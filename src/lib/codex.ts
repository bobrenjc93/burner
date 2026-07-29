import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BurnerSettings, Evaluation, EvaluationRun, Idea, ReviewFinding } from "../types.js";
import { runCommand } from "./process.js";
import { clampScore, errorMessage, parseJsonObject } from "./utils.js";

const evaluationSchema = {
  type: "object",
  properties: {
    score: { type: "number", minimum: 0, maximum: 100 },
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "string" }, maxItems: 8 },
    suggestions: { type: "array", items: { type: "string" }, maxItems: 6 },
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
          evaluationIds: { type: "array", items: { type: "string" } },
          resources: { type: "array", items: { type: "string" } },
        },
        required: ["title", "description", "rationale", "predictedImpact", "evaluationIds", "resources"],
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
export type PlannedIdea = Omit<Idea, "id" | "status" | "createdAt" | "updatedAt" | "source" | "agentRunId">;
export type SessionResult = { message: string; threadId: string };
export type ReviewResult = { approved: boolean; summary: string; findings: ReviewFinding[] };

export class CodexClient {
  constructor(private readonly onProgress?: (message: string) => void) {}

  async evaluate(
    cwd: string,
    evaluation: Evaluation,
    settings: BurnerSettings,
    context: EvaluationRun["context"],
  ): Promise<EvaluationOutput> {
    const prompt = [
      "You are a rigorous repository evaluator. Inspect the current repository state and answer the evaluation below.",
      "Base the score on concrete evidence from code, tests, configuration, and user-facing behavior. Do not edit any files.",
      "A score of 100 means genuinely exceptional and production-ready. Be calibrated, concise, and actionable.",
      `Evaluation: ${evaluation.name}`,
      evaluation.prompt,
      `Context: ${context === "agent" || context === "composite" ? "This is a candidate branch; assess only its current state." : "This is the current project baseline."}`,
    ].join("\n\n");
    const output = await this.structured<EvaluationOutput>(cwd, prompt, evaluationSchema, settings.evaluatorModel, "read-only");
    return {
      score: clampScore(output.score),
      summary: output.summary.trim(),
      evidence: output.evidence.map(String).slice(0, 8),
      suggestions: output.suggestions.map(String).slice(0, 6),
    };
  }

  async planIdeas(
    cwd: string,
    evaluations: Evaluation[],
    latest: Map<string, EvaluationRun>,
    existingIdeas: Idea[],
    settings: BurnerSettings,
  ): Promise<PlannedIdea[]> {
    const evaluationContext = evaluations.map((evaluation) => {
      const run = latest.get(evaluation.id);
      return {
        id: evaluation.id,
        name: evaluation.name,
        prompt: evaluation.prompt,
        score: run?.score,
        summary: run?.summary,
        evidence: run?.evidence,
        suggestions: run?.suggestions,
      };
    });
    const prompt = [
      "You are Burner's improvement planner. Inspect this repository and propose a small set of concrete, independent changes that coding agents can implement on separate branches.",
      "Optimize the evaluation scores below. Prefer high-leverage, reviewable changes over broad rewrites. Do not duplicate existing ideas. Do not edit files.",
      "predictedImpact is an expected 0-100 relative impact used for queue ordering. evaluationIds must use only IDs supplied below.",
      "resources lists shared scarce resources only when required (examples: gpu, cpu-heavy, device-ios). Use an empty list for normal work. Ideas sharing a resource will not run concurrently.",
      `Evaluations:\n${JSON.stringify(evaluationContext, null, 2)}`,
      `Existing ideas:\n${JSON.stringify(existingIdeas.slice(-30).map(({ title, description, status }) => ({ title, description, status })), null, 2)}`,
    ].join("\n\n");
    const output = await this.structured<{ ideas: PlannedIdea[] }>(cwd, prompt, ideasSchema, settings.evaluatorModel, "read-only");
    const validIds = new Set(evaluations.map((evaluation) => evaluation.id));
    return output.ideas.map((idea) => ({
      title: String(idea.title).trim().slice(0, 120),
      description: String(idea.description).trim(),
      rationale: String(idea.rationale).trim(),
      predictedImpact: clampScore(Number(idea.predictedImpact)),
      evaluationIds: [...new Set(idea.evaluationIds.filter((value) => validIds.has(value)))],
      resources: [...new Set(idea.resources.map((value) => String(value).toLowerCase().replace(/[^a-z0-9._-]/g, "-")).filter(Boolean))],
    }));
  }

  async implement(
    cwd: string,
    idea: Idea,
    evaluations: Evaluation[],
    settings: BurnerSettings,
  ): Promise<SessionResult> {
    const affected = evaluations.filter((evaluation) => idea.evaluationIds.includes(evaluation.id));
    const prompt = [
      "You are an implementation agent working in an isolated git worktree for Burner.",
      "Implement the improvement below completely. Inspect the repository first, follow its local instructions, keep the scope reviewable, and run the most relevant tests or checks.",
      "Do not create branches, commit, push, open a pull request, or modify anything under .burner; Burner handles delivery after you finish.",
      `Title: ${idea.title}`,
      `Task: ${idea.description}`,
      `Why it matters: ${idea.rationale}`,
      affected.length
        ? `Target evaluations:\n${affected.map((evaluation) => `- ${evaluation.name}: ${evaluation.prompt}`).join("\n")}`
        : "Target: improve the repository according to the task.",
      "In your final response, concisely state what changed and which checks passed.",
    ].join("\n\n");
    return this.unstructuredSession(cwd, prompt, settings.agentModel);
  }

  async integrateComposite(cwd: string, title: string, sourceTitles: string[], settings: BurnerSettings): Promise<SessionResult> {
    const prompt = [
      "You are the author/integrator for a composite Burner pull request in an isolated git worktree.",
      "Inspect the combined changes, resolve incomplete integration, and run the most relevant tests. Preserve every included pull request's intent while removing duplication or incompatibilities.",
      "Do not create branches, commit, push, open pull requests, or modify anything under .burner; Burner owns delivery.",
      `Composite: ${title}`,
      `Included changes:\n${sourceTitles.map((source) => `- ${source}`).join("\n")}`,
      "In the final response, summarize integration changes and checks.",
    ].join("\n\n");
    return this.unstructuredSession(cwd, prompt, settings.agentModel);
  }

  async revise(cwd: string, threadId: string, review: ReviewResult, settings: BurnerSettings): Promise<SessionResult> {
    const prompt = [
      "An independent reviewer requested changes. Address every finding in the current worktree, run relevant checks, and leave the branch ready for another review.",
      "Do not commit, push, or open a pull request; Burner handles git delivery.",
      `Review summary: ${review.summary}`,
      `Findings:\n${review.findings.map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.title}${finding.file ? ` (${finding.file})` : ""}: ${finding.detail}`).join("\n")}`,
      "If a finding is invalid, verify that carefully and explain it, but make all justified fixes.",
    ].join("\n\n");
    return this.unstructuredSession(cwd, prompt, settings.agentModel, threadId);
  }

  async review(cwd: string, baseBranch: string, title: string, settings: BurnerSettings): Promise<ReviewResult> {
    const prompt = [
      "Act as an independent, rigorous reviewer. Review the complete branch diff against the base branch.",
      "Approve only when there are no material correctness, security, regression, race, lifecycle, or missing-test issues that should block merge.",
      "Do not edit files. Keep findings concrete and actionable. Approval must be false whenever any finding requires an author change.",
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
    sandbox: "read-only" | "workspace-write",
  ): Promise<T> {
    const tempDir = await mkdtemp(join(tmpdir(), "burner-codex-"));
    const schemaPath = join(tempDir, "schema.json");
    const outputPath = join(tempDir, "output.json");
    try {
      await writeFile(schemaPath, JSON.stringify(schema), "utf8");
      const args = this.args(cwd, model, sandbox);
      args.push("--output-schema", schemaPath, "--output-last-message", outputPath, "-");
      const result = await runCommand("codex", args, {
        cwd,
        input: prompt,
        timeoutMs: 45 * 60 * 1000,
        onStderr: (line) => this.onProgress?.(line),
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `codex exec exited with ${result.exitCode}`);
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
      const args = this.args(cwd, model, "read-only");
      args.push("--output-schema", schemaPath, "--output-last-message", outputPath, "-");
      const result = await runCommand("codex", args, {
        cwd,
        input: prompt,
        timeoutMs: 60 * 60 * 1000,
        onStderr: (line) => this.onProgress?.(line),
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `codex reviewer exited with ${result.exitCode}`);
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
  ): Promise<SessionResult> {
    const tempDir = await mkdtemp(join(tmpdir(), "burner-agent-"));
    const outputPath = join(tempDir, "output.md");
    try {
      const args = resumeThreadId
        ? ["exec", "resume", "--json", "-c", 'approval_policy="never"', "-c", 'sandbox_mode="workspace-write"']
        : ["exec", "--json", "--color", "never", "--sandbox", "workspace-write", "-c", 'approval_policy="never"', "-C", cwd];
      if (model.trim()) args.push("--model", model.trim());
      args.push("--output-last-message", outputPath);
      if (resumeThreadId) args.push(resumeThreadId);
      args.push("-");
      const result = await runCommand("codex", args, {
        cwd,
        input: prompt,
        timeoutMs: 2 * 60 * 60 * 1000,
        onStderr: (line) => this.onProgress?.(line),
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `codex exec exited with ${result.exitCode}`);
      const threadEvent = result.stdout.split("\n").map((line) => {
        try { return JSON.parse(line) as { type?: string; thread_id?: string }; } catch { return undefined; }
      }).find((event) => event?.type === "thread.started" && event.thread_id);
      const threadId = threadEvent?.thread_id ?? resumeThreadId;
      if (!threadId) throw new Error("Codex did not return a resumable author thread id.");
      return { message: (await readFile(outputPath, "utf8").catch(() => result.stdout)).trim(), threadId };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private args(cwd: string, model: string, sandbox: "read-only" | "workspace-write"): string[] {
    const args = [
      "exec",
      "--ephemeral",
      "--color",
      "never",
      "--sandbox",
      sandbox,
      "-c",
      'approval_policy="never"',
      "-C",
      cwd,
    ];
    if (model.trim()) args.push("--model", model.trim());
    return args;
  }
}
