import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LockManager } from "../dist/lib/locks.js";
import { CodexClient } from "../dist/lib/codex.js";
import { EventHub } from "../dist/lib/events.js";
import { inferIdeaResources, Orchestrator, selectYoloLeafBatch, selectYoloMergeCandidate } from "../dist/lib/orchestrator.js";
import { updateProgressArtifacts } from "../dist/lib/progress.js";
import { buildCompositeDraftPrBody, buildCompositePrBody, buildPrBody, GitService } from "../dist/lib/git.js";
import { createBurnerServer } from "../dist/server.js";
import { StateStore, validateEvaluation } from "../dist/lib/store.js";
import { clampScore, parseJsonObject, slugify, weightedScore } from "../dist/lib/utils.js";

const exec = (cwd, command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { cwd }, (error, stdout, stderr) => {
    if (error) reject(new Error(stderr || error.message));
    else resolve(stdout);
  });
});

test("CLI version matches the package version", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const output = await exec(process.cwd(), process.execPath, ["dist/cli.js", "--version"]);
  assert.equal(output.trim(), packageJson.version);
});

test("score helpers clamp and weight enabled evaluations", () => {
  assert.equal(clampScore(105), 100);
  assert.equal(clampScore(-4), 0);
  assert.equal(clampScore(72.26), 72.3);
  const evaluations = [
    { id: "quality", weight: 2, enabled: true },
    { id: "speed", weight: 1, enabled: true },
    { id: "paused", weight: 10, enabled: false },
  ];
  assert.equal(weightedScore(evaluations, new Map([["quality", 80], ["speed", 50], ["paused", 0]])), 70);
});

test("merge progress artifacts retain every series and deduplicate PR retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-progress-test-"));
  try {
    await writeFile(join(root, "README.md"), "# Demo\n");
    const timestamp = "2026-01-01T00:00:00.000Z";
    const evaluations = [
      { id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp },
      { id: "speed", name: "Speed", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp },
    ];
    await updateProgressArtifacts(root, evaluations, [
      { key: "base:abc", recordedAt: timestamp, label: "base abc", kind: "baseline", title: "main", scores: { quality: 60, speed: 70 } },
      { key: "pr:12", recordedAt: "2026-01-02T00:00:00.000Z", label: "PR #12", kind: "composite", prNumber: 12, title: "Combined", scores: { quality: 75, speed: 80 } },
    ]);
    await updateProgressArtifacts(root, evaluations, [
      { key: "pr:12", recordedAt: "2026-01-03T00:00:00.000Z", label: "PR #12", kind: "composite", prNumber: 12, title: "Combined", scores: { quality: 76, speed: 81 } },
    ]);
    const readme = await readFile(join(root, "README.md"), "utf8");
    const history = JSON.parse(await readFile(join(root, "docs", "burner-evaluation-history.json"), "utf8"));
    const svg = await readFile(join(root, "docs", "burner-evaluation-progress.svg"), "utf8");
    assert.match(readme, /burner-progress:start/);
    assert.match(readme, /burner-evaluation-progress\.svg/);
    assert.equal(history.points.length, 2);
    assert.equal(history.points[1].recordedAt, "2026-01-02T00:00:00.000Z");
    assert.equal(history.points[1].scores.quality, 76);
    assert.match(svg, /Quality/);
    assert.match(svg, /PR #12/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("benchmark-oriented ideas conservatively infer the shared CPU resource", () => {
  assert.deepEqual(inferIdeaResources({ title: "Emit benchmark evidence", description: "Prove results", rationale: "Integrity" }), ["cpu-heavy"]);
  assert.deepEqual(inferIdeaResources({ title: "Profile grouped queries", description: "Find hot paths", rationale: "Speed" }), ["cpu-heavy"]);
  assert.deepEqual(inferIdeaResources({ title: "Improve SQL docs", description: "Add examples", rationale: "Clarity" }), []);
});

test("resuming the orchestrator does not force a redundant fresh baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-resume-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const orchestrator = new Orchestrator(root, store, new EventHub());
    const forced = [];
    orchestrator.tick = async (force) => { forced.push(force); };
    await orchestrator.setEnabled(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(forced, [false]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("structured output parser tolerates a fenced preamble", () => {
  assert.deepEqual(parseJsonObject("result follows\n{\"score\": 88}\nthanks"), { score: 88 });
  assert.equal(slugify("Polish the first-run UX!"), "polish-the-first-run-ux");
});

test("headless CLI configures evaluations, ideas, and conservative settings as JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-cli-test-"));
  const cli = join(process.cwd(), "dist", "cli.js");
  try {
    const help = await exec(root, "node", [cli, "--help"]);
    assert.match(help, /Codex agents?[\s\S]*unrestricted filesystem and command access/);
    assert.match(help, /--yolo\s+autonomously run and master-cook leaf PRs/);
    assert.match(help, /--yolo-batch-size <n>\s+leaf PRs per composite/);
    await assert.rejects(() => exec(root, "node", [cli, "--no-open", "--yolo-batch-size", "0"]), /integer between 1 and 100/);
    assert.deepEqual(JSON.parse(await exec(root, "node", [cli, "eval", "clear", "--yes", "-C", root])), { removed: 3 });
    const evaluation = JSON.parse(await exec(root, "node", [cli, "eval", "add", "-C", root, "--name", "Correctness", "--prompt", "Score correctness out of 100", "--command", "./full", "--screening-command", "./quick", "--weight", "2"]));
    assert.equal(evaluation.name, "Correctness");
    assert.equal(evaluation.screeningCommand, "./quick");
    const listed = JSON.parse(await exec(root, "node", [cli, "eval", "list", "-C", root]));
    assert.deepEqual(listed.map((item) => item.id), [evaluation.id]);
    const idea = JSON.parse(await exec(root, "node", [cli, "idea", "add", "-C", root, "--title", "Build core", "--description", "Implement the core", "--impact", "90", "--eval", evaluation.id, "--resource", "cpu"]));
    assert.equal(idea.predictedImpact, 90);
    assert.deepEqual(idea.evaluationIds, [evaluation.id]);
    assert.deepEqual(idea.resources, ["cpu"]);
    const settings = JSON.parse(await exec(root, "node", [cli, "settings", "set", "-C", root, "--parallelism", "1", "--max-review-rounds", "4", "--portfolio-review-rounds", "3", "--merge-cadence-minutes", "60", "--auto-create-prs", "true"]));
    assert.equal(settings.parallelism, 1);
    assert.equal(settings.maxReviewRounds, 4);
    assert.equal(settings.portfolioReviewRounds, 3);
    assert.equal(settings.mergeCadenceMinutes, 60);
    assert.equal(settings.autoCreatePrs, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("command evaluations return deterministic structured scores without Codex", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-command-eval-test-"));
  const evaluator = join(root, "evaluate");
  try {
    await writeFile(evaluator, `#!/bin/sh\nprintf '%s\\n' '{"score":42.25,"summary":"Measured locally","evidence":["same workload"],"suggestions":["go faster"]}'\n`);
    await chmod(evaluator, 0o755);
    const settings = { parallelism: 1, evaluationIntervalMinutes: 30, orchestratorIntervalMinutes: 15, autoRun: false, autoCreatePrs: true, evaluatorModel: "", agentModel: "", baseBranch: "main", remote: "origin", defaultResources: [], maxReviewRounds: 8, preferLivingComposite: true, compositeAbsorbThreshold: 0 };
    const output = await new CodexClient().evaluate(root, { id: "bench", name: "Benchmark", prompt: "Measure it", command: evaluator, weight: 1, enabled: true, createdAt: new Date().toISOString() }, settings, "manual");
    assert.equal(output.score, 42.3);
    assert.equal(output.summary, "Measured locally");
    assert.deepEqual(output.evidence, ["same workload"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portfolio leaf screens are comparable and composites retain the full command", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-screening-eval-test-"));
  const full = join(root, "full");
  const screen = join(root, "screen");
  try {
    await writeFile(full, `#!/bin/sh\nprintf '%s\\n' '{"score":90,"summary":"216 full cases","evidence":[],"suggestions":[]}'\n`);
    await writeFile(screen, `#!/bin/sh\nprintf '%s\\n' '{"score":80,"summary":"48 screening cases","evidence":[],"suggestions":[]}'\n`);
    await Promise.all([chmod(full, 0o755), chmod(screen, 0o755)]);
    const settings = { parallelism: 1, evaluationIntervalMinutes: 30, orchestratorIntervalMinutes: 15, autoRun: false, autoCreatePrs: true, evaluatorModel: "", agentModel: "", baseBranch: "main", remote: "origin", defaultResources: [], maxReviewRounds: 8, preferLivingComposite: true, compositeAbsorbThreshold: 0 };
    const evaluation = { id: "bench", name: "Benchmark", prompt: "Measure it", command: full, screeningCommand: screen, weight: 1, enabled: true, createdAt: new Date().toISOString() };
    const codex = new CodexClient();
    assert.equal((await codex.evaluate(root, evaluation, settings, "screening_baseline")).score, 80);
    assert.equal((await codex.evaluate(root, evaluation, settings, "agent")).score, 80);
    assert.equal((await codex.evaluate(root, evaluation, settings, "composite")).score, 90);
    assert.equal((await codex.evaluate(root, evaluation, settings, "baseline")).score, 90);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portfolio merge clock starts after full and screening baselines", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-screening-clock-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    await store.update((state) => {
      state.evaluations = [{ id: "bench", name: "Benchmark", prompt: "Measure", command: "full", screeningCommand: "quick", weight: 1, enabled: true, createdAt: new Date().toISOString() }];
      state.orchestrator.mergeWindowStartedAt = undefined;
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 10 });
    orchestrator.git = { resolveRef: async () => "base" };
    const contexts = [];
    orchestrator.runEvaluations = async (context) => {
      contexts.push(context);
      const run = { id: `run-${context}`, evaluationId: "bench", score: 80, commit: "base", createdAt: new Date().toISOString(), durationMs: 1, status: "completed", context };
      await store.update((state) => state.evaluationRuns.push(run));
      return [run];
    };
    await orchestrator.runBaselineEvaluations("baseline");
    assert.deepEqual(contexts, ["baseline", "screening_baseline"]);
    assert.ok(store.get().orchestrator.lastEvaluationAt);
    assert.ok(store.get().orchestrator.mergeWindowStartedAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resource locks are exclusive and recover after release", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-lock-test-"));
  try {
    const locks = new LockManager(root);
    const first = await locks.tryAcquire("gpu", "agent-one");
    assert.ok(first);
    assert.equal(await locks.tryAcquire("gpu", "agent-two"), undefined);
    assert.deepEqual(await locks.list(), ["gpu"]);
    let waiterSettled = false;
    const waiting = locks.acquire("gpu", "agent-two", { timeoutMs: 1_000, pollMs: 10 }).then((lock) => { waiterSettled = true; return lock; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(waiterSettled, false);
    await first.release();
    const second = await waiting;
    assert.ok(second);
    await second.release();
    await writeFile(join(root, "orphan.lock"), JSON.stringify({ pid: 2_147_483_647, createdAt: new Date().toISOString() }));
    assert.deepEqual(await locks.reapOrphans(), ["orphan"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart recovery makes every interrupted agent phase resumable", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-agent-recovery-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const interrupted = ["starting", "running", "reviewing", "revising", "evaluating", "opening_pr"];
    await store.update((state) => {
      state.agentRuns = interrupted.map((status, index) => ({
        id: `agent-${index}`,
        ideaId: `idea-${index}`,
        status,
        branch: `branch-${index}`,
        worktree: root,
        startedAt: timestamp,
        deltas: [],
        resources: [],
        reviewRounds: [],
      }));
      state.ideas = interrupted.map((_status, index) => ({
        id: `idea-${index}`,
        title: `Idea ${index}`,
        description: "Recover me",
        rationale: "Test",
        predictedImpact: 1,
        evaluationIds: [],
        resources: [],
        status: "running",
        source: "manual",
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
    });
    const recovered = new StateStore(root);
    await recovered.init();
    assert.deepEqual(recovered.get().agentRuns.map((run) => run.status), interrupted.map(() => "failed"));
    assert.ok(recovered.get().agentRuns.every((run) => run.error === "Burner stopped before this run completed."));
    assert.ok(recovered.get().ideas.every((idea) => idea.status === "failed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent retries cannot exceed configured parallelism", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-retry-capacity-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.activeAgents.add("busy");
    await assert.rejects(() => orchestrator.retryAgent("missing"), /All configured agent slots are currently in use/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compiled server serves the API and closes connected event streams", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-server-test-"));
  const burner = await createBurnerServer({ root, host: "127.0.0.1", port: 0 });
  try {
    const address = burner.server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.deepEqual(health, { ok: true, project: root.split("/").at(-1) });
    const dashboard = await (await fetch(`${base}/api/dashboard`)).json();
    assert.equal(dashboard.runtime.yolo, false);

    const created = await fetch(`${base}/api/evaluations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Docs", prompt: "Score the docs", weight: 2, enabled: true }),
    });
    assert.equal(created.status, 201);
    const invalidComposite = await fetch(`${base}/api/composites`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentRunIds: [] }) });
    assert.equal(invalidComposite.status, 400);
    const missingRetry = await fetch(`${base}/api/agents/missing/retry`, { method: "POST" });
    assert.equal(missingRetry.status, 404);

    await new Promise((resolve, reject) => {
      const request = get(`${base}/api/events`, (response) => {
        response.once("data", resolve);
        response.on("error", reject);
      });
      request.on("error", reject);
    });
    await Promise.race([
      burner.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Server shutdown timed out with an SSE client")), 1_500)),
    ]);
  } finally {
    if (burner.server.listening) await burner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("git service assembles source branches into an actual composite worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-composite-test-"));
  try {
    await exec(root, "git", ["init", "-b", "main"]);
    await writeFile(join(root, "base.txt"), "base\n");
    await exec(root, "git", ["add", "."]);
    await exec(root, "git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "base"]);
    await exec(root, "git", ["switch", "-c", "feature-a"]);
    await writeFile(join(root, "a.txt"), "a\n");
    await exec(root, "git", ["add", "."]);
    await exec(root, "git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "a"]);
    await exec(root, "git", ["switch", "main"]);
    await exec(root, "git", ["switch", "-c", "feature-b"]);
    await writeFile(join(root, "b.txt"), "b\n");
    await exec(root, "git", ["add", "."]);
    await exec(root, "git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "b"]);
    await exec(root, "git", ["switch", "main"]);
    const git = new GitService(root, join(root, ".burner"));
    const worktree = await git.createWorktree("composite", "burner/composite-test", "main");
    assert.equal((await git.mergeBranch(worktree, "feature-a")).merged, true);
    assert.equal((await git.mergeBranch(worktree, "feature-b")).merged, true);
    assert.equal(await git.hasRef("burner/composite-test"), true);
    assert.equal(await import("node:fs/promises").then((fs) => fs.readFile(join(worktree, "a.txt"), "utf8")), "a\n");
    assert.equal(await import("node:fs/promises").then((fs) => fs.readFile(join(worktree, "b.txt"), "utf8")), "b\n");
    await git.removeWorktree(worktree);
    const experiment = await git.createWorktree("experiment", "burner/experiment-test", "burner/composite-test");
    await writeFile(join(experiment, "experiment.txt"), "win\n");
    await git.commit(experiment, "experiment");
    await git.removeWorktree(experiment);
    const evolving = await git.createExistingWorktree("evolving", "burner/composite-test");
    assert.equal((await git.mergeBranch(evolving, "burner/experiment-test")).merged, true);
    assert.equal(await import("node:fs/promises").then((fs) => fs.readFile(join(evolving, "experiment.txt"), "utf8")), "win\n");
    await git.removeWorktree(evolving);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub PR disposition labels are mutually exclusive and initialized once", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-label-test-"));
  const bin = join(root, "bin");
  const argsLog = join(root, "gh-args.jsonl");
  await import("node:fs/promises").then((fs) => fs.mkdir(bin));
  const executable = join(bin, "gh");
  await writeFile(executable, `#!/usr/bin/env node\nconst fs=require("fs");fs.appendFileSync(process.env.BURNER_TEST_GH_ARGS,JSON.stringify(process.argv.slice(2))+"\\n");\n`);
  await chmod(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.BURNER_TEST_GH_ARGS = argsLog;
  try {
    const git = new GitService(root, join(root, ".burner"));
    await git.openPr({ cwd: root, base: "main", branch: "composite", title: "Composite", body: "Draft", draft: true });
    await git.markPrReady(root, 42);
    await git.markPrDraft(root, 42);
    await git.markPrDisposition(root, 42, "unmerged");
    await git.markPrDisposition(root, 42, "merged");
    const calls = (await readFile(argsLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(calls.some((args) => args[0] === "pr" && args[1] === "create" && args.includes("--draft")));
    assert.ok(calls.some((args) => args[0] === "pr" && args[1] === "ready"));
    assert.ok(calls.some((args) => args[0] === "pr" && args[1] === "ready" && args.includes("--undo")));
    assert.equal(calls.filter((args) => args[0] === "label" && args[1] === "create").length, 3);
    assert.deepEqual(calls.at(-2), ["pr", "edit", "42", "--add-label", "burner-unmerged", "--remove-label", "burner-merged"]);
    assert.deepEqual(calls.at(-1), ["pr", "edit", "42", "--add-label", "burner-merged", "--remove-label", "burner-unmerged", "--remove-label", "burner-quarantined"]);
  } finally {
    process.env.PATH = previousPath;
    delete process.env.BURNER_TEST_GH_ARGS;
    await rm(root, { recursive: true, force: true });
  }
});

test("PR bodies record review approval and recalculated composite scores", () => {
  const rounds = [{ id: "r1", round: 1, commit: "abc", approved: true, summary: "Approved", findings: [], createdAt: new Date().toISOString() }];
  const deltas = [{ evaluationId: "quality", name: "Quality", before: 70, after: 82, delta: 12 }];
  assert.match(buildPrBody("Change", "Done", deltas, 12, rounds), /Approved by an independent Codex reviewer/);
  const screened = buildPrBody("Change", "Done", [{ ...deltas[0], screening: true }], 12, rounds);
  assert.match(screened, /Quality \(leaf screen\)/);
  assert.match(screened, /Composite PRs rerun each full command/);
  const body = buildCompositePrBody({ description: "Combined", sources: [{ agentRunId: "a", prNumber: 12, title: "A", branch: "a" }, { agentRunId: "b", prNumber: 13, title: "B", branch: "b" }], deltas, compositeScore: 82, impact: 12, reviewRounds: rounds });
  assert.match(body, /Composite score: 82\.0 \/ 100/);
  assert.match(body, /#12/);
  assert.match(body, /never inferred by adding individual deltas/);
  const draft = buildCompositeDraftPrBody({ description: "Combined", sources: [{ agentRunId: "a", prNumber: 12, title: "A", branch: "a" }, { agentRunId: "b", prNumber: 13, title: "B", branch: "b" }], phase: "awaiting review" });
  assert.match(draft, /Master cook · draft/);
  assert.match(draft, /not mergeable until independent review and combined-code evaluation finish/);
});

test("YOLO merge selection prefers reviewed composites and rejects stale or deterministic regressions", () => {
  const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: new Date().toISOString() };
  const deltas = [
    { evaluationId: "quality", name: "Quality", before: 70, after: 72, delta: 2 },
    { evaluationId: "speed", name: "Speed", before: 80, after: 80, delta: 0 },
  ];
  const state = {
    settings: { compositeAbsorbThreshold: 0 },
    evaluations: [{ id: "quality", enabled: true }, { id: "speed", enabled: true, command: "./benchmark" }],
    composites: [{ id: "composite", status: "open", prNumber: 20, baseCommit: "base", reviewApproved: true, reviewRounds: [approvedRound], deltas, impact: 1, sources: [{ agentRunId: "agent", kind: "pull_request" }] }],
    agentRuns: [{ id: "agent", status: "completed", prState: "open", prNumber: 10, baseCommit: "base", reviewApproved: true, reviewRounds: [approvedRound], deltas, impact: 5 }],
  };
  assert.deepEqual(selectYoloMergeCandidate(state, "base"), { kind: "composite", id: "composite", prNumber: 20, impact: 1 });
  state.composites[0].status = "closed";
  assert.equal(selectYoloMergeCandidate(state, "base", false), undefined);
  assert.deepEqual(selectYoloMergeCandidate(state, "base"), { kind: "agent", id: "agent", prNumber: 10, impact: 5 });
  assert.equal(selectYoloMergeCandidate(state, "new-base"), undefined);
  state.agentRuns[0].deltas = [{ ...deltas[0], delta: -0.1 }, deltas[1]];
  assert.deepEqual(selectYoloMergeCandidate(state, "base"), { kind: "agent", id: "agent", prNumber: 10, impact: 5 });
  state.agentRuns[0].deltas = [deltas[0], { ...deltas[1], delta: -0.1 }];
  assert.equal(selectYoloMergeCandidate(state, "base"), undefined);
  state.agentRuns[0].deltas = [deltas[0]];
  assert.equal(selectYoloMergeCandidate(state, "base"), undefined);
});

test("YOLO portfolio waits for a full leaf batch, ranks impact, and reserves composite sources", () => {
  const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: new Date().toISOString() };
  const deltas = [{ evaluationId: "speed", name: "Speed", before: 80, after: 81, delta: 1 }];
  const leaf = (id, impact) => ({ id, status: "completed", prState: "open", prNumber: Number(id.slice(1)), baseCommit: "base", reviewApproved: true, reviewRounds: [approvedRound], deltas, impact });
  const state = {
    settings: { compositeAbsorbThreshold: 0 },
    evaluations: [{ id: "speed", enabled: true, command: "./benchmark" }],
    composites: [],
    agentRuns: [leaf("a1", 1), leaf("a2", 8), leaf("a3", 5)],
  };
  assert.deepEqual(selectYoloLeafBatch(state, "base", 4), []);
  assert.deepEqual(selectYoloLeafBatch(state, "base", 4, 2), ["a2", "a3", "a1"]);
  assert.deepEqual(selectYoloLeafBatch(state, "base", 3), ["a2", "a3", "a1"]);
  state.composites.push({ id: "composite", status: "queued", sources: [{ agentRunId: "a2" }] });
  assert.deepEqual(selectYoloLeafBatch(state, "base", 3), []);
  state.agentRuns.push(leaf("a4", 4));
  assert.deepEqual(selectYoloLeafBatch(state, "base", 3), ["a3", "a4", "a1"]);
  state.agentRuns[2].baseCommit = "old-base";
  assert.deepEqual(selectYoloLeafBatch(state, "base", 3), []);
  state.agentRuns[1].quarantinedAt = new Date().toISOString();
  assert.deepEqual(selectYoloLeafBatch(state, "base", 3, 2), ["a4", "a1"]);
});

test("YOLO portfolio automatically cooks a complete batch without creating a living line", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-yolo-portfolio-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: timestamp };
    const leaf = (id, number, impact) => ({ id, ideaId: `idea-${id}`, status: "completed", branch: `branch-${id}`, worktree: "", startedAt: timestamp, completedAt: timestamp, prUrl: `https://example.test/pull/${number}`, prNumber: number, prState: "open", baseCommit: "base", deltas: [{ evaluationId: "speed", name: "Speed", before: 80, after: 81, delta: 1 }], impact, resources: [], reviewRounds: [approvedRound], reviewApproved: true });
    await store.update((state) => {
      state.evaluations = [{ id: "speed", name: "Speed", prompt: "Measure speed", command: "./benchmark", weight: 1, enabled: true, createdAt: timestamp }];
      state.agentRuns = [leaf("slow", 1, 2), leaf("fast", 2, 7)];
      state.ideas.push(
        { id: "idea-slow", title: "Slow win", description: "", rationale: "", predictedImpact: 2, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "slow" },
        { id: "idea-fast", title: "Fast win", description: "", rationale: "", predictedImpact: 7, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "fast" },
      );
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 2 });
    orchestrator.git = { resolveRef: async () => "base" };
    let request;
    orchestrator.createComposite = async (...args) => { request = args; return {}; };
    assert.equal(await orchestrator.autoCookNext(), true);
    assert.deepEqual(request[0], ["fast", "slow"]);
    assert.match(request[1], /YOLO generation 1/);
    assert.deepEqual(request[3], { makeLiving: false });
    assert.equal(store.get().orchestrator.livingCompositeId, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("YOLO starts a partial cook early enough for the observed full suite to meet its deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-yolo-deadline-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.settings.mergeCadenceMinutes = 60;
      state.evaluations = [
        { id: "benchmark", name: "Benchmark", prompt: "Measure", command: "./full", weight: 1, enabled: true, createdAt: timestamp },
        { id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp },
      ];
      state.evaluationRuns = [
        { id: "benchmark-run", evaluationId: "benchmark", score: 80, commit: "base", createdAt: timestamp, durationMs: 40 * 60_000, status: "completed", context: "baseline" },
        { id: "quality-run", evaluationId: "quality", score: 80, commit: "base", createdAt: timestamp, durationMs: 3 * 60_000, status: "completed", context: "baseline" },
      ];
      state.orchestrator.mergeWindowStartedAt = new Date(Date.now() - 13 * 60_000).toISOString();
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 10 });
    assert.equal(orchestrator.mergeCadenceDue(), false);
    assert.equal(orchestrator.portfolioCookDue(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("YOLO cadence cooks a healthy partial batch and falls back to one reviewed leaf", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-yolo-cadence-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const old = new Date(Date.now() - 61 * 60_000).toISOString();
    const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: timestamp };
    const leaf = (id, number, impact) => ({ id, ideaId: `idea-${id}`, status: "completed", branch: `branch-${id}`, worktree: "", startedAt: timestamp, completedAt: timestamp, prUrl: `https://example.test/pull/${number}`, prNumber: number, prState: "open", baseCommit: "base", deltas: [{ evaluationId: "speed", name: "Speed", before: 80, after: 81, delta: 1 }], impact, resources: [], reviewRounds: [approvedRound], reviewApproved: true });
    await store.update((state) => {
      state.settings.mergeCadenceMinutes = 60;
      state.orchestrator.mergeWindowStartedAt = old;
      state.evaluations = [{ id: "speed", name: "Speed", prompt: "Measure speed", command: "./benchmark", weight: 1, enabled: true, createdAt: timestamp }];
      state.agentRuns = [leaf("a", 1, 3), leaf("b", 2, 2)];
      state.ideas.push(
        { id: "idea-a", title: "A", description: "", rationale: "", predictedImpact: 3, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "a" },
        { id: "idea-b", title: "B", description: "", rationale: "", predictedImpact: 2, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "b" },
      );
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 10 });
    orchestrator.git = { resolveRef: async () => "base" };
    let cooked;
    orchestrator.createComposite = async (...args) => { cooked = args; return {}; };
    assert.equal(await orchestrator.autoMergeNext(), false);
    assert.equal(await orchestrator.autoCookNext(), true);
    assert.deepEqual(cooked[0], ["a", "b"]);
    assert.match(cooked[2], /shortened this batch/);

    await store.update((state) => { state.agentRuns.find((run) => run.id === "b").quarantinedAt = timestamp; });
    orchestrator.activeAgents.add("in-flight");
    assert.equal(await orchestrator.shouldDrainForPortfolio(), true);
    orchestrator.activeAgents.clear();
    let merged;
    orchestrator.mergeAgent = async (id) => { merged = id; return {}; };
    assert.equal(await orchestrator.autoMergeNext(), true);
    assert.equal(merged, "a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("YOLO portfolio caps reviews, quarantines the implicated leaf, and queues the healthy subset", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-yolo-quarantine-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const run = (id, number, impact) => ({ id, ideaId: `idea-${id}`, status: "completed", branch: `branch-${id}`, worktree: "", startedAt: timestamp, completedAt: timestamp, prUrl: `https://example.test/pull/${number}`, prNumber: number, prState: "open", baseCommit: "base", deltas: [], impact, resources: [], reviewRounds: [], reviewApproved: true });
    await store.update((state) => {
      state.settings.portfolioReviewRounds = 3;
      state.agentRuns.push(run("a", 1, 3), run("b", 2, 2), run("c", 3, 1));
      state.composites.push({
        id: "blocked", title: "Blocked generation", description: "Combined", status: "reviewing", branch: "composite-blocked", worktree: "", baseCommit: "base",
        sources: [
          { agentRunId: "a", prNumber: 1, title: "A", branch: "branch-a", kind: "pull_request", impact: 3 },
          { agentRunId: "b", prNumber: 2, title: "B", branch: "branch-b", kind: "pull_request", impact: 2 },
          { agentRunId: "c", prNumber: 3, title: "C", branch: "branch-c", kind: "pull_request", impact: 1 },
        ],
        deltas: [], reviewRounds: [], prNumber: 100, prUrl: "https://example.test/pull/100", createdAt: timestamp, updatedAt: timestamp, isLiving: false,
      });
    });
    const quarantined = [];
    const closed = [];
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 10 });
    orchestrator.git = {
      resolveRef: async () => "base",
      changedFiles: async (_cwd, _base, head) => head.endsWith("branch-b") ? ["src/parser.ts"] : ["README.md"],
      markPrQuarantined: async (_cwd, number) => quarantined.push(number),
      closePr: async (_cwd, number) => closed.push(number),
    };
    let fallback;
    orchestrator.createComposite = async (ids, title, description) => { fallback = { ids, title, description }; return { id: "fallback" }; };
    await orchestrator.quarantineCompositeBlocker("blocked", [{ severity: "high", title: "Parser bug", detail: "Fix", file: "src/parser.ts:42" }]);
    const state = store.get();
    assert.ok(state.agentRuns.find((item) => item.id === "b").quarantinedAt);
    assert.equal(state.composites.find((item) => item.id === "blocked").status, "closed");
    assert.equal(state.composites.find((item) => item.id === "blocked").supersededByCompositeId, "fallback");
    assert.deepEqual(fallback.ids, ["a", "c"]);
    assert.deepEqual(quarantined, [2]);
    assert.deepEqual(closed, [100]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("YOLO portfolio opens a draft composite before review and bounds review rounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-yolo-draft-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.settings.portfolioReviewRounds = 3;
      state.composites.push({ id: "draft", title: "Visible composite", description: "Combined", status: "building", branch: "composite-draft", worktree: root, sources: [{ agentRunId: "a", prNumber: 1, title: "A", branch: "a", kind: "pull_request" }, { agentRunId: "b", prNumber: 2, title: "B", branch: "b", kind: "pull_request" }], deltas: [], reviewRounds: [], createdAt: timestamp, updatedAt: timestamp, isLiving: false });
      state.agentRuns.push({ id: "agent", ideaId: "idea", status: "reviewing", branch: "agent", worktree: root, startedAt: timestamp, deltas: [], resources: [], reviewRounds: [] });
    });
    const opened = [];
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 10 });
    orchestrator.git = {
      push: async () => undefined,
      openPr: async (options) => { opened.push(options); return { url: "https://example.test/pull/10", number: 10 }; },
      head: async () => "head",
      hasChanges: async () => false,
    };
    await orchestrator.publishCompositeDraft(root, "draft", "awaiting review", store.get().settings);
    assert.equal(opened[0].draft, true);
    assert.equal(store.get().composites[0].prNumber, 10);

    let reviewCalls = 0;
    orchestrator.codex = {
      review: async () => { reviewCalls += 1; return { approved: false, summary: "Not yet", findings: [{ severity: "high", title: "Bug", detail: "Fix", file: "src/app.ts" }] }; },
      revise: async () => ({ threadId: "thread", message: "revised" }),
    };
    await assert.rejects(() => orchestrator.reviewAgent(root, "agent", "Agent", "main", "thread", store.get().settings), /bounded review budget/);
    assert.equal(reviewCalls, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("YOLO portfolio drains active agents instead of refilling slots when a batch is ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-yolo-drain-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: timestamp };
    const leaf = (id, number) => ({ id, ideaId: `idea-${id}`, status: "completed", branch: `branch-${id}`, worktree: "", startedAt: timestamp, completedAt: timestamp, prUrl: `https://example.test/pull/${number}`, prNumber: number, prState: "open", baseCommit: "base", deltas: [{ evaluationId: "speed", name: "Speed", before: 80, after: 81, delta: 1 }], impact: 1, resources: [], reviewRounds: [approvedRound], reviewApproved: true });
    await store.update((state) => {
      state.settings.parallelism = 5;
      state.orchestrator.enabled = true;
      state.evaluations = [{ id: "speed", name: "Speed", prompt: "Measure speed", command: "./benchmark", weight: 1, enabled: true, createdAt: timestamp }];
      state.agentRuns = [leaf("a", 1), leaf("b", 2)];
      state.ideas.push({ id: "queued", title: "Do more", description: "More work", rationale: "Improve", predictedImpact: 10, evaluationIds: [], resources: [], status: "queued", createdAt: timestamp, updatedAt: timestamp, source: "manual" });
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 2 });
    orchestrator.git = { resolveRef: async () => "base" };
    orchestrator.activeAgents.add("already-running");
    let dispatched = false;
    orchestrator.runIdea = async () => { dispatched = true; };
    await orchestrator.schedule();
    assert.equal(dispatched, false);
    assert.equal(orchestrator.portfolioDraining, true);
    assert.match(store.get().activity[0].message, /batch ready; draining active agents/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("command-backed evaluations are serialized across concurrent candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-command-serialization-test-"));
  const evaluator = join(root, "evaluate");
  const mutex = join(root, "command-running");
  const overlap = join(root, "overlap-detected");
  try {
    await exec(root, "git", ["init", "-b", "main"]);
    await writeFile(join(root, "README.md"), "test\n");
    await exec(root, "git", ["add", "README.md"]);
    await exec(root, "git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "base"]);
    await writeFile(evaluator, `#!/bin/sh\nif ! mkdir "$BURNER_TEST_EVAL_MUTEX" 2>/dev/null; then\n  printf overlap > "$BURNER_TEST_EVAL_OVERLAP"\n  exit 9\nfi\ntrap 'rmdir "$BURNER_TEST_EVAL_MUTEX" 2>/dev/null || true' EXIT\nsleep 0.3\nprintf '%s\\n' '{"score":50,"summary":"serialized","evidence":[],"suggestions":[]}'\n`);
    await chmod(evaluator, 0o755);
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.settings.parallelism = 5;
      state.evaluations = [{ id: "benchmark", name: "Benchmark", prompt: "Measure", command: evaluator, weight: 1, enabled: true, createdAt: timestamp }];
    });
    process.env.BURNER_TEST_EVAL_MUTEX = mutex;
    process.env.BURNER_TEST_EVAL_OVERLAP = overlap;
    const orchestrator = new Orchestrator(root, store, new EventHub());
    await orchestrator.locks.init();
    const [first, second] = await Promise.all([
      orchestrator.runEvaluations("agent", root, "agent-a"),
      orchestrator.runEvaluations("agent", root, "agent-b"),
    ]);
    assert.deepEqual([...first, ...second].map((run) => run.status), ["completed", "completed"]);
    await assert.rejects(() => readFile(overlap, "utf8"), /ENOENT/);
  } finally {
    delete process.env.BURNER_TEST_EVAL_MUTEX;
    delete process.env.BURNER_TEST_EVAL_OVERLAP;
    await rm(root, { recursive: true, force: true });
  }
});

test("evaluation suites do not overlap and run command checks before prompt checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-evaluation-suite-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.settings.parallelism = 5;
      state.evaluations = [
        { id: "prompt", name: "Prompt", prompt: "Inspect", weight: 1, enabled: true, createdAt: timestamp },
        { id: "command", name: "Command", prompt: "Measure", command: "./benchmark", weight: 1, enabled: true, createdAt: timestamp },
      ];
    });
    const order = [];
    let activeSuite;
    let overlapped = false;
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.git = { head: async () => "commit" };
    orchestrator.codex = {
      preflight: async () => undefined,
      evaluate: async (cwd, evaluation) => {
        if (activeSuite && activeSuite !== cwd) overlapped = true;
        activeSuite = cwd;
        order.push(`${cwd}:${evaluation.id}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        activeSuite = undefined;
        return { score: 50, summary: "measured", evidence: [], suggestions: [] };
      },
    };
    await orchestrator.locks.init();
    await Promise.all([
      orchestrator.runEvaluations("agent", "suite-a", "agent-a"),
      orchestrator.runEvaluations("agent", "suite-b", "agent-b"),
    ]);
    assert.equal(overlapped, false);
    assert.ok(
      JSON.stringify(order) === JSON.stringify(["suite-a:command", "suite-a:prompt", "suite-b:command", "suite-b:prompt"]) ||
      JSON.stringify(order) === JSON.stringify(["suite-b:command", "suite-b:prompt", "suite-a:command", "suite-a:prompt"]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evaluation suites share cpu-heavy without deadlocking the owning agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-evaluation-resource-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.evaluations = [{ id: "command", name: "Command", prompt: "Measure", command: "./benchmark", weight: 1, enabled: true, createdAt: timestamp }];
      state.agentRuns.push({ id: "cpu-agent", resources: ["cpu-heavy"] });
    });
    const order = [];
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.git = { head: async () => "commit" };
    orchestrator.codex = {
      evaluate: async (cwd) => {
        order.push(cwd);
        const held = await orchestrator.locks.list();
        assert.ok(held.includes("cpu-heavy"));
        assert.ok(held.includes("evaluation-suite"));
        return { score: 50, summary: "measured", evidence: [], suggestions: [] };
      },
    };
    await orchestrator.locks.init();
    const agentLease = await orchestrator.locks.acquire("cpu-heavy", "cpu-agent");
    let plainFinished = false;
    const plain = orchestrator.runEvaluations("agent", "plain-suite", "plain-agent").then(() => { plainFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(plainFinished, false);
    await orchestrator.runEvaluations("agent", "owned-suite", "cpu-agent");
    assert.deepEqual(order, ["owned-suite"]);
    await agentLease.release();
    await plain;
    assert.deepEqual(order, ["owned-suite", "plain-suite"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every Codex role and structured fallback uses unrestricted mode with correct flag placement", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-codex-test-"));
  const bin = join(root, "bin");
  await import("node:fs/promises").then((fs) => fs.mkdir(bin));
  const executable = join(bin, "codex");
  const argsLog = join(root, "args.jsonl");
  await writeFile(executable, `#!/usr/bin/env node\nconst fs=require("fs");const args=process.argv.slice(2);const input=fs.readFileSync(0,"utf8");fs.appendFileSync(process.env.BURNER_TEST_ARGS,JSON.stringify({args,input})+"\\n");if(args.includes("--help")){console.log("  --dangerously-bypass-approvals-and-sandbox  unrestricted");process.exit(0);}const i=args.indexOf("--output-last-message");const out=args[i+1];if(args.includes("--output-schema")){process.exit(9);}if(input.includes("improvement planner")){fs.writeFileSync(out,JSON.stringify({ideas:[]}));}else if(input.includes("rigorous repository evaluator")){fs.writeFileSync(out,JSON.stringify({score:77,summary:"Measured",evidence:["code"],suggestions:["improve"]}));}else if(input.includes("independent, rigorous reviewer")){fs.writeFileSync(out,JSON.stringify({approved:true,summary:"Ready",findings:[]}));}else{fs.writeFileSync(out,"Author complete");console.log(JSON.stringify({type:"thread.started",thread_id:"thread-test"}));}\n`);
  await chmod(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.BURNER_TEST_ARGS = argsLog;
  const settings = { parallelism: 1, evaluationIntervalMinutes: 30, orchestratorIntervalMinutes: 15, autoRun: false, autoCreatePrs: true, evaluatorModel: "", agentModel: "", baseBranch: "main", remote: "origin", defaultResources: [], maxReviewRounds: 8, preferLivingComposite: true, compositeAbsorbThreshold: 0 };
  try {
    const codex = new CodexClient();
    const evaluation = { id: "quality", name: "Quality", prompt: "Score quality", weight: 1, enabled: true, createdAt: new Date().toISOString() };
    assert.equal((await codex.evaluate(root, evaluation, settings, "manual")).score, 77);
    assert.deepEqual(await codex.planIdeas(root, [evaluation], new Map(), [], settings), []);
    const author = await codex.implement(root, { id: "idea", title: "Improve", description: "Do it", rationale: "Quality", predictedImpact: 20, evaluationIds: [], resources: [], status: "running", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source: "manual" }, [], settings);
    assert.equal(author.threadId, "thread-test");
    assert.equal((await codex.integrateComposite(root, "Combined", ["Improve"], settings)).message, "Author complete");
    const revision = await codex.revise(root, author.threadId, { approved: false, summary: "Fix it", findings: [{ severity: "high", title: "Bug", detail: "Resolve", file: "app.js" }] }, settings);
    assert.equal(revision.message, "Author complete");
    const review = await codex.review(root, "main", "Improve", settings);
    assert.equal(review.approved, true);
    const calls = (await readFile(argsLog, "utf8")).trim().split("\n").map(JSON.parse);
    for (const { args } of calls) {
      assert.equal(args[0], "--dangerously-bypass-approvals-and-sandbox");
      assert.equal(args[1], "exec");
      assert.ok(!args.includes("--sandbox"));
      assert.ok(!args.includes("-s"));
      assert.ok(!args.includes("--ask-for-approval"));
      assert.ok(!args.includes("-a"));
      assert.ok(!args.some((arg) => /sandbox_mode|approval_policy|read-only|workspace-write/.test(arg)));
    }
    assert.ok(calls.some(({ input }) => input.includes("rigorous repository evaluator")));
    assert.ok(calls.some(({ input }) => input.includes("improvement planner")));
    assert.ok(calls.some(({ input }) => input.includes("implementation agent")));
    assert.ok(calls.some(({ input }) => input.includes("author/integrator")));
    assert.ok(calls.some(({ input }) => input.includes("independent reviewer requested changes")));
    const reviewerCalls = calls.filter(({ input }) => input.includes("independent, rigorous reviewer"));
    assert.equal(reviewerCalls.length, 2);
    assert.ok(reviewerCalls[0].args.includes("--output-schema"));
    assert.ok(!reviewerCalls[1].args.includes("--output-schema"));
    assert.ok(calls.some(({ args }) => args.includes("resume") && args.includes("thread-test")));
  } finally {
    process.env.PATH = previousPath;
    delete process.env.BURNER_TEST_ARGS;
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex unrestricted-mode preflight fails clearly without a restricted fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-codex-preflight-test-"));
  const bin = join(root, "bin");
  await import("node:fs/promises").then((fs) => fs.mkdir(bin));
  const executable = join(bin, "codex");
  await writeFile(executable, `#!/usr/bin/env node\nconsole.error("error: unexpected argument '--dangerously-bypass-approvals-and-sandbox'");process.exit(2);\n`);
  await chmod(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  try {
    await assert.rejects(
      () => new CodexClient().preflight(root),
      /requires Codex unrestricted mode.*will not fall back to restricted mode/s,
    );
  } finally {
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex preflight supports Meta's launcher-level sandbox bypass without a PTY shim", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-codex-meta-preflight-test-"));
  const bin = join(root, "bin");
  await import("node:fs/promises").then((fs) => fs.mkdir(bin));
  const executable = join(bin, "codex");
  const argsLog = join(root, "args.jsonl");
  await writeFile(executable, `#!/usr/bin/env node\nconst fs=require("fs");const args=process.argv.slice(2);fs.appendFileSync(process.env.BURNER_TEST_ARGS,JSON.stringify(args)+"\\n");if(!args.includes("--dangerously-disable-osx-sandbox")){console.error("sandbox_apply: Operation not permitted");process.exit(2);}if(args.includes("--help")){console.log("--dangerously-bypass-approvals-and-sandbox");process.exit(0);}const out=args[args.indexOf("--output-last-message")+1];fs.writeFileSync(out,JSON.stringify({score:88,summary:"ok",evidence:[],suggestions:[]}));\n`);
  await chmod(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.BURNER_TEST_ARGS = argsLog;
  const settings = { parallelism: 1, evaluationIntervalMinutes: 30, orchestratorIntervalMinutes: 15, autoRun: false, autoCreatePrs: true, evaluatorModel: "", agentModel: "", baseBranch: "main", remote: "origin", defaultResources: [], maxReviewRounds: 8, preferLivingComposite: true, compositeAbsorbThreshold: 0 };
  try {
    const output = await new CodexClient().evaluate(root, { id: "quality", name: "Quality", prompt: "Score it", weight: 1, enabled: true, createdAt: new Date().toISOString() }, settings, "manual");
    assert.equal(output.score, 88);
    const calls = (await readFile(argsLog, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls[0].slice(0, 2), ["--dangerously-bypass-approvals-and-sandbox", "exec"]);
    assert.deepEqual(calls[1].slice(0, 3), ["--dangerously-disable-osx-sandbox", "--dangerously-bypass-approvals-and-sandbox", "exec"]);
    assert.deepEqual(calls[2].slice(0, 3), ["--dangerously-disable-osx-sandbox", "--dangerously-bypass-approvals-and-sandbox", "exec"]);
  } finally {
    process.env.PATH = previousPath;
    delete process.env.BURNER_TEST_ARGS;
    await rm(root, { recursive: true, force: true });
  }
});

test("merged composites supersede source PRs and queue overlapping composites for rebuild", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-reconcile-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const run = (id, number) => ({ id, ideaId: `idea-${id}`, status: "completed", branch: `branch-${id}`, worktree: "", startedAt: timestamp, completedAt: timestamp, prUrl: `https://example.test/pull/${number}`, prNumber: number, prState: "open", deltas: [], resources: [], reviewRounds: [], reviewApproved: true });
    await store.update((state) => {
      state.agentRuns.push(run("a", 1), run("b", 2), run("c", 3), run("d", 4));
      state.composites.push(
        { id: "merged", title: "Merged composite", description: "", status: "open", branch: "composite-merged", worktree: "", sources: [{ agentRunId: "a", prNumber: 1, title: "A", branch: "branch-a", kind: "pull_request" }, { agentRunId: "b", prNumber: 2, title: "B", branch: "branch-b", kind: "pull_request" }], deltas: [], reviewRounds: [], prNumber: 100, prUrl: "https://example.test/pull/100", createdAt: timestamp, updatedAt: timestamp, isLiving: true },
        { id: "overlap", title: "Overlap", description: "", status: "open", branch: "composite-overlap", worktree: "", sources: [{ agentRunId: "a", prNumber: 1, title: "A", branch: "branch-a", kind: "pull_request" }, { agentRunId: "c", prNumber: 3, title: "C", branch: "branch-c", kind: "pull_request" }, { agentRunId: "d", prNumber: 4, title: "D", branch: "branch-d", kind: "pull_request" }], deltas: [], reviewRounds: [], prNumber: 101, prUrl: "https://example.test/pull/101", createdAt: timestamp, updatedAt: timestamp, isLiving: false },
      );
      state.orchestrator.livingCompositeId = "merged";
    });
    const closed = [];
    const labeled = [];
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.git = {
      remoteExists: async () => true,
      listPullRequests: async () => [
        { number: 1, state: "OPEN", headRefName: "branch-a", url: "" }, { number: 2, state: "OPEN", headRefName: "branch-b", url: "" },
        { number: 3, state: "OPEN", headRefName: "branch-c", url: "" }, { number: 4, state: "OPEN", headRefName: "branch-d", url: "" },
        { number: 100, state: "MERGED", headRefName: "composite-merged", url: "" }, { number: 101, state: "OPEN", headRefName: "composite-overlap", url: "" },
      ],
      closePr: async (_cwd, number, _comment, disposition) => { closed.push([number, disposition]); },
      markPrDisposition: async (_cwd, number, disposition) => { labeled.push([number, disposition]); },
      syncBase: async () => "abcdef1234567890",
    };
    await orchestrator.syncPullRequests(true);
    const state = store.get();
    assert.equal(state.composites.find((item) => item.id === "merged").status, "merged");
    assert.equal(state.agentRuns.find((item) => item.id === "a").prState, "superseded");
    assert.equal(state.agentRuns.find((item) => item.id === "b").prState, "superseded");
    const overlap = state.composites.find((item) => item.id === "overlap");
    assert.equal(overlap.status, "rebuilding");
    assert.deepEqual(overlap.sources.map((source) => source.agentRunId), ["c", "d"]);
    assert.deepEqual(closed.sort(), [[1, "merged"], [2, "merged"]]);
    assert.deepEqual(labeled, [[100, "merged"]]);
    assert.equal(state.orchestrator.baseSyncPending, false);
    assert.equal(state.orchestrator.lastEvaluationAt, undefined);
    assert.ok(state.orchestrator.lastMergeAt);
    assert.equal(state.orchestrator.mergeWindowStartedAt, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an exactly merged composite becomes the next full baseline without rerunning it", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-promote-baseline-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.evaluations = [{ id: "quality", name: "Quality", prompt: "Score", command: "full", screeningCommand: "quick", weight: 1, enabled: true, createdAt: timestamp }];
      state.composites.push({ id: "combined", title: "Combined", description: "", status: "merged", branch: "burner/combined", worktree: "", sources: [], deltas: [], reviewRounds: [], createdAt: timestamp, updatedAt: timestamp, isLiving: false });
      state.evaluationRuns.push({ id: "combined-score", evaluationId: "quality", score: 88, commit: "combined-head", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite", compositeId: "combined" });
    });
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.git = { tree: async () => "same-tree" };
    assert.equal(await orchestrator.promoteMergedCompositeBaseline("combined", "new-main"), true);
    assert.equal(store.latestRuns().get("quality").score, 88);
    assert.equal(store.latestRuns().get("quality").commit, "new-main");
    assert.equal(store.latestScreeningRuns().size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evaluation weight changes restamp open leaf impacts and PR bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-reweight-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.evaluations = [
        { id: "capability", name: "Capability", prompt: "Score", weight: 2, enabled: true, createdAt: timestamp },
        { id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp },
        { id: "parity", name: "Parity", prompt: "Score", command: "bench", weight: 3, enabled: true, createdAt: timestamp },
        { id: "integrity", name: "Integrity", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp },
      ];
      state.ideas = [{ id: "idea", title: "Improve", description: "Change it", rationale: "", predictedImpact: 1, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "run" }];
      state.agentRuns = [{ id: "run", ideaId: "idea", status: "completed", branch: "branch", worktree: "", startedAt: timestamp, completedAt: timestamp, prNumber: 42, prState: "open", deltas: [
        { evaluationId: "capability", name: "Capability", before: 40, after: 45, delta: 5 },
        { evaluationId: "quality", name: "Quality", before: 75, after: 85, delta: 10 },
        { evaluationId: "parity", name: "Parity", before: 100, after: 100, delta: 0 },
        { evaluationId: "integrity", name: "Integrity", before: 85, after: 70, delta: -15 },
      ], impact: -1.2, resources: [], reviewRounds: [], reviewApproved: true }];
    });
    const edits = [];
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.git = { editPr: async (...args) => edits.push(args) };
    await orchestrator.refreshEvaluationWeights();
    assert.equal(store.get().agentRuns[0].impact, 0.7);
    assert.equal(edits.length, 1);
    assert.match(edits[0][3], /Burner impact score: \+0\.7/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("successful experiments bind to and incrementally evolve the living composite", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-living-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const evaluation = store.get().evaluations[0];
    await store.update((state) => {
      state.orchestrator.livingCompositeId = "living";
      state.composites.push({ id: "living", title: "Year-long line", description: "", status: "open", branch: "burner/living", worktree: "", sources: [{ agentRunId: "seed-a", prNumber: 1, title: "A", branch: "a", kind: "pull_request" }, { agentRunId: "seed-b", prNumber: 2, title: "B", branch: "b", kind: "pull_request" }], deltas: [], compositeScore: 80, reviewRounds: [], reviewApproved: true, prNumber: 10, prUrl: "https://example.test/pull/10", createdAt: timestamp, updatedAt: timestamp, isLiving: true, pendingExperimentRunIds: [] });
      state.evaluationRuns.push({ id: "composite-eval", evaluationId: evaluation.id, score: 80, commit: "living-head", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite", compositeId: "living" });
      state.agentRuns.push({ id: "experiment", ideaId: "idea", status: "evaluating", branch: "burner/experiment", worktree: "/tmp/worktree", startedAt: timestamp, deltas: [], impact: 4, resources: [], reviewRounds: [], reviewApproved: true, baseRef: "burner/living", baseCommit: "living-head", parentCompositeId: "living" });
    });
    const pushed = [];
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.git = { fetchBranch: async () => "origin/burner/living", resolveRef: async () => "living-head", push: async (_cwd, _remote, branch) => pushed.push(branch) };
    const base = await orchestrator.resolveAgentBase({ id: "idea", title: "Experiment", description: "", rationale: "", predictedImpact: 1, evaluationIds: [], resources: [], status: "queued", createdAt: timestamp, updatedAt: timestamp, source: "manual", baseCompositeId: "living" }, store.get());
    assert.equal(base.compositeId, "living");
    assert.equal(base.baseline.get(evaluation.id).score, 80);
    await orchestrator.absorbExperiment("living", "experiment", { id: "idea", title: "Experiment", description: "", rationale: "", predictedImpact: 1, evaluationIds: [], resources: [], status: "running", createdAt: timestamp, updatedAt: timestamp, source: "manual" }, "/tmp/worktree", "burner/experiment", 4, store.get().settings);
    const state = store.get();
    const living = state.composites.find((item) => item.id === "living");
    assert.equal(state.agentRuns.find((item) => item.id === "experiment").status, "absorbed");
    assert.equal(living.status, "rebuilding");
    assert.equal(living.rebuildMode, "incremental");
    assert.deepEqual(living.pendingExperimentRunIds, ["experiment"]);
    assert.equal(living.sources.at(-1).kind, "experiment");
    assert.deepEqual(pushed, ["burner/experiment"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("state persists evaluation configuration and excludes candidate scores from baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-store-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const evaluation = store.get().evaluations[0];
    await store.update((state) => {
      state.evaluationRuns.push(
        { id: "baseline", evaluationId: evaluation.id, score: 61, commit: "a", createdAt: "2026-01-01T00:00:00.000Z", durationMs: 1, status: "completed", context: "manual" },
        { id: "candidate", evaluationId: evaluation.id, score: 99, commit: "b", createdAt: "2026-01-02T00:00:00.000Z", durationMs: 1, status: "completed", context: "agent" },
      );
    });
    assert.equal(store.latestRuns().get(evaluation.id)?.score, 61);
    const reloaded = new StateStore(root);
    await reloaded.init();
    assert.equal(reloaded.get().projectName, root.split("/").at(-1));
    assert.equal(reloaded.get().version, 3);
    assert.equal(reloaded.get().settings.maxReviewRounds, 8);
    assert.equal(reloaded.get().settings.portfolioReviewRounds, 3);
    assert.equal(reloaded.get().settings.mergeCadenceMinutes, 60);
    assert.equal(reloaded.get().settings.parallelism, 1);
    assert.equal(reloaded.latestRuns().get(evaluation.id)?.score, 61);
    assert.deepEqual(validateEvaluation({ name: " UX ", prompt: " Score it ", weight: 2 }), { name: "UX", prompt: "Score it", weight: 2, enabled: true });
    assert.deepEqual(validateEvaluation({ name: "Bench", prompt: "Score", command: " full ", screeningCommand: " quick " }), { name: "Bench", prompt: "Score", command: "full", screeningCommand: "quick", weight: 1, enabled: true });
    assert.throws(() => validateEvaluation({ name: "Bench", prompt: "Score", screeningCommand: "quick" }), /requires a full evaluation command/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
