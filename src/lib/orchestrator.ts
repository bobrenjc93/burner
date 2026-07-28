import { join } from "node:path";
import type { AgentRun, BurnerState, CompositePr, CompositeSource, EvaluationRun, Idea, ReviewRound, RuntimeStatus, ScoreDelta } from "../types.js";
import { CodexClient, type ReviewResult, type SessionResult } from "./codex.js";
import { EventHub } from "./events.js";
import { buildCompositePrBody, buildPrBody, GitService } from "./git.js";
import type { HeldLock } from "./locks.js";
import { LockManager } from "./locks.js";
import { commandExists, runCommand } from "./process.js";
import { StateStore } from "./store.js";
import { errorMessage, id, mapLimit, now, slugify, weightedScore } from "./utils.js";

export class Orchestrator {
  private readonly git: GitService;
  private readonly locks: LockManager;
  private readonly codex: CodexClient;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private activeAgents = new Set<string>();
  private activeComposites = new Set<string>();
  private runningEvaluations = 0;
  private lastPrSyncAt = 0;
  private runtimeCache?: { value: RuntimeStatus; expires: number };

  constructor(
    private readonly root: string,
    private readonly store: StateStore,
    private readonly events: EventHub,
  ) {
    this.git = new GitService(root, store.dataDir);
    this.locks = new LockManager(join(store.dataDir, "locks"));
    this.codex = new CodexClient((message) => {
      const clean = message.trim().slice(0, 800);
      if (clean) this.events.emit("progress", { message: clean });
    });
  }

  async init(): Promise<void> {
    await this.locks.init();
    const orphanedLocks = await this.locks.reapOrphans();
    if (orphanedLocks.length) {
      await this.store.addActivity({ type: "system", message: "Recovered stale resource locks", detail: orphanedLocks.join(", ") });
    }
    const status = await this.git.status();
    if (status.available && status.branch) {
      const state = this.store.get();
      if (!(await this.git.hasRef(state.settings.baseBranch))) {
        await this.store.update((draft) => {
          draft.settings.baseBranch = status.branch!;
        });
      }
    }
    this.timer = setInterval(() => void this.tick(), 5_000);
    this.timer.unref();
    if (this.store.get().settings.autoRun) await this.setEnabled(true);
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.store.update((state) => {
      state.orchestrator.enabled = false;
    });
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.store.update((state) => {
      state.orchestrator.enabled = enabled;
    });
    await this.store.addActivity({
      type: "system",
      message: enabled ? "Orchestrator ignited" : "Orchestrator paused",
      detail: enabled ? "Burner is watching evaluations and dispatching queued work." : "Running agents will finish; new work will not start.",
    });
    this.events.emit("state", this.store.get());
    if (enabled) void this.tick(true);
  }

  async runCycle(): Promise<void> {
    await this.tick(true);
  }

  async runEvaluations(context: EvaluationRun["context"] = "manual", cwd = this.root, agentRunId?: string, compositeId?: string): Promise<EvaluationRun[]> {
    const state = this.store.get();
    const evaluations = state.evaluations.filter((evaluation) => evaluation.enabled);
    if (!evaluations.length) throw new Error("Add at least one enabled evaluation first.");
    if (!(await commandExists("codex", this.root))) throw new Error("Codex CLI is not available. Install and authenticate Codex first.");
    const commit = await this.git.head(cwd);
    this.runningEvaluations += evaluations.length;
    await this.store.addActivity({
      type: "evaluation",
      message: `Running ${evaluations.length} evaluation${evaluations.length === 1 ? "" : "s"}`,
      detail: context === "agent" || context === "composite" ? "Measuring the candidate branch." : `At commit ${commit.slice(0, 8)}.`,
    });
    try {
      const runs = await mapLimit(evaluations, Math.min(state.settings.parallelism, 3), async (evaluation) => {
        const run: EvaluationRun = {
          id: id("evalrun"),
          evaluationId: evaluation.id,
          commit,
          createdAt: now(),
          durationMs: 0,
          status: "running",
          context,
          agentRunId,
          compositeId,
        };
        const started = Date.now();
        await this.store.update((draft) => draft.evaluationRuns.push(run));
        this.events.emit("evaluation", { id: run.id, status: "running", evaluationId: evaluation.id });
        try {
          const output = await this.codex.evaluate(cwd, evaluation, state.settings, context);
          Object.assign(run, output, { status: "completed" as const, durationMs: Date.now() - started });
          await this.store.update((draft) => {
            const current = draft.evaluationRuns.find((item) => item.id === run.id);
            if (current) Object.assign(current, run);
          });
          this.events.emit("evaluation", { id: run.id, status: "completed", score: run.score });
        } catch (error) {
          Object.assign(run, { status: "failed" as const, error: errorMessage(error), durationMs: Date.now() - started });
          await this.store.update((draft) => {
            const current = draft.evaluationRuns.find((item) => item.id === run.id);
            if (current) Object.assign(current, run);
          });
          this.events.emit("evaluation", { id: run.id, status: "failed", error: run.error });
        }
        return run;
      });
      const succeeded = runs.filter((run) => run.status === "completed").length;
      await this.store.addActivity({
        type: succeeded === runs.length ? "evaluation" : "error",
        message: `${succeeded}/${runs.length} evaluations completed`,
        detail: context === "agent" || context === "composite" ? "Candidate branch scoring finished." : "Baseline signals are up to date.",
      });
      if (context !== "agent" && context !== "composite") {
        await this.store.update((draft) => {
          draft.orchestrator.lastEvaluationAt = now();
        });
      }
      return runs;
    } finally {
      this.runningEvaluations -= evaluations.length;
      this.events.emit("state", this.store.get());
    }
  }

  async plan(): Promise<Idea[]> {
    const state = this.store.get();
    const evaluations = state.evaluations.filter((evaluation) => evaluation.enabled);
    const latest = this.store.latestRuns();
    if (!evaluations.some((evaluation) => latest.has(evaluation.id))) {
      throw new Error("Run a baseline evaluation before generating ideas.");
    }
    await this.store.addActivity({ type: "idea", message: "Planning the next improvements", detail: "Codex is inspecting weak signals and open work." });
    const planned = await this.codex.planIdeas(this.root, evaluations, latest, state.ideas, state.settings);
    const created: Idea[] = planned
      .filter((idea) => idea.title && idea.description)
      .map((idea) => ({ ...idea, id: id("idea"), status: "queued", createdAt: now(), updatedAt: now(), source: "codex" }));
    await this.store.update((draft) => {
      draft.ideas.push(...created);
      draft.orchestrator.lastPlanningAt = now();
    });
    await this.store.addActivity({
      type: "idea",
      message: `${created.length} improvement${created.length === 1 ? "" : "s"} added to the queue`,
      detail: created[0]?.title,
    });
    this.events.emit("state", this.store.get());
    return created;
  }

  async runtimeStatus(force = false): Promise<RuntimeStatus> {
    if (!force && this.runtimeCache && this.runtimeCache.expires > Date.now()) return this.runtimeCache.value;
    const [git, heldLocks, codexAvailable, ghAvailable] = await Promise.all([
      this.git.status(),
      this.locks.list(),
      commandExists("codex", this.root),
      commandExists("gh", this.root),
    ]);
    let codexVersion: string | undefined;
    let ghAuthenticated = false;
    if (codexAvailable) {
      const result = await runCommand("codex", ["--version"], { cwd: this.root, timeoutMs: 5_000 });
      codexVersion = result.stdout.trim().split("\n").find((line) => line.includes("codex-cli"))?.trim();
    }
    if (ghAvailable) {
      ghAuthenticated = (await runCommand("gh", ["auth", "status"], { cwd: this.root, timeoutMs: 8_000 })).exitCode === 0;
    }
    const value: RuntimeStatus = {
      codex: { available: codexAvailable, version: codexVersion },
      git,
      gh: { available: ghAvailable, authenticated: ghAuthenticated },
      runningEvaluations: this.runningEvaluations,
      runningAgents: this.activeAgents.size,
      runningComposites: this.activeComposites.size,
      heldLocks,
    };
    this.runtimeCache = { value, expires: Date.now() + 4_000 };
    return value;
  }

  async createComposite(agentRunIds: string[], title?: string, description?: string): Promise<CompositePr> {
    const uniqueIds = [...new Set(agentRunIds)];
    const state = this.store.get();
    const sources: CompositeSource[] = uniqueIds.map((runId) => {
      const run = state.agentRuns.find((item) => item.id === runId);
      const idea = run ? state.ideas.find((item) => item.id === run.ideaId) : undefined;
      if (!run?.prNumber || !run.prUrl || (run.prState && run.prState !== "open")) throw new Error("Every composite source must be an open Burner pull request.");
      return { agentRunId: run.id, prNumber: run.prNumber, title: idea?.title ?? run.branch, branch: run.branch };
    });
    if (sources.length < 2) throw new Error("Choose at least two open pull requests to master cook.");
    const compositeId = id("composite");
    const timestamp = now();
    const composite: CompositePr = {
      id: compositeId,
      title: title?.trim().slice(0, 120) || `Composite: ${sources.map((source) => `#${source.prNumber}`).join(" + ")}`,
      description: description?.trim() || "A master-cooked combination of independently reviewed Burner improvements.",
      status: "queued",
      branch: `burner/composite-${slugify(title || sources.map((source) => source.title).join("-"), 28)}-${compositeId.slice(-6)}`,
      worktree: "",
      sources,
      deltas: [],
      reviewRounds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.update((draft) => draft.composites.push(composite));
    await this.store.addActivity({ type: "pr", message: `Composite queued: ${composite.title}`, detail: `${sources.length} source PRs will be merged and re-evaluated.` });
    this.events.emit("state", this.store.get());
    void this.scheduleComposites(true);
    return composite;
  }

  async mergeComposite(compositeId: string): Promise<void> {
    const composite = this.store.get().composites.find((item) => item.id === compositeId);
    if (!composite?.prNumber || composite.status !== "open") throw new Error("Only an open composite pull request can be merged.");
    await this.git.mergePr(this.root, composite.prNumber);
    await this.store.addActivity({ type: "pr", message: `Merge requested: ${composite.title}`, detail: `Waiting for GitHub to merge PR #${composite.prNumber}.` });
    await this.syncPullRequests(true);
  }

  async retryComposite(compositeId: string): Promise<void> {
    let found = false;
    await this.store.update((state) => {
      const composite = state.composites.find((item) => item.id === compositeId);
      if (composite && composite.status === "failed") {
        composite.status = composite.prNumber ? "rebuilding" : "queued";
        composite.error = undefined;
        composite.reviewRounds = [];
        composite.reviewApproved = false;
        composite.updatedAt = now();
        found = true;
      }
    });
    if (!found) throw new Error("Only a failed composite can be retried.");
    void this.scheduleComposites(true);
  }

  async syncPullRequests(force = false): Promise<void> {
    if (!force && Date.now() - this.lastPrSyncAt < 20_000) return;
    this.lastPrSyncAt = Date.now();
    const state = this.store.get();
    if (!(await this.git.remoteExists(state.settings.remote)) || !(await commandExists("gh", this.root))) return;
    let pullRequests: Awaited<ReturnType<GitService["listPullRequests"]>>;
    try {
      pullRequests = await this.git.listPullRequests();
    } catch (error) {
      if (force) throw error;
      return;
    }
    const byNumber = new Map(pullRequests.map((pr) => [pr.number, pr]));
    const newlyMergedCompositeIds: string[] = [];
    const changedRunIds = new Set<string>();
    let baseChanged = Boolean(state.orchestrator.baseSyncPending);
    await this.store.update((draft) => {
      for (const run of draft.agentRuns) {
        if (!run.prNumber) continue;
        const remote = byNumber.get(run.prNumber);
        if (!remote) continue;
        const next = remote.state === "OPEN" ? "open" : remote.state === "MERGED" ? "merged" : run.prState === "superseded" ? "superseded" : "closed";
        if (run.prState !== next) {
          if (next === "merged") { baseChanged = true; draft.orchestrator.baseSyncPending = true; }
          run.prState = next;
          changedRunIds.add(run.id);
        }
      }
      for (const composite of draft.composites) {
        if (!composite.prNumber) continue;
        const remote = byNumber.get(composite.prNumber);
        if (!remote) continue;
        if (remote.state === "MERGED" && composite.status !== "merged") {
          composite.status = "merged";
          composite.mergedAt = now();
          composite.updatedAt = now();
          newlyMergedCompositeIds.push(composite.id);
          baseChanged = true;
          draft.orchestrator.baseSyncPending = true;
        } else if (remote.state === "CLOSED" && composite.status !== "merged" && composite.status !== "closed") {
          composite.status = "closed";
          composite.updatedAt = now();
        } else if (remote.state === "OPEN" && composite.status === "closed") {
          composite.status = "open";
          composite.updatedAt = now();
        }
      }
    });

    for (const compositeId of newlyMergedCompositeIds) {
      const composite = this.store.get().composites.find((item) => item.id === compositeId);
      if (!composite) continue;
      for (const source of composite.sources) {
        const run = this.store.get().agentRuns.find((item) => item.id === source.agentRunId);
        if (run?.prState === "open") {
          await this.git.closePr(this.root, source.prNumber, `Superseded by merged composite PR #${composite.prNumber}.`);
          await this.store.update((draft) => {
            const current = draft.agentRuns.find((item) => item.id === source.agentRunId);
            if (current) { current.prState = "superseded"; current.supersededByCompositeId = compositeId; }
          });
          changedRunIds.add(source.agentRunId);
        }
      }
      await this.store.addActivity({ type: "pr", message: `Composite merged: ${composite.title}`, detail: "Source PRs were closed and the base branch will be refreshed." });
    }

    if (baseChanged) {
      const commit = await this.git.syncBase(state.settings.remote, state.settings.baseBranch);
      await this.store.update((draft) => {
        draft.orchestrator.lastEvaluationAt = undefined;
        draft.orchestrator.lastPlanningAt = undefined;
        draft.orchestrator.baseSyncPending = false;
      });
      await this.store.addActivity({ type: "system", message: `Base updated to ${commit.slice(0, 8)}`, detail: "New agents will branch from the merged main; baseline and composites are being recalculated." });
    }

    const after = this.store.get();
    for (const composite of after.composites.filter((item) => item.status === "open")) {
      const filtered = composite.sources.filter((source) => after.agentRuns.find((run) => run.id === source.agentRunId)?.prState === "open");
      const affected = baseChanged || filtered.length !== composite.sources.length || filtered.some((source) => changedRunIds.has(source.agentRunId));
      if (!affected) continue;
      if (filtered.length < 2) {
        if (composite.prNumber) await this.git.closePr(this.root, composite.prNumber, "Burner closed this composite because fewer than two source PRs remain open after reconciliation.");
        await this.store.update((draft) => {
          const current = draft.composites.find((item) => item.id === composite.id);
          if (current) { current.sources = filtered; current.status = "closed"; current.updatedAt = now(); }
        });
      } else {
        await this.store.update((draft) => {
          const current = draft.composites.find((item) => item.id === composite.id);
          if (current) { current.sources = filtered; current.status = "rebuilding"; current.reviewApproved = false; current.reviewRounds = []; current.updatedAt = now(); }
        });
      }
    }
    this.events.emit("state", this.store.get());
  }

  private async tick(force = false): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.syncPullRequests();
      const initial = this.store.get();
      if (!initial.orchestrator.enabled && !force) return;
      const settings = initial.settings;
      const evaluationDue =
        force ||
        !initial.orchestrator.lastEvaluationAt ||
        Date.now() - new Date(initial.orchestrator.lastEvaluationAt).getTime() >= settings.evaluationIntervalMinutes * 60_000;
      if (evaluationDue && this.runningEvaluations === 0 && this.activeAgents.size === 0 && this.activeComposites.size === 0) {
        await this.runEvaluations("baseline");
      }
      const refreshed = this.store.get();
      const planningDue =
        force ||
        !refreshed.orchestrator.lastPlanningAt ||
        Date.now() - new Date(refreshed.orchestrator.lastPlanningAt).getTime() >= settings.orchestratorIntervalMinutes * 60_000;
      const queued = refreshed.ideas.filter((idea) => idea.status === "queued").length;
      if (planningDue && queued < settings.parallelism * 2) await this.plan();
      await this.scheduleComposites();
      await this.schedule();
    } catch (error) {
      await this.store.addActivity({ type: "error", message: "Orchestrator cycle failed", detail: errorMessage(error) });
      this.events.emit("error", { message: errorMessage(error) });
    } finally {
      this.ticking = false;
      this.events.emit("state", this.store.get());
    }
  }

  private async schedule(): Promise<void> {
    const state = this.store.get();
    if (!state.orchestrator.enabled) return;
    const capacity = Math.max(0, state.settings.parallelism - this.activeAgents.size - this.activeComposites.size);
    if (!capacity) return;
    const queue = state.ideas
      .filter((idea) => idea.status === "queued")
      .sort((a, b) => b.predictedImpact - a.predictedImpact);
    let started = 0;
    for (const idea of queue) {
      if (started >= capacity) break;
      const resources = [...new Set([...state.settings.defaultResources, ...idea.resources])];
      const lease = await this.locks.tryAcquireAll(resources, idea.id);
      if (!lease) continue;
      started += 1;
      this.activeAgents.add(idea.id);
      void this.runIdea(idea, resources, lease.locks, lease.release);
    }
  }

  private async runIdea(
    idea: Idea,
    resources: string[],
    heldLocks: HeldLock[],
    releaseLocks: () => Promise<void>,
  ): Promise<void> {
    const runId = id("agent");
    const branch = `burner/${slugify(idea.title)}-${runId.slice(-6)}`;
    const initialRun: AgentRun = {
      id: runId,
      ideaId: idea.id,
      status: "starting",
      branch,
      worktree: "",
      startedAt: now(),
      deltas: [],
      resources,
      reviewRounds: [],
    };
    await this.store.update((state) => {
      state.agentRuns.push(initialRun);
      const current = state.ideas.find((item) => item.id === idea.id);
      if (current) Object.assign(current, { status: "running", agentRunId: runId, updatedAt: now() });
    });
    await this.store.addActivity({ type: "agent", message: `Agent started: ${idea.title}`, detail: resources.length ? `Locks: ${resources.join(", ")}` : branch });
    this.events.emit("agent", { runId, status: "starting" });
    let worktree = "";
    try {
      const settings = this.store.get().settings;
      const rootStatus = await this.git.status();
      if (!rootStatus.available) throw new Error("Implementation agents require a git repository with at least one commit.");
      if (rootStatus.dirty) throw new Error("The base checkout has uncommitted changes. Commit or stash them before dispatching an agent so evaluation deltas stay comparable.");
      const baseCommit = await this.git.resolveRef(settings.baseBranch);
      const baseline = this.store.latestRuns();
      const enabledEvaluations = this.store.get().evaluations.filter((evaluation) => evaluation.enabled);
      const missingBaseline = enabledEvaluations.find((evaluation) => baseline.get(evaluation.id)?.commit !== baseCommit);
      if (missingBaseline) throw new Error(`Run a clean baseline at ${settings.baseBranch} before dispatching; '${missingBaseline.name}' is missing a comparable score.`);
      const gitLock = await this.locks.tryAcquire("git-metadata", runId);
      if (!gitLock) throw new Error("Git metadata is busy; retry this idea in a moment.");
      try {
        worktree = await this.git.createWorktree(runId, branch, settings.baseBranch);
      } finally {
        await gitLock.release();
      }
      await this.updateAgent(runId, { worktree, status: "running" });
      const currentIdea = this.store.get().ideas.find((item) => item.id === idea.id) ?? idea;
      const authorStartCommit = await this.git.head(worktree);
      const author = await this.codex.implement(worktree, currentIdea, this.store.get().evaluations, settings);
      let lastMessage = author.message;
      await this.updateAgent(runId, { lastMessage, authorThreadId: author.threadId });
      const hasUncommittedChanges = await this.git.hasChanges(worktree);
      if (!hasUncommittedChanges && await this.git.head(worktree) === authorStartCommit) {
        await this.updateAgent(runId, { status: "no_changes", completedAt: now() });
        await this.finishIdea(idea.id, "completed");
        await this.store.addActivity({ type: "agent", message: `No changes produced: ${idea.title}`, detail: lastMessage.slice(0, 180) });
        return;
      }
      if (hasUncommittedChanges) await this.git.commit(worktree, `burner: ${idea.title}`);
      const reviewed = await this.reviewAgent(worktree, runId, idea.title, settings.baseBranch, author.threadId, settings);
      lastMessage = reviewed.message;
      await this.updateAgent(runId, { lastMessage, authorThreadId: reviewed.threadId, reviewApproved: true });
      if (await this.git.resolveRef(settings.baseBranch) !== baseCommit) throw new Error("The base branch moved during the review loop. Retry this idea so its author starts from the new main.");
      await this.updateAgent(runId, { status: "evaluating" });
      const afterRuns = await this.runEvaluations("agent", worktree, runId);
      const failedEvaluation = afterRuns.find((run) => run.status !== "completed" || run.score === undefined);
      if (failedEvaluation) throw new Error("Candidate evaluation failed; Burner will not deliver a PR without complete before/after scores.");
      const deltas = this.calculateDeltas(this.store.get(), baseline, afterRuns);
      const impact = this.calculateImpact(this.store.get(), deltas);
      await this.updateAgent(runId, { deltas, impact });
      let pr: { url: string; number?: number } | undefined;
      if (settings.autoCreatePrs) {
        if (await this.git.resolveRef(settings.baseBranch) !== baseCommit) throw new Error("The base branch moved during evaluation. Retry this idea to recalculate against the new main.");
        await this.updateAgent(runId, { status: "opening_pr" });
        if (!(await this.git.remoteExists(settings.remote))) throw new Error(`Git remote '${settings.remote}' does not exist.`);
        await this.git.push(worktree, settings.remote, branch);
        pr = await this.git.openPr({
          cwd: worktree,
          base: settings.baseBranch,
          branch,
          title: idea.title,
          body: buildPrBody(idea.description, lastMessage, deltas, impact, this.store.get().agentRuns.find((run) => run.id === runId)?.reviewRounds ?? []),
        });
      }
      await this.updateAgent(runId, {
        status: "completed",
        completedAt: now(),
        prUrl: pr?.url,
        prNumber: pr?.number,
        prState: pr ? "open" : undefined,
      });
      await this.finishIdea(idea.id, "completed");
      await this.store.addActivity({
        type: pr ? "pr" : "agent",
        message: pr ? `PR opened: ${idea.title}` : `Agent completed: ${idea.title}`,
        detail: pr?.url ?? `Measured impact: ${impact >= 0 ? "+" : ""}${impact.toFixed(1)}`,
      });
      if (pr) {
        const cleanupLock = await this.locks.tryAcquire("git-metadata", `${runId}-cleanup`);
        if (cleanupLock) {
          try { await this.git.removeWorktree(worktree); } finally { await cleanupLock.release(); }
        }
      }
      this.events.emit("agent", { runId, status: "completed", prUrl: pr?.url, impact });
    } catch (error) {
      const message = errorMessage(error);
      await this.updateAgent(runId, { status: "failed", error: message, completedAt: now() });
      await this.finishIdea(idea.id, "failed");
      await this.store.addActivity({ type: "error", message: `Agent failed: ${idea.title}`, detail: message });
      this.events.emit("agent", { runId, status: "failed", error: message });
    } finally {
      await releaseLocks();
      this.activeAgents.delete(idea.id);
      this.runtimeCache = undefined;
      this.events.emit("state", this.store.get());
      if (this.store.get().orchestrator.enabled) void this.schedule();
      void heldLocks;
    }
  }

  private async scheduleComposites(force = false): Promise<void> {
    if (this.activeComposites.size) return;
    const state = this.store.get();
    if (this.activeAgents.size + this.activeComposites.size >= state.settings.parallelism) return;
    const next = state.composites.find((composite) => composite.status === "rebuilding") ?? state.composites.find((composite) => composite.status === "queued");
    if (!next || (!force && !state.orchestrator.enabled)) return;
    this.activeComposites.add(next.id);
    void this.buildComposite(next.id, next.status === "rebuilding").finally(() => {
      this.activeComposites.delete(next.id);
      this.runtimeCache = undefined;
      this.events.emit("state", this.store.get());
      if (this.store.get().orchestrator.enabled) void this.scheduleComposites();
    });
  }

  private async buildComposite(compositeId: string, rebuild: boolean): Promise<void> {
    const lease = await this.locks.tryAcquireAll(["composite-build", ...this.store.get().settings.defaultResources], compositeId);
    if (!lease) return;
    let worktree = "";
    try {
      let state = this.store.get();
      let composite = state.composites.find((item) => item.id === compositeId);
      if (!composite) throw new Error("Composite not found.");
      if (composite.sources.length < 2) throw new Error("A composite requires at least two open source PRs.");
      const settings = state.settings;
      const rootStatus = await this.git.status();
      if (!rootStatus.available || rootStatus.dirty) throw new Error("Composite builds require a clean git base checkout.");
      const baseCommit = await this.git.resolveRef(settings.baseBranch);
      const baseline = this.store.latestRuns();
      const enabledEvaluations = state.evaluations.filter((evaluation) => evaluation.enabled);
      const missing = enabledEvaluations.find((evaluation) => baseline.get(evaluation.id)?.commit !== baseCommit);
      if (missing) throw new Error(`Run a clean baseline at ${settings.baseBranch} before building the composite; '${missing.name}' is stale.`);
      await this.updateComposite(compositeId, { status: rebuild ? "rebuilding" : "building", baseCommit, error: undefined, updatedAt: now() });

      const gitLock = await this.locks.tryAcquire("git-metadata", `${compositeId}-create`);
      if (!gitLock) throw new Error("Git metadata is busy; retry the composite shortly.");
      try {
        worktree = rebuild
          ? await this.git.createRebuildWorktree(compositeId, composite.branch, settings.baseBranch)
          : await this.git.createWorktree(compositeId, composite.branch, settings.baseBranch);
      } finally {
        await gitLock.release();
      }
      await this.updateComposite(compositeId, { worktree, updatedAt: now() });

      for (const source of composite.sources) {
        const sourceRef = await this.git.fetchBranch(settings.remote, source.branch);
        const merge = await this.git.mergeBranch(worktree, sourceRef);
        if (merge.conflict) {
          const resolver = await this.codex.integrateComposite(worktree, composite.title, [source.title], settings);
          if (await this.git.hasChanges(worktree)) await this.git.commit(worktree, `burner: resolve composite conflict for #${source.prNumber}`);
          await this.updateComposite(compositeId, { authorThreadId: resolver.threadId, updatedAt: now() });
        }
      }

      const author = await this.codex.integrateComposite(worktree, composite.title, composite.sources.map((source) => source.title), settings);
      if (await this.git.hasChanges(worktree)) await this.git.commit(worktree, `burner: integrate ${composite.title}`);
      await this.updateComposite(compositeId, { authorThreadId: author.threadId, updatedAt: now() });
      const reviewed = await this.reviewComposite(worktree, compositeId, composite.title, settings.baseBranch, author.threadId, settings);
      await this.updateComposite(compositeId, { authorThreadId: reviewed.threadId, reviewApproved: true, status: "evaluating", updatedAt: now() });

      if (await this.git.resolveRef(settings.baseBranch) !== baseCommit) {
        throw new Error("BASE_CHANGED: the base branch moved while this composite was cooking; it will be rebuilt and reevaluated.");
      }

      const afterRuns = await this.runEvaluations("composite", worktree, undefined, compositeId);
      if (afterRuns.some((run) => run.status !== "completed" || run.score === undefined)) throw new Error("Composite evaluation failed; the combined PR will not be delivered without complete recalculated scores.");
      state = this.store.get();
      const deltas = this.calculateDeltas(state, baseline, afterRuns);
      const impact = this.calculateImpact(state, deltas);
      const scoreMap = new Map(afterRuns.filter((run) => run.score !== undefined).map((run) => [run.evaluationId, run.score!]));
      const compositeScore = weightedScore(state.evaluations, scoreMap) ?? 0;
      composite = state.composites.find((item) => item.id === compositeId)!;
      const body = buildCompositePrBody({
        description: composite.description,
        sources: composite.sources,
        deltas,
        compositeScore,
        impact,
        reviewRounds: composite.reviewRounds,
      });
      if (await this.git.resolveRef(settings.baseBranch) !== baseCommit) {
        throw new Error("BASE_CHANGED: the base branch moved during composite evaluation; it will be rebuilt and reevaluated.");
      }
      if (rebuild && composite.prNumber) {
        await this.git.forcePush(worktree, settings.remote, composite.branch);
        await this.git.editPr(worktree, composite.prNumber, composite.title, body);
      } else {
        await this.git.push(worktree, settings.remote, composite.branch);
        const pr = await this.git.openPr({ cwd: worktree, base: settings.baseBranch, branch: composite.branch, title: composite.title, body });
        await this.updateComposite(compositeId, { prUrl: pr.url, prNumber: pr.number, updatedAt: now() });
      }
      await this.updateComposite(compositeId, { status: "open", deltas, impact, compositeScore, reviewApproved: true, error: undefined, updatedAt: now() });
      await this.store.addActivity({ type: "pr", message: rebuild ? `Composite rebuilt: ${composite.title}` : `Composite opened: ${composite.title}`, detail: `Recalculated score ${compositeScore.toFixed(1)} (${impact >= 0 ? "+" : ""}${impact.toFixed(1)} impact).` });
      const cleanupLock = await this.locks.tryAcquire("git-metadata", `${compositeId}-cleanup`);
      if (cleanupLock) {
        try { await this.git.removeWorktree(worktree); } finally { await cleanupLock.release(); }
      }
    } catch (error) {
      const message = errorMessage(error);
      if (worktree) {
        const cleanupLock = await this.locks.tryAcquire("git-metadata", `${compositeId}-failed-cleanup`);
        if (cleanupLock) {
          try { await this.git.removeWorktree(worktree); } finally { await cleanupLock.release(); }
        }
      }
      const baseMoved = message.startsWith("BASE_CHANGED:");
      await this.updateComposite(compositeId, { status: baseMoved ? "rebuilding" : "failed", error: message.replace("BASE_CHANGED: ", ""), updatedAt: now() });
      await this.store.addActivity({ type: baseMoved ? "system" : "error", message: baseMoved ? "Composite queued for a fresh base" : "Composite build failed", detail: message.replace("BASE_CHANGED: ", "") });
    } finally {
      await lease.release();
    }
  }

  private async reviewAgent(cwd: string, runId: string, title: string, baseBranch: string, threadId: string, settings: BurnerState["settings"]): Promise<SessionResult> {
    let currentThreadId = threadId;
    let message = this.store.get().agentRuns.find((run) => run.id === runId)?.lastMessage ?? "";
    for (let roundNumber = 1; roundNumber <= settings.maxReviewRounds; roundNumber += 1) {
      await this.updateAgent(runId, { status: "reviewing" });
      const review = await this.codex.review(cwd, baseBranch, title, settings);
      const round: ReviewRound = { id: id("review"), round: roundNumber, commit: await this.git.head(cwd), approved: review.approved, summary: review.summary, findings: review.findings, createdAt: now() };
      await this.store.update((state) => state.agentRuns.find((run) => run.id === runId)?.reviewRounds.push(round));
      this.events.emit("review", { runId, round: roundNumber, approved: review.approved, findings: review.findings.length });
      if (review.approved) {
        round.completedAt = now();
        await this.store.update((state) => {
          const stored = state.agentRuns.find((run) => run.id === runId)?.reviewRounds.find((item) => item.id === round.id);
          if (stored) Object.assign(stored, round);
        });
        return { message, threadId: currentThreadId };
      }
      if (roundNumber === settings.maxReviewRounds) break;
      await this.updateAgent(runId, { status: "revising" });
      const revision = await this.codex.revise(cwd, currentThreadId, this.normalizeReview(review), settings);
      currentThreadId = revision.threadId;
      message = revision.message;
      if (await this.git.hasChanges(cwd)) await this.git.commit(cwd, `burner: address review round ${roundNumber}`);
      round.authorResponse = revision.message;
      round.completedAt = now();
      await this.store.update((state) => {
        const stored = state.agentRuns.find((run) => run.id === runId)?.reviewRounds.find((item) => item.id === round.id);
        if (stored) Object.assign(stored, round);
      });
    }
    throw new Error(`Reviewer did not approve after ${settings.maxReviewRounds} rounds; no PR was opened.`);
  }

  private async reviewComposite(cwd: string, compositeId: string, title: string, baseBranch: string, threadId: string, settings: BurnerState["settings"]): Promise<SessionResult> {
    let currentThreadId = threadId;
    let message = "Composite integration complete.";
    for (let roundNumber = 1; roundNumber <= settings.maxReviewRounds; roundNumber += 1) {
      await this.updateComposite(compositeId, { status: "reviewing", updatedAt: now() });
      const review = await this.codex.review(cwd, baseBranch, title, settings);
      const round: ReviewRound = { id: id("review"), round: roundNumber, commit: await this.git.head(cwd), approved: review.approved, summary: review.summary, findings: review.findings, createdAt: now() };
      await this.store.update((state) => state.composites.find((item) => item.id === compositeId)?.reviewRounds.push(round));
      this.events.emit("review", { compositeId, round: roundNumber, approved: review.approved, findings: review.findings.length });
      if (review.approved) {
        round.completedAt = now();
        await this.store.update((state) => {
          const stored = state.composites.find((item) => item.id === compositeId)?.reviewRounds.find((item) => item.id === round.id);
          if (stored) Object.assign(stored, round);
        });
        return { message, threadId: currentThreadId };
      }
      if (roundNumber === settings.maxReviewRounds) break;
      await this.updateComposite(compositeId, { status: "revising", updatedAt: now() });
      const revision = await this.codex.revise(cwd, currentThreadId, this.normalizeReview(review), settings);
      currentThreadId = revision.threadId;
      message = revision.message;
      if (await this.git.hasChanges(cwd)) await this.git.commit(cwd, `burner: address composite review round ${roundNumber}`);
      round.authorResponse = revision.message;
      round.completedAt = now();
      await this.store.update((state) => {
        const stored = state.composites.find((item) => item.id === compositeId)?.reviewRounds.find((item) => item.id === round.id);
        if (stored) Object.assign(stored, round);
      });
    }
    throw new Error(`Composite reviewer did not approve after ${settings.maxReviewRounds} rounds.`);
  }

  private normalizeReview(review: ReviewResult): ReviewResult {
    if (review.findings.length || review.approved) return review;
    return { ...review, findings: [{ severity: "medium", title: "Reviewer requested another pass", detail: review.summary || "Inspect the complete diff and address remaining review concerns.", file: "" }] };
  }

  private calculateDeltas(state: BurnerState, before: Map<string, EvaluationRun>, afterRuns: EvaluationRun[]): ScoreDelta[] {
    return afterRuns.map((after) => {
      const evaluation = state.evaluations.find((item) => item.id === after.evaluationId);
      const beforeRun = before.get(after.evaluationId);
      const delta = beforeRun?.score !== undefined && after.score !== undefined ? Math.round((after.score - beforeRun.score) * 10) / 10 : undefined;
      return {
        evaluationId: after.evaluationId,
        name: evaluation?.name ?? after.evaluationId,
        before: beforeRun?.score,
        after: after.score,
        delta,
        summary: after.summary,
      };
    });
  }

  private calculateImpact(state: BurnerState, deltas: ScoreDelta[]): number {
    let total = 0;
    let weights = 0;
    for (const delta of deltas) {
      if (delta.delta === undefined) continue;
      const weight = state.evaluations.find((evaluation) => evaluation.id === delta.evaluationId)?.weight ?? 1;
      total += delta.delta * weight;
      weights += weight;
    }
    return weights ? Math.round((total / weights) * 10) / 10 : 0;
  }

  private async updateAgent(runId: string, patch: Partial<AgentRun>): Promise<void> {
    await this.store.update((state) => {
      const run = state.agentRuns.find((item) => item.id === runId);
      if (run) Object.assign(run, patch);
    });
    this.events.emit("agent", { runId, ...patch });
  }

  private async updateComposite(compositeId: string, patch: Partial<CompositePr>): Promise<void> {
    await this.store.update((state) => {
      const composite = state.composites.find((item) => item.id === compositeId);
      if (composite) Object.assign(composite, patch);
    });
    this.events.emit("composite", { compositeId, ...patch });
  }

  private async finishIdea(ideaId: string, status: Idea["status"]): Promise<void> {
    await this.store.update((state) => {
      const idea = state.ideas.find((item) => item.id === ideaId);
      if (idea) Object.assign(idea, { status, updatedAt: now() });
    });
  }
}
