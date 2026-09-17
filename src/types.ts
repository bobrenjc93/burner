export type Evaluation = {
  id: string;
  name: string;
  prompt: string;
  command?: string;
  screeningCommand?: string;
  weight: number;
  enabled: boolean;
  createdAt: string;
  /** Changes whenever score-producing evaluation inputs are edited. */
  definitionVersion?: string;
};

export type CommandEvidenceReference = {
  /** Original measurement ID, including when its scores are later promoted to a baseline. */
  runId: string;
  /** Paths relative to the canonical repository, never the evaluated worktree. */
  directory?: string;
  manifest?: string;
  /** Owned temporary export sink, retained for recovery until collection and cleanup succeed. */
  recoveryDirectory?: string;
  status: "capturing" | "complete" | "incomplete";
  issues?: string[];
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
  attempts?: number;
  error?: string;
  context: "baseline" | "screening_baseline" | "agent" | "composite" | "manual";
  agentRunId?: string;
  compositeId?: string;
  /** Exact evaluation definition used to produce this run. */
  evaluationDefinitionVersion?: string;
  /** Number of independent prompt samples represented by this persisted median. */
  promptSampleCount?: number;
  /** Best-effort raw command capture; retention status does not change scoring or eligibility. */
  commandEvidence?: CommandEvidenceReference;
  /** One invocation of a durably owned leaf sample; retries keep the slot. */
  leafSample?: { receiptId: string; side: "candidate" | "baseline"; index: number; attempt: number };
  /** Source measurements of a persisted reduction or baseline promotion. */
  sourceRunIds?: string[];
};

export type Idea = {
  id: string;
  title: string;
  description: string;
  rationale: string;
  predictedImpact: number;
  /** Scheduling lane. Foundational work may be score-neutral while it unlocks a sparse evaluation. */
  lane?: "incremental" | "foundational";
  /** Concrete, independently reviewable capability delivered by a foundational idea. */
  milestone?: string;
  /** Internal scheduling credit only; never contributes to an evaluation or merge score. */
  milestoneCredit?: number;
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
  screening?: boolean;
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
  /** Leaf approval identity; absent on legacy review checkpoints. */
  baseCommit?: string;
  evaluationFingerprint?: string;
  /** Committed result of a consumed author response, not another review. */
  authorCommit?: string;
};

export type PullRequestState = "open" | "closed" | "merged" | "superseded";

export type FullAssessmentIdentity = {
  baseCommit: string;
  candidateCommit: string;
  evaluationFingerprint: string;
};

export type FullMergeValidation = FullAssessmentIdentity & {
  qualified: boolean;
  completedAt: string;
  /** Absent only on legacy version-3 records; new assessments are self-contained. */
  candidateTree?: string;
  deltas?: ScoreDelta[];
  impact?: number;
  evaluation?: LeafEvaluationReceipt;
  legacyProvenance?: {
    importer: "old-leaf-full-v1";
    originalDigest: string;
    sources: LeafEvidenceReference[];
    activities: { activity: Activity; digest: string }[];
    reductions: { evaluationId: string; baseline: string; samples: string[]; count: number; representativeOrder: "known" | "unknown-tie" }[];
  };
};

export type LeafEvidenceReference = { runId: string; digest: string };

export type LeafSampleSlot =
  | { attempts: string[]; success?: LeafEvidenceReference }
  | { reuse: LeafEvidenceReference & { reason: "baseline" | "full-command" } };

export type LeafEvaluationReceipt = {
  id: string;
  purpose: "delivery" | "full";
  agentRunId: string;
  approvalRoundId?: string;
  identity: FullAssessmentIdentity;
  candidateTree: string;
  scoreDefinitionFingerprint: string;
  evaluations: {
    evaluationId: string;
    definitionVersion?: string;
    mode: "prompt" | "full-command" | "screening-command";
    baseline: {
      source: LeafEvidenceReference;
      comparisonCommit: string;
      score: number;
      count: number;
      projection?: { compositeId?: string; sourceCommit: string; inputs: LeafEvidenceReference[] };
    };
    candidate: LeafSampleSlot[];
    baselineConfirmations?: LeafSampleSlot[];
    baselineMedian?: LeafEvidenceReference;
  }[];
  result?: {
    completedAt: string;
    sources: LeafEvidenceReference[];
    selections: { evaluationId: string; candidate: string; baseline: string; candidateSources: string[]; baselineSources: string[]; count: number; baselineCount: number }[];
    deltas: ScoreDelta[];
    impact: number;
  };
};

/** Version-3 aggregate delivery records are read-only compatibility input. */
export type LegacyLeafEvaluation = { evaluationRunIds: string[]; deltas: ScoreDelta[]; impact: number; completedAt: string };

/** GitHub's repository node identity, resolved from the configured Git remote. */
export type LeafRepositoryIdentity = { host: string; id: string; nameWithOwner: string };

/** The complete controlled PR tuple. MERGED is an observation, never a content preimage. */
export type LeafPrFields = { title: string; body: string; isDraft: boolean; state: "OPEN" | "CLOSED" };
export type LeafPrContent = Pick<LeafPrFields, "title" | "body" | "isDraft">;

/** Explicit, read-only ingress for the one supported archived writer protocol. */
export type LegacyLeafPrProofInput = {
  protocol: "executed-leaf-writer-v1";
  directory: string;
  startedSha256: string;
  resultSha256: string;
  stateSha256: string;
};

export type LeafTerminalReason = {
  continuationId: string;
  /** Transfer identity, not proof that a source has landed. */
  compositeId?: string;
} & (
  | { kind: "review-limit" | "no-changes" | "rejected" | "absorbed" | "superseded" | "abandoned" }
  | { kind: "withdrawn"; head: string; detail: string }
);

export type LeafPrSemanticOwner =
  | { kind: "delivery" | "review-checkpoint"; continuationId: string }
  | { kind: "full-publication"; assessment: FullAssessmentIdentity }
  | { kind: "merge-ready"; head: string }
  | { kind: "weight-presentation"; fingerprint: string }
  | { kind: "terminal-close"; reason: LeafTerminalReason };

export type LeafPrEffect =
  | { kind: "create"; after: LeafPrFields }
  | { kind: "edit"; field: "title" | "body"; before: LeafPrFields; after: LeafPrFields }
  | { kind: "draft" | "ready" | "close"; before: LeafPrFields; after: LeafPrFields };

/** The sole leaf content/lifecycle authority; Git heads stay in continuation receipts. */
export type LeafPrOwnership = {
  version: 1;
  repository: LeafRepositoryIdentity;
  branch: string;
  baseBranch: string;
  creationToken?: string;
  known?: { number: number; url: string; fields: LeafPrFields };
  pending?: { id: string; owner: LeafPrSemanticOwner; target: LeafPrFields; effect?: LeafPrEffect };
  /** Retained after close acknowledgment; CLOSED never authorizes reopening. */
  terminal?: LeafTerminalReason;
  /** Past checked inclusion; targetCommit is the then-proved target, not today's base. */
  merged?: { sourceBase: string; head: string; landing: string; targetCommit: string };
  legacy?: { protocol: "executed-leaf-writer-v1"; proofDigest: string; stateDigest: string; runtimeDigest: string; driverDigest: string };
};

type LeafPublicationGit = {
  branch: string;
  number?: number;
  previousRemoteHead: string | null;
  head: string;
};

/** New publications refer to the single PR owner, not another desired-content copy. */
export type LeafPublication = LeafPublicationGit & { prOwnerId: string };

/** Read-only admission input, never written by the current publisher. */
export type LegacyLeafPublication = LeafPublicationGit & {
  title: string;
  body: string;
  draft?: boolean;
};

export type LeafManagedPlan = {
  inputHead: string;
  inputTree: string;
  tree: string;
  files: { path: string; oldBlob: string | null; oldText: string | null; text: string | null; mode: string; temporary: string }[];
};

export type GeneratedLeafProgress = {
  /** Present on new certificates; legacy proofs require exact Git admission. */
  baseCommit?: string;
  inputCommit: string;
  inputTree: string;
  outputCommit: string;
  outputTree: string;
  plan: LeafManagedPlan;
  /** Earlier exact proofs retained when another stamp replaces this one. */
  previous?: GeneratedLeafProgress[];
};

export type LeafQualificationPolicy = "ordinary" | "separate-full";

export type FullEvaluationHistoryEntry =
  | {
      kind: "assessment";
      assessment: FullMergeValidation;
      /** Git-owned identity against this assessment's recorded comparison base. */
      comparison: { tree: string; progress: GeneratedLeafProgress[] };
    }
  | {
      kind: "superseded";
      evaluation: LeafEvaluationReceipt;
      refreshId: string;
      targetRef: string;
      targetCommit: string;
      retiredAt: string;
    };

type LeafDone = { step: "done"; outcome: "completed" | "no_changes" | "absorbed" | "rejected"; completedAt: string; evaluation?: LeafEvaluationReceipt | LegacyLeafEvaluation };

type LeafRefresh = {
  targetRef: string;
  targetCommit: string;
  destination: "initial" | "evidence";
  previousRemoteHead: string | null;
  parentCompositeId?: string;
  resources: string[];
} & (
  | { phase: "merge"; tree: string; conflict: boolean; contained: boolean }
  | { phase: "conflict-author" }
  | { phase: "commit"; tree: string; parents: string[]; result?: { message: string; threadId: string } }
  | { phase: "restore" }
  | { phase: "write"; plan: LeafManagedPlan }
  | { phase: "restore-commit"; plan: LeafManagedPlan }
  | { phase: "push" }
);

export type LeafAuthorReason =
  | { kind: "initial" }
  | { kind: "review"; roundId: string }
  | { kind: "evaluation"; assessment: FullAssessmentIdentity; notes?: string }
  | { kind: "operator"; requestId: string }
  | { kind: "checks"; feedback: string };

export type LeafContinuationIdentity = {
  baseRef: string;
  baseCommit: string;
  branch: string;
  evaluationFingerprint: string;
  remote: string;
  baseBranch: string;
  /** The exact last known published head; a branch name alone is not provenance. */
  pullRequest?: { number: number; head: string; url?: string };
};

type LeafCheckpoint = {
  id: string;
  identity: LeafContinuationIdentity;
  /** Expected committed input head (or the input parent for a commit receipt). */
  head: string;
  /** Delivery/checkpoint Git push expectations; content belongs only to leafPr. */
  publication?: LeafPublication | LegacyLeafPublication;
};

/** The sole next-operation owner for new-format leaf execution. */
export type LeafContinuation = LeafCheckpoint & (
  | { step: "author"; reason: LeafAuthorReason }
  | {
      step: "commit";
      tree: string;
      result: { message: string; threadId: string };
      source: { kind: "author"; reason: LeafAuthorReason } | { kind: "evidence"; implementationCommit: string };
      commitMessage: string;
    }
  | { step: "evidence" }
  | { step: "review"; implementationCommit: string; evidence: string }
  | {
      step: "delivery";
      approvalRoundId: string;
      /** Completed candidate/screening work awaiting publication, not a full verdict. */
      evaluation?: LeafEvaluationReceipt | LegacyLeafEvaluation;
    }
  | LeafDone
  | { step: "progress"; phase: "write" | "commit" | "push"; plan: LeafManagedPlan; previousRemoteHead: string; done: LeafDone }
  | ({ step: "refresh" } & LeafRefresh)
);

/** Request provenance, not another execution cursor. Only the latest may resume. */
export type LeafReauthorRequest = {
  id: string;
  guidance: string;
  source: Extract<LeafContinuation, { step: "evidence" | "review" | "done" }>;
  previousAuthorMessage?: string;
  assessment?: FullAssessmentIdentity;
  admittedAt: string;
  output?: { continuationId: string; head: string };
  releasedAt?: string;
};

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
  /** One-way admission latch for this numbered leaf's canonical checkout(s). */
  retainWorktree?: true;
  startedAt: string;
  completedAt?: string;
  lastMessage?: string;
  /** Immutable original author handoff, retained when later repairs update lastMessage. */
  initialAuthorMessage?: string;
  error?: string;
  prUrl?: string;
  prNumber?: number;
  prState?: PullRequestState;
  leafPr?: LeafPrOwnership;
  supersededByCompositeId?: string;
  deltas: ScoreDelta[];
  impact?: number;
  resources: string[];
  authorThreadId?: string;
  /** Read-only legacy admission input; continuation owns new-format execution. */
  authoringComplete?: boolean;
  continuation?: LeafContinuation;
  /** Older requests retain provenance; the latest unreleased request caps execution at its author output. */
  reauthorRequests?: LeafReauthorRequest[];
  reviewRounds: ReviewRound[];
  reviewApproved?: boolean;
  baseRef?: string;
  baseCommit?: string;
  parentCompositeId?: string;
  absorbedAt?: string;
  quarantinedAt?: string;
  quarantineReason?: string;
  cadenceFallback?: boolean;
  evaluationRetryCount?: number;
  /** Read-only version-3 input; target admission moves it into terminal history. */
  fullMergeValidation?: FullMergeValidation;
  /** Append-only terminal evidence. No persisted "latest" assessment alias. */
  fullEvaluationHistory?: FullEvaluationHistoryEntry[];
  /** Missing legacy provenance is unknown, never an implicit ordinary policy. */
  leafQualificationPolicy?: LeafQualificationPolicy;
  fullEvaluation?:
    | { step: "sampling"; evaluation: LeafEvaluationReceipt }
    | { step: "publication"; assessment: FullAssessmentIdentity; publication: LeafPublication | LegacyLeafPublication };
  generatedProgress?: GeneratedLeafProgress;
  /** Read-only legacy input. New repairs reference terminal history by identity. */
  evaluationRepair?: {
    validation: NonNullable<AgentRun["fullMergeValidation"]>;
    deltas: ScoreDelta[];
    rejectedTree: string;
    notes?: string;
  };
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
  rebuildMode?: "incremental" | "from_base" | "resume";
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
  stallTerminationHours: number;
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
    bestScore?: number;
    bestScoreAt?: string;
    bestScoreEvaluationFingerprint?: string;
    stalledAt?: string;
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
