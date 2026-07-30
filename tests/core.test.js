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
import { Orchestrator, selectYoloLeafBatch, selectYoloMergeCandidate } from "../dist/lib/orchestrator.js";
import { buildCompositePrBody, buildPrBody, GitService } from "../dist/lib/git.js";
import { createBurnerServer } from "../dist/server.js";
import { StateStore, validateEvaluation } from "../dist/lib/store.js";
import { clampScore, parseJsonObject, slugify, weightedScore } from "../dist/lib/utils.js";

const exec = (cwd, command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { cwd }, (error, stdout, stderr) => {
    if (error) reject(new Error(stderr || error.message));
    else resolve(stdout);
  });
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
    const evaluation = JSON.parse(await exec(root, "node", [cli, "eval", "add", "-C", root, "--name", "Correctness", "--prompt", "Score correctness out of 100", "--weight", "2"]));
    assert.equal(evaluation.name, "Correctness");
    const listed = JSON.parse(await exec(root, "node", [cli, "eval", "list", "-C", root]));
    assert.deepEqual(listed.map((item) => item.id), [evaluation.id]);
    const idea = JSON.parse(await exec(root, "node", [cli, "idea", "add", "-C", root, "--title", "Build core", "--description", "Implement the core", "--impact", "90", "--eval", evaluation.id, "--resource", "cpu"]));
    assert.equal(idea.predictedImpact, 90);
    assert.deepEqual(idea.evaluationIds, [evaluation.id]);
    assert.deepEqual(idea.resources, ["cpu"]);
    const settings = JSON.parse(await exec(root, "node", [cli, "settings", "set", "-C", root, "--parallelism", "1", "--max-review-rounds", "4", "--auto-create-prs", "true"]));
    assert.equal(settings.parallelism, 1);
    assert.equal(settings.maxReviewRounds, 4);
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

test("PR bodies record review approval and recalculated composite scores", () => {
  const rounds = [{ id: "r1", round: 1, commit: "abc", approved: true, summary: "Approved", findings: [], createdAt: new Date().toISOString() }];
  const deltas = [{ evaluationId: "quality", name: "Quality", before: 70, after: 82, delta: 12 }];
  assert.match(buildPrBody("Change", "Done", deltas, 12, rounds), /Approved by an independent Codex reviewer/);
  const body = buildCompositePrBody({ description: "Combined", sources: [{ agentRunId: "a", prNumber: 12, title: "A", branch: "a" }, { agentRunId: "b", prNumber: 13, title: "B", branch: "b" }], deltas, compositeScore: 82, impact: 12, reviewRounds: rounds });
  assert.match(body, /Composite score: 82\.0 \/ 100/);
  assert.match(body, /#12/);
  assert.match(body, /never inferred by adding individual deltas/);
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
  assert.deepEqual(selectYoloLeafBatch(state, "base", 3), ["a2", "a3", "a1"]);
  state.composites.push({ id: "composite", status: "queued", sources: [{ agentRunId: "a2" }] });
  assert.deepEqual(selectYoloLeafBatch(state, "base", 3), []);
  state.agentRuns.push(leaf("a4", 4));
  assert.deepEqual(selectYoloLeafBatch(state, "base", 3), ["a3", "a4", "a1"]);
  state.agentRuns[2].baseCommit = "old-base";
  assert.deepEqual(selectYoloLeafBatch(state, "base", 3), []);
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
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.git = {
      remoteExists: async () => true,
      listPullRequests: async () => [
        { number: 1, state: "OPEN", headRefName: "branch-a", url: "" }, { number: 2, state: "OPEN", headRefName: "branch-b", url: "" },
        { number: 3, state: "OPEN", headRefName: "branch-c", url: "" }, { number: 4, state: "OPEN", headRefName: "branch-d", url: "" },
        { number: 100, state: "MERGED", headRefName: "composite-merged", url: "" }, { number: 101, state: "OPEN", headRefName: "composite-overlap", url: "" },
      ],
      closePr: async (_cwd, number) => { closed.push(number); },
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
    assert.deepEqual(closed.sort(), [1, 2]);
    assert.equal(state.orchestrator.baseSyncPending, false);
    assert.equal(state.orchestrator.lastEvaluationAt, undefined);
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
    assert.equal(reloaded.get().settings.parallelism, 1);
    assert.equal(reloaded.latestRuns().get(evaluation.id)?.score, 61);
    assert.deepEqual(validateEvaluation({ name: " UX ", prompt: " Score it ", weight: 2 }), { name: "UX", prompt: "Score it", weight: 2, enabled: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
