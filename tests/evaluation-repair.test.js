import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexClient } from "../dist/lib/codex.js";
import { EventHub } from "../dist/lib/events.js";
import { TransientMergeGateError } from "../dist/lib/git.js";
import { canRetryAgent, compositeSourceRegressions, fullMergeValidationFingerprint, latestFullAssessment, fullAssessmentForIdentity, Orchestrator, reusableFullAgentCommandRuns } from "../dist/lib/orchestrator.js";
import { StateStore } from "../dist/lib/store.js";
import { createBurnerServer } from "../dist/server.js";
import { leafRefreshRepository } from "./leaf-refresh-test-helpers.js";
import { fixtureLeafPr, installLeafPrFixtureTransport } from "./leaf-pr-test-helpers.js";

const timestamp = "2026-09-01T00:00:00.000Z";
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// Real persisted state and retry/review/delivery control flow. Only external
// Git, Codex and measurement effects are replaced; resource leases are private
// fixture acquisitions, with no campaign runs.
async function fixture(t, { rounds = 9, limit = 12 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "burner-evaluation-repair-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(root);
  await store.init();
  await store.update((state) => {
    Object.assign(state.settings, { maxReviewRounds: limit, portfolioReviewRounds: limit, parallelism: 3, autoCreatePrs: true });
    state.orchestrator.enabled = false;
    state.evaluations = [{ id: "perf", name: "CUDA parity", prompt: "unchanged contract", command: "test-placeholder", definitionVersion: "v1", weight: 1, enabled: true, createdAt: timestamp }];
    state.evaluationRuns = [{ id: "baseline", evaluationId: "perf", score: 70, commit: "base", context: "baseline", status: "completed", durationMs: 1, createdAt: timestamp, evaluationDefinitionVersion: "v1" }];
    state.ideas = [{ id: "idea", agentRunId: "agent", title: "Repair performance", description: "Preserve coverage", rationale: "A real regression", predictedImpact: 1, evaluationIds: ["perf"], resources: [], status: "completed", source: "manual", createdAt: timestamp, updatedAt: timestamp }];
    state.agentRuns = [{
      id: "agent", ideaId: "idea", branch: "burner/repair", worktree: root, status: "completed", startedAt: timestamp, completedAt: timestamp,
      baseRef: "main", baseCommit: "base", authorThreadId: "author", authoringComplete: true, lastMessage: "candidate",
      resources: ["test-resource"], prNumber: 42, prUrl: "https://example.test/pr/42", prState: "open", reviewApproved: true,
      reviewRounds: Array.from({ length: rounds }, (_, index) => ({ id: `review-${index + 1}`, round: index + 1, commit: "rejected", approved: index === rounds - 1, summary: "historical review", findings: [], createdAt: timestamp, completedAt: timestamp, baseCommit: "base", evaluationFingerprint: fullMergeValidationFingerprint(state) })),
      deltas: [{ evaluationId: "perf", name: "CUDA parity", before: 70, after: 68, delta: -2, summary: "Confirmed warm execution regression." }], impact: -2,
      fullMergeValidation: { baseCommit: "base", candidateCommit: "rejected", evaluationFingerprint: fullMergeValidationFingerprint(state), qualified: false, completedAt: timestamp },
    }];
    Object.assign(state.agentRuns[0].fullMergeValidation, { candidateTree: "rejected-tree", deltas: structuredClone(state.agentRuns[0].deltas), impact: -2 });
    state.evaluationRuns.push({ id: "original-full", evaluationId: "perf", score: 68, commit: "rejected", context: "composite", agentRunId: "agent", status: "completed", durationMs: 1, createdAt: timestamp, evaluationDefinitionVersion: "v1" });
  });
  const calls = [];
  const world = { head: "rejected", tree: "rejected-tree", dirty: false, remoteHead: "rejected", remoteState: "OPEN",
    remoteTitle: "Repair performance", remoteBody: "Original body", remoteDraft: false, commits: 0, measurements: 0, score: 71 };
  await store.update((state) => {
    const run = state.agentRuns[0];
    run.leafPr = fixtureLeafPr(run, { title: world.remoteTitle, body: world.remoteBody, isDraft: world.remoteDraft, state: "OPEN" }, { historical: true });
  });
  const trees = new Map([["base", "base-tree"], ["rejected", "rejected-tree"]]);
  const parents = new Map();
  const orchestrator = new Orchestrator(root, store, new EventHub());
  orchestrator.assertCandidateDoesNotOwnProgress = async () => undefined;
  const tryAcquireAll = orchestrator.locks.tryAcquireAll.bind(orchestrator.locks);
  orchestrator.locks.tryAcquireAll = async (...args) => {
    calls.push("lease");
    const lease = await tryAcquireAll(...args);
    if (!lease) return lease;
    const release = lease.release;
    lease.release = async () => { await release(); calls.push("release"); };
    return lease;
  };
  orchestrator.git = {
    status: async () => ({ available: true, dirty: false }),
    createWorktree: async () => root,
    resolveRef: async (ref) => ref === "main" ? "base" : world.head,
    head: async () => world.head,
    tree: async (commit) => trees.get(commit) ?? world.tree,
    assertWorktree: async () => undefined,
    hasChanges: async () => world.dirty,
    createExistingWorktree: async () => root,
    commit: async () => { const parent = world.head; world.head = `repaired-${++world.commits}`; world.dirty = false; trees.set(world.head, world.tree); parents.set(world.head, parent); calls.push("commit"); return world.head; },
    prepareLeafCommit: async (_cwd, _branch, inputHead) => {
      assert.equal(world.head, inputHead, "the author must not change HEAD");
      calls.push("prepare");
      return { inputHead, tree: world.dirty ? world.tree : trees.get(world.head) ?? world.tree };
    },
    finalizeLeafCommit: async (cwd, _branch, receipt, message) => {
      if (world.head === receipt.inputHead) {
        if (receipt.tree === trees.get(world.head)) return world.head;
        return orchestrator.git.commit(cwd, message);
      }
      assert.equal(trees.get(world.head), receipt.tree);
      assert.equal(parents.get(world.head), receipt.inputHead);
      assert.equal(world.dirty, false);
      return world.head;
    },
    getPullRequest: async () => ({ number: 42, state: world.remoteState, headRefName: "burner/repair", headRefOid: world.remoteHead,
      title: world.remoteTitle, body: world.remoteBody, isDraft: world.remoteDraft, statusCheckRollup: [], url: "https://example.test/pr/42" }),
    remoteExists: async () => true,
    remoteBranchHead: async (_cwd, _remote, branch) => branch === "main" ? "base" : world.remoteHead ?? null,
    push: async () => { calls.push("push"); world.remoteHead = world.head; },
    pushLeaf: async (cwd, remote, branch, head, previous) => {
      assert.equal(head, world.head);
      if (world.remoteHead === head) return;
      assert.equal(world.remoteHead ?? null, previous, "publication uses its saved remote lease");
      return orchestrator.git.push(cwd, remote, branch);
    },
    editPr: async (_cwd, number, title, body) => { assert.equal(number, 42); calls.push("edit"); world.remoteTitle = title; world.remoteBody = body; },
    markPrDraft: async (_cwd, number) => { assert.equal(number, 42); calls.push("draft"); world.remoteDraft = true; },
    removeWorktree: async () => { calls.push("cleanup"); },
    reopenPr: async (_cwd, number) => { assert.equal(number, 42); world.remoteState = "OPEN"; calls.push("reopen"); },
    closePr: async () => { assert.fail("repair must not close any PR"); },
    openPr: async () => { assert.fail("repair must retain its existing PR"); },
    mergePr: async () => { assert.fail("retry is not merge authorization"); },
    listPullRequests: async () => { assert.fail("retry must not synchronize unrelated PRs"); },
  };
  installLeafPrFixtureTransport(orchestrator.git, {
    observe: (...args) => orchestrator.git.getPullRequest(...args),
    edit: (cwd, number, field, value) => orchestrator.git.editPr(cwd, number,
      field === "title" ? value : world.remoteTitle, field === "body" ? value : world.remoteBody),
    draft: (cwd, number, value) => {
      if (value) return orchestrator.git.markPrDraft(cwd, number);
      assert.equal(number, 42); world.remoteDraft = false; calls.push("ready");
    },
    close: async (_cwd, number) => { assert.equal(number, 42); world.remoteState = "CLOSED"; calls.push("close"); },
  });
  orchestrator.codex = {
    preflight: async () => undefined,
    evaluate: async () => { calls.push("evaluate"); world.measurements += 1; return { score: world.score, summary: "Measured candidate", evidence: [], suggestions: [] }; },
    revise: async (_cwd, thread, feedback, _settings, kind) => {
      calls.push({ revise: { thread, feedback: structuredClone(feedback), kind } });
      world.dirty = true; world.tree = "repaired-tree";
      return { threadId: "author", message: "Repaired execution" };
    },
    refreshAgentEvidence: async () => { calls.push("evidence"); return { threadId: "author", message: "Checked evidence" }; },
    review: async () => { calls.push("review"); return { approved: true, summary: "Approved", findings: [] }; },
  };
  orchestrator.scheduleComposites = async () => { calls.push("schedule"); };
  orchestrator.tick = async () => { calls.push("tick"); };
  return { root, store, orchestrator, calls, world, run: () => store.get().agentRuns[0] };
}

test("targeted full-score repair retains one PR, confirmed feedback and cumulative round 9 -> 10", async (t) => {
  const f = await fixture(t);
  await f.store.update((state) => { state.agentRuns.push({ ...structuredClone(state.agentRuns[0]), id: "held", ideaId: "held-idea", branch: "burner/held", prNumber: 99 }); });
  const held = f.store.get().agentRuns[1];
  const definitions = f.store.get().evaluations;
  const oldValidation = latestFullAssessment(f.run());
  const oldDeltas = f.run().deltas;
  const run = await f.orchestrator.retryAgent("agent", { repairNotes: "Keep the numerical contract unchanged." });
  assert.equal(run.status, "completed");
  assert.equal(run.reviewRounds.length, 10);
  assert.equal(run.reviewRounds.at(-1).round, 10);
  assert.equal(run.reviewRounds.at(-1).commit, "repaired-1");
  assert.equal(run.reviewRounds.at(-1).baseCommit, "base");
  assert.equal(run.reviewRounds.at(-1).evaluationFingerprint, oldValidation.evaluationFingerprint);
  assert.equal(run.prNumber, 42);
  assert.equal(run.authorThreadId, "author");
  assert.deepEqual(latestFullAssessment(run), oldValidation);
  assert.deepEqual(latestFullAssessment(run).deltas, oldDeltas);
  assert.equal(run.fullMergeValidation, undefined, "new-format recovery has no writable latest alias");
  assert.equal(run.fullEvaluationHistory.length, 1);
  assert.equal(run.evaluationRepair, undefined);
  assert.equal(run.continuation.step, "done");
  const revision = f.calls.find((call) => call.revise).revise;
  assert.equal(revision.kind, "evaluation");
  assert.match(revision.feedback.summary, /rejected against base/);
  assert.equal(revision.feedback.findings[0].title, "CUDA parity: 70 -> 68 (delta -2)");
  assert.match(revision.feedback.findings.at(-1).title, /not evaluation evidence/);
  assert.deepEqual(f.store.get().agentRuns[1], held);
  assert.deepEqual(f.store.get().evaluations, definitions);
  assert.ok(f.calls.indexOf("review") > f.calls.indexOf("evidence"));
  assert.ok(f.calls.indexOf("evaluate") > f.calls.indexOf("review"));
  assert.equal(f.calls.filter((call) => call === "release").length, 1);
  assert.equal(f.calls.includes("schedule"), false);
  assert.equal(f.orchestrator.agentClaims.size, 0);
  assert.equal(f.orchestrator.activeAgents.size, 0);
});

test("public retry lends its actual CPU acquisition, including an aliased physical key", async (t) => {
  for (const resource of ["cpu-heavy", "cpu/heavy"]) await t.test(resource, async (t) => {
    const f = await fixture(t);
    await f.store.update((state) => { state.agentRuns[0].resources = [resource]; });
    const acquire = f.orchestrator.locks.acquire.bind(f.orchestrator.locks);
    f.orchestrator.locks.acquire = (name, ...args) => {
      assert.notEqual(name, "cpu-heavy", "the retry already owns the physical CPU resource; reacquisition would deadlock");
      return acquire(name, ...args);
    };
    const evaluate = f.orchestrator.codex.evaluate;
    f.orchestrator.codex.evaluate = async (...args) => {
      assert.ok((await f.orchestrator.locks.list()).includes("cpu-heavy"));
      return evaluate(...args);
    };
    const run = await f.orchestrator.retryAgent("agent");
    assert.equal(run.status, "completed", run.error);
    assert.equal(f.world.measurements, 1);
    assert.equal(f.calls.filter((call) => call === "release").length, 1);
    assert.deepEqual(await f.orchestrator.locks.list(), []);
  });
});

test("fresh repair rejects stale or incomplete identities without state, author or evaluation changes", async (t) => {
  const cases = [
    ["remote head", (f) => { f.world.remoteHead = "different"; }],
    ["missing remote head", (f) => { f.world.remoteHead = undefined; }],
    ["remote branch", (f) => { f.orchestrator.git.getPullRequest = async () => ({ number: 42, state: "OPEN", headRefName: "other", headRefOid: "rejected" }); }],
    ["closed remote", (f) => { f.orchestrator.git.getPullRequest = async () => ({ number: 42, state: "CLOSED", headRefName: "burner/repair", headRefOid: "rejected" }); }],
    ["local head", (f) => { f.world.head = "different"; }],
    ["base", (f) => { f.orchestrator.git.resolveRef = async (ref) => ref === "main" ? "new-base" : "rejected"; }],
    ["review head", async (f) => { await f.store.update((s) => { s.agentRuns[0].reviewRounds.at(-1).commit = "other"; }); }],
    ["review incomplete", async (f) => { await f.store.update((s) => { delete s.agentRuns[0].reviewRounds.at(-1).completedAt; }); }],
    ["fingerprint", async (f) => { await f.store.update((s) => { s.agentRuns[0].fullMergeValidation.evaluationFingerprint = "different"; }); }],
    ["missing delta", async (f) => { await f.store.update((s) => { s.agentRuns[0].fullMergeValidation.deltas = []; }); }],
    ["unknown score", async (f) => { await f.store.update((s) => { delete s.agentRuns[0].fullMergeValidation.deltas[0].before; }); }],
    ["screening delta", async (f) => { await f.store.update((s) => { s.agentRuns[0].fullMergeValidation.deltas[0].screening = true; }); }],
    ["duplicate delta", async (f) => { await f.store.update((s) => { s.agentRuns[0].fullMergeValidation.deltas.push(s.agentRuns[0].fullMergeValidation.deltas[0]); }); }],
    ["qualified checkpoint", async (f) => { await f.store.update((s) => { s.agentRuns[0].fullMergeValidation.qualified = true; }); }],
    ["dirty rejected worktree", (f) => { f.world.dirty = true; }],
    ["exhausted review budget", async (f) => { await f.store.update((s) => { s.settings.maxReviewRounds = 9; }); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async (t) => {
    const f = await fixture(t);
    await mutate(f);
    const before = f.run();
    await assert.rejects(f.orchestrator.retryAgent("agent"));
    assert.deepEqual(f.run(), before);
    assert.equal(f.calls.some((call) => call.revise || call === "review" || call === "evaluate" || call === "commit"), false);
    assert.equal(f.orchestrator.agentClaims.size, 0);
    assert.equal(f.orchestrator.activeAgents.size, 0);
  });
});

test("admission rechecks identity after awaited preparation and releases owned resources", async (t) => {
  const f = await fixture(t);
  let changed = false;
  const inspect = f.orchestrator.git.getPullRequest;
  f.orchestrator.git.getPullRequest = async (...args) => {
    if (f.calls.includes("lease") && !changed) {
      changed = true;
      await f.store.update((state) => { state.agentRuns[0].lastMessage = "changed concurrently"; });
    }
    return inspect(...args);
  };
  await assert.rejects(f.orchestrator.retryAgent("agent"), /identity changed|owner changed/);
  assert.equal(f.run().reviewApproved, true);
  assert.equal(f.run().evaluationRepair, undefined);
  assert.equal(f.calls.filter((call) => call === "release").length, 1);
  assert.equal(f.orchestrator.agentClaims.size, 0);
});

test("live review-budget reduction during preparation stops author work", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  const inspect = f.orchestrator.git.getPullRequest;
  f.orchestrator.git.getPullRequest = async (...args) => {
    if (++reads === 2) await f.store.update((state) => { state.settings.maxReviewRounds = 9; });
    return inspect(...args);
  };
  await assert.rejects(f.orchestrator.retryAgent("agent"), /no review budget|bounded review budget/);
  assert.equal(f.calls.some((call) => call.revise), false);
  assert.equal(f.run().evaluationRepair, undefined);
  assert.equal(f.orchestrator.agentClaims.size, 0);
});

test("durable evaluation feedback survives interruption and process-local restart", async (t) => {
  const f = await fixture(t);
  f.orchestrator.codex.revise = async () => { throw new Error("author interrupted"); };
  await f.orchestrator.retryAgent("agent", { repairNotes: "Preserve all outputs." });
  assert.equal(f.run().status, "failed");
  assert.equal(f.run().reviewApproved, false);
  const checkpoint = f.run().continuation;
  assert.equal(checkpoint.reason.notes, "Preserve all outputs.");
  assert.equal(latestFullAssessment(f.run()).qualified, false);
  const recovered = new StateStore(f.root);
  await recovered.init();
  const resumed = new Orchestrator(f.root, recovered, new EventHub());
  for (const property of ["git", "locks", "assertCandidateDoesNotOwnProgress", "scheduleComposites", "tick"]) resumed[property] = f.orchestrator[property];
  let feedback;
  resumed.codex = { ...f.orchestrator.codex, revise: async (_cwd, _thread, review, _settings, kind) => {
    assert.equal(kind, "evaluation"); feedback = review;
    f.world.dirty = true; f.world.tree = "repaired-tree";
    return { threadId: "author", message: "Resumed" };
  } };
  const run = await resumed.retryAgent("agent");
  assert.equal(run.status, "completed");
  assert.equal(run.continuation.step, "done");
  assert.deepEqual(latestFullAssessment(run).candidateCommit, checkpoint.reason.assessment.candidateCommit);
  assert.match(feedback.findings[0].detail, /Confirmed warm execution/);
  assert.equal(run.reviewRounds.length, 10);
});

test("no-op and empty-commit repairs cannot purchase new review or score samples", async (t) => {
  for (const emptyCommit of [false, true]) await t.test(String(emptyCommit), async (t) => {
    const f = await fixture(t);
    f.orchestrator.codex.revise = async () => {
      if (emptyCommit) f.world.head = "empty-commit";
      return { threadId: "author", message: "No implementation change" };
    };
    const run = await f.orchestrator.retryAgent("agent");
    assert.equal(run.status, "failed");
    assert.match(run.error, emptyCommit ? /branch\/head or worktree changed/ : /rejected tree unchanged/);
    assert.equal(run.reviewRounds.length, 9);
    assert.equal(f.calls.includes("review"), false);
    assert.equal(f.calls.includes("evaluate"), false);
    assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", "base"), false);
    assert.equal(f.calls.includes("evaluate"), false);
  });
});

test("a review revision that restores the rejected tree stops before another review", async (t) => {
  const f = await fixture(t);
  f.orchestrator.codex.review = async () => {
    f.calls.push("review");
    return { approved: false, summary: "Fix semantics", findings: [{ severity: "high", title: "Semantics", detail: "Restore prior behavior", file: "code.rs" }] };
  };
  const revise = f.orchestrator.codex.revise;
  let revisions = 0;
  f.orchestrator.codex.revise = async (...args) => {
    const result = await revise(...args);
    if (++revisions === 2) f.world.tree = "rejected-tree";
    return result;
  };
  const run = await f.orchestrator.retryAgent("agent");
  assert.equal(run.status, "failed");
  assert.match(run.error, /rejected tree unchanged/);
  assert.equal(f.calls.filter((call) => call === "review").length, 1);
  assert.equal(f.calls.includes("evaluate"), false);
});

test("the final pre-evaluation guard catches a restored tree after approval", async (t) => {
  const f = await fixture(t);
  f.orchestrator.codex.review = async () => {
    f.world.tree = "rejected-tree";
    f.world.head = "restored-head";
    return { approved: true, summary: "Approved", findings: [] };
  };
  const run = await f.orchestrator.retryAgent("agent");
  assert.match(run.error, /branch\/head or worktree changed/);
  assert.equal(f.calls.includes("evaluate"), false);
});

test("final-round approval is atomic and delivery resumes after evaluation or push failure with zero new reviews", async (t) => {
  for (const stage of ["evaluation", "push"]) await t.test(stage, async (t) => {
    const f = await fixture(t, { rounds: 9, limit: 10 });
    const evaluate = f.orchestrator.codex.evaluate;
    const push = f.orchestrator.git.push;
    let observedApproval = false;
    f.store.subscribe((state) => {
      const run = state.agentRuns[0];
      const last = run.reviewRounds.at(-1);
      if (last?.round === 10 && last.approved && last.completedAt) {
        assert.equal(run.reviewApproved, true, "completed approval and top-level approval must be persisted together");
        observedApproval = true;
      }
    });
    if (stage === "evaluation") f.orchestrator.codex.evaluate = async () => { throw new Error("evaluation transport failed"); };
    else f.orchestrator.git.push = async () => { throw new Error("push failed"); };
    const failed = await f.orchestrator.retryAgent("agent");
    assert.equal(failed.status, "failed");
    assert.equal(failed.reviewApproved, true);
    assert.equal(failed.reviewRounds.length, 10);
    assert.ok(failed.reviewRounds.at(-1).completedAt);
    assert.equal(observedApproval, true);
    f.orchestrator.codex.evaluate = evaluate;
    f.orchestrator.git.push = push;
    f.calls.length = 0;
    const recoveredStore = new StateStore(f.root);
    await recoveredStore.init();
    const recovered = new Orchestrator(f.root, recoveredStore, new EventHub());
    for (const property of ["git", "locks", "codex", "assertCandidateDoesNotOwnProgress", "scheduleComposites", "tick"]) recovered[property] = f.orchestrator[property];
    const completed = await recovered.retryAgent("agent");
    assert.equal(completed.status, "completed");
    assert.equal(completed.reviewRounds.length, 10);
    assert.equal(f.calls.includes("review"), false);
    assert.equal(f.calls.includes("evidence"), false);
    assert.equal(f.calls.some((call) => call.revise), false);
    assert.ok(f.calls.includes("push"));
  });
});

test("an obsolete claim handle cannot release a later owner's reservation", async (t) => {
  const f = await fixture(t);
  const first = f.orchestrator.claimAgents(["agent"]);
  first.release();
  const second = f.orchestrator.claimAgents(["agent"]);
  first.release();
  assert.equal(f.orchestrator.agentClaims.get("agent"), second.token);
  second.release();
  assert.equal(f.orchestrator.agentClaims.size, 0);
});

test("delivery rechecks the exact approved head after asynchronous admission", async (t) => {
  const f = await fixture(t, { rounds: 10, limit: 10 });
  await f.store.update((state) => { state.agentRuns[0].status = "failed"; });
  const activity = f.store.addActivity.bind(f.store);
  f.store.addActivity = async (entry) => {
    if (entry.message.startsWith("Agent retry resumed")) f.world.head = "unapproved-drift";
    return activity(entry);
  };
  const failed = await f.orchestrator.retryAgent("agent");
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /branch\/head or worktree changed/);
  assert.equal(f.calls.includes("evaluate"), false);
  assert.equal(f.calls.includes("push"), false);
});

test("ordinary exact approval can resume delivery, but changed or incomplete legacy approval needs headroom", async (t) => {
  for (const mode of ["exact", "changed", "incomplete", "unknown-fingerprint"]) await t.test(mode, async (t) => {
    const f = await fixture(t, { rounds: 10, limit: 10 });
    await f.store.update((state) => {
      const run = state.agentRuns[0];
      run.status = "failed";
      delete run.fullMergeValidation;
      Object.assign(run.reviewRounds.at(-1), { baseCommit: "base", evaluationFingerprint: fullMergeValidationFingerprint(state) });
      if (mode === "incomplete") delete run.reviewRounds.at(-1).completedAt;
      if (mode === "unknown-fingerprint") delete run.reviewRounds.at(-1).evaluationFingerprint;
    });
    if (mode === "changed") f.world.head = "unreviewed";
    if (mode === "exact") {
      const run = await f.orchestrator.retryAgent("agent");
      assert.equal(run.status, "completed");
      assert.equal(f.calls.includes("review"), false);
    } else {
      await assert.rejects(f.orchestrator.retryAgent("agent"), /no review budget/);
      assert.equal(f.calls.includes("evaluate"), false);
      assert.equal(f.calls.some((call) => call.revise), false);
    }
  });
});

test("delivery recovery preserves an exact rejected full qualification and its deltas", async (t) => {
  const f = await fixture(t, { rounds: 10, limit: 10 });
  await f.store.update((state) => { state.agentRuns[0].status = "failed"; });
  const before = f.run();
  const run = await f.orchestrator.retryAgent("agent");
  assert.equal(run.status, "completed");
  assert.deepEqual(latestFullAssessment(run), latestFullAssessment(before));
  assert.deepEqual(run.deltas, before.deltas);
  assert.equal(run.impact, before.impact);
  assert.equal(f.calls.includes("evaluate"), false);
  assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", "base"), false);
  assert.equal(f.calls.includes("evaluate"), false);
});

test("real unresolved review and CI feedback take precedence over historical evaluation feedback", async (t) => {
  for (const kind of ["review", "ci"]) await t.test(kind, async (t) => {
    const f = await fixture(t);
    const checkpoint = { validation: latestFullAssessment(f.run()), deltas: f.run().deltas, rejectedTree: "rejected-tree" };
    await f.store.update((state) => {
      const run = state.agentRuns[0]; run.status = "failed"; run.evaluationRepair = checkpoint;
      if (kind === "review") { Object.assign(run.reviewRounds.at(-1), { approved: false, findings: [{ severity: "high", title: "Actual review", detail: "Repair this blocker", file: "code.rs" }] }); delete run.reviewRounds.at(-1).completedAt; }
      else { run.quarantineReason = "Merge gate rejected PR #42: CI failed"; run.error = "Required test failed"; }
    });
    if (kind === "ci") { const inspect = f.orchestrator.git.getPullRequest; f.orchestrator.git.getPullRequest = async (...args) => ({ ...await inspect(...args), statusCheckRollup: [{ name: "Required test", status: "COMPLETED", conclusion: "FAILURE" }] }); }
    await f.orchestrator.retryAgent("agent");
    const revision = f.calls.find((call) => call.revise).revise;
    assert.equal(revision.kind, "review");
    assert.equal(revision.feedback.findings[0].title, kind === "review" ? "Actual review" : "Repair the failed merge gate");
  });
});

test("claims exclude duplicate repair, refresh, composite creation/retry, qualification and merge", async (t) => {
  const f = await fixture(t);
  await f.store.update((state) => {
    state.agentRuns.push({ ...structuredClone(state.agentRuns[0]), id: "other", ideaId: "other-idea", branch: "burner/other", prNumber: 99 });
    state.composites.push({ id: "failed-composite", title: "Failed", description: "", branch: "burner/composite", worktree: "", status: "failed", sources: state.agentRuns.map((run) => ({ agentRunId: run.id, prNumber: run.prNumber, branch: run.branch, title: run.id, kind: "pull_request" })), deltas: [], reviewRounds: [], createdAt: timestamp, updatedAt: timestamp });
  });
  const entered = deferred();
  const resume = deferred();
  const inspect = f.orchestrator.git.getPullRequest;
  f.orchestrator.git.getPullRequest = async (...args) => { entered.resolve(); await resume.promise; return inspect(...args); };
  const repair = f.orchestrator.retryAgent("agent");
  await entered.promise;
  const token = f.orchestrator.agentClaims.get("agent");
  for (const competing of [
    () => f.orchestrator.retryAgent("agent"),
    () => f.orchestrator.refreshAgentBaseAndRetry("agent"),
    () => f.orchestrator.createComposite(["agent", "other"]),
    () => f.orchestrator.retryComposite("failed-composite"),
    () => f.orchestrator.mergeAgent("agent"),
  ]) {
    await assert.rejects(competing(), /reserved/);
    assert.equal(f.orchestrator.agentClaims.get("agent"), token, "a loser cannot release the winner's reservation");
    assert.equal(f.orchestrator.agentClaims.has("other"), false, "multi-source claims are all-or-none");
  }
  assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", "base"), false);
  resume.resolve();
  assert.equal((await repair).status, "completed");
  assert.equal(f.orchestrator.agentClaims.size, 0);
});

test("a stale reconciliation decision cannot retire a repaired PR after its claim is released", async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  const resume = deferred();
  const oldRemote = [{ number: 42, state: "OPEN", headRefName: "burner/repair", headRefOid: "rejected", statusCheckRollup: [], url: "https://example.test/pr/42" }];
  f.orchestrator.git.listPullRequests = async () => { entered.resolve(); await resume.promise; return oldRemote; };
  f.orchestrator.ensureLivingComposite = async () => undefined;
  f.orchestrator.git.markPrDisposition = async () => { assert.fail("stale reconciliation must not relabel the PR"); };
  const sync = f.orchestrator.syncPullRequests(true);
  await entered.promise;
  await f.orchestrator.retryAgent("agent");
  const repaired = f.run();
  assert.equal(f.orchestrator.agentClaims.size, 0);
  resume.resolve();
  await sync;
  assert.deepEqual(f.run(), repaired);
});

test("resource contention and thrown preparation release claims without erasing feedback", async (t) => {
  for (const stage of ["busy", "acquire", "worktree"]) await t.test(stage, async (t) => {
    const f = await fixture(t);
    const before = f.run();
    if (stage === "busy") f.orchestrator.locks.tryAcquireAll = async () => undefined;
    if (stage === "acquire") f.orchestrator.locks.tryAcquireAll = async () => { throw new Error("resource acquisition failed"); };
    if (stage === "worktree") {
      f.orchestrator.git.head = async () => { throw new Error("missing worktree"); };
      f.orchestrator.git.createExistingWorktree = async () => { throw new Error("worktree creation failed"); };
    }
    await assert.rejects(f.orchestrator.retryAgent("agent"));
    assert.deepEqual(f.run(), before);
    assert.equal(f.orchestrator.agentClaims.size, 0);
    assert.equal(f.orchestrator.activeAgents.size, 0);
    assert.equal(f.calls.filter((call) => call === "release").length, stage === "worktree" ? 1 : 0);
  });
});

test("paused retry does not dispatch queued composites; enabled retry retains scheduling", async (t) => {
  for (const enabled of [false, true]) await t.test(String(enabled), async (t) => {
    const f = await fixture(t);
    await f.store.update((state) => { state.orchestrator.enabled = enabled; });
    await f.orchestrator.retryAgent("agent");
    assert.equal(f.calls.includes("schedule"), enabled);
  });
});

test("evaluation revision prompt labels confirmed feedback, not a fictional reviewer", async () => {
  const client = new CodexClient();
  let prompt;
  client.unstructuredSession = async (_cwd, text) => { prompt = text; return { threadId: "author", message: "done" }; };
  await client.revise("/test-worktree", "author", { approved: false, summary: "68 vs 70", findings: [] }, { agentModel: "test" }, "evaluation");
  assert.match(prompt, /confirmed evaluation gate rejected/);
  assert.match(prompt, /not an independent code review/);
  assert.doesNotMatch(prompt, /An independent reviewer requested changes/);
  assert.match(prompt, /preserve evaluation definitions, denominators, tolerances/);
});

test("retry API admits a completed full-rejected leaf and validates bounded notes", async (t) => {
  const f = await fixture(t);
  t.mock.method(Orchestrator.prototype, "init", async () => undefined);
  t.mock.method(Orchestrator.prototype, "close", async () => undefined);
  const accepted = [];
  t.mock.method(Orchestrator.prototype, "retryAgent", async (runId, options) => { accepted.push({ runId, options }); return f.run(); });
  const server = await createBurnerServer({ root: f.root, host: "127.0.0.1", port: 0, startPaused: true, manual: true });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.server.address().port}/api/agents/agent/retry`;
  const post = (body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ repairNotes: "Keep output behavior." })).status, 202);
  assert.deepEqual(accepted, [{ runId: "agent", options: { repairNotes: "Keep output behavior." } }]);
  assert.equal((await post({ repairNotes: "x".repeat(12_001) })).status, 400);
  assert.equal((await post({ repairNotes: 7 })).status, 400);
  for (const retainWorktree of [false, null, 0, "true", {}, []]) {
    assert.equal((await post({ retainWorktree })).status, 400, "explicit invalid values must reach validation, not be omitted");
  }
  assert.equal((await post({ legacyPrProof: null })).status, 400);
  assert.equal((await post({ retainWorktree: true })).status, 202);
  assert.deepEqual(accepted.at(-1), { runId: "agent", options: { repairNotes: undefined, retainWorktree: true } });
  await server.store.update((state) => { state.agentRuns[0].status = "failed"; });
  assert.equal((await post({ repairNotes: "Not a fresh repair" })).status, 400);
  assert.equal((await post({})).status, 202);
  await server.store.update((state) => { state.agentRuns[0].status = "completed"; state.agentRuns[0].fullMergeValidation.qualified = true; });
  assert.equal((await post({})).status, 409);
  assert.equal(canRetryAgent(server.store.get().agentRuns[0]), false);
  const onDisk = JSON.parse(await readFile(join(f.root, ".burner", "state.json"), "utf8"));
  assert.equal(onDisk.agentRuns[0].prNumber, 42);
});

async function restart(f) {
  const recovered = new StateStore(f.root);
  await recovered.init();
  const resumed = new Orchestrator(f.root, recovered, new EventHub());
  for (const property of ["git", "locks", "codex", "assertCandidateDoesNotOwnProgress", "scheduleComposites", "tick"]) resumed[property] = f.orchestrator[property];
  f.store = recovered;
  f.orchestrator = resumed;
  f.run = () => recovered.get().agentRuns[0];
}

test("every durable author/evidence/reviewer cut point resumes only its successor after StateStore reload", async (t) => {
  const cuts = ["author-receipt", "author-commit", "author-successor", "evidence-receipt", "evidence-commit", "evidence-successor",
    "review-rejection", "response-receipt", "response-commit", "response-successor", "approval", "evaluation-receipt", "done"];
  for (const cut of cuts) await t.test(cut, async (t) => {
    const response = cut.startsWith("response") || cut === "review-rejection";
    const f = await fixture(t, { limit: response ? 11 : 10 });
    let evidenceCalls = 0;
    let reviewCalls = 0;
    f.orchestrator.codex.refreshAgentEvidence = async () => {
      f.calls.push("evidence"); evidenceCalls += 1;
      f.world.dirty = true; f.world.tree = `evidence-tree-${evidenceCalls}`;
      return { threadId: "author", message: `Durable evidence ${evidenceCalls}` };
    };
    f.orchestrator.codex.review = async () => {
      f.calls.push("review"); reviewCalls += 1;
      return response && reviewCalls === 1
        ? { approved: false, summary: "Fix semantics", findings: [{ severity: "high", title: "Semantics", detail: "Fix the behavior", file: "code.rs" }] }
        : { approved: true, summary: "Approved", findings: [] };
    };
    let interrupted = false;
    const isReceipt = (cursor, kind) => cursor?.step === "commit" && (kind === "evidence"
      ? cursor.source.kind === "evidence"
      : cursor.source.kind === "author" && cursor.source.reason.kind === (kind === "response" ? "review" : "evaluation"));
    const fail = () => { interrupted = true; throw new Error(`Injected ${cut} interruption`); };
    const unsubscribe = f.store.subscribe((state) => {
      if (interrupted) return;
      const run = state.agentRuns[0];
      const cursor = run.continuation;
      if ((cut.endsWith("-receipt") && cut !== "evaluation-receipt" && isReceipt(cursor, cut.split("-")[0])) ||
        (cut === "author-successor" && cursor?.step === "evidence" && !run.reviewRounds.at(-1)?.authorResponse) ||
        (cut === "evidence-successor" && cursor?.step === "review") ||
        (cut === "review-rejection" && cursor?.step === "author" && cursor.reason.kind === "review") ||
        (cut === "response-successor" && cursor?.step === "evidence" && run.reviewRounds.at(-1)?.authorResponse) ||
        (cut === "approval" && cursor?.step === "delivery" && !cursor.evaluation) ||
        (cut === "evaluation-receipt" && cursor?.step === "delivery" && cursor.evaluation) ||
        (cut === "done" && cursor?.step === "done")) fail();
    });
    const finalize = f.orchestrator.git.finalizeLeafCommit;
    f.orchestrator.git.finalizeLeafCommit = async (...args) => {
      const cursor = f.run().continuation;
      const head = await finalize(...args);
      if (!interrupted && cut.endsWith("-commit") && isReceipt(cursor, cut.split("-")[0])) fail();
      return head;
    };
    const interruptedRun = await f.orchestrator.retryAgent("agent");
    assert.equal(interrupted, true, `the ${cut} boundary must actually execute`);
    assert.equal(interruptedRun.status, cut.endsWith("-commit") ? "failed" : "completed",
      "an observed durable rename is acknowledged; an unacknowledged Git effect keeps its receipt for retry");
    unsubscribe();
    await restart(f);
    if (interruptedRun.status !== "completed") assert.equal((await f.orchestrator.retryAgent("agent")).status, "completed");
    assert.equal(f.run().continuation.step, "done");
    assert.equal(f.calls.filter((call) => call.revise?.kind === "evaluation").length, 1, "completed evaluation authoring is never repeated");
    assert.equal(f.calls.filter((call) => call.revise?.kind === "review").length, response ? 1 : 0, "each review response is consumed once");
    assert.equal(evidenceCalls, response ? 2 : 1, "a completed evidence handoff is never regenerated");
    assert.equal(reviewCalls, response ? 2 : 1, "a durably recorded review is never repeated");
    assert.equal(f.calls.filter((call) => call === "evaluate").length, 1, "completed delivery evaluation survives publication interruption");
    assert.equal(f.run().reviewRounds.length, response ? 11 : 10);
    if (response) {
      const answered = f.run().reviewRounds.at(-2);
      assert.ok(answered.authorResponse && answered.completedAt && answered.authorCommit);
    }
    assert.equal(f.orchestrator.agentClaims.size, 0);
    assert.equal(f.orchestrator.activeAgents.size, 0);
  });
});

test("A to B rejection rollover survives real synchronization and restart without resampling unchanged B", async (t) => {
  const f = await fixture(t);
  const a = structuredClone(latestFullAssessment(f.run()));
  f.world.score = 67;
  await f.orchestrator.retryAgent("agent");
  const bHead = f.world.head;
  assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", "base"), false);
  const b = latestFullAssessment(f.run());
  assert.equal(b.candidateCommit, bHead);
  assert.equal(b.impact, -3);
  assert.equal(b.deltas[0].after, 67);
  assert.notEqual(b.candidateTree, a.candidateTree);
  f.orchestrator.git.listPullRequests = async () => [await f.orchestrator.git.getPullRequest()];
  f.orchestrator.git.markPrDisposition = async () => undefined;
  f.orchestrator.ensureLivingComposite = async () => undefined;
  await f.orchestrator.syncPullRequests(true);
  assert.equal(f.run().status, "completed");
  assert.equal(f.run().prState, "open");
  const measurements = f.store.get().evaluationRuns;
  await restart(f);
  let repairs = 0;
  f.orchestrator.codex.revise = async (_cwd, _thread, feedback, _settings, kind) => {
    repairs += 1;
    assert.equal(kind, "evaluation");
    assert.match(feedback.summary, new RegExp(bHead));
    assert.match(feedback.findings[0].title, /70 -> 67/);
    return { threadId: "author", message: "No changes" };
  };
  const callsBefore = f.calls.length;
  await f.orchestrator.retryAgent("agent");
  assert.equal(f.run().continuation.step, "evidence", "the no-op author result was consumed");
  await restart(f);
  await f.orchestrator.retryAgent("agent");
  assert.equal(repairs, 1);
  assert.match(f.run().error, /rejected tree unchanged/);
  assert.equal(f.calls.slice(callsBefore).some((call) => call === "review" || call === "evaluate" || call === "evidence"), false);
  assert.deepEqual(latestFullAssessment(f.run()), b);
  assert.deepEqual(f.store.get().evaluationRuns, measurements);
  assert.equal(f.run().reviewRounds.length, 10);
  assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", "base"), false);
});

test("public A-B-A recovery retains every rejection through restart and trimming, while changed C still qualifies", async (t) => {
  for (const restored of [true, false]) await t.test(restored ? "restored A" : "changed C", async (t) => {
    const f = await receiptFixture(t, { signals: 1, score: 67 });
    const original = latestFullAssessment(f.run());
    assert.equal((await f.orchestrator.retryAgent("agent")).status, "completed");
    assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", "base"), false);
    const history = f.run().fullEvaluationHistory;
    assert.equal(history.length, 2);
    assert.deepEqual(history[0].assessment, original);
    assert.equal(history[1].assessment.candidateCommit, f.world.head);
    assert.equal(history[1].assessment.qualified, false);
    assert.equal(f.run().fullMergeValidation, undefined);
    const rows = f.store.get().evaluationRuns;
    await f.store.update((state) => {
      state.evaluationRuns.push(...Array.from({ length: 1100 }, (_, index) => ({
        id: `unrelated-history-${index}`, evaluationId: "signal-0", commit: "other", context: "agent", agentRunId: "other",
        status: "completed", score: 100, durationMs: 1, createdAt: new Date(Date.now() + index).toISOString(), evaluationDefinitionVersion: "v1",
      })));
    });
    await restart(f);
    assert.deepEqual(f.run().fullEvaluationHistory, history);
    for (const row of rows) assert.deepEqual(f.store.get().evaluationRuns.find((entry) => entry.id === row.id), row);
    const count = f.samples.length;
    const rounds = f.run().reviewRounds.length;
    f.world.score = 72;
    f.orchestrator.codex.revise = async (_cwd, thread, feedback, _settings, kind) => {
      assert.equal(thread, "author"); assert.equal(kind, "evaluation");
      assert.match(feedback.summary, new RegExp(history[1].assessment.candidateCommit));
      f.world.dirty = true; f.world.tree = restored ? "rejected-tree" : "changed-C-tree";
      return { threadId: "author", message: restored ? "Restored A" : "Changed C implementation" };
    };
    const result = await f.orchestrator.retryAgent("agent");
    assert.deepEqual(f.run().fullEvaluationHistory, history);
    if (restored) {
      assert.equal(result.status, "failed");
      assert.match(result.error, /rejected tree unchanged/);
      assert.equal(f.samples.length, count);
      assert.equal(result.reviewRounds.length, rounds);
      await restart(f);
      assert.equal((await f.orchestrator.retryAgent("agent")).status, "failed");
      assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", "base"), false);
      await assert.rejects(f.orchestrator.mergeAgent("agent"));
      assert.equal(f.samples.length, count);
      assert.equal(f.run().reviewRounds.length, rounds);
    } else {
      assert.equal(result.status, "completed", result.error);
      assert.equal(result.reviewRounds.length, rounds + 1);
      assert.equal(f.samples.length, count + 3);
      assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", "base"), true);
      assert.equal(f.samples.length, count + 6, "the new full prompt cohort remains independently owned");
      assert.deepEqual(f.run().fullEvaluationHistory.slice(0, 2), history);
      assert.equal(f.run().fullEvaluationHistory.length, 3);
      assert.equal(latestFullAssessment(f.run()).qualified, true);
      assert.deepEqual(fullAssessmentForIdentity(f.run(), original), original);
      assert.equal(f.run().fullMergeValidation, undefined);
      await restart(f);
      assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", "base"), true);
      assert.equal(f.samples.length, count + 6);
    }
    assert.equal(f.store.get().orchestrator.enabled, false);
    assert.equal(f.run().authorThreadId, "author");
    assert.equal(f.run().prNumber, 42);
  });
});

test("historical rejected-tree memory precedes a positive exact-identity cache", async (t) => {
  const f = await fixture(t);
  const original = latestFullAssessment(f.run());
  f.world.head = "later-positive-same-tree";
  f.world.remoteHead = f.world.head;
  await f.store.update((state) => {
    const run = state.agentRuns[0];
    delete run.fullMergeValidation;
    const positive = { ...structuredClone(original), candidateCommit: f.world.head, qualified: true,
      completedAt: "2026-09-02T00:00:00.000Z", deltas: [{ ...original.deltas[0], after: 71, delta: 1 }], impact: 1 };
    run.fullEvaluationHistory = [
      { kind: "assessment", assessment: original, comparison: { tree: "rejected-tree", progress: [] } },
      { kind: "assessment", assessment: positive, comparison: { tree: "rejected-tree", progress: [] } },
    ];
  });
  assert.equal(latestFullAssessment(f.run()).qualified, true);
  assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", "base"), false);
  await assert.rejects(f.orchestrator.mergeAgent("agent"), /rejected tree/);
  assert.equal(f.world.measurements, 0);
  assert.equal(f.calls.includes("review"), false);
});

test("target adoption retains distinct provable legacy repair feedback and refuses conflicting history", async (t) => {
  for (const scenario of ["distinct", "wrong-tree", "same-identity-conflict", "history-conflict"]) await t.test(scenario, async (t) => {
    const f = await receiptFixture(t, { signals: 1, score: 67 });
    const original = latestFullAssessment(f.run());
    assert.equal((await f.orchestrator.retryAgent("agent")).status, "completed");
    assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", "base"), false);
    const second = latestFullAssessment(f.run());
    const expected = f.run().fullEvaluationHistory;
    await f.store.update((state) => {
      const run = state.agentRuns[0];
      if (scenario === "history-conflict") {
        run.fullEvaluationHistory.push({ ...structuredClone(expected[0]), comparison: { tree: "different", progress: [] } });
        return;
      }
      delete run.fullEvaluationHistory;
      run.fullMergeValidation = second;
      run.evaluationRepair = { validation: scenario === "same-identity-conflict" ? { ...second, qualified: true } : original,
        deltas: original.deltas, rejectedTree: scenario === "wrong-tree" ? "wrong-tree" : original.candidateTree };
    });
    const before = f.run();
    const count = f.samples.length;
    const rounds = before.reviewRounds.length;
    let calls = 0;
    f.orchestrator.codex.revise = async () => { calls += 1; throw new Error("Stop after exact legacy adoption"); };
    if (scenario === "distinct") {
      assert.equal((await f.orchestrator.retryAgent("agent")).status, "failed");
      assert.equal(calls, 1);
      assert.equal(f.run().fullMergeValidation, undefined);
      assert.deepEqual(f.run().fullEvaluationHistory, expected);
      assert.deepEqual(f.run().evaluationRepair, before.evaluationRepair, "legacy repair input is read-only");
      assert.deepEqual(fullAssessmentForIdentity(f.run(), original), original);
      assert.deepEqual(fullAssessmentForIdentity(f.run(), second), second);
    } else {
      await assert.rejects(f.orchestrator.retryAgent("agent"), /Conflicting|rejected-tree proof/);
      assert.deepEqual(f.run(), before);
      assert.equal(calls, 0);
    }
    assert.equal(f.samples.length, count);
    assert.equal(f.run().reviewRounds.length, rounds);
  });
});

test("a completed final-budget delivery reuses canonical negative values rather than newer presentation values", async (t) => {
  const f = await fixture(t, { rounds: 12, limit: 12 });
  await f.store.update((state) => {
    const run = state.agentRuns[0];
    run.status = "failed";
    run.deltas = [{ ...run.deltas[0], after: 99, delta: 29, screening: true, summary: "Newer presentation" }];
    run.impact = 29;
  });
  const full = latestFullAssessment(f.run());
  await restart(f);
  const result = await f.orchestrator.retryAgent("agent");
  assert.equal(result.status, "completed");
  assert.equal(result.continuation.outcome, "completed");
  assert.deepEqual(result.deltas, full.deltas);
  assert.equal(result.impact, -2);
  assert.equal(f.calls.some((call) => call.revise || ["review", "evidence", "evaluate"].includes(call)), false);
  await assert.rejects(f.orchestrator.retryAgent("agent"), /no review budget|bounded review budget/);
  assert.equal(result.prNumber, 42);
});

test("unanchored old full rows are not importable even when presentation or newer scores agree", async (t) => {
  for (const newerScore of [68, 69]) await t.test(String(newerScore), async (t) => {
    const f = await fixture(t);
    await f.store.update((state) => {
      const run = state.agentRuns[0];
      delete run.fullMergeValidation.deltas; delete run.fullMergeValidation.impact; delete run.fullMergeValidation.candidateTree;
      state.evaluationRuns.find((row) => row.id === "original-full").summary = "Original confirmed regression";
      state.evaluationRuns.push({ ...state.evaluationRuns.find((row) => row.id === "original-full"), id: "newer-same-head", score: newerScore,
        createdAt: "2026-09-02T00:00:00.000Z", summary: "NEWER UNPROVEN SUMMARY" });
      run.deltas[0].after = newerScore; run.deltas[0].delta = newerScore - 70; run.deltas[0].summary = "NEWER UNPROVEN SUMMARY"; run.impact = newerScore - 70;
    });
    await assert.rejects(f.orchestrator.retryAgent("agent"), /historical measurement provenance|full-evaluation trace|legacy full/);
    assert.equal(f.calls.some((call) => call.revise || call === "evaluate"), false);
  });
});

test("legacy score retirement is normalized only with its exact diagnostic and known same PR", async (t) => {
  for (const scenario of ["open", "closed", "unknown-closure", "merged", "missing-head"]) await t.test(scenario, async (t) => {
    const f = await fixture(t);
    await f.store.update((state) => {
      const run = state.agentRuns[0];
      run.status = "failed"; run.prState = scenario === "open" ? "open" : "closed";
      run.error = "PR #42 exact-head full validation rejected the candidate: full evaluation regressions: CUDA parity -2.0.";
      run.quarantineReason = `Merge gate rejected PR #42: ${run.error}`;
      if (scenario === "unknown-closure") run.error = "Someone closed this PR";
    });
    f.world.remoteState = scenario === "open" ? "OPEN" : scenario === "merged" ? "MERGED" : "CLOSED";
    if (scenario === "missing-head") f.world.remoteHead = undefined;
    if (scenario === "open") {
      await f.orchestrator.retryAgent("agent");
      assert.equal(f.run().status, "completed");
      assert.equal(f.run().prNumber, 42);
      assert.equal(f.calls.includes("reopen"), false);
    } else {
      await assert.rejects(f.orchestrator.retryAgent("agent"));
      assert.equal(f.calls.some((call) => call.revise || call === "evaluate" || call === "reopen"), false);
    }
  });
});

test("ambiguous legacy evaluation author and partially recorded review response fail without effects", async (t) => {
  for (const mode of ["evaluation-author", "response-text-only", "response-time-only"]) await t.test(mode, async (t) => {
    const f = await fixture(t);
    await f.store.update((state) => {
      const run = state.agentRuns[0]; run.status = "failed";
      run.evaluationRepair = { validation: structuredClone(run.fullMergeValidation), deltas: run.deltas, rejectedTree: "rejected-tree" };
      if (mode === "evaluation-author") delete run.reviewRounds.at(-1).evaluationFingerprint;
      else {
        const round = run.reviewRounds.at(-1); round.approved = false;
        if (mode === "response-text-only") { round.authorResponse = "Done"; delete round.completedAt; }
      }
    });
    const before = f.run();
    await assert.rejects(f.orchestrator.retryAgent("agent"), /ambiguous/);
    assert.deepEqual(f.run(), before);
    assert.equal(f.calls.some((call) => call.revise || call === "evaluate" || call === "push"), false);
  });
});

test("consumed legacy response continues with evidence instead of applying the same review again", async (t) => {
  const f = await fixture(t);
  await f.store.update((state) => {
    const run = state.agentRuns[0]; run.status = "failed"; run.reviewApproved = false;
    Object.assign(run.reviewRounds.at(-1), { approved: false, authorResponse: "Already repaired", findings: [{ severity: "high", title: "Old blocker", detail: "Already fixed", file: "code.rs" }] });
    delete run.fullMergeValidation;
  });
  await f.orchestrator.retryAgent("agent");
  assert.equal(f.run().status, "completed");
  assert.equal(f.calls.some((call) => call.revise), false);
  assert.equal(f.calls.filter((call) => call === "evidence").length, 1);
  assert.equal(f.run().reviewRounds.at(-2).authorResponse, "Already repaired");
});

test("retained done continuations protect all measurements and historical comparison bases through trimming", async (t) => {
  const f = await fixture(t);
  await f.orchestrator.retryAgent("agent");
  const retained = f.store.get().evaluationRuns.map((row) => row.id);
  await f.store.update((state) => {
    state.agentRuns[0].reviewRounds[0].baseCommit = "earlier-base";
    state.evaluationRuns.push({ ...state.evaluationRuns[0], id: "earlier-comparison", commit: "earlier-base" });
    state.evaluationRuns.push(...Array.from({ length: 1_100 }, (_, index) => ({
      id: `unrelated-${index}`, evaluationId: "perf", commit: "unrelated", context: "agent", agentRunId: "other", status: "completed", score: 1,
      durationMs: 1, createdAt: timestamp, evaluationDefinitionVersion: "v1",
    })));
  });
  await restart(f);
  const ids = new Set(f.store.get().evaluationRuns.map((row) => row.id));
  for (const id of [...retained, "earlier-comparison"]) assert.equal(ids.has(id), true, id);
  assert.equal(ids.has("unrelated-0"), false);
  assert.equal(f.run().reviewRounds.length, 10);
  assert.equal(f.run().continuation.step, "done");
});

test("awaited author, evidence, reviewer and evaluation identity changes cannot advance or publish", async (t) => {
  for (const phase of ["author", "evidence", "review", "evaluation"]) await t.test(phase, async (t) => {
    const f = await fixture(t);
    const replace = (object, key) => {
      const original = object[key];
      object[key] = async function (...args) { const result = await original.apply(this, args); f.world.head = "unexpected-head"; return result; };
    };
    if (phase === "author") replace(f.orchestrator.codex, "revise");
    if (phase === "evidence") replace(f.orchestrator.codex, "refreshAgentEvidence");
    if (phase === "review") replace(f.orchestrator.codex, "review");
    if (phase === "evaluation") replace(f.orchestrator.codex, "evaluate");
    await f.orchestrator.retryAgent("agent");
    assert.equal(f.run().status, "failed");
    assert.match(f.run().error, /branch\/head or worktree changed|clean pinned Git identity/);
    assert.equal(f.calls.includes("push"), false);
    assert.equal(latestFullAssessment(f.run()).candidateCommit, "rejected");
    assert.equal(f.run().reviewRounds.length, phase === "evaluation" ? 10 : 9);
    assert.equal(f.orchestrator.agentClaims.size, 0);
  });
});

test("session-start checkpoints remain compatible with a legitimate completed phase", async (t) => {
  const f = await fixture(t);
  const revise = f.orchestrator.codex.revise;
  f.orchestrator.codex.revise = async (...args) => {
    await f.orchestrator.checkpointAuthorSession(f.root, "resumed-author");
    return { ...await revise(...args), threadId: "resumed-author" };
  };
  assert.equal((await f.orchestrator.retryAgent("agent")).status, "completed");
  assert.equal(f.calls.filter((call) => call.revise).length, 1);
});

test("the shared initial loop retains no-change, no-PR, absorbed and rejected terminal outcomes", async (t) => {
  for (const outcome of ["no_changes", "completed", "absorbed", "rejected"]) await t.test(outcome, async (t) => {
    const f = await fixture(t);
    const parent = outcome === "absorbed" || outcome === "rejected";
    await f.store.update((state) => {
      state.agentRuns = [];
      Object.assign(state.ideas[0], { status: "queued", agentRunId: undefined });
      state.settings.autoCreatePrs = false;
      if (parent) state.composites = [{ id: "living", title: "Living line", branch: "burner/living", worktree: "", status: "open", sources: [], deltas: [], reviewRounds: [], reviewApproved: true, createdAt: timestamp, updatedAt: timestamp }];
    });
    f.world.head = "base"; f.world.tree = "base-tree"; f.world.remoteHead = null;
    if (outcome === "rejected") f.world.score = 69;
    const resolve = f.orchestrator.git.resolveRef;
    f.orchestrator.git.resolveRef = async (ref) => ref === "burner/living" ? "base" : resolve(ref);
    f.orchestrator.codex.implement = async (_cwd, idea, _evaluations, _settings, thread) => {
      assert.equal(idea.description, "Preserve coverage");
      assert.equal(thread, undefined);
      f.calls.push("implement");
      if (outcome !== "no_changes") { f.world.dirty = true; f.world.tree = "initial-tree"; }
      return { threadId: "initial-author", message: "Original task complete" };
    };
    const lease = await f.orchestrator.locks.tryAcquireAll([], "initial-agent");
    assert.ok(lease);
    await f.orchestrator.runIdea(f.store.get().ideas[0], {
      ref: parent ? "burner/living" : "main", commit: "base", baseline: f.store.latestRuns(), ...(parent ? { compositeId: "living" } : {}),
    }, [], lease);
    const run = f.run();
    assert.equal(run.status, outcome, run.error);
    assert.equal(run.continuation.step, "done");
    assert.equal(run.continuation.outcome, outcome);
    assert.equal(run.initialAuthorMessage, "Original task complete");
    assert.equal(run.authoringComplete, undefined, "new-format runs have only one completion owner");
    assert.equal(run.prNumber, undefined);
    assert.equal(f.store.get().ideas[0].status, "completed");
    assert.equal(f.calls.filter((call) => call === "implement").length, 1);
    assert.equal(f.calls.filter((call) => call === "evaluate").length, outcome === "no_changes" ? 0 : 1);
    assert.equal(f.calls.filter((call) => call === "push").length, outcome === "absorbed" ? 1 : 0);
    if (parent) assert.equal(f.store.get().composites[0].status, outcome === "absorbed" ? "rebuilding" : "open");
    await restart(f);
    assert.equal(f.run().continuation.outcome, outcome);
    assert.equal(f.store.get().ideas[0].status, "completed");
  });
});

test("base refresh carries an unfinished initial task but consumes a proven initial-author receipt", async (t) => {
  for (const completedAuthor of [false, true]) await t.test(String(completedAuthor), async (t) => {
    const f = await fixture(t, { rounds: 0 });
    const g = await leafRefreshRepository(f.root, { branch: "burner/repair" });
    f.orchestrator.git = g.git;
    delete f.orchestrator.assertCandidateDoesNotOwnProgress;
    let prepared;
    if (completedAuthor) {
      await writeFile(join(g.worktree, "initial-result.txt"), "Proven original implementation\n");
      prepared = await g.git.prepareLeafCommit(g.worktree, "burner/repair", g.head);
    }
    const originalTree = await g.git.tree(g.head);
    await f.store.update((state) => {
      const run = state.agentRuns[0];
      Object.assign(run, { worktree: g.worktree, baseCommit: g.base, status: "failed", reviewApproved: false, prNumber: undefined, prState: undefined, prUrl: undefined, authoringComplete: false });
      delete run.leafPr;
      Object.assign(run.fullMergeValidation, { baseCommit: g.base, candidateCommit: g.head, candidateTree: originalTree });
      state.evaluationRuns[0].commit = g.base;
      state.evaluationRuns[1].commit = g.head;
      const common = { id: "interrupted-initial", head: g.head, identity: f.orchestrator.continuationIdentity(run, state) };
      run.continuation = completedAuthor
        ? { ...common, step: "commit", tree: prepared.tree, source: { kind: "author", reason: { kind: "initial" } }, result: { threadId: "author", message: "Proven original implementation" }, commitMessage: "initial implementation" }
        : { ...common, step: "author", reason: { kind: "initial" } };
      state.settings.autoCreatePrs = false;
      state.evaluationRuns.push({ ...state.evaluationRuns[0], id: "new-baseline", commit: g.target, createdAt: "2026-09-02T00:00:00.000Z" });
    });
    const full = latestFullAssessment(f.run());
    f.orchestrator.codex.implement = async (_cwd, idea, _evaluations, _settings, thread) => {
      assert.equal(completedAuthor, false, "a durably completed initial author is not replayed");
      assert.equal(thread, "author");
      assert.equal(idea.description, "Preserve coverage");
      assert.equal(f.run().continuation.reason.kind, "initial");
      assert.equal(f.run().baseCommit, g.target);
      f.calls.push("implement");
      await writeFile(join(g.worktree, "initial-result.txt"), "Finished original task on refreshed base\n");
      return { threadId: "author", message: "Finished original task on refreshed base" };
    };
    const result = await f.orchestrator.refreshAgentBaseAndRetry("agent");
    assert.equal(result.status, "completed", result.error);
    assert.equal(result.continuation.identity.baseCommit, g.target);
    assert.equal(result.continuation.outcome, "completed");
    assert.equal(result.initialAuthorMessage, completedAuthor ? "Proven original implementation" : "Finished original task on refreshed base");
    assert.equal(f.calls.filter((call) => call === "implement").length, completedAuthor ? 0 : 1);
    assert.equal(f.calls.filter((call) => call === "evidence").length, 1);
    assert.equal(result.reviewRounds.length, 1);
    assert.deepEqual(latestFullAssessment(result), full, "old-base evidence remains history, not a new-base rejection guard");
    assert.equal(f.calls.filter((call) => call === "release").length, 1);
    assert.equal(f.orchestrator.agentClaims.size, 0);
    assert.equal(g.calls.merges.length, 1);
    assert.equal(g.calls.pushes.length, 1);
  });
});

test("full validation never cleans an unexpected dirty, wrong-head or wrong-worktree checkpoint", async (t) => {
  for (const drift of ["dirty-at-entry", "dirty-during-evaluation", "head-during-evaluation", "wrong-worktree"]) await t.test(drift, async (t) => {
    const f = await fixture(t);
    f.world.head = "fresh-candidate"; f.world.tree = "fresh-tree";
    if (drift === "dirty-at-entry") f.world.dirty = true;
    if (drift === "wrong-worktree") f.orchestrator.git.assertWorktree = async () => { throw new Error("Wrong worktree identity"); };
    const evaluate = f.orchestrator.codex.evaluate;
    f.orchestrator.codex.evaluate = async function (...args) {
      const result = await evaluate.apply(this, args);
      if (drift === "dirty-during-evaluation") f.world.dirty = true;
      if (drift === "head-during-evaluation") f.world.head = "unexpected-head";
      return result;
    };
    const before = f.run();
    if (drift === "wrong-worktree") await assert.rejects(f.orchestrator.fullyValidateLeafForMerge("agent", "base"), /Wrong worktree identity/);
    else if (drift.includes("during-evaluation")) {
      await assert.rejects(f.orchestrator.fullyValidateLeafForMerge("agent", "base"), /clean pinned Git identity/);
      assert.equal(f.run().fullEvaluation.step, "sampling", "the independently completed sample remains owned despite Git drift");
      assert.deepEqual(latestFullAssessment(f.run()), latestFullAssessment(before));
      assert.equal(f.run().fullMergeValidation, undefined);
      const { fullEvaluation, fullEvaluationHistory, fullMergeValidation, leafQualificationPolicy, ...afterInputs } = f.run();
      const { fullMergeValidation: oldAlias, ...beforeInputs } = before;
      assert.deepEqual(afterInputs, beforeInputs, "only receipt admission and exact legacy adoption may progress");
    } else {
      assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", "base"), false);
      assert.deepEqual(f.run(), before);
    }
    assert.equal(f.calls.includes("cleanup"), false);
    assert.equal(f.calls.includes("edit"), false);
    assert.equal(f.orchestrator.agentClaims.size, 0);
  });
});

test("base refresh accounts for a prepared author result before refusing new work at the cumulative budget limit", async (t) => {
  const f = await fixture(t, { rounds: 12 });
  const g = await leafRefreshRepository(f.root, { branch: "burner/repair" });
  f.orchestrator.git = g.git;
  delete f.orchestrator.assertCandidateDoesNotOwnProgress;
  await writeFile(join(g.worktree, "completed-author.txt"), "Completed original author effect\n");
  const receipt = await g.git.prepareLeafCommit(g.worktree, "burner/repair", g.head);
  await f.store.update((state) => {
    const run = state.agentRuns[0];
    Object.assign(run, { worktree: g.worktree, baseCommit: g.base, status: "failed", reviewApproved: false, prNumber: undefined, prState: undefined, prUrl: undefined });
    delete run.leafPr;
    run.continuation = { id: "pending-author", step: "commit", head: g.head, tree: receipt.tree,
      identity: f.orchestrator.continuationIdentity(run, state), source: { kind: "author", reason: { kind: "initial" } },
      result: { threadId: "author", message: "Completed initial work" }, commitMessage: "initial implementation" };
  });
  await assert.rejects(f.orchestrator.refreshAgentBaseAndRetry("agent"), /no review budget remains/);
  assert.equal(f.run().initialAuthorMessage, "Completed initial work");
  assert.equal(f.run().continuation.step, "evidence");
  assert.notEqual(await g.git.head(g.worktree), g.head);
  assert.equal(await g.git.tree(await g.git.head(g.worktree)), receipt.tree);
  assert.equal(await g.git.hasChanges(g.worktree), false);
  assert.equal(f.run().reviewRounds.length, 12);
  assert.deepEqual(g.calls.merges, []);
  assert.deepEqual(g.calls.pushes, []);
  assert.ok(!f.calls.some((call) => ["evidence", "review", "evaluate"].includes(call) || call.revise));
  assert.equal(f.orchestrator.agentClaims.size, 0);
  assert.equal(f.calls.filter((call) => call === "release").length, 1);
});

test("quarantined checkpoint publication recovers only the saved PR or exact cursor head", async (t) => {
  for (const scenario of ["push-before-receipt", "create-before-receipt", "known-closed", "third-head", "wrong-branch", "wrong-pr", "unproven-closure"]) await t.test(scenario, async (t) => {
    const f = await fixture(t);
    await f.store.update((state) => {
      const run = state.agentRuns[0];
      Object.assign(run, { status: "failed", reviewApproved: false, quarantinedAt: timestamp, quarantineReason: "Review yielded with 10 minutes left so fallback work can use the merge reserve." });
      Object.assign(run.reviewRounds.at(-1), { commit: "checkpoint", approved: false, completedAt: undefined, findings: [{ severity: "high", title: "Blocker", detail: "Finish the review fix", file: "code.rs" }] });
      run.continuation = { id: "quarantined-review", step: "author", reason: { kind: "review", roundId: run.reviewRounds.at(-1).id }, head: "checkpoint",
        identity: f.orchestrator.continuationIdentity(run, state, { number: 42, headRefOid: "rejected", url: run.prUrl }),
      };
      if (scenario === "create-before-receipt") { delete run.prNumber; delete run.prState; delete run.prUrl; delete run.leafPr; delete run.continuation.identity.pullRequest; }
    });
    f.world.head = "checkpoint"; f.world.tree = "checkpoint-tree";
    if (scenario === "create-before-receipt") f.world.remoteHead = null;
    let created = false;
    f.orchestrator.git.pullRequestsForBranch = async () => created ? [await f.orchestrator.git.getPullRequest()] : [];
    const push = f.orchestrator.git.push;
    if (scenario === "create-before-receipt") {
      f.orchestrator.git.findLeafPrs = async () => created ? [await f.orchestrator.git.observeLeafPr(f.root, f.run().leafPr.repository, 42)] : [];
      f.orchestrator.git.createLeafPr = async (input) => {
        created = true; f.world.remoteTitle = input.title; f.world.remoteBody = input.body; f.world.remoteDraft = input.isDraft;
        throw new Error("Create succeeded before receipt");
      };
    }
    else f.orchestrator.git.push = async (...args) => { await push(...args); throw new Error("Push succeeded before receipt"); };
    const claim = f.orchestrator.claimAgents(["agent"]);
    try { await assert.rejects(f.orchestrator.publishAgentCheckpoint(f.store.get().ideas[0], "agent", f.root, "burner/repair", f.store.get().settings, claim), /succeeded before receipt/); }
    finally { claim.release(); }
    f.orchestrator.git.push = push;
    if (scenario === "known-closed" || scenario === "unproven-closure") f.world.remoteState = "CLOSED";
    if (scenario === "third-head") f.world.remoteHead = "unrelated-third-head";
    if (scenario === "wrong-branch") {
      const getPr = f.orchestrator.git.getPullRequest;
      f.orchestrator.git.getPullRequest = async () => ({ ...await getPr(), headRefName: "other-branch" });
    }
    if (scenario === "wrong-pr") await f.store.update((state) => { state.agentRuns[0].prNumber = 43; });
    if (scenario === "unproven-closure") await f.store.update((state) => { delete state.agentRuns[0].quarantinedAt; delete state.agentRuns[0].quarantineReason; });
    if (created) {
      f.orchestrator.git.listPullRequests = async () => [await f.orchestrator.git.getPullRequest()];
      f.orchestrator.ensureLivingComposite = async () => undefined;
      await f.orchestrator.syncPullRequests(true);
      assert.equal(f.run().prNumber, 42, "sync resumes the saved create token/tuple owner, not branch-only adoption");
      assert.equal(f.run().leafPr.pending, undefined);
      assert.equal(f.run().continuation.publication, undefined);
    }
    await restart(f);
    f.calls.length = 0;
    if (["push-before-receipt", "create-before-receipt"].includes(scenario)) {
      const result = await f.orchestrator.retryAgent("agent");
      assert.equal(result.status, "completed", result.error);
      assert.equal(result.prNumber, 42);
      assert.equal(result.continuation.identity.pullRequest.head, f.world.head);
      assert.equal(f.calls.filter((call) => call.revise).length, 1);
      assert.equal(f.calls.includes("reopen"), false);
    } else {
      const before = f.run();
      await assert.rejects(f.orchestrator.retryAgent("agent"));
      assert.deepEqual(f.run(), before);
      assert.equal(f.calls.some((call) => call.revise || ["push", "reopen", "evaluate", "review"].includes(call)), false);
    }
    assert.equal(f.orchestrator.agentClaims.size, 0);
  });
});

test("cleanup is optional after atomic done and never deletes newly dirty files", async (t) => {
  for (const mode of ["cleanup-failure", "new-dirty-files"]) await t.test(mode, async (t) => {
    const f = await fixture(t);
    if (mode === "cleanup-failure") f.orchestrator.git.removeWorktree = async () => { throw new Error("Injected cleanup failure"); };
    else f.store.subscribe((state) => { if (state.agentRuns[0].continuation?.step === "done") f.world.dirty = true; });
    assert.equal((await f.orchestrator.retryAgent("agent")).status, "completed");
    assert.equal(f.calls.includes("cleanup"), false);
    await restart(f);
    assert.equal(f.run().continuation.outcome, "completed");
    assert.equal(f.store.get().ideas[0].status, "completed");
    assert.equal(f.calls.filter((call) => call === "evaluate").length, 1);
  });
});

async function receiptFixture(t, { baselineCount = 3, signals = 2, command = false, score = 70 } = {}) {
  const f = await fixture(t);
  const worktree = await mkdtemp(join(f.root, "candidate-"));
  await f.store.update((state) => {
    state.evaluations = Array.from({ length: signals }, (_, index) => ({ id: `signal-${index}`, name: `Signal ${index}`,
      prompt: "Compare the exact candidate and baseline", ...(command ? { command: "fixture-command" } : {}),
      definitionVersion: "v1", weight: index + 1, enabled: true, createdAt: timestamp }));
    state.evaluationRuns = state.evaluations.map((evaluation) => ({ id: `base-${evaluation.id}`, evaluationId: evaluation.id,
      score: 70, summary: `Frozen ${evaluation.name}`, commit: "base", context: "baseline", status: "completed", durationMs: 1,
      createdAt: timestamp, evaluationDefinitionVersion: "v1", ...(!command && baselineCount > 1 ? { promptSampleCount: baselineCount } : {}) }));
    const run = state.agentRuns[0];
    run.worktree = worktree;
    run.deltas = state.evaluations.map((evaluation) => ({ evaluationId: evaluation.id, name: evaluation.name, before: 70, after: 69, delta: -1, summary: "Saved rejection" }));
    run.impact = -1;
    run.fullMergeValidation = { ...run.fullMergeValidation, evaluationFingerprint: fullMergeValidationFingerprint(state), deltas: structuredClone(run.deltas), impact: -1 };
    for (const round of run.reviewRounds) round.evaluationFingerprint = fullMergeValidationFingerprint(state);
  });
  f.world.score = score;
  f.worktree = worktree;
  f.samples = [];
  f.orchestrator.git.head = async (cwd) => cwd === f.root ? "base" : f.world.head;
  f.orchestrator.git.hasChanges = async (cwd) => cwd === f.root ? false : f.world.dirty;
  f.orchestrator.git.createExistingWorktree = async () => worktree;
  f.orchestrator.codex.evaluate = async (_cwd, evaluation, _settings, context, baseline) => {
    f.samples.push({ evaluationId: evaluation.id, context, baseline: baseline && structuredClone(baseline), screening: Boolean(evaluation.screeningCommand) });
    return { score: context === "baseline" ? 70 : f.world.score, summary: `${context} ${evaluation.id} sample ${f.samples.length}`,
      evidence: [`Evidence ${f.samples.length}`], suggestions: [] };
  };
  return f;
}

const receiptOf = (f, purpose) => purpose === "full" ? f.run().fullEvaluation?.evaluation ?? latestFullAssessment(f.run())?.evaluation : f.run().continuation.evaluation;
const resumeReceipt = (f, purpose) => purpose === "full" ? f.orchestrator.fullyValidateLeafForMerge("agent", "base") : f.orchestrator.retryAgent("agent");

async function incompleteSampleFixture(t) {
  const f = await receiptFixture(t, { signals: 1 });
  assert.equal((await f.orchestrator.retryAgent("agent")).status, "completed");
  const runLeafEvaluation = f.orchestrator.runLeafEvaluation.bind(f.orchestrator);
  let candidateError;
  f.orchestrator.codex.evaluate = async () => { throw new Error("Injected sample transport failure"); };
  f.orchestrator.runLeafEvaluation = async (...args) => {
    try { return await runLeafEvaluation(...args); }
    catch (error) { candidateError = error; throw error; }
  };
  assert.equal(await resumeReceipt(f, "full"), false);
  assert.ok(candidateError instanceof Error && !(candidateError instanceof AggregateError));
  assert.match(candidateError.message, /incomplete candidate sample 0 after targeted retries/);
  assert.equal(receiptOf(f, "full").evaluations[0].candidate[0].attempts.length, 2);
  return { ...f, candidateError };
}

function sampleFailureCases(candidateError) {
  const nested = new AggregateError([candidateError, candidateError], "Nested sample failures");
  return [
    { name: "single", error: candidateError, retryable: true },
    { name: "multiple", error: nested, retryable: true },
    { name: "nested", error: new AggregateError([candidateError, nested], "Sample failures"), retryable: true },
    { name: "mixed nested", error: new AggregateError([candidateError,
      new AggregateError([candidateError, new Error("Receipt persistence failed")], "Nested persistence failure")], "Mixed failures"), retryable: false },
    { name: "hard-first nested", error: new AggregateError([
      new AggregateError([new Error("Receipt persistence failed"), candidateError], "Nested persistence failure"), candidateError], "Mixed failures"), retryable: false },
    { name: "outer release failure", error: new AggregateError([nested, new Error("Resource lease release failed")], "Work and release failures"), retryable: false },
    { name: "empty", error: new AggregateError([], "Empty failures"), retryable: false },
    { name: "nested empty", error: new AggregateError([candidateError, new AggregateError([], "Empty failures")], "Nested empty failures"), retryable: false },
  ];
}

test("public full validation classifies only nonempty all-candidate error aggregates as incomplete", async (t) => {
  // Capture the private error from a genuine exhausted fill, not its name or an exported classifier.
  const f = await incompleteSampleFixture(t);
  const pending = structuredClone(f.run().fullEvaluation);
  const assessment = structuredClone(latestFullAssessment(f.run()));
  for (const { name, error, retryable } of sampleFailureCases(f.candidateError)) await t.test(name, async () => {
    f.orchestrator.runLeafEvaluation = async () => { throw error; };
    if (retryable) assert.equal(await resumeReceipt(f, "full"), false);
    else await assert.rejects(resumeReceipt(f, "full"), (caught) => caught === error, "the original hard aggregate must escape intact");
    assert.deepEqual(f.run().fullEvaluation, pending);
    assert.deepEqual(latestFullAssessment(f.run()), assessment);
    assert.equal(f.orchestrator.agentClaims.size, 0);
  });
});

test("runIdea grants one bounded retry only to nonempty all-candidate error aggregates", async (t) => {
  const { candidateError } = await incompleteSampleFixture(t);
  const nested = new AggregateError([candidateError, new AggregateError([candidateError], "Nested sample failure")], "Sample failures");
  const cases = [...sampleFailureCases(candidateError),
    { name: "retry already spent", error: nested, retryable: true, previousRetries: 1 },
    { name: "orchestrator disabled", error: nested, retryable: true, enabled: false }];
  for (const { name, error, retryable, previousRetries = 0, enabled = true } of cases) await t.test(name, async (t) => {
    const f = await fixture(t);
    await f.store.update((state) => {
      state.agentRuns = [];
      Object.assign(state.ideas[0], { status: "queued", agentRunId: undefined });
      state.orchestrator.enabled = enabled;
    });
    f.orchestrator.continueLeaf = async (_idea, _base, runId) => {
      if (previousRetries) await f.store.update((state) => { state.agentRuns.find((run) => run.id === runId).evaluationRetryCount = previousRetries; });
      throw error;
    };
    f.orchestrator.schedule = async () => undefined;
    const retries = [];
    f.orchestrator.retryAgent = async (runId) => {
      retries.push({ runId, claims: f.orchestrator.agentClaims.size, active: f.orchestrator.activeAgents.size, released: f.calls.includes("release") });
      return f.run();
    };
    const lease = await f.orchestrator.locks.tryAcquireAll([], "initial-agent");
    assert.ok(lease);
    f.orchestrator.activeAgents.add("idea");
    await f.orchestrator.runIdea(f.store.get().ideas[0], { ref: "main", commit: "base", baseline: f.store.latestRuns() }, [], lease);
    const run = f.run();
    assert.equal(run.status, "failed");
    assert.equal(run.error, error.message, "classification must not replace the original aggregate message");
    assert.equal(run.evaluationRetryCount, previousRetries || (retryable ? 1 : undefined));
    assert.deepEqual(retries, retryable && !previousRetries && enabled
      ? [{ runId: run.id, claims: 0, active: 0, released: true }] : []);
    assert.equal(f.orchestrator.agentClaims.size, 0);
    assert.equal(f.calls.filter((call) => call === "release").length, 1);
  });
});

function failBeforeReceiptWrite(f, predicate) {
  const update = f.store.update.bind(f.store);
  let failed = false;
  f.store.update = (mutator) => update((draft) => {
    mutator(draft);
    if (!failed && predicate(draft)) { failed = true; throw new Error("Injected receipt write failure before rename"); }
  });
  return () => failed;
}

test("public delivery/full resume seed A after sibling B exhausts only its unfinished slot", async (t) => {
  for (const purpose of ["delivery", "full"]) await t.test(purpose, async (t) => {
    const f = await receiptFixture(t);
    if (purpose === "full") assert.equal((await f.orchestrator.retryAgent("agent")).status, "completed");
    const savedFull = latestFullAssessment(f.run());
    const evaluate = f.orchestrator.codex.evaluate;
    let failures = 0;
    f.orchestrator.codex.evaluate = async (...args) => {
      if (args[1].id === "signal-1") { failures += 1; throw new Error("Sibling transport interrupted"); }
      return evaluate(...args);
    };
    const result = await resumeReceipt(f, purpose);
    assert.equal(purpose === "full" ? result : result.status, purpose === "full" ? false : "failed");
    assert.equal(failures, 2, "existing two-pass policy is unchanged");
    const receipt = receiptOf(f, purpose);
    const firstId = receipt.evaluations[0].candidate[0].success.runId;
    const first = f.store.get().evaluationRuns.find((row) => row.id === firstId);
    assert.equal(receipt.evaluations[1].candidate[0].attempts.length, 2);
    assert.deepEqual(latestFullAssessment(f.run()), savedFull);
    // A later baseline must not replace the receipt's frozen comparison.
    await f.store.update((state) => state.evaluationRuns.push(...state.evaluationRuns.filter((row) => row.context === "baseline").map((row) =>
      ({ ...row, id: `later-${row.id}`, score: 95, createdAt: new Date().toISOString() }))));
    f.orchestrator.codex.evaluate = evaluate;
    const count = f.samples.length;
    await restart(f);
    const resumed = await resumeReceipt(f, purpose);
    assert.equal(purpose === "full" ? resumed : resumed.status, purpose === "full" ? true : "completed");
    assert.deepEqual(f.store.get().evaluationRuns.find((row) => row.id === firstId), first);
    assert.equal(f.samples.length, count + 1, "the successful sibling never runs again");
    assert.equal(f.samples.at(-1).baseline.score, 70);
    assert.equal(receiptOf(f, purpose).result.selections[0].candidate, firstId);
    assert.equal(f.run().reviewRounds.length, 10);
    assert.equal(f.store.get().orchestrator.enabled, false);
    assert.equal(f.calls.includes("schedule"), false);
  });
});

test("candidate and baseline confirmation slots survive sibling and aggregate persistence failures", async (t) => {
  for (const purpose of ["delivery", "full"]) for (const cut of ["candidate-confirmation", "baseline-confirmation", "aggregate", "verdict"]) {
    if (purpose === "delivery" && cut === "verdict") continue;
    await t.test(`${purpose}/${cut}`, async (t) => {
      const f = await receiptFixture(t, { signals: 1, baselineCount: 1, score: 71 });
      if (purpose === "full") {
        f.world.score = 70;
        assert.equal((await f.orchestrator.retryAgent("agent")).status, "completed");
        f.world.score = 71;
      }
      const wasCut = failBeforeReceiptWrite(f, (state) => {
        const run = state.agentRuns[0];
        const receipt = purpose === "full" ? run.fullEvaluation?.evaluation : run.continuation?.evaluation;
        if (cut === "verdict") return run.fullEvaluation?.step === "publication";
        if (!receipt) return false;
        if (cut === "aggregate") return Boolean(receipt.result);
        const side = cut === "candidate-confirmation" ? "candidate" : "baseline";
        return state.evaluationRuns.some((row) => row.status === "completed" && row.leafSample?.receiptId === receipt.id &&
          row.leafSample.side === side && row.leafSample.index === 2);
      });
      if (purpose === "full") await assert.rejects(resumeReceipt(f, purpose), /before rename/);
      else assert.equal((await resumeReceipt(f, purpose)).status, "failed");
      assert.equal(wasCut(), true);
      const receipt = receiptOf(f, purpose);
      const completed = f.store.get().evaluationRuns.filter((row) => row.status === "completed" && row.leafSample?.receiptId === receipt.id);
      assert.ok(completed.some((row) => row.leafSample.index === 0));
      const count = f.samples.length;
      const aggregateTime = receipt.result?.completedAt;
      await restart(f);
      const result = await resumeReceipt(f, purpose);
      assert.equal(purpose === "full" ? result : result.status, purpose === "full" ? true : "completed");
      const final = receiptOf(f, purpose);
      for (const row of completed) assert.deepEqual(f.store.get().evaluationRuns.find((saved) => saved.id === row.id), row);
      assert.equal(f.samples.length, count + (cut.endsWith("confirmation") ? 1 : 0));
      assert.equal(final.result.selections[0].count, 3);
      assert.equal(final.result.selections[0].baselineCount, 3);
      const raw = f.store.get().evaluationRuns.filter((row) => row.leafSample?.receiptId === final.id);
      assert.equal(raw.every((row) => row.promptSampleCount === undefined && row.sourceRunIds === undefined), true, "raw rows are not forged medians");
      const median = f.store.get().evaluationRuns.find((row) => row.id === final.evaluations[0].baselineMedian.runId);
      assert.equal(median.sourceRunIds.length, 3);
      if (aggregateTime) assert.equal(latestFullAssessment(f.run()).completedAt, aggregateTime);
      assert.equal(f.run().reviewRounds.length, 10);
    });
  }
});

test("durable successful samples survive listener, notification and resource-release exceptions", async (t) => {
  for (const fault of ["listener-after-rename", "notification", "release"]) await t.test(fault, async (t) => {
    const f = await receiptFixture(t, { signals: 1, command: true });
    let fired = false;
    if (fault === "listener-after-rename") f.store.subscribe((state) => {
      if (!fired && state.evaluationRuns.some((row) => row.leafSample && row.status === "completed")) {
        fired = true; throw new Error("Listener failed after durable rename");
      }
    });
    if (fault === "notification") {
      const emit = f.orchestrator.events.emit.bind(f.orchestrator.events);
      f.orchestrator.events.emit = (type, value) => {
        if (!fired && type === "evaluation" && value.status === "completed") { fired = true; throw new Error("Completed notification failed"); }
        return emit(type, value);
      };
    }
    if (fault === "release") {
      const acquire = f.orchestrator.locks.acquire.bind(f.orchestrator.locks);
      f.orchestrator.locks.acquire = async (...args) => {
        const held = await acquire(...args);
        const release = held.release;
        held.release = async () => {
          await release();
          if (!fired && args[0] === "cpu-heavy") { fired = true; throw new Error("Sample resource release failed"); }
        };
        return held;
      };
    }
    const first = await f.orchestrator.retryAgent("agent");
    assert.equal(fired, true);
    const receipt = receiptOf(f, "delivery");
    const source = f.store.get().evaluationRuns.find((row) => row.id === receipt.evaluations[0].candidate[0].success.runId);
    assert.equal(source.status, "completed");
    assert.equal(f.samples.length, 1);
    await restart(f);
    if (first.status !== "completed") assert.equal((await f.orchestrator.retryAgent("agent")).status, "completed");
    assert.equal(f.samples.length, 1);
    assert.deepEqual(f.store.get().evaluationRuns.find((row) => row.id === source.id), source);
  });
});

test("a completed full verdict and its unfinished PR edit are separately durable facts", async (t) => {
  for (const cut of ["before-edit", "after-edit", "ack-before-rename"]) await t.test(cut, async (t) => {
    const f = await receiptFixture(t, { signals: 1 });
    assert.equal((await f.orchestrator.retryAgent("agent")).status, "completed");
    // Full scores differ from delivery so the desired body needs an edit.
    f.world.score = 71;
    const edit = f.orchestrator.git.editPr;
    let interrupted = false;
    if (cut !== "ack-before-rename") f.orchestrator.git.editPr = async (...args) => {
      if (!interrupted) {
        interrupted = true;
        if (cut === "after-edit") await edit(...args);
        throw new Error("Full publication interrupted");
      }
      return edit(...args);
    };
    else {
      const update = f.store.update.bind(f.store);
      f.store.update = (mutator) => update((state) => {
        const wasPublication = state.agentRuns[0].fullEvaluation?.step === "publication";
        mutator(state);
        if (!interrupted && wasPublication && !state.agentRuns[0].fullEvaluation) { interrupted = true; throw new Error("Full publication interrupted before acknowledgement"); }
      });
    }
    await assert.rejects(f.orchestrator.fullyValidateLeafForMerge("agent", "base"), /Full publication interrupted/);
    assert.equal(interrupted, true);
    assert.equal(f.run().fullEvaluation.step, "publication");
    const verdict = latestFullAssessment(f.run());
    assert.equal(verdict.qualified, true);
    const samples = f.samples.length;
    const edits = f.calls.filter((call) => call === "edit").length;
    await restart(f);
    assert.equal((await f.orchestrator.retryAgent("agent")).status, "completed", "public retry can acknowledge an already-authorized edit without scoring");
    assert.equal(f.run().fullEvaluation, undefined);
    assert.deepEqual(latestFullAssessment(f.run()), verdict);
    assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", "base"), true);
    assert.equal(f.samples.length, samples);
    assert.equal(f.calls.filter((call) => call === "edit").length, edits + (cut === "before-edit" ? 1 : 0));
    assert.equal(f.store.get().orchestrator.enabled, false);
  });
});

test("public full-publication recovery separates retained evidence from current policy", async (t) => {
  for (const operation of ["retry", "full", "merge"]) for (const drift of ["candidate", "baseline", "definition"]) {
    await t.test(`${operation}/${drift}`, async (t) => {
      const f = await receiptFixture(t, { signals: 1 });
      assert.equal((await f.orchestrator.retryAgent("agent")).status, "completed");
      f.world.score = 71;
      const edit = f.orchestrator.git.editPr;
      f.orchestrator.git.editPr = async () => { throw new Error("Pause before full publication"); };
      await assert.rejects(f.orchestrator.fullyValidateLeafForMerge("agent", "base"), /Pause before full publication/);
      f.orchestrator.git.editPr = edit;
      const receipt = latestFullAssessment(f.run()).evaluation;
      await f.store.update((state) => {
        if (drift === "definition") state.evaluations[0].definitionVersion = "foreign-v2";
        else {
          const id = drift === "candidate" ? receipt.result.selections[0].candidate : receipt.result.selections[0].baseline;
          state.evaluationRuns.find((row) => row.id === id).score += 1;
        }
      });
      const before = structuredClone(f.run());
      const samples = f.samples.length;
      const edits = f.calls.filter((call) => call === "edit").length;
      const body = f.world.remoteBody;
      const rows = structuredClone(f.store.get().evaluationRuns);
      const protectedCalls = () => f.calls.filter((call) => typeof call === "object" ||
        ["evidence", "review", "evaluate", "commit", "push", "ready", "reopen", "close"].includes(call));
      const scientificAndMergeCalls = structuredClone(protectedCalls());
      await restart(f);
      const resume = operation === "retry" ? () => f.orchestrator.retryAgent("agent")
        : operation === "full" ? () => f.orchestrator.fullyValidateLeafForMerge("agent", "base")
          : () => f.orchestrator.mergeAgent("agent");
      if (drift === "definition") {
        if (operation === "retry") assert.equal((await resume()).status, "completed", "retry may acknowledge the already authorized factual publication");
        else await assert.rejects(resume(), /Changed policy cannot authorize new samples|exact independently approved evaluation input/);
        const expected = structuredClone(before);
        expected.leafPr.known.fields = structuredClone(expected.leafPr.pending.target);
        delete expected.leafPr.pending;
        delete expected.fullEvaluation;
        assert.deepEqual(f.run(), expected, "only publication acknowledgments change; original verdict, sources, budget and approval remain historical");
        assert.equal(f.world.remoteBody, before.leafPr.pending.target.body);
        assert.equal(f.calls.filter((call) => call === "edit").length, edits + 1);
        assert.equal(fullAssessmentForIdentity(f.run(), { baseCommit: "base", candidateCommit: f.world.head,
          evaluationFingerprint: fullMergeValidationFingerprint(f.store.get()) }), undefined, "publication does not create current qualification");
      } else {
        await assert.rejects(resume(), /evidence|changed|definitions|source/i);
        assert.equal(f.calls.filter((call) => call === "edit").length, edits);
        assert.equal(f.world.remoteBody, body);
        assert.deepEqual(f.run(), before, "corrupt evidence refusal retains the exact pending PR/full owners and historical verdict");
      }
      assert.equal(f.samples.length, samples);
      assert.deepEqual(f.store.get().evaluationRuns, rows);
      assert.deepEqual(protectedCalls(), scientificAndMergeCalls, "no new author, review, samples, push, readiness, close or merge authority");
      assert.equal(f.world.remoteState, "OPEN");
      assert.equal(f.orchestrator.agentClaims.size, 0);
    });
  }
});

// Retained old-writer topology: four unchanged prompts have two raw rows;
// four changed prompts have six. These identifiers/timings are fixture facts,
// not an implementation allowlist. Rubric text and all external effects are fake.
const oldFullSignals = [
  ["7af648fb", 5, 91, 91, "5d7537be", "4fe7f816", "00:03:48.400", 109244],
  ["8417a4a8", 4, 23.9, 24, "c03caae6", "875783e1", "00:03:48.400", 85639, ["179ec2be", "00:07:55.164", 111237], ["bccd452c", "00:07:55.497", 189617]],
  ["63a24994", 4, 60, 60, "04082b2f", "db30aa83", "00:03:48.400", 68124],
  ["39340456", 2, 32, 33, "3cf6c02c", "76f1d74f", "00:04:56.856", 93308, ["65a67f4f", "00:07:55.164", 86315], ["0dda9b08", "00:07:55.497", 159811]],
  ["b4945d15", 3, 80, 80, "41276b49", "42066e75", "00:05:14.393", 76079],
  ["c8a1bfb9", 1, 71, 72, "6b7a05a5", "7750fb56", "00:05:37.988", 90502, ["6dffed78", "00:07:55.164", 88746], ["182341e6", "00:07:55.497", 246990]],
  ["a61c0e71", 4, 16.5, 18, "613de58d", "8cc0641b", "23:48:29.706", 307372],
  ["6f98c42d", 4, 28, 21.2, "65bd8402", "bbb3feca", "23:53:37.417", 147315],
  ["d4c0b71e", 2, 83, 81, "a92e729c", "bbcbf75f", "00:06:30.506", 76406, ["c98004b9", "00:09:21.805", 136593], ["b72b128a", "00:10:35.661", 103641]],
  ["b7f2a91c", 4, 5.5, 5.5, "3197f66d", "4ee7a1fd", "00:06:30.837", 82626],
];

async function oldFullFixture(t) {
  const f = await fixture(t);
  const time = (value) => `2026-09-${value.startsWith("23:") ? "14" : "15"}T${value}Z`;
  const completedAt = time("00:12:20.393");
  const row = (evaluationId, key, score, at, durationMs, context) => ({ id: `evalrun_${key}`, evaluationId, score,
    summary: `Original ${key} prose`, evidence: [`Raw ${key}`], commit: "rejected", agentRunId: "agent", context,
    status: "completed", attempts: 1, durationMs, createdAt: time(at), evaluationDefinitionVersion: "v1" });
  await f.store.update((state) => {
    state.settings.compositeAbsorbThreshold = 0;
    state.evaluations = oldFullSignals.map(([key, weight], index) => ({ id: `eval_${key}`, name: `Fixture signal ${key}`, prompt: "Frozen legacy fixture rubric",
      ...(index === 6 || index === 7 ? { command: "fixture-only" } : {}), definitionVersion: "v1", weight, enabled: true, createdAt: timestamp }));
    state.evaluationRuns = [];
    for (const [index, signal] of oldFullSignals.entries()) {
      const [key, , before, after, baselineId, seedId, seedTime, duration, ...confirmations] = signal;
      const evaluationId = `eval_${key}`;
      const command = index === 6 || index === 7;
      state.evaluationRuns.push({ id: `evalrun_${baselineId}`, evaluationId, score: before, commit: "base", context: "baseline", status: "completed",
        durationMs: 1, attempts: 1, createdAt: timestamp, evaluationDefinitionVersion: "v1", ...(!command ? { promptSampleCount: 3 } : {}) });
      if (!command) {
        state.evaluationRuns.push(row(evaluationId, `ordinary-${key}`, after, "23:48:30.053", 100, "agent"));
        if (confirmations.length) for (const number of [1, 2]) state.evaluationRuns.push(row(evaluationId, `ordinary-confirm-${key}-${number}`, after,
          number === 1 ? "23:56:06.527" : "23:56:06.849", 100, "composite"));
      }
      state.evaluationRuns.push(row(evaluationId, seedId, after, seedTime, duration, command ? "agent" : "composite"));
      for (const [key, at, duration] of confirmations) state.evaluationRuns.push(row(evaluationId, key, after, at, duration, "composite"));
    }
    const run = state.agentRuns[0];
    run.deltas = oldFullSignals.map(([key, , before, after]) => ({ evaluationId: `eval_${key}`, name: `Fixture signal ${key}`, before, after, delta: Math.round((after - before) * 10) / 10 }));
    run.impact = -0.7;
    run.fullMergeValidation = { baseCommit: "base", candidateCommit: "rejected", evaluationFingerprint: fullMergeValidationFingerprint(state), qualified: false, completedAt };
    for (const review of run.reviewRounds) Object.assign(review, { completedAt: time("23:40:00.000"), evaluationFingerprint: fullMergeValidationFingerprint(state) });
    const activity = (key, at, message, type = "evaluation", detail) => ({ id: `activity_${key}`, createdAt: time(at), message, type, ...(detail ? { detail } : {}) });
    const start = "Measuring the candidate branch.";
    const end = "Candidate branch scoring finished.";
    state.activity = [
      activity("ordinary", "23:56:05.722", "Confirming 4 prompt changes for leaf candidate"),
      activity("6ec08a36", "00:03:47.659", "Reusing 2 exact-head command evaluations for PR #42"),
      activity("50f7a794", "00:03:48.109", "Running 8 evaluations", "evaluation", start),
      activity("1a625854", "00:07:53.892", "8/8 evaluations completed", "evaluation", end),
      activity("fd6a8c6b", "00:07:54.389", "Confirming 4 prompt changes for PR #42"),
      activity("0fdc2f15", "00:07:54.875", "Running 4 evaluations", "evaluation", start),
      activity("63277371", "00:07:55.225", "Running 4 evaluations", "evaluation", start),
      activity("17f9e8c7", "00:11:38.793", "4/4 evaluations completed", "evaluation", end),
      activity("d14e322c", "00:12:19.691", "4/4 evaluations completed", "evaluation", end),
      activity("418547e6", "00:12:22.338", "Leaf rejected by full merge validation: Repair performance", "agent"),
    ].reverse();
  });
  f.orchestrator.codex.revise = async () => { throw new Error("Fixture stops after persisted repair admission"); };
  f.expectedSources = oldFullSignals.flatMap(([, , , , baseline, seed, , , ...confirmations]) => [baseline, seed, ...confirmations.map(([key]) => key)]).map((key) => `evalrun_${key}`).sort();
  return f;
}

test("public legacy admission imports the actual two/six-row topology without sampling or rewriting raw evidence", async (t) => {
  const f = await oldFullFixture(t);
  const raw = f.store.get().evaluationRuns;
  const original = latestFullAssessment(f.run());
  const result = await f.orchestrator.retryAgent("agent", { repairNotes: "Apply a real code repair later" });
  assert.equal(result.status, "failed");
  assert.match(result.error, /stops after persisted repair admission/);
  assert.equal(result.continuation.step, "author");
  assert.equal(result.continuation.reason.kind, "evaluation");
  assert.equal(latestFullAssessment(result).qualified, false);
  assert.equal(latestFullAssessment(result).completedAt, original.completedAt);
  assert.equal(latestFullAssessment(result).impact, -0.7);
  assert.deepEqual(latestFullAssessment(result).legacyProvenance.sources.map((source) => source.runId).sort(), f.expectedSources);
  assert.equal(f.expectedSources.length, 28);
  for (const [index, signal] of oldFullSignals.entries()) {
    if (index === 6 || index === 7) continue;
    assert.equal(raw.filter((row) => row.agentRunId === "agent" && row.evaluationId === `eval_${signal[0]}`).length, signal.length > 8 ? 6 : 2);
  }
  const tied = latestFullAssessment(result).legacyProvenance.reductions.filter((entry) => entry.count === 3);
  assert.equal(tied.length, 4);
  assert.equal(tied.every((entry) => entry.representativeOrder === "unknown-tie"), true);
  assert.deepEqual(f.store.get().evaluationRuns, raw);
  assert.equal(f.world.measurements, 0);
  assert.equal(result.reviewRounds.length, 9);
  await restart(f);
  assert.deepEqual(latestFullAssessment(f.run()), latestFullAssessment(result));
});

test("public legacy admission refuses competing/missing/gap provenance and excludes strictly later rows", async (t) => {
  for (const scenario of ["competing-seed", "missing-confirmation", "competing-baseline", "missing-anchor", "seed-gap", "marker-gap", "completion-gap", "later-only"]) {
    await t.test(scenario, async (t) => {
      const f = await oldFullFixture(t);
      await f.store.update((state) => {
        const duplicate = (id) => ({ ...state.evaluationRuns.find((row) => row.id === `evalrun_${id}`), id: `extra-${scenario}` });
        if (scenario === "competing-seed") state.evaluationRuns.push(duplicate("4fe7f816"));
        if (scenario === "missing-confirmation") state.evaluationRuns = state.evaluationRuns.filter((row) => row.id !== "evalrun_179ec2be");
        if (scenario === "competing-baseline") state.evaluationRuns.push(duplicate("5d7537be"));
        if (scenario === "missing-anchor") state.activity = state.activity.filter((entry) => entry.id !== "activity_6ec08a36");
        const times = { "seed-gap": "00:07:54.140", "marker-gap": "00:07:54.632", "completion-gap": "00:12:20.000", "later-only": "00:13:00.000" };
        if (times[scenario]) state.evaluationRuns.push({ ...duplicate("875783e1"), durationMs: 1, createdAt: `2026-09-15T${times[scenario]}Z` });
      });
      const before = f.run();
      const rows = f.store.get().evaluationRuns;
      if (scenario === "later-only") {
        await f.orchestrator.retryAgent("agent");
        assert.deepEqual(latestFullAssessment(f.run()).legacyProvenance.sources.map((source) => source.runId).sort(), f.expectedSources);
      } else {
        await assert.rejects(f.orchestrator.retryAgent("agent"), /historical measurement provenance/);
        assert.deepEqual(f.run(), before);
      }
      assert.deepEqual(f.store.get().evaluationRuns, rows);
      assert.equal(f.world.measurements, 0);
    });
  }
});

test("proven required-check repair does not demand unrelated old full-score hydration", async (t) => {
  const f = await fixture(t);
  await f.store.update((state) => {
    const run = state.agentRuns[0];
    delete run.fullMergeValidation.deltas; delete run.fullMergeValidation.impact; delete run.fullMergeValidation.candidateTree;
    Object.assign(run, { status: "failed", error: "Required test failed", quarantineReason: "Merge gate rejected PR #42: Required test failed", quarantinedAt: timestamp });
    state.evaluationRuns = state.evaluationRuns.filter((row) => row.context === "baseline");
  });
  const full = latestFullAssessment(f.run());
  const read = f.orchestrator.git.getPullRequest;
  f.orchestrator.git.getPullRequest = async (...args) => ({ ...await read(...args), statusCheckRollup: [{ name: "Required test", status: "COMPLETED", conclusion: "FAILURE" }] });
  assert.equal((await f.orchestrator.retryAgent("agent")).status, "completed");
  assert.deepEqual(latestFullAssessment(f.run()), full);
  assert.equal(f.calls.find((call) => call.revise).revise.kind, "review");
});

test("later exact check-repair delivery can explain changed legacy presentation without replacing the old cohort", async (t) => {
  for (const scenario of ["verified-delivery", "missing-receipt", "mismatched-presentation", "changed-source"]) await t.test(scenario, async (t) => {
    const f = await oldFullFixture(t);
    const original = latestFullAssessment(f.run());
    const originalRows = f.store.get().evaluationRuns;
    await f.store.update((state) => {
      Object.assign(state.agentRuns[0], { status: "failed", error: "Required test failed",
        quarantineReason: "Merge gate rejected PR #42: Required test failed", quarantinedAt: timestamp });
    });
    let failingChecks = true;
    const get = f.orchestrator.git.getPullRequest;
    f.orchestrator.git.getPullRequest = async (...args) => ({ ...await get(...args),
      statusCheckRollup: failingChecks ? [{ name: "Required test", status: "COMPLETED", conclusion: "FAILURE" }] : [] });
    f.orchestrator.codex.revise = async (_cwd, thread, _feedback, _settings, kind) => {
      assert.equal(kind, "review"); f.world.dirty = true; f.world.tree = "checked-replacement-tree";
      return { threadId: thread, message: "Required checks repaired" };
    };
    f.orchestrator.codex.evaluate = async (_cwd, _evaluation, _settings, _context, baseline) => {
      f.world.measurements += 1;
      return { score: baseline.score, summary: "New checked candidate matches its frozen baseline", evidence: [], suggestions: [] };
    };
    assert.equal((await f.orchestrator.retryAgent("agent")).status, "completed");
    failingChecks = false;
    assert.deepEqual(f.run().fullMergeValidation, original, "check repair did not demand unrelated legacy hydration");
    assert.equal(f.run().fullEvaluationHistory, undefined);
    assert.equal(f.run().reviewRounds.length, 10);
    assert.equal(f.run().impact, 0);
    const receipt = receiptOf(f, "delivery");
    if (scenario !== "verified-delivery") await f.store.update((state) => {
      const run = state.agentRuns[0];
      if (scenario === "missing-receipt") delete run.continuation.evaluation;
      if (scenario === "mismatched-presentation") run.deltas[0].summary = "Unproven replacement presentation";
      if (scenario === "changed-source") state.evaluationRuns.find((row) => row.id === receipt.result.selections[0].candidate).score += 1;
    });
    const before = f.run();
    const count = f.world.measurements;
    await restart(f);
    if (scenario === "verified-delivery") {
      assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", "base"), true);
      const adopted = fullAssessmentForIdentity(f.run(), original);
      assert.equal(adopted.qualified, false);
      assert.equal(adopted.completedAt, original.completedAt);
      assert.equal(adopted.impact, -0.7);
      assert.deepEqual(adopted.legacyProvenance.sources.map((source) => source.runId).sort(), f.expectedSources);
      assert.equal(f.run().fullEvaluationHistory.length, 2);
      assert.equal(f.run().fullMergeValidation, undefined);
      assert.equal(f.world.measurements, count + 8, "only the independently owned new full prompt seeds run");
      for (const row of originalRows) assert.deepEqual(f.store.get().evaluationRuns.find((saved) => saved.id === row.id), row);
    } else {
      await assert.rejects(f.orchestrator.fullyValidateLeafForMerge("agent", "base"), /historical measurement provenance|evidence .*changed/);
      assert.deepEqual(f.run(), before);
      assert.equal(f.world.measurements, count);
    }
    assert.equal(f.run().reviewRounds.length, 10);
    assert.equal(f.store.get().orchestrator.enabled, false);
  });
});

test("owned slot updates are accepted but a foreign successor snapshot is never rebound as authority", async (t) => {
  for (const phase of ["after-review-transition", "during-sample"]) await t.test(phase, async (t) => {
    const f = await receiptFixture(t, { signals: 1 });
    let changed = false;
    if (phase === "after-review-transition") {
      const update = f.store.update.bind(f.store);
      f.store.update = async (mutator) => {
        const result = await update(mutator);
        if (!changed && result.agentRuns[0].continuation?.step === "delivery" && !result.agentRuns[0].continuation.evaluation) {
          changed = true;
          await update((state) => { state.agentRuns[0].lastMessage = "Foreign changed handoff"; });
        }
        return result;
      };
    } else {
      const evaluate = f.orchestrator.codex.evaluate;
      f.orchestrator.codex.evaluate = async (...args) => {
        const result = await evaluate(...args);
        if (!changed) { changed = true; await f.store.update((state) => { state.agentRuns[0].authorThreadId = "foreign-author"; }); }
        return result;
      };
    }
    const result = await f.orchestrator.retryAgent("agent");
    assert.equal(changed, true);
    assert.equal(result.status, "failed");
    assert.match(result.error, /identity changed|changed its author\/review\/base\/PR/);
    assert.equal(f.calls.includes("push"), false);
    assert.equal(latestFullAssessment(f.run()).qualified, false);
    assert.equal(f.samples.length, phase === "during-sample" ? 1 : 0);
  });
});

test("a notification failure waits for every sample sibling before releasing its claim", async (t) => {
  const f = await receiptFixture(t);
  const blocked = deferred();
  const proceed = deferred();
  const evaluate = f.orchestrator.codex.evaluate;
  f.orchestrator.codex.evaluate = async (...args) => {
    if (args[1].id === "signal-1") { blocked.resolve(); await proceed.promise; }
    return evaluate(...args);
  };
  let failed = false;
  const emit = f.orchestrator.events.emit.bind(f.orchestrator.events);
  f.orchestrator.events.emit = (type, value) => {
    if (!failed && type === "evaluation" && value.status === "completed") { failed = true; throw new Error("Injected notification failure"); }
    return emit(type, value);
  };
  const operation = f.orchestrator.retryAgent("agent");
  await blocked.promise;
  assert.equal(f.orchestrator.agentClaims.has("agent"), true);
  assert.equal(f.calls.includes("release"), false);
  proceed.resolve();
  assert.equal((await operation).status, "failed");
  assert.equal(f.orchestrator.agentClaims.size, 0);
  assert.equal(receiptOf(f, "delivery").evaluations.every((entry) => entry.candidate[0].success), true);
  const count = f.samples.length;
  await restart(f);
  assert.equal((await f.orchestrator.retryAgent("agent")).status, "completed");
  assert.equal(f.samples.length, count);
});

test("full prompt cohorts are independent, and consumers prefer their exact completed receipt", async (t) => {
  const f = await receiptFixture(t, { signals: 1, score: 69 });
  assert.equal((await f.orchestrator.retryAgent("agent")).status, "completed");
  const delivery = receiptOf(f, "delivery");
  assert.equal(delivery.result.selections[0].count, 3);
  assert.equal(f.samples.length, 3);
  f.world.score = 68;
  assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", "base"), false);
  const full = latestFullAssessment(f.run()).evaluation;
  assert.equal(f.samples.length, 6);
  assert.notEqual(full.id, delivery.id);
  assert.equal(full.result.sources.filter((source) => delivery.result.selections[0].candidateSources.includes(source.runId)).length, 0);
  await f.store.update((state) => {
    const representative = state.evaluationRuns.find((row) => row.id === delivery.result.selections[0].candidate);
    state.evaluationRuns.push({ ...representative, id: "later-unowned-same-head", leafSample: undefined, score: 100, createdAt: new Date(Date.now() + 10_000).toISOString() });
    state.agentRuns[0].deltas = [{ ...state.agentRuns[0].deltas[0], after: 100, delta: 30 }];
  });
  const source = { agentRunId: "agent", prNumber: 42, branch: f.run().branch, title: "Receipt source", kind: "pull_request" };
  const feedback = compositeSourceRegressions(f.store.get(), [source], "base");
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].after, 68);
  assert.match(feedback[0].summary, /composite/);
  await f.store.update((state) => { state.evaluationRuns.find((row) => row.id === full.result.selections[0].candidate).score = 99; });
  assert.deepEqual(compositeSourceRegressions(f.store.get(), [source], "base"), []);
  await assert.rejects(f.orchestrator.fullyValidateLeafForMerge("agent", "base"), /evidence .* changed/);
  assert.equal(f.samples.length, 6, "changed evidence is refused, not remeasured");
});

test("public living-line delivery freezes projected source and inherited baseline count through restart and trimming", async (t) => {
  const f = await receiptFixture(t, { signals: 1, score: 69 });
  await f.store.update((state) => {
    const run = state.agentRuns[0];
    delete run.fullMergeValidation;
    Object.assign(run, { status: "failed", parentCompositeId: "living", baseRef: "burner/living", prNumber: undefined, prUrl: undefined, prState: undefined });
    delete run.leafPr;
    state.composites = [{ id: "living", title: "Living fixture", branch: "burner/living", status: "open", isLiving: true,
      sources: [], reviewRounds: [], deltas: [], createdAt: timestamp, updatedAt: timestamp }];
    state.evaluationRuns.push({ id: "raw-living-floor", evaluationId: "signal-0", score: 70, summary: "Inherited confirmed floor",
      commit: "previous-living-head", context: "composite", compositeId: "living", status: "completed", durationMs: 1,
      createdAt: timestamp, evaluationDefinitionVersion: "v1", sourceRunIds: ["living-source-child"] },
    { id: "living-source-child", evaluationId: "signal-0", score: 70, commit: "previous-living-head", context: "composite",
      compositeId: "living", status: "completed", durationMs: 1, createdAt: timestamp, evaluationDefinitionVersion: "v1" });
  });
  // Avoid a competing equal-score source: only the retained floor source is a
  // living-composite result; its transitive child has independent provenance.
  await f.store.update((state) => { state.evaluationRuns.find((row) => row.id === "living-source-child").compositeId = "earlier-living"; });
  f.orchestrator.git.resolveRef = async (ref) => ["main", "burner/living"].includes(ref) ? "base" : f.world.head;
  const evaluate = f.orchestrator.codex.evaluate;
  let attempts = 0;
  f.orchestrator.codex.evaluate = async (...args) => {
    if (++attempts > 1) throw new Error("Projected delivery confirmation interrupted");
    return evaluate(...args);
  };
  assert.equal((await f.orchestrator.retryAgent("agent")).status, "failed");
  const pending = receiptOf(f, "delivery");
  const baseline = pending.evaluations[0].baseline;
  assert.equal(baseline.source.runId, "raw-living-floor");
  assert.equal(baseline.projection.sourceCommit, "previous-living-head");
  assert.equal(baseline.comparisonCommit, "base");
  assert.equal(baseline.count, 3);
  assert.deepEqual(baseline.projection.inputs.map((input) => input.runId).sort(), ["base-signal-0", "raw-living-floor"]);
  const completedSeed = pending.evaluations[0].candidate[0].success.runId;
  await f.store.update((state) => {
    state.evaluationRuns.push({ ...state.evaluationRuns.find((row) => row.id === "base-signal-0"), id: "new-main-floor", score: 100, createdAt: new Date().toISOString() });
  });
  f.orchestrator.codex.evaluate = evaluate;
  await restart(f);
  const resumed = await f.orchestrator.retryAgent("agent");
  assert.equal(resumed.status, "rejected", resumed.error);
  const receipt = receiptOf(f, "delivery");
  assert.equal(receipt.result.selections[0].candidateSources[0], completedSeed);
  assert.equal(receipt.result.selections[0].baselineCount, 3);
  assert.equal(receipt.result.deltas[0].before, 70);
  assert.equal(receipt.result.deltas[0].after, 69);
  assert.equal(f.samples.length, 3, "only missing confirmations run; the projected baseline is not resampled in main");
  assert.equal(f.samples.every((sample) => sample.baseline.score === 70 && sample.baseline.commit === "base" && sample.baseline.promptSampleCount === 3), true);
  const source = { agentRunId: "agent", branch: f.run().branch, title: "Projected source", kind: "experiment" };
  assert.deepEqual(compositeSourceRegressions(f.store.get(), [source], "base"), [], "a rejected experiment is not promoted as a completed source");
  await f.store.update((state) => {
    state.composites = [];
    state.evaluationRuns.push(...Array.from({ length: 1100 }, (_, index) => ({
      id: `projection-roll-${index}`, evaluationId: "signal-0", commit: "other", context: "agent", agentRunId: "other",
      score: 100, status: "completed", durationMs: 1, createdAt: new Date().toISOString(), evaluationDefinitionVersion: "v1",
    })));
  });
  await restart(f);
  for (const id of ["raw-living-floor", "living-source-child", "base-signal-0", ...receipt.result.sources.map((source) => source.runId)]) {
    assert.ok(f.store.get().evaluationRuns.some((row) => row.id === id), id);
  }
  assert.equal(f.store.get().evaluationRuns.find((row) => row.id === "raw-living-floor").promptSampleCount, undefined);
  assert.deepEqual(compositeSourceRegressions(f.store.get(), [source], "base"), []);
});

test("screened commands never seed full receipts and saved modes survive delivery restart", async (t) => {
  const f = await receiptFixture(t, { signals: 1, command: true });
  f.orchestrator.yolo = true; f.orchestrator.yoloBatchSize = 2;
  await f.store.update((state) => {
    state.agentRuns[0].leafQualificationPolicy = "separate-full";
    state.evaluations[0].screeningCommand = "fixture-screen";
    state.evaluationRuns.push({ ...state.evaluationRuns[0], id: "screening-base", score: 50, context: "screening_baseline" });
  });
  const push = f.orchestrator.git.push;
  f.orchestrator.git.push = async () => { throw new Error("Publication interrupted after screen"); };
  assert.equal((await f.orchestrator.retryAgent("agent")).status, "failed");
  assert.equal(receiptOf(f, "delivery").evaluations[0].mode, "screening-command");
  assert.equal(receiptOf(f, "delivery").result.deltas[0].before, 50);
  const screenedId = receiptOf(f, "delivery").result.selections[0].candidate;
  f.orchestrator.git.push = push;
  await restart(f); // Default mode is now non-portfolio; it cannot relabel the receipt.
  assert.equal((await f.orchestrator.retryAgent("agent")).status, "completed");
  assert.equal(f.samples.length, 1);
  assert.equal(receiptOf(f, "delivery").result.deltas[0].screening, true);
  assert.deepEqual(reusableFullAgentCommandRuns(f.store.get(), "agent", f.world.head), []);
  assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", "base"), true);
  assert.equal(f.samples.length, 2);
  assert.equal(f.samples.at(-1).screening, false);
  const full = latestFullAssessment(f.run()).evaluation;
  assert.equal(full.evaluations[0].mode, "full-command");
  assert.equal(full.evaluations[0].candidate[0].reuse, undefined);
  assert.equal(full.result.selections[0].candidate === screenedId, false);
  assert.equal(f.store.get().evaluationRuns.find((row) => row.id === screenedId).context, "agent");
});

test("merged baseline promotion uses receipt counts/sources and retains their closure after history trimming", async (t) => {
  for (const score of [70, 71]) await t.test(String(score), async (t) => {
    const f = await receiptFixture(t, { signals: 1, score });
    assert.equal((await f.orchestrator.retryAgent("agent")).status, "completed");
    assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", "base"), true);
    const receipt = latestFullAssessment(f.run()).evaluation;
    const selected = receipt.result.selections[0];
    await f.store.update((state) => {
      state.agentRuns[0].prState = "merged";
      state.evaluationRuns.push({ ...state.evaluationRuns.find((row) => row.id === selected.candidate), id: "unrelated-newer-sample", leafSample: undefined, score: 99, createdAt: new Date(Date.now() + 1000).toISOString() });
      state.agentRuns[0].deltas[0].after = 99;
    });
    assert.equal(await f.orchestrator.promoteMergedAgentBaseline("agent", f.world.head), true);
    const baseline = f.store.latestRuns().get("signal-0");
    assert.equal(baseline.score, score);
    assert.equal(baseline.promptSampleCount, 3, "unchanged confirmed-count inheritance is preserved without relabeling raw rows");
    assert.equal(baseline.leafSample, undefined);
    for (const id of selected.candidateSources) assert.equal(baseline.sourceRunIds.includes(id), true);
    await f.store.update((state) => {
      state.agentRuns = [];
      state.evaluationRuns.push(...Array.from({ length: 1_100 }, (_, index) => ({ ...baseline, id: `unrelated-roll-${index}`, context: "agent", agentRunId: "other", sourceRunIds: undefined, commit: "other" })));
    });
    await restart(f);
    const rows = f.store.get().evaluationRuns;
    assert.ok(rows.find((row) => row.id === baseline.id));
    for (const id of baseline.sourceRunIds) assert.ok(rows.find((row) => row.id === id), id);
    for (const id of selected.candidateSources) assert.equal(rows.find((row) => row.id === id).promptSampleCount, undefined);
  });
});

test("public manual merge preserves mode policy but cannot bypass retained negative or missing receipt evidence", async (t) => {
  for (const scenario of ["ordinary-delivery", "portfolio-needs-full", "retained-negative", "changed-source", "missing-approval"]) await t.test(scenario, async (t) => {
    const f = await receiptFixture(t, { signals: 1, command: true });
    if (scenario !== "retained-negative") await f.store.update((state) => {
      delete state.agentRuns[0].fullMergeValidation; state.agentRuns[0].status = "failed";
      state.agentRuns[0].leafQualificationPolicy = scenario === "portfolio-needs-full" ? "separate-full" : "ordinary";
    });
    if (scenario === "portfolio-needs-full") { f.orchestrator.yolo = true; f.orchestrator.yoloBatchSize = 2; }
    assert.equal((await f.orchestrator.retryAgent("agent")).status, "completed");
    const receipt = receiptOf(f, "delivery");
    let merges = 0;
    let stamps = 0;
    f.orchestrator.stampLeafProgress = async () => { stamps += 1; return f.run(); };
    f.orchestrator.git.mergeLeafPr = async (_cwd, _repository, number, head) => {
      assert.equal(number, 42); assert.equal(head, f.world.head); merges += 1;
      throw new TransientMergeGateError("Fixture reached the authorized merge boundary");
    };
    f.orchestrator.syncPullRequests = async () => undefined;
    if (scenario === "changed-source") await f.store.update((state) => { state.evaluationRuns.find((row) => row.id === receipt.result.selections[0].candidate).summary = "foreign evidence"; });
    if (scenario === "missing-approval") await f.store.update((state) => { delete state.agentRuns[0].reviewRounds.at(-1).completedAt; });
    const samples = f.samples.length;
    if (scenario === "ordinary-delivery") await assert.rejects(f.orchestrator.mergeAgent("agent"), /authorized merge boundary/);
    else {
      await assert.rejects(f.orchestrator.mergeAgent("agent"), /retained negative|receipt evidence|evidence .* changed|independently approved/);
      assert.equal(stamps, 0);
      if (scenario === "portfolio-needs-full" || scenario === "retained-negative") {
        assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", "base"), true);
        await assert.rejects(f.orchestrator.mergeAgent("agent"), /authorized merge boundary/);
      }
    }
    assert.equal(f.samples.length, samples, "merge itself never samples; the explicit full gate may reuse this exact full command");
    assert.equal(merges, ["ordinary-delivery", "portfolio-needs-full", "retained-negative"].includes(scenario) ? 1 : 0);
  });
});
