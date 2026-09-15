import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CommandEvidenceArchive, COMMAND_EVIDENCE_LIMITS } from "../dist/lib/command-evidence.js";
import { CodexClient } from "../dist/lib/codex.js";
import { EventHub } from "../dist/lib/events.js";
import { GitService } from "../dist/lib/git.js";
import { fullMergeValidationFingerprint, latestFullAssessment, fullAssessmentForIdentity, Orchestrator } from "../dist/lib/orchestrator.js";
import { runCommand } from "../dist/lib/process.js";
import { StateStore } from "../dist/lib/store.js";
import { fixtureLeafPr, installLeafPrFixtureTransport } from "./leaf-pr-test-helpers.js";

const payload = { score: 11.360180, summary: "Measured normally", evidence: ["same workload"], suggestions: [] };
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const nodeCommand = (source) => `${quote(process.execPath)} -e ${quote(source)}`;
const print = (value = payload) => `process.stdout.write(${JSON.stringify(`${JSON.stringify(value)}\n`)});`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));

async function fixture(t, source = print(), options = {}) {
  const root = await mkdtemp(join(tmpdir(), "burner-command-evidence-test-"));
  const retainedSinks = new Set();
  t.after(async () => {
    for (const sink of retainedSinks) await rm(sink, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const cwd = join(root, "candidate");
  await mkdir(cwd);
  const store = new StateStore(root);
  await store.init();
  await store.update((state) => {
    state.evaluations = [{ id: "bench", name: "Benchmark", prompt: "Measure", command: nodeCommand(source),
      enabled: true, weight: 1, createdAt: "2026-09-13T00:00:00.000Z", definitionVersion: "version-1" }];
  });
  const events = new EventHub();
  const orchestrator = new Orchestrator(root, store, events, options);
  orchestrator.git = { head: async () => "measured-commit" };
  const run = async (context = "agent") => {
    const measured = (await orchestrator.runEvaluations(context, cwd, "author-1"))[0];
    if (measured.commandEvidence?.recoveryDirectory) retainedSinks.add(measured.commandEvidence.recoveryDirectory);
    return measured;
  };
  return { root, cwd, store, events, orchestrator, run };
}

async function recorder(t, id = "evalrun_original") {
  const f = await fixture(t);
  const run = { id, evaluationId: "bench", commit: "measured-commit", createdAt: "2026-09-13T00:00:00.000Z",
    status: "running", durationMs: 0, context: "agent", agentRunId: "author-1", evaluationDefinitionVersion: "version-1",
    privateConfiguration: "DO-NOT-ARCHIVE-WHOLE-RUN" };
  const archive = await CommandEvidenceArchive.create(f.store.dataDir, run, "Benchmark", f.cwd, "full");
  t.after(async () => {
    // Only this recorder's exclusively created temporary sink, if a test interrupts finalization.
    if (archive.artifactDir) await rm(archive.artifactDir, { recursive: true, force: true });
  });
  return { ...f, record: run, archive, directory: archive.reference.directory ? join(f.root, archive.reference.directory) : undefined };
}

async function finish(archive, outcome = { status: "completed" }) {
  archive.startCommand();
  archive.append("stdout", `${JSON.stringify(payload)}\n`);
  await archive.recordCommand({ stdout: JSON.stringify(payload), stderr: "", exitCode: 0 });
  await archive.recordNormalized({ ...payload, score: 11.4 });
  return archive.finalize(outcome);
}

async function verifyManifest(root, reference) {
  const manifest = await json(join(root, reference.manifest));
  assert.equal(manifest.measurement.runId, reference.runId);
  for (const file of manifest.files) {
    const bytes = await readFile(join(root, reference.directory, file.path));
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(sha256(bytes), file.sha256, file.path);
  }
  return manifest;
}

test("attempt archive retains precise output before normalization and before persisted completion", async (t) => {
  const f = await fixture(t, `process.stderr.write('first\\n\\nlast'); ${print()}`);
  let observedComplete = false;
  f.store.subscribe((state) => {
    const completed = state.evaluationRuns.find((run) => run.status === "completed");
    if (completed) {
      const manifest = JSON.parse(readFileSync(join(f.root, completed.commandEvidence.manifest), "utf8"));
      assert.equal(manifest.outcome.status, "completed");
      observedComplete = true;
    }
  });
  const run = await f.run();
  assert.equal(run.status, "completed");
  assert.equal(run.score, 11.4);
  assert.equal(run.commandEvidence.status, "complete");
  assert.equal(run.commandEvidence.recoveryDirectory, undefined);
  assert.equal(run.commandEvidence.runId, run.id);
  assert.equal(observedComplete, true);
  const directory = join(f.root, run.commandEvidence.directory);
  assert.equal(JSON.parse(await readFile(join(directory, "stdout.txt"), "utf8")).score, 11.360180);
  assert.equal(await readFile(join(directory, "stderr.txt"), "utf8"), "first\n\nlast");
  assert.equal((await json(join(directory, "normalized.json"))).score, 11.4);
  const manifest = await verifyManifest(f.root, run.commandEvidence);
  assert.equal(manifest.measurement.commit, "measured-commit");
  assert.equal(manifest.measurement.evaluationDefinitionVersion, f.store.get().evaluations[0].definitionVersion);
  assert.equal(manifest.measurement.cwd, f.cwd);
  assert.equal(manifest.measurement.commandKind, "full");
  assert.equal(manifest.measurement.agentRunId, "author-1");
  assert.equal(manifest.status, "complete");
  const command = await json(join(directory, "command.json"));
  assert.equal(command.exitCode, 0);
  assert.equal(command.streams.stderr.retainedBytes, Buffer.byteLength("first\n\nlast"));
  assert.ok(command.startedAt <= command.completedAt);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  for (const name of ["stdout.txt", "stderr.txt", "command.json", "normalized.json", "manifest.json"]) {
    assert.equal((await lstat(join(directory, name))).mode & 0o777, 0o600);
  }
});

for (const [label, source, error, normalized] of [
  ["nonzero exit", `${print()} process.stderr.write('original command failure'); process.exitCode = 7;`, /original command failure/, false],
  ["invalid JSON", "process.stdout.write('invalid response');", /Codex returned invalid JSON/, false],
  ["invalid schema", print({ score: "bad", summary: "No number", evidence: [], suggestions: [] }), /must contain score/, false],
  ["invalid measurement", print({ ...payload, baselineInvalid: true, summary: "Wrong reference" }), /Evaluation baseline invalid: Wrong reference/, false],
  ["invalid validity type", print({ ...payload, baselineInvalid: "false" }), /baselineInvalid must be a boolean/, false],
  ["inconclusive measurement", print({ ...payload, score: 0, summary: "Benchmark rejected: no timing score was accepted", evidence: ["unstable timing"] }), /inconclusive measurement/, true],
]) test(`${label} retains raw evidence and exactly the original evaluation error`, async (t) => {
  const f = await fixture(t, source);
  let original;
  try { await new CodexClient().evaluate(f.cwd, f.store.get().evaluations[0], f.store.get().settings, "agent"); }
  catch (failure) { original = failure.message; }
  assert.match(original, error);
  const run = await f.run();
  assert.equal(run.status, "failed");
  assert.equal(run.score, undefined);
  assert.equal(run.error, original);
  assert.equal(run.commandEvidence.status, "complete", "complete capture is not an approved measurement");
  const manifest = await verifyManifest(f.root, run.commandEvidence);
  assert.equal(manifest.outcome.status, "failed");
  assert.equal(manifest.outcome.error, original);
  assert.equal(existsSync(join(f.root, run.commandEvidence.directory, "normalized.json")), normalized);
  assert.ok((await readFile(join(f.root, run.commandEvidence.directory, "stdout.txt"))).length > 0);
});

test("legitimate correctness zero remains a completed score, not an archival failure", async (t) => {
  const f = await fixture(t, print({ ...payload, score: 0, summary: "Benchmark rejected: no timing score was accepted", evidence: ["typed correctness mismatch"] }));
  const run = await f.run();
  assert.equal(run.status, "completed");
  assert.equal(run.score, 0);
  assert.equal(run.commandEvidence.status, "complete");
});

test("failed commands can explicitly export reports and raw observation files", async (t) => {
  const f = await fixture(t, `const fs = require('node:fs'); const path = require('node:path');
    const sink = process.env.BURNER_EVALUATION_ARTIFACT_DIR;
    fs.writeFileSync(path.join(sink, 'report.json'), JSON.stringify({ raw: 'samples.json' }));
    fs.writeFileSync(path.join(sink, 'samples.json'), '[1.360180,2,3]');
    process.stderr.write('report written before failure'); process.exitCode = 9;`);
  const run = await f.run();
  assert.equal(run.status, "failed");
  assert.equal(run.commandEvidence.status, "complete");
  const manifest = await verifyManifest(f.root, run.commandEvidence);
  assert.deepEqual(manifest.files.filter((file) => file.path.startsWith("artifacts/")).map((file) => file.path).sort(),
    ["artifacts/report.json", "artifacts/samples.json"]);
  assert.equal(await readFile(join(f.root, run.commandEvidence.directory, "artifacts/samples.json"), "utf8"), "[1.360180,2,3]");
});

test("export sink is fresh per attempt, removed after collection, and independent of the evaluated cwd", async (t) => {
  const f = await fixture(t, `process.stderr.write(process.env.BURNER_EVALUATION_ARTIFACT_DIR); ${print()}`);
  const first = await f.run();
  const second = await f.run();
  const sinks = await Promise.all([first, second].map((run) => readFile(join(f.root, run.commandEvidence.directory, "stderr.txt"), "utf8")));
  assert.notEqual(sinks[0], sinks[1]);
  for (const sink of sinks) { assert.ok(!sink.startsWith(f.cwd)); assert.equal(existsSync(sink), false); }
  assert.notEqual(first.id, second.id);
  await verifyManifest(f.root, first.commandEvidence);
});

test("evidence strings and report contents never trigger arbitrary file discovery", async (t) => {
  const f = await fixture(t, `require('node:fs').writeFileSync('unexported.json', 'do not collect');
    ${print({ ...payload, evidence: ["Report: unexported.json", "../../outside-secret.json"] })}`);
  const run = await f.run();
  const manifest = await verifyManifest(f.root, run.commandEvidence);
  assert.deepEqual(manifest.files.filter((file) => file.path.startsWith("artifacts/")), []);
  assert.deepEqual(await readdir(join(f.root, run.commandEvidence.directory, "artifacts")), []);
});

test("stdout retention truncation does not change parsing or scoring beyond the retained prefix", async (t) => {
  const f = await fixture(t, `process.stdout.write(' '.repeat(${COMMAND_EVIDENCE_LIMITS.streamBytes + 1})); ${print()}`);
  const run = await f.run();
  assert.equal(run.status, "completed");
  assert.equal(run.score, 11.4);
  assert.equal(run.commandEvidence.status, "incomplete");
  const directory = join(f.root, run.commandEvidence.directory);
  assert.equal((await lstat(join(directory, "stdout.txt"))).size, COMMAND_EVIDENCE_LIMITS.streamBytes);
  const command = await json(join(directory, "command.json"));
  assert.equal(command.streams.stdout.truncated, true);
  assert.ok(command.streams.stdout.observedBytes > command.streams.stdout.retainedBytes);
  assert.equal((await json(join(directory, "normalized.json"))).score, 11.4);
  assert.ok(f.store.get().activity.some((entry) => entry.message === "Command evidence retention incomplete"));
  await verifyManifest(f.root, run.commandEvidence);
});

test("raw stream bounds are independent and measured in re-encoded UTF-8 bytes", async (t) => {
  const f = await recorder(t);
  const prefix = "x".repeat(COMMAND_EVIDENCE_LIMITS.streamBytes - 1);
  f.archive.startCommand();
  f.archive.append("stdout", `${prefix}€`);
  f.archive.append("stderr", "é".repeat(COMMAND_EVIDENCE_LIMITS.streamBytes / 2 + 1));
  await f.archive.recordCommand({ stdout: "", stderr: "", exitCode: 0 });
  const reference = await f.archive.finalize({ status: "completed" });
  const stdout = await readFile(join(f.directory, "stdout.txt"));
  assert.equal(stdout.length, COMMAND_EVIDENCE_LIMITS.streamBytes);
  assert.equal(stdout.at(-1), Buffer.from("€")[0], "the documented byte cutoff may split a character");
  const command = await json(join(f.directory, "command.json"));
  for (const stream of ["stdout", "stderr"]) {
    assert.equal(command.streams[stream].observedBytes, COMMAND_EVIDENCE_LIMITS.streamBytes + 2);
    assert.equal(command.streams[stream].retainedBytes, COMMAND_EVIDENCE_LIMITS.streamBytes);
    assert.equal(command.streams[stream].truncated, true);
  }
  assert.equal(reference.status, "incomplete");
  await verifyManifest(f.root, reference);
});

test("canonical timeout records partial streams, exported data and the separate termination reason", async (t) => {
  const f = await recorder(t);
  f.archive.startCommand();
  const result = await runCommand("/bin/sh", ["-c", "printf partial; printf diagnostic >&2; printf samples > \"$BURNER_EVALUATION_ARTIFACT_DIR/raw.txt\"; sleep 30 & wait"], {
    cwd: f.cwd, timeoutMs: 80, env: { BURNER_EVALUATION_ARTIFACT_DIR: f.archive.artifactDir },
    onStdout: (chunk) => f.archive.append("stdout", chunk), onStderrChunk: (chunk) => f.archive.append("stderr", chunk),
  });
  assert.equal(result.exitCode, 124);
  assert.equal(result.termination, "timeout");
  await f.archive.recordCommand(result);
  const reference = await f.archive.finalize({ status: "failed", error: result.stderr });
  assert.equal(await readFile(join(f.directory, "stderr.txt"), "utf8"), "diagnostic");
  assert.equal(await readFile(join(f.directory, "stdout.txt"), "utf8"), "partial");
  assert.equal(await readFile(join(f.directory, "artifacts/raw.txt"), "utf8"), "samples");
  const command = await json(join(f.directory, "command.json"));
  assert.equal(command.exitCode, 124);
  assert.equal(command.termination, "timeout");
  assert.match((await verifyManifest(f.root, reference)).outcome.error, /Command timed out/);
});

test("Codex shutdown captures the abort without accepting a score or dropping partial exports", async (t) => {
  const f = await fixture(t, `const fs = require('node:fs'); const path = require('node:path');
    fs.writeFileSync(path.join(process.env.BURNER_EVALUATION_ARTIFACT_DIR, 'partial.txt'), 'partial observation');
    process.stdout.write('partial JSON'); process.stderr.write('ready to abort'); setInterval(() => {}, 1000);`);
  f.orchestrator.codex = new CodexClient((message) => { if (message.includes("ready to abort")) f.orchestrator.codex.close(); });
  const run = await f.run();
  assert.equal(run.status, "failed");
  assert.equal(run.score, undefined);
  assert.match(run.error, /Command aborted during Burner shutdown/);
  const directory = join(f.root, run.commandEvidence.directory);
  assert.equal((await json(join(directory, "command.json"))).termination, "abort");
  assert.equal(await readFile(join(directory, "artifacts/partial.txt"), "utf8"), "partial observation");
  await verifyManifest(f.root, run.commandEvidence);
});

test("signal exits are distinct from ordinary exit codes and synthetic timeout codes", async (t) => {
  const f = await recorder(t);
  f.archive.startCommand();
  const result = await runCommand("/bin/sh", ["-c", "kill -TERM $$"], { cwd: f.cwd });
  assert.equal(result.termination, "signal");
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.exitCode, 1);
  await f.archive.recordCommand(result);
  const reference = await f.archive.finalize({ status: "failed", error: "Evaluation command exited with 1" });
  assert.equal((await json(join(f.directory, "command.json"))).signal, "SIGTERM");
  await verifyManifest(f.root, reference);
});

test("launch failure records empty streams and preserves the original launch error", async (t) => {
  const f = await recorder(t);
  const client = new CodexClient();
  let failure;
  try { await client.evaluate(join(f.cwd, "missing"), f.store.get().evaluations[0], f.store.get().settings, "agent", undefined, f.archive); }
  catch (error) { failure = error; }
  assert.equal(failure.code, "ENOENT");
  const reference = await f.archive.finalize({ status: "failed", error: failure.message });
  const command = await json(join(f.directory, "command.json"));
  assert.equal(command.exitCode, undefined);
  assert.equal(command.launchError, failure.message);
  assert.equal(command.streams.stdout.retainedBytes, 0);
  assert.equal((await verifyManifest(f.root, reference)).outcome.error, failure.message);
});

for (const failCommand of [false, true]) test(`unavailable archive does not alter a ${failCommand ? "failed" : "successful"} command`, async (t) => {
  const source = failCommand ? "process.stderr.write('original failure'); process.exitCode = 17;" : print();
  const f = await fixture(t, source);
  await writeFile(join(f.store.dataDir, "evaluation-runs"), "existing owner data", { flag: "wx" });
  const before = f.store.get().settings;
  const run = await f.run();
  assert.equal(run.status, failCommand ? "failed" : "completed");
  assert.equal(run.score, failCommand ? undefined : 11.4);
  assert.equal(run.error, failCommand ? "original failure" : undefined);
  assert.equal(run.commandEvidence.status, "incomplete");
  assert.equal(run.commandEvidence.directory, undefined);
  assert.equal(run.commandEvidence.manifest, undefined);
  assert.match(run.commandEvidence.issues.join(" "), /Archive parent is not a regular directory/);
  assert.equal(await readFile(join(f.store.dataDir, "evaluation-runs"), "utf8"), "existing owner data");
  assert.deepEqual(f.store.get().settings, before);
  assert.ok(f.store.get().activity.some((entry) => entry.message === "Command evidence retention incomplete"));
});

test("immutable attempt IDs never reuse a prior archive or claim its manifest", async (t) => {
  const f = await recorder(t);
  const first = await finish(f.archive);
  const original = await readFile(join(f.root, first.manifest));
  const second = await CommandEvidenceArchive.create(f.store.dataDir, f.record, "Benchmark", f.cwd, "full");
  const rejected = await finish(second);
  assert.equal(rejected.status, "incomplete");
  assert.equal(rejected.directory, undefined);
  assert.equal(rejected.manifest, undefined);
  assert.match(rejected.issues.join(" "), /EEXIST/);
  assert.deepEqual(await readFile(join(f.root, first.manifest)), original);
  assert.deepEqual(await f.archive.finalize({ status: "failed", error: "late caller" }), first, "sealed outcome cannot be rewritten");
});

test("manifest collision preserves the old bytes and leaves no false successful reference", async (t) => {
  const f = await recorder(t);
  await writeFile(join(f.directory, "manifest.json"), "previous owner", { flag: "wx" });
  const reference = await finish(f.archive);
  assert.equal(reference.status, "incomplete");
  assert.equal(reference.manifest, undefined);
  assert.equal(await readFile(join(f.directory, "manifest.json"), "utf8"), "previous owner");
  assert.match(reference.issues.join(" "), /Seal manifest.*EEXIST/);
});

test("manifest publication failure cannot replace the original command error or claim a seal", async (t) => {
  const f = await fixture(t, "process.stderr.write('original command failure'); process.exitCode = 7;");
  const originalLink = fsPromises.link;
  let injected = false;
  const mocked = t.mock.method(fsPromises, "link", async (source, target) => {
    if (String(target).endsWith("/manifest.json")) { injected = true; throw new Error("injected manifest publication EIO"); }
    return originalLink(source, target);
  });
  syncBuiltinESMExports();
  let run;
  try { run = await f.run(); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(injected, true);
  assert.equal(run.status, "failed");
  assert.equal(run.error, "original command failure");
  assert.equal(run.commandEvidence.status, "incomplete");
  assert.equal(run.commandEvidence.manifest, undefined);
  assert.match(run.commandEvidence.issues.join(" "), /injected manifest publication EIO/);
  const directory = join(f.root, run.commandEvidence.directory);
  assert.equal(existsSync(join(directory, "manifest.json")), false);
  assert.equal(await readFile(join(directory, "stderr.txt"), "utf8"), "original command failure");
});

test("post-publication temporary-link cleanup failure cannot contradict sealed evidence", async (t) => {
  const f = await recorder(t);
  const originalRm = fsPromises.rm;
  let temporary;
  const mocked = t.mock.method(fsPromises, "rm", async (path, ...options) => {
    if (String(path).includes("/.manifest-") && String(path).endsWith(".tmp")) {
      temporary = path;
      throw new Error("injected harmless temporary-link cleanup error");
    }
    return originalRm(path, ...options);
  });
  syncBuiltinESMExports();
  let reference;
  try { reference = await finish(f.archive); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(temporary);
  assert.equal(reference.status, "complete");
  assert.equal(reference.recoveryDirectory, undefined);
  assert.equal(reference.issues, undefined);
  const manifest = await verifyManifest(f.root, reference);
  assert.equal(manifest.status, reference.status);
  assert.deepEqual(manifest.issues, []);
  assert.equal((await lstat(temporary)).ino, (await lstat(join(f.root, reference.manifest))).ino);
  assert.deepEqual(await readFile(temporary), await readFile(join(f.root, reference.manifest)));
  assert.deepEqual(await f.archive.finalize({ status: "failed", error: "late error" }), reference);
});

test("a missing raw file is explicit and is not assigned a fabricated size or hash", async (t) => {
  const f = await recorder(t);
  await writeFile(join(f.directory, "stdout.txt"), "occupied path", { flag: "wx" });
  const reference = await finish(f.archive);
  assert.equal(reference.status, "incomplete");
  const manifest = await verifyManifest(f.root, reference);
  assert.equal(manifest.files.some((file) => file.path === "stdout.txt"), false);
  const command = await json(join(f.directory, "command.json"));
  assert.equal(command.streams.stdout.retainedBytes, 0);
  assert.equal(command.streams.stdout.truncated, true);
  assert.equal(await readFile(join(f.directory, "stdout.txt"), "utf8"), "occupied path");
});

test("partial raw writes retain their actual prefix and never change the accepted score", async (t) => {
  const f = await fixture(t);
  const probe = await open(join(f.root, "prototype-probe"), "wx");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const write = prototype.write;
  const raw = `${JSON.stringify(payload)}\n`;
  let interrupted = false;
  t.mock.method(prototype, "write", async function (buffer, offset, length, ...rest) {
    if (!interrupted && Buffer.isBuffer(buffer) && buffer.toString() === raw) {
      if (offset === 0) return write.call(this, buffer, offset, 3, ...rest);
      interrupted = true;
      throw new Error("injected partial write EIO");
    }
    return write.call(this, buffer, offset, length, ...rest);
  });
  const run = await f.run();
  assert.equal(interrupted, true);
  assert.equal(run.status, "completed");
  assert.equal(run.score, 11.4);
  assert.equal(run.error, undefined);
  assert.equal(run.commandEvidence.status, "incomplete");
  const manifest = await verifyManifest(f.root, run.commandEvidence);
  const file = manifest.files.find((entry) => entry.path === "stdout.txt");
  assert.equal(file.bytes, 3);
  assert.equal(file.sha256, sha256(Buffer.from(raw.slice(0, 3))));
  assert.equal(file.complete, false);
  const command = await json(join(f.root, run.commandEvidence.directory, "command.json"));
  assert.equal(command.streams.stdout.retainedBytes, 3);
  assert.equal(command.streams.stdout.truncated, true);
  assert.match(manifest.issues.join(" "), /injected partial write EIO/);
});

test("partial export read errors preserve the bytes already read and the original command failure", async (t) => {
  const f = await recorder(t);
  const source = "partial source observation";
  await writeFile(join(f.archive.artifactDir, "raw.txt"), source);
  const probe = await open(join(f.root, "prototype-probe"), "wx");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const read = prototype.read;
  let interrupted = false;
  t.mock.method(prototype, "read", async function (buffer, offset, length, position) {
    if (!interrupted && Buffer.isBuffer(buffer) && buffer.length === source.length) {
      if (offset === 0) return read.call(this, buffer, offset, 7, position);
      interrupted = true;
      throw new Error("injected partial read EIO");
    }
    return read.call(this, buffer, offset, length, position);
  });
  const reference = await finish(f.archive, { status: "failed", error: "original command failure" });
  assert.equal(interrupted, true);
  assert.equal(reference.status, "incomplete");
  const manifest = await verifyManifest(f.root, reference);
  const file = manifest.files.find((entry) => entry.path === "artifacts/raw.txt");
  assert.equal(file.bytes, 7);
  assert.equal(file.complete, false);
  assert.equal(await readFile(join(f.directory, file.path), "utf8"), source.slice(0, 7));
  assert.equal(manifest.outcome.error, "original command failure");
  assert.match(manifest.issues.join(" "), /injected partial read EIO/);
  assert.equal(reference.recoveryDirectory, f.archive.artifactDir);
  assert.equal(manifest.recoveryDirectory, f.archive.artifactDir);
  assert.equal(await readFile(join(reference.recoveryDirectory, "raw.txt"), "utf8"), source);
});

test("an export changed during collection is retained only as an explicitly partial snapshot", async (t) => {
  const f = await recorder(t);
  const source = "original observation";
  const path = join(f.archive.artifactDir, "raw.txt");
  await writeFile(path, source);
  const probe = await open(join(f.root, "prototype-probe"), "wx");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const read = prototype.read;
  let changed = false;
  t.mock.method(prototype, "read", async function (...args) {
    const result = await read.apply(this, args);
    if (!changed && Buffer.isBuffer(args[0]) && args[0].length === source.length) {
      changed = true;
      await writeFile(path, "later writer");
    }
    return result;
  });
  const reference = await finish(f.archive);
  assert.equal(changed, true);
  assert.equal(reference.status, "incomplete");
  const manifest = await verifyManifest(f.root, reference);
  const file = manifest.files.find((entry) => entry.path === "artifacts/raw.txt");
  assert.equal(file.complete, false);
  assert.equal(await readFile(join(f.directory, file.path), "utf8"), source);
  assert.match(manifest.issues.join(" "), /changed during collection/);
  assert.equal(reference.recoveryDirectory, f.archive.artifactDir);
  assert.equal(await readFile(join(reference.recoveryDirectory, "raw.txt"), "utf8"), "later writer");
});

test("artifact destination collisions never overwrite or adopt unrelated bytes", async (t) => {
  const f = await recorder(t);
  await writeFile(join(f.archive.artifactDir, "raw.txt"), "new export");
  await writeFile(join(f.directory, "artifacts/raw.txt"), "existing bytes");
  const reference = await finish(f.archive);
  assert.equal(reference.status, "incomplete");
  assert.equal(await readFile(join(f.directory, "artifacts/raw.txt"), "utf8"), "existing bytes");
  const manifest = await verifyManifest(f.root, reference);
  assert.equal(manifest.files.some((file) => file.path === "artifacts/raw.txt"), false);
  assert.equal(reference.recoveryDirectory, f.archive.artifactDir);
  assert.equal(manifest.recoveryDirectory, f.archive.artifactDir);
  assert.equal(await readFile(join(reference.recoveryDirectory, "raw.txt"), "utf8"), "new export");
});

test("an archive write failure retains the complete producer export and exposes recovery in activity", async (t) => {
  const f = await fixture(t, `require('node:fs').writeFileSync(require('node:path').join(process.env.BURNER_EVALUATION_ARTIFACT_DIR, 'raw.txt'), 'complete original');
    process.stderr.write('original command failure'); process.exitCode = 4;`);
  await writeFile(join(f.store.dataDir, "evaluation-runs"), "unavailable destination", { flag: "wx" });
  const run = await f.run();
  assert.equal(run.status, "failed");
  assert.equal(run.error, "original command failure");
  assert.equal(run.commandEvidence.status, "incomplete");
  assert.equal(await readFile(join(run.commandEvidence.recoveryDirectory, "raw.txt"), "utf8"), "complete original");
  assert.ok(f.store.get().activity.some((entry) => entry.message === "Command evidence retention incomplete" && entry.detail.includes(run.commandEvidence.recoveryDirectory)));
});

test("partial artifact writes preserve the complete sink original and a truthful archived prefix", async (t) => {
  const f = await recorder(t);
  const source = "complete producer original";
  await writeFile(join(f.archive.artifactDir, "raw.txt"), source);
  const probe = await open(join(f.root, "prototype-probe"), "wx");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const write = prototype.write;
  let interrupted = false;
  t.mock.method(prototype, "write", async function (buffer, offset, length, ...rest) {
    if (!interrupted && Buffer.isBuffer(buffer) && buffer.toString() === source) {
      if (offset === 0) return write.call(this, buffer, offset, 4, ...rest);
      interrupted = true;
      throw new Error("injected artifact ENOSPC");
    }
    return write.call(this, buffer, offset, length, ...rest);
  });
  const reference = await finish(f.archive, { status: "failed", error: "original evaluation failure" });
  assert.equal(interrupted, true);
  assert.equal(reference.status, "incomplete");
  const manifest = await verifyManifest(f.root, reference);
  const file = manifest.files.find((entry) => entry.path === "artifacts/raw.txt");
  assert.equal(file.bytes, 4);
  assert.equal(file.complete, false);
  assert.equal(manifest.outcome.error, "original evaluation failure");
  assert.equal(manifest.recoveryDirectory, reference.recoveryDirectory);
  assert.equal(await readFile(join(reference.recoveryDirectory, "raw.txt"), "utf8"), source);
  assert.match(manifest.issues.join(" "), /injected artifact ENOSPC/);
});

for (const id of ["../outside", "/absolute", "a/b", "a\\b", ".", "..", "x".repeat(129)]) {
  test(`unsafe run ID ${JSON.stringify(id)} is rejected without path traversal`, async (t) => {
    const f = await recorder(t, id);
    const reference = await finish(f.archive);
    assert.equal(reference.status, "incomplete");
    assert.equal(reference.directory, undefined);
    assert.match(reference.issues.join(" "), /Unsafe evaluation run ID/);
    assert.equal(existsSync(join(f.store.dataDir, "evaluation-runs")), false);
  });
}

test("collector rejects unsafe names, links, directories and special files but keeps safe exports", async (t) => {
  const f = await recorder(t);
  const sink = f.archive.artifactDir;
  await writeFile(join(sink, "safe-file_1.txt"), "accepted");
  await writeFile(join(sink, "bad name.txt"), "rejected");
  await writeFile(join(sink, ".hidden"), "rejected");
  await writeFile(join(sink, "back\\slash"), "rejected");
  await writeFile(join(sink, "x".repeat(129)), "rejected");
  const outside = join(f.root, "outside.txt");
  await writeFile(outside, "outside bytes");
  await symlink(outside, join(sink, "symlink.txt"));
  await link(outside, join(sink, "hardlink.txt"));
  await symlink(f.cwd, join(sink, "directory-link"));
  await mkdir(join(sink, "subdirectory"));
  await writeFile(join(sink, "subdirectory/nested.txt"), "not traversed");
  assert.equal((await runCommand("mkfifo", [join(sink, "fifo")], { cwd: f.cwd })).exitCode, 0);
  const reference = await finish(f.archive);
  assert.equal(reference.status, "incomplete");
  const manifest = await verifyManifest(f.root, reference);
  assert.deepEqual(manifest.files.filter((file) => file.path.startsWith("artifacts/")).map((file) => file.path), ["artifacts/safe-file_1.txt"]);
  assert.match(manifest.issues.join(" "), /Unsafe export name/);
  assert.match(manifest.issues.join(" "), /regular file with exactly one link/);
  assert.equal(await readFile(outside, "utf8"), "outside bytes");
  assert.equal(reference.recoveryDirectory, sink);
  assert.equal(existsSync(sink), true);
});

test("replaced export and archive directories are not followed or recursively removed", async (t) => {
  const f = await recorder(t);
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "keep");
  await rm(f.archive.artifactDir, { recursive: true });
  await symlink(outside, f.archive.artifactDir);
  const reference = await finish(f.archive);
  assert.equal(reference.status, "incomplete");
  assert.match(reference.issues.join(" "), /Owned directory was removed or replaced/);
  assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "keep");
  assert.equal((await lstat(f.archive.artifactDir)).isSymbolicLink(), true);
  assert.equal(reference.recoveryDirectory, undefined, "a replaced sink is not represented as an owned recovery location");
  const other = await recorder(t, "evalrun_other");
  await rm(join(other.directory, "artifacts"), { recursive: true });
  await symlink(outside, join(other.directory, "artifacts"));
  await writeFile(join(other.archive.artifactDir, "new.txt"), "must not escape");
  const rejected = await finish(other.archive);
  assert.equal(rejected.status, "incomplete");
  assert.equal(existsSync(join(outside, "new.txt")), false);
});

for (const count of [128, 129]) test(`flat export entry count boundary: ${count}`, async (t) => {
  const f = await recorder(t);
  for (let i = 0; i < count; i++) await writeFile(join(f.archive.artifactDir, `file-${i}.txt`), `${i}`);
  const reference = await finish(f.archive);
  const manifest = await verifyManifest(f.root, reference);
  assert.equal(manifest.files.filter((file) => file.path.startsWith("artifacts/")).length, 128);
  assert.equal(reference.status, count === 128 ? "complete" : "incomplete");
  if (count === 129) assert.match(manifest.issues.join(" "), /Export count exceeds 128/);
});

test("recorded report bundle sizes fit the export limits without transforming raw files", () => {
  // Metadata from retained public-default-compile-v2 coverage/CUDA runs; no canonical files are read or copied.
  const bundles = [
    { name: "coverage", count: 13, total: 158812772,
      sizes: [45415241, 2162, 2143, 823, 45417449, 2563, 11080649, 851, 11080670, 851, 45417613, 2563, 389194] },
    { name: "CUDA performance", count: 9, total: 113272026,
      sizes: [45417588, 2563, 11080639, 851, 11080675, 851, 45417561, 2575, 268723] },
  ];
  for (const bundle of bundles) {
    assert.equal(bundle.sizes.length, bundle.count, bundle.name);
    assert.equal(bundle.sizes.reduce((sum, size) => sum + size, 0), bundle.total, bundle.name);
    assert.ok(bundle.count <= COMMAND_EVIDENCE_LIMITS.files, bundle.name);
    assert.ok(bundle.sizes.every((size) => size <= COMMAND_EVIDENCE_LIMITS.fileBytes), bundle.name);
    assert.ok(bundle.total <= COMMAND_EVIDENCE_LIMITS.exportBytes, bundle.name);
    assert.ok(bundle.sizes.some((size) => size > 32 * 1024 * 1024), "both bundles exceed the old per-file limit");
  }
  assert.ok(bundles[0].total > 128 * 1024 * 1024, "coverage also exceeds the old total limit");
});

test("per-file and total export byte limits accept the boundary and reject overflow", async (t) => {
  assert.deepEqual(COMMAND_EVIDENCE_LIMITS, { files: 128, fileBytes: 64 * 1024 * 1024, exportBytes: 512 * 1024 * 1024, streamBytes: 8 * 1024 * 1024 });
  const wholeFileCount = COMMAND_EVIDENCE_LIMITS.exportBytes / COMMAND_EVIDENCE_LIMITS.fileBytes;
  assert.equal(wholeFileCount, 8);
  const f = await recorder(t);
  // Sparse inputs avoid filling the producer sink; retained copies exercise the real 512 MiB ceiling.
  for (let i = 0; i < wholeFileCount; i++) {
    const handle = await open(join(f.archive.artifactDir, `${i}.bin`), "wx");
    await handle.truncate(COMMAND_EVIDENCE_LIMITS.fileBytes);
    await handle.close();
  }
  // Collect the exact boundary first; directory iteration order cannot influence this assertion.
  const reference = await finish(f.archive);
  const manifest = await verifyManifest(f.root, reference);
  assert.equal(reference.status, "complete");
  assert.equal(manifest.status, "complete");
  assert.deepEqual(manifest.limits, COMMAND_EVIDENCE_LIMITS);
  assert.equal(manifest.outcome.status, "completed");
  assert.ok(manifest.files.every((file) => file.complete));
  assert.equal(reference.recoveryDirectory, undefined);
  assert.equal(manifest.recoveryDirectory, undefined);
  assert.equal(existsSync(f.archive.artifactDir), false);
  assert.equal(manifest.files.filter((file) => file.path.startsWith("artifacts/")).reduce((sum, file) => sum + file.bytes, 0), COMMAND_EVIDENCE_LIMITS.exportBytes);
  const g = await recorder(t);
  const tooLarge = await open(join(g.archive.artifactDir, "too-large.bin"), "wx");
  await tooLarge.truncate(COMMAND_EVIDENCE_LIMITS.fileBytes + 1);
  await tooLarge.close();
  const rejected = await finish(g.archive);
  const rejectedManifest = await verifyManifest(g.root, rejected);
  assert.equal(rejected.status, "incomplete");
  assert.equal(rejectedManifest.status, "incomplete");
  assert.deepEqual(rejectedManifest.limits, COMMAND_EVIDENCE_LIMITS);
  assert.equal(rejectedManifest.outcome.status, "completed");
  assert.match(rejected.issues.join(" "), /64 MiB per-file limit/);
  assert.equal(rejectedManifest.files.some((file) => file.path.startsWith("artifacts/")), false);
  assert.equal(rejected.recoveryDirectory, g.archive.artifactDir);
  assert.equal(rejectedManifest.recoveryDirectory, g.archive.artifactDir);
  assert.equal((await lstat(join(rejected.recoveryDirectory, "too-large.bin"))).size, COMMAND_EVIDENCE_LIMITS.fileBytes + 1);
  // One extra maximum-size file must exceed the total in every possible enumeration order.
  const h = await recorder(t);
  for (let i = 0; i < wholeFileCount + 1; i++) {
    const handle = await open(join(h.archive.artifactDir, `${i}.bin`), "wx");
    await handle.truncate(COMMAND_EVIDENCE_LIMITS.fileBytes);
    await handle.close();
  }
  const totalRejected = await finish(h.archive);
  const totalManifest = await verifyManifest(h.root, totalRejected);
  assert.equal(totalRejected.status, "incomplete");
  assert.equal(totalManifest.status, "incomplete");
  assert.deepEqual(totalManifest.limits, COMMAND_EVIDENCE_LIMITS);
  assert.equal(totalManifest.outcome.status, "completed");
  assert.ok(totalManifest.files.every((file) => file.complete));
  assert.match(totalRejected.issues.join(" "), /512 MiB total limit/);
  assert.equal(totalManifest.files.filter((file) => file.path.startsWith("artifacts/")).reduce((sum, file) => sum + file.bytes, 0), COMMAND_EVIDENCE_LIMITS.exportBytes);
  assert.equal(totalRejected.recoveryDirectory, h.archive.artifactDir);
  assert.equal(totalManifest.recoveryDirectory, h.archive.artifactDir);
  const preserved = await readdir(totalRejected.recoveryDirectory);
  assert.equal(preserved.length, wholeFileCount + 1);
  for (const name of preserved) assert.equal((await lstat(join(totalRejected.recoveryDirectory, name))).size, COMMAND_EVIDENCE_LIMITS.fileBytes);
});

test("total export limit plus one byte is incomplete and recoverable regardless of enumeration order", async (t) => {
  const f = await recorder(t);
  const wholeFileCount = COMMAND_EVIDENCE_LIMITS.exportBytes / COMMAND_EVIDENCE_LIMITS.fileBytes;
  for (let i = 0; i < wholeFileCount; i++) {
    const handle = await open(join(f.archive.artifactDir, `${i}.bin`), "wx");
    await handle.truncate(COMMAND_EVIDENCE_LIMITS.fileBytes);
    await handle.close();
  }
  await writeFile(join(f.archive.artifactDir, "one-byte.bin"), Buffer.from([0x7f]));
  const reference = await finish(f.archive);
  const manifest = await verifyManifest(f.root, reference);
  assert.equal(reference.status, "incomplete");
  assert.equal(manifest.status, "incomplete");
  assert.deepEqual(manifest.limits, COMMAND_EVIDENCE_LIMITS);
  assert.equal(manifest.outcome.status, "completed");
  assert.equal((await json(join(f.directory, "normalized.json"))).score, 11.4);
  assert.match(reference.issues.join(" "), /512 MiB total limit/);
  assert.ok(manifest.files.every((file) => file.complete));
  const retainedBytes = manifest.files.filter((file) => file.path.startsWith("artifacts/")).reduce((sum, file) => sum + file.bytes, 0);
  assert.ok(retainedBytes <= COMMAND_EVIDENCE_LIMITS.exportBytes);
  // The byte can be retained before the last maximum-size file, or rejected after all eight fit.
  assert.ok([COMMAND_EVIDENCE_LIMITS.exportBytes, COMMAND_EVIDENCE_LIMITS.exportBytes - COMMAND_EVIDENCE_LIMITS.fileBytes + 1].includes(retainedBytes));
  assert.equal(reference.recoveryDirectory, f.archive.artifactDir);
  assert.equal(manifest.recoveryDirectory, f.archive.artifactDir);
  const preserved = await readdir(reference.recoveryDirectory);
  assert.equal(preserved.length, wholeFileCount + 1);
  for (const name of preserved) {
    assert.equal((await lstat(join(reference.recoveryDirectory, name))).size, name === "one-byte.bin" ? 1 : COMMAND_EVIDENCE_LIMITS.fileBytes);
  }
});

test("missing sink keeps raw data, marks capture incomplete, and preserves the original failure", async (t) => {
  const f = await recorder(t);
  await rm(f.archive.artifactDir, { recursive: true });
  const reference = await finish(f.archive, { status: "failed", error: "original invalid JSON" });
  assert.equal(reference.status, "incomplete");
  const manifest = await verifyManifest(f.root, reference);
  assert.equal(manifest.outcome.error, "original invalid JSON");
  assert.ok(manifest.files.some((file) => file.path === "stdout.txt"));
});

test("measurement metadata is a narrow projection, never a whole run or private settings dump", async (t) => {
  const f = await recorder(t);
  const reference = await finish(f.archive);
  const manifest = await verifyManifest(f.root, reference);
  assert.doesNotMatch(JSON.stringify(manifest), /DO-NOT-ARCHIVE-WHOLE-RUN/);
  assert.deepEqual(Object.keys(await json(join(f.directory, "measurement.json"))).sort(),
    ["agentRunId", "commandKind", "commit", "context", "createdAt", "cwd", "evaluationDefinitionVersion", "evaluationId", "evaluationName", "runId"].sort());
  assert.equal(manifest.measurement.runId, "evalrun_original");
});

test("full and screening commands record their actual selection without changing baseline semantics", async (t) => {
  for (const [context, portfolio, expected, kind] of [
    ["agent", false, 11.4, "full"], ["agent", true, 22.2, "screening"],
    ["screening_baseline", false, 22.2, "screening"], ["baseline", true, 11.4, "full"],
    ["composite", true, 11.4, "full"], ["manual", false, 11.4, "full"],
  ]) {
    const f = await fixture(t, print(), { yolo: portfolio, yoloBatchSize: 3 });
    await f.store.update((state) => { state.evaluations[0].screeningCommand = nodeCommand(print({ ...payload, score: 22.222 })); });
    const run = await f.run(context);
    assert.equal(run.score, expected, `${context}/${portfolio}`);
    assert.equal((await verifyManifest(f.root, run.commandEvidence)).measurement.commandKind, kind);
  }
});

test("prompt evaluations do not create a command archive or gain a new capture dependency", async (t) => {
  const f = await fixture(t);
  await f.store.update((state) => { delete state.evaluations[0].command; });
  f.orchestrator.codex = { preflight: async () => {}, evaluate: async (...args) => { assert.equal(args[5], undefined); return payload; } };
  const run = await f.run();
  assert.equal(run.status, "completed");
  assert.equal(run.commandEvidence, undefined);
  assert.equal(existsSync(join(f.store.dataDir, "evaluation-runs")), false);
});

test("baseline promotion preserves the original command archive identity and immutable bytes", async (t) => {
  const f = await fixture(t);
  const run = await f.run("composite");
  const original = await readFile(join(f.root, run.commandEvidence.manifest));
  await f.store.update((state) => {
    state.agentRuns.push({ id: "author-1", ideaId: "idea-1", status: "completed", branch: "burner/source", worktree: f.cwd,
      startedAt: run.createdAt, prState: "open", prNumber: 1, prUrl: "https://example.test/pull/1", baseRef: "main", baseCommit: "base", reviewApproved: true,
      reviewRounds: [{ id: "review", round: 1, commit: "measured-commit", approved: true, summary: "Approved", findings: [],
        createdAt: run.createdAt, completedAt: run.createdAt, baseCommit: "base", evaluationFingerprint: fullMergeValidationFingerprint(state) }], resources: [],
      deltas: [{ evaluationId: "bench", name: "Benchmark", before: 10, after: 11.4, delta: 1.4 }] });
    state.agentRuns[0].leafPr = fixtureLeafPr(state.agentRuns[0], { title: "Old", body: "Old", isDraft: true, state: "OPEN" }, { historical: true });
    state.evaluationRuns.push({ id: "baseline", evaluationId: "bench", status: "completed", context: "baseline", score: 10,
      commit: "base", createdAt: run.createdAt, durationMs: 1, evaluationDefinitionVersion: state.evaluations[0].definitionVersion });
  });
  const pr = { number: 1, url: "https://example.test/pull/1", state: "OPEN", headRefName: "burner/source", headRefOid: "measured-commit", title: "Old", body: "Old", isDraft: true, statusCheckRollup: [] };
  Object.assign(f.orchestrator.git, {
    tree: async () => "same-tested-tree", resolveRef: async (ref) => ref === "main" ? "base" : "measured-commit",
    createExistingWorktree: async () => f.cwd, assertWorktree: async () => undefined, hasChanges: async () => false,
    getPullRequest: async () => ({ ...pr }), editPr: async (_cwd, _number, title, body) => { Object.assign(pr, { title, body }); },
    removeWorktree: async () => undefined,
  });
  installLeafPrFixtureTransport(f.orchestrator.git, {
    observe: (...args) => f.orchestrator.git.getPullRequest(...args),
    edit: (cwd, number, field, value) => f.orchestrator.git.editPr(cwd, number, field === "title" ? value : pr.title, field === "body" ? value : pr.body),
  });
  f.orchestrator.codex = { preflight: async () => undefined, evaluate: async () => { assert.fail("full command reuse must not rerun the archived invocation"); } };
  assert.equal(await f.orchestrator.fullyValidateLeafForMerge("author-1", "base"), true);
  assert.equal(latestFullAssessment(f.store.get().agentRuns[0]).evaluation.evaluations[0].candidate[0].reuse.reason, "full-command");
  await f.store.update((state) => { state.agentRuns[0].prState = "merged"; });
  assert.equal(await f.orchestrator.promoteMergedAgentBaseline("author-1", "merged-commit"), true);
  const baseline = f.store.latestRuns().get("bench");
  assert.notEqual(baseline.id, run.id);
  assert.equal(baseline.commit, "merged-commit");
  assert.deepEqual(baseline.commandEvidence, run.commandEvidence);
  assert.equal(baseline.commandEvidence.runId, run.id);
  assert.deepEqual(await readFile(join(f.root, baseline.commandEvidence.manifest)), original);
  assert.equal((await verifyManifest(f.root, baseline.commandEvidence)).measurement.commit, "measured-commit");
});

test("archives survive canonical worktree removal and rolling state-history trimming, remaining Git-ignored", async (t) => {
  const f = await fixture(t);
  const git = async (...args) => {
    const result = await runCommand("git", args, { cwd: f.root });
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout.trim();
  };
  await git("init", "-q");
  await git("-c", "user.name=Burner Test", "-c", "user.email=burner-test@example.invalid", "commit", "--allow-empty", "-qm", "test root");
  await rm(f.cwd, { recursive: true });
  await git("worktree", "add", "-q", "--detach", f.cwd, "HEAD");
  f.orchestrator.git = new GitService(f.root, f.store.dataDir);
  const run = await f.run();
  const reference = run.commandEvidence;
  const original = await readFile(join(f.root, reference.manifest));
  await f.orchestrator.git.removeWorktree(f.cwd);
  assert.equal(existsSync(f.cwd), false);
  await f.store.update((state) => {
    for (let i = 0; i < 1001; i++) state.evaluationRuns.push({ ...run, id: `new-${i}`, commandEvidence: undefined,
      createdAt: new Date(Date.UTC(2027, 0, 1, 0, 0, i)).toISOString() });
  });
  assert.equal(f.store.get().evaluationRuns.some((entry) => entry.id === run.id), false);
  assert.deepEqual(await readFile(join(f.root, reference.manifest)), original);
  await verifyManifest(f.root, reference);
  const status = await git("status", "--short", "--untracked-files=all");
  assert.doesNotMatch(status, /evaluation-runs|state\.json|locks/);
  assert.match(status, /evaluations\.json/);
});

test("restart marks an unfinished capture incomplete without deleting its partial archive", async (t) => {
  const f = await recorder(t);
  await f.store.update((state) => state.evaluationRuns.push({ ...f.record, commandEvidence: structuredClone(f.archive.reference) }));
  const original = await readFile(join(f.directory, "measurement.json"));
  const reloaded = new StateStore(f.root);
  await reloaded.init();
  const run = reloaded.get().evaluationRuns.find((entry) => entry.id === f.record.id);
  assert.equal(run.status, "failed");
  assert.equal(run.commandEvidence.status, "incomplete");
  assert.equal(run.commandEvidence.recoveryDirectory, f.archive.artifactDir);
  assert.equal(existsSync(run.commandEvidence.recoveryDirectory), true);
  assert.match(run.commandEvidence.issues.join(" "), /stopped before command evidence was finalized/);
  assert.deepEqual(await readFile(join(f.directory, "measurement.json")), original);
  assert.equal(existsSync(join(f.directory, "manifest.json")), false);
});
