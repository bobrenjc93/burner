import { join } from "node:path";
import type { AgentRun, BurnerState, CompositePr, CompositeSource, Evaluation, EvaluationRun, Idea, ReviewRound, RuntimeStatus, ScoreDelta } from "../types.js";
import { CodexClient, type ReviewResult, type SessionResult } from "./codex.js";
import { EventHub } from "./events.js";
import { buildCompositeDraftPrBody, buildCompositePrBody, buildPrBody, GitService } from "./git.js";
import type { HeldLock } from "./locks.js";
import { LockManager } from "./locks.js";
import { commandExists, runCommand } from "./process.js";
import { updateProgressArtifacts, type ProgressPoint } from "./progress.js";
import { StateStore } from "./store.js";
import { errorMessage, id, mapLimit, now, slugify, weightedScore } from "./utils.js";

type AgentBase = {
  ref: string;
  commit: string;
  baseline: Map<string, EvaluationRun>;
  compositeId?: string;
};

export type YoloMergeCandidate = { kind: "agent" | "composite"; id: string; prNumber: number; impact: number };

class PortfolioReviewLimitError extends Error {
  constructor(readonly findings: ReviewResult["findings"], readonly target: "agent" | "composite") {
    super(`Portfolio ${target} exhausted its bounded review budget.`);
    this.name = "PortfolioReviewLimitError";
  }
}

const finalReviewApproved = (reviewApproved: boolean | undefined, rounds: ReviewRound[]) => reviewApproved === true && rounds.at(-1)?.approved === true;

function isYoloCandidate(
  deltas: ScoreDelta[],
  impact: number | undefined,
  enabledEvaluationIds: Set<string>,
  commandEvaluationIds: Set<string>,
  threshold: number,
): impact is number {
  if (!Number.isFinite(impact) || impact! <= threshold) return false;
  const byEvaluation = new Map(deltas.map((delta) => [delta.evaluationId, delta]));
  const complete = [...enabledEvaluationIds].every((evaluationId) => {
    const delta = byEvaluation.get(evaluationId)?.delta;
    return Number.isFinite(delta);
  });
  return complete && [...commandEvaluationIds].every((evaluationId) => byEvaluation.get(evaluationId)!.delta! >= 0);
}

function yoloEvaluationSets(state: BurnerState): { enabled: Set<string>; commands: Set<string> } {
  return {
    enabled: new Set(state.evaluations.filter((evaluation) => evaluation.enabled).map((evaluation) => evaluation.id)),
    commands: new Set(state.evaluations.filter((evaluation) => evaluation.enabled && evaluation.command).map((evaluation) => evaluation.id)),
  };
}

export function inferIdeaResources(idea: Pick<Idea, "title" | "description" | "rationale">): string[] {
  const text = `${idea.title} ${idea.description} ${idea.rationale}`;
  return /\b(?:benchmarks?|performance|profil(?:e|er|ing)|load[ -]?tests?|stress[ -]?tests?)\b/i.test(text)
    ? ["cpu-heavy"]
    : [];
}

function reservedCompositeSourceIds(state: BurnerState): Set<string> {
  return new Set(state.composites
    .filter((composite) => !["merged", "closed"].includes(composite.status))
    .flatMap((composite) => composite.sources.map((source) => source.agentRunId)));
}

function eligibleYoloLeaves(state: BurnerState, baseCommit: string): AgentRun[] {
  const { enabled, commands } = yoloEvaluationSets(state);
  if (!enabled.size) return [];
  const reserved = reservedCompositeSourceIds(state);
  return state.agentRuns
    .filter((run) =>
      run.status === "completed" &&
      run.prState === "open" &&
      run.prNumber !== undefined &&
      run.baseCommit === baseCommit &&
      !run.quarantinedAt &&
      !reserved.has(run.id) &&
      finalReviewApproved(run.reviewApproved, run.reviewRounds) &&
      isYoloCandidate(run.deltas, run.impact, enabled, commands, state.settings.compositeAbsorbThreshold))
    .sort((a, b) => (b.impact ?? -Infinity) - (a.impact ?? -Infinity));
}

export function selectYoloLeafBatch(state: BurnerState, baseCommit: string, batchSize: number, minimumSize = batchSize): string[] {
  if (batchSize < 2 || minimumSize < 2) return [];
  const eligible = eligibleYoloLeaves(state, baseCommit);
  return eligible.length >= minimumSize ? eligible.slice(0, batchSize).map((run) => run.id) : [];
}

export function selectYoloMergeCandidate(state: BurnerState, baseCommit: string, includeAgents = true): YoloMergeCandidate | undefined {
  const { enabled: enabledEvaluationIds, commands: commandEvaluationIds } = yoloEvaluationSets(state);
  if (!enabledEvaluationIds.size) return undefined;
  const threshold = state.settings.compositeAbsorbThreshold;
  const composites = state.composites
    .filter((composite) =>
      composite.status === "open" &&
      composite.prNumber !== undefined &&
      composite.baseCommit === baseCommit &&
      finalReviewApproved(composite.reviewApproved, composite.reviewRounds) &&
      isYoloCandidate(composite.deltas, composite.impact, enabledEvaluationIds, commandEvaluationIds, threshold))
    .map((composite) => ({ kind: "composite" as const, id: composite.id, prNumber: composite.prNumber!, impact: composite.impact! }))
    .sort((a, b) => b.impact - a.impact);
  if (composites[0]) return composites[0];
  if (!includeAgents) return undefined;

  const compositeSourceIds = reservedCompositeSourceIds(state);
  return state.agentRuns
    .filter((run) =>
      run.status === "completed" &&
      run.prState === "open" &&
      run.prNumber !== undefined &&
      run.baseCommit === baseCommit &&
      !run.quarantinedAt &&
      !compositeSourceIds.has(run.id) &&
      finalReviewApproved(run.reviewApproved, run.reviewRounds) &&
      isYoloCandidate(run.deltas, run.impact, enabledEvaluationIds, commandEvaluationIds, threshold))
    .map((run) => ({ kind: "agent" as const, id: run.id, prNumber: run.prNumber!, impact: run.impact! }))
    .sort((a, b) => b.impact - a.impact)[0];
}

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
  private readonly yolo: boolean;
  private readonly yoloBatchSize: number;
  private portfolioDraining = false;

  private portfolioMode(): boolean {
    return this.yolo && this.yoloBatchSize > 1;
  }

  private mergeCadenceDue(state = this.store.get()): boolean {
    if (!this.portfolioMode()) return false;
    const anchor = state.orchestrator.mergeWindowStartedAt;
    return Boolean(anchor && Date.now() - new Date(anchor).getTime() >= state.settings.mergeCadenceMinutes * 60_000);
  }

  private portfolioCookDue(state = this.store.get()): boolean {
    if (!this.portfolioMode()) return false;
    const anchor = state.orchestrator.mergeWindowStartedAt;
    if (!anchor) return false;
    const cadenceMs = state.settings.mergeCadenceMinutes * 60_000;
    const latest = this.store.latestRuns();
    let commandMs = 0;
    let promptMs = 0;
    for (const evaluation of state.evaluations.filter((item) => item.enabled)) {
      const duration = latest.get(evaluation.id)?.durationMs ?? 0;
      if (evaluation.command) commandMs += duration;
      else promptMs = Math.max(promptMs, duration);
    }
    const observedLeadMs = commandMs + promptMs + 5 * 60_000;
    const leadMs = Math.min(Math.max(5 * 60_000, observedLeadMs), Math.max(0, cadenceMs - 5 * 60_000));
    return Date.now() - new Date(anchor).getTime() >= cadenceMs - leadMs;
  }

  private portfolioReviewLimit(settings: BurnerState["settings"]): number {
    return this.portfolioMode() ? Math.min(settings.maxReviewRounds, settings.portfolioReviewRounds) : settings.maxReviewRounds;
  }

  private async recordCadenceBreach(): Promise<void> {
    const state = this.store.get();
    if (!this.mergeCadenceDue(state)) return;
    const lastAlert = state.orchestrator.lastMergeCadenceAlertAt;
    if (lastAlert && Date.now() - new Date(lastAlert).getTime() < state.settings.mergeCadenceMinutes * 60_000) return;
    await this.store.update((draft) => { draft.orchestrator.lastMergeCadenceAlertAt = now(); });
    await this.store.addActivity({
      type: "error",
      message: "Merge cadence missed",
      detail: `No qualifying merge completed within ${state.settings.mergeCadenceMinutes} minutes. Burner will shorten the next batch, permit a single reviewed leaf merge, and quarantine review-loop blockers.`,
    });
  }

  constructor(
    private readonly root: string,
    private readonly store: StateStore,
    private readonly events: EventHub,
    options: { yolo?: boolean; yoloBatchSize?: number } = {},
  ) {
    this.yolo = Boolean(options.yolo);
    this.yoloBatchSize = Math.max(1, Math.min(100, Math.floor(options.yoloBatchSize ?? 10)));
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
    if (this.yolo) await this.preflightYolo();
    this.timer = setInterval(() => void this.tick(), 5_000);
    this.timer.unref();
    if (this.store.get().settings.autoRun || this.yolo) await this.setEnabled(true);
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
      detail: enabled
        ? this.yolo
          ? this.yoloBatchSize > 1
            ? `YOLO portfolio is accumulating reviewed leaf PRs and master-cooking them in batches of ${this.yoloBatchSize}.`
            : "YOLO autopilot is evaluating, dispatching, opening, and autonomously merging monotonic leaf work."
          : "Burner is watching evaluations and dispatching queued work."
        : "Running agents will finish; new work will not start.",
    });
    this.events.emit("state", this.store.get());
    if (enabled) void this.tick(false);
  }

  private async preflightYolo(): Promise<void> {
    const settings = this.store.get().settings;
    const status = await this.git.status();
    if (!status.available || !status.commit) throw new Error("Burner --yolo requires a git repository with at least one commit.");
    if (status.branch !== settings.baseBranch) throw new Error(`Burner --yolo requires the root checkout on '${settings.baseBranch}' so merged work can be synchronized.`);
    if (status.dirty) throw new Error("Burner --yolo requires a clean root checkout.");
    if (!(await this.git.remoteExists(settings.remote))) throw new Error(`Burner --yolo requires git remote '${settings.remote}'.`);
    if (!(await commandExists("gh", this.root))) throw new Error("Burner --yolo requires the GitHub CLI.");
    const ghAuth = await runCommand("gh", ["auth", "status"], { cwd: this.root, timeoutMs: 8_000 });
    if (ghAuth.exitCode !== 0) throw new Error("Burner --yolo requires an authenticated GitHub CLI.");
    await this.codex.preflight(this.root);
    const baseCommit = await this.git.resolveRef(settings.baseBranch);
    const fullBaseline = this.store.latestRuns();
    const screeningBaseline = this.store.latestScreeningRuns();
    await this.store.update((draft) => {
      const enabled = draft.evaluations.filter((evaluation) => evaluation.enabled);
      const complete = enabled.every((evaluation) => fullBaseline.get(evaluation.id)?.commit === baseCommit) &&
        (!this.portfolioMode() || enabled.every((evaluation) => !evaluation.screeningCommand || screeningBaseline.get(evaluation.id)?.commit === baseCommit));
      if (complete) {
        draft.orchestrator.mergeWindowStartedAt ??= now();
      } else {
        draft.orchestrator.lastEvaluationAt = undefined;
        draft.orchestrator.mergeWindowStartedAt = undefined;
      }
    });
    await this.store.addActivity({
      type: "system",
      message: this.yoloBatchSize > 1 ? "YOLO portfolio enabled" : "YOLO autopilot enabled",
      detail: this.yoloBatchSize > 1
        ? `Burner will retain approved leaves, cook ${this.yoloBatchSize} current-base leaves into each composite, and merge only qualifying composites.`
        : "Burner will merge one current-base leaf PR at a time only after reviewer approval, complete evaluations, positive weighted impact, and no deterministic command-evaluation regression.",
    });
    if (this.yoloBatchSize > 1) await this.ensureLivingComposite();
  }

  private async autoMergeNext(): Promise<boolean> {
    const state = this.store.get();
    const baseCommit = await this.git.resolveRef(state.settings.baseBranch);
    const cadenceNeedsSingleLeaf = (this.mergeCadenceDue(state) || this.portfolioCookDue(state)) && selectYoloLeafBatch(state, baseCommit, this.yoloBatchSize, 2).length === 0;
    const candidate = selectYoloMergeCandidate(state, baseCommit, this.yoloBatchSize === 1 || cadenceNeedsSingleLeaf);
    if (!candidate) return false;
    await this.store.addActivity({
      type: "pr",
      message: `YOLO approved PR #${candidate.prNumber} for merge`,
      detail: `Reviewer approved; all enabled evaluations completed, deterministic checks did not regress, and weighted impact is +${candidate.impact.toFixed(1)}.`,
    });
    if (candidate.kind === "composite") await this.mergeComposite(candidate.id);
    else await this.mergeAgent(candidate.id);
    return true;
  }

  private async autoCookNext(): Promise<boolean> {
    if (this.yoloBatchSize < 2) return false;
    const state = this.store.get();
    const baseCommit = await this.git.resolveRef(state.settings.baseBranch);
    const cadenceDue = this.mergeCadenceDue(state);
    const cookDue = cadenceDue || this.portfolioCookDue(state);
    const leafIds = selectYoloLeafBatch(state, baseCommit, this.yoloBatchSize, cookDue ? 2 : this.yoloBatchSize);
    if (!leafIds.length) return false;
    const generation = state.composites.length + 1;
    await this.createComposite(
      leafIds,
      `YOLO generation ${generation}: ${leafIds.length} reviewed improvements`,
      `Automatically master-cooked from ${leafIds.length} independently authored, reviewed, and evaluated leaf pull requests on ${state.settings.baseBranch.slice(0, 80)}.${cookDue && leafIds.length < this.yoloBatchSize ? ` Burner shortened this batch early enough to honor the ${state.settings.mergeCadenceMinutes}-minute merge deadline.` : ""}`,
      { makeLiving: false },
    );
    this.portfolioDraining = false;
    return true;
  }

  private async shouldDrainForPortfolio(): Promise<boolean> {
    if (!this.yolo || this.yoloBatchSize < 2 || this.activeAgents.size === 0 || this.activeComposites.size > 0) return false;
    const state = this.store.get();
    const baseCommit = await this.git.resolveRef(state.settings.baseBranch);
    const cadenceDue = this.mergeCadenceDue(state);
    const cookDue = cadenceDue || this.portfolioCookDue(state);
    const eligible = eligibleYoloLeaves(state, baseCommit);
    const selected = cookDue
      ? eligible.slice(0, this.yoloBatchSize).map((run) => run.id)
      : selectYoloLeafBatch(state, baseCommit, this.yoloBatchSize);
    const ready = selected.length >= (cadenceDue ? 1 : cookDue ? 2 : this.yoloBatchSize);
    if (ready && !this.portfolioDraining) {
      this.portfolioDraining = true;
      await this.store.addActivity({
        type: "pr",
        message: "Portfolio batch ready; draining active agents",
        detail: `${selected.length} eligible leaves are reserved for the next composite${cookDue ? " under deadline-aware cadence scheduling" : ""}. No replacement agents will start until the current ${this.activeAgents.size} finish.`,
      });
    } else if (!ready) {
      this.portfolioDraining = false;
    }
    return ready;
  }

  async runCycle(): Promise<void> {
    await this.tick(true);
  }

  async runNextIdea(): Promise<AgentRun> {
    const state = this.store.get();
    const idea = state.ideas.filter((item) => item.status === "queued").sort((a, b) => b.predictedImpact - a.predictedImpact)[0];
    if (!idea) throw new Error("No queued ideas are available.");
    const base = await this.resolveAgentBase(idea, state);
    const resources = [...new Set([...state.settings.defaultResources, ...idea.resources, ...inferIdeaResources(idea), ...(base.compositeId ? [`living-${base.compositeId}`] : [])])];
    const lease = await this.locks.tryAcquireAll(resources, idea.id);
    if (!lease) throw new Error("A required resource is currently locked.");
    this.activeAgents.add(idea.id);
    await this.runIdea(idea, base, resources, lease.locks, lease.release);
    const after = this.store.get();
    const runId = after.ideas.find((item) => item.id === idea.id)?.agentRunId;
    const completed = after.agentRuns.find((run) => run.id === runId);
    if (!completed) throw new Error("The agent run did not produce a result.");
    return completed;
  }

  async retryAgent(runId: string): Promise<AgentRun> {
    const state = this.store.get();
    if (this.activeAgents.size + this.activeComposites.size >= state.settings.parallelism) throw new Error("All configured agent slots are currently in use.");
    const run = state.agentRuns.find((item) => item.id === runId);
    const idea = run ? state.ideas.find((item) => item.id === run.ideaId) : undefined;
    if (!run || run.status !== "failed" || !idea) throw new Error("Only a failed agent run can be retried.");
    if (!run.worktree || !run.authorThreadId || !run.baseRef || !run.baseCommit) throw new Error("This run failed before it produced a resumable candidate.");
    if (await this.git.resolveRef(run.baseRef) !== run.baseCommit) throw new Error("The candidate base has moved; queue a fresh idea against the latest base instead.");
    await this.git.head(run.worktree);
    if (await this.git.hasChanges(run.worktree)) await this.git.commit(run.worktree, "burner: preserve interrupted revision");
    const baseline = run.parentCompositeId
      ? this.store.latestCompositeRuns(run.parentCompositeId)
      : this.portfolioMode() ? this.store.latestAgentBaselines() : this.store.latestRuns();
    const enabledEvaluations = state.evaluations.filter((evaluation) => evaluation.enabled);
    const missingBaseline = enabledEvaluations.find((evaluation) => baseline.get(evaluation.id)?.commit !== run.baseCommit);
    if (missingBaseline) throw new Error(`Refresh '${missingBaseline.name}' at the candidate base before retrying.`);
    const lease = await this.locks.tryAcquireAll(run.resources, `${run.id}-retry`);
    if (!lease) throw new Error("A required resource is currently locked.");
    const base: AgentBase = { ref: run.baseRef, commit: run.baseCommit, baseline, compositeId: run.parentCompositeId };
    this.activeAgents.add(idea.id);
    await this.store.update((draft) => {
      const currentRun = draft.agentRuns.find((item) => item.id === run.id);
      const currentIdea = draft.ideas.find((item) => item.id === idea.id);
      if (currentRun) Object.assign(currentRun, { status: "reviewing", error: undefined, completedAt: undefined, reviewApproved: false, reviewRounds: [], deltas: [], impact: undefined });
      if (currentIdea) Object.assign(currentIdea, { status: "running", updatedAt: now() });
    });
    await this.store.addActivity({ type: "agent", message: `Agent retry resumed: ${idea.title}`, detail: "Reusing the existing candidate and author session." });
    try {
      await this.reviewAndDeliverAgent(idea, base, run.id, run.worktree, run.branch, state.settings, run.authorThreadId, run.lastMessage ?? "");
    } catch (error) {
      const message = errorMessage(error);
      const quarantined = error instanceof PortfolioReviewLimitError;
      const completedAt = now();
      await this.updateAgent(run.id, {
        status: "failed",
        error: message,
        completedAt,
        ...(quarantined ? { quarantinedAt: completedAt, quarantineReason: `No approval within ${this.portfolioReviewLimit(this.store.get().settings)} portfolio review rounds.` } : {}),
      });
      await this.finishIdea(idea.id, "failed");
      await this.store.addActivity({
        type: "error",
        message: quarantined ? `Agent quarantined: ${idea.title}` : `Agent retry failed: ${idea.title}`,
        detail: quarantined ? "The review budget was exhausted. Burner released the portfolio slot so healthier work can advance." : message,
      });
    } finally {
      await lease.release();
      this.activeAgents.delete(idea.id);
      this.runtimeCache = undefined;
      this.events.emit("state", this.store.get());
      if (this.yolo && this.store.get().orchestrator.enabled) void this.tick(false);
      else void this.scheduleComposites(true);
    }
    return this.store.get().agentRuns.find((item) => item.id === run.id)!;
  }

  async runEvaluations(context: EvaluationRun["context"] = "manual", cwd = this.root, agentRunId?: string, compositeId?: string): Promise<EvaluationRun[]> {
    const owner = id("evalsuite");
    const callerOwnsCpuLock = Boolean(
      agentRunId && this.store.get().agentRuns.find((run) => run.id === agentRunId)?.resources.includes("cpu-heavy"),
    );
    // Acquire the scarce CPU resource before the suite lock. Otherwise a normal
    // candidate could hold evaluation-suite while waiting for a cpu-heavy agent,
    // and that agent could deadlock waiting to evaluate before releasing its lease.
    const cpuLock = callerOwnsCpuLock
      ? undefined
      : await this.locks.acquire("cpu-heavy", owner, { timeoutMs: 6 * 60 * 60 * 1000, pollMs: 250 });
    let suiteLock: HeldLock | undefined;
    try {
      suiteLock = await this.locks.acquire("evaluation-suite", owner, { timeoutMs: 6 * 60 * 60 * 1000, pollMs: 250 });
      return await this.runEvaluationSuite(context, cwd, agentRunId, compositeId);
    } finally {
      await suiteLock?.release();
      await cpuLock?.release();
    }
  }

  async runBaselineEvaluations(context: "baseline" | "manual" = "manual"): Promise<EvaluationRun[]> {
    const commit = await this.git.resolveRef(this.store.get().settings.baseBranch);
    const enabled = this.store.get().evaluations.filter((evaluation) => evaluation.enabled);
    const fullBaseline = this.store.latestRuns();
    const fullRuns = enabled.every((evaluation) => fullBaseline.get(evaluation.id)?.commit === commit)
      ? []
      : await this.runEvaluations(context);
    const screeningBaseline = this.store.latestScreeningRuns();
    const screeningRuns = enabled.some((evaluation) => evaluation.screeningCommand && screeningBaseline.get(evaluation.id)?.commit !== commit)
      ? await this.runEvaluations("screening_baseline")
      : [];
    const runs = [...fullRuns, ...screeningRuns];
    const refreshedFull = this.store.latestRuns();
    const refreshedScreening = this.store.latestScreeningRuns();
    const complete = enabled.every((evaluation) => refreshedFull.get(evaluation.id)?.commit === commit) &&
      enabled.every((evaluation) => !evaluation.screeningCommand || refreshedScreening.get(evaluation.id)?.commit === commit);
    if (runs.every((run) => run.status === "completed" && run.score !== undefined) && complete) {
      await this.store.update((draft) => {
        draft.orchestrator.lastEvaluationAt = now();
        if (this.portfolioMode()) draft.orchestrator.mergeWindowStartedAt ??= now();
      });
    }
    return runs;
  }

  private async promoteMergedCompositeBaseline(compositeId: string, baseCommit: string): Promise<boolean> {
    const state = this.store.get();
    const composite = state.composites.find((item) => item.id === compositeId);
    if (!composite) return false;
    const runs = this.store.latestCompositeRuns(compositeId);
    const enabled = state.evaluations.filter((evaluation) => evaluation.enabled);
    if (!enabled.length || enabled.some((evaluation) => runs.get(evaluation.id)?.score === undefined)) return false;
    if (await this.git.tree(baseCommit) !== await this.git.tree(composite.branch)) return false;
    const createdAt = now();
    await this.store.update((draft) => {
      for (const evaluation of enabled) {
        const source = runs.get(evaluation.id)!;
        draft.evaluationRuns.push({
          ...source,
          id: id("evalrun"),
          commit: baseCommit,
          createdAt,
          context: "baseline",
          agentRunId: undefined,
          compositeId: undefined,
        });
      }
    });
    await this.store.addActivity({ type: "evaluation", message: "Merged composite promoted to baseline", detail: `The tested composite tree exactly matches ${baseCommit.slice(0, 8)}; only leaf screens need refreshing.` });
    return true;
  }

  private async runEvaluationSuite(context: EvaluationRun["context"], cwd: string, agentRunId?: string, compositeId?: string): Promise<EvaluationRun[]> {
    const state = this.store.get();
    const evaluations = state.evaluations.filter((evaluation) => evaluation.enabled && (context !== "screening_baseline" || evaluation.screeningCommand));
    if (!evaluations.length) throw new Error("Add at least one enabled evaluation first.");
    if (evaluations.some((evaluation) => !evaluation.command)) await this.codex.preflight(cwd);
    const commit = await this.git.head(cwd);
    this.runningEvaluations += evaluations.length;
    await this.store.addActivity({
      type: "evaluation",
      message: `Running ${evaluations.length} evaluation${evaluations.length === 1 ? "" : "s"}`,
      detail: context === "agent" || context === "composite" ? "Measuring the candidate branch." : `At commit ${commit.slice(0, 8)}.`,
    });
    try {
      const evaluateOne = async (evaluation: Evaluation): Promise<EvaluationRun> => {
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
        let commandLock: HeldLock | undefined;
        try {
          if (evaluation.command || evaluation.screeningCommand) {
            commandLock = await this.locks.acquire(`command-evaluation-${evaluation.id}`, run.id, { timeoutMs: 6 * 60 * 60 * 1000, pollMs: 250 });
          }
          const evaluated = context === "agent" && !this.portfolioMode()
            ? { ...evaluation, screeningCommand: undefined }
            : evaluation;
          const output = await this.codex.evaluate(cwd, evaluated, state.settings, context);
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
        } finally {
          await commandLock?.release();
        }
        return run;
      };
      const commandRuns = await mapLimit(evaluations.filter((evaluation) => evaluation.command || evaluation.screeningCommand), 1, evaluateOne);
      const promptRuns = await mapLimit(evaluations.filter((evaluation) => !evaluation.command && !evaluation.screeningCommand), Math.min(state.settings.parallelism, 3), evaluateOne);
      const runs = [...commandRuns, ...promptRuns];
      const succeeded = runs.filter((run) => run.status === "completed").length;
      await this.store.addActivity({
        type: succeeded === runs.length ? "evaluation" : "error",
        message: `${succeeded}/${runs.length} evaluations completed`,
        detail: context === "agent" || context === "composite" ? "Candidate branch scoring finished." : "Baseline signals are up to date.",
      });
      return runs;
    } finally {
      this.runningEvaluations -= evaluations.length;
      this.events.emit("state", this.store.get());
    }
  }

  async plan(): Promise<Idea[]> {
    const state = this.store.get();
    const evaluations = state.evaluations.filter((evaluation) => evaluation.enabled);
    const living = this.findLivingComposite(state);
    const latest = living ? this.store.latestCompositeRuns(living.id) : this.store.latestRuns();
    if (!evaluations.some((evaluation) => latest.has(evaluation.id))) {
      throw new Error(living ? "The living composite needs a completed evaluation before planning experiments." : "Run a baseline evaluation before generating ideas.");
    }
    await this.store.addActivity({ type: "idea", message: "Planning the next improvements", detail: living ? `Exploring from living line: ${living.title}` : "Codex is inspecting weak signals and open work." });
    let planningCwd = this.root;
    let planningWorktree = "";
    if (living) {
      const planningRef = await this.git.fetchBranch(state.settings.remote, living.branch);
      const gitLock = await this.locks.acquire("git-metadata", `plan-${living.id}`);
      try {
        planningWorktree = await this.git.createDetachedWorktree(id("planning"), planningRef);
        planningCwd = planningWorktree;
      } finally {
        await gitLock.release();
      }
    }
    let planned;
    try {
      planned = await this.codex.planIdeas(planningCwd, evaluations, latest, state.ideas, state.settings);
    } finally {
      if (planningWorktree) {
        const cleanupLock = await this.locks.acquire("git-metadata", `plan-cleanup-${living?.id}`);
        try { await this.git.removeWorktree(planningWorktree); } finally { await cleanupLock.release(); }
      }
    }
    const created: Idea[] = planned
      .filter((idea) => idea.title && idea.description)
      .map((idea) => ({ ...idea, id: id("idea"), status: "queued", createdAt: now(), updatedAt: now(), source: "codex", baseCompositeId: living?.id }));
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
      this.codex.available(this.root),
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
      yolo: this.yolo,
      yoloBatchSize: this.yolo ? this.yoloBatchSize : undefined,
      runningEvaluations: this.runningEvaluations,
      runningAgents: this.activeAgents.size,
      runningComposites: this.activeComposites.size,
      heldLocks,
    };
    this.runtimeCache = { value, expires: Date.now() + 4_000 };
    return value;
  }

  async createComposite(agentRunIds: string[], title?: string, description?: string, options: { makeLiving?: boolean } = {}): Promise<CompositePr> {
    const uniqueIds = [...new Set(agentRunIds)];
    const state = this.store.get();
    const sources: CompositeSource[] = uniqueIds.map((runId) => {
      const run = state.agentRuns.find((item) => item.id === runId);
      const idea = run ? state.ideas.find((item) => item.id === run.ideaId) : undefined;
      if (!run?.prNumber || !run.prUrl || (run.prState && run.prState !== "open")) throw new Error("Every composite source must be an open Burner pull request.");
      return { agentRunId: run.id, prNumber: run.prNumber, title: idea?.title ?? run.branch, branch: run.branch, kind: "pull_request" as const, impact: run.impact };
    });
    if (sources.length < 2) throw new Error("Choose at least two open pull requests to master cook.");
    const compositeId = id("composite");
    const timestamp = now();
    const currentLiving = state.orchestrator.livingCompositeId ? state.composites.find((item) => item.id === state.orchestrator.livingCompositeId) : undefined;
    const makeLiving = options.makeLiving ?? (!currentLiving || ["merged", "closed"].includes(currentLiving.status));
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
      isLiving: makeLiving,
      pendingExperimentRunIds: [],
    };
    await this.store.update((draft) => {
      draft.composites.push(composite);
      if (makeLiving) draft.orchestrator.livingCompositeId = composite.id;
    });
    await this.store.addActivity({
      type: "pr",
      message: `Composite queued: ${composite.title}`,
      detail: makeLiving
        ? `${sources.length} source PRs will seed a continuously evaluated living line.`
        : `${sources.length} reviewed leaf PRs are reserved for this independently rebuilt and recalculated portfolio generation.`,
    });
    this.events.emit("state", this.store.get());
    void this.scheduleComposites(true);
    return composite;
  }

  async setLivingComposite(compositeId: string): Promise<void> {
    let title = "";
    await this.store.update((state) => {
      const composite = state.composites.find((item) => item.id === compositeId);
      if (!composite || composite.status !== "open" || !composite.reviewApproved) throw new Error("Only an open, approved composite can become the living line.");
      state.orchestrator.livingCompositeId = compositeId;
      for (const item of state.composites) item.isLiving = item.id === compositeId;
      title = composite.title;
    });
    await this.store.addActivity({ type: "system", message: `Living line selected: ${title}`, detail: "New planning and experiments will build from this composite." });
    this.events.emit("state", this.store.get());
  }

  async refreshEvaluationWeights(): Promise<void> {
    const changedAgentIds = new Set<string>();
    const changedCompositeIds = new Set<string>();
    await this.store.update((state) => {
      for (const run of state.agentRuns) {
        if (!run.deltas.length) continue;
        const impact = this.calculateImpact(state, run.deltas);
        if (run.impact !== impact) { run.impact = impact; changedAgentIds.add(run.id); }
      }
      for (const composite of state.composites) {
        if (!composite.deltas.length) continue;
        const impact = this.calculateImpact(state, composite.deltas);
        const scores = new Map(composite.deltas.flatMap((delta) => delta.after === undefined ? [] : [[delta.evaluationId, delta.after] as const]));
        const compositeScore = weightedScore(state.evaluations, scores);
        if (composite.impact !== impact || (compositeScore !== undefined && composite.compositeScore !== compositeScore)) {
          composite.impact = impact;
          if (compositeScore !== undefined) composite.compositeScore = compositeScore;
          changedCompositeIds.add(composite.id);
        }
      }
    });
    const state = this.store.get();
    for (const run of state.agentRuns.filter((item) => changedAgentIds.has(item.id) && item.prNumber && item.prState === "open")) {
      const idea = state.ideas.find((item) => item.id === run.ideaId);
      await this.git.editPr(this.root, run.prNumber!, idea?.title ?? run.branch, buildPrBody(idea?.description ?? "", run.lastMessage ?? "", run.deltas, run.impact ?? 0, run.reviewRounds));
    }
    for (const composite of state.composites.filter((item) => changedCompositeIds.has(item.id) && item.prNumber && item.status === "open")) {
      await this.git.editPr(this.root, composite.prNumber!, composite.title, buildCompositePrBody({
        description: composite.description,
        sources: composite.sources,
        deltas: composite.deltas,
        compositeScore: composite.compositeScore ?? 0,
        impact: composite.impact ?? 0,
        reviewRounds: composite.reviewRounds,
      }));
    }
    if (changedAgentIds.size || changedCompositeIds.size) {
      await this.store.addActivity({ type: "evaluation", message: "Evaluation weights reapplied", detail: `${changedAgentIds.size} leaf and ${changedCompositeIds.size} composite impact stamp${changedAgentIds.size + changedCompositeIds.size === 1 ? "" : "s"} refreshed.` });
      this.events.emit("state", this.store.get());
    }
  }

  async mergeComposite(compositeId: string): Promise<void> {
    const composite = this.store.get().composites.find((item) => item.id === compositeId);
    if (!composite?.prNumber || composite.status !== "open") throw new Error("Only an open composite pull request can be merged.");
    await this.stampProgressBeforeMerge("composite", composite.id);
    await this.git.mergePr(this.root, composite.prNumber);
    await this.store.addActivity({ type: "pr", message: `Merge requested: ${composite.title}`, detail: `Waiting for GitHub to merge PR #${composite.prNumber}.` });
    await this.syncPullRequests(true);
  }

  async mergeAgent(runId: string): Promise<AgentRun> {
    const run = this.store.get().agentRuns.find((item) => item.id === runId);
    if (!run?.prNumber || run.status !== "completed" || run.prState !== "open") throw new Error("Only an open, completed agent pull request can be merged.");
    await this.stampProgressBeforeMerge("agent", run.id);
    await this.git.mergePr(this.root, run.prNumber);
    await this.store.addActivity({ type: "pr", message: `Merge requested for PR #${run.prNumber}`, detail: "Synchronizing the base branch before any new agents start." });
    await this.syncPullRequests(true);
    return this.store.get().agentRuns.find((item) => item.id === runId)!;
  }

  private async stampProgressBeforeMerge(kind: "agent" | "composite", candidateId: string): Promise<void> {
    const state = this.store.get();
    const candidate = kind === "agent"
      ? state.agentRuns.find((item) => item.id === candidateId)
      : state.composites.find((item) => item.id === candidateId);
    if (!candidate) throw new Error("Merge candidate not found while recording evaluation progress.");
    const deltas = candidate.deltas;
    const enabled = state.evaluations.filter((evaluation) => evaluation.enabled);
    const scores = Object.fromEntries(enabled.map((evaluation) => {
      const score = deltas.find((delta) => delta.evaluationId === evaluation.id)?.after;
      if (score === undefined) throw new Error(`Cannot record progress: '${evaluation.name}' has no candidate score.`);
      return [evaluation.id, score];
    }));
    const prNumber = candidate.prNumber;
    if (!prNumber) throw new Error("Merge candidate has no pull request number while recording progress.");
    const title = kind === "agent"
      ? state.ideas.find((idea) => idea.id === (candidate as AgentRun).ideaId)?.title ?? candidate.branch
      : (candidate as CompositePr).title;
    const baselineRuns = this.store.latestRuns();
    const baselineScores = Object.fromEntries(enabled.flatMap((evaluation) => {
      const score = baselineRuns.get(evaluation.id)?.score;
      return score === undefined ? [] : [[evaluation.id, score] as const];
    }));
    const baseCommit = await this.git.resolveRef(state.settings.baseBranch);
    const recordedAt = now();
    const points: ProgressPoint[] = [];
    if (Object.keys(baselineScores).length === enabled.length) {
      points.push({ key: `base:${baseCommit}`, recordedAt, label: `base ${baseCommit.slice(0, 7)}`, kind: "baseline", title: state.settings.baseBranch, scores: baselineScores });
    }
    points.push({ key: `pr:${prNumber}`, recordedAt, label: `PR #${prNumber}`, kind: kind === "agent" ? "leaf" : "composite", prNumber, title, scores });
    const owner = `progress-${candidateId}`;
    let worktree = "";
    const createLock = await this.locks.acquire("git-metadata", `${owner}-create`);
    try { worktree = await this.git.createExistingWorktree(owner, candidate.branch); }
    finally { await createLock.release(); }
    try {
      await updateProgressArtifacts(worktree, state.evaluations, points);
      if (await this.git.hasChanges(worktree)) {
        await this.git.commit(worktree, `burner: record evaluation progress for PR #${prNumber}`);
        await this.git.push(worktree, state.settings.remote, candidate.branch);
      }
    } finally {
      const cleanupLock = await this.locks.acquire("git-metadata", `${owner}-cleanup`);
      try { if (worktree) await this.git.removeWorktree(worktree); }
      finally { await cleanupLock.release(); }
    }
    await this.store.addActivity({ type: "evaluation", message: `Progress graph updated for PR #${prNumber}`, detail: "README.md, SVG, and raw evaluation history were committed to the merge candidate." });
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
    const dispositionUpdates: Array<{ number: number; disposition: "merged" | "unmerged" }> = [];
    let baseChanged = Boolean(state.orchestrator.baseSyncPending);
    let syncedBaseCommit: string | undefined;
    await this.store.update((draft) => {
      for (const run of draft.agentRuns) {
        if (!run.prNumber) continue;
        const remote = byNumber.get(run.prNumber);
        if (!remote) continue;
        const next = remote.state === "OPEN" ? "open" : remote.state === "MERGED" ? "merged" : run.prState === "superseded" ? "superseded" : "closed";
        if (run.prState !== next) {
          if (next === "merged") {
            const mergedAt = now();
            baseChanged = true;
            draft.orchestrator.baseSyncPending = true;
            draft.orchestrator.lastMergeAt = mergedAt;
            draft.orchestrator.mergeWindowStartedAt = mergedAt;
            draft.orchestrator.lastMergeCadenceAlertAt = undefined;
          }
          run.prState = next;
          changedRunIds.add(run.id);
          dispositionUpdates.push({ number: run.prNumber, disposition: next === "merged" ? "merged" : "unmerged" });
        }
      }
      for (const composite of draft.composites) {
        if (!composite.prNumber) continue;
        const remote = byNumber.get(composite.prNumber);
        if (!remote) continue;
        if (remote.state === "MERGED" && composite.status !== "merged") {
          const mergedAt = now();
          composite.status = "merged";
          composite.mergedAt = mergedAt;
          composite.updatedAt = mergedAt;
          draft.orchestrator.lastMergeAt = mergedAt;
          draft.orchestrator.mergeWindowStartedAt = mergedAt;
          draft.orchestrator.lastMergeCadenceAlertAt = undefined;
          newlyMergedCompositeIds.push(composite.id);
          baseChanged = true;
          draft.orchestrator.baseSyncPending = true;
          composite.isLiving = false;
          if (draft.orchestrator.livingCompositeId === composite.id) draft.orchestrator.livingCompositeId = undefined;
          dispositionUpdates.push({ number: composite.prNumber, disposition: "merged" });
        } else if (remote.state === "CLOSED" && composite.status !== "merged" && composite.status !== "closed") {
          composite.status = "closed";
          composite.updatedAt = now();
          composite.isLiving = false;
          if (draft.orchestrator.livingCompositeId === composite.id) draft.orchestrator.livingCompositeId = undefined;
          dispositionUpdates.push({ number: composite.prNumber, disposition: "unmerged" });
        } else if (remote.state === "OPEN" && composite.status === "closed") {
          composite.status = "open";
          composite.updatedAt = now();
          dispositionUpdates.push({ number: composite.prNumber, disposition: "unmerged" });
        }
      }
    });

    for (const update of new Map(dispositionUpdates.map((item) => [item.number, item])).values()) {
      await this.git.markPrDisposition(this.root, update.number, update.disposition).catch(() => undefined);
    }

    for (const compositeId of newlyMergedCompositeIds) {
      const composite = this.store.get().composites.find((item) => item.id === compositeId);
      if (!composite) continue;
      for (const source of composite.sources) {
        const run = this.store.get().agentRuns.find((item) => item.id === source.agentRunId);
        if (source.prNumber && run?.prState === "open") {
          await this.git.closePr(this.root, source.prNumber, `Superseded by merged composite PR #${composite.prNumber}.`, "merged");
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
      syncedBaseCommit = commit;
      await this.store.update((draft) => {
        draft.orchestrator.lastEvaluationAt = undefined;
        draft.orchestrator.lastPlanningAt = undefined;
        draft.orchestrator.baseSyncPending = false;
      });
      await this.store.addActivity({ type: "system", message: `Base updated to ${commit.slice(0, 8)}`, detail: "New agents will branch from the merged main; baseline and composites are being recalculated." });
      let promoted = false;
      for (const compositeId of newlyMergedCompositeIds) {
        if (await this.promoteMergedCompositeBaseline(compositeId, commit)) { promoted = true; break; }
      }
      if (!promoted) {
        await this.store.update((draft) => { draft.orchestrator.mergeWindowStartedAt = undefined; });
        await this.store.addActivity({ type: "evaluation", message: "Cold baseline required after merge", detail: "The next merge-cadence window will start after full and screening baselines finish." });
      }
    }

    if (syncedBaseCommit && this.yolo && this.yoloBatchSize > 1) {
      const beforeCleanup = this.store.get();
      const staleFailedComposites = beforeCleanup.composites.filter((composite) =>
        composite.status === "failed" && composite.baseCommit !== syncedBaseCommit);
      for (const composite of staleFailedComposites) {
        if (composite.prNumber) {
          await this.git.closePr(this.root, composite.prNumber, `Burner retired this failed portfolio generation because ${state.settings.baseBranch} advanced to ${syncedBaseCommit.slice(0, 8)}.`);
        }
      }
      if (staleFailedComposites.length) {
        const staleCompositeIds = new Set(staleFailedComposites.map((composite) => composite.id));
        await this.store.update((draft) => {
          for (const composite of draft.composites) {
            if (!staleCompositeIds.has(composite.id)) continue;
            composite.status = "closed";
            composite.isLiving = false;
            composite.updatedAt = now();
          }
        });
      }
      const current = this.store.get();
      const reserved = reservedCompositeSourceIds(current);
      const staleLeaves = current.agentRuns.filter((run) =>
        run.prState === "open" &&
        run.prNumber !== undefined &&
        run.baseCommit !== syncedBaseCommit &&
        !reserved.has(run.id));
      for (const run of staleLeaves) {
        await this.git.closePr(this.root, run.prNumber!, `Burner closed this unbatched leaf because the YOLO portfolio advanced ${state.settings.baseBranch}; a fresh experiment will be planned from ${syncedBaseCommit.slice(0, 8)}.`);
      }
      if (staleLeaves.length) {
        const staleIds = new Set(staleLeaves.map((run) => run.id));
        await this.store.update((draft) => {
          for (const run of draft.agentRuns) if (staleIds.has(run.id)) run.prState = "closed";
        });
        await this.store.addActivity({ type: "pr", message: `${staleLeaves.length} stale leaf PR${staleLeaves.length === 1 ? "" : "s"} closed`, detail: "The next portfolio generation will branch from the newly merged base." });
      }
      if (staleFailedComposites.length) {
        await this.store.addActivity({ type: "pr", message: `${staleFailedComposites.length} failed portfolio generation${staleFailedComposites.length === 1 ? "" : "s"} retired`, detail: "Their obsolete leaf PRs were released for stale-branch cleanup." });
      }
    }

    const after = this.store.get();
    for (const composite of after.composites.filter((item) => item.status === "open")) {
      const filtered = composite.sources.filter((source) => {
        const run = after.agentRuns.find((item) => item.id === source.agentRunId);
        return source.kind === "experiment" ? run?.status === "absorbed" : run?.prState === "open";
      });
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
          if (current) { current.sources = filtered; current.status = "rebuilding"; current.rebuildMode = "from_base"; current.reviewApproved = false; current.reviewRounds = []; current.updatedAt = now(); }
        });
      }
    }
    await this.ensureLivingComposite();
    this.events.emit("state", this.store.get());
  }

  private async tick(force = false): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.syncPullRequests();
      const initial = this.store.get();
      if (!initial.orchestrator.enabled && !force) return;
      if (this.portfolioMode()) await this.recordCadenceBreach();
      if (this.yolo && this.runningEvaluations === 0 && this.activeAgents.size === 0 && this.activeComposites.size === 0) {
        if (await this.autoMergeNext()) return;
        if (await this.autoCookNext()) return;
      }
      if (await this.shouldDrainForPortfolio()) return;
      const settings = initial.settings;
      const evaluationDue =
        force ||
        !initial.orchestrator.lastEvaluationAt ||
        Date.now() - new Date(initial.orchestrator.lastEvaluationAt).getTime() >= settings.evaluationIntervalMinutes * 60_000;
      if (evaluationDue && this.runningEvaluations === 0 && this.activeAgents.size === 0 && this.activeComposites.size === 0) {
        await this.runBaselineEvaluations("baseline");
      }
      const refreshed = this.store.get();
      if (!refreshed.orchestrator.enabled && !force) return;
      const configuredLiving = refreshed.orchestrator.livingCompositeId ? refreshed.composites.find((item) => item.id === refreshed.orchestrator.livingCompositeId) : undefined;
      if (!(this.yolo && this.yoloBatchSize > 1) && refreshed.settings.preferLivingComposite && configuredLiving && configuredLiving.status !== "open") {
        await this.scheduleComposites();
        return;
      }
      const planningDue =
        force ||
        !refreshed.orchestrator.lastPlanningAt ||
        Date.now() - new Date(refreshed.orchestrator.lastPlanningAt).getTime() >= settings.orchestratorIntervalMinutes * 60_000;
      const queued = refreshed.ideas.filter((idea) => idea.status === "queued").length;
      if (planningDue && queued < settings.parallelism * 2) await this.plan();
      if (!this.store.get().orchestrator.enabled && !force) return;
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

  private findLivingComposite(state: BurnerState): CompositePr | undefined {
    if (this.yolo && this.yoloBatchSize > 1) return undefined;
    if (!state.settings.preferLivingComposite || !state.orchestrator.livingCompositeId) return undefined;
    const composite = state.composites.find((item) => item.id === state.orchestrator.livingCompositeId);
    return composite?.status === "open" && composite.reviewApproved ? composite : undefined;
  }

  private async ensureLivingComposite(): Promise<void> {
    await this.store.update((state) => {
      if (this.yolo && this.yoloBatchSize > 1) {
        state.orchestrator.livingCompositeId = undefined;
        for (const item of state.composites) item.isLiving = false;
        return;
      }
      if (!state.settings.preferLivingComposite) return;
      const current = state.orchestrator.livingCompositeId ? state.composites.find((item) => item.id === state.orchestrator.livingCompositeId) : undefined;
      if (current && !["merged", "closed"].includes(current.status)) {
        for (const item of state.composites) item.isLiving = item.id === current.id;
        return;
      }
      const next = state.composites
        .filter((item) => item.status === "open" && item.reviewApproved)
        .sort((a, b) => (b.compositeScore ?? -Infinity) - (a.compositeScore ?? -Infinity))[0];
      state.orchestrator.livingCompositeId = next?.id;
      for (const item of state.composites) item.isLiving = item.id === next?.id;
    });
  }

  private async resolveAgentBase(idea: Idea, state: BurnerState): Promise<AgentBase> {
    const portfolioMode = this.yolo && this.yoloBatchSize > 1;
    const living = this.findLivingComposite(state);
    const requested = !portfolioMode && idea.baseCompositeId ? state.composites.find((item) => item.id === idea.baseCompositeId) : undefined;
    const composite = requested?.status === "open" && requested.reviewApproved ? requested : living;
    if (composite && state.settings.preferLivingComposite) {
      const ref = await this.git.fetchBranch(state.settings.remote, composite.branch);
      const commit = await this.git.resolveRef(ref);
      const baseline = this.store.latestCompositeRuns(composite.id);
      return { ref, commit, baseline, compositeId: composite.id };
    }
    const commit = await this.git.resolveRef(state.settings.baseBranch);
    return {
      ref: state.settings.baseBranch,
      commit,
      baseline: this.portfolioMode() ? this.store.latestAgentBaselines() : this.store.latestRuns(),
    };
  }

  private async absorbExperiment(
    compositeId: string,
    runId: string,
    idea: Idea,
    worktree: string,
    branch: string,
    impact: number,
    settings: BurnerState["settings"],
  ): Promise<void> {
    const state = this.store.get();
    const composite = state.composites.find((item) => item.id === compositeId);
    const run = state.agentRuns.find((item) => item.id === runId);
    if (!composite || composite.status !== "open" || !run?.baseCommit) throw new Error("The living composite is no longer available for absorption.");
    if (await this.git.resolveRef(composite.branch) !== run.baseCommit) throw new Error("The living composite advanced during evaluation. Retry this experiment from its latest state.");
    await this.git.push(worktree, settings.remote, branch);
    const absorbedAt = now();
    await this.store.update((draft) => {
      const currentComposite = draft.composites.find((item) => item.id === compositeId);
      const currentRun = draft.agentRuns.find((item) => item.id === runId);
      if (!currentComposite || !currentRun) return;
      currentComposite.sources.push({ agentRunId: runId, title: idea.title, branch, kind: "experiment", absorbedAt, impact });
      currentComposite.status = "rebuilding";
      currentComposite.rebuildMode = "incremental";
      currentComposite.pendingExperimentRunIds = [...new Set([...(currentComposite.pendingExperimentRunIds ?? []), runId])];
      currentComposite.reviewApproved = false;
      currentComposite.reviewRounds = [];
      currentComposite.updatedAt = absorbedAt;
      currentRun.status = "absorbed";
      currentRun.absorbedAt = absorbedAt;
      currentRun.completedAt = absorbedAt;
      draft.orchestrator.lastPlanningAt = undefined;
    });
    await this.store.addActivity({ type: "pr", message: `Experiment absorbed: ${idea.title}`, detail: `Impact +${impact.toFixed(1)}. ${composite.title} will now be rebuilt, reviewed, and fully reevaluated.` });
    this.events.emit("state", this.store.get());
  }

  private async schedule(): Promise<void> {
    const state = this.store.get();
    if (!state.orchestrator.enabled) return;
    if (await this.shouldDrainForPortfolio()) return;
    if (this.yolo && this.yoloBatchSize > 1 && state.composites.some((composite) => ["queued", "building", "reviewing", "revising", "evaluating", "rebuilding"].includes(composite.status))) return;
    const configuredLiving = state.orchestrator.livingCompositeId ? state.composites.find((item) => item.id === state.orchestrator.livingCompositeId) : undefined;
    if (!(this.yolo && this.yoloBatchSize > 1) && state.settings.preferLivingComposite && configuredLiving && configuredLiving.status !== "open") return;
    const capacity = Math.max(0, state.settings.parallelism - this.activeAgents.size - this.activeComposites.size);
    if (!capacity) return;
    const queue = state.ideas
      .filter((idea) => idea.status === "queued")
      .sort((a, b) => b.predictedImpact - a.predictedImpact);
    let started = 0;
    for (const idea of queue) {
      if (started >= capacity) break;
      let base: AgentBase;
      try { base = await this.resolveAgentBase(idea, state); } catch { continue; }
      const resources = [...new Set([...state.settings.defaultResources, ...idea.resources, ...inferIdeaResources(idea), ...(base.compositeId ? [`living-${base.compositeId}`] : [])])];
      const lease = await this.locks.tryAcquireAll(resources, idea.id);
      if (!lease) continue;
      started += 1;
      this.activeAgents.add(idea.id);
      void this.runIdea(idea, base, resources, lease.locks, lease.release);
    }
  }

  private async runIdea(
    idea: Idea,
    base: AgentBase,
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
      baseRef: base.ref,
      baseCommit: base.commit,
      parentCompositeId: base.compositeId,
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
      const baseCommit = base.commit;
      const baseline = base.baseline;
      const enabledEvaluations = this.store.get().evaluations.filter((evaluation) => evaluation.enabled);
      const missingBaseline = enabledEvaluations.find((evaluation) => baseline.get(evaluation.id)?.commit !== baseCommit);
      if (missingBaseline) throw new Error(`Refresh evaluations at ${base.ref} before dispatching; '${missingBaseline.name}' is missing a comparable score.`);
      const gitLock = await this.locks.acquire("git-metadata", runId);
      try {
        worktree = await this.git.createWorktree(runId, branch, base.ref);
      } finally {
        await gitLock.release();
      }
      await this.updateAgent(runId, { worktree, status: "running" });
      const currentIdea = this.store.get().ideas.find((item) => item.id === idea.id) ?? idea;
      const authorStartCommit = await this.git.head(worktree);
      const author = await this.codex.implement(worktree, currentIdea, this.store.get().evaluations, settings);
      const lastMessage = author.message;
      await this.updateAgent(runId, { lastMessage, authorThreadId: author.threadId });
      const hasUncommittedChanges = await this.git.hasChanges(worktree);
      if (!hasUncommittedChanges && await this.git.head(worktree) === authorStartCommit) {
        await this.updateAgent(runId, { status: "no_changes", completedAt: now() });
        await this.finishIdea(idea.id, "completed");
        await this.store.addActivity({ type: "agent", message: `No changes produced: ${idea.title}`, detail: lastMessage.slice(0, 180) });
        return;
      }
      if (hasUncommittedChanges) await this.git.commit(worktree, `burner: ${idea.title}`);
      await this.reviewAndDeliverAgent(idea, base, runId, worktree, branch, settings, author.threadId, lastMessage);
    } catch (error) {
      const message = errorMessage(error);
      const quarantined = error instanceof PortfolioReviewLimitError;
      const completedAt = now();
      await this.updateAgent(runId, {
        status: "failed",
        error: message,
        completedAt,
        ...(quarantined ? { quarantinedAt: completedAt, quarantineReason: `No approval within ${this.portfolioReviewLimit(this.store.get().settings)} portfolio review rounds.` } : {}),
      });
      await this.finishIdea(idea.id, "failed");
      await this.store.addActivity({
        type: "error",
        message: quarantined ? `Agent quarantined: ${idea.title}` : `Agent failed: ${idea.title}`,
        detail: quarantined ? "The review budget was exhausted. Burner released the portfolio slot so healthier work can advance." : message,
      });
      this.events.emit("agent", { runId, status: "failed", error: message });
    } finally {
      await releaseLocks();
      this.activeAgents.delete(idea.id);
      this.runtimeCache = undefined;
      this.events.emit("state", this.store.get());
      if (this.store.get().orchestrator.enabled) {
        if (this.yolo) void this.tick(false);
        else void this.schedule();
      }
      if (!this.yolo || !this.store.get().orchestrator.enabled) void this.scheduleComposites(true);
      void heldLocks;
    }
  }

  private async reviewAndDeliverAgent(
    idea: Idea,
    base: AgentBase,
    runId: string,
    worktree: string,
    branch: string,
    settings: BurnerState["settings"],
    authorThreadId: string,
    initialMessage: string,
  ): Promise<void> {
    const reviewed = await this.reviewAgent(worktree, runId, idea.title, base.ref, authorThreadId, settings);
    const lastMessage = reviewed.message || initialMessage;
    await this.updateAgent(runId, { lastMessage, authorThreadId: reviewed.threadId, reviewApproved: true });
    if (await this.git.resolveRef(base.ref) !== base.commit) throw new Error("The experiment base moved during the review loop. Retry this idea from the latest living line.");
    await this.updateAgent(runId, { status: "evaluating" });
    const afterRuns = await this.runEvaluations("agent", worktree, runId);
    const failedEvaluation = afterRuns.find((run) => run.status !== "completed" || run.score === undefined);
    if (failedEvaluation) throw new Error("Candidate evaluation failed; Burner will not deliver a PR without complete before/after scores.");
    const deltas = this.calculateDeltas(this.store.get(), base.baseline, afterRuns);
    const impact = this.calculateImpact(this.store.get(), deltas);
    await this.updateAgent(runId, { deltas, impact });
    if (base.compositeId) {
      const regressions = deltas.filter((delta) => (delta.delta ?? -Infinity) < 0);
      if (impact <= settings.compositeAbsorbThreshold || regressions.length) {
        await this.updateAgent(runId, { status: "rejected", completedAt: now() });
        await this.finishIdea(idea.id, "completed");
        await this.store.addActivity({ type: "agent", message: `Experiment rejected: ${idea.title}`, detail: regressions.length ? `${regressions.length} evaluation regression${regressions.length === 1 ? "" : "s"}; living line unchanged.` : `Impact ${impact.toFixed(1)} did not clear the ${settings.compositeAbsorbThreshold.toFixed(1)} absorption threshold.` });
        return;
      }
      await this.absorbExperiment(base.compositeId, runId, idea, worktree, branch, impact, settings);
      await this.finishIdea(idea.id, "completed");
      return;
    }
    let pr: { url: string; number?: number } | undefined;
    if (settings.autoCreatePrs || this.yolo) {
      if (await this.git.resolveRef(base.ref) !== base.commit) throw new Error("The base branch moved during evaluation. Retry this idea to recalculate against the new main.");
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
    await this.updateAgent(runId, { status: "completed", completedAt: now(), prUrl: pr?.url, prNumber: pr?.number, prState: pr ? "open" : undefined });
    await this.finishIdea(idea.id, "completed");
    await this.store.addActivity({ type: pr ? "pr" : "agent", message: pr ? `PR opened: ${idea.title}` : `Agent completed: ${idea.title}`, detail: pr?.url ?? `Measured impact: ${impact >= 0 ? "+" : ""}${impact.toFixed(1)}` });
    if (pr) {
      const cleanupLock = await this.locks.acquire("git-metadata", `${runId}-cleanup`);
      try { await this.git.removeWorktree(worktree); } finally { await cleanupLock.release(); }
    }
    this.events.emit("agent", { runId, status: "completed", prUrl: pr?.url, impact });
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
      if (this.yolo && this.store.get().orchestrator.enabled) void this.tick(false);
      else void this.scheduleComposites(true);
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
      if (composite.sources.length < 2) throw new Error("A composite requires at least two constituent changes.");
      const settings = state.settings;
      const incremental = rebuild && composite.rebuildMode === "incremental" && Boolean(composite.pendingExperimentRunIds?.length);
      const rootStatus = await this.git.status();
      if (!rootStatus.available || rootStatus.dirty) throw new Error("Composite builds require a clean git base checkout.");
      const baseCommit = await this.git.resolveRef(settings.baseBranch);
      const baseline = this.store.latestRuns();
      const enabledEvaluations = state.evaluations.filter((evaluation) => evaluation.enabled);
      const missing = enabledEvaluations.find((evaluation) => baseline.get(evaluation.id)?.commit !== baseCommit);
      if (missing) throw new Error(`Run a clean baseline at ${settings.baseBranch} before building the composite; '${missing.name}' is stale.`);
      await this.updateComposite(compositeId, { status: rebuild ? "rebuilding" : "building", baseCommit, error: undefined, updatedAt: now() });

      const gitLock = await this.locks.acquire("git-metadata", `${compositeId}-create`);
      try {
        worktree = rebuild
          ? incremental
            ? await this.git.createExistingWorktree(compositeId, composite.branch)
            : await this.git.createRebuildWorktree(compositeId, composite.branch, settings.baseBranch)
          : await this.git.createWorktree(compositeId, composite.branch, settings.baseBranch);
      } finally {
        await gitLock.release();
      }
      await this.updateComposite(compositeId, { worktree, updatedAt: now() });

      const checkpointSource: CompositeSource | undefined = rebuild && !incremental && composite.isLiving && composite.checkpointBranch
        ? { agentRunId: `checkpoint-${composite.id}`, title: "Previous living-line checkpoint", branch: composite.checkpointBranch, kind: "experiment" }
        : undefined;
      const sourcesToMerge = incremental
        ? composite.sources.filter((source) => composite!.pendingExperimentRunIds?.includes(source.agentRunId))
        : checkpointSource ? [checkpointSource] : composite.sources;
      for (const source of sourcesToMerge) {
        const sourceRef = await this.git.fetchBranch(settings.remote, source.branch);
        const merge = await this.git.mergeBranch(worktree, sourceRef);
        if (merge.conflict) {
          const resolver = await this.codex.integrateComposite(worktree, composite.title, [source.title], settings);
          if (await this.git.hasChanges(worktree)) await this.git.commit(worktree, `burner: resolve composite conflict for ${source.prNumber ? `#${source.prNumber}` : source.title}`);
          await this.updateComposite(compositeId, { authorThreadId: resolver.threadId, updatedAt: now() });
        }
      }

      await this.publishCompositeDraft(worktree, compositeId, "integrating the combined source branches", settings);
      const author = await this.codex.integrateComposite(worktree, composite.title, sourcesToMerge.map((source) => source.title), settings);
      if (await this.git.hasChanges(worktree)) await this.git.commit(worktree, `burner: integrate ${composite.title}`);
      await this.updateComposite(compositeId, { authorThreadId: author.threadId, updatedAt: now() });
      await this.publishCompositeDraft(worktree, compositeId, "integrating and awaiting independent review", settings);
      const reviewed = await this.reviewComposite(worktree, compositeId, composite.title, settings.baseBranch, author.threadId, settings);
      await this.updateComposite(compositeId, { authorThreadId: reviewed.threadId, reviewApproved: true, status: "evaluating", updatedAt: now() });
      await this.publishCompositeDraft(worktree, compositeId, "recalculating every evaluation after review approval", settings);

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
      if (composite.prNumber) {
        await this.git.forcePush(worktree, settings.remote, composite.branch);
        await this.git.editPr(worktree, composite.prNumber, composite.title, body);
        await this.git.markPrReady(worktree, composite.prNumber);
      } else {
        await this.git.push(worktree, settings.remote, composite.branch);
        const pr = await this.git.openPr({ cwd: worktree, base: settings.baseBranch, branch: composite.branch, title: composite.title, body });
        await this.updateComposite(compositeId, { prUrl: pr.url, prNumber: pr.number, updatedAt: now() });
      }
      const checkpointBranch = composite.checkpointBranch ?? `burner/checkpoint-${composite.id}`;
      await this.git.pushCheckpoint(worktree, settings.remote, checkpointBranch);
      await this.updateComposite(compositeId, { status: "open", deltas, impact, compositeScore, reviewApproved: true, rebuildMode: undefined, pendingExperimentRunIds: [], checkpointBranch, error: undefined, updatedAt: now() });
      await this.ensureLivingComposite();
      await this.store.addActivity({ type: "pr", message: rebuild ? `Composite rebuilt: ${composite.title}` : `Composite opened: ${composite.title}`, detail: `Recalculated score ${compositeScore.toFixed(1)} (${impact >= 0 ? "+" : ""}${impact.toFixed(1)} impact).` });
      const cleanupLock = await this.locks.acquire("git-metadata", `${compositeId}-cleanup`);
      try { await this.git.removeWorktree(worktree); } finally { await cleanupLock.release(); }
    } catch (error) {
      const message = errorMessage(error);
      if (worktree) {
        const cleanupLock = await this.locks.acquire("git-metadata", `${compositeId}-failed-cleanup`);
        try { await this.git.removeWorktree(worktree); } finally { await cleanupLock.release(); }
      }
      if (error instanceof PortfolioReviewLimitError && error.target === "composite") {
        await this.quarantineCompositeBlocker(compositeId, error.findings);
        return;
      }
      const baseMoved = message.startsWith("BASE_CHANGED:");
      const currentMode = this.store.get().composites.find((item) => item.id === compositeId)?.rebuildMode;
      await this.updateComposite(compositeId, { status: baseMoved ? "rebuilding" : "failed", rebuildMode: baseMoved ? "from_base" : currentMode, error: message.replace("BASE_CHANGED: ", ""), updatedAt: now() });
      await this.store.addActivity({ type: baseMoved ? "system" : "error", message: baseMoved ? "Composite queued for a fresh base" : "Composite build failed", detail: message.replace("BASE_CHANGED: ", "") });
    } finally {
      await lease.release();
    }
  }

  private async reviewAgent(cwd: string, runId: string, title: string, baseBranch: string, threadId: string, settings: BurnerState["settings"]): Promise<SessionResult> {
    let currentThreadId = threadId;
    let message = this.store.get().agentRuns.find((run) => run.id === runId)?.lastMessage ?? "";
    const reviewLimit = this.portfolioReviewLimit(settings);
    let lastReview: ReviewResult | undefined;
    for (let roundNumber = 1; roundNumber <= reviewLimit; roundNumber += 1) {
      await this.updateAgent(runId, { status: "reviewing" });
      const review = await this.codex.review(cwd, baseBranch, title, settings);
      lastReview = review;
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
      if (roundNumber === reviewLimit) break;
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
    if (this.portfolioMode()) throw new PortfolioReviewLimitError(lastReview?.findings ?? [], "agent");
    throw new Error(`Reviewer did not approve after ${reviewLimit} rounds; no PR was opened.`);
  }

  private async reviewComposite(cwd: string, compositeId: string, title: string, baseBranch: string, threadId: string, settings: BurnerState["settings"]): Promise<SessionResult> {
    let currentThreadId = threadId;
    let message = "Composite integration complete.";
    const reviewLimit = this.portfolioReviewLimit(settings);
    let lastReview: ReviewResult | undefined;
    for (let roundNumber = 1; roundNumber <= reviewLimit; roundNumber += 1) {
      await this.updateComposite(compositeId, { status: "reviewing", updatedAt: now() });
      const review = await this.codex.review(cwd, baseBranch, title, settings);
      lastReview = review;
      const round: ReviewRound = { id: id("review"), round: roundNumber, commit: await this.git.head(cwd), approved: review.approved, summary: review.summary, findings: review.findings, createdAt: now() };
      await this.store.update((state) => state.composites.find((item) => item.id === compositeId)?.reviewRounds.push(round));
      this.events.emit("review", { compositeId, round: roundNumber, approved: review.approved, findings: review.findings.length });
      await this.publishCompositeDraft(cwd, compositeId, `in independent review round ${roundNumber}`, settings);
      if (review.approved) {
        round.completedAt = now();
        await this.store.update((state) => {
          const stored = state.composites.find((item) => item.id === compositeId)?.reviewRounds.find((item) => item.id === round.id);
          if (stored) Object.assign(stored, round);
        });
        return { message, threadId: currentThreadId };
      }
      if (roundNumber === reviewLimit) break;
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
      await this.publishCompositeDraft(cwd, compositeId, `revising findings from review round ${roundNumber}`, settings);
    }
    if (this.portfolioMode()) throw new PortfolioReviewLimitError(lastReview?.findings ?? [], "composite");
    throw new Error(`Composite reviewer did not approve after ${reviewLimit} rounds.`);
  }

  private normalizeReview(review: ReviewResult): ReviewResult {
    if (review.findings.length || review.approved) return review;
    return { ...review, findings: [{ severity: "medium", title: "Reviewer requested another pass", detail: review.summary || "Inspect the complete diff and address remaining review concerns.", file: "" }] };
  }

  private async quarantineCompositeBlocker(compositeId: string, findings: ReviewResult["findings"]): Promise<void> {
    const state = this.store.get();
    const composite = state.composites.find((item) => item.id === compositeId);
    if (!composite) return;
    const baseCommit = composite.baseCommit ?? await this.git.resolveRef(state.settings.baseBranch);
    const findingFiles = findings
      .map((finding) => finding.file.trim().replace(/^\.\//, "").replace(/:\d+(?::\d+)?$/, ""))
      .filter(Boolean);
    const scored: Array<{ source: CompositeSource; score: number; impact: number }> = [];
    for (const source of composite.sources.filter((item) => item.kind === "pull_request")) {
      let files: string[] = [];
      try {
        files = await this.git.changedFiles(this.root, baseCommit, `${state.settings.remote}/${source.branch}`);
      } catch {
        // The source may have been removed remotely. It remains a valid low-confidence quarantine candidate.
      }
      const score = findingFiles.reduce((total, findingFile) => total + (files.some((file) => file === findingFile || findingFile.endsWith(`/${file}`) || file.endsWith(`/${findingFile}`)) ? 1 : 0), 0);
      const runImpact = state.agentRuns.find((run) => run.id === source.agentRunId)?.impact;
      scored.push({ source, score, impact: source.impact ?? runImpact ?? -Infinity });
    }
    scored.sort((a, b) => b.score - a.score || a.impact - b.impact || b.source.agentRunId.localeCompare(a.source.agentRunId));
    const suspect = scored[0]?.source;
    if (!suspect) {
      await this.updateComposite(compositeId, { status: "failed", error: "Portfolio review budget exhausted, but no leaf source could be isolated.", updatedAt: now() });
      return;
    }

    const timestamp = now();
    const reason = findingFiles.length && scored[0]!.score > 0
      ? `Composite review repeatedly blocked in ${findingFiles.join(", ")}. Burner isolated the leaf with the strongest file overlap.`
      : "Composite review exhausted its bounded budget. Burner isolated the lowest-impact leaf so the healthy subset could continue.";
    await this.store.update((draft) => {
      const run = draft.agentRuns.find((item) => item.id === suspect.agentRunId);
      if (run) { run.quarantinedAt = timestamp; run.quarantineReason = reason; }
      const current = draft.composites.find((item) => item.id === compositeId);
      if (current) {
        current.status = "closed";
        current.reviewApproved = false;
        current.quarantinedSourceAgentRunId = suspect.agentRunId;
        current.error = `Review budget exhausted; quarantined ${suspect.prNumber ? `#${suspect.prNumber}` : suspect.title}.`;
        current.updatedAt = timestamp;
      }
    });
    if (suspect.prNumber) await this.git.markPrQuarantined(this.root, suspect.prNumber).catch(() => undefined);
    if (composite.prNumber) {
      await this.git.closePr(this.root, composite.prNumber, `Burner retired this draft after its bounded review budget. ${suspect.prNumber ? `Source PR #${suspect.prNumber}` : suspect.title} was quarantined; a healthy subset will continue.`);
    }
    await this.store.addActivity({
      type: "error",
      message: `Portfolio leaf quarantined: ${suspect.prNumber ? `#${suspect.prNumber}` : suspect.title}`,
      detail: `${reason} The remaining ${composite.sources.length - 1} source changes were released immediately.`,
    });

    const remainingIds = composite.sources.filter((source) => source.agentRunId !== suspect.agentRunId && source.kind === "pull_request").map((source) => source.agentRunId);
    if (remainingIds.length >= 2) {
      const fallback = await this.createComposite(
        remainingIds,
        `${composite.title.replace(/ · healthy subset.*$/, "")} · healthy subset`,
        `${composite.description}\n\nBurner removed ${suspect.prNumber ? `#${suspect.prNumber}` : suspect.title} after the portfolio review budget was exhausted and continued with the remaining reviewed leaves.`,
        { makeLiving: false },
      );
      await this.updateComposite(compositeId, { supersededByCompositeId: fallback.id, updatedAt: now() });
    }
  }

  private async publishCompositeDraft(cwd: string, compositeId: string, phase: string, settings: BurnerState["settings"]): Promise<void> {
    if (!settings.autoCreatePrs && !this.yolo) return;
    const composite = this.store.get().composites.find((item) => item.id === compositeId);
    if (!composite) return;
    const body = buildCompositeDraftPrBody({
      description: composite.description,
      sources: composite.sources,
      reviewRounds: composite.reviewRounds,
      phase,
    });
    if (composite.prNumber) {
      await this.git.markPrDraft(cwd, composite.prNumber);
      await this.git.forcePush(cwd, settings.remote, composite.branch);
      await this.git.editPr(cwd, composite.prNumber, composite.title, body);
      return;
    }
    await this.git.push(cwd, settings.remote, composite.branch);
    const pr = await this.git.openPr({
      cwd,
      base: settings.baseBranch,
      branch: composite.branch,
      title: composite.title,
      body,
      draft: true,
    });
    await this.updateComposite(compositeId, { prUrl: pr.url, prNumber: pr.number, updatedAt: now() });
    await this.store.addActivity({ type: "pr", message: `Draft composite opened: ${composite.title}`, detail: `${pr.url} · ${phase}.` });
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
        screening: after.context === "agent" && Boolean(evaluation?.screeningCommand) && this.portfolioMode(),
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
