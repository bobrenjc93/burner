import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventHub } from "../dist/lib/events.js";
import { Orchestrator } from "../dist/lib/orchestrator.js";
import { StateStore } from "../dist/lib/store.js";

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "burner-composite-priority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(root);
  await store.init();
  const timestamp = new Date().toISOString();
  await store.update((state) => {
    state.settings.stallTerminationHours = 0;
    state.settings.parallelism = 3;
    state.orchestrator.enabled = options.enabled ?? true;
    state.orchestrator.lastEvaluationAt = timestamp;
    state.orchestrator.lastPlanningAt = timestamp;
    state.evaluations = [{
      id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true,
      createdAt: timestamp, definitionVersion: "v1",
    }];
    state.evaluationRuns = [{
      id: "baseline", evaluationId: "quality", score: 90, commit: "base",
      status: "completed", context: "baseline", promptSampleCount: 3,
      evaluationDefinitionVersion: "v1", createdAt: timestamp, durationMs: 1,
    }];
    state.composites = options.noQueue ? [] : [{
      id: "repair", title: "Queued repair", description: "", status: options.status ?? "queued",
      branch: "burner/repair", worktree: "", sources: [], deltas: [], reviewRounds: [],
      createdAt: timestamp, updatedAt: timestamp,
    }];
  });
  const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: options.yolo ?? true, yoloBatchSize: 2 });
  const calls = [];
  orchestrator.syncPullRequests = async () => {};
  orchestrator.recordCadenceBreach = async () => {};
  orchestrator.git = { resolveRef: async () => "base" };
  orchestrator.autoMergeNext = async () => { calls.push("merge"); return true; };
  orchestrator.autoCookNext = async () => { calls.push("cook"); return true; };
  orchestrator.shouldDrainForPortfolio = async () => { calls.push("drain"); return true; };
  orchestrator.scheduleComposites = async (force) => { calls.push(["composites", force]); };
  orchestrator.schedule = async () => { calls.push("authors"); };
  return { store, orchestrator, calls };
}

for (const status of ["queued", "rebuilding"]) {
  test(`idle YOLO prioritizes a ${status} composite over unrelated leaf validation`, async (t) => {
    const { orchestrator, calls } = await fixture(t, { status });
    await orchestrator.tick();
    assert.deepEqual(calls, [["composites", undefined]], "use normal composite scheduling without bypassing pause or resource gates");
  });
}

test("paused YOLO does not dispatch queued composites or validate leaves", async (t) => {
  const { orchestrator, calls } = await fixture(t, { enabled: false });
  await orchestrator.tick();
  assert.deepEqual(calls, []);
});

test("idle YOLO retains leaf validation priority when no composite is queued", async (t) => {
  const { orchestrator, calls } = await fixture(t, { noQueue: true });
  await orchestrator.tick();
  assert.deepEqual(calls, ["merge"]);
});

test("qualified composites retain merge priority over queued integrations", async (t) => {
  for (const kind of ["qualified", "old-base", "unreviewed", "regressed", "incomplete", "closed"]) {
    const { store, orchestrator, calls } = await fixture(t);
    await store.update((state) => {
      state.composites.push({
        ...state.composites[0], id: "ready", status: kind === "closed" ? "closed" : "open", prNumber: 20,
        baseCommit: kind === "old-base" ? "old-base" : "base",
        reviewApproved: kind !== "unreviewed",
        reviewRounds: [{ round: 1, approved: kind !== "unreviewed", findings: [], summary: "Reviewed" }],
        impact: kind === "regressed" ? -1 : 1,
        deltas: kind === "incomplete" ? [] : [{ evaluationId: "quality", before: 90, after: kind === "regressed" ? 89 : 91, delta: kind === "regressed" ? -1 : 1 }],
      });
    });
    await orchestrator.tick();
    assert.deepEqual(calls, kind === "qualified" ? ["merge"] : [["composites", undefined]], kind);
  }
});

test("manual cycles retain their existing order with a queued composite", async (t) => {
  for (const enabled of [false, true]) {
    const { orchestrator, calls } = await fixture(t, { enabled });
    await orchestrator.tick(true);
    assert.deepEqual(calls, ["merge"]);
  }
});

test("queued composite priority does not bypass active work or non-YOLO scheduling", async (t) => {
  for (const [kind, expected] of [["author", "cook"], ["evaluation", "drain"], ["composite", "drain"], ["non-yolo", "drain"]]) {
    const { orchestrator, calls } = await fixture(t, { yolo: kind !== "non-yolo" });
    if (kind === "author") orchestrator.activeAgents.add("active-author");
    if (kind === "evaluation") orchestrator.runningEvaluations = 1;
    if (kind === "composite") orchestrator.activeComposites.add("active-composite");
    await orchestrator.tick();
    assert.deepEqual(calls, [expected], kind);
  }
});

test("queued composites do not bypass missing, stale, or unconfirmed baselines", async (t) => {
  for (const kind of ["missing", "old-base", "old-definition", "unconfirmed", "screening"]) {
    const { store, orchestrator, calls } = await fixture(t);
    await store.update((state) => {
      if (kind === "missing") state.evaluationRuns = [];
      if (kind === "old-base") state.evaluationRuns[0].commit = "old-base";
      if (kind === "old-definition") state.evaluations[0].definitionVersion = "v2";
      if (kind === "unconfirmed") state.evaluationRuns[0].promptSampleCount = 1;
      if (kind === "screening") state.evaluations[0].screeningCommand = "./screen";
    });
    assert.equal(orchestrator.missingBaselineEvaluations("base").length, 1, kind);
    await orchestrator.tick();
    assert.deepEqual(calls, ["merge"], "incomplete baselines must retain the existing path and its validation gates");
  }
});

test("queued composite priority rechecks pause and active work after resolving the base", async (t) => {
  for (const kind of ["pause", "author", "evaluation", "composite"]) {
    const { store, orchestrator, calls } = await fixture(t);
    orchestrator.git.resolveRef = async () => {
      if (kind === "pause") await store.update((state) => { state.orchestrator.enabled = false; });
      if (kind === "author") orchestrator.activeAgents.add("late-author");
      if (kind === "evaluation") orchestrator.runningEvaluations = 1;
      if (kind === "composite") orchestrator.activeComposites.add("late-composite");
      return "base";
    };
    await orchestrator.tick();
    assert.deepEqual(calls, [], kind);
  }
});

test("queued composite priority rechecks baseline definitions after resolving the base", async (t) => {
  const { store, orchestrator, calls } = await fixture(t);
  orchestrator.git.resolveRef = async () => {
    await store.update((state) => { state.evaluations[0].definitionVersion = "v2"; });
    return "base";
  };
  await orchestrator.tick();
  assert.deepEqual(calls, ["merge"]);
});

test("reserved composite sources do not also dispatch same-PR base refreshes", async (t) => {
  const reservedStatuses = ["queued", "building", "reviewing", "revising", "evaluating", "rebuilding", "open"];
  for (const status of [...reservedStatuses, "failed", "closed", "merged"]) {
    const { store, orchestrator } = await fixture(t, { status });
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      for (const id of ["reserved", "unrelated"]) {
        state.ideas.push({
          id: `idea-${id}`, title: id, description: "Refresh retained work", rationale: "No orphan PRs",
          predictedImpact: 1, evaluationIds: [], resources: [], status: "failed", source: "manual",
          createdAt: timestamp, updatedAt: timestamp, agentRunId: id,
        });
        state.agentRuns.push({
          id, ideaId: `idea-${id}`, status: "failed", branch: `burner/${id}`, worktree: "",
          startedAt: timestamp, completedAt: timestamp, deltas: [], resources: [], authorThreadId: `author-${id}`,
          baseRef: "main", baseCommit: "old-base", prNumber: id === "reserved" ? 10 : 11, prState: "open",
          error: "Base advanced to base; same-PR refresh pending.", reviewApproved: true,
          reviewRounds: [{ round: 1, commit: "head", approved: true, summary: "Approved", findings: [], createdAt: timestamp }],
        });
      }
      state.composites[0].sources = [{ agentRunId: "reserved", prNumber: 10, title: "Reserved source", branch: "burner/reserved", kind: "pull_request" }];
    });
    const refreshed = [];
    orchestrator.refreshAgentBaseAndRetry = async (id) => { refreshed.push(id); };
    const expected = reservedStatuses.includes(status) ? ["unrelated"] : ["reserved", "unrelated"];
    assert.deepEqual(orchestrator.pendingBaseRefreshes(store.get()).map((run) => run.id), expected, status);
    assert.equal(orchestrator.schedulePendingBaseRefreshes("base"), expected.length, status);
    assert.deepEqual(refreshed, expected, "unreserved work stays eligible, and terminal composites release their sources");
  }
});
