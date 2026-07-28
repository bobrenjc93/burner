import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CompositeSource, ReviewRound, ScoreDelta } from "../types.js";
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

  async resolveRef(ref: string): Promise<string> {
    const result = await runCommand("git", ["rev-parse", ref], { cwd: this.root });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not resolve ${ref}`);
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

  async createRebuildWorktree(runId: string, branch: string, baseBranch: string): Promise<string> {
    const worktreesDir = join(this.dataDir, "worktrees");
    const path = join(worktreesDir, runId);
    await mkdir(worktreesDir, { recursive: true });
    await rm(path, { recursive: true, force: true });
    const add = await runCommand("git", ["worktree", "add", path, branch], { cwd: this.root });
    if (add.exitCode !== 0) throw new Error(add.stderr.trim() || "Could not recreate composite worktree");
    const reset = await runCommand("git", ["reset", "--hard", baseBranch], { cwd: path });
    if (reset.exitCode !== 0) throw new Error(reset.stderr.trim() || `Could not reset composite to ${baseBranch}`);
    return path;
  }

  async mergeBranch(cwd: string, branch: string): Promise<{ merged: boolean; conflict: boolean }> {
    const result = await runCommand(
      "git",
      ["-c", "user.name=Burner", "-c", "user.email=burner@localhost", "merge", "--no-ff", "--no-edit", branch],
      { cwd },
    );
    if (result.exitCode === 0) return { merged: true, conflict: false };
    const status = await runCommand("git", ["diff", "--name-only", "--diff-filter=U"], { cwd });
    if (status.stdout.trim()) return { merged: false, conflict: true };
    throw new Error(result.stderr.trim() || `Could not merge ${branch}`);
  }

  async fetchBranch(remote: string, branch: string): Promise<string> {
    const result = await runCommand("git", ["fetch", remote, `refs/heads/${branch}:refs/remotes/${remote}/${branch}`], { cwd: this.root, timeoutMs: 10 * 60 * 1000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not fetch ${remote}/${branch}`);
    return `${remote}/${branch}`;
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

  async forcePush(cwd: string, remote: string, branch: string): Promise<void> {
    const result = await runCommand("git", ["push", "--force-with-lease", "-u", remote, branch], { cwd, timeoutMs: 10 * 60 * 1000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not update composite branch");
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

  async editPr(cwd: string, number: number, title: string, body: string): Promise<void> {
    const result = await runCommand("gh", ["pr", "edit", String(number), "--title", title, "--body", body], { cwd, timeoutMs: 5 * 60 * 1000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not update PR #${number}`);
  }

  async closePr(cwd: string, number: number, comment: string): Promise<void> {
    const result = await runCommand("gh", ["pr", "close", String(number), "--comment", comment], { cwd, timeoutMs: 5 * 60 * 1000 });
    if (result.exitCode !== 0 && !result.stderr.includes("already closed")) throw new Error(result.stderr.trim() || `Could not close PR #${number}`);
  }

  async mergePr(cwd: string, number: number): Promise<void> {
    const result = await runCommand("gh", ["pr", "merge", String(number), "--merge"], { cwd, timeoutMs: 10 * 60 * 1000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not merge PR #${number}`);
  }

  async listPullRequests(cwd = this.root): Promise<Array<{ number: number; state: "OPEN" | "CLOSED" | "MERGED"; headRefName: string; url: string }>> {
    const result = await runCommand("gh", ["pr", "list", "--state", "all", "--limit", "1000", "--json", "number,state,headRefName,url"], { cwd, timeoutMs: 2 * 60 * 1000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not synchronize pull requests");
    return JSON.parse(result.stdout) as Array<{ number: number; state: "OPEN" | "CLOSED" | "MERGED"; headRefName: string; url: string }>;
  }

  async syncBase(remote: string, baseBranch: string): Promise<string> {
    const fetch = await runCommand("git", ["fetch", remote, baseBranch], { cwd: this.root, timeoutMs: 10 * 60 * 1000 });
    if (fetch.exitCode !== 0) throw new Error(fetch.stderr.trim() || `Could not fetch ${remote}/${baseBranch}`);
    const status = await this.status();
    if (status.dirty) throw new Error("Cannot update the base branch while the root checkout has uncommitted changes.");
    if (status.branch !== baseBranch) throw new Error(`Switch the root checkout to '${baseBranch}' so Burner can fast-forward after merges.`);
    const merge = await runCommand("git", ["merge", "--ff-only", `${remote}/${baseBranch}`], { cwd: this.root });
    if (merge.exitCode !== 0) throw new Error(merge.stderr.trim() || `Could not fast-forward ${baseBranch}`);
    return this.head();
  }

  async remoteExists(remote: string): Promise<boolean> {
    return (await runCommand("git", ["remote", "get-url", remote], { cwd: this.root })).exitCode === 0;
  }
}

function reviewSection(reviewRounds: ReviewRound[]): string[] {
  const approved = reviewRounds.at(-1)?.approved;
  return [
    "## Review loop",
    "",
    approved ? `✅ Approved by an independent Codex reviewer after ${reviewRounds.length} round${reviewRounds.length === 1 ? "" : "s"}.` : "⚠️ Review approval was not recorded.",
    "",
    ...reviewRounds.map((round) => `- Round ${round.round}: ${round.approved ? "approved" : `${round.findings.length} finding${round.findings.length === 1 ? "" : "s"}`}`),
    "",
  ];
}

function evaluationRows(deltas: ScoreDelta[]): string {
  return deltas.length
    ? deltas.map((delta) => {
        const before = delta.before === undefined ? "—" : delta.before.toFixed(1);
        const after = delta.after === undefined ? "—" : delta.after.toFixed(1);
        const change = delta.delta === undefined ? "—" : `${delta.delta >= 0 ? "+" : ""}${delta.delta.toFixed(1)}`;
        return `| ${delta.name.replace(/\|/g, "\\|")} | ${before} | ${after} | ${change} |`;
      }).join("\n")
    : "| No completed evaluations | — | — | — |";
}

export function buildPrBody(description: string, lastMessage: string, deltas: ScoreDelta[], impact: number, reviewRounds: ReviewRound[] = []): string {
  const rows = evaluationRows(deltas);
  return [
    "## What changed",
    "",
    description,
    "",
    lastMessage,
    "",
    ...reviewSection(reviewRounds),
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

export function buildCompositePrBody(options: { description: string; sources: CompositeSource[]; deltas: ScoreDelta[]; compositeScore: number; impact: number; reviewRounds: ReviewRound[] }): string {
  return [
    "## Master cook",
    "",
    options.description,
    "",
    `This composite was built and evaluated from the actual combined code for ${options.sources.length} pull requests:`,
    "",
    ...options.sources.map((source) => `- #${source.prNumber} — ${source.title}`),
    "",
    ...reviewSection(options.reviewRounds),
    "## Recalculated composite evaluation",
    "",
    `**Composite score: ${options.compositeScore.toFixed(1)} / 100** · **Impact: ${options.impact >= 0 ? "+" : ""}${options.impact.toFixed(1)}**`,
    "",
    "| Evaluation | Base | Composite | Delta |",
    "| --- | ---: | ---: | ---: |",
    evaluationRows(options.deltas),
    "",
    "Merging this PR tells Burner to close the included source PRs and rebuild every other open composite against the new base.",
    "",
    "<sub>Composite scores are recalculated from the combined worktree, never inferred by adding individual deltas.</sub>",
  ].join("\n");
}
