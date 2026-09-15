import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventHub } from "../dist/lib/events.js";
import { fullMergeValidationFingerprint, latestFullAssessment, Orchestrator } from "../dist/lib/orchestrator.js";
import { StateStore } from "../dist/lib/store.js";
import { fixtureLeafPr, installLeafPrFixtureTransport } from "./leaf-pr-test-helpers.js";
import { withFixture, deliver, evidenceSnapshot, assertEvidenceUnchanged } from "./leaf-policy-effects-test-helpers.js";

const time = "2026-09-01T00:00:00.000Z";
const clone = (value) => structuredClone(value);

// Policy-boundary tests use the real store, public operations, receipt executor,
// reducer and PR owner. Git/GitHub are explicit transport fixtures; graph and
// worktree behavior have their own real-Git public suites. Every subprocess is
// denied here, including any accidental model/evaluation command fallthrough.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "burner-recorded-policy-"));
  const calls = { samples: [], effects: [], observations: 0, proofs: 0, fetched: 0, blocked: [] };
  const spawn = childProcess.spawn;
  childProcess.spawn = (...args) => { calls.blocked.push(args[0]); assert.fail(`Unexpected subprocess: ${args[0]}`); };
  syncBuiltinESMExports();
  t.after(async () => {
    childProcess.spawn = spawn;
    syncBuiltinESMExports();
    await writeFile(join(root, "calls.json"), JSON.stringify(calls, null, 2));
    if (t.passed) await rm(root, { recursive: true, force: true });
    else t.diagnostic(`Retained policy fixture: ${root}`);
  });
  let store = new StateStore(root);
  await store.init();
  await store.update((state) => {
    Object.assign(state.settings, { maxReviewRounds: 12, portfolioReviewRounds: 12, defaultResources: [], autoCreatePrs: true });
    state.orchestrator.enabled = false;
    // Registry order is deliberately different from score-fingerprint order.
    state.evaluations = ["zeta", "alpha"].map((id, index) => ({ id, name: id, prompt: `${id} original prompt`,
      command: `${id} fixture-only command`, definitionVersion: "v1", weight: index + 1, enabled: true, createdAt: time }));
    state.evaluationRuns = state.evaluations.map((evaluation, index) => ({ id: `baseline-${evaluation.id}`, evaluationId: evaluation.id,
      score: 70 + index, commit: "base", context: "baseline", status: "completed", durationMs: 1, createdAt: time, evaluationDefinitionVersion: "v1" }));
    state.ideas = [{ id: "idea", agentRunId: "agent", title: "Recorded policy fixture", description: "Preserve facts", rationale: "Policy is not history",
      predictedImpact: 2, evaluationIds: ["zeta", "alpha"], resources: [], status: "completed", source: "manual", createdAt: time, updatedAt: time }];
    const run = { id: "agent", ideaId: "idea", branch: "burner/policy", worktree: root, status: "completed", startedAt: time, completedAt: time,
      baseRef: "main", baseCommit: "base", authorThreadId: "author", authoringComplete: true, lastMessage: "Original author",
      resources: [], prNumber: 42, prUrl: "https://example.test/fixture/burner/pull/42", prState: "open", reviewApproved: true,
      leafQualificationPolicy: "separate-full", reviewRounds: [{ id: "approval", round: 1, commit: "candidate", approved: true,
        summary: "Exact independent approval", findings: [], createdAt: time, completedAt: time, baseCommit: "base", evaluationFingerprint: fullMergeValidationFingerprint(state) }], deltas: [] };
    run.continuation = { id: "done", step: "done", outcome: "completed", completedAt: time, head: "candidate",
      identity: { baseRef: "main", baseCommit: "base", branch: run.branch, evaluationFingerprint: fullMergeValidationFingerprint(state),
        remote: "origin", baseBranch: "main", pullRequest: { number: 42, head: "candidate", url: run.prUrl } } };
    run.leafPr = fixtureLeafPr(run, { title: "Recorded policy fixture", body: "Initial body", isDraft: true, state: "OPEN" });
    state.agentRuns = [run];
  });
  const world = { title: "Recorded policy fixture", body: "Initial body", isDraft: true, state: "OPEN", score: 76, head: "candidate", base: "base" };
  let orchestrator;
  const install = () => {
    orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.git = {
      assertWorktree: async (cwd, branch) => { assert.equal(cwd, root); assert.equal(branch, "burner/policy"); },
      head: async () => world.head,
      tree: async (commit) => `${commit === "burner/policy" ? world.head : commit}-tree`,
      resolveRef: async (ref) => ref === "main" ? world.base : world.head,
      hasChanges: async () => false,
      remoteBranchHead: async (_cwd, _remote, branch) => branch === "main" ? world.base : world.head,
      createExistingWorktree: async () => root,
      removeWorktree: async () => { calls.effects.push("optional-cleanup"); },
    };
    installLeafPrFixtureTransport(orchestrator.git, {
      base: () => world.base,
      observe: async () => {
        calls.observations += 1;
        return { number: 42, url: store.get().agentRuns[0].prUrl, headRefName: "burner/policy", headRefOid: world.head,
          title: world.title, body: world.body, isDraft: world.isDraft, state: world.state,
          ...(world.state === "MERGED" ? { mergeCommit: "landing" } : {}),
          mergeable: "MERGEABLE", statusCheckRollup: [{ name: "check", status: "COMPLETED", conclusion: "SUCCESS" }] };
      },
      edit: async (_cwd, _number, field, value) => {
        calls.effects.push(`edit:${field}`);
        if (world.beforeEffect) await world.beforeEffect(`edit:${field}`);
        world[field] = value;
        if (world.afterEffect) await world.afterEffect(`edit:${field}`);
      },
      draft: async (_cwd, _number, value) => {
        calls.effects.push(value ? "draft" : "ready");
        if (world.beforeEffect) await world.beforeEffect(value ? "draft" : "ready");
        world.isDraft = value;
        if (world.afterEffect) await world.afterEffect(value ? "draft" : "ready");
      },
      close: async () => { calls.effects.push("close"); world.state = "CLOSED"; },
      merge: async () => { calls.effects.push("merge"); throw new Error("Fixture stops before merge transport"); },
      prove: async () => { calls.proofs += 1; return { target: world.base }; },
      fetch: async ({ branch, head }) => { assert.equal(branch, "burner/policy"); assert.equal(head, world.head); calls.fetched += 1; },
    });
    orchestrator.codex = new Proxy({
      close: async () => undefined,
      preflight: async () => undefined,
      evaluate: async (_cwd, evaluation, _settings, context, _baseline, evidence) => {
        calls.samples.push({ id: evaluation.id, context });
        if (world.evaluate) return world.evaluate(evaluation, context, evidence);
        const result = { score: world.score, summary: `Recorded ${evaluation.id}`, evidence: [], suggestions: [] };
        if (evaluation.command) {
          evidence.startCommand();
          const stdout = JSON.stringify(result);
          evidence.append("stdout", stdout);
          await evidence.recordCommand({ stdout, stderr: "", exitCode: 0 });
          await evidence.recordNormalized(result);
        }
        return result;
      },
    }, { get: (target, key) => key in target ? target[key] : () => assert.fail(`Unarranged model owner: ${String(key)}`) });
  };
  install();
  return { root, calls, world, get store() { return store; }, get orchestrator() { return orchestrator; }, run: () => store.get().agentRuns[0],
    qualify: () => orchestrator.fullyValidateLeafForMerge("agent", "base"),
    restart: async () => { store = new StateStore(root); await store.init(); install(); },
    stateBytes: () => readFile(store.statePath, "utf8") };
}

test("recorded full evidence still permits exact terminal settlement after a weight edit", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.qualify(), true);
  const history = clone(f.run().fullEvaluationHistory);
  const reviews = clone(f.run().reviewRounds);
  const rows = clone(f.store.get().evaluationRuns);
  await f.store.update((state) => { state.evaluations[0].weight = 4; });
  f.world.state = "MERGED"; f.world.isDraft = false;
  await f.restart();
  const result = await f.orchestrator.mergeAgent("agent");
  assert.equal(result.prState, "merged");
  assert.equal(f.calls.proofs, 1);
  assert.deepEqual(result.fullEvaluationHistory, history);
  assert.deepEqual(result.reviewRounds, reviews);
  assert.deepEqual(f.store.get().evaluationRuns, rows);
  assert.equal(f.calls.samples.length, 2);
  assert.deepEqual(f.calls.blocked, []);
});

test("completed full result finalizes its recorded verdict after policy changes without authorizing a current cache", async (t) => {
  const f = await fixture(t);
  const update = f.store.update.bind(f.store);
  let cut = false;
  f.store.update = (mutate) => update((state) => {
    mutate(state);
    if (!cut && state.agentRuns[0].leafPr.pending?.owner.kind === "full-publication") {
      cut = true;
      throw new Error("Fixture cut after complete reduction before publication admission");
    }
  });
  await assert.rejects(f.qualify(), /Fixture cut/);
  assert.equal(cut, true);
  const receipt = clone(f.run().fullEvaluation.evaluation);
  assert.ok(receipt.result);
  await f.store.update((state) => { state.evaluations[0].weight = 4; });
  await f.restart();
  assert.equal(await f.qualify(), false, "historical completion is not current qualification");
  assert.equal(f.run().fullEvaluation, undefined);
  assert.deepEqual(latestFullAssessment(f.run()).evaluation, receipt);
  assert.equal(latestFullAssessment(f.run()).qualified, true);
  assert.equal(f.calls.samples.length, 2);
  assert.deepEqual(f.calls.blocked, []);
});

test("a changed policy cannot buy a new full assessment of an unchanged completed candidate", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.qualify(), true);
  const history = clone(f.run().fullEvaluationHistory);
  await f.store.update((state) => { state.evaluations[0].weight = 4; });
  const result = await f.qualify().catch(() => false);
  assert.equal(result, false);
  assert.deepEqual(f.run().fullEvaluationHistory, history);
  assert.equal(f.run().fullEvaluation, undefined);
  assert.equal(f.calls.samples.length, 2);
});

const policyEdits = [
  ["weight", (state) => { state.evaluations[0].weight = 4; }],
  ["name", (state) => { state.evaluations[0].name = "New name"; }],
  ["prompt", (state) => { state.evaluations[0].prompt = "New prompt"; }],
  ["command", (state) => { state.evaluations[0].command = "New command"; }],
  ["screening command", (state) => { state.evaluations[0].screeningCommand = "New screen"; }],
  ["definition version", (state) => { state.evaluations[0].definitionVersion = "v2"; }],
  ["disabled member", (state) => { state.evaluations[0].enabled = false; }],
  ["removed member", (state) => { state.evaluations.shift(); }],
  ["new member", (state) => { state.evaluations.push({ ...state.evaluations[0], id: "new" }); }],
  ["threshold", (state) => { state.settings.compositeAbsorbThreshold = 50; }],
  ["registry order", (state) => { state.evaluations.reverse(); }],
];

test("all current policy edits preserve historical terminal facts and deny current qualification", async (t) => {
  for (const [name, edit] of policyEdits) await t.test(name, async (t) => {
    const f = await fixture(t);
    assert.equal(await f.qualify(), true);
    const history = clone(f.run().fullEvaluationHistory);
    const rows = clone(f.store.get().evaluationRuns);
    await f.store.update(edit);
    const effects = f.calls.effects.length;
    await assert.rejects(f.orchestrator.mergeAgent("agent"));
    assert.equal(f.calls.effects.length, effects, "stale evidence cannot authorize readiness or merge");
    assert.equal(await f.qualify().catch(() => false), false);
    assert.deepEqual(f.run().fullEvaluationHistory, history, "policy changes cannot append another same-tree assessment");
    assert.equal(f.calls.samples.length, 2);
    f.world.state = "MERGED"; f.world.isDraft = false;
    await f.restart();
    assert.equal((await f.orchestrator.mergeAgent("agent")).prState, "merged");
    assert.deepEqual(f.run().fullEvaluationHistory, history);
    assert.deepEqual(f.store.get().evaluationRuns, rows);
    assert.equal(f.calls.effects.length, effects, "terminal facts do not send new PR effects");
    assert.deepEqual(f.calls.blocked, []);
  });
});

test("damaged recorded contracts, reductions and wrappers refuse before terminal observation", async (t) => {
  const editFull = (change) => (full) => {
    const value = JSON.parse(full.evaluation.identity.evaluationFingerprint);
    change(value);
    full.evaluation.identity.evaluationFingerprint = JSON.stringify(value);
  };
  const editScore = (change) => (full) => {
    const value = JSON.parse(full.evaluation.scoreDefinitionFingerprint);
    change(value);
    full.evaluation.scoreDefinitionFingerprint = JSON.stringify(value);
  };
  const cases = [
    ["full malformed JSON", (full) => { full.evaluation.identity.evaluationFingerprint = "{"; }],
    ["full array", (full) => { full.evaluation.identity.evaluationFingerprint = "[]"; }],
    ["score malformed JSON", (full) => { full.evaluation.scoreDefinitionFingerprint = "{"; }],
    ["score object", (full) => { full.evaluation.scoreDefinitionFingerprint = "{}"; }],
    ["unsupported protocol", editFull((p) => { p.candidateEvaluationProtocol = "unsupported"; })],
    ["null threshold", editFull((p) => { p.threshold = null; })],
    ["threshold type", editFull((p) => { p.threshold = "0"; })],
    ["threshold range", editFull((p) => { p.threshold = 101; })],
    ["missing threshold", editFull((p) => { delete p.threshold; })],
    ["unknown contract field", editFull((p) => { p.mode = "invented"; })],
    ["duplicate full definition", editFull((p) => { p.evaluations[1] = clone(p.evaluations[0]); })],
    ["duplicate score definition", editScore((p) => { p[1] = clone(p[0]); })],
    ["missing full member", editFull((p) => { p.evaluations.pop(); })],
    ["missing score member", editScore((p) => { p.pop(); })],
    ["unsorted score contract", editScore((p) => { p.reverse(); })],
    ["overlapping name", editScore((p) => { p[0].name = "Conflicting"; })],
    ["overlapping command", editScore((p) => { p[0].command = "Conflicting"; })],
    ["overlapping weight", editScore((p) => { p[0].weight = 4; })],
    ["overlapping version", editScore((p) => { delete p[0].definitionVersion; })],
    ["empty name", editFull((p) => { p.evaluations[0].name = ""; })],
    ["wrong prompt type", editFull((p) => { p.evaluations[0].prompt = 4; })],
    ["zero weight", editFull((p) => { p.evaluations[0].weight = 0; })],
    ["excess weight", editFull((p) => { p.evaluations[0].weight = 11; })],
    ["weight type", editFull((p) => { p.evaluations[0].weight = "1"; })],
    ["null version", editFull((p) => { p.evaluations[0].definitionVersion = null; })],
    ["unknown entry field", editFull((p) => { p.evaluations[0].enabled = true; })],
    ["screening without full command", editScore((p) => { delete p[0].command; p[0].screeningCommand = "screen"; })],
    ["definition membership order", (full) => { full.evaluation.evaluations.reverse(); }],
    ["invalid evaluation mode", (full) => { full.evaluation.evaluations[0].mode = "invented"; }],
    ["wrong definition version", (full) => { full.evaluation.evaluations[0].definitionVersion = "v2"; }],
    ["duplicate selection", (full) => { full.evaluation.result.selections[1] = clone(full.evaluation.result.selections[0]); }],
    ["duplicate delta", (full) => { full.evaluation.result.deltas[1] = clone(full.evaluation.result.deltas[0]); }],
    ["selection count", (full) => { full.evaluation.result.selections[0].count = 3; }],
    ["selection source", (full) => { full.evaluation.result.selections[0].candidate = "unknown"; }],
    ["baseline count", (full) => { full.evaluation.evaluations[0].baseline.count = 3; }],
    ["baseline comparison", (full) => { full.evaluation.evaluations[0].baseline.comparisonCommit = "other"; }],
    ["success digest", (full) => { full.evaluation.evaluations[0].candidate[0].success.digest = "changed"; }],
    ["duplicate attempt", (full) => { full.evaluation.evaluations[0].candidate[0].attempts.push(full.evaluation.evaluations[0].candidate[0].attempts[0]); }],
    ["missing source closure", (full) => { full.evaluation.result.sources.pop(); }],
    ["duplicate source closure", (full) => { full.evaluation.result.sources[1] = clone(full.evaluation.result.sources[0]); }],
    ["delta name", (full) => { full.evaluation.result.deltas[0].name = "Changed"; }],
    ["delta summary", (full) => { full.evaluation.result.deltas[0].summary = "Changed"; }],
    ["delta arithmetic", (full) => { full.evaluation.result.deltas[0].delta = 99; }],
    ["screening flag", (full) => { full.evaluation.result.deltas[0].screening = true; }],
    ["weighted impact", (full) => { full.evaluation.result.impact = 99; }],
    ["result timestamp", (full) => { full.evaluation.result.completedAt = "unknown"; }],
    ["wrapper time", (full) => { full.completedAt = time; }],
    ["wrapper tree", (full) => { full.candidateTree = "other"; }],
    ["wrapper commit", (full) => { full.candidateCommit = "other"; }],
    ["wrapper impact", (full) => { full.impact = 99; }],
    ["wrapper verdict", (full) => { full.qualified = false; }],
    ["wrong row score", (_full, state) => { state.evaluationRuns.find((row) => row.leafSample).score = 99; }],
    ["missing row", (_full, state) => { state.evaluationRuns = state.evaluationRuns.filter((row) => !row.leafSample); }],
  ];
  for (const [name, change] of cases) await t.test(name, async (t) => {
    const f = await fixture(t);
    assert.equal(await f.qualify(), true);
    await f.store.update((state) => { change(state.agentRuns[0].fullEvaluationHistory[0].assessment, state); state.evaluations[0].weight = 4; });
    f.world.state = "MERGED"; f.world.isDraft = false;
    const before = await f.stateBytes(), observations = f.calls.observations, effects = f.calls.effects.length;
    await assert.rejects(f.orchestrator.mergeAgent("agent"));
    assert.equal(await f.stateBytes(), before);
    assert.equal(f.calls.observations, observations, "invalid source evidence must fail before PR observation");
    assert.equal(f.calls.effects.length, effects);
    assert.equal(f.calls.proofs, 0);
    assert.equal(f.calls.samples.length, 2);
  });
});

test("valid omitted definition versions remain recorded facts after the registry changes", async (t) => {
  const f = await fixture(t);
  await f.store.update((state) => {
    for (const evaluation of state.evaluations) delete evaluation.definitionVersion;
    for (const row of state.evaluationRuns) delete row.evaluationDefinitionVersion;
    state.agentRuns[0].reviewRounds[0].evaluationFingerprint = fullMergeValidationFingerprint(state);
    state.agentRuns[0].continuation.identity.evaluationFingerprint = fullMergeValidationFingerprint(state);
  });
  assert.equal(await f.qualify(), true);
  const history = clone(f.run().fullEvaluationHistory);
  const policy = latestFullAssessment(f.run()).evaluation;
  assert.ok(JSON.parse(policy.identity.evaluationFingerprint).evaluations.every((entry) => !Object.hasOwn(entry, "definitionVersion")));
  await f.store.update((state) => { state.evaluations = []; });
  f.world.state = "MERGED"; f.world.isDraft = false;
  assert.equal((await f.orchestrator.mergeAgent("agent")).prState, "merged");
  assert.deepEqual(f.run().fullEvaluationHistory, history);
});

test("an incomplete stale full receipt cannot execute another sample after restart", async (t) => {
  const f = await fixture(t);
  f.world.evaluate = async () => { throw new Error("Fixture interrupted sample"); };
  assert.equal(await f.qualify(), false);
  const receipt = clone(f.run().fullEvaluation.evaluation), count = f.calls.samples.length;
  assert.equal(receipt.result, undefined);
  await f.store.update((state) => { state.evaluations[0].screeningCommand = "new screen"; });
  await f.restart();
  await assert.rejects(f.qualify(), /changed definitions/);
  assert.deepEqual(f.run().fullEvaluation.evaluation, receipt);
  assert.equal(f.calls.samples.length, count);
});

test("current composite source consumer and baseline promoter retain explicit policy authorization", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.qualify(), true);
  const source = { agentRunId: "agent", prNumber: 42, branch: "burner/policy", kind: "pull_request", title: "Owned source" };
  await f.store.update((state) => {
    state.composites = [{ id: "composite", title: "Source consumer", branch: "burner/composite", status: "building", worktree: "",
      sources: [source], deltas: [], reviewRounds: [], createdAt: time, updatedAt: time, pendingExperimentRunIds: [] }];
  });
  // This is the real internal source consumer called by the public composite
  // build path, not an aggregate evaluation or validation stub.
  const consume = async () => {
    const claim = f.orchestrator.claimAgents(["agent"]);
    try { return await f.orchestrator.validateCompositeLeafSource("composite", source, claim); }
    finally { claim.release(); }
  };
  assert.equal((await consume()).head, "candidate", "positive current-policy source control");
  assert.equal(f.calls.fetched, 1);
  await f.store.update((state) => { state.evaluations[0].weight = 4; });
  const before = clone(f.store.get().evaluationRuns);
  await assert.rejects(consume(), /changed definitions/);
  assert.equal(f.calls.fetched, 1, "stale source stopped before immutable fetch/consumption");
  f.world.state = "MERGED"; f.world.isDraft = false;
  await f.orchestrator.mergeAgent("agent");
  assert.equal(await f.orchestrator.promoteMergedAgentBaseline("agent", "candidate"), false);
  assert.deepEqual(f.store.get().evaluationRuns, before);
  assert.equal(f.calls.samples.length, 2);
});

test("a current full receipt remains eligible for the existing exact-tree baseline promotion", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.qualify(), true);
  f.world.state = "MERGED"; f.world.isDraft = false;
  await f.orchestrator.mergeAgent("agent");
  const before = f.store.get().evaluationRuns.length;
  assert.equal(await f.orchestrator.promoteMergedAgentBaseline("agent", "candidate"), true);
  assert.equal(f.store.get().evaluationRuns.length, before + 2);
  assert.equal(f.calls.samples.length, 2);
});

test("negative history and current author admission remain closed to policy-only repairs", async (t) => {
  for (const [name, edit] of policyEdits.slice(0, 6)) await t.test(name, async (t) => {
    const f = await fixture(t);
    f.world.score = 68;
    assert.equal(await f.qualify(), false);
    const history = clone(f.run().fullEvaluationHistory), reviews = clone(f.run().reviewRounds);
    await f.store.update(edit);
    assert.equal(await f.qualify().catch(() => false), false);
    await assert.rejects(f.orchestrator.retryAgent("agent"));
    assert.deepEqual(f.run().fullEvaluationHistory, history);
    assert.deepEqual(f.run().reviewRounds, reviews);
    assert.equal(f.calls.samples.length, 2);
    assert.equal(f.run().fullEvaluation, undefined);
    assert.deepEqual(f.calls.blocked, []);
  });
});

test("a genuinely changed candidate with current independent approval can still qualify", async (t) => {
  const f = await fixture(t);
  f.world.score = 68;
  assert.equal(await f.qualify(), false);
  const original = clone(f.run().fullEvaluationHistory[0]);
  f.world.head = "changed-candidate"; f.world.score = 76;
  // Arrange the next independently approved source, as the author/review owner
  // does. This control exercises public full qualification, not author execution.
  await f.store.update((state) => {
    state.evaluations[0].weight = 4;
    const run = state.agentRuns[0], fingerprint = fullMergeValidationFingerprint(state);
    run.continuation.head = "changed-candidate";
    run.continuation.identity.pullRequest.head = "changed-candidate";
    run.continuation.identity.evaluationFingerprint = fingerprint;
    run.reviewRounds.push({ ...run.reviewRounds[0], id: "approval-2", round: 2, commit: "changed-candidate", evaluationFingerprint: fingerprint });
  });
  assert.equal(await f.qualify(), true);
  assert.equal(f.run().fullEvaluationHistory.length, 2);
  assert.deepEqual(f.run().fullEvaluationHistory[0], original);
  assert.equal(f.calls.samples.length, 4);
});

test("historical absorbed retirement uses its recorded delivery and exact retained transfer after policy drift", async (t) => {
  for (const drift of ["policy-only", "damaged-row", "missing-transfer"]) await t.test(drift, async (t) => withFixture(t, {}, async (f) => {
    const delivered = await deliver(f);
    const parentBranch = "burner/recorded-parent";
    const parentWorktree = await f.git.createWorktree("recorded-parent", parentBranch, f.base);
    await f.git.mergeBranch(parentWorktree, delivered.continuation.head);
    assert.equal(await f.git.isCommitAncestor(delivered.continuation.head, await f.git.head(parentWorktree)), true);
    // Arrange the already-recorded atomic transfer, not a new absorption
    // admission. Its real delivery receipt and merged source stay unmodified.
    await f.store.update((state) => {
      const run = state.agentRuns.find((item) => item.id === delivered.id);
      Object.assign(run, { status: "absorbed", parentCompositeId: "parent", absorbedAt: time, baseRef: parentBranch });
      run.continuation.outcome = "absorbed";
      run.continuation.identity.baseRef = parentBranch;
      state.composites.push({ id: "parent", title: "Recorded transfer", branch: parentBranch, worktree: parentWorktree, status: "open",
        baseCommit: f.base, sources: [{ agentRunId: run.id, branch: run.branch, prNumber: run.prNumber, title: "Transferred leaf",
          kind: "experiment", absorbedAt: time }], deltas: [], reviewRounds: [], pendingExperimentRunIds: [], createdAt: time, updatedAt: time });
      state.evaluations[0].weight = 7;
      if (drift === "damaged-row") {
        const selected = run.continuation.evaluation.result.selections[0].candidate;
        state.evaluationRuns.find((row) => row.id === selected).score += 1;
      } else if (drift === "missing-transfer") state.composites[0].sources = [];
    });
    const before = clone(f.run()), rows = clone(f.store.get().evaluationRuns), evidence = evidenceSnapshot(f);
    const effects = f.calls.effects.length;
    if (drift === "policy-only") f.fault = { name: "close", cut: "lost-response", hit: false };
    await f.restart();
    await f.sync();
    if (drift === "policy-only") {
      assert.equal(f.fault.hit, true);
      assert.equal(f.world.pr.state, "CLOSED");
      assert.equal(f.run().prState, "open", "uncertain response does not fabricate close acknowledgment");
      assert.equal(f.run().leafPr.pending.effect.kind, "close");
      f.fault = undefined;
      await f.restart();
      await f.sync();
      assert.equal(f.run().prState, "closed");
      assert.equal(f.run().leafPr.known.fields.state, "CLOSED");
      assert.equal(f.run().leafPr.pending, undefined);
      assert.equal(f.calls.effects.length, effects + 1, "the exact closed after-image is not sent twice");
      assert.equal(f.run().status, "absorbed");
      assert.equal(f.run().absorbedAt, time);
    } else {
      assert.equal(f.world.pr.state, "OPEN");
      assert.deepEqual(f.run(), before, "damaged evidence or transfer membership cannot authorize retirement");
      assert.equal(f.calls.effects.length, effects);
    }
    assertEvidenceUnchanged(f, evidence);
    assert.deepEqual(f.store.get().evaluationRuns, rows);
    assert.equal(f.calls.merges.length, 0, "historical retirement cannot authorize a PR merge");
  }));
});
