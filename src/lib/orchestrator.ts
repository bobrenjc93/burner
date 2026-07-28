import { join } from "node:path";
import type { AgentRun, BurnerState, EvaluationRun, Idea, RuntimeStatus, ScoreDelta } from "../types.js";
import { CodexClient } from "./codex.js";
import { EventHub } from "./events.js";
import { buildPrBody, GitService } from "./git.js";
import type { HeldLock } from "./locks.js";
import { LockManager } from "./locks.js";
import { commandExists, runCommand } from "./process.js";
import { StateStore } from "./store.js";
import { errorMessage, id, mapLimit, now, slugify } from "./utils.js";

export class Orchestrator {
  private readonly git: GitService;
  private readonly locks: LockManager;
  private readonly codex: CodexClient;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private activeAgents = new Set<string>();
  private runningEvaluations = 0;
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

  async runEvaluations(context: EvaluationRun["context"] = "manual", cwd = this.root, agentRunId?: string): Promise<EvaluationRun[]> {
    const state = this.store.get();
    const evaluations = state.evaluations.filter((evaluation) => evaluation.enabled);
    if (!evaluations.length) throw new Error("Add at least one enabled evaluation first.");
    if (!(await commandExists("codex", this.root))) throw new Error("Codex CLI is not available. Install and authenticate Codex first.");
    const commit = await this.git.head(cwd);
    this.runningEvaluations += evaluations.length;
    await this.store.addActivity({
      type: "evaluation",
      message: `Running ${evaluations.length} evaluation${evaluations.length === 1 ? "" : "s"}`,
      detail: context === "agent" ? "Measuring the candidate branch." : `At commit ${commit.slice(0, 8)}.`,
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
        detail: context === "agent" ? "Candidate branch scoring finished." : "Baseline signals are up to date.",
      });
      if (context !== "agent") {
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
      heldLocks,
    };
    this.runtimeCache = { value, expires: Date.now() + 4_000 };
    return value;
  }

  private async tick(force = false): Promise<void> {
    if (this.ticking) return;
    const initial = this.store.get();
    if (!initial.orchestrator.enabled && !force) return;
    this.ticking = true;
    try {
      const settings = initial.settings;
      const evaluationDue =
        force ||
        !initial.orchestrator.lastEvaluationAt ||
        Date.now() - new Date(initial.orchestrator.lastEvaluationAt).getTime() >= settings.evaluationIntervalMinutes * 60_000;
      if (evaluationDue && this.runningEvaluations === 0 && this.activeAgents.size === 0) {
        await this.runEvaluations("baseline");
      }
      const refreshed = this.store.get();
      const planningDue =
        force ||
        !refreshed.orchestrator.lastPlanningAt ||
        Date.now() - new Date(refreshed.orchestrator.lastPlanningAt).getTime() >= settings.orchestratorIntervalMinutes * 60_000;
      const queued = refreshed.ideas.filter((idea) => idea.status === "queued").length;
      if (planningDue && queued < settings.parallelism * 2) await this.plan();
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
    const capacity = Math.max(0, state.settings.parallelism - this.activeAgents.size);
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
      const lastMessage = await this.codex.implement(worktree, currentIdea, this.store.get().evaluations, settings);
      await this.updateAgent(runId, { lastMessage });
      if (!(await this.git.hasChanges(worktree))) {
        await this.updateAgent(runId, { status: "no_changes", completedAt: now() });
        await this.finishIdea(idea.id, "completed");
        await this.store.addActivity({ type: "agent", message: `No changes produced: ${idea.title}`, detail: lastMessage.slice(0, 180) });
        return;
      }
      await this.git.commit(worktree, `burner: ${idea.title}`);
      await this.updateAgent(runId, { status: "evaluating" });
      const afterRuns = await this.runEvaluations("agent", worktree, runId);
      const failedEvaluation = afterRuns.find((run) => run.status !== "completed" || run.score === undefined);
      if (failedEvaluation) throw new Error("Candidate evaluation failed; Burner will not deliver a PR without complete before/after scores.");
      const deltas = this.calculateDeltas(this.store.get(), baseline, afterRuns);
      const impact = this.calculateImpact(this.store.get(), deltas);
      await this.updateAgent(runId, { deltas, impact });
      let pr: { url: string; number?: number } | undefined;
      if (settings.autoCreatePrs) {
        await this.updateAgent(runId, { status: "opening_pr" });
        if (!(await this.git.remoteExists(settings.remote))) throw new Error(`Git remote '${settings.remote}' does not exist.`);
        await this.git.push(worktree, settings.remote, branch);
        pr = await this.git.openPr({
          cwd: worktree,
          base: settings.baseBranch,
          branch,
          title: idea.title,
          body: buildPrBody(idea.description, lastMessage, deltas, impact),
        });
      }
      await this.updateAgent(runId, {
        status: "completed",
        completedAt: now(),
        prUrl: pr?.url,
        prNumber: pr?.number,
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

  private async finishIdea(ideaId: string, status: Idea["status"]): Promise<void> {
    await this.store.update((state) => {
      const idea = state.ideas.find((item) => item.id === ideaId);
      if (idea) Object.assign(idea, { status, updatedAt: now() });
    });
  }
}
