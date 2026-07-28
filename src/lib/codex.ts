import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BurnerSettings, Evaluation, EvaluationRun, Idea } from "../types.js";
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

type EvaluationOutput = { score: number; summary: string; evidence: string[]; suggestions: string[] };
export type PlannedIdea = Omit<Idea, "id" | "status" | "createdAt" | "updatedAt" | "source" | "agentRunId">;

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
      `Context: ${context === "agent" ? "This is a candidate branch; assess only its current state." : "This is the current project baseline."}`,
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
  ): Promise<string> {
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
    return this.unstructured(cwd, prompt, settings.agentModel, "workspace-write");
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

  private async unstructured(
    cwd: string,
    prompt: string,
    model: string,
    sandbox: "read-only" | "workspace-write",
  ): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), "burner-agent-"));
    const outputPath = join(tempDir, "output.md");
    try {
      const args = this.args(cwd, model, sandbox);
      args.push("--output-last-message", outputPath, "-");
      const result = await runCommand("codex", args, {
        cwd,
        input: prompt,
        timeoutMs: 2 * 60 * 60 * 1000,
        onStderr: (line) => this.onProgress?.(line),
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `codex exec exited with ${result.exitCode}`);
      return (await readFile(outputPath, "utf8").catch(() => result.stdout)).trim();
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
