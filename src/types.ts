export type Evaluation = {
  id: string;
  name: string;
  prompt: string;
  command?: string;
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
  context: "baseline" | "agent" | "composite" | "manual";
  agentRunId?: string;
  compositeId?: string;
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
  baseCompositeId?: string;
};

export type ScoreDelta = {
  evaluationId: string;
  name: string;
  before?: number;
  after?: number;
  delta?: number;
  summary?: string;
};

export type ReviewFinding = {
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  detail: string;
  file: string;
};

export type ReviewRound = {
  id: string;
  round: number;
  commit: string;
  approved: boolean;
  summary: string;
  findings: ReviewFinding[];
  authorResponse?: string;
  createdAt: string;
  completedAt?: string;
};

export type PullRequestState = "open" | "closed" | "merged" | "superseded";

export type AgentRun = {
  id: string;
  ideaId: string;
  status:
    | "starting"
    | "running"
    | "reviewing"
    | "revising"
    | "evaluating"
    | "opening_pr"
    | "completed"
    | "absorbed"
    | "rejected"
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
  prState?: PullRequestState;
  supersededByCompositeId?: string;
  deltas: ScoreDelta[];
  impact?: number;
  resources: string[];
  authorThreadId?: string;
  reviewRounds: ReviewRound[];
  reviewApproved?: boolean;
  baseRef?: string;
  baseCommit?: string;
  parentCompositeId?: string;
  absorbedAt?: string;
  quarantinedAt?: string;
  quarantineReason?: string;
};

export type CompositeSource = {
  agentRunId: string;
  prNumber?: number;
  title: string;
  branch: string;
  kind: "pull_request" | "experiment";
  absorbedAt?: string;
  impact?: number;
};

export type CompositePr = {
  id: string;
  title: string;
  description: string;
  status: "queued" | "building" | "reviewing" | "revising" | "evaluating" | "open" | "rebuilding" | "merged" | "closed" | "failed";
  branch: string;
  worktree: string;
  baseCommit?: string;
  sources: CompositeSource[];
  deltas: ScoreDelta[];
  compositeScore?: number;
  impact?: number;
  reviewRounds: ReviewRound[];
  reviewApproved?: boolean;
  authorThreadId?: string;
  prUrl?: string;
  prNumber?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  isLiving: boolean;
  rebuildMode?: "incremental" | "from_base";
  pendingExperimentRunIds?: string[];
  checkpointBranch?: string;
  quarantinedSourceAgentRunId?: string;
  supersededByCompositeId?: string;
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
  maxReviewRounds: number;
  portfolioReviewRounds: number;
  mergeCadenceMinutes: number;
  preferLivingComposite: boolean;
  compositeAbsorbThreshold: number;
};

export type BurnerState = {
  version: 3;
  projectName: string;
  settings: BurnerSettings;
  evaluations: Evaluation[];
  evaluationRuns: EvaluationRun[];
  ideas: Idea[];
  agentRuns: AgentRun[];
  composites: CompositePr[];
  activity: Activity[];
  orchestrator: {
    enabled: boolean;
    lastEvaluationAt?: string;
    lastPlanningAt?: string;
    baseSyncPending?: boolean;
    livingCompositeId?: string;
    lastMergeAt?: string;
    mergeWindowStartedAt?: string;
    lastMergeCadenceAlertAt?: string;
  };
};

export type RuntimeStatus = {
  codex: { available: boolean; version?: string };
  git: { available: boolean; branch?: string; commit?: string; dirty?: boolean };
  gh: { available: boolean; authenticated: boolean };
  yolo: boolean;
  yoloBatchSize?: number;
  runningEvaluations: number;
  runningAgents: number;
  runningComposites: number;
  heldLocks: string[];
};

export type DashboardPayload = {
  state: BurnerState;
  runtime: RuntimeStatus;
  compositeScore?: number;
  previousCompositeScore?: number;
};
