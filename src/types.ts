export type Evaluation = {
  id: string;
  name: string;
  prompt: string;
  weight: number;
  enabled: boolean;
  createdAt: string;
};

export type EvaluationRun = {
  id: string;
  evaluationId: string;
  score?: number;
  summary?: string;
  evidence?: string[];
  suggestions?: string[];
  commit: string;
  createdAt: string;
  durationMs: number;
  status: "running" | "completed" | "failed";
  error?: string;
  context: "baseline" | "agent" | "manual";
  agentRunId?: string;
};

export type Idea = {
  id: string;
  title: string;
  description: string;
  rationale: string;
  predictedImpact: number;
  evaluationIds: string[];
  resources: string[];
  status: "queued" | "running" | "completed" | "failed" | "dismissed";
  createdAt: string;
  updatedAt: string;
  source: "codex" | "manual";
  agentRunId?: string;
};

export type ScoreDelta = {
  evaluationId: string;
  name: string;
  before?: number;
  after?: number;
  delta?: number;
  summary?: string;
};

export type AgentRun = {
  id: string;
  ideaId: string;
  status:
    | "starting"
    | "running"
    | "evaluating"
    | "opening_pr"
    | "completed"
    | "failed"
    | "no_changes";
  branch: string;
  worktree: string;
  startedAt: string;
  completedAt?: string;
  lastMessage?: string;
  error?: string;
  prUrl?: string;
  prNumber?: number;
  deltas: ScoreDelta[];
  impact?: number;
  resources: string[];
};

export type Activity = {
  id: string;
  type: "system" | "evaluation" | "idea" | "agent" | "pr" | "error";
  message: string;
  detail?: string;
  createdAt: string;
};

export type BurnerSettings = {
  parallelism: number;
  evaluationIntervalMinutes: number;
  orchestratorIntervalMinutes: number;
  autoRun: boolean;
  autoCreatePrs: boolean;
  evaluatorModel: string;
  agentModel: string;
  baseBranch: string;
  remote: string;
  defaultResources: string[];
};

export type BurnerState = {
  version: 1;
  projectName: string;
  settings: BurnerSettings;
  evaluations: Evaluation[];
  evaluationRuns: EvaluationRun[];
  ideas: Idea[];
  agentRuns: AgentRun[];
  activity: Activity[];
  orchestrator: {
    enabled: boolean;
    lastEvaluationAt?: string;
    lastPlanningAt?: string;
  };
};

export type RuntimeStatus = {
  codex: { available: boolean; version?: string };
  git: { available: boolean; branch?: string; commit?: string; dirty?: boolean };
  gh: { available: boolean; authenticated: boolean };
  runningEvaluations: number;
  runningAgents: number;
  heldLocks: string[];
};

export type DashboardPayload = {
  state: BurnerState;
  runtime: RuntimeStatus;
  compositeScore?: number;
  previousCompositeScore?: number;
};
