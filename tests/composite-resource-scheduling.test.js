import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { EventHub } from "../dist/lib/events.js";
import { LockManager } from "../dist/lib/locks.js";
import { Orchestrator } from "../dist/lib/orchestrator.js";
import { StateStore } from "../dist/lib/store.js";
import { fixtureLeafPr, installLeafPrFixtureTransport } from "./leaf-pr-test-helpers.js";

const timestamp = "2026-09-01T00:00:00.000Z";
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
async function waitFor(predicate, message) {
  const deadline = performance.now() + 10_000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, message);
    await immediate();
  }
}
const compositeRecord = (id, status, sources = []) => ({ id, title: id, description: "Scheduling fixture", status,
  branch: id, worktree: "", baseCommit: "base", sources, deltas: [], reviewRounds: [], isLiving: false,
  createdAt: timestamp, updatedAt: timestamp });

async function fixture(t, { yolo = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "burner-composite-scheduling-"));
  const store = new StateStore(root);
  await store.init();
  await store.update((state) => { state.orchestrator.enabled = false; state.settings.parallelism = 1; state.evaluations = []; });
  const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo });
  const other = new LockManager(join(store.dataDir, "locks"));
  const starts = [];
  const reopened = [];
  const remotes = new Map();
  let nextPr = 10;
  orchestrator.git = { resolveRef: async (ref) => ref === "main" ? "base" : `${ref}-head`,
    reopenPr: async (_cwd, number) => { reopened.push(number); } };
  installLeafPrFixtureTransport(orchestrator.git, { observe: async (_cwd, number) => structuredClone(remotes.get(number)) });
  const finish = async (id) => {
    await store.update((state) => { state.composites.find((item) => item.id === id).status = "open"; });
    return "settled";
  };
  let build = finish;
  orchestrator.buildComposite = async (id, rebuild) => { starts.push({ id, rebuild }); return build(id, rebuild); };
  const addSources = async (prefix) => {
    const ids = [`${prefix}-first`, `${prefix}-second`];
    await store.update((state) => {
      for (const id of ids) {
        const fields = { title: id, body: "Owned source", isDraft: true, state: "OPEN" };
        const remote = { ...fields, number: nextPr++, url: `https://example.test/pr/${id}`, headRefName: id,
          headRefOid: `${id}-head`, mergeable: "MERGEABLE", statusCheckRollup: [] };
        remotes.set(remote.number, remote);
        const run = { id, ideaId: `idea-${id}`, status: "completed", branch: id, worktree: "", baseRef: "main", baseCommit: "base",
          startedAt: timestamp, completedAt: timestamp, prNumber: remote.number, prUrl: remote.url, prState: "open",
          deltas: [], reviewRounds: [], resources: ["gpu"] };
        run.leafPr = fixtureLeafPr(run, fields);
        run.continuation = { id: `done-${id}`, step: "done", outcome: "completed", head: remote.headRefOid, completedAt: timestamp,
          identity: orchestrator.continuationIdentity(run, state, remote) };
        state.agentRuns.push(run);
      }
    });
    return ids;
  };
  const create = async (prefix) => orchestrator.createComposite(await addSources(prefix), prefix, "Accepted fixture work", { makeLiving: false });
  const failed = async (id) => {
    const ids = await addSources(id);
    await store.update((state) => {
      const sources = ids.map((runId) => {
        const run = state.agentRuns.find((item) => item.id === runId);
        return { agentRunId: run.id, title: run.id, branch: run.branch, prNumber: run.prNumber, kind: "pull_request" };
      });
      state.composites.push({ ...compositeRecord(id, "failed", sources), prNumber: nextPr++,
        reviewRounds: [{ id: `${id}-review`, round: 1, commit: `${id}-head`, approved: false, findings: [], summary: "Prior review", createdAt: timestamp }] });
    });
  };
  const automatic = async (id, status = "rebuilding") => store.update((state) => { state.composites.push(compositeRecord(id, status)); });
  t.after(async () => { await orchestrator.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, orchestrator, other, starts, reopened, addSources, create, failed, automatic, finish,
    build: (callback) => { build = callback; } };
}

async function enableYoloPriority(f) {
  const current = new Date().toISOString();
  await f.store.update((state) => {
    state.orchestrator.enabled = true;
    state.orchestrator.lastEvaluationAt = current;
    state.orchestrator.lastPlanningAt = current;
    state.settings.stallTerminationHours = 0;
    state.evaluations = [{ id: "quality", name: "Quality", prompt: "Fixture quality", enabled: true, weight: 1,
      definitionVersion: "v1", createdAt: current }];
    state.evaluationRuns = [{ id: "baseline", evaluationId: "quality", score: 70, commit: "base", status: "completed",
      context: "baseline", promptSampleCount: 3, evaluationDefinitionVersion: "v1", createdAt: current, durationMs: 1 }];
  });
  f.orchestrator.syncPullRequests = async () => {};
  f.orchestrator.autoMergeNext = async () => false;
  f.orchestrator.autoCookNext = async () => false;
  f.orchestrator.shouldDrainForPortfolio = async () => true;
}

for (const occupied of ["agent capacity", "active composite"]) {
  test(`public creation behind ${occupied} retains only its exact accepted ID across the wakeup`, async (t) => {
    const f = await fixture(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await f.automatic("unrelated-rebuild");
    const slots = occupied === "agent capacity" ? f.orchestrator.activeAgents : f.orchestrator.activeComposites;
    slots.add("occupied-slot");
    const accepted = await f.create("created");
    assert.deepEqual(f.starts, []);
    assert.deepEqual([...f.orchestrator.compositeRequests.keys()], [accepted.id]);
    assert.ok(f.orchestrator.compositeWakeup);
    slots.delete("occupied-slot");
    t.mock.timers.tick(4_999);
    await immediate();
    assert.deepEqual(f.starts, []);
    t.mock.timers.tick(1);
    await waitFor(() => f.starts.length === 1 && !f.orchestrator.activeComposites.size, "accepted creation must retain its capacity wait");
    assert.deepEqual(f.starts, [{ id: accepted.id, rebuild: false }]);
    assert.equal(f.store.get().composites.find((item) => item.id === "unrelated-rebuild").status, "rebuilding");
    assert.equal(f.orchestrator.compositeRequests.size, 0);
    assert.equal(f.store.get().orchestrator.enabled, false);
  });
}

for (const rejection of ["source validation", "source identity", "source reservation"]) {
  for (const pendingWakeup of [false, true]) {
    test(`rejected ${rejection} cannot wake unrelated YOLO work${pendingWakeup ? " or replace its pending timer" : " during a priority decision"}`, async (t) => {
      const f = await fixture(t, { yolo: true });
      t.mock.timers.enable({ apis: ["setTimeout"] });
      await enableYoloPriority(f);
      const sourceIds = rejection === "source validation" ? ["missing-first", "missing-second"] : await f.addSources("unaccepted");
      await f.automatic("unrelated-rebuild");
      if (pendingWakeup) {
        f.build(async () => "deferred");
        await f.orchestrator.tick(false);
        await waitFor(() => f.starts.length === 1 && !f.orchestrator.activeComposites.size && f.orchestrator.compositeWakeup,
          "an automatic deferred attempt must own the existing wakeup");
        f.build(f.finish);
      }
      const beforeStarts = structuredClone(f.starts);
      const wakeup = f.orchestrator.compositeWakeup;
      assert.equal(Boolean(wakeup), pendingWakeup);
      assert.equal(f.orchestrator.compositeRequests.size, 0, "this scenario has no accepted manual requests");
      const external = new StateStore(f.root);
      await external.init({ recoverInterrupted: false });
      const enteredSync = deferred();
      const finishSync = deferred();
      let syncs = 0;
      f.orchestrator.syncPullRequests = async () => { syncs += 1; enteredSync.resolve(); await finishSync.promise; };
      const ticking = f.orchestrator.tick(false);
      const update = f.store.update.bind(f.store);
      const finishAdmission = deferred();
      let creation;
      try {
        await enteredSync.promise;
        if (rejection === "source validation") {
          await assert.rejects(f.orchestrator.createComposite(sourceIds, "Rejected request", "Never accepted", { makeLiving: false }),
            /Every composite source must be an open, nonterminal Burner pull request/);
        } else {
          const enteredAdmission = deferred();
          f.store.update = async (mutator) => {
            f.store.update = update;
            enteredAdmission.resolve();
            await finishAdmission.promise;
            return update(mutator);
          };
          creation = f.orchestrator.createComposite(sourceIds, "Rejected request", "Never accepted", { makeLiving: false })
            .then((value) => ({ value }), (error) => ({ error }));
          await enteredAdmission.promise;
          assert.equal(f.orchestrator.agentClaims.size, 2);
          await external.update((state) => {
            if (rejection === "source identity") state.agentRuns.find((run) => run.id === sourceIds[0]).branch += "-changed";
            else {
              const sources = sourceIds.map((id) => {
                const run = state.agentRuns.find((item) => item.id === id);
                return { agentRunId: id, title: id, branch: run.branch, prNumber: run.prNumber, kind: "pull_request" };
              });
              state.composites.push(compositeRecord("external-reservation", "queued", sources));
            }
          });
          finishAdmission.resolve();
          const result = await creation;
          assert.match(result.error?.message ?? "", /A composite source changed before admission/);
        }
        assert.deepEqual(f.starts, beforeStarts, "rejection must not dispatch work before the existing priority decision finishes");
        assert.equal(f.orchestrator.compositeWakeup, wakeup, "rejection must neither clear nor replace an existing wakeup");
        assert.equal(f.orchestrator.ticking, true);
        assert.equal(syncs, 1);
        assert.equal(f.orchestrator.compositeRequests.size, 0);
        assert.equal(f.orchestrator.agentClaims.size, 0);
        assert.deepEqual(f.store.get().composites.map((item) => item.id), rejection === "source reservation"
          ? ["unrelated-rebuild", "external-reservation"] : ["unrelated-rebuild"]);
        assert.equal(f.store.get().composites[0].status, "rebuilding");
        await f.orchestrator.setEnabled(false);
        finishSync.resolve();
        await ticking;
        t.mock.timers.tick(5_000);
        await immediate();
        assert.deepEqual(f.starts, beforeStarts, "a rejected request leaves no authority behind after pause");
      } finally {
        f.store.update = update;
        finishAdmission.resolve();
        await creation;
        await f.orchestrator.close();
        finishSync.resolve();
        await ticking;
      }
    });
  }
}

for (const fails of [false, true]) {
  test(`durably accepted creation waits for source claims while its activity ${fails ? "fails" : "is held"}`, async (t) => {
    const f = await fixture(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const entered = deferred();
    const finishActivity = deferred();
    const addActivity = f.store.addActivity.bind(f.store);
    f.store.addActivity = async (entry) => {
      if (entry.message.startsWith("Composite queued:")) {
        entered.resolve();
        await finishActivity.promise;
        if (fails) throw new Error("fixture post-admission activity failure");
      }
      return addActivity(entry);
    };
    f.build(async (id) => {
      assert.equal(f.orchestrator.agentClaims.size, 0, "the creator must release source claims before integration is admitted");
      return f.finish(id);
    });
    const creation = f.create("held-activity").then((value) => ({ value }), (error) => ({ error }));
    try {
      await entered.promise;
      const accepted = f.store.get().composites[0];
      assert.equal(accepted.status, "queued");
      assert.ok(f.orchestrator.compositeRequests.has(accepted.id));
      assert.equal(f.orchestrator.agentClaims.size, 2);
      assert.deepEqual(f.starts, []);
      t.mock.timers.tick(5_000);
      await immediate();
      assert.deepEqual(f.starts, [], "a timer cannot turn source reservations into integration authority");
      finishActivity.resolve();
      const result = await creation;
      if (fails) assert.match(result.error?.message ?? "", /post-admission activity failure/);
      else assert.equal(result.value.id, accepted.id);
      await waitFor(() => f.starts.length === 1 && !f.orchestrator.activeComposites.size, "the durable request must survive activity settlement");
      assert.deepEqual(f.starts, [{ id: accepted.id, rebuild: false }]);
      assert.equal(f.store.get().composites[0].status, "open");
      assert.equal(f.orchestrator.agentClaims.size, 0);
    } finally { finishActivity.resolve(); await creation; }
  });
}

for (const occupied of ["agent capacity", "active composite"]) {
  test(`public retry behind ${occupied} keeps its ID and cumulative review history`, async (t) => {
    const f = await fixture(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await f.automatic("unrelated-rebuild");
    await f.failed("retry-me");
    const previous = structuredClone(f.store.get().composites.find((item) => item.id === "retry-me"));
    const slots = occupied === "agent capacity" ? f.orchestrator.activeAgents : f.orchestrator.activeComposites;
    slots.add("occupied-slot");
    await f.orchestrator.retryComposite("retry-me");
    assert.deepEqual(f.starts, []);
    assert.deepEqual(f.reopened, [previous.prNumber]);
    assert.deepEqual([...f.orchestrator.compositeRequests.keys()], ["retry-me"]);
    slots.delete("occupied-slot");
    t.mock.timers.tick(5_000);
    await waitFor(() => f.starts.length === 1 && !f.orchestrator.activeComposites.size, "accepted retry must survive an active composite");
    assert.deepEqual(f.starts, [{ id: "retry-me", rebuild: true }]);
    assert.deepEqual(f.store.get().composites.find((item) => item.id === "retry-me").reviewRounds, previous.reviewRounds);
    assert.equal(f.store.get().composites.find((item) => item.id === "unrelated-rebuild").status, "rebuilding");
  });
}

test("accepted IDs retain rebuild-before-queued order without granting an earlier unrelated rebuild", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.orchestrator.activeAgents.add("occupied-slot");
  await f.automatic("unrelated-first");
  const queued = await f.create("accepted-queued");
  await f.failed("accepted-rebuild");
  await f.orchestrator.retryComposite("accepted-rebuild");
  assert.deepEqual(f.starts, []);
  f.orchestrator.activeAgents.delete("occupied-slot");
  t.mock.timers.tick(5_000);
  await waitFor(() => f.starts.length === 2 && !f.orchestrator.activeComposites.size, "both accepted records must settle");
  assert.deepEqual(f.starts, [{ id: "accepted-rebuild", rebuild: true }, { id: queued.id, rebuild: false }]);
  assert.equal(f.store.get().composites[0].status, "rebuilding");
  assert.equal(f.orchestrator.compositeRequests.size, 0);
});

test("an older completion cannot retire a newer public retry token for the same composite", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await f.failed("same-id");
  await f.automatic("unrelated");
  const firstFinish = deferred();
  f.build(async (id) => f.starts.length === 1 ? firstFinish.promise : f.finish(id));
  await f.orchestrator.retryComposite("same-id");
  await waitFor(() => f.starts.length === 1, "first retry must start");
  const oldToken = f.orchestrator.compositeRequests.get("same-id");
  await f.store.update((state) => { state.composites.find((item) => item.id === "same-id").status = "failed"; });
  await f.orchestrator.retryComposite("same-id");
  const newToken = f.orchestrator.compositeRequests.get("same-id");
  assert.ok(newToken);
  assert.notEqual(newToken, oldToken);
  await f.orchestrator.scheduleComposites();
  assert.equal(f.orchestrator.compositeRequests.get("same-id"), newToken, "active-attempt pruning must not erase the newer request");
  firstFinish.resolve("settled");
  await waitFor(() => f.starts.length === 2 && !f.orchestrator.activeComposites.size, "newer retry must run after old completion");
  assert.deepEqual(f.starts.map(({ id }) => id), ["same-id", "same-id"]);
  assert.equal(f.orchestrator.compositeRequests.size, 0);
  assert.equal(f.store.get().composites.find((item) => item.id === "unrelated").status, "rebuilding");
});

for (const tickState of ["pauses during sync", "is already running"]) {
  test(`enabled YOLO settlement retains accepted work when its wider tick ${tickState}`, async (t) => {
    const f = await fixture(t, { yolo: true });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const finishFirst = deferred();
    const enteredSync = deferred();
    const finishSync = deferred();
    let syncs = 0;
    f.orchestrator.syncPullRequests = async () => { syncs += 1; enteredSync.resolve(); await finishSync.promise; };
    f.build(async (id) => {
      if (f.starts.length === 1) await finishFirst.promise;
      return f.finish(id);
    });
    const first = await f.create("first-active");
    await f.store.update((state) => { state.orchestrator.enabled = true; });
    await f.automatic("unrelated-rebuild");
    const accepted = await f.create("accepted-second");
    const wakeup = f.orchestrator.compositeWakeup;
    assert.ok(wakeup);
    assert.deepEqual(f.starts.map(({ id }) => id), [first.id]);
    t.mock.timers.tick(2_000);
    let existingTick;
    try {
      if (tickState === "is already running") {
        existingTick = f.orchestrator.tick(false);
        await enteredSync.promise;
        assert.equal(f.orchestrator.ticking, true);
      }
      finishFirst.resolve();
      await enteredSync.promise;
      await waitFor(() => !f.orchestrator.activeComposites.size, "the first composite must settle while the wider tick awaits sync");
      assert.equal(syncs, 1, "an already-running tick is not replaced by the completion callback");
      assert.equal(f.orchestrator.compositeWakeup, wakeup, "settlement must preserve the original accepted-request deadline");
      await f.orchestrator.setEnabled(false);
      finishSync.resolve();
      await existingTick;
      await waitFor(() => !f.orchestrator.ticking, "the wider tick must observe pause after sync");
      assert.deepEqual(f.starts.map(({ id }) => id), [first.id]);
      t.mock.timers.tick(2_999);
      await immediate();
      assert.deepEqual(f.starts.map(({ id }) => id), [first.id]);
      t.mock.timers.tick(1);
      await waitFor(() => f.starts.length === 2 && !f.orchestrator.activeComposites.size, "accepted work must start at the original five-second deadline");
      assert.deepEqual(f.starts.map(({ id }) => id), [first.id, accepted.id]);
      assert.equal(f.store.get().composites.find((item) => item.id === "unrelated-rebuild").status, "rebuilding");
      assert.equal(f.store.get().composites.find((item) => item.id === accepted.id).status, "open");
      assert.equal(f.store.get().orchestrator.enabled, false);
      assert.equal(f.orchestrator.compositeRequests.size, 0);
    } finally { finishFirst.resolve(); finishSync.resolve(); await existingTick; }
  });
}

test("fresh and retried worker completions do not postpone an accepted YOLO request's existing deadline", async (t) => {
  const f = await fixture(t, { yolo: true });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const finishFirst = deferred();
  const enteredSync = deferred();
  const finishSync = deferred();
  let syncs = 0;
  f.orchestrator.syncPullRequests = async () => { syncs += 1; enteredSync.resolve(); await finishSync.promise; };
  f.build(async (id) => {
    if (f.starts.length === 1) await finishFirst.promise;
    return f.finish(id);
  });
  const first = await f.create("first-active");
  await f.store.update((state) => { state.orchestrator.enabled = true; });
  await f.automatic("unrelated-rebuild");
  const accepted = await f.create("accepted-second");
  const wakeup = f.orchestrator.compositeWakeup;
  assert.ok(wakeup);

  // Drive both public worker APIs and their real lease/claim/finalizer paths.
  // Leaf author/evidence work is outside this scheduler contract and is the
  // only downstream continuation replaced here.
  Object.assign(f.orchestrator.git, {
    status: async () => ({ available: true, dirty: false }),
    createWorktree: async (_id, branch) => join(f.root, branch),
    createExistingWorktree: async (_id, branch) => join(f.root, branch),
    assertWorktree: async () => {}, hasChanges: async () => false,
    head: async (cwd) => `${basename(cwd)}-head`,
  });
  f.orchestrator.resolveAgentBase = async () => ({ ref: "main", commit: "base", baseline: new Map() });
  const completedWorkers = [];
  f.orchestrator.continueLeaf = async (idea, _base, runId, claim) => {
    f.orchestrator.assertAgentClaim(claim, runId);
    assert.equal(await f.other.tryAcquire("worker-fixture", "probe"), undefined);
    await f.store.update((state) => {
      const run = state.agentRuns.find((item) => item.id === runId);
      run.status = "completed";
      run.completedAt = timestamp;
      run.continuation = { id: run.continuation.id, identity: run.continuation.identity, head: run.continuation.head,
        step: "done", outcome: "completed", completedAt: timestamp };
      state.ideas.find((item) => item.id === idea.id).status = "completed";
    });
    completedWorkers.push(idea.id);
  };
  const worker = async (id, retry = false) => {
    await f.store.update((state) => {
      state.ideas.push({ id, title: "Fixture worker", description: "Controlled continuation", rationale: "Scheduler regression",
        predictedImpact: 0, evaluationIds: [], resources: ["worker-fixture"], status: retry ? "failed" : "queued", source: "manual",
        createdAt: timestamp, updatedAt: timestamp, ...(retry ? { agentRunId: id } : {}) });
      if (retry) {
        const run = { id, ideaId: id, status: "failed", branch: id, worktree: "", baseRef: "main", baseCommit: "base",
          startedAt: timestamp, completedAt: timestamp, authorThreadId: "fixture-author", resources: ["worker-fixture"], deltas: [], reviewRounds: [] };
        run.continuation = { id: `leaf-${id}`, step: "evidence", head: `${id}-head`, identity: f.orchestrator.continuationIdentity(run, state) };
        state.agentRuns.push(run);
      }
    });
    const result = retry ? await f.orchestrator.retryAgent(id) : await f.orchestrator.runNextIdea();
    assert.equal(result.status, "completed", result.error);
    assert.equal(f.orchestrator.activeAgents.size, 0);
    assert.equal(f.orchestrator.agentClaims.size, 0);
    assert.deepEqual(await f.other.list(), []);
    assert.equal(f.orchestrator.compositeWakeup, wakeup, "a genuine worker completion must not reset the pending deadline");
  };
  try {
    finishFirst.resolve();
    await enteredSync.promise;
    await waitFor(() => !f.orchestrator.activeComposites.size, "the first composite must settle");
    for (const [id, retry] of [["fresh-one", false], ["retried-worker", true], ["fresh-two", false]]) {
      t.mock.timers.tick(1_000);
      await worker(id, retry);
      assert.deepEqual(f.starts.map(({ id: compositeId }) => compositeId), [first.id]);
    }
    assert.deepEqual(completedWorkers, ["fresh-one", "retried-worker", "fresh-two"]);
    assert.equal(syncs, 1, "worker completion wakes must not create a competing wide tick");
    await f.orchestrator.setEnabled(false);
    finishSync.resolve();
    await waitFor(() => !f.orchestrator.ticking, "the original tick must observe pause");
    t.mock.timers.tick(1_999);
    await immediate();
    assert.equal(f.starts.length, 1);
    t.mock.timers.tick(1);
    await waitFor(() => f.starts.length === 2 && !f.orchestrator.activeComposites.size, "repeated completion must not postpone the original five-second wakeup");
    assert.deepEqual(f.starts.map(({ id }) => id), [first.id, accepted.id]);
    assert.equal(f.store.get().composites.find((item) => item.id === "unrelated-rebuild").status, "rebuilding");
    assert.equal(f.store.get().orchestrator.enabled, false);
  } finally { finishFirst.resolve(); finishSync.resolve(); }
});

for (const boundary of ["sync", "base resolution"]) {
  test(`enabled YOLO timer expiry waits for an in-flight ${boundary} priority decision`, async (t) => {
    const f = await fixture(t, { yolo: true });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const finishFirst = deferred();
    const entered = deferred();
    const finishDecision = deferred();
    let decisions = 0;
    f.build(async (id) => {
      if (f.starts.length === 1) await finishFirst.promise;
      return f.finish(id);
    });
    const first = await f.create("first-active");
    await enableYoloPriority(f);
    const blockDecision = async () => {
      if (++decisions === 1) { entered.resolve(); await finishDecision.promise; }
    };
    if (boundary === "sync") f.orchestrator.syncPullRequests = blockDecision;
    else {
      const resolve = f.orchestrator.git.resolveRef;
      f.orchestrator.git.resolveRef = async (ref) => {
        if (ref === "main") await blockDecision();
        return resolve(ref);
      };
    }
    const accepted = await f.create("accepted-second");
    try {
      finishFirst.resolve();
      await entered.promise;
      await waitFor(() => !f.orchestrator.activeComposites.size, "the first build must settle before the blocked decision");
      for (let expiry = 0; expiry < 2; expiry += 1) {
        const previousWakeup = f.orchestrator.compositeWakeup;
        assert.ok(previousWakeup);
        t.mock.timers.tick(5_000);
        await waitFor(() => f.orchestrator.compositeWakeup && f.orchestrator.compositeWakeup !== previousWakeup,
          "a busy wide tick must retain one future wakeup");
        assert.equal(f.orchestrator.ticking, true);
        assert.equal(decisions, 1, "timer ticks must not run a second concurrent priority decision");
        assert.deepEqual(f.starts.map(({ id }) => id), [first.id], "elapsed time alone cannot authorize the next build");
      }
      finishDecision.resolve();
      await waitFor(() => f.starts.length === 2 && !f.orchestrator.activeComposites.size && !f.orchestrator.ticking,
        "a completed priority decision must consume the pending wakeup without timer/tick phase-lock");
      assert.deepEqual(f.starts.map(({ id }) => id), [first.id, accepted.id]);
      assert.equal(f.store.get().composites.find((item) => item.id === accepted.id).status, "open");
    } finally { finishFirst.resolve(); finishDecision.resolve(); }
  });
}

test("enabled YOLO timer expiry cannot overtake a qualified merge and the next wake dispatches accepted work", async (t) => {
  const f = await fixture(t, { yolo: true });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const finishFirst = deferred();
  const enteredMerge = deferred();
  const finishMerge = deferred();
  const order = [];
  f.build(async (id) => {
    if (f.starts.length === 1) await finishFirst.promise;
    else order.push("accepted-build");
    return f.finish(id);
  });
  const first = await f.create("first-active");
  await enableYoloPriority(f);
  await f.store.update((state) => {
    state.composites.push({ ...compositeRecord("qualified", "open"), prNumber: 900, reviewApproved: true, impact: 1,
      reviewRounds: [{ round: 1, approved: true, findings: [], summary: "Reviewed" }],
      deltas: [{ evaluationId: "quality", before: 70, after: 71, delta: 1 }] });
  });
  f.orchestrator.autoMergeNext = async () => {
    if (f.store.get().composites.find((item) => item.id === "qualified").status !== "open") return false;
    order.push("merge-start");
    enteredMerge.resolve();
    await finishMerge.promise;
    await f.store.update((state) => { state.composites.find((item) => item.id === "qualified").status = "merged"; });
    order.push("merge-complete");
    return true;
  };
  const accepted = await f.create("accepted-second");
  try {
    finishFirst.resolve();
    await enteredMerge.promise;
    for (let expiry = 0; expiry < 2; expiry += 1) {
      const previousWakeup = f.orchestrator.compositeWakeup;
      t.mock.timers.tick(5_000);
      await waitFor(() => f.orchestrator.compositeWakeup && f.orchestrator.compositeWakeup !== previousWakeup,
        "a merge in progress must keep a bounded wakeup");
      assert.deepEqual(f.starts.map(({ id }) => id), [first.id]);
      assert.deepEqual(order, ["merge-start"], "no competing merge or integration may cross the live merge boundary");
    }
    finishMerge.resolve();
    await waitFor(() => !f.orchestrator.ticking, "the qualified merge must finish before any integration decision");
    assert.deepEqual(order, ["merge-start", "merge-complete"]);
    t.mock.timers.tick(4_999);
    await immediate();
    assert.equal(f.starts.length, 1);
    t.mock.timers.tick(1);
    await waitFor(() => f.starts.length === 2 && !f.orchestrator.activeComposites.size,
      "the next bounded tick must dispatch accepted work after the qualified merge");
    assert.deepEqual(f.starts.map(({ id }) => id), [first.id, accepted.id]);
    assert.deepEqual(order, ["merge-start", "merge-complete", "accepted-build"]);
  } finally { finishFirst.resolve(); finishMerge.resolve(); }
});

test("a timer-started YOLO tick that observes pause during sync retains one bounded accepted-request wake", async (t) => {
  const f = await fixture(t, { yolo: true });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await enableYoloPriority(f);
  const enteredSync = deferred();
  const finishSync = deferred();
  f.orchestrator.syncPullRequests = async () => { enteredSync.resolve(); await finishSync.promise; };
  f.orchestrator.activeAgents.add("occupied-slot");
  await f.automatic("unrelated-rebuild");
  const accepted = await f.create("accepted-after-pause");
  f.orchestrator.activeAgents.delete("occupied-slot");
  try {
    t.mock.timers.tick(5_000);
    await enteredSync.promise;
    assert.equal(f.orchestrator.ticking, true);
    assert.deepEqual(f.starts, []);
    await f.orchestrator.setEnabled(false);
    finishSync.resolve();
    await waitFor(() => !f.orchestrator.ticking && f.orchestrator.compositeWakeup,
      "the timer tick finalizer must retain accepted work after observing pause");
    t.mock.timers.tick(4_999);
    await immediate();
    assert.deepEqual(f.starts, []);
    t.mock.timers.tick(1);
    await waitFor(() => f.starts.length === 1 && !f.orchestrator.activeComposites.size,
      "the next paused wake must dispatch only the accepted ID");
    assert.deepEqual(f.starts, [{ id: accepted.id, rebuild: false }]);
    assert.equal(f.store.get().composites.find((item) => item.id === "unrelated-rebuild").status, "rebuilding");
    assert.equal(f.store.get().orchestrator.enabled, false);
  } finally { finishSync.resolve(); }
});

for (const incomplete of ["missing", "unconfirmed"]) {
  test(`enabled YOLO timer preserves the ${incomplete} baseline gate until confirmed evidence exists`, async (t) => {
    const f = await fixture(t, { yolo: true });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await enableYoloPriority(f);
    await f.store.update((state) => {
      if (incomplete === "missing") state.evaluationRuns = [];
      else state.evaluationRuns[0].promptSampleCount = 1;
    });
    f.orchestrator.shouldDrainForPortfolio = async () => false;
    f.orchestrator.plan = async () => assert.fail("incomplete baselines must not reach planning");
    let syncs = 0;
    f.orchestrator.syncPullRequests = async () => { syncs += 1; };
    f.orchestrator.activeAgents.add("occupied-slot");
    const accepted = await f.create("baseline-gated");
    f.orchestrator.activeAgents.delete("occupied-slot");
    for (let expiry = 1; expiry <= 2; expiry += 1) {
      t.mock.timers.tick(5_000);
      await waitFor(() => syncs === expiry && !f.orchestrator.ticking && f.orchestrator.compositeWakeup,
        "an incomplete baseline must defer to a future tick");
      assert.deepEqual(f.starts, []);
      assert.equal(f.orchestrator.missingBaselineEvaluations("base").length, 1);
    }
    assert.ok(f.store.get().activity.some((entry) => entry.message === "Agent scheduling deferred: baseline incomplete"));
    await f.store.update((state) => {
      state.evaluationRuns = [{ id: "confirmed-baseline", evaluationId: "quality", score: 70, commit: "base", status: "completed",
        context: "baseline", promptSampleCount: 3, evaluationDefinitionVersion: "v1", createdAt: new Date().toISOString(), durationMs: 1 }];
    });
    f.orchestrator.shouldDrainForPortfolio = async () => true;
    t.mock.timers.tick(5_000);
    await waitFor(() => f.starts.length === 1 && !f.orchestrator.activeComposites.size, "confirmed baseline must unblock the next priority-checked tick");
    assert.deepEqual(f.starts, [{ id: accepted.id, rebuild: false }]);
    assert.equal(f.orchestrator.missingBaselineEvaluations("base").length, 0);
  });
}

test("enabled YOLO resource contention retries once per bounded wake without recursive tick spin", async (t) => {
  const f = await fixture(t, { yolo: true });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await enableYoloPriority(f);
  let syncs = 0;
  f.orchestrator.syncPullRequests = async () => { syncs += 1; };
  const held = await f.other.acquire("gpu", "existing-work");
  f.build(async (id) => {
    const lease = await f.orchestrator.locks.tryAcquireAll(["composite-build", "gpu"], id);
    if (!lease) return "deferred";
    try { return await f.finish(id); } finally { await lease.release(); }
  });
  f.orchestrator.activeAgents.add("occupied-slot");
  const accepted = await f.create("busy-priority-checked");
  f.orchestrator.activeAgents.delete("occupied-slot");
  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      t.mock.timers.tick(4_999);
      await immediate();
      assert.equal(f.starts.length, attempt - 1);
      t.mock.timers.tick(1);
      await waitFor(() => f.starts.length === attempt && !f.orchestrator.activeComposites.size && !f.orchestrator.ticking && f.orchestrator.compositeWakeup,
        "a busy attempt must release its slot and arm one bounded wake");
      for (let flush = 0; flush < 5; flush += 1) await immediate();
      assert.equal(f.starts.length, attempt, "settling a deferred attempt must not recursively invoke another tick");
      assert.equal(syncs, attempt);
      assert.deepEqual(await f.other.list(), ["gpu"]);
    }
    await held.release();
    t.mock.timers.tick(5_000);
    await waitFor(() => f.starts.length === 3 && !f.orchestrator.activeComposites.size, "free resources must unblock the next bounded priority-checked attempt");
    assert.deepEqual(f.starts.map(({ id }) => id), [accepted.id, accepted.id, accepted.id]);
    assert.equal(f.store.get().composites.find((item) => item.id === accepted.id).status, "open");
    assert.deepEqual(await f.other.list(), []);
  } finally { await held.release(); }
});

test("busy accepted work has one bounded wakeup and continues through pause without admitting unrelated work", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const held = await f.other.acquire("gpu", "existing-work");
  f.build(async (id) => {
    const lease = await f.orchestrator.locks.tryAcquireAll(["composite-build", "gpu"], id);
    if (!lease) return "deferred";
    try { return await f.finish(id); } finally { await lease.release(); }
  });
  const accepted = await f.create("busy");
  await waitFor(() => f.starts.length === 1 && !f.orchestrator.activeComposites.size, "first busy attempt must relinquish its slot");
  await f.automatic("unrelated");
  await f.orchestrator.setEnabled(false);
  const timer = f.orchestrator.compositeWakeup;
  assert.ok(timer);
  for (let i = 0; i < 10; i += 1) await f.orchestrator.scheduleComposites();
  assert.equal(f.orchestrator.compositeWakeup, timer);
  assert.equal(f.starts.length, 1);
  assert.deepEqual(await f.other.list(), ["gpu"]);
  t.mock.timers.tick(4_999);
  await immediate();
  assert.equal(f.starts.length, 1);
  t.mock.timers.tick(1);
  await waitFor(() => f.starts.length === 2 && !f.orchestrator.activeComposites.size, "one retry is due at five seconds");
  assert.ok(f.orchestrator.compositeWakeup);
  assert.deepEqual(await f.other.list(), ["gpu"]);
  await held.release();
  t.mock.timers.tick(5_000);
  await waitFor(() => f.starts.length === 3 && !f.orchestrator.activeComposites.size, "accepted paused work must resume when the resource is free");
  assert.deepEqual(f.starts.map(({ id }) => id), [accepted.id, accepted.id, accepted.id]);
  assert.equal(f.store.get().composites.find((item) => item.id === accepted.id).status, "open");
  assert.equal(f.store.get().composites.find((item) => item.id === "unrelated").status, "rebuilding");
  assert.equal(f.store.get().orchestrator.enabled, false);
  assert.deepEqual(await f.other.list(), []);
});

test("an automatic busy attempt does not gain accepted authority when its timer fires after pause", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await f.automatic("automatic");
  await f.store.update((state) => { state.orchestrator.enabled = true; });
  const held = await f.other.acquire("gpu", "existing-work");
  f.build(async (id) => {
    const lease = await f.orchestrator.locks.tryAcquireAll(["gpu"], id);
    if (!lease) return "deferred";
    try { return await f.finish(id); } finally { await lease.release(); }
  });
  await f.orchestrator.scheduleComposites();
  await waitFor(() => f.starts.length === 1 && !f.orchestrator.activeComposites.size, "automatic busy attempt must defer");
  await f.orchestrator.setEnabled(false);
  await held.release();
  t.mock.timers.tick(5_000);
  await immediate();
  assert.equal(f.starts.length, 1);
  assert.equal(f.orchestrator.compositeRequests.size, 0);
  assert.equal(f.orchestrator.compositeWakeup, undefined);
  assert.equal(f.store.get().composites[0].status, "rebuilding");
});

test("close cancels accepted capacity wakeups and later callbacks cannot dispatch", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.orchestrator.activeAgents.add("occupied");
  await f.create("close-me");
  assert.ok(f.orchestrator.compositeWakeup);
  await f.orchestrator.close();
  f.orchestrator.activeAgents.delete("occupied");
  t.mock.timers.tick(15_000);
  await f.orchestrator.scheduleComposites();
  assert.deepEqual(f.starts, []);
  assert.equal(f.orchestrator.compositeRequests.size, 0);
  assert.equal(f.orchestrator.compositeWakeup, undefined);
});

test("close leaves an active build's lease owned until settlement and its completion cannot start a successor", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const finishBuild = deferred();
  let lease;
  f.build(async (id) => {
    lease = await f.orchestrator.locks.tryAcquireAll(["gpu"], id);
    assert.ok(lease);
    try { await finishBuild.promise; return await f.finish(id); }
    finally { await lease.release(); }
  });
  const first = await f.create("active-owner");
  try {
    await waitFor(() => Boolean(lease), "the active build must own its lease");
    const successor = await f.create("waiting-successor");
    await f.orchestrator.close();
    assert.equal(await f.other.tryAcquire("gpu", "after-close"), undefined, "close does not release another owner's protected work");
    assert.equal(f.orchestrator.compositeWakeup, undefined);
    finishBuild.resolve();
    await waitFor(() => !f.orchestrator.activeComposites.size, "the active build must be allowed to settle");
    t.mock.timers.tick(10_000);
    await f.orchestrator.scheduleComposites();
    assert.deepEqual(f.starts.map(({ id }) => id), [first.id]);
    assert.equal(f.store.get().composites.find((item) => item.id === successor.id).status, "queued");
    assert.deepEqual(await f.other.list(), []);
  } finally { finishBuild.resolve(); }
});

for (const fromTimer of [false, true]) {
  test(`failed cleanup fences successors and existing timers${fromTimer ? " after a timer-dispatched attempt" : ""}`, async (t) => {
    const f = await fixture(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const finishBuild = deferred();
    let owned;
    let release;
    f.build(async (id) => {
      if (fromTimer && f.starts.length === 1) return "deferred";
      owned = await f.orchestrator.locks.tryAcquireAll(["gpu"], id);
      assert.ok(owned);
      release = owned.locks[0].release;
      owned.locks[0].release = async () => { throw new Error("fixture cleanup failure"); };
      await finishBuild.promise;
      await f.finish(id);
      await owned.release();
      return "settled";
    });
    try {
      const first = await f.create("cleanup-owner");
      if (fromTimer) {
        await waitFor(() => !f.orchestrator.activeComposites.size && f.orchestrator.compositeWakeup, "initial deferral must arm the timer");
        t.mock.timers.tick(5_000);
      }
      await waitFor(() => Boolean(owned), "the active attempt must own its actual lease");
      const successor = await f.create("successor");
      assert.ok(f.orchestrator.compositeRequests.has(successor.id));
      assert.ok(f.orchestrator.compositeWakeup, "the active slot left a real successor timer to cancel");
      finishBuild.resolve();
      await waitFor(() => f.orchestrator.compositeAdmissionClosed && !f.orchestrator.activeComposites.size, "failed release must fence admission");
      assert.equal(f.orchestrator.compositeWakeup, undefined);
      assert.equal(f.orchestrator.compositeRequests.size, 0);
      assert.ok(f.store.get().activity.some((entry) => entry.type === "error" && /cleanup failure|release all acquired/.test(entry.detail ?? "")));
      t.mock.timers.tick(20_000);
      await f.orchestrator.scheduleComposites();
      assert.deepEqual(f.starts.map(({ id }) => id), fromTimer ? [first.id, first.id] : [first.id]);
      assert.equal(f.store.get().composites.find((item) => item.id === successor.id).status, "queued");
      assert.equal(await f.other.tryAcquire("gpu", "successor-probe"), undefined, "failed cleanup has not manufactured quiescence");
    } finally {
      finishBuild.resolve();
      if (owned) { owned.locks[0].release = release; await owned.release(); }
    }
  });
}
