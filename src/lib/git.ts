import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ScoreDelta } from "../types.js";
import { runCommand } from "./process.js";

export class GitService {
  constructor(readonly root: string, private readonly dataDir: string) {}

  async status(): Promise<{ available: boolean; branch?: string; commit?: string; dirty?: boolean }> {
    const inside = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd: this.root }).catch(() => undefined);
    if (!inside || inside.exitCode !== 0) return { available: false };
    const [branch, commit, dirty] = await Promise.all([
      runCommand("git", ["branch", "--show-current"], { cwd: this.root }),
      runCommand("git", ["rev-parse", "--short", "HEAD"], { cwd: this.root }),
      runCommand("git", ["status", "--porcelain"], { cwd: this.root }),
    ]);
    return {
      available: true,
      branch: branch.stdout.trim() || undefined,
      commit: commit.stdout.trim() || undefined,
      dirty: Boolean(dirty.stdout.trim()),
    };
  }

  async head(cwd = this.root): Promise<string> {
    const result = await runCommand("git", ["rev-parse", "HEAD"], { cwd });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not resolve git HEAD");
    return result.stdout.trim();
  }

  async hasRef(ref: string): Promise<boolean> {
    return (await runCommand("git", ["rev-parse", "--verify", ref], { cwd: this.root })).exitCode === 0;
  }

  async createWorktree(runId: string, branch: string, baseBranch: string): Promise<string> {
    const worktreesDir = join(this.dataDir, "worktrees");
    const path = join(worktreesDir, runId);
    await mkdir(worktreesDir, { recursive: true });
    await rm(path, { recursive: true, force: true });
    const result = await runCommand("git", ["worktree", "add", "-b", branch, path, baseBranch], { cwd: this.root });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not create worktree");
    return path;
  }

  async hasChanges(cwd: string): Promise<boolean> {
    const result = await runCommand("git", ["status", "--porcelain"], { cwd });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not inspect worktree changes");
    return Boolean(result.stdout.trim());
  }

  async commit(cwd: string, message: string): Promise<string> {
    const add = await runCommand("git", ["add", "-A"], { cwd });
    if (add.exitCode !== 0) throw new Error(add.stderr.trim() || "Could not stage changes");
    const commit = await runCommand(
      "git",
      ["-c", "user.name=Burner", "-c", "user.email=burner@localhost", "commit", "-m", message],
      { cwd },
    );
    if (commit.exitCode !== 0) throw new Error(commit.stderr.trim() || "Could not commit changes");
    return this.head(cwd);
  }

  async push(cwd: string, remote: string, branch: string): Promise<void> {
    const result = await runCommand("git", ["push", "-u", remote, branch], { cwd, timeoutMs: 10 * 60 * 1000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not push branch");
  }

  async openPr(options: {
    cwd: string;
    base: string;
    branch: string;
    title: string;
    body: string;
  }): Promise<{ url: string; number?: number }> {
    const result = await runCommand(
      "gh",
      ["pr", "create", "--base", options.base, "--head", options.branch, "--title", options.title, "--body", options.body],
      { cwd: options.cwd, timeoutMs: 5 * 60 * 1000 },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not open pull request");
    const url = result.stdout.trim().split("\n").at(-1) ?? "";
    const match = url.match(/\/pull\/(\d+)/);
    return { url, number: match ? Number(match[1]) : undefined };
  }

  async removeWorktree(path: string): Promise<void> {
    await runCommand("git", ["worktree", "remove", "--force", path], { cwd: this.root });
  }

  async remoteExists(remote: string): Promise<boolean> {
    return (await runCommand("git", ["remote", "get-url", remote], { cwd: this.root })).exitCode === 0;
  }
}

export function buildPrBody(description: string, lastMessage: string, deltas: ScoreDelta[], impact: number): string {
  const rows = deltas.length
    ? deltas
        .map((delta) => {
          const before = delta.before === undefined ? "—" : delta.before.toFixed(1);
          const after = delta.after === undefined ? "—" : delta.after.toFixed(1);
          const change = delta.delta === undefined ? "—" : `${delta.delta >= 0 ? "+" : ""}${delta.delta.toFixed(1)}`;
          return `| ${delta.name.replace(/\|/g, "\\|")} | ${before} | ${after} | ${change} |`;
        })
        .join("\n")
    : "| No completed evaluations | — | — | — |";
  return [
    "## What changed",
    "",
    description,
    "",
    lastMessage,
    "",
    "## Evaluation impact",
    "",
    `**Burner impact score: ${impact >= 0 ? "+" : ""}${impact.toFixed(1)}**`,
    "",
    "| Evaluation | Before | After | Delta |",
    "| --- | ---: | ---: | ---: |",
    rows,
    "",
    "<sub>Generated and evaluated locally by Burner. Scores are model-based signals; review the code and evidence before merging.</sub>",
  ].join("\n");
}
