import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventHub } from "../dist/lib/events.js";
import { canRetryAgent, fullMergeValidationFingerprint, latestFullAssessment, fullAssessmentForIdentity, Orchestrator } from "../dist/lib/orchestrator.js";
import { replaceProgressReadmeBlock } from "../dist/lib/progress.js";
import { StateStore } from "../dist/lib/store.js";
import { fixtureGit, leafRefreshRepository } from "./leaf-refresh-test-helpers.js";
import { fixtureLeafPr, installLeafPrFixtureTransport } from "./leaf-pr-test-helpers.js";

const branch = "burner/refresh-cuts";
const timestamp = "2026-09-01T00:00:00.000Z";
const managed = ["README.md", "docs/burner-evaluation-history.json", "docs/burner-evaluation-progress.svg"];

async function fixture(t, { prepared, conflict = false, closed = false, pendingFull = false } = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), "burner-refresh-public-"));
  let passed = false;
  const priorTrace = process.env.GIT_TRACE2_EVENT;
  t.after(async () => {
    if (priorTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = priorTrace;
    if (passed) await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    else t.diagnostic(`Failed fixture retained: ${root}`);
  });
  const store = new StateStore(root);
  await store.init();
  const g = await leafRefreshRepository(root, { branch, published: true, deferTarget: pendingFull });
  let reviewed = g.head;
  let target = g.target;
  if (conflict) {
    await fs.writeFile(join(g.worktree, "base.txt"), "leaf conflict\n");
    reviewed = await g.git.commit(g.worktree, "leaf conflict");
    await fs.writeFile(join(root, "base.txt"), "upstream conflict\n");
    target = await g.git.commit(root, "upstream conflict");
    await g.git.push(root, "origin", "main");
  }
  const readme = await fs.readFile(join(g.worktree, "README.md"), "utf8");
  const plan = await g.git.planLeafManagedFiles(g.worktree, branch, reviewed, {
    "README.md": replaceProgressReadmeBlock(readme, "<!-- burner-progress:start -->\nOld generated progress.\n<!-- burner-progress:end -->"),
    "docs/burner-evaluation-history.json": '{"old":true}\n',
    "docs/burner-evaluation-progress.svg": "<svg>old</svg>\n",
  });
  await g.git.applyLeafManagedFiles(g.worktree, branch, plan);
  const stampReceipt = await g.git.prepareLeafCommit(g.worktree, branch, reviewed);
  const stamped = await g.git.finalizeLeafCommit(g.worktree, branch, stampReceipt, "old generated stamp");
  await g.git.pushLeaf(g.worktree, "origin", branch, stamped, g.head);
  const generatedProgress = { inputCommit: reviewed, inputTree: plan.inputTree, outputCommit: stamped, outputTree: plan.tree, plan };
  await g.git.verifyGeneratedProgress(generatedProgress);
  let preparedReceipt;
  if (prepared) {
    await fs.writeFile(join(g.worktree, "completed-result.txt"), `Returned ${prepared} result\n`);
    preparedReceipt = await g.git.prepareLeafCommit(g.worktree, branch, stamped);
  }
  await store.update((state) => {
    Object.assign(state.settings, { autoRun: true, autoCreatePrs: true, maxReviewRounds: 12, portfolioReviewRounds: 12, parallelism: 1 });
    state.orchestrator.enabled = false;
    state.evaluations = [{ id: "perf", name: "Fixture performance", ...(!pendingFull ? { command: "MUST-NOT-EXECUTE" } : {}), prompt: "Frozen fixture contract", definitionVersion: "v1", weight: 1, enabled: true, createdAt: timestamp }];
    state.evaluationRuns = [...new Set([g.base, target])].map((commit, index) => ({ id: `baseline-${index}`, evaluationId: "perf", score: 70, commit, context: "baseline", status: "completed", durationMs: 1, createdAt: `2026-09-0${index + 1}T00:00:00.000Z`, evaluationDefinitionVersion: "v1", ...(pendingFull ? { promptSampleCount: 3 } : {}) }));
    state.ideas = [{ id: "idea", title: "Retain same leaf", description: "Original task", rationale: "Recovery", predictedImpact: 1, evaluationIds: ["perf"], resources: [], status: "failed", source: "manual", agentRunId: "agent", createdAt: timestamp, updatedAt: timestamp },
      { id: "unrelated", title: "Do not run", description: "", rationale: "", predictedImpact: 100, evaluationIds: [], resources: [], status: "queued", source: "manual", createdAt: timestamp, updatedAt: timestamp }];
    const fingerprint = fullMergeValidationFingerprint(state);
    const identity = { baseRef: "main", baseCommit: g.base, branch, evaluationFingerprint: fingerprint, remote: "origin", baseBranch: "main", pullRequest: { number: 42, head: stamped, url: "https://example.test/pr/42" } };
    const deltas = [{ evaluationId: "perf", name: "Fixture performance", before: 70, after: 68, delta: -2, summary: "Old confirmed rejection" }];
    state.agentRuns = [{ id: "agent", ideaId: "idea", branch, worktree: g.worktree, status: "failed", startedAt: timestamp, completedAt: timestamp,
      baseRef: "main", baseCommit: g.base, authorThreadId: "same-author", lastMessage: "Prior implementation", resources: [], prNumber: 42, prUrl: "https://example.test/pr/42", prState: closed ? "closed" : "open", reviewApproved: !prepared,
      reviewRounds: Array.from({ length: 9 }, (_, index) => ({ id: `review-${index}`, round: index + 1, commit: reviewed, approved: index === 8, summary: "Historical review", findings: [], createdAt: timestamp, completedAt: timestamp, baseCommit: g.base, evaluationFingerprint: fingerprint })),
      deltas, impact: -2, generatedProgress,
      fullMergeValidation: { baseCommit: g.base, candidateCommit: reviewed, candidateTree: plan.inputTree, evaluationFingerprint: fingerprint, qualified: false, completedAt: timestamp, deltas, impact: -2 },
      continuation: prepared ? { id: "returned-result", identity, head: stamped, step: "commit", tree: preparedReceipt.tree,
        source: prepared === "author" ? { kind: "author", reason: { kind: "initial" } } : { kind: "evidence", implementationCommit: stamped },
        result: { threadId: "same-author", message: `Returned ${prepared} result` }, commitMessage: `record returned ${prepared}` }
        : { id: "old-delivery", identity, head: stamped, step: "done", outcome: "completed", completedAt: timestamp },
    }];
    state.agentRuns[0].leafPr = fixtureLeafPr(state.agentRuns[0], { title: "Retain same leaf", body: "Old", isDraft: true, state: closed ? "CLOSED" : "OPEN" });
  });
  const counts = { author: 0, evidence: 0, review: 0, evaluation: 0, reopen: 0, edit: 0 };
  const remote = { number: 42, state: closed ? "CLOSED" : "OPEN", headRefName: branch, title: "Retain same leaf", body: "Old", isDraft: true, url: "https://example.test/pr/42" };
  g.git.getPullRequest = async () => ({ ...remote, headRefOid: await g.git.remoteBranchHead(root, "origin", branch), statusCheckRollup: [] });
  g.git.reopenPr = async (_cwd, number) => { assert.equal(number, 42); counts.reopen += 1; remote.state = "OPEN"; };
  g.git.editPr = async (_cwd, number, title, body) => { assert.equal(number, 42); counts.edit += 1; Object.assign(remote, { title, body }); };
  g.git.markPrDraft = async () => { remote.isDraft = true; };
  for (const method of ["mergePr", "closePr", "openPr", "listPullRequests"]) g.git[method] = async () => { assert.fail(`Base refresh cannot call ${method}`); };
  installLeafPrFixtureTransport(g.git, {
    observe: (...args) => g.git.getPullRequest(...args),
    edit: (cwd, number, field, value) => g.git.editPr(cwd, number,
      field === "title" ? value : remote.title, field === "body" ? value : remote.body),
    draft: (cwd, number, value) => { assert.equal(value, true); return g.git.markPrDraft(cwd, number); },
  });
  // Retain the checkout for exact tree/parent assertions after delivery.
  g.git.removeWorktree = async () => undefined;
  const codex = {
    preflight: async () => undefined,
    implement: async () => { assert.fail("The completed original author must not rerun"); },
    revise: async (cwd, thread, review) => {
      assert.equal(conflict, true); assert.equal(cwd, g.worktree); assert.equal(thread, "same-author");
      assert.match(review.summary, new RegExp(target));
      counts.author += 1;
      await fs.writeFile(join(cwd, "base.txt"), "resolved pinned conflict\n");
      return { threadId: thread, message: "Durable conflict resolution" };
    },
    refreshAgentEvidence: async (_cwd, _base, _title, thread) => { assert.equal(thread, "same-author"); counts.evidence += 1; return { threadId: thread, message: "New-base evidence" }; },
    review: async () => { counts.review += 1; return { approved: true, summary: "Approved refreshed input", findings: [] }; },
    evaluate: async (_cwd, _evaluation, _settings, context) => {
      counts.evaluation += 1;
      const purpose = f.run().fullEvaluation?.step === "sampling" ? "full" : "delivery";
      return { score: purpose === "full" ? 72 : 71, summary: `Measured ${purpose}/${context} input`, evidence: [], suggestions: [] };
    },
  };
  const f = { root, ...g, target, reviewed, stamped, prepared, counts, remote, store,
    full: structuredClone(store.get().agentRuns[0].fullMergeValidation), pass: () => { passed = true; } };
  const bind = () => {
    f.orchestrator = new Orchestrator(root, f.store, new EventHub());
    f.orchestrator.git = g.git;
    f.orchestrator.codex = codex;
    f.orchestrator.scheduleComposites = async () => { assert.fail("Paused refresh cannot schedule unrelated work"); };
    f.orchestrator.tick = async () => { assert.fail("Paused refresh cannot start the campaign"); };
    f.run = () => f.store.get().agentRuns[0];
  };
  bind();
  f.restart = async () => { f.store = new StateStore(root); await f.store.init(); bind(); };
  const trace = join(root, ".burner", "refresh-git-trace.jsonl");
  process.env.GIT_TRACE2_EVENT = trace;
  f.effects = async (command) => (await fs.readFile(trace, "utf8").catch(() => "")).split("\n").filter(Boolean).map(JSON.parse)
    .filter((event) => event.event === "start" && event.argv?.includes(command) &&
      (command !== "push" || event.argv.some((arg) => arg === branch || arg.endsWith(`refs/heads/${branch}`))));
  return f;
}

function stateCut(f, predicate, afterRename = false) {
  let fired = false;
  const fail = (state) => { if (!fired && predicate(state.agentRuns[0])) { fired = true; throw new Error("Injected refresh state cut"); } };
  let restore;
  if (afterRename) restore = f.store.subscribe(fail);
  else {
    const update = f.store.update.bind(f.store);
    f.store.update = (mutator) => update((draft) => { mutator(draft); fail(draft); });
    restore = () => { f.store.update = update; };
  }
  return { fired: () => fired, restore };
}

async function assertCompleted(f, { merges = 1, commits = f.prepared ? 3 : 2, author = 0 } = {}) {
  const run = f.run();
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.prNumber, 42);
  assert.equal(run.branch, branch);
  assert.equal(run.authorThreadId, "same-author");
  assert.equal(run.baseCommit, f.target);
  assert.equal(run.reviewRounds.length, 10);
  assert.equal(run.reviewRounds.at(-1).baseCommit, f.target);
  assert.deepEqual(latestFullAssessment(run), f.full, "ordinary delivery cannot clear the saved negative full assessment");
  assert.equal(run.generatedProgress, undefined);
  assert.deepEqual(f.counts, { author, evidence: 1, review: 1, evaluation: 1, reopen: 0, edit: 1 });
  assert.equal((await f.effects("merge")).length, merges);
  assert.equal((await f.effects("commit")).length, commits);
  assert.equal((await f.effects("push")).length, merges);
  assert.equal(await f.git.remoteBranchHead(f.root, "origin", branch), run.continuation.head);
  assert.equal(await f.git.hasChanges(f.worktree), false);
  assert.equal(f.orchestrator.agentClaims.size, 0);
  assert.equal(f.orchestrator.activeAgents.size, 0);
  assert.deepEqual(await f.orchestrator.locks.list(), []);
  assert.equal(f.store.get().orchestrator.enabled, false);
  assert.equal(f.store.get().settings.autoRun, true);
  assert.equal(f.store.get().ideas.find((idea) => idea.id === "unrelated").status, "queued");
  const mergeHeads = (await fixtureGit(f.worktree, "rev-list", "--merges", `${f.stamped}..HEAD`)).split("\n").filter(Boolean);
  assert.equal(mergeHeads.length, merges);
  const parents = (await fixtureGit(f.worktree, "rev-list", "--parents", "-n", "1", mergeHeads[0])).split(" ");
  assert.equal(parents.length, 3);
  assert.equal(parents[2], f.target);
  for (const path of managed.slice(1)) await assert.rejects(fs.readFile(join(f.worktree, path)), { code: "ENOENT" });
  assert.doesNotMatch(await fs.readFile(join(f.worktree, "README.md"), "utf8"), /burner-progress:start/);
}

async function pendingFullFixture(t, { completed = false } = {}) {
  const f = await fixture(t, { pendingFull: true, closed: false });
  f.orchestrator.codex.revise = async (cwd, thread, feedback, _settings, kind) => {
    assert.equal(kind, "evaluation"); assert.equal(thread, "same-author");
    assert.match(feedback.summary, /Confirmed full evaluation rejected/);
    f.counts.author += 1;
    await fs.writeFile(join(cwd, "repaired.txt"), "A distinct repaired implementation\n");
    return { threadId: thread, message: "Repaired before interrupted full qualification" };
  };
  assert.equal((await f.orchestrator.retryAgent("agent")).status, "completed");
  assert.equal(f.run().reviewRounds.length, 10);
  assert.equal(f.counts.evaluation, 3);
  const evaluate = f.orchestrator.codex.evaluate;
  let attempts = 0;
  if (completed) {
    const cut = stateCut(f, (run) => run.fullEvaluation?.step === "publication");
    await assert.rejects(f.orchestrator.fullyValidateLeafForMerge("agent", f.base), /Injected refresh state cut/);
    assert.equal(cut.fired(), true);
    cut.restore();
  } else {
    f.orchestrator.codex.evaluate = async (...args) => {
      if (++attempts > 1) throw new Error("Full confirmation transport interrupted");
      return evaluate(...args);
    };
    assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", f.base), false);
    f.orchestrator.codex.evaluate = evaluate;
  }
  const pending = f.run().fullEvaluation;
  assert.equal(pending.step, "sampling");
  assert.equal(Boolean(pending.evaluation.result), completed);
  assert.ok(pending.evaluation.evaluations[0].candidate[0].success);
  f.pending = structuredClone(pending.evaluation);
  f.history = structuredClone(f.run().fullEvaluationHistory);
  f.originalHead = await f.git.head(f.worktree);
  f.originalRows = f.store.get().evaluationRuns.filter((row) => row.leafSample?.receiptId === f.pending.id);
  f.advanceBase = async () => {
    f.target = await f.advance();
    await f.store.update((state) => state.evaluationRuns.push({ id: "advanced-baseline", evaluationId: "perf", score: 70,
      commit: f.target, context: "baseline", status: "completed", promptSampleCount: 3, durationMs: 1,
      createdAt: new Date().toISOString(), evaluationDefinitionVersion: "v1" }));
  };
  return f;
}

test("public base advance atomically retires partial full ownership and pins refresh across publication cuts", async (t) => {
  for (const cut of ["before-rename", "after-rename", "after-merge", "after-push"]) await t.test(cut, async (t) => {
    const f = await pendingFullFixture(t);
    await f.advanceBase();
    const count = f.counts.evaluation;
    let state;
    let fired = false;
    let restore = () => {};
    if (cut.endsWith("rename")) {
      state = stateCut(f, (run) => run.continuation?.step === "refresh" && run.continuation.phase === "merge", cut === "after-rename");
      restore = state.restore;
    } else {
      const method = cut === "after-merge" ? "finalizeLeafCommit" : "pushLeaf";
      const original = f.git[method].bind(f.git);
      f.git[method] = async (...args) => {
        const cursor = f.run().continuation;
        const result = await original(...args);
        if (!fired && cursor?.step === "refresh" && cursor.phase === (cut === "after-merge" ? "commit" : "push")) {
          fired = true; throw new Error(`Injected partial full ${cut}`);
        }
        return result;
      };
      restore = () => { f.git[method] = original; };
    }
    try {
      if (cut === "after-rename") await f.orchestrator.refreshAgentBaseAndRetry("agent");
      else await assert.rejects(f.orchestrator.refreshAgentBaseAndRetry("agent"), /Injected/);
    } finally { restore(); }
    assert.equal(state?.fired() ?? fired, true);
    if (cut === "before-rename") {
      assert.deepEqual(f.run().fullEvaluation.evaluation, f.pending);
      assert.deepEqual(f.run().fullEvaluationHistory, f.history);
      assert.equal(f.run().continuation.step, "done");
    } else {
      assert.equal(f.run().fullEvaluation, undefined);
      const retired = f.run().fullEvaluationHistory.at(-1);
      assert.equal(retired.kind, "superseded");
      assert.deepEqual(retired.evaluation, f.pending);
      assert.equal(retired.targetCommit, f.target);
      assert.equal(retired.targetRef, "main");
      if (f.run().continuation.step === "refresh") assert.equal(retired.refreshId, f.run().continuation.id);
    }
    await f.restart();
    if (f.run().status !== "completed") await f.orchestrator.refreshAgentBaseAndRetry("agent");
    assert.equal(f.run().status, "completed", f.run().error);
    assert.equal(f.run().baseCommit, f.target);
    assert.equal(f.run().reviewRounds.length, 11);
    assert.equal(f.counts.evaluation, count + 3, "retired old-base slots never resume; only new-base delivery runs");
    assert.deepEqual(f.run().fullEvaluationHistory.slice(0, 1), f.history);
    assert.equal(f.run().fullEvaluationHistory.length, 2);
    const retired = f.run().fullEvaluationHistory[1];
    assert.deepEqual(retired.evaluation, f.pending);
    assert.equal(latestFullAssessment(f.run()).qualified, false, "a partial retirement is not an assessment");
    for (const row of f.originalRows) assert.deepEqual(f.store.get().evaluationRuns.find((saved) => saved.id === row.id), row);
    const merges = (await fixtureGit(f.worktree, "rev-list", "--merges", `${f.originalHead}..HEAD`)).split("\n").filter(Boolean);
    assert.equal(merges.length, 1);
    const parents = (await fixtureGit(f.worktree, "rev-list", "--parents", "-n", "1", merges[0])).split(" ");
    assert.deepEqual(parents.slice(1), [f.originalHead, f.target]);
    assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", f.target), true);
    assert.equal(f.counts.evaluation, count + 6);
    assert.equal(f.run().fullEvaluationHistory.length, 3);
    assert.equal(f.run().fullEvaluation, undefined);
    assert.equal(f.run().fullMergeValidation, undefined);
    assert.equal(f.store.get().orchestrator.enabled, false);
    assert.equal(f.run().authorThreadId, "same-author");
    assert.equal(f.run().prNumber, 42);
    f.pass();
  });
});

test("completed full reduction at an advanced base finalizes its recorded verdict before refresh", async (t) => {
  for (const cut of ["before-edit", "after-edit", "ack-before-rename"]) await t.test(cut, async (t) => {
    const f = await pendingFullFixture(t, { completed: true });
    await f.advanceBase();
    const count = f.counts.evaluation;
    const edit = f.git.editPr;
    let fired = false;
    let restore;
    if (cut === "ack-before-rename") {
      const update = f.store.update.bind(f.store);
      f.store.update = (mutate) => update((state) => {
        const publication = state.agentRuns[0].fullEvaluation?.step === "publication";
        mutate(state);
        if (!fired && publication && !state.agentRuns[0].fullEvaluation) { fired = true; throw new Error("Injected completed full acknowledgement"); }
      });
      restore = () => { f.store.update = update; };
    } else {
      f.git.editPr = async (...args) => {
        if (!fired) { fired = true; if (cut === "after-edit") await edit(...args); throw new Error("Injected completed full edit"); }
        return edit(...args);
      };
      restore = () => { f.git.editPr = edit; };
    }
    // A different confirmed full score produces a distinct rendered body;
    // the renderer intentionally does not include raw evaluator summaries.
    try { await assert.rejects(f.orchestrator.refreshAgentBaseAndRetry("agent"), /Injected completed full/); }
    finally { restore(); }
    assert.equal(fired, true);
    assert.equal(f.run().baseCommit, f.base);
    assert.equal(f.run().fullEvaluation.step, "publication");
    const assessment = fullAssessmentForIdentity(f.run(), f.pending.identity);
    assert.deepEqual(assessment.evaluation, f.pending);
    assert.equal(assessment.completedAt, f.pending.result.completedAt);
    assert.equal(assessment.impact, f.pending.result.impact);
    assert.equal(assessment.qualified, true);
    assert.equal(f.run().fullEvaluationHistory.some((entry) => entry.kind === "superseded"), false);
    assert.equal(f.counts.evaluation, count);
    assert.equal((await f.effects("merge")).length, 0);
    const edits = f.counts.edit;
    await f.restart();
    await f.orchestrator.refreshAgentBaseAndRetry("agent");
    assert.equal(f.run().status, "completed", f.run().error);
    assert.equal(f.run().baseCommit, f.target);
    assert.equal(f.run().reviewRounds.length, 11);
    assert.deepEqual(fullAssessmentForIdentity(f.run(), f.pending.identity), assessment);
    assert.equal(f.run().fullEvaluationHistory.length, 2);
    assert.equal(f.counts.evaluation, count + 3, "completed old-base full slots are never reevaluated");
    assert.equal(f.counts.edit, edits + (cut === "before-edit" ? 1 : 0) + 1, "only missing full edit and new-base delivery edit occur");
    assert.equal(f.run().fullEvaluation, undefined);
    assert.equal(f.store.get().orchestrator.enabled, false);
    f.pass();
  });
});

test("partial full retirement refuses foreign source, definitions, remote and base drift without losing evidence", async (t) => {
  for (const drift of ["source-head", "definitions", "remote-head", "base-reset", "target-after-plan", "snapshot-after-plan"]) {
    await t.test(drift, async (t) => {
      const f = await pendingFullFixture(t);
      if (drift === "base-reset") {
        const tree = await f.git.tree(f.base);
        const reset = await fixtureGit(f.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit-tree", tree, "-m", "Unrelated base reset");
        await fixtureGit(f.root, "update-ref", "refs/heads/main", reset, f.base);
      } else await f.advanceBase();
      if (drift === "source-head") {
        await fs.writeFile(join(f.worktree, "foreign.txt"), "Foreign source successor\n");
        await f.git.commit(f.worktree, "foreign source advance");
      }
      if (drift === "definitions") await f.store.update((state) => { state.evaluations[0].prompt = "Foreign replacement definition"; });
      if (drift === "remote-head") {
        const get = f.git.getPullRequest;
        f.git.getPullRequest = async (...args) => ({ ...await get(...args), headRefOid: f.base });
      }
      if (drift.endsWith("after-plan")) {
        const plan = f.git.planLeafMerge.bind(f.git);
        f.git.planLeafMerge = async (...args) => {
          const result = await plan(...args);
          if (drift === "target-after-plan") {
            await fs.writeFile(join(f.root, "foreign-upstream.txt"), "Foreign second base advance\n");
            await f.git.commit(f.root, "foreign base after plan");
          } else await f.store.update((state) => { state.agentRuns[0].authorThreadId = "foreign-author"; });
          return result;
        };
      }
      const count = f.counts.evaluation;
      const merges = (await f.effects("merge")).length;
      const pushes = (await f.effects("push")).length;
      await assert.rejects(f.orchestrator.refreshAgentBaseAndRetry("agent"), /recorded source|changed definitions|known unmerged PR|legitimate advance|changed during admission|admission changed identity|identity or complete fields|comparison base diverged|owner changed/);
      assert.deepEqual(f.run().fullEvaluation.evaluation, f.pending);
      assert.deepEqual(f.run().fullEvaluationHistory, f.history);
      assert.equal(f.run().continuation.step, "done");
      assert.equal(f.run().baseCommit, f.base);
      assert.equal(f.run().reviewRounds.length, 10);
      assert.equal(f.counts.evaluation, count);
      assert.equal((await f.effects("merge")).length, merges);
      assert.equal((await f.effects("push")).length, pushes);
      for (const row of f.originalRows) assert.deepEqual(f.store.get().evaluationRuns.find((saved) => saved.id === row.id), row);
      if (drift === "snapshot-after-plan") assert.equal(f.run().authorThreadId, "foreign-author", "foreign identity is not adopted or overwritten");
      assert.equal(f.orchestrator.agentClaims.size, 0);
      assert.deepEqual(await f.orchestrator.locks.list(), []);
      f.pass();
    });
  }
});

test("public pinned refresh consumes each Git and persistence cut exactly once", async (t) => {
  for (const cut of ["admission", "prepared-author", "prepared-evidence", "merge-prepared", "merge-commit", "restore-plan", ...managed.map((path) => `file:${path}`), "restore-commit", "push", "identity-before-rename", "identity-after-rename"]) {
    await t.test(cut, async (t) => {
      const prepared = cut === "prepared-author" ? "author" : cut === "prepared-evidence" ? "evidence" : undefined;
      const f = await fixture(t, { prepared });
      f.remote.wasOpen = Boolean(prepared);
      let fired = false;
      let restore = () => {};
      const fail = () => { fired = true; throw new Error(`Injected refresh ${cut}`); };
      if (["admission", "restore-plan", "identity-before-rename", "identity-after-rename"].includes(cut)) {
        const state = stateCut(f, (run) => cut === "admission" ? run.continuation?.step === "refresh" && run.continuation.phase === "merge"
          : cut === "restore-plan" ? run.continuation?.step === "refresh" && run.continuation.phase === "write"
            : run.baseCommit === f.target && run.continuation?.step === "evidence", cut === "identity-after-rename");
        restore = state.restore;
        f.wasCut = state.fired;
      } else if (cut === "merge-prepared") {
        const original = f.git.prepareLeafMerge.bind(f.git);
        f.git.prepareLeafMerge = async (...args) => { await original(...args); if (!fired) fail(); };
      } else if (cut === "push") {
        const original = f.git.pushLeaf.bind(f.git);
        f.git.pushLeaf = async (...args) => { await original(...args); if (!fired) fail(); };
      } else if (cut.startsWith("file:")) {
        const target = join(f.worktree, cut.slice(5));
        const originals = { rename: fs.rename, unlink: fs.unlink };
        fs.rename = async (from, to) => { const value = await originals.rename(from, to); if (!fired && to === target) fail(); return value; };
        fs.unlink = async (path) => { const value = await originals.unlink(path); if (!fired && path === target) fail(); return value; };
        syncBuiltinESMExports();
        restore = () => { Object.assign(fs, originals); syncBuiltinESMExports(); };
      } else {
        const original = f.git.finalizeLeafCommit.bind(f.git);
        f.git.finalizeLeafCommit = async (...args) => {
          const cursor = f.run().continuation;
          const value = await original(...args);
          if (!fired && (prepared ? cursor?.step === "commit" : cursor?.step === "refresh" && cursor.phase === (cut === "merge-commit" ? "commit" : "restore-commit"))) fail();
          return value;
        };
      }
      try {
        if (cut === "identity-after-rename") await f.orchestrator.refreshAgentBaseAndRetry("agent");
        else await assert.rejects(f.orchestrator.refreshAgentBaseAndRetry("agent"), /Injected refresh/);
      } finally { restore(); }
      assert.equal(f.wasCut?.() ?? fired, true, "the actual requested boundary must execute");
      t.diagnostic(JSON.stringify({ cut, phase: f.run().continuation.step === "refresh" ? f.run().continuation.phase : f.run().continuation.step,
        head: await f.git.head(f.worktree), base: f.run().baseCommit, remote: await f.git.remoteBranchHead(f.root, "origin", branch) }));
      await f.restart();
      if (f.run().status !== "completed") {
        if (f.run().continuation.step === "refresh") await f.orchestrator.retryAgent("agent");
        else await f.orchestrator.refreshAgentBaseAndRetry("agent");
      }
      await assertCompleted(f);
      f.pass();
    });
  }
});

test("public conflict refresh consumes its same-author result and commit without replay", async (t) => {
  for (const cut of ["result", "commit"]) await t.test(cut, async (t) => {
    const f = await fixture(t, { conflict: true });
    let fired = false;
    let restore = () => {};
    if (cut === "result") {
      // A durable result is already authority even if its listener throws.
      const state = stateCut(f, (run) => run.continuation?.step === "refresh" && run.continuation.phase === "commit" && Boolean(run.continuation.result), true);
      restore = state.restore;
      f.wasCut = state.fired;
    } else {
      const original = f.git.finalizeLeafCommit.bind(f.git);
      f.git.finalizeLeafCommit = async (...args) => { const result = await original(...args); if (!fired && f.run().continuation?.phase === "commit") { fired = true; throw new Error("Injected refresh conflict commit"); } return result; };
    }
    try {
      if (cut === "result") await f.orchestrator.refreshAgentBaseAndRetry("agent");
      else await assert.rejects(f.orchestrator.refreshAgentBaseAndRetry("agent"), /Injected refresh/);
    } finally { restore(); }
    assert.equal(f.wasCut?.() ?? fired, true);
    await f.restart();
    if (f.run().status !== "completed") await f.orchestrator.retryAgent("agent");
    await assertCompleted(f, { author: 1 });
    assert.equal(await fs.readFile(join(f.worktree, "base.txt"), "utf8"), "resolved pinned conflict\n");
    f.pass();
  });
});

test("public conflict-author retry resumes its own interrupted unstaged and staged resolution", async (t) => {
  for (const staged of [false, true]) await t.test(staged ? "staged" : "unstaged", async (t) => {
    const f = await fixture(t, { conflict: true });
    const revise = f.orchestrator.codex.revise;
    const partial = "Owned unfinished conflict resolution; resume this same author.\n";
    let authorCalls = 0;
    let saved;
    f.orchestrator.codex.revise = async (...args) => {
      authorCalls += 1;
      assert.equal(args[0], f.worktree);
      assert.equal(args[1], "same-author");
      assert.equal(f.run().continuation.step, "refresh");
      assert.equal(f.run().continuation.phase, "conflict-author", "author admission must already be durable");
      if (authorCalls === 1) {
        f.counts.author += 1;
        await fs.writeFile(join(f.worktree, "base.txt"), partial);
        if (staged) await fixtureGit(f.worktree, "add", "base.txt");
        throw new Error("Injected conflict author interruption after its own partial edit");
      }
      assert.equal(authorCalls, 2, "only the unfinished same-session author is resumed");
      assert.deepEqual(f.run().continuation, saved.continuation);
      assert.deepEqual(f.run().reviewRounds, saved.reviews);
      assert.deepEqual(f.run().fullEvaluationHistory, saved.history);
      assert.deepEqual(f.store.get().evaluationRuns, saved.rows);
      assert.equal(await fs.readFile(join(f.worktree, "base.txt"), "utf8"), partial);
      assert.equal(await fixtureGit(f.worktree, "ls-files", "--stage", "-z"), saved.index);
      assert.equal(await fixtureGit(f.worktree, "status", "--porcelain=v1", "--untracked-files=all"), saved.status);
      assert.equal(await f.git.head(f.worktree), saved.head);
      assert.equal(await fixtureGit(f.worktree, "rev-parse", "MERGE_HEAD"), f.target);
      return revise(...args);
    };
    await assert.rejects(f.orchestrator.refreshAgentBaseAndRetry("agent"), /Injected conflict author interruption/);
    assert.equal(authorCalls, 1);
    assert.equal(f.run().reviewRounds.length, 9);
    assert.equal(f.run().baseCommit, f.base);
    assert.equal(f.run().continuation.phase, "conflict-author");
    assert.equal(f.run().continuation.targetCommit, f.target);
    assert.equal(f.counts.evidence + f.counts.review + f.counts.evaluation, 0);
    assert.equal((await f.effects("merge")).length, 1);
    assert.equal((await f.effects("commit")).length, 0);
    assert.equal((await f.effects("push")).length, 0);
    assert.equal(f.orchestrator.agentClaims.size, 0);
    assert.equal(f.orchestrator.activeAgents.size, 0);
    assert.deepEqual(await f.orchestrator.locks.list(), []);
    saved = structuredClone({ continuation: f.run().continuation, reviews: f.run().reviewRounds,
      history: f.run().fullEvaluationHistory, rows: f.store.get().evaluationRuns,
      index: await fixtureGit(f.worktree, "ls-files", "--stage", "-z"),
      status: await fixtureGit(f.worktree, "status", "--porcelain=v1", "--untracked-files=all"),
      head: await f.git.head(f.worktree) });
    await f.restart();
    await f.orchestrator.retryAgent("agent");
    assert.equal(authorCalls, 2);
    await assertCompleted(f, { author: 2 });
    assert.deepEqual(f.run().reviewRounds.slice(0, 9), saved.reviews, "completed history and cumulative budget are not reset");
    assert.deepEqual(f.run().fullEvaluationHistory, saved.history);
    for (const row of saved.rows) assert.deepEqual(f.store.get().evaluationRuns.find((item) => item.id === row.id), row);
    assert.equal(await fs.readFile(join(f.worktree, "base.txt"), "utf8"), "resolved pinned conflict\n");
    f.pass();
  });
});

test("a second base advance never rebinds an admitted refresh target", async (t) => {
  const f = await fixture(t);
  const original = f.git.prepareLeafMerge.bind(f.git);
  let newer;
  f.git.prepareLeafMerge = async (...args) => {
    await original(...args);
    if (!newer) {
      await fs.writeFile(join(f.root, "later-upstream.txt"), "newer base, outside admitted refresh\n");
      newer = await f.git.commit(f.root, "second base advance");
      await f.git.push(f.root, "origin", "main");
    }
  };
  await assert.rejects(f.orchestrator.refreshAgentBaseAndRetry("agent"), /base has moved/);
  assert.equal(f.run().baseCommit, f.target);
  assert.equal(f.run().continuation.step, "evidence");
  const merge = (await fixtureGit(f.worktree, "rev-list", "--merges", `${f.stamped}..HEAD`)).trim();
  assert.equal((await fixtureGit(f.worktree, "rev-list", "--parents", "-n", "1", merge)).split(" ")[2], f.target);
  assert.equal(f.counts.evidence + f.counts.review + f.counts.evaluation, 0);
  assert.equal(f.orchestrator.agentClaims.size, 0);
  await f.store.update((state) => state.evaluationRuns.push({ ...state.evaluationRuns[1], id: "baseline-newer", commit: newer, createdAt: "2026-09-03T00:00:00.000Z" }));
  await f.restart();
  f.target = newer;
  await f.orchestrator.refreshAgentBaseAndRetry("agent");
  await assertCompleted(f, { merges: 2, commits: 4 });
  f.pass();
});

test("public refresh preserves foreign files or a third remote head after a saved publication cut", async (t) => {
  for (const drift of ["staged", "unstaged", "untracked", "remote"]) await t.test(drift, async (t) => {
    const f = await fixture(t, { closed: false });
    f.remote.wasOpen = true;
    const push = f.git.pushLeaf.bind(f.git);
    let interrupted = false;
    f.git.pushLeaf = async (...args) => { if (!interrupted) { interrupted = true; throw new Error("Injected refresh before publication"); } return push(...args); };
    await assert.rejects(f.orchestrator.refreshAgentBaseAndRetry("agent"), /Injected refresh/);
    assert.equal(f.run().continuation.phase, "push");
    let file;
    if (drift === "remote") {
      const foreign = await fixtureGit(f.worktree, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit-tree", await f.git.tree(f.stamped), "-p", f.stamped, "-m", "foreign remote owner");
      await fixtureGit(f.worktree, "push", "origin", `${foreign}:refs/heads/foreign-object`);
      await fixtureGit(f.root, "--git-dir", join(f.root, ".burner", "fixture-remote.git"), "update-ref", `refs/heads/${branch}`, foreign);
    } else {
      file = join(f.worktree, drift === "untracked" ? "foreign.txt" : "base.txt");
      await fs.writeFile(file, "Preserve this foreign edit\n");
      if (drift === "staged") await fixtureGit(f.worktree, "add", "base.txt");
    }
    const before = { head: await f.git.head(f.worktree), index: await fixtureGit(f.worktree, "write-tree"),
      status: await fixtureGit(f.worktree, "status", "--porcelain=v1", "--untracked-files=all"), remote: await f.git.remoteBranchHead(f.root, "origin", branch), pushes: (await f.effects("push")).length };
    await f.restart();
    await assert.rejects(f.orchestrator.retryAgent("agent"), /changed|saved remote lease/);
    assert.equal(await f.git.head(f.worktree), before.head);
    assert.equal(await fixtureGit(f.worktree, "write-tree"), before.index);
    assert.equal(await fixtureGit(f.worktree, "status", "--porcelain=v1", "--untracked-files=all"), before.status);
    assert.equal(await f.git.remoteBranchHead(f.root, "origin", branch), before.remote);
    assert.equal((await f.effects("push")).length, before.pushes);
    assert.equal(f.counts.author + f.counts.evidence + f.counts.review + f.counts.evaluation, 0);
    if (file) assert.equal(await fs.readFile(file, "utf8"), "Preserve this foreign edit\n");
    assert.equal(f.orchestrator.agentClaims.size, 0);
    f.pass();
  });
});

test("public conflicted refresh refuses an unreturned foreign resolution without replaying merge or author", async (t) => {
  const f = await fixture(t, { conflict: true });
  const prepare = f.git.prepareLeafMerge.bind(f.git);
  let interrupted = false;
  f.git.prepareLeafMerge = async (...args) => { await prepare(...args); if (!interrupted) { interrupted = true; throw new Error("Injected refresh after conflict preparation"); } };
  await assert.rejects(f.orchestrator.refreshAgentBaseAndRetry("agent"), /Injected refresh/);
  await fs.writeFile(join(f.worktree, "base.txt"), "Foreign partial resolution must survive\n");
  const index = await fixtureGit(f.worktree, "ls-files", "--stage", "-z");
  const mergeCount = (await f.effects("merge")).length;
  await f.restart();
  await assert.rejects(f.orchestrator.retryAgent("agent"), /left untouched|conflict/i);
  assert.equal(await fs.readFile(join(f.worktree, "base.txt"), "utf8"), "Foreign partial resolution must survive\n");
  assert.equal(await fixtureGit(f.worktree, "ls-files", "--stage", "-z"), index);
  assert.equal((await f.effects("merge")).length, mergeCount);
  assert.equal(f.counts.author + f.counts.evidence + f.counts.review + f.counts.evaluation, 0);
  f.pass();
});

test("an admitted refresh drains its receipts after a live budget reduction without new model work", async (t) => {
  const f = await fixture(t);
  const prepare = f.git.prepareLeafMerge.bind(f.git);
  f.git.prepareLeafMerge = async (...args) => {
    await prepare(...args);
    await f.store.update((state) => { state.settings.maxReviewRounds = 9; });
  };
  await assert.rejects(f.orchestrator.refreshAgentBaseAndRetry("agent"), /no review budget remains/);
  assert.equal(f.run().baseCommit, f.target);
  assert.equal(f.run().continuation.step, "evidence");
  assert.equal(f.run().reviewRounds.length, 9);
  assert.equal((await f.effects("merge")).length, 1);
  assert.equal((await f.effects("commit")).length, 2);
  assert.equal((await f.effects("push")).length, 1);
  assert.equal(f.counts.author + f.counts.evidence + f.counts.review + f.counts.evaluation, 0);
  assert.equal(f.orchestrator.agentClaims.size, 0);
  assert.ok(f.run().leafPr.terminal || f.run().leafPr.pending?.owner.kind === "terminal-close" || f.run().leafPr.known.fields.state === "CLOSED",
    "the exhausted refresh reached a known terminal owner before retry");
  assert.equal(canRetryAgent(f.run()), false);
  const saved = structuredClone({ run: f.run(), rows: f.store.get().evaluationRuns, counts: f.counts });
  await f.restart();
  await assert.rejects(f.orchestrator.retryAgent("agent"));
  assert.deepEqual(f.run(), saved.run, "terminal retry cannot rewrite retained review, refresh, or full history");
  assert.deepEqual(f.store.get().evaluationRuns, saved.rows);
  assert.deepEqual(f.counts, saved.counts, "terminal retry performs no additional author/review/evaluation work");
  assert.equal(canRetryAgent(f.run()), false);
  assert.equal((await f.effects("commit")).length, 2);
  assert.equal((await f.effects("push")).length, 1);
  f.pass();
});

test("public base refresh preserves known terminal and unknown externally closed leaves", async (t) => {
  for (const known of [true, false]) await t.test(known ? "known terminal" : "external closure", async (t) => {
    const f = await fixture(t, { closed: known });
    if (!known) f.remote.state = "CLOSED";
    const before = structuredClone(f.run());
    const head = await f.git.head(f.worktree);
    const remote = await f.git.remoteBranchHead(f.root, "origin", branch);
    await assert.rejects(f.orchestrator.refreshAgentBaseAndRetry("agent"), /closed|terminal|lifecycle/i);
    assert.deepEqual(f.run(), before);
    assert.equal(await f.git.head(f.worktree), head);
    assert.equal(await f.git.remoteBranchHead(f.root, "origin", branch), remote);
    assert.equal((await f.effects("merge")).length, 0);
    assert.equal((await f.effects("commit")).length, 0);
    assert.equal((await f.effects("push")).length, 0);
    assert.deepEqual(f.counts, { author: 0, evidence: 0, review: 0, evaluation: 0, reopen: 0, edit: 0 });
    assert.equal(f.orchestrator.agentClaims.size, 0);
    assert.deepEqual(await f.orchestrator.locks.list(), []);
    f.pass();
  });
});
