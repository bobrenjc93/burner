import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BurnerSettings, Evaluation, EvaluationRun, Idea, ReviewFinding } from "../types.js";
import { CODEX_REASONING_EFFORT, DEFAULT_CODEX_MODEL } from "./codex-config.js";
import { runCommand, type CommandResult } from "./process.js";
import { clampScore, errorMessage, parseJsonObject, truncateText } from "./utils.js";

const UNRESTRICTED_FLAG = "--dangerously-bypass-approvals-and-sandbox";
const META_DISABLE_SANDBOX_FLAG = "--dangerously-disable-osx-sandbox";
const AUTOMATION_HOOK_ARGS = ["--disable", "hooks"];
export const DEFAULT_PROMPT_EVALUATION_TIMEOUT_MS = 4 * 60 * 1000;
const PROGRESS_OWNERSHIP = "Burner owns the canonical merge-coupled evaluation progress artifacts: the managed README section, docs/burner-evaluation-history.json, and docs/burner-evaluation-progress.svg. Burner injects them only after final candidate scores are known. During exact-head validation those Burner-generated artifacts may therefore appear in the candidate diff; ignore those generated changes entirely when scoring every rubric, including Repository polish and Benchmark integrity, and do not treat them as candidate-authored evidence or regressions. Do not create or modify those artifacts, and do not add repository-side progress generators, validators, tests, or workflows.";
const MEASURED_ARTIFACT_PROVENANCE = "Treat checked-in benchmark and evaluation artifacts as measured evidence, not ordinary merge blobs. Distinguish evidence claiming to measure the current candidate from explicitly historical records. For current-candidate evidence, apply these rules: If an artifact records a git commit, dirty status, or worktree/import/executable/build path, verify that provenance after integration. Never retain a leaf, sibling, parent, or stale-worktree path in a composite artifact. Regenerate stale evidence with repository-supported tooling from a clean checkout rooted inside the current composite worktree; never hand-edit provenance or fabricate measurements. The measured code commit may precede the artifact-only commit at HEAD only when the intervening diff contains reports/evidence and no implementation or benchmark-harness changes. Historical records instead remain pinned to their original source/build identities and may retain clearly labeled original paths after their worktrees are cleaned up. When the task requests missing setup metadata for historical workloads, an explicitly labeled, newly measured same-code setup rerun at that historical revision is valid if its actual commands, timestamps, cache state, source/build hashes, and links to the original workload artifacts are verified. Preserve the original compute measurements; do not require rerunning unchanged historical workloads solely to supply setup metadata. Never attribute later setup measurements to the original capture, use historical evidence to award current-candidate performance credit, or relabel stale current-candidate evidence as historical to evade a required fresh measurement.";
type CodexCommandOptions = { cwd: string; input?: string; timeoutMs?: number; onStdout?: (chunk: string) => void; onStderr?: (line: string) => void };
export type CompositeIntegrationContext = {
  phase?: "resolve-conflicts" | "integrate";
  description?: string;
  sourceRegressions?: {
    source: string;
    commit: string;
    evaluation: string;
    before: number;
    after: number;
    summary: string;
    evidence: string[];
    suggestions: string[];
  }[];
};

function modelArgs(model: string): string[] {
  return ["--model", model.trim() || DEFAULT_CODEX_MODEL, "-c", `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`];
}

const evaluationSchema = {
  type: "object",
  properties: {
    score: { type: "number", minimum: 0, maximum: 100 },
    summary: { type: "string", maxLength: 1_000 },
    evidence: { type: "array", items: { type: "string", maxLength: 1_500 }, maxItems: 8 },
    suggestions: { type: "array", items: { type: "string", maxLength: 750 }, maxItems: 6 },
  },
  required: ["score", "summary", "evidence", "suggestions"],
  additionalProperties: false,
};

const ideasSchema = {
  type: "object",
  properties: {
    ideas: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          rationale: { type: "string" },
          predictedImpact: { type: "number", minimum: 0, maximum: 100 },
          lane: { type: "string", enum: ["incremental", "foundational"] },
          milestone: { type: "string" },
          milestoneCredit: { type: "number", minimum: 0, maximum: 100 },
          evaluationIds: { type: "array", items: { type: "string" } },
          resources: { type: "array", items: { type: "string" } },
        },
        required: ["title", "description", "rationale", "predictedImpact", "lane", "milestone", "milestoneCredit", "evaluationIds", "resources"],
        additionalProperties: false,
      },
    },
  },
  required: ["ideas"],
  additionalProperties: false,
};

const reviewSchema = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    summary: { type: "string" },
    findings: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          title: { type: "string" },
          detail: { type: "string" },
          file: { type: "string" },
        },
        required: ["severity", "title", "detail", "file"],
        additionalProperties: false,
      },
    },
  },
  required: ["approved", "summary", "findings"],
  additionalProperties: false,
};

type EvaluationOutput = { score: number; summary: string; evidence: string[]; suggestions: string[] };
export type PlannedIdea = Omit<Idea, "id" | "status" | "createdAt" | "updatedAt" | "source" | "agentRunId" | "lane" | "milestone" | "milestoneCredit"> &
  Required<Pick<Idea, "lane" | "milestone" | "milestoneCredit">>;
export type SessionResult = { message: string; threadId: string };
export type ReviewResult = { approved: boolean; summary: string; findings: ReviewFinding[] };

function commandFailure(result: CommandResult, fallback: string): string {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  const raw = stderr && stdout ? `${stderr}\n${stdout}` : stderr || stdout || fallback;
  if (result.exitCode === 124) return raw.split("\n").reverse().find((line) => /timed out/i.test(line)) ?? fallback;
  return raw.length > 8_000 ? `…[truncated]\n${truncateText(raw, 8_000, true)}` : truncateText(raw, 8_000);
}

function isInconclusiveCommandOutput(output: EvaluationOutput): boolean {
  if (output.score !== 0 || !/\b(?:benchmark rejected|no timing score was accepted|invalid measurement)\b/i.test(output.summary)) return false;
  if (!output.evidence.length) return true;
  return output.evidence.some((item) => /\b(?:unstable timing|primary timing saturated|every case reached (?:the )?parity cap|timing .{0,80}(?:spread|variance|noise)|timed? out|failed to launch|could not execute|no such file|permission denied|checksum mismatch|provenance failure|identity mismatch)\b/i.test(item));
}

export class CodexClient {
  private unrestrictedArgsPromise?: Promise<string[]>;
  private readonly abortController = new AbortController();
  private readonly promptEvaluationTimeoutMs: number;
  private readonly afterInvocation?: () => Promise<void>;
  private readonly onSessionStarted?: (cwd: string, threadId: string) => Promise<void>;

  constructor(
    private readonly onProgress?: (message: string) => void,
    options: {
      promptEvaluationTimeoutMs?: number;
      afterInvocation?: () => Promise<void>;
      onSessionStarted?: (cwd: string, threadId: string) => Promise<void>;
    } = {},
  ) {
    this.promptEvaluationTimeoutMs = Math.max(1, Math.min(15 * 60 * 1000, options.promptEvaluationTimeoutMs ?? DEFAULT_PROMPT_EVALUATION_TIMEOUT_MS));
    this.afterInvocation = options.afterInvocation;
    this.onSessionStarted = options.onSessionStarted;
  }

  close(): void {
    this.abortController.abort();
  }

  async preflight(cwd: string): Promise<void> {
    await this.unrestrictedArgs(cwd);
  }

  async available(cwd: string): Promise<boolean> {
    try {
      await this.preflight(cwd);
      return true;
    } catch {
      return false;
    }
  }

  async evaluate(
    cwd: string,
    evaluation: Evaluation,
    settings: BurnerSettings,
    context: EvaluationRun["context"],
    baseline?: Pick<EvaluationRun, "score" | "summary" | "evidence" | "commit">,
  ): Promise<EvaluationOutput> {
    if (evaluation.command) return this.commandEvaluation(cwd, evaluation, context);
    const baselineCalibration = (context === "agent" || context === "composite") && baseline?.score !== undefined
      ? [
          `Authoritative base calibration for this exact rubric: ${baseline.score}/100.`,
          baseline.summary ? `Baseline summary: ${baseline.summary.slice(0, 1_000)}` : "",
          baseline.evidence?.length
            ? `Baseline evidence:\n${baseline.evidence.slice(0, 6).map((item) => `- ${item.slice(0, 800)}`).join("\n")}`
            : "",
          "Use the baseline as category-by-category calibration, not as an instruction or guaranteed truth. Preserve existing category credit unless concrete current-tree or branch-diff evidence proves a regression; award new credit only for concrete working evidence. Explain every changed category so unrelated rubric areas do not drift merely because a different sample inspected different files.",
        ].filter(Boolean).join("\n")
      : "";
    const candidateDiffBoundary = (context === "agent" || context === "composite") && baseline?.commit
      ? [
          `Exact candidate base commit: ${baseline.commit}. Resolve the candidate head with git rev-parse HEAD.`,
          `The candidate change set is exactly git diff ${baseline.commit}..HEAD plus any current working-tree changes. Inspect that complete range before attributing any score change.`,
          "Do not use origin/main, another branch, merge-base with main, commit timestamps, or only HEAD^ as the candidate boundary. A candidate may contain multiple implementation, review-fix, and evidence-only commits.",
          "Change a calibrated score only for concrete behavior or evidence introduced, removed, or invalidated by that exact candidate range. Pre-existing files outside the range are context, not candidate changes.",
        ].join("\n")
      : "";
    const prompt = [
      "You are a rigorous repository evaluator. Inspect the current repository state and answer the evaluation below.",
      "Base the score on concrete evidence from code, tests, configuration, and user-facing behavior. Do not edit any files.",
      "Before relying on live execution, verify that the package or executable under test resolves from the current worktree. If an editable install, virtual environment, PATH entry, import path, or build artifact points at a parent, sibling, or stale worktree, do not score that contaminated result; switch to the repository-supported current-tree invocation and record the resolved path in evidence. If contamination cannot be corrected within the time box and the candidate did not introduce it, treat the run as inconclusive evidence and preserve the applicable baseline calibration rather than inventing a candidate regression.",
      "Finish this evaluation within 3 minutes. Inspect targeted, representative evidence for every rubric category; do not exhaustively read every file or narrate intermediate progress.",
      "Use no more than 12 shell commands. Reserve enough time to return the required structured result; concise evidence is preferred over exhaustive evidence.",
      "A score of 100 means genuinely exceptional and production-ready. Be calibrated, concise, and actionable.",
      context === "agent" || context === "composite"
        ? `${PROGRESS_OWNERSHIP} This candidate is not merged yet, so do not reduce its score because it lacks a history point for the current PR. Assess only previously merged history; Burner will add the current point atomically after every final score is available.`
        : "This is a baseline evaluation; assess the progress artifacts currently committed in the repository.",
      `Evaluation: ${evaluation.name}`,
      evaluation.prompt,
      baselineCalibration,
      candidateDiffBoundary,
      `Context: ${context === "agent" || context === "composite" ? "This is a candidate branch; assess only its current state." : "This is the current project baseline."}`,
    ].filter(Boolean).join("\n\n");
    const output = await this.structured<EvaluationOutput>(cwd, prompt, evaluationSchema, settings.evaluatorModel, this.promptEvaluationTimeoutMs);
    return this.normalizeEvaluation(output);
  }

  private async commandEvaluation(cwd: string, evaluation: Evaluation, context: EvaluationRun["context"]): Promise<EvaluationOutput> {
    const command = context === "agent" || context === "screening_baseline"
      ? evaluation.screeningCommand ?? evaluation.command
      : evaluation.command;
    if (!command) throw new Error(`Evaluation '${evaluation.name}' has no command for ${context}.`);
    const result = await runCommand("/bin/sh", ["-lc", command], {
      cwd,
      env: { BURNER_EVALUATION_CONTEXT: context, BURNER_EVALUATION_NAME: evaluation.name },
      timeoutMs: 60 * 60 * 1000,
      signal: this.abortController.signal,
      onStderr: (line) => this.onProgress?.(line),
    });
    if (result.exitCode !== 0) throw new Error(commandFailure(result, `Evaluation command exited with ${result.exitCode}`));
    const output = this.normalizeEvaluation(parseJsonObject<EvaluationOutput>(result.stdout));
    if (isInconclusiveCommandOutput(output)) {
      const detail = output.evidence[0] ? ` ${output.evidence[0]}` : "";
      throw new Error(`Evaluation command reported an inconclusive measurement: ${output.summary}.${detail}`.slice(0, 2_000));
    }
    return output;
  }

  private normalizeEvaluation(output: EvaluationOutput): EvaluationOutput {
    if (!Number.isFinite(Number(output.score)) || typeof output.summary !== "string" || !Array.isArray(output.evidence) || !Array.isArray(output.suggestions)) {
      throw new Error("Evaluation output must contain score, summary, evidence, and suggestions.");
    }
    return {
      score: clampScore(output.score),
      summary: truncateText(output.summary.trim(), 1_000),
      evidence: output.evidence.map((item) => truncateText(String(item), 1_500)).slice(0, 8),
      suggestions: output.suggestions.map((item) => truncateText(String(item), 750)).slice(0, 6),
    };
  }

  async planIdeas(
    cwd: string,
    evaluations: Evaluation[],
    latest: Map<string, EvaluationRun>,
    existingIdeas: Idea[],
    settings: BurnerSettings,
    foundationalDeliveryPending = false,
  ): Promise<PlannedIdea[]> {
    const cadenceMinutes = Math.max(5, settings.mergeCadenceMinutes ?? 60);
    const implementationBudgetMinutes = Math.max(5, Math.floor(cadenceMinutes / 4));
    const enabledEvaluations = evaluations.filter((evaluation) => evaluation.enabled);
    const totalWeight = enabledEvaluations.reduce((total, evaluation) => total + evaluation.weight, 0);
    const evaluationContext = enabledEvaluations.map((evaluation) => {
      const run = latest.get(evaluation.id);
      const score = run?.score;
      return {
        id: evaluation.id,
        name: evaluation.name,
        weight: evaluation.weight,
        maximumCompositeGain: score === undefined || totalWeight === 0
          ? undefined
          : Math.round((100 - score) * evaluation.weight / totalWeight * 10) / 10,
        prompt: evaluation.prompt,
        kind: evaluation.command ? "command" : "prompt",
        score,
        summary: run?.summary,
        evidence: run?.evidence,
        suggestions: run?.suggestions,
      };
    });
    const foundationalLaneOccupied = foundationalDeliveryPending || existingIdeas.some((idea) =>
      idea.lane === "foundational" && (idea.status === "queued" || idea.status === "running"));
    const foundationalTarget = foundationalLaneOccupied
      ? undefined
      : evaluationContext
        .filter((evaluation) => evaluation.score !== undefined && Number.isFinite(evaluation.score) && evaluation.score >= 0 && evaluation.score < 100)
        // Rank the actual weighted gap, not its rounded presentation value.
        .sort((a, b) => (100 - (b.score ?? 100)) * b.weight - (100 - (a.score ?? 100)) * a.weight)[0];
    const foundationalDirective = foundationalTarget
      ? `The foundational lane is open. Reserve exactly one proposal for evaluation '${foundationalTarget.id}' (${foundationalTarget.name}), the measured evaluation with the largest weighted headroom (current score ${foundationalTarget.score}/100; approximately ${foundationalTarget.maximumCompositeGain} composite points available). Continue the milestone sequence through partial progress; a nonzero score does not close this lane. That proposal must target '${foundationalTarget.id}', use lane='foundational', and state one concrete verifiable milestone.`
      : foundationalLaneOccupied
        ? "The foundational lane is already occupied by unfinished work. Do not propose another foundational idea in this planning pass; mark every proposal lane='incremental'."
        : "No enabled evaluation currently has a measured, valid score below 100. Do not reserve the foundational lane in this planning pass; mark every proposal lane='incremental'.";
    const prompt = [
      "You are Burner's improvement planner. Inspect this repository and propose a small set of concrete, independent changes that coding agents can implement on separate branches.",
      "Optimize the evaluation scores below. Prefer high-leverage, reviewable changes over broad rewrites. Do not duplicate existing ideas. Do not edit files.",
      `Burner targets a qualifying merge every ${cadenceMinutes} minutes with ${settings.parallelism} parallel agent slot${settings.parallelism === 1 ? "" : "s"}. Each idea must be small enough for one author to implement, test, undergo repeated independent review, revise, and candidate-evaluate in about ${implementationBudgetMinutes} minutes.`,
      "This is a hard scope constraint: each idea must deliver one narrow, coherent capability with at most three concrete acceptance outcomes. Decompose foundations into independently useful increments. Never propose an umbrella task such as building an entire engine, service, UI, persistence layer, or end-to-end product in one branch.",
      "Keep command-backed scoring independent from implementation work. If a missing corpus case or evaluator capability is needed, propose that evaluator-only change as its own idea first, with the unsupported implementation receiving zero credit; propose the implementation separately only after the fixed denominator exists. Never combine evaluator/corpus changes and the implementation they score in one idea.",
      "Use two scheduling lanes. Incremental ideas pursue immediate measured gains. The foundational lane crosses sparse-reward gaps as a sequence of independently useful, tested milestones; it is not permission to propose an end-to-end rewrite.",
      foundationalDirective,
      "milestoneCredit is internal 0-100 scheduling priority for prerequisite value. It never changes measured evaluation scores. Use it only for foundational ideas; incremental ideas must use an empty milestone and milestoneCredit=0.",
      `${PROGRESS_OWNERSHIP} Do not propose duplicate progress infrastructure; the first successful product merge creates the artifacts automatically.`,
      "Treat failed or quarantined existing ideas as evidence that their scope was too large or risky. Replace them only with strictly smaller, non-overlapping increments; do not rephrase and resubmit the same scope.",
      "predictedImpact is the expected immediate measured 0-100 impact. Evaluation weight and maximumCompositeGain show aggregate leverage. evaluationIds must use only IDs supplied below.",
      "resources lists shared scarce resources only when required (examples: gpu, cpu-heavy, device-ios). Use an empty list for normal work. Ideas sharing a resource will not run concurrently.",
      `Evaluations:\n${JSON.stringify(evaluationContext, null, 2)}`,
      `Existing ideas:\n${JSON.stringify(existingIdeas.slice(-30).map(({ title, description, status, lane, milestone, evaluationIds }) => ({ title, description, status, lane, milestone, evaluationIds })), null, 2)}`,
    ].join("\n\n");
    const output = await this.structured<{ ideas: PlannedIdea[] }>(cwd, prompt, ideasSchema, settings.evaluatorModel);
    const validIds = new Set(enabledEvaluations.map((evaluation) => evaluation.id));
    const foundationalIndex = foundationalTarget
      ? output.ideas.findIndex((idea) => idea.evaluationIds.includes(foundationalTarget.id) && idea.lane === "foundational")
      : -1;
    const promotedFoundationalIndex = foundationalIndex >= 0 || !foundationalTarget
      ? foundationalIndex
      : output.ideas.findIndex((idea) => idea.evaluationIds.includes(foundationalTarget.id));
    return output.ideas.map((idea, index) => {
      const foundational = index === promotedFoundationalIndex;
      return {
        title: String(idea.title).trim().slice(0, 120),
        description: String(idea.description).trim(),
        rationale: String(idea.rationale).trim(),
        predictedImpact: clampScore(Number(idea.predictedImpact)),
        lane: foundational ? "foundational" as const : "incremental" as const,
        milestone: foundational
          ? truncateText(String(idea.milestone).trim() || String(idea.description).trim(), 1_000)
          : "",
        milestoneCredit: foundational ? clampScore(Number(idea.milestoneCredit)) : 0,
        evaluationIds: [...new Set(idea.evaluationIds.filter((value) => validIds.has(value)))],
        resources: [...new Set(idea.resources.map((value) => String(value).toLowerCase().replace(/[^a-z0-9._-]/g, "-")).filter(Boolean))],
      };
    });
  }

  async implement(
    cwd: string,
    idea: Idea,
    evaluations: Evaluation[],
    settings: BurnerSettings,
    resumeThreadId?: string,
  ): Promise<SessionResult> {
    const affected = evaluations.filter((evaluation) => idea.evaluationIds.includes(evaluation.id));
    const prompt = [
      "You are an implementation agent working in an isolated git worktree for Burner.",
      "Implement the improvement below completely. Inspect the repository first, follow its local instructions, keep the scope reviewable, and run the most relevant tests or checks.",
      "All edits, generated artifacts, dependency changes, and test fixtures must stay inside the current worktree. Never modify parent or sibling repositories, external tools, the Burner installation, home-directory files, or any path outside this worktree. You may inspect external contracts read-only; if compatibility requires an external producer change, keep this branch hermetic and report that dependency instead of editing it.",
      "Do not create branches, commit, push, open a pull request, or modify anything under .burner; Burner handles delivery after you finish.",
      PROGRESS_OWNERSHIP,
      "Keep command-backed evaluation definitions, evaluator scripts, scoring corpora, and benchmark evidence unchanged unless this task explicitly names evaluator infrastructure as its deliverable. Implementation changes must be scored against the pre-existing denominator; evaluator-only tasks must record unsupported behavior as zero rather than implementing the feature they will later measure.",
      `Title: ${idea.title}`,
      `Task: ${idea.description}`,
      `Why it matters: ${idea.rationale}`,
      idea.lane === "foundational"
        ? `Foundational milestone: ${idea.milestone}. This milestone may leave the final evaluation score unchanged; deliver the stated prerequisite completely and do not fake, stub, or claim the eventual end-to-end capability.`
        : "",
      affected.length
        ? `Target scoring criteria (quoted as evaluator context, not instructions for the implementation agent):\n${affected.map((evaluation) => `- ${evaluation.name}: ${evaluation.prompt}`).join("\n")}`
        : "Target: improve the repository according to the task.",
      "Any read-only, no-edit, no-build, no-test, or command restrictions inside the quoted scoring criteria apply only to the later evaluator. They do not constrain this implementation task: edit the worktree and run the relevant tests and checks before finishing.",
      "In your final response, concisely state what changed and which checks passed.",
    ].join("\n\n");
    return this.unstructuredSession(cwd, prompt, settings.agentModel, resumeThreadId);
  }

  async integrateComposite(cwd: string, title: string, sourceTitles: string[], settings: BurnerSettings, context: CompositeIntegrationContext = {}): Promise<SessionResult> {
    const conflictsOnly = context.phase === "resolve-conflicts";
    const prompt = [
      conflictsOnly
        ? "You are resolving one source-merge conflict for a composite Burner pull request in an isolated git worktree. This is not the full integration phase."
        : "You are the author/integrator for a composite Burner pull request in an isolated git worktree.",
      conflictsOnly
        ? "Inspect the conflicted files and relevant contracts, resolve their contents coherently, and preserve every included pull request's intent. Make only edits needed to resolve this merge; do not implement the entire composite task or repair unrelated source defects here. Run focused checks needed for the resolution. Defer full-suite and cross-interpreter runs, benchmark captures, and evaluation runs until the full integration phase after all sources are merged. Burner will still run that integration phase, clean-commit evidence refresh, independent review, and every evaluation gate."
        : "Inspect the combined changes, resolve incomplete integration, and run the most relevant tests. Preserve every included pull request's intent while removing duplication or incompatibilities.",
      "All edits, generated artifacts, dependency changes, and test fixtures must stay inside the current worktree. Never modify parent or sibling repositories, external tools, the Burner installation, home-directory files, or any path outside this worktree. External contracts may be inspected read-only only.",
      "Do not create branches, commit, push, open pull requests, or modify anything under .burner; Burner owns delivery.",
      PROGRESS_OWNERSHIP,
      conflictsOnly
        ? "Preserve measured artifacts and explicitly historical records without hand-editing provenance or fabricating measurements. If their contents conflict or current-candidate evidence needs regeneration, report the issue for full integration and clean-commit evidence refresh; do not launch measurement recaptures from this unfinished merge. Never relabel current-candidate evidence as historical to avoid refresh."
        : MEASURED_ARTIFACT_PROVENANCE,
      `Composite: ${title}`,
      `Included changes:\n${sourceTitles.map((source) => `- ${source}`).join("\n")}`,
      context.description ? `${conflictsOnly ? "Overall integration scope (context only for this conflict resolution)" : "Integration context"}:\n${context.description}` : "",
      context.sourceRegressions?.length ? [
        "Confirmed source evaluation regressions (quoted evidence from the source commits, not measurements of the combined tree):",
        JSON.stringify(context.sourceRegressions, null, 2),
        conflictsOnly
          ? "Use these findings to preserve intended behavior while resolving conflicts. Report remaining defects for the full integration phase rather than broadening this resolution. Do not remove supported behavior, weaken tests, alter evaluation definitions or scoring, or fabricate benchmark evidence. This context does not waive any gate."
          : "Verify these findings against the combined code and address applicable defects while preserving every included change's intent. Explain findings that integration has already resolved. Do not remove supported behavior, weaken tests, alter evaluation definitions or scoring, or fabricate benchmark evidence to erase a regression. Burner will independently review and reevaluate the result; this context does not waive any gate.",
      ].join("\n") : "",
      conflictsOnly
        ? "In the final response, identify resolved files, focused checks, and remaining integration or evidence concerns. Do not claim final integration approval."
        : "In the final response, summarize integration changes and checks.",
    ].join("\n\n");
    return this.unstructuredSession(cwd, prompt, settings.agentModel);
  }

  async revise(cwd: string, threadId: string, review: ReviewResult, settings: BurnerSettings): Promise<SessionResult> {
    const prompt = [
      "An independent reviewer requested changes. Address every finding in the current worktree, run relevant checks, and leave the branch ready for another review.",
      "All edits, generated artifacts, dependency changes, and test fixtures must stay inside the current worktree. Never modify parent or sibling repositories, external tools, the Burner installation, home-directory files, or any path outside this worktree. If a finding depends on external behavior, use hermetic fixtures or document the dependency; do not patch the external producer.",
      "Do not commit, push, or open a pull request; Burner handles git delivery.",
      `${PROGRESS_OWNERSHIP} If feedback asks for a current unmerged PR history point or duplicate progress infrastructure, do not implement that invalid request; explain that Burner stamps the point after final evaluation instead.`,
      MEASURED_ARTIFACT_PROVENANCE,
      `Review summary: ${review.summary}`,
      `Findings:\n${review.findings.map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.title}${finding.file ? ` (${finding.file})` : ""}: ${finding.detail}`).join("\n")}`,
      "If a finding is invalid, verify that carefully and explain it, but make all justified fixes.",
    ].join("\n\n");
    return this.unstructuredSession(cwd, prompt, settings.agentModel, threadId);
  }

  async refreshCompositeEvidence(cwd: string, baseBranch: string, title: string, threadId: string, implementationCommit: string, settings: BurnerSettings, taskScope?: string): Promise<SessionResult> {
    return this.refreshEvidence(cwd, baseBranch, title, threadId, implementationCommit, settings, "composite", taskScope);
  }

  async refreshAgentEvidence(cwd: string, baseBranch: string, title: string, threadId: string, implementationCommit: string, settings: BurnerSettings, taskScope?: string): Promise<SessionResult> {
    return this.refreshEvidence(cwd, baseBranch, title, threadId, implementationCommit, settings, "candidate", taskScope);
  }

  private async refreshEvidence(cwd: string, baseBranch: string, title: string, threadId: string, implementationCommit: string, settings: BurnerSettings, kind: "composite" | "candidate", taskScope?: string): Promise<SessionResult> {
    const prompt = [
      `Perform the post-commit evidence step for this ${kind}. Burner has now committed the implementation, so final measurements can use a clean code commit before independent review.`,
      `Change: ${title}`,
      `Base branch: ${baseBranch}. Clean implementation commit: ${implementationCommit}.`,
      taskScope ? `Original task scope (requirements, not proof of completion):\n${taskScope}` : "",
      "Inspect the original task requirements and the complete candidate diff against the base. Refresh measured artifacts introduced or changed by this candidate that claim to describe its final implementation and are now stale. Generate and preserve any new measured artifacts explicitly required by the task, including captures deferred until the implementation was committed, even when no report has been checked in yet. Development-only runs from dirty or uncommitted sources do not satisfy required clean-commit captures. If neither stale current-candidate artifacts nor outstanding task-required captures exist, make no changes and report that briefly. Do not invent additional measurement requirements. Preserve historical baseline measurements and unrelated artifacts unchanged.",
      MEASURED_ARTIFACT_PROVENANCE,
      "Use existing repository-supported build and measurement tooling from the committed implementation. Keep the established workload matrix, reference, denominator, unsupported outcomes, and slow results. Changes in this step must be limited to new or regenerated evidence and its accompanying documentation. Do not change implementation, dependencies, tests, benchmark harnesses, evaluation definitions, scoring, or supported behavior. If those changes are required, leave the evidence untouched and report the blocker for independent review instead of manufacturing a passing report.",
      "All generated files and edits must stay inside this worktree. Never modify parent or sibling repositories, external tools, the Burner installation, home-directory files, or paths outside this worktree. Do not commit, push, create branches, or open pull requests; Burner owns delivery.",
      PROGRESS_OWNERSHIP,
      "This step does not approve the branch or replace any independent review, tests, evaluations, or merge gates. Do not rerun unrelated full test suites just to repeat validation already completed by the author; run the checks needed to validate the regenerated evidence.",
      "Finish within 30 minutes. Summarize artifacts regenerated, their measured commit and checks, or any remaining blocker.",
    ].join("\n\n");
    return this.unstructuredSession(cwd, prompt, settings.agentModel, threadId, 30 * 60 * 1000);
  }

  async review(cwd: string, baseBranch: string, title: string, settings: BurnerSettings): Promise<ReviewResult> {
    const prompt = [
      "Act as an independent, rigorous reviewer. Review the complete branch diff against the base branch.",
      "Approve only when there are no material correctness, security, regression, race, lifecycle, or missing-test issues that should block merge.",
      "Perform a comprehensive blocker pass now: inspect every changed subsystem against correctness boundaries, resource limits, public contracts, and tests, and report all material findings you can substantiate in this response. Do not deliberately defer a risk category to a later round.",
      "Findings must be merge blockers caused by or exposed by this change, not optional hardening or unrelated feature requests. On later rounds, verify prior fixes and the complete current diff without inventing new scope.",
      "Do not edit files. Keep findings concrete and actionable. Approval must be false whenever any finding requires an author change.",
      `${PROGRESS_OWNERSHIP} Treat candidate-authored duplicate progress infrastructure or mutations to these artifacts as a merge blocker. Do not require a history point for the current unmerged PR.`,
      `${MEASURED_ARTIFACT_PROVENANCE} Treat stale or contaminated measured-artifact provenance as a merge blocker.`,
      `Change under review: ${title}`,
      `Base branch: ${baseBranch}. Inspect the complete diff from this base to HEAD before deciding.`,
    ].join("\n\n");
    const result = await this.reviewStructured<ReviewResult>(cwd, baseBranch, prompt, reviewSchema, settings.agentModel);
    return {
      approved: Boolean(result.approved),
      summary: String(result.summary).trim(),
      findings: result.findings.map((finding) => ({ severity: finding.severity, title: String(finding.title).trim(), detail: String(finding.detail).trim(), file: String(finding.file).trim() })),
    };
  }

  private async structured<T>(
    cwd: string,
    prompt: string,
    schema: object,
    model: string,
    timeoutMs = 15 * 60 * 1000,
  ): Promise<T> {
    const tempDir = await mkdtemp(join(tmpdir(), "burner-codex-"));
    const schemaPath = join(tempDir, "schema.json");
    const outputPath = join(tempDir, "output.json");
    try {
      await writeFile(schemaPath, JSON.stringify(schema), "utf8");
      const args = this.args(cwd, model);
      args.push("--output-schema", schemaPath, "--output-last-message", outputPath, "-");
      let result = await this.runCodex(args, {
        cwd,
        input: prompt,
        timeoutMs,
        onStderr: (line) => this.onProgress?.(line),
      });
      if (result.exitCode !== 0 && result.exitCode !== 124) {
        await rm(outputPath, { force: true });
        const fallbackArgs = this.args(cwd, model);
        fallbackArgs.push("--output-last-message", outputPath, "-");
        result = await this.runCodex(fallbackArgs, {
          cwd,
          input: this.schemaFallbackPrompt(prompt, schema),
          timeoutMs,
          onStderr: (line) => this.onProgress?.(line),
        });
      }
      if (result.exitCode !== 0) throw new Error(commandFailure(result, `codex exec exited with ${result.exitCode}`));
      const raw = await readFile(outputPath, "utf8").catch(() => result.stdout);
      return parseJsonObject<T>(raw);
    } catch (error) {
      throw new Error(`Codex run failed: ${errorMessage(error)}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async reviewStructured<T extends ReviewResult>(cwd: string, baseBranch: string, prompt: string, schema: object, model: string): Promise<T> {
    const tempDir = await mkdtemp(join(tmpdir(), "burner-review-"));
    const schemaPath = join(tempDir, "schema.json");
    const outputPath = join(tempDir, "output.json");
    try {
      await writeFile(schemaPath, JSON.stringify(schema), "utf8");
      const args = this.args(cwd, model);
      args.push("--output-schema", schemaPath, "--output-last-message", outputPath, "-");
      let result = await this.runCodex(args, {
        cwd,
        input: prompt,
        timeoutMs: 60 * 60 * 1000,
        onStderr: (line) => this.onProgress?.(line),
      });
      if (result.exitCode !== 0 && result.exitCode !== 124) {
        await rm(outputPath, { force: true });
        const fallbackArgs = this.args(cwd, model);
        fallbackArgs.push("--output-last-message", outputPath, "-");
        result = await this.runCodex(fallbackArgs, {
          cwd,
          input: this.schemaFallbackPrompt(prompt, schema),
          timeoutMs: 60 * 60 * 1000,
          onStderr: (line) => this.onProgress?.(line),
        });
      }
      if (result.exitCode !== 0) throw new Error(commandFailure(result, `codex reviewer exited with ${result.exitCode}`));
      return parseJsonObject<T>(await readFile(outputPath, "utf8").catch(() => result.stdout));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async unstructuredSession(
    cwd: string,
    prompt: string,
    model: string,
    resumeThreadId?: string,
    timeoutMs = 2 * 60 * 60 * 1000,
  ): Promise<SessionResult> {
    const tempDir = await mkdtemp(join(tmpdir(), "burner-agent-"));
    const outputPath = join(tempDir, "output.md");
    let threadId: string | undefined;
    let pendingLine = "";
    let checkpoint = Promise.resolve();
    let checkpointFailed = false;
    let checkpointError: unknown;
    const rememberThread = (value: unknown) => {
      if (threadId || typeof value !== "string" || !value.trim()) return;
      threadId = value;
      // Attach the rejection handler immediately: persistence happens while
      // Codex is still running, not only after a successful process exit.
      checkpoint = Promise.resolve().then(() => this.onSessionStarted?.(cwd, value)).catch((error) => {
        checkpointFailed = true;
        checkpointError = error;
      });
    };
    const consumeStdout = (chunk: string) => {
      if (threadId) return;
      pendingLine += chunk;
      let newline: number;
      while (!threadId && (newline = pendingLine.indexOf("\n")) !== -1) {
        const line = pendingLine.slice(0, newline);
        pendingLine = pendingLine.slice(newline + 1);
        try {
          const event = JSON.parse(line) as { type?: string; thread_id?: unknown } | null;
          if (event?.type === "thread.started") rememberThread(event.thread_id);
        } catch { /* Ignore non-JSON CLI diagnostics and unrelated events. */ }
      }
      if (threadId) pendingLine = "";
    };
    try {
      const args = resumeThreadId
        ? ["exec", "resume", "--json"]
        : ["exec", "--json", "--color", "never", "-C", cwd];
      args.push(...modelArgs(model));
      args.push("--output-last-message", outputPath);
      if (resumeThreadId) args.push(resumeThreadId);
      args.push("-");
      const result = await this.runCodex(args, {
        cwd,
        input: prompt,
        timeoutMs,
        onStdout: consumeStdout,
        onStderr: (line) => this.onProgress?.(line),
      });
      consumeStdout("\n");
      if (!threadId) {
        // Also support command adapters that return buffered output without
        // streaming it, and resumed sessions that omit thread.started.
        pendingLine = "";
        consumeStdout(result.stdout + "\n");
        rememberThread(resumeThreadId);
      }
      await checkpoint;
      if (checkpointFailed) throw new Error(`Could not persist Codex author checkpoint: ${errorMessage(checkpointError)}`);
      if (result.exitCode !== 0) throw new Error(commandFailure(result, `codex exec exited with ${result.exitCode}`));
      if (!threadId) throw new Error("Codex did not return a resumable author thread id.");
      return { message: (await readFile(outputPath, "utf8").catch(() => result.stdout)).trim(), threadId };
    } finally {
      // A command or parent-worktree guard can throw after emitting the event.
      // Do not let the failure race the durable checkpoint write.
      await checkpoint;
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private args(cwd: string, model: string): string[] {
    const args = [
      "exec",
      "--ephemeral",
      "--color",
      "never",
      "-C",
      cwd,
    ];
    args.push(...modelArgs(model));
    return args;
  }

  private async unrestrictedArgs(cwd: string): Promise<string[]> {
    this.unrestrictedArgsPromise ??= this.detectUnrestrictedArgs(cwd);
    return this.unrestrictedArgsPromise;
  }

  private async detectUnrestrictedArgs(cwd: string): Promise<string[]> {
    const candidates = [[UNRESTRICTED_FLAG], [META_DISABLE_SANDBOX_FLAG, UNRESTRICTED_FLAG]];
    const failures: string[] = [];
    for (const flags of candidates) {
      try {
        const result = await runCommand("codex", [...flags, "exec", "--help"], { cwd, timeoutMs: 10_000, signal: this.abortController.signal });
        const help = `${result.stdout}\n${result.stderr}`;
        if (result.exitCode === 0 && help.includes(UNRESTRICTED_FLAG)) return flags;
        failures.push(help.trim() || `codex exited with ${result.exitCode}`);
      } catch (error) {
        failures.push(errorMessage(error));
      }
    }
    throw new Error(this.preflightError(failures.at(-1) ?? "Codex preflight failed."));
  }

  private async runCodex(args: string[], options: CodexCommandOptions): Promise<CommandResult> {
    const unrestrictedArgs = await this.unrestrictedArgs(options.cwd);
    const automationArgs = args[0] === "exec"
      ? [args[0], ...AUTOMATION_HOOK_ARGS, ...args.slice(1)]
      : args;
    const result = await runCommand("codex", [...unrestrictedArgs, ...automationArgs], { ...options, signal: this.abortController.signal });
    await this.afterInvocation?.();
    return result;
  }

  private preflightError(detail: string): string {
    return `Burner requires Codex unrestricted mode (${UNRESTRICTED_FLAG}), but the installed Codex CLI did not accept it. Upgrade Codex; Burner will not fall back to restricted mode.${detail ? ` Details: ${detail}` : ""}`;
  }

  private schemaFallbackPrompt(prompt: string, schema: object): string {
    return `${prompt}\n\nReturn only one JSON object matching this JSON Schema exactly. Do not use Markdown fences or add commentary.\n${JSON.stringify(schema)}`;
  }
}
