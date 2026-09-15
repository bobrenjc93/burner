import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, opendir, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandEvidenceReference, EvaluationRun } from "../types.js";
import type { CommandResult } from "./process.js";
import { errorMessage, now } from "./utils.js";

export const COMMAND_EVIDENCE_LIMITS = Object.freeze({
  files: 128,
  fileBytes: 64 * 1024 * 1024,
  exportBytes: 512 * 1024 * 1024,
  streamBytes: 8 * 1024 * 1024,
});

const safeName = (name: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name);
type RetainedFile = { path: string; bytes: number; sha256: string; complete: boolean };
type Stream = { chunks: Buffer[]; observedBytes: number; retainedBytes: number };
type Identity = { dev: number; ino: number };
type Outcome = { status: "completed" | "failed"; error?: string };
type NormalizedOutput = Pick<EvaluationRun, "score" | "summary" | "evidence" | "suggestions">;

/** One command attempt's best-effort recorder; failures never replace its score or error. */
export class CommandEvidenceArchive {
  readonly reference: CommandEvidenceReference;
  artifactDir?: string;
  private directory?: string;
  private directoryIdentity?: Identity;
  private sinkIdentity?: Identity;
  private readonly files: RetainedFile[] = [];
  private readonly issues: string[] = [];
  private issueCount = 0;
  private readonly streams: Record<"stdout" | "stderr", Stream> = {
    stdout: { chunks: [], observedBytes: 0, retainedBytes: 0 },
    stderr: { chunks: [], observedBytes: 0, retainedBytes: 0 },
  };
  private commandStartedAt?: string;
  private commandRecorded = false;
  private finalized?: Promise<CommandEvidenceReference>;

  private constructor(private readonly dataDir: string, private readonly measurement: {
    runId: string;
    evaluationId: string;
    evaluationName: string;
    evaluationDefinitionVersion?: string;
    commit: string;
    context: EvaluationRun["context"];
    agentRunId?: string;
    compositeId?: string;
    createdAt: string;
    cwd: string;
    commandKind: "full" | "screening";
  }) {
    this.reference = { runId: measurement.runId, status: "capturing" };
  }

  static async create(dataDir: string, run: EvaluationRun, evaluationName: string, cwd: string, commandKind: "full" | "screening"): Promise<CommandEvidenceArchive> {
    const archive = new CommandEvidenceArchive(resolve(dataDir), {
      runId: run.id, evaluationId: run.evaluationId, evaluationName,
      evaluationDefinitionVersion: run.evaluationDefinitionVersion,
      commit: run.commit, context: run.context, agentRunId: run.agentRunId,
      compositeId: run.compositeId, createdAt: run.createdAt, cwd: resolve(cwd), commandKind,
    });
    await archive.attempt("Create archive", async () => {
      if (!safeName(run.id)) throw new Error("Unsafe evaluation run ID.");
      if (!(await lstat(archive.dataDir)).isDirectory()) throw new Error("Burner data directory is not a regular directory.");
      const parent = join(archive.dataDir, "evaluation-runs");
      await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      if (!(await lstat(parent)).isDirectory()) throw new Error("Archive parent is not a regular directory.");
      const directory = join(parent, run.id);
      await mkdir(directory, { mode: 0o700 }); // Never reuse or overwrite an earlier attempt.
      archive.directory = directory;
      archive.directoryIdentity = await lstat(directory);
      archive.reference.directory = `.burner/evaluation-runs/${run.id}`;
      await mkdir(join(directory, "artifacts"), { mode: 0o700 });
      await archive.save("measurement.json", Buffer.from(`${JSON.stringify(archive.measurement, null, 2)}\n`));
    });
    await archive.attempt("Create export sink", async () => {
      archive.artifactDir = await mkdtemp(join(tmpdir(), "burner-evaluation-export-"));
      archive.sinkIdentity = await lstat(archive.artifactDir);
      archive.reference.recoveryDirectory = archive.artifactDir;
    });
    return archive;
  }

  startCommand(): void {
    this.commandStartedAt = now();
  }

  /** Buffers at most 8 MiB per stream, encoded from runCommand's decoded UTF-8 chunks. */
  append(stream: "stdout" | "stderr", chunk: string): void {
    const target = this.streams[stream];
    const bytes = Buffer.from(chunk, "utf8");
    target.observedBytes += bytes.length;
    const retained = bytes.subarray(0, Math.max(0, COMMAND_EVIDENCE_LIMITS.streamBytes - target.retainedBytes));
    if (retained.length) target.chunks.push(Buffer.from(retained));
    target.retainedBytes += retained.length;
  }

  /** Must settle before the caller checks exit status or interprets stdout. */
  async recordCommand(result?: CommandResult, error?: unknown): Promise<void> {
    this.commandRecorded = true;
    for (const stream of ["stdout", "stderr"] as const) {
      const value = this.streams[stream];
      if (value.observedBytes > value.retainedBytes) this.issue(`${stream} truncated at ${COMMAND_EVIDENCE_LIMITS.streamBytes} UTF-8 bytes.`);
      await this.save(`${stream}.txt`, Buffer.concat(value.chunks));
      value.chunks = [];
    }
    await this.save("command.json", Buffer.from(`${JSON.stringify({
      startedAt: this.commandStartedAt, completedAt: now(),
      exitCode: result?.exitCode, termination: result?.termination, signal: result?.signal,
      launchError: error === undefined ? undefined : errorMessage(error).slice(0, 8_000),
      streams: Object.fromEntries(Object.entries(this.streams).map(([name, value]) => {
        const retainedBytes = this.files.find((file) => file.path === `${name}.txt`)?.bytes ?? 0;
        return [name, { observedBytes: value.observedBytes, retainedBytes, truncated: value.observedBytes > retainedBytes }];
      })),
    }, null, 2)}\n`));
  }

  async recordNormalized(output: NormalizedOutput): Promise<void> {
    await this.save("normalized.json", Buffer.from(`${JSON.stringify(output, null, 2)}\n`));
  }

  finalize(outcome: Outcome): Promise<CommandEvidenceReference> {
    this.finalized ??= this.finish(outcome);
    return this.finalized;
  }

  private issue(message: string): void {
    this.issueCount++;
    if (this.issues.length < 16) this.issues.push(message.slice(0, 500));
    this.reference.status = "incomplete";
    this.reference.issues = [...this.issues];
  }

  private async attempt(label: string, action: () => Promise<void>): Promise<void> {
    try { await action(); }
    catch (error) { this.issue(`${label}: ${errorMessage(error)}`); }
  }

  private async assertDirectory(path: string, expected?: Identity): Promise<void> {
    const actual = await lstat(path);
    if (!actual.isDirectory() || (expected && (actual.dev !== expected.dev || actual.ino !== expected.ino))) {
      throw new Error("Owned directory was removed or replaced.");
    }
  }

  private async assertArchive(): Promise<void> {
    if (!this.directory) throw new Error("Archive directory unavailable.");
    await this.assertDirectory(this.dataDir);
    await this.assertDirectory(join(this.dataDir, "evaluation-runs"));
    await this.assertDirectory(this.directory, this.directoryIdentity);
  }

  private async save(name: string, bytes: Buffer, complete = true): Promise<void> {
    let handle: FileHandle | undefined;
    let written = 0;
    let flushed = false;
    const hash = createHash("sha256");
    await this.attempt(`Retain ${name}`, async () => {
      await this.assertArchive();
      if (name.startsWith("artifacts/")) await this.assertDirectory(join(this.directory!, "artifacts"));
      handle = await open(join(this.directory!, name), "wx", 0o600);
      while (written < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, written, bytes.length - written);
        if (!bytesWritten) throw new Error("File write made no progress.");
        hash.update(bytes.subarray(written, written + bytesWritten));
        written += bytesWritten;
      }
      await handle.sync();
      flushed = true;
    });
    if (handle) {
      await this.attempt(`Close ${name}`, () => handle!.close());
      this.files.push({ path: name, bytes: written, sha256: hash.digest("hex"), complete: complete && flushed && written === bytes.length });
    }
  }

  private async collectExports(): Promise<void> {
    if (!this.artifactDir) { this.issue("Export sink unavailable."); return; }
    await this.assertDirectory(this.artifactDir, this.sinkIdentity);
    let entries = 0;
    let total = 0;
    const directory = await opendir(this.artifactDir);
    for await (const entry of directory) {
      if (++entries > COMMAND_EVIDENCE_LIMITS.files) { this.issue(`Export count exceeds ${COMMAND_EVIDENCE_LIMITS.files}; remaining entries not collected.`); break; }
      await this.attempt(`Export ${entry.name}`, async () => {
        if (!safeName(entry.name)) throw new Error("Unsafe export name; use 1–128 ASCII letters, digits, dots, underscores or hyphens, starting with a letter or digit.");
        await this.assertDirectory(this.artifactDir!, this.sinkIdentity);
        const source = join(this.artifactDir!, entry.name);
        const expected = await lstat(source);
        if (!expected.isFile() || expected.nlink !== 1) throw new Error("Export must be a regular file with exactly one link.");
        if (expected.size > COMMAND_EVIDENCE_LIMITS.fileBytes) throw new Error(`Export exceeds the ${COMMAND_EVIDENCE_LIMITS.fileBytes / (1024 * 1024)} MiB per-file limit.`);
        if (expected.size > COMMAND_EVIDENCE_LIMITS.exportBytes - total) throw new Error(`Export exceeds the ${COMMAND_EVIDENCE_LIMITS.exportBytes / (1024 * 1024)} MiB total limit.`);
        const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let bytes: Buffer | undefined;
        let read = 0;
        let complete = false;
        try {
          const before = await input.stat();
          if (!before.isFile() || before.nlink !== 1 || before.ino !== expected.ino || before.dev !== expected.dev || before.size !== expected.size) {
            throw new Error("Export changed before collection.");
          }
          bytes = Buffer.alloc(before.size);
          while (read < bytes.length) {
            const { bytesRead } = await input.read(bytes, read, bytes.length - read, read);
            if (!bytesRead) break;
            read += bytesRead;
          }
          const after = await input.stat();
          const current = await lstat(source);
          complete = read === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs &&
            after.ctimeMs === before.ctimeMs && after.nlink === 1 && current.ino === before.ino && current.dev === before.dev && !current.isSymbolicLink();
          if (!complete) this.issue(`Export ${entry.name} changed during collection; retained bytes are partial.`);
        } finally {
          // Even a later read/stat/close error must not discard a prefix already obtained.
          await this.attempt(`Close export ${entry.name}`, () => input.close());
          if (bytes) {
            total += read;
            await this.save(`artifacts/${entry.name}`, bytes.subarray(0, read), complete);
          }
        }
      });
    }
  }

  private async finish(outcome: Outcome): Promise<CommandEvidenceReference> {
    if (!this.commandRecorded) this.issue("No command result was captured.");
    const beforeCollection = this.issueCount;
    await this.attempt("Collect exports", () => this.collectExports());
    delete this.reference.recoveryDirectory;
    if (this.artifactDir) {
      // A failed read or copy may leave this sink as the only complete original.
      // Count all errors, even after the bounded diagnostic list fills up.
      if (this.issueCount === beforeCollection) await this.attempt("Remove export sink", async () => {
        await this.assertDirectory(this.artifactDir!, this.sinkIdentity);
        await rm(this.artifactDir!, { recursive: true, force: true });
      });
      await this.attempt("Locate recoverable exports", async () => {
        try { await this.assertDirectory(this.artifactDir!, this.sinkIdentity); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        this.reference.recoveryDirectory = this.artifactDir;
      });
    }
    await this.attempt("Seal manifest", async () => {
      await this.assertArchive();
      const manifest = Buffer.from(`${JSON.stringify({
        version: 1, measurement: this.measurement, completedAt: now(),
        outcome: { ...outcome, error: outcome.error?.slice(0, 8_000), errorTruncated: (outcome.error?.length ?? 0) > 8_000 },
        status: this.issues.length ? "incomplete" : "complete", issues: this.issues,
        recoveryDirectory: this.reference.recoveryDirectory,
        limits: COMMAND_EVIDENCE_LIMITS, files: this.files,
      }, null, 2)}\n`);
      const temporary = join(this.directory!, `.manifest-${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(manifest);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Atomic, exclusive publication: rename would overwrite a previous manifest.
      await link(temporary, join(this.directory!, "manifest.json"));
      this.reference.manifest = `${this.reference.directory}/manifest.json`;
      // Publication is the seal. A leftover second link to those same bytes is
      // harmless housekeeping, not a reason to contradict the sealed status.
      await rm(temporary).catch(() => undefined);
    });
    this.reference.status = this.issues.length ? "incomplete" : "complete";
    return structuredClone(this.reference);
  }
}
