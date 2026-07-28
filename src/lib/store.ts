import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Activity, BurnerState, Evaluation, EvaluationRun } from "../types.js";
import { id, now, weightedScore } from "./utils.js";

type Listener = (state: BurnerState) => void;

function initialState(root: string): BurnerState {
  const createdAt = now();
  return {
    version: 1,
    projectName: basename(root),
    settings: {
      parallelism: 2,
      evaluationIntervalMinutes: 30,
      orchestratorIntervalMinutes: 15,
      autoRun: false,
      autoCreatePrs: true,
      evaluatorModel: "",
      agentModel: "",
      baseBranch: "main",
      remote: "origin",
      defaultResources: [],
    },
    evaluations: [
      {
        id: id("eval"),
        name: "Overall quality",
        prompt: "Score the overall quality and production readiness of this repository out of 100.",
        weight: 1,
        enabled: true,
        createdAt,
      },
      {
        id: id("eval"),
        name: "Polish",
        prompt: "How polished, coherent, and delightful is the user-facing experience? Score it out of 100.",
        weight: 1,
        enabled: true,
        createdAt,
      },
      {
        id: id("eval"),
        name: "Performance",
        prompt: "Score this project's runtime and loading performance out of 100, based on evidence in the repository.",
        weight: 1,
        enabled: true,
        createdAt,
      },
    ],
    evaluationRuns: [],
    ideas: [],
    agentRuns: [],
    activity: [
      {
        id: id("activity"),
        type: "system",
        message: "Burner is ready",
        detail: "Configure evaluations, run a baseline, then ignite the orchestrator.",
        createdAt,
      },
    ],
    orchestrator: { enabled: false },
  };
}

export class StateStore {
  readonly dataDir: string;
  readonly statePath: string;
  private state!: BurnerState;
  private listeners = new Set<Listener>();
  private writeChain = Promise.resolve();

  constructor(readonly root: string) {
    this.dataDir = join(root, ".burner");
    this.statePath = join(this.dataDir, "state.json");
  }

  async init(): Promise<BurnerState> {
    await mkdir(this.dataDir, { recursive: true });
    try {
      this.state = JSON.parse(await readFile(this.statePath, "utf8")) as BurnerState;
      this.state.orchestrator.enabled = false;
      for (const run of this.state.agentRuns) {
        if (["starting", "running", "evaluating", "opening_pr"].includes(run.status)) {
          run.status = "failed";
          run.error = "Burner stopped before this run completed.";
          run.completedAt = now();
        }
      }
      for (const idea of this.state.ideas) {
        if (idea.status === "running") idea.status = "failed";
      }
      for (const run of this.state.evaluationRuns) {
        if (run.status === "running") {
          run.status = "failed";
          run.error = "Burner stopped before this evaluation completed.";
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = initialState(this.root);
    }
    await this.persist();
    return this.get();
  }

  get(): BurnerState {
    return structuredClone(this.state);
  }

  async update(mutator: (state: BurnerState) => void): Promise<BurnerState> {
    mutator(this.state);
    this.trim();
    await this.persist();
    const snapshot = this.get();
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async addActivity(activity: Omit<Activity, "id" | "createdAt">): Promise<void> {
    await this.update((state) => {
      state.activity.unshift({ ...activity, id: id("activity"), createdAt: now() });
    });
  }

  latestRuns(context?: EvaluationRun["context"]): Map<string, EvaluationRun> {
    const latest = new Map<string, EvaluationRun>();
    for (const run of this.state.evaluationRuns) {
      if (
        run.status !== "completed" ||
        run.score === undefined ||
        (context ? run.context !== context : run.context === "agent")
      ) continue;
      const current = latest.get(run.evaluationId);
      if (!current || run.createdAt > current.createdAt) latest.set(run.evaluationId, run);
    }
    return latest;
  }

  compositeScores(): { current?: number; previous?: number } {
    const byEvaluation = new Map<string, EvaluationRun[]>();
    for (const run of this.state.evaluationRuns) {
      if (run.status !== "completed" || run.score === undefined || run.context === "agent") continue;
      const runs = byEvaluation.get(run.evaluationId) ?? [];
      runs.push(run);
      byEvaluation.set(run.evaluationId, runs);
    }
    const current = new Map<string, number>();
    const previous = new Map<string, number>();
    for (const [evaluationId, runs] of byEvaluation) {
      runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (runs[0]?.score !== undefined) current.set(evaluationId, runs[0].score);
      if (runs[1]?.score !== undefined) previous.set(evaluationId, runs[1].score);
    }
    return {
      current: weightedScore(this.state.evaluations, current),
      previous: weightedScore(this.state.evaluations, previous),
    };
  }

  private async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const temp = `${this.statePath}.tmp`;
      await writeFile(temp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
      await rename(temp, this.statePath);
    });
    return this.writeChain;
  }

  private trim(): void {
    this.state.activity = this.state.activity.slice(0, 250);
    this.state.evaluationRuns = this.state.evaluationRuns.slice(-1000);
    this.state.ideas = this.state.ideas.slice(-250);
    this.state.agentRuns = this.state.agentRuns.slice(-250);
  }
}

export function validateEvaluation(input: Partial<Evaluation>): Omit<Evaluation, "id" | "createdAt"> {
  const name = input.name?.trim();
  const prompt = input.prompt?.trim();
  if (!name || !prompt) throw new Error("Evaluation name and prompt are required.");
  const weight = Number(input.weight ?? 1);
  if (!Number.isFinite(weight) || weight <= 0 || weight > 10) throw new Error("Weight must be between 0 and 10.");
  return { name, prompt, weight, enabled: input.enabled ?? true };
}
