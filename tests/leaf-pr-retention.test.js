import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateStore } from "../dist/lib/store.js";

const timestamp = "2026-01-01T00:00:00.000Z";
const base = "a".repeat(40);
const head = "b".repeat(40);
const fingerprint = "fixed-evaluation-definition";
const reference = (runId) => ({ runId, digest: "c".repeat(64) });

function idea(id, runId) {
  return { id, title: id, description: "Retained publication input", rationale: "Persistence contract",
    predictedImpact: 1, evaluationIds: [], resources: [], status: "completed", source: "manual",
    createdAt: timestamp, updatedAt: timestamp, agentRunId: runId };
}

function run(id, ideaId) {
  return { id, ideaId, status: "completed", branch: `burner/${id}`, worktree: "",
    startedAt: timestamp, completedAt: timestamp, deltas: [], resources: [], reviewRounds: [] };
}

function ownership(branch, state = "OPEN") {
  return { version: 1, repository: { host: "github.com", id: "R_fixture", nameWithOwner: "fixture/repo" },
    branch, baseBranch: "main", known: { number: 41, url: "https://github.com/fixture/repo/pull/41",
      fields: { title: "Owned title", body: "Owned evidence", isDraft: true, state } } };
}

function continuation(evaluation) {
  return { id: "leaf-owned", head, identity: { baseRef: "main", baseCommit: base,
    branch: "burner/owned-run", evaluationFingerprint: fingerprint, remote: "origin", baseBranch: "main",
    pullRequest: { number: 41, head, url: "https://github.com/fixture/repo/pull/41" } },
    step: "done", outcome: "completed", completedAt: timestamp, ...(evaluation ? { evaluation } : {}) };
}

function evaluationRow(id, extra = {}) {
  return { id, evaluationId: "perf", commit: head, context: "agent", agentRunId: "owned-run",
    status: "completed", score: 1, durationMs: 1, attempts: 1, createdAt: timestamp,
    evaluationDefinitionVersion: "v1", ...extra };
}

// These receipts exercise persistence of opaque evidence, not score admission.
// Public qualification tests separately validate hashes, cohorts and verdicts.
function receipt(id) {
  return { id, purpose: "full", agentRunId: "owned-run", identity: { baseCommit: base, candidateCommit: head,
    evaluationFingerprint: fingerprint }, candidateTree: "d".repeat(40), scoreDefinitionFingerprint: "scores-v1",
    evaluations: [{ evaluationId: "perf", definitionVersion: "v1", mode: "prompt",
      baseline: { source: reference("old-baseline"), comparisonCommit: base, score: 2, count: 3,
        projection: { sourceCommit: base, inputs: [reference("projected-source")] } },
      baselineMedian: reference("baseline-median"),
      baselineConfirmations: [{ attempts: ["baseline-confirmation"], success: reference("baseline-confirmation") }],
      candidate: [{ attempts: ["failed-attempt", "successful-sample"], success: reference("successful-sample") },
        { reuse: { ...reference("reused-command"), reason: "full-command" } }] }],
    result: { completedAt: timestamp, sources: [reference("result-source")], selections: [],
      deltas: [{ evaluationId: "perf", name: "Performance", before: 2, after: 1, delta: -1 }], impact: -1 } };
}

function composite(id) {
  return { id, title: id, description: "Retained transfer identity", status: "closed", branch: `burner/${id}`,
    worktree: "", sources: [], deltas: [], reviewRounds: [], createdAt: timestamp, updatedAt: timestamp, isLiving: false,
    pendingExperimentRunIds: [] };
}

async function withStore(t, action) {
  const prefix = join(tmpdir(), "burner-leaf-pr-retention-");
  const root = await mkdtemp(prefix);
  try {
    const store = new StateStore(root);
    await store.init({ recoverInterrupted: false });
    await action(store, root);
    assert.ok(root.startsWith(prefix));
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    t.diagnostic(`Retained failed isolated persistence fixture: ${root}`);
    throw error;
  }
}

function exceedRunAndIdeaWindows(state) {
  for (let index = 0; index < 501; index += 1) {
    state.ideas.push(idea(`unrelated-idea-${index}`, `unrelated-run-${index}`));
    state.agentRuns.push(run(`unrelated-run-${index}`, `unrelated-idea-${index}`));
  }
}

async function reload(root) {
  const store = new StateStore(root);
  await store.init();
  return store;
}

test("old OPEN leaf keeps its owning idea through rolling history and default reload", async (t) => withStore(t, async (store, root) => {
  const ownedIdea = idea("owned-idea", "owned-run");
  const ownedRun = { ...run("owned-run", ownedIdea.id), prNumber: 41, prUrl: "https://github.com/fixture/repo/pull/41", prState: "open" };
  await store.update((state) => {
    state.ideas.push(structuredClone(ownedIdea));
    state.agentRuns.push(structuredClone(ownedRun));
    exceedRunAndIdeaWindows(state);
  });
  const persisted = (await reload(root)).get();
  assert.deepEqual(persisted.agentRuns.find((item) => item.id === ownedRun.id), ownedRun);
  assert.deepEqual(persisted.ideas.find((item) => item.id === ownedIdea.id), ownedIdea);
  assert.equal(persisted.agentRuns.some((item) => item.id === "unrelated-run-0"), false);
  assert.equal(persisted.ideas.some((item) => item.id === "unrelated-idea-0"), false);
}));

test("ordinary old completed run without a PR owner remains eligible for rolling retention", async (t) => withStore(t, async (store, root) => {
  const finishedIdea = idea("finished-idea", "finished-run");
  const finishedRun = { ...run("finished-run", finishedIdea.id), continuation: continuation() };
  // Keep the fixture's completed cursor identity consistent with its owner.
  finishedRun.continuation.identity.branch = finishedRun.branch;
  delete finishedRun.continuation.identity.pullRequest;
  await store.update((draft) => {
    draft.ideas.push(structuredClone(finishedIdea));
    draft.agentRuns.push(structuredClone(finishedRun));
    exceedRunAndIdeaWindows(draft);
  });
  const persisted = (await reload(root)).get();
  assert.equal(persisted.agentRuns.some((item) => item.id === finishedRun.id), false);
  assert.equal(persisted.ideas.some((item) => item.id === finishedIdea.id), false);
}));

for (const state of ["open", "closed", "merged", "superseded"]) {
  test(`durable PR owner retains its run and idea when display disposition is ${state}`, async (t) => withStore(t, async (store, root) => {
    const ownedIdea = idea("owned-idea", "owned-run");
    const ownedRun = { ...run("owned-run", ownedIdea.id), baseRef: "main", baseCommit: base,
      prNumber: 41, prUrl: "https://github.com/fixture/repo/pull/41", prState: state,
      continuation: continuation(), leafPr: ownership("burner/owned-run", state === "closed" || state === "superseded" ? "CLOSED" : "OPEN") };
    if (state === "merged") ownedRun.leafPr.known.fields.isDraft = false;
    if (state === "closed" || state === "superseded") ownedRun.leafPr.terminal = {
      kind: state === "closed" ? "abandoned" : "superseded", continuationId: "leaf-owned",
    };
    await store.update((draft) => {
      draft.ideas.push(structuredClone(ownedIdea));
      draft.agentRuns.push(structuredClone(ownedRun));
      exceedRunAndIdeaWindows(draft);
    });
    const persisted = (await reload(root)).get();
    assert.deepEqual(persisted.agentRuns.find((item) => item.id === ownedRun.id), ownedRun);
    assert.deepEqual(persisted.ideas.find((item) => item.id === ownedIdea.id), ownedIdea);
    assert.equal(persisted.agentRuns.some((item) => item.id === "unrelated-run-0"), false);
  }));
}

for (const effect of ["create", "close"]) {
  test(`unacknowledged ${effect} effect survives trimming before remote outcome is known`, async (t) => withStore(t, async (store, root) => {
    const ownedIdea = idea("owned-idea", "owned-run");
    const leafPr = ownership("burner/owned-run");
    if (effect === "create") {
      const after = structuredClone(leafPr.known.fields);
      delete leafPr.known;
      leafPr.creationToken = "correlation-for-one-creation";
      leafPr.pending = { id: "create-intent", owner: { kind: "delivery", continuationId: "leaf-owned" },
        target: after, effect: { kind: "create", after } };
    } else {
      const reason = { kind: "review-limit", continuationId: "leaf-owned" };
      const before = structuredClone(leafPr.known.fields);
      const after = { ...before, state: "CLOSED" };
      leafPr.terminal = reason;
      leafPr.pending = { id: "close-intent", owner: { kind: "terminal-close", reason },
        target: after, effect: { kind: "close", before, after } };
    }
    // No display state or live continuation supplies an independent retention
    // reason: the durable PR effect itself must keep its exact owner alive.
    const ownedRun = { ...run("owned-run", ownedIdea.id), leafPr };
    await store.update((draft) => {
      draft.ideas.push(structuredClone(ownedIdea));
      draft.agentRuns.push(structuredClone(ownedRun));
      exceedRunAndIdeaWindows(draft);
    });
    const reloaded = await reload(root);
    await reloaded.addActivity({ type: "system", message: "Still awaiting remote effect acknowledgment" });
    const persisted = (await reload(root)).get();
    assert.deepEqual(persisted.agentRuns.find((item) => item.id === ownedRun.id), ownedRun);
    assert.deepEqual(persisted.ideas.find((item) => item.id === ownedIdea.id), ownedIdea);
    assert.equal(persisted.agentRuns.some((item) => item.id === "unrelated-run-0"), false);
  }));
}

test("closed PR awaiting semantic acknowledgment retains exact owner, history and evidence closure", async (t) => withStore(t, async (store, root) => {
  const ownedIdea = idea("owned-idea", "owned-run");
  const leafPr = ownership("burner/owned-run", "CLOSED");
  const reason = { kind: "abandoned", continuationId: "leaf-owned" };
  leafPr.terminal = reason;
  leafPr.pending = { id: "close-intent", owner: { kind: "terminal-close", reason }, target: structuredClone(leafPr.known.fields) };
  const full = receipt("full-assessment");
  const partial = { ...receipt("superseded-sampling"), result: undefined,
    evaluations: [{ ...receipt("superseded-sampling").evaluations[0],
      candidate: [{ attempts: ["superseded-sample"], success: reference("superseded-sample") }] }] };
  const ownedRun = { ...run("owned-run", ownedIdea.id), baseRef: "main", baseCommit: base, prNumber: 41,
    prUrl: leafPr.known.url, prState: "closed", leafPr,
    fullEvaluationHistory: [
      { kind: "assessment", comparison: { tree: "d".repeat(40), progress: [] }, assessment: {
        ...full.identity, candidateTree: full.candidateTree, qualified: false, completedAt: timestamp,
        deltas: full.result.deltas, impact: -1, evaluation: full,
        legacyProvenance: { importer: "old-leaf-full-v1", originalDigest: "e".repeat(64),
          sources: [reference("legacy-source")], activities: [], reductions: [] } } },
      { kind: "superseded", evaluation: partial, refreshId: "refresh-old", targetRef: "main", targetCommit: base, retiredAt: timestamp },
    ], reviewRounds: [{ id: "review-owned", round: 1, commit: head, baseCommit: "f".repeat(40),
      approved: true, summary: "Saved review", findings: [], createdAt: timestamp, completedAt: timestamp }] };
  // A PR owner without a continuation must retain old measurements too. It is
  // not valid to infer release from a closed PR or from a missing cursor.
  const rows = [
    evaluationRow("old-baseline", { agentRunId: undefined, context: "baseline", commit: base }),
    evaluationRow("projected-source", { agentRunId: undefined, sourceRunIds: ["projection-parent"] }),
    evaluationRow("projection-parent", { agentRunId: undefined, sourceRunIds: ["projection-root"] }),
    evaluationRow("projection-root", { agentRunId: undefined }),
    ...["baseline-median", "baseline-confirmation", "failed-attempt", "successful-sample", "reused-command",
      "result-source", "superseded-sample", "legacy-source", "otherwise-unreferenced-owned-sample"].map((id) => evaluationRow(id)),
    evaluationRow("old-comparison", { agentRunId: undefined, context: "baseline", commit: "f".repeat(40) }),
  ];
  await store.update((draft) => {
    draft.ideas.push(structuredClone(ownedIdea));
    draft.agentRuns.push(structuredClone(ownedRun));
    draft.evaluationRuns.push(...structuredClone(rows));
    exceedRunAndIdeaWindows(draft);
    draft.evaluationRuns.push(...Array.from({ length: 1_101 }, (_, index) => evaluationRow(`unrelated-eval-${index}`,
      { agentRunId: "unrelated-run-500", commit: "9".repeat(40) })));
    draft.evaluationRuns.push(evaluationRow("new-baseline", { agentRunId: undefined, context: "baseline",
      commit: "9".repeat(40), createdAt: "2026-02-01T00:00:00.000Z" }));
  });
  const reloaded = await reload(root);
  await reloaded.addActivity({ type: "system", message: "Second trim after reload" });
  const persisted = (await reload(root)).get();
  const normalized = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(persisted.agentRuns.find((item) => item.id === ownedRun.id), normalized(ownedRun));
  assert.deepEqual(persisted.ideas.find((item) => item.id === ownedIdea.id), ownedIdea);
  for (const row of rows) assert.deepEqual(persisted.evaluationRuns.find((item) => item.id === row.id), normalized(row), row.id);
  assert.equal(persisted.evaluationRuns.some((item) => item.id === "unrelated-eval-0"), false);
}));

for (const link of ["parent", "terminal", "pending"]) {
  test(`PR owner keeps its ${link} composite handoff identity past composite history limits`, async (t) => withStore(t, async (store, root) => {
    const ownedIdea = idea("owned-idea", "owned-run");
    const ownedRun = { ...run("owned-run", ownedIdea.id), prState: "closed", leafPr: ownership("burner/owned-run", "CLOSED") };
    const handoff = composite("old-handoff");
    const reason = { kind: "superseded", continuationId: "leaf-owned", compositeId: handoff.id };
    if (link === "parent") ownedRun.parentCompositeId = handoff.id;
    if (link === "terminal") ownedRun.leafPr.terminal = reason;
    if (link === "pending") ownedRun.leafPr.pending = { id: "close-intent", owner: { kind: "terminal-close", reason },
      target: structuredClone(ownedRun.leafPr.known.fields) };
    await store.update((draft) => {
      draft.ideas.push(structuredClone(ownedIdea));
      draft.agentRuns.push(structuredClone(ownedRun));
      draft.composites.push(structuredClone(handoff), ...Array.from({ length: 251 }, (_, index) => composite(`unrelated-composite-${index}`)));
      exceedRunAndIdeaWindows(draft);
    });
    const persisted = (await reload(root)).get();
    assert.deepEqual(persisted.composites.find((item) => item.id === handoff.id), handoff);
    assert.equal(persisted.composites.some((item) => item.id === "unrelated-composite-0"), false);
    assert.deepEqual(persisted.agentRuns.find((item) => item.id === ownedRun.id), ownedRun);
  }));
}
