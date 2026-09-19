import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { EventHub } from "../dist/lib/events.js";
import { LockManager } from "../dist/lib/locks.js";
import { Orchestrator } from "../dist/lib/orchestrator.js";
import { StateStore } from "../dist/lib/store.js";

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

// Resource admission is real. Git/model IO and previously validated leaf
// consumption are controlled boundaries; the existing public source fixture
// independently exercises immutable source receipts and real Git ancestry.
async function fixture(t, mode = "fresh") {
  const root = await mkdtemp(join(tmpdir(), "burner-composite-resources-"));
  const worktree = join(root, "fixture-worktree");
  const store = new StateStore(root);
  await store.init();
  const orchestrator = new Orchestrator(root, store, new EventHub());
  const other = new LockManager(join(store.dataDir, "locks"));
  const calls = { phases: [], merges: [], worktrees: [], cleanups: [] };
  const controls = { base: "base", acquired: undefined };
  const required = ["composite-build", "cpu-heavy", "gpu", "living-ancestor", "living-combined", "project-default", "source-second"];
  const sources = ["first", "second"].map((id) => ({ agentRunId: id, title: id, branch: id, kind: "experiment" }));
  await store.update((state) => {
    state.orchestrator.enabled = true;
    Object.assign(state.settings, { defaultResources: ["project-default"], preferLivingComposite: false, compositeAbsorbThreshold: 0 });
    state.evaluations = [{ id: "quality", name: "Quality", prompt: "Fixture quality", weight: 1, enabled: true, definitionVersion: "v1", createdAt: timestamp }];
    const baseline = { id: "baseline", evaluationId: "quality", score: 70, promptSampleCount: 3,
      evaluationDefinitionVersion: "v1", commit: "base", context: "baseline", status: "completed", durationMs: 1, createdAt: timestamp };
    state.evaluationRuns = [baseline, { ...baseline, id: "previous-composite", context: "composite", compositeId: "combined", commit: "previous-head" }];
    state.agentRuns = sources.map((source, index) => ({ id: source.agentRunId, ideaId: `idea-${source.agentRunId}`,
      branch: source.branch, worktree: "", status: "absorbed", baseRef: "main", baseCommit: "base", parentCompositeId: "combined",
      startedAt: timestamp, completedAt: timestamp, deltas: [], reviewRounds: [],
      resources: index === 0 ? ["gpu", "cpu/heavy", "living-ancestor"] : ["cpu-heavy", "source-second", "living-combined"] }));
    state.composites = [{ id: "combined", title: "Combined", description: "Resource fixture", branch: "combined", worktree: "",
      status: mode === "fresh" ? "queued" : "rebuilding", baseCommit: "base", sources,
      deltas: [], reviewRounds: [], isLiving: true, createdAt: timestamp, updatedAt: timestamp,
      ...(mode === "fresh" ? {} : { prNumber: 41, prUrl: "https://example.test/pr/41" }),
      ...(mode === "resume" ? { rebuildMode: "resume" } : {}),
      ...(mode === "incremental" ? { rebuildMode: "incremental", pendingExperimentRunIds: ["second"] } : {}),
      ...(mode === "checkpoint" ? { rebuildMode: "from_base", checkpointBranch: "checkpoint-combined" } : {}),
    }];
  });
  const assertOwned = async (phase) => {
    calls.phases.push(phase);
    for (const name of required) {
      const unexpected = await other.tryAcquire(name, `probe-${phase}`);
      if (unexpected) await unexpected.release();
      assert.equal(unexpected, undefined, `${phase} must exclude another manager from ${name}`);
    }
    assert.deepEqual((await other.list()).filter((name) => name !== "git-metadata").sort(), [...required].sort());
  };
  const acquireAll = orchestrator.locks.tryAcquireAll.bind(orchestrator.locks);
  orchestrator.locks.tryAcquireAll = async (...args) => {
    const lease = await acquireAll(...args);
    if (lease) controls.acquired = lease;
    return lease;
  };
  const acquire = orchestrator.locks.acquire.bind(orchestrator.locks);
  orchestrator.locks.acquire = async (name, ...args) => {
    assert.notEqual(name, "cpu-heavy", "evaluations must borrow the admitted CPU handle, not reacquire it");
    return acquire(name, ...args);
  };
  orchestrator.git = {
    status: async () => ({ available: true, dirty: false }),
    resolveRef: async (ref) => ref === "main" ? controls.base : `${ref}-head`,
    head: async (cwd) => cwd === root ? controls.base : "combined-head",
    tree: async (head) => `${head}-tree`, hasChanges: async () => false,
    createWorktree: async () => { calls.worktrees.push("fresh"); await assertOwned("create"); return worktree; },
    createExistingWorktree: async () => { calls.worktrees.push("existing"); await assertOwned("create"); return worktree; },
    createRebuildWorktree: async () => { calls.worktrees.push("from-base"); await assertOwned("create"); return worktree; },
    fetchBranch: async (_remote, branch) => `${branch}-head`,
    mergeBranch: async (_cwd, head) => { calls.merges.push(head); return { conflict: false }; },
    isCommitAncestor: async () => true, push: async () => {}, forcePush: async () => {},
    editPr: async () => {}, markPrDraft: async () => {}, reopenPr: async () => {}, closePr: async () => {},
    openPr: async () => ({ number: 41, url: "https://example.test/pr/41" }), pushCheckpoint: async () => {},
    removeWorktree: async (cwd) => { calls.cleanups.push(cwd); await assertOwned("cleanup"); },
  };
  orchestrator.validateCompositeLeafSource = async (id, source, claim) => {
    assert.equal(id, "combined");
    orchestrator.assertAgentClaim(claim, source.agentRunId);
    const run = store.get().agentRuns.find((item) => item.id === source.agentRunId);
    assert.ok(run, "the controlled consumption boundary never supplies a missing source");
    return { run, head: `${source.branch}-head` };
  };
  orchestrator.restoreBurnerProgressFromCommit = async () => false;
  orchestrator.assertCandidateDoesNotOwnProgress = async () => {};
  orchestrator.publishCompositeDraft = async () => {};
  orchestrator.ensureLivingComposite = async () => {};
  const session = { threadId: "fixture-author", message: "Fixture output" };
  orchestrator.codex = {
    close: () => {}, preflight: async () => {},
    integrateComposite: async () => { await assertOwned("integration"); return session; },
    refreshCompositeEvidence: async () => { await assertOwned("evidence"); return session; },
    review: async () => { await assertOwned("review"); return { approved: true, summary: "Fixture approval", findings: [] }; },
    evaluate: async () => { await assertOwned("evaluation"); return { score: 70, summary: "Fixture result", evidence: [], suggestions: [] }; },
    revise: async () => assert.fail("resource fixtures must not bypass monotonicity with an extra revision"),
  };
  const evaluate = orchestrator.runCandidateEvaluations.bind(orchestrator);
  orchestrator.runCandidateEvaluations = async (cpu, ...args) => {
    const admitted = controls.acquired.locks.find((held) => held.forResource(orchestrator.locks, "cpu-heavy"));
    assert.equal(cpu, admitted, "the evaluator receives the exact live handle acquired by this composite");
    return evaluate(cpu, ...args);
  };
  t.after(async () => { await orchestrator.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, orchestrator, other, controls, calls, required };
}

async function pendingErrorFixture(t) {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await f.store.update((state) => { state.composites[0].status = "failed"; });
  f.orchestrator.activeAgents.add("occupied-slot");
  try { await f.orchestrator.retryComposite("combined"); }
  finally { f.orchestrator.activeAgents.delete("occupied-slot"); }
  assert.deepEqual([...f.orchestrator.compositeRequests.keys()], ["combined"]);
  assert.ok(f.orchestrator.compositeWakeup, "the fault must cancel a real accepted-request wakeup");
  assert.deepEqual(f.calls.phases, []);
  return f;
}

function assertAdmissionFenced(f) {
  assert.equal(f.orchestrator.compositeAdmissionClosed, true);
  assert.equal(f.orchestrator.compositeWakeup, undefined);
  assert.equal(f.orchestrator.compositeRequests.size, 0);
}

for (const mode of ["fresh", "resume", "incremental", "checkpoint"]) {
  test(`${mode} composites own every included resource through integration, evidence, evaluation and cleanup`, async (t) => {
    const f = await fixture(t, mode);
    assert.equal(await f.orchestrator.buildComposite("combined", mode !== "fresh"), "settled");
    const composite = f.store.get().composites[0];
    assert.equal(composite.status, "open", composite.error);
    assert.deepEqual(f.calls.merges, { fresh: ["first-head", "second-head"], resume: [], incremental: ["second-head"], checkpoint: ["checkpoint-combined-head"] }[mode]);
    assert.deepEqual(f.calls.phases, ["create", "integration", "evidence", "review", "evaluation", "cleanup"]);
    assert.equal(f.store.get().evaluationRuns.filter((run) => run.compositeId === "combined" && run.id !== "previous-composite").length, 1);
    assert.deepEqual(composite.sources.map((source) => source.agentRunId), ["first", "second"]);
    assert.deepEqual(await f.other.list(), []);
    const recovered = await f.other.tryAcquireAll(f.required, "after-composite");
    assert.ok(recovered);
    await recovered.release();
  });
}

for (const heldName of ["gpu", "living-combined", "living-ancestor"]) {
  test(`a busy ${heldName} excludes the whole composite without partial protected work`, async (t) => {
    const f = await fixture(t);
    const held = await f.other.acquire(heldName, "existing-work");
    try {
      assert.equal(await f.orchestrator.buildComposite("combined", false), "deferred");
      assert.deepEqual(f.calls.phases, []);
      assert.deepEqual(f.calls.merges, []);
      assert.equal(f.store.get().composites[0].status, "queued");
      assert.deepEqual(await f.other.list(), [heldName], "all partial acquisitions are rolled back; the existing owner remains");
    } finally { await held.release(); }
  });
}

for (const change of ["resources", "defaults", "membership", "missing-source"]) {
  test(`disk ${change} drift during acquisition is observed before protected work`, async (t) => {
    const f = await fixture(t);
    const external = new StateStore(f.root);
    await external.init({ recoverInterrupted: false });
    const entered = deferred();
    const resume = deferred();
    const acquire = f.orchestrator.locks.tryAcquireAll.bind(f.orchestrator.locks);
    f.orchestrator.locks.tryAcquireAll = async (...args) => {
      const lease = await acquire(...args);
      entered.resolve(); await resume.promise;
      return lease;
    };
    const running = f.orchestrator.buildComposite("combined", false);
    try {
      await entered.promise;
      await external.update((state) => {
        if (change === "resources") state.agentRuns[0].resources.push("new-source-resource");
        if (change === "defaults") state.settings.defaultResources.push("new-default-resource");
        if (change === "membership") state.composites[0].sources.reverse();
        if (change === "missing-source") state.agentRuns.pop();
      });
      assert.notDeepEqual(f.store.get(), external.get(), "the controller really has a stale cached snapshot");
    } finally { resume.resolve(); }
    assert.equal(await running, change === "missing-source" ? "settled" : "deferred");
    assert.deepEqual(f.calls.phases, []);
    assert.deepEqual(f.calls.merges, []);
    assert.deepEqual(await f.other.list(), []);
    const composite = f.store.get().composites[0];
    assert.equal(composite.status, change === "missing-source" ? "failed" : "queued");
    if (change === "missing-source") assert.match(composite.error, /second.*missing.*resource/i);
  });
}

test("a missing included source fails before acquisition or a worktree even on resume", async (t) => {
  const f = await fixture(t, "resume");
  await f.store.update((state) => { state.agentRuns.pop(); });
  const acquire = t.mock.method(f.orchestrator.locks, "tryAcquireAll", async () => assert.fail("unknown requirements cannot be admitted"));
  assert.equal(await f.orchestrator.buildComposite("combined", true), "settled");
  assert.equal(acquire.mock.callCount(), 0);
  assert.equal(f.store.get().composites[0].status, "failed");
  assert.match(f.store.get().composites[0].error, /second.*missing.*resource/i);
  assert.deepEqual(f.calls.phases, []);
});

test("close while complete resource acquisition is in flight releases the lease without starting work", async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  const resume = deferred();
  const acquire = f.orchestrator.locks.tryAcquireAll.bind(f.orchestrator.locks);
  f.orchestrator.locks.tryAcquireAll = async (...args) => {
    const lease = await acquire(...args);
    entered.resolve(); await resume.promise;
    return lease;
  };
  const running = f.orchestrator.buildComposite("combined", false);
  try { await entered.promise; await f.orchestrator.close(); }
  finally { resume.resolve(); }
  assert.equal(await running, "settled");
  assert.deepEqual(f.calls.phases, []);
  assert.deepEqual(await f.other.list(), []);
  assert.equal(f.orchestrator.compositeAdmissionClosed, true);
});

test("real composite acquisition errors settle failed and fence admission before protected work", async (t) => {
  const f = await pendingErrorFixture(t);
  const failure = new Error("fixture resource acquisition failure");
  const acquire = t.mock.method(f.orchestrator.locks, "tryAcquireAll", async () => { throw failure; });
  assert.equal(await f.orchestrator.buildComposite("combined", false), "settled");
  assert.equal(acquire.mock.callCount(), 1);
  assert.equal(f.store.get().composites[0].status, "failed");
  assert.equal(f.store.get().composites[0].error, failure.message);
  assert.deepEqual(f.calls.phases, []);
  assert.deepEqual(f.calls.worktrees, []);
  assert.deepEqual(await f.other.list(), []);
  assertAdmissionFenced(f);
  t.mock.timers.tick(10_000);
  await f.orchestrator.scheduleComposites();
  assert.equal(acquire.mock.callCount(), 1, "the cancelled wakeup cannot turn an acquisition exception into a retry");
});

test("real composite cleanup failure fences admission even when its cleanup retry succeeds", async (t) => {
  const f = await pendingErrorFixture(t);
  const failure = new Error("fixture first worktree cleanup failure");
  const remove = f.orchestrator.git.removeWorktree;
  let removals = 0;
  f.orchestrator.git.removeWorktree = async (...args) => {
    await remove(...args);
    if (++removals === 1) throw failure;
  };
  assert.equal(await f.orchestrator.buildComposite("combined", false), "settled");
  assert.equal(removals, 2, "the real error boundary retries worktree cleanup under the original lease");
  assert.deepEqual(f.calls.phases, ["create", "integration", "evidence", "review", "evaluation", "cleanup", "cleanup"]);
  assert.equal(f.store.get().composites[0].status, "failed");
  assert.equal(f.store.get().composites[0].error, failure.message);
  assert.deepEqual(await f.other.list(), []);
  assertAdmissionFenced(f);
});

test("real composite work and cleanup failures retain both errors while fencing and releasing outer leases", async (t) => {
  const f = await pendingErrorFixture(t);
  const workFailure = new Error("fixture integration failure");
  const cleanupFailure = new Error("fixture failed-work cleanup failure");
  const integrate = f.orchestrator.codex.integrateComposite;
  f.orchestrator.codex.integrateComposite = async (...args) => { await integrate(...args); throw workFailure; };
  const remove = f.orchestrator.git.removeWorktree;
  f.orchestrator.git.removeWorktree = async (...args) => { await remove(...args); throw cleanupFailure; };
  await assert.rejects(f.orchestrator.buildComposite("combined", false), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [workFailure, cleanupFailure]);
    return true;
  });
  assert.deepEqual(f.calls.phases, ["create", "integration", "cleanup"]);
  assert.equal(f.calls.cleanups.length, 1);
  assert.deepEqual(await f.other.list(), []);
  assertAdmissionFenced(f);
});

test("real composite lease-release failure fences admission and retains the occupied GPU until owner teardown", async (t) => {
  const f = await pendingErrorFixture(t);
  const failure = new Error("fixture GPU release failure");
  const acquire = f.orchestrator.locks.tryAcquireAll.bind(f.orchestrator.locks);
  let gpu;
  let releaseGpu;
  f.orchestrator.locks.tryAcquireAll = async (...args) => {
    const lease = await acquire(...args);
    assert.ok(lease);
    gpu = lease.locks.find((held) => held.forResource(f.orchestrator.locks, "gpu"));
    assert.ok(gpu);
    releaseGpu = gpu.release;
    gpu.release = async () => { throw failure; };
    return lease;
  };
  try {
    await assert.rejects(f.orchestrator.buildComposite("combined", false), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure]);
      return true;
    });
    assert.deepEqual(f.calls.phases, ["create", "integration", "evidence", "review", "evaluation", "cleanup"]);
    assertAdmissionFenced(f);
    assert.deepEqual(await f.other.list(), ["gpu"], "all other real handles release; the failed GPU release remains visible");
    assert.equal(await f.other.tryAcquire("gpu", "after-failed-release"), undefined);
    t.mock.timers.tick(10_000);
    await f.orchestrator.scheduleComposites();
    assert.equal(f.calls.worktrees.length, 1);
    assert.deepEqual(await f.other.list(), ["gpu"], "neither the cancelled timer nor fencing may manufacture quiescence");
  } finally {
    if (gpu) {
      gpu.release = releaseGpu;
      await releaseGpu();
    }
  }
});

test("BASE_CHANGED retains an accepted paused retry through cleanup and its next from-base build", async (t) => {
  const f = await fixture(t, "checkpoint");
  await f.store.update((state) => {
    state.orchestrator.enabled = false;
    state.composites[0].status = "failed";
    state.composites.push({ ...structuredClone(state.composites[0]), id: "unrelated", status: "rebuilding", sources: [] });
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const resolve = f.orchestrator.git.resolveRef;
  let baseReads = 0;
  f.orchestrator.git.resolveRef = async (ref) => {
    if (ref === "main" && ++baseReads === 2) {
      f.controls.base = "new-base";
      await f.store.update((state) => { state.evaluationRuns.find((run) => run.id === "baseline").commit = "new-base"; });
    }
    return resolve(ref);
  };
  await f.orchestrator.retryComposite("combined");
  await waitFor(() => !f.orchestrator.activeComposites.size && f.orchestrator.compositeWakeup, "the stale-base build must defer");
  const token = f.orchestrator.compositeRequests.get("combined");
  assert.ok(token);
  assert.equal(f.store.get().composites[0].rebuildMode, "from_base");
  assert.equal(f.calls.cleanups.length, 1);
  assert.equal(f.calls.phases.filter((phase) => phase === "evaluation").length, 0);
  assert.deepEqual(await f.other.list(), []);
  t.mock.timers.tick(4_999);
  await immediate();
  assert.equal(f.calls.worktrees.length, 1);
  assert.equal(f.orchestrator.compositeRequests.get("combined"), token);
  t.mock.timers.tick(1);
  await waitFor(() => !f.orchestrator.activeComposites.size && f.store.get().composites[0].status === "open", "accepted retry must finish while paused");
  assert.deepEqual(f.calls.worktrees, ["from-base", "from-base"]);
  assert.equal(f.store.get().composites[0].baseCommit, "new-base");
  assert.equal(f.store.get().composites[1].status, "rebuilding", "unrelated paused work is not granted this request");
  assert.equal(f.store.get().orchestrator.enabled, false);
  assert.equal(f.orchestrator.compositeRequests.has("combined"), false);
  assert.deepEqual(await f.other.list(), []);
});
