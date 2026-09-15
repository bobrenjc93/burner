import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CommandEvidenceArchive } from "../dist/lib/command-evidence.js";
import { EventHub } from "../dist/lib/events.js";
import { Orchestrator } from "../dist/lib/orchestrator.js";
import { StateStore } from "../dist/lib/store.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const evaluation = (id, command) => ({ id, name: id, prompt: `Evaluate ${id}`, command, enabled: true, weight: 1,
  definitionVersion: `${id}-v1`, createdAt: "2026-01-01T00:00:00.000Z" });
const sample = (evaluationId, score, commit = "candidate", context = "composite") => ({
  id: `${context}-${evaluationId}-${score}`, evaluationId, score, commit, context,
  evaluationDefinitionVersion: `${evaluationId}-v1`, status: "completed", durationMs: 1,
  createdAt: "2026-01-01T00:00:00.000Z", summary: "fixture measurement", evidence: [], suggestions: [],
});
const output = (score = 60) => ({ score, summary: "fixture measurement", evidence: [], suggestions: [] });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "burner-evaluation-isolation-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(root);
  await store.init();
  const orchestrator = new Orchestrator(root, store, new EventHub());
  return { root, store, orchestrator };
}

test("prompt-slot handoff reserves the oldest waiter's permit before a newcomer arrives", async (t) => {
  const { orchestrator } = await fixture(t);
  const holders = await Promise.all([0, 1, 2].map(() => orchestrator.acquirePromptEvaluationSlot()));
  let releaseQueued;
  let releaseNewcomer;
  const queued = orchestrator.acquirePromptEvaluationSlot().then((release) => { releaseQueued = release; });
  holders[0]();
  const newcomer = orchestrator.acquirePromptEvaluationSlot().then((release) => { releaseNewcomer = release; });
  try {
    await queued;
    assert.equal(orchestrator.activePromptEvaluations, 3);
    assert.equal(releaseNewcomer, undefined, "the newcomer must not steal the queued waiter's reserved slot");
    holders[0]();
    assert.equal(orchestrator.activePromptEvaluations, 3, "duplicate release does not create capacity");
    holders[1]();
    await newcomer;
    assert.equal(orchestrator.activePromptEvaluations, 3);
  } finally {
    holders.forEach((release) => release());
    await queued;
    releaseQueued();
    await newcomer;
    releaseNewcomer();
  }
  assert.equal(orchestrator.activePromptEvaluations, 0);
  assert.equal(orchestrator.promptEvaluationWaiters.length, 0);
});

test("independent managers exclude command/prompt overlap while a cohort runs three prompts", async (t) => {
  const { root, store, orchestrator } = await fixture(t);
  await store.update((state) => { state.evaluations = [evaluation("command", "fixture-never-executed"), ...[1, 2, 3].map((n) => evaluation(`prompt-${n}`))]; });
  const other = new Orchestrator(root, store, new EventHub());
  orchestrator.git = other.git = { head: async () => "candidate" };
  const commandEntered = deferred();
  const finishCommand = deferred();
  const threePrompts = deferred();
  const finishPrompts = deferred();
  const requested = [deferred(), deferred()];
  let requests = 0;
  const acquire = other.locks.acquire.bind(other.locks);
  other.locks.acquire = (...args) => { requested[requests++]?.resolve(); return acquire(...args); };
  let commands = 0;
  let prompts = 0;
  let maxPrompts = 0;
  let outsideStarts = 0;
  orchestrator.codex = {
    preflight: async () => undefined,
    evaluate: async (_cwd, entry) => {
      if (entry.command) {
        assert.equal(prompts, 0); commands += 1;
        commandEntered.resolve(); await finishCommand.promise;
        commands -= 1;
      } else {
        assert.equal(commands, 0); prompts += 1;
        maxPrompts = Math.max(maxPrompts, prompts);
        if (prompts === 3) threePrompts.resolve();
        await finishPrompts.promise; prompts -= 1;
      }
      return output();
    },
  };
  other.codex = { preflight: async () => undefined, evaluate: async () => {
    assert.equal(commands + prompts, 0); outsideStarts += 1; return output();
  } };
  const cohort = orchestrator.runEvaluations();
  const started = [cohort];
  try {
    await commandEntered.promise;
    started.push(other.runEvaluations("manual", root, undefined, undefined, ["prompt-1"]));
    await requested[0].promise;
    assert.equal(outsideStarts, 0);
    finishCommand.resolve();
    await threePrompts.promise;
    started.push(other.runEvaluations("manual", root, undefined, undefined, ["command"]));
    await requested[1].promise;
    assert.equal(outsideStarts, 0);
    assert.equal(maxPrompts, 3);
    finishPrompts.resolve();
    await Promise.all(started);
    assert.equal(outsideStarts, 2);
  } finally {
    finishCommand.resolve(); finishPrompts.resolve();
    await Promise.allSettled(started);
  }
  assert.equal(orchestrator.runningEvaluations, 0);
  assert.deepEqual(await orchestrator.locks.list(), []);
});

test("a caller lends its aliased CPU handle, while public row attribution cannot borrow it", async (t) => {
  const { root, store, orchestrator } = await fixture(t);
  await store.update((state) => {
    state.evaluations = [evaluation("prompt")];
    state.agentRuns.push({ id: "agent", ideaId: "idea", resources: ["cpu-heavy"] });
  });
  orchestrator.activeAgents.add("idea");
  orchestrator.git = { head: async () => "candidate" };
  let measured = 0;
  orchestrator.codex = { preflight: async () => undefined, evaluate: async () => { measured += 1; return output(); } };
  const lease = await orchestrator.locks.tryAcquireAll(["cpu/heavy", "gpu"], "caller");
  const acquire = orchestrator.locks.acquire.bind(orchestrator.locks);
  const requested = deferred();
  let cpuAcquisitions = 0;
  orchestrator.locks.acquire = (...args) => { cpuAcquisitions += 1; requested.resolve(); return acquire(...args); };
  let publicFinished = false;
  const publicCall = orchestrator.runEvaluations("agent", root, "agent").then((runs) => { publicFinished = true; return runs; });
  try {
    await requested.promise;
    await orchestrator.withEvaluationLease(lease, (cpu) => orchestrator.runEvaluationSuite(cpu, "agent", root, "agent"));
    assert.equal(cpuAcquisitions, 1, "borrowing must not reacquire the caller's physical path");
    assert.equal(publicFinished, false, "row metadata and activeAgents are not resource authority");
    assert.equal(measured, 1);
    assert.ok(lease.locks[0].forResource(orchestrator.locks, "cpu-heavy"));
  } finally { await lease.release(); await publicCall; }
  assert.equal(measured, 2);
  await assert.rejects(orchestrator.withEvaluationLease(lease, async () => assert.fail("released lease reused")), /releasing or released/);
});

test("candidate and baseline confirmation batches share three slots and preserve median sample counts", async (t) => {
  const { root, store, orchestrator } = await fixture(t);
  const ids = ["one", "two"];
  const baseline = new Map(ids.map((id) => [id, sample(id, 50, "base", "baseline")]));
  const after = ids.map((id) => sample(id, 60));
  await store.update((state) => {
    state.evaluations = ids.map((id) => evaluation(id));
    state.evaluationRuns = [...baseline.values(), ...after];
  });
  orchestrator.git = { head: async (cwd) => cwd === root ? "base" : "candidate" };
  const threeStarted = deferred();
  const finish = deferred();
  let active = 0;
  let max = 0;
  const calls = [];
  orchestrator.codex = { preflight: async () => undefined, evaluate: async (cwd, entry) => {
    active += 1; max = Math.max(max, active);
    if (active === 3) threeStarted.resolve();
    calls.push([cwd === root ? "baseline" : "candidate", entry.id]);
    await finish.promise; active -= 1;
    return output(cwd === root ? 50 : 60);
  } };
  const running = orchestrator.withEvaluationLease(undefined, (cpu) =>
    orchestrator.confirmPromptChanges(cpu, "candidate-fixture", baseline, after, "fixture candidate", undefined, "composite"));
  try { await threeStarted.promise; assert.equal(max, 3); }
  finally { finish.resolve(); }
  const medians = await running;
  assert.equal(calls.length, 8);
  assert.ok(medians.every((row) => row.promptSampleCount === 3 && row.score === 60));
  assert.ok([...baseline.values()].every((row) => row.promptSampleCount === 3 && row.score === 50));
  assert.equal(orchestrator.activePromptEvaluations, 0);
  assert.deepEqual(await orchestrator.locks.list(), []);
});

test("notification failure drains siblings through durable persistence before releasing admission", async (t) => {
  const { store, orchestrator } = await fixture(t);
  await store.update((state) => { state.evaluations = [evaluation("first"), evaluation("sibling")]; });
  orchestrator.git = { head: async () => "candidate" };
  const firstFailed = deferred();
  const siblingStarted = deferred();
  const siblingFinish = deferred();
  const persisted = deferred();
  const finishPersistence = deferred();
  const firstError = new Error("first notification failed");
  const siblingError = new Error("sibling notification failed");
  const emit = orchestrator.events.emit.bind(orchestrator.events);
  orchestrator.events.emit = (type, data) => {
    if (type === "evaluation" && data.status === "completed") {
      const row = store.get().evaluationRuns.find((item) => item.id === data.id);
      if (row.evaluationId === "first") { firstFailed.resolve(); throw firstError; }
      throw siblingError;
    }
    return emit(type, data);
  };
  const persist = orchestrator.persistLeafUpdate.bind(orchestrator);
  let delayed = false;
  orchestrator.persistLeafUpdate = async (...args) => {
    await persist(...args);
    if (!delayed && store.get().evaluationRuns.some((row) => row.evaluationId === "sibling" && row.status === "completed")) {
      delayed = true; persisted.resolve(); await finishPersistence.promise;
    }
  };
  orchestrator.codex = { preflight: async () => undefined, evaluate: async (_cwd, entry) => {
    if (entry.id === "sibling") { siblingStarted.resolve(); await siblingFinish.promise; }
    return output();
  } };
  let returned = false;
  const running = orchestrator.runEvaluations().finally(() => { returned = true; });
  const rejected = assert.rejects(running, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(new Set(error.errors), new Set([firstError, siblingError]));
    return true;
  });
  try {
    await Promise.all([firstFailed.promise, siblingStarted.promise]);
    assert.equal(returned, false);
    assert.equal(await orchestrator.locks.tryAcquire("cpu-heavy", "probe"), undefined);
    siblingFinish.resolve();
    await persisted.promise;
    assert.equal(returned, false);
    assert.equal(await orchestrator.locks.tryAcquire("cpu-heavy", "probe"), undefined);
  } finally {
    siblingFinish.resolve(); finishPersistence.resolve();
    await rejected;
  }
  assert.ok(store.get().evaluationRuns.every((row) => row.status === "completed" && row.score === 60));
  assert.equal(orchestrator.activePromptEvaluations, 0);
  assert.deepEqual(await orchestrator.locks.list(), []);
});

for (const phase of ["initial", "retry"]) {
  test(`prompt ${phase} batches drain a sibling before propagating rejection`, async (t) => {
    const { root, orchestrator } = await fixture(t);
    const entered = deferred();
    const finish = deferred();
    const failure = new Error(`${phase} failed`);
    let calls = 0;
    orchestrator.runEvaluationSuite = async () => {
      const call = ++calls;
      if (phase === "retry" && call <= 2) return [{ ...sample("prompt", undefined), status: "failed" }];
      if (call === (phase === "retry" ? 3 : 1)) throw failure;
      entered.resolve(); await finish.promise;
      return [sample("prompt", 60)];
    };
    let returned = false;
    const running = orchestrator.withEvaluationLease(undefined, (cpu) =>
      orchestrator.collectPromptMedians(cpu, "composite", root, ["prompt"], new Map([["prompt", sample("prompt", 60)]]), "fixture"))
      .finally(() => { returned = true; });
    const rejected = assert.rejects(running, (error) => error === failure);
    try {
      await entered.promise;
      assert.equal(returned, false);
      assert.equal(await orchestrator.locks.tryAcquire("cpu-heavy", "probe"), undefined);
    } finally { finish.resolve(); await rejected; }
    assert.deepEqual(await orchestrator.locks.list(), []);
  });
}

test("prompt-only retry validates its actual definition snapshot after a configuration change", async (t) => {
  const { root, store, orchestrator } = await fixture(t);
  await store.update((state) => { state.evaluations = [evaluation("prompt")]; });
  orchestrator.git = { head: async () => "candidate" };
  let calls = 0;
  orchestrator.codex = { preflight: async () => undefined, evaluate: async (_cwd, entry) => {
    assert.equal(entry.command, undefined);
    if (++calls === 1) throw new Error("retry needed");
    return output();
  } };
  const addActivity = store.addActivity.bind(store);
  store.addActivity = async (activity) => {
    if (activity.message.startsWith("Retrying")) await store.update((state) => { state.evaluations[0].command = "must-not-launch"; });
    return addActivity(activity);
  };
  await assert.rejects(orchestrator.withEvaluationLease(undefined, (cpu) =>
    orchestrator.collectPromptMedians(cpu, "composite", root, ["prompt"], new Map([["prompt", sample("prompt", 60)]]), "fixture")),
  /Parallel prompt confirmations cannot launch a command/);
  assert.equal(calls, 2, "the changed command must never launch as a parallel retry");
  assert.equal(store.get().evaluationRuns.filter((row) => row.status === "completed").length, 1);
  assert.deepEqual(await orchestrator.locks.list(), []);
});

test("cohort work and owned release failures are both retained", async (t) => {
  const { orchestrator } = await fixture(t);
  const workError = new Error("work failed");
  const releaseError = new Error("release failed");
  const acquire = orchestrator.locks.acquire.bind(orchestrator.locks);
  let held;
  let originalRelease;
  orchestrator.locks.acquire = async (...args) => {
    held = await acquire(...args); originalRelease = held.release;
    held.release = async () => { throw releaseError; };
    return held;
  };
  try {
    await assert.rejects(orchestrator.withEvaluationLease(undefined, async () => { throw workError; }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [workError, releaseError]);
      return true;
    });
  } finally { await originalRelease(); }
});

test("execution, archive-finalization and persistence failures survive while a sibling drains", async (t) => {
  const { store, orchestrator } = await fixture(t);
  await store.update((state) => { state.evaluations = [evaluation("command", "never-executed"), evaluation("prompt")]; });
  orchestrator.git = { head: async () => "candidate" };
  const executionError = new Error("fixture execution failed");
  const archiveError = new Error("fixture archive finalization failed");
  const persistenceError = new Error("fixture persistence failed");
  t.mock.method(CommandEvidenceArchive, "create", async (_directory, run) => ({
    reference: { runId: run.id, status: "incomplete", issues: ["fixture archive fault"] },
    finalize: async () => { throw archiveError; },
  }));
  orchestrator.codex = { preflight: async () => undefined, evaluate: async (_cwd, entry) => {
    if (entry.command) throw executionError;
    return output();
  } };
  const entered = deferred();
  const finish = deferred();
  const persist = orchestrator.persistLeafUpdate.bind(orchestrator);
  let writes = 0;
  orchestrator.persistLeafUpdate = async (...args) => {
    if (++writes === 2) throw persistenceError;
    if (writes === 4) { entered.resolve(); await finish.promise; }
    return persist(...args);
  };
  let returned = false;
  const running = orchestrator.runEvaluations().finally(() => { returned = true; });
  const errors = (error) => error instanceof AggregateError ? error.errors.flatMap(errors) : [error];
  const rejected = assert.rejects(running, (error) => {
    assert.deepEqual(errors(error), [executionError, archiveError, persistenceError]);
    return true;
  });
  try {
    await Promise.race([entered.promise, rejected.then(() => assert.fail("the cohort returned before sibling persistence"))]);
    assert.equal(returned, false);
    assert.equal(await orchestrator.locks.tryAcquire("cpu-heavy", "probe"), undefined);
    assert.equal(orchestrator.activePromptEvaluations, 1);
  } finally { finish.resolve(); await rejected; }
  assert.equal(store.get().evaluationRuns.find((row) => row.evaluationId === "prompt").status, "completed");
  assert.equal(orchestrator.activePromptEvaluations, 0);
  assert.equal(orchestrator.runningEvaluations, 0);
  assert.deepEqual(await orchestrator.locks.list(), []);
});

test("candidate confirmation failure cannot release its baseline sibling before persistence", async (t) => {
  const { root, store, orchestrator } = await fixture(t);
  await store.update((state) => { state.evaluations = [evaluation("prompt")]; });
  const baselineRun = sample("prompt", 50, "base", "baseline");
  const baseline = new Map([["prompt", baselineRun]]);
  const candidate = sample("prompt", 60);
  const failure = new Error("candidate confirmation failed");
  const entered = deferred();
  const finish = deferred();
  const savedBaseline = { ...baselineRun, id: "completed-baseline-sibling", promptSampleCount: 3 };
  orchestrator.collectPromptMedians = async (_cpuLock, context) => {
    if (context === "composite") throw failure;
    assert.equal(context, "baseline");
    entered.resolve(); await finish.promise;
    await store.update((state) => { state.evaluationRuns.push(structuredClone(savedBaseline)); });
    return new Map([["prompt", savedBaseline]]);
  };
  let returned = false;
  const running = orchestrator.withEvaluationLease(undefined, (cpuLock) =>
    orchestrator.confirmPromptChanges(cpuLock, root, baseline, [candidate], "candidate"))
    .finally(() => { returned = true; });
  const rejected = assert.rejects(running, (error) => error === failure);
  try {
    await Promise.race([entered.promise, rejected.then(() => assert.fail("the baseline sibling never started"))]);
    assert.equal(returned, false);
    assert.equal(await orchestrator.locks.tryAcquire("cpu-heavy", "probe"), undefined);
  } finally { finish.resolve(); await rejected; }
  assert.deepEqual(store.get().evaluationRuns.find((row) => row.id === savedBaseline.id), savedBaseline);
  assert.deepEqual(await orchestrator.locks.list(), []);
});
