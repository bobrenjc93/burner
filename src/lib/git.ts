import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CompositeSource, ReviewRound, ScoreDelta } from "../types.js";
import { runCommand } from "./process.js";

export type PullRequestDisposition = "merged" | "unmerged";

type PullRequestMergeStatus = {
  state: "OPEN" | "CLOSED" | "MERGED";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  headRefOid: string;
};

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class GitService {
  private dispositionLabelsReady = false;

  constructor(
    readonly root: string,
    private readonly dataDir: string,
    private readonly mergePolling: { attempts?: number; intervalMs?: number; mergeAttempts?: number } = {},
  ) {}

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

  async tree(ref: string): Promise<string> {
    const result = await runCommand("git", ["rev-parse", `${ref}^{tree}`], { cwd: this.root });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not resolve tree for ${ref}`);
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

  async createDetachedWorktree(runId: string, ref: string): Promise<string> {
    const worktreesDir = join(this.dataDir, "worktrees");
    const path = join(worktreesDir, runId);
    await mkdir(worktreesDir, { recursive: true });
    await rm(path, { recursive: true, force: true });
    const result = await runCommand("git", ["worktree", "add", "--detach", path, ref], { cwd: this.root });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not create planning worktree at ${ref}`);
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

  async createExistingWorktree(runId: string, branch: string): Promise<string> {
    const worktreesDir = join(this.dataDir, "worktrees");
    const path = join(worktreesDir, runId);
    await mkdir(worktreesDir, { recursive: true });
    await rm(path, { recursive: true, force: true });
    const add = await runCommand("git", ["worktree", "add", path, branch], { cwd: this.root });
    if (add.exitCode !== 0) throw new Error(add.stderr.trim() || "Could not check out the living composite worktree");
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

  async pushCheckpoint(cwd: string, remote: string, checkpointBranch: string): Promise<void> {
    const result = await runCommand("git", ["push", "--force", remote, `HEAD:refs/heads/${checkpointBranch}`], { cwd, timeoutMs: 10 * 60 * 1000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not persist the living-line checkpoint");
  }

  async openPr(options: {
    cwd: string;
    base: string;
    branch: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<{ url: string; number?: number }> {
    const args = ["pr", "create", "--base", options.base, "--head", options.branch, "--title", options.title, "--body", options.body];
    if (options.draft) args.push("--draft");
    const result = await runCommand(
      "gh",
      args,
      { cwd: options.cwd, timeoutMs: 5 * 60 * 1000 },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not open pull request");
    const url = result.stdout.trim().split("\n").at(-1) ?? "";
    const match = url.match(/\/pull\/(\d+)/);
    const number = match ? Number(match[1]) : undefined;
    if (number) await this.markPrDisposition(options.cwd, number, "unmerged").catch(() => undefined);
    return { url, number };
  }

  async removeWorktree(path: string): Promise<void> {
    await runCommand("git", ["worktree", "remove", "--force", path], { cwd: this.root });
  }

  async editPr(cwd: string, number: number, title: string, body: string): Promise<void> {
    const result = await runCommand("gh", ["pr", "edit", String(number), "--title", title, "--body", body], { cwd, timeoutMs: 5 * 60 * 1000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not update PR #${number}`);
  }

  async markPrReady(cwd: string, number: number): Promise<void> {
    const result = await runCommand("gh", ["pr", "ready", String(number)], { cwd, timeoutMs: 2 * 60 * 1000 });
    const stderr = result.stderr.toLowerCase();
    if (result.exitCode !== 0 && !stderr.includes("already marked ready") && !stderr.includes("not a draft")) {
      throw new Error(result.stderr.trim() || `Could not mark PR #${number} ready`);
    }
  }

  async markPrDraft(cwd: string, number: number): Promise<void> {
    const result = await runCommand("gh", ["pr", "ready", String(number), "--undo"], { cwd, timeoutMs: 2 * 60 * 1000 });
    const stderr = result.stderr.toLowerCase();
    if (result.exitCode !== 0 && !stderr.includes("already a draft") && !stderr.includes("is a draft")) {
      throw new Error(result.stderr.trim() || `Could not mark PR #${number} as draft`);
    }
  }

  async changedFiles(cwd: string, base: string, head: string): Promise<string[]> {
    const result = await runCommand("git", ["diff", "--name-only", `${base}...${head}`], { cwd });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not compare ${base} and ${head}`);
    return result.stdout.split("\n").map((value) => value.trim()).filter(Boolean);
  }

  async closePr(cwd: string, number: number, comment: string, disposition: PullRequestDisposition = "unmerged"): Promise<void> {
    const result = await runCommand("gh", ["pr", "close", String(number), "--comment", comment], { cwd, timeoutMs: 5 * 60 * 1000 });
    if (result.exitCode !== 0 && !result.stderr.includes("already closed")) throw new Error(result.stderr.trim() || `Could not close PR #${number}`);
    await this.markPrDisposition(cwd, number, disposition).catch(() => undefined);
  }

  async mergePr(cwd: string, number: number): Promise<void> {
    const expectedHead = await this.head(cwd);
    const mergeAttempts = this.mergePolling.mergeAttempts ?? 3;
    let lastError = "";
    for (let attempt = 1; attempt <= mergeAttempts; attempt += 1) {
      const status = await this.waitForPrMergeability(cwd, number, expectedHead);
      if (status.state === "MERGED") {
        await this.markPrDisposition(cwd, number, "merged").catch(() => undefined);
        return;
      }
      const result = await runCommand("gh", ["pr", "merge", String(number), "--merge"], { cwd, timeoutMs: 10 * 60 * 1000 });
      if (result.exitCode === 0) {
        await this.markPrDisposition(cwd, number, "merged").catch(() => undefined);
        return;
      }
      lastError = result.stderr.trim() || result.stdout.trim() || `Could not merge PR #${number}`;
      const transient = /not mergeable|mergeability|head (?:branch|sha).*(?:changed|updated)|base branch.*(?:changed|updated)/i.test(lastError);
      if (!transient || attempt === mergeAttempts) throw new Error(lastError);
      await wait(this.mergePolling.intervalMs ?? 2_500);
    }
    throw new Error(lastError || `Could not merge PR #${number}`);
  }

  private async waitForPrMergeability(cwd: string, number: number, expectedHead: string): Promise<PullRequestMergeStatus> {
    const attempts = this.mergePolling.attempts ?? 24;
    const intervalMs = this.mergePolling.intervalMs ?? 2_500;
    let lastStatus: PullRequestMergeStatus | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = await runCommand(
        "gh",
        ["pr", "view", String(number), "--json", "state,mergeable,headRefOid"],
        { cwd, timeoutMs: 2 * 60 * 1000 },
      );
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not inspect PR #${number} mergeability`);
      lastStatus = JSON.parse(result.stdout) as PullRequestMergeStatus;
      if (lastStatus.state === "MERGED") return lastStatus;
      if (lastStatus.state !== "OPEN") throw new Error(`PR #${number} is ${lastStatus.state.toLowerCase()} instead of open.`);
      if (lastStatus.headRefOid === expectedHead && lastStatus.mergeable === "MERGEABLE") return lastStatus;
      if (lastStatus.headRefOid === expectedHead && lastStatus.mergeable === "CONFLICTING") {
        throw new Error(`PR #${number} conflicts with its base branch at ${expectedHead.slice(0, 8)}.`);
      }
      if (attempt < attempts) await wait(intervalMs);
    }
    const observed = lastStatus?.headRefOid ? lastStatus.headRefOid.slice(0, 8) : "unknown";
    throw new Error(`GitHub did not report PR #${number} mergeable at head ${expectedHead.slice(0, 8)} after ${attempts} checks (observed ${observed}, ${lastStatus?.mergeable ?? "UNKNOWN"}).`);
  }

  async markPrDisposition(cwd: string, number: number, disposition: PullRequestDisposition): Promise<void> {
    await this.ensureDispositionLabels(cwd);
    const desired = `burner-${disposition}`;
    const opposite = disposition === "merged" ? "burner-unmerged" : "burner-merged";
    const args = ["pr", "edit", String(number), "--add-label", desired, "--remove-label", opposite];
    if (disposition === "merged") args.push("--remove-label", "burner-quarantined");
    const result = await runCommand(
      "gh",
      args,
      { cwd, timeoutMs: 2 * 60 * 1000 },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not label PR #${number} as ${disposition}`);
  }

  async markPrQuarantined(cwd: string, number: number): Promise<void> {
    await this.ensureDispositionLabels(cwd);
    const result = await runCommand(
      "gh",
      ["pr", "edit", String(number), "--add-label", "burner-quarantined"],
      { cwd, timeoutMs: 2 * 60 * 1000 },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not quarantine PR #${number}`);
  }

  private async ensureDispositionLabels(cwd: string): Promise<void> {
    if (this.dispositionLabelsReady) return;
    const labels = [
      ["burner-merged", "1f883d", "Merged directly or included through a merged Burner composite"],
      ["burner-unmerged", "d97706", "Open or closed without inclusion in main"],
      ["burner-quarantined", "cf222e", "Removed from an autonomous batch after exhausting its review budget"],
    ] as const;
    for (const [name, color, description] of labels) {
      const result = await runCommand(
        "gh",
        ["label", "create", name, "--color", color, "--description", description, "--force"],
        { cwd, timeoutMs: 2 * 60 * 1000 },
      );
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not create GitHub label '${name}'`);
    }
    this.dispositionLabelsReady = true;
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
        const name = `${delta.name}${delta.screening ? " (leaf screen)" : ""}`;
        return `| ${name.replace(/\|/g, "\\|")} | ${before} | ${after} | ${change} |`;
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
    deltas.some((delta) => delta.screening)
      ? "<sub>Leaf-screen commands are compared with the same screen on the base. Composite PRs rerun each full command on the combined checkout before merging.</sub>"
      : "<sub>Generated and evaluated locally by Burner. Scores are model-based signals; review the code and evidence before merging.</sub>",
  ].join("\n");
}

export function buildCompositePrBody(options: { description: string; sources: CompositeSource[]; deltas: ScoreDelta[]; compositeScore: number; impact: number; reviewRounds: ReviewRound[] }): string {
  const visibleSources = options.sources.slice(-100);
  const omittedSources = options.sources.length - visibleSources.length;
  return [
    "## Master cook",
    "",
    options.description,
    "",
    `This living composite was built and evaluated from the actual combined code for ${options.sources.length} constituent changes:`,
    "",
    ...(omittedSources ? [`- … ${omittedSources} earlier constituent changes retained in the living line`] : []),
    ...visibleSources.map((source) => source.prNumber ? `- #${source.prNumber} — ${source.title}` : `- 🧪 ${source.title} — absorbed experiment${source.impact === undefined ? "" : ` (${source.impact >= 0 ? "+" : ""}${source.impact.toFixed(1)})`}`),
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
    "Burner continuously updates this feature branch with approved, regression-free experiments. Merging it closes included source PRs and rebuilds every other open composite against the new base.",
    "",
    "<sub>Composite scores are recalculated from the combined worktree, never inferred by adding individual deltas.</sub>",
  ].join("\n");
}

export function buildCompositeDraftPrBody(options: { description: string; sources: CompositeSource[]; reviewRounds?: ReviewRound[]; phase: string }): string {
  return [
    "## Master cook · draft",
    "",
    options.description,
    "",
    `🚧 **Burner is ${options.phase}.** This PR is visible early for auditability but is not mergeable until independent review and combined-code evaluation finish.`,
    "",
    "## Constituent changes",
    "",
    ...options.sources.map((source) => source.prNumber ? `- #${source.prNumber} — ${source.title}` : `- 🧪 ${source.title}`),
    "",
    ...(options.reviewRounds?.length ? reviewSection(options.reviewRounds) : []),
    "## Recalculated composite evaluation",
    "",
    "Pending. Burner will replace this section with scores measured from the actual combined checkout, then mark the PR ready.",
    "",
    "<sub>Draft opened early by Burner so integration and review progress is visible on GitHub.</sub>",
  ].join("\n");
}
