import assert from "node:assert/strict";
import childProcess from "node:child_process";
import promises, { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventHub } from "../dist/lib/events.js";
import { GitService, TransientMergeGateError } from "../dist/lib/git.js";
import { fullMergeValidationFingerprint, latestFullAssessment, fullAssessmentForIdentity, Orchestrator } from "../dist/lib/orchestrator.js";
import { runCommand } from "../dist/lib/process.js";
import { StateStore } from "../dist/lib/store.js";
import { fixtureLeafPr, installLeafPrFixtureTransport } from "./leaf-pr-test-helpers.js";

const timestamp = "2026-09-01T00:00:00.000Z";
const branch = "burner/public-progress";
const managedPaths = ["README.md", "docs/burner-evaluation-history.json", "docs/burner-evaluation-progress.svg"];

async function gitCommand(cwd, ...args) {
  const result = await runCommand("git", args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function bindOrchestrator(f) {
  const orchestrator = new Orchestrator(f.root, f.store, new EventHub());
  f.orchestrator = orchestrator;
  f.git = orchestrator.git;
  f.run = () => f.store.get().agentRuns.find((run) => run.id === "agent");
  orchestrator.codex = {
    close: () => undefined,
    preflight: async () => undefined,
    evaluate: async (cwd, evaluation, _settings, context) => {
      assert.equal(f.sealed, false, "progress recovery must not invoke another evaluator");
      assert.equal(await f.git.head(cwd), f.reviewed);
      assert.equal(evaluation.id, "quality");
      assert.equal(context, "composite");
      f.calls.samples += 1;
      return { score: 72, summary: `Independent full sample ${f.calls.samples}`, evidence: ["fixture evidence"], suggestions: [] };
    },
    implement: async () => assert.fail("unexpected model implementation"),
    revise: async () => assert.fail("unexpected model revision"),
    refreshAgentEvidence: async () => assert.fail("unexpected model evidence refresh"),
    review: async () => assert.fail("unexpected model review"),
    planIdeas: async () => assert.fail("unexpected campaign planning"),
  };
  const exactNumber = (number) => assert.equal(number, 42, "only the fixture PR is in scope");
  f.git.getPullRequest = async (_cwd, number) => {
    exactNumber(number);
    return { number, state: f.world.state, headRefName: branch, headRefOid: await f.git.remoteBranchHead(f.root, "origin", branch),
      url: "https://example.test/pr/42", title: f.world.title, body: f.world.body, isDraft: f.world.isDraft,
      statusCheckRollup: f.world.checkFailure ? [{ name: "fixture-check", status: "COMPLETED", conclusion: "FAILURE" }] : [] };
  };
  f.git.editPr = async (_cwd, number, title, body) => { exactNumber(number); f.world.title = title; f.world.body = body; f.calls.edits += 1; };
  f.git.markPrReady = async (_cwd, number) => { exactNumber(number); f.world.isDraft = false; };
  f.git.markPrDraft = async (_cwd, number) => { exactNumber(number); f.world.isDraft = true; };
  f.git.reopenPr = async (_cwd, number) => { exactNumber(number); f.world.state = "OPEN"; f.calls.reopens += 1; };
  f.git.closePr = async (_cwd, number) => { exactNumber(number); f.world.state = "CLOSED"; f.calls.closes += 1; };
  f.git.mergePr = async (_cwd, number, head) => {
    exactNumber(number);
    assert.equal(head, await f.git.remoteBranchHead(f.root, "origin", branch));
    f.calls.mergeHeads.push(head);
    if (f.world.checkFailure) throw new Error(`PR #42 required check failed at ${head.slice(0, 8)}: fixture-check.`);
    // A public merge is authorized to reach this external boundary. Stop at a
    // transient transport failure so no remote campaign or base sync can run.
    throw new TransientMergeGateError("Fixture merge transport stop");
  };
  for (const method of ["openPr", "listPullRequests", "pullRequestsForBranch", "markPrDisposition", "markPrQuarantined"]) {
    f.git[method] = async () => assert.fail(`unexpected external PR effect: ${method}`);
  }
  installLeafPrFixtureTransport(f.git, {
    observe: (...args) => f.git.getPullRequest(...args),
    edit: (cwd, number, field, value) => f.git.editPr(cwd, number,
      field === "title" ? value : f.world.title, field === "body" ? value : f.world.body),
    draft: (cwd, number, value) => value ? f.git.markPrDraft(cwd, number) : f.git.markPrReady(cwd, number),
    close: (...args) => f.git.closePr(...args),
    merge: (...args) => f.git.mergePr(...args),
  });
  orchestrator.tick = async () => assert.fail("progress retry must not tick a campaign");
  orchestrator.scheduleComposites = async () => assert.fail("progress retry must not dispatch unrelated composites");
}

async function fixture(t, { leafQualificationPolicy } = {}) {
  const root = await mkdtemp(join(tmpdir(), "burner-public-progress-"));
  const f = { root, sealed: false, retain: false, originalTrace: process.env.GIT_TRACE2_EVENT,
    calls: { samples: 0, edits: 0, reopens: 0, closes: 0, mergeHeads: [] },
    world: { state: "OPEN", title: "Candidate", body: "", isDraft: true, checkFailure: false } };
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) => {
    assert.equal(command, "git", "no model, GitHub, or other external executable may fall through the fixture fakes");
    return spawn(command, args, options);
  };
  syncBuiltinESMExports();
  t.after(async () => {
    childProcess.spawn = spawn;
    syncBuiltinESMExports();
    if (f.originalTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = f.originalTrace;
    if (f.retain) t.diagnostic(`Retained failed isolated fixture: ${root}`);
    else await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  await gitCommand(root, "init", "-b", "main");
  await gitCommand(root, "config", "maintenance.auto", "false");
  await gitCommand(root, "config", "gc.auto", "0");
  await writeFile(join(root, ".gitignore"), ".burner/\ntarget/\n");
  await writeFile(join(root, "README.md"), "# Authored documentation  \n\n");
  await writeFile(join(root, "code.txt"), "base implementation\n");
  const git = new GitService(root, join(root, ".burner"));
  f.base = await git.commit(root, "fixture base");
  f.worktree = await git.createWorktree("agent", branch, f.base);
  await writeFile(join(f.worktree, "code.txt"), "reviewed implementation\n");
  f.reviewed = await git.commit(f.worktree, "fixture reviewed candidate");
  f.remote = join(root, ".burner", "remote.git");
  await gitCommand(root, "init", "--bare", f.remote);
  await gitCommand(root, "remote", "add", "origin", f.remote);
  await git.push(root, "origin", "main");
  await git.push(f.worktree, "origin", branch);
  await git.removeWorktree(f.worktree);
  f.store = new StateStore(root);
  await f.store.init();
  await f.store.update((state) => {
    Object.assign(state.settings, { autoRun: true, autoCreatePrs: true, defaultResources: [], maxReviewRounds: 12, parallelism: 3 });
    state.orchestrator.enabled = false;
    state.evaluations = [{ id: "quality", name: "Quality", prompt: "Evaluate the exact candidate", definitionVersion: "v1", weight: 1, enabled: true, createdAt: timestamp }];
    state.evaluationRuns = [{ id: "baseline", evaluationId: "quality", evaluationDefinitionVersion: "v1", commit: f.base,
      context: "baseline", status: "completed", score: 70, promptSampleCount: 3, summary: "Confirmed baseline", evidence: [], suggestions: [], durationMs: 1, createdAt: timestamp }];
    state.ideas = [
      { id: "idea", agentRunId: "agent", title: "Candidate", description: "Reviewed candidate", rationale: "Recovery fixture", predictedImpact: 2, evaluationIds: ["quality"], resources: [], status: "completed", source: "manual", createdAt: timestamp, updatedAt: timestamp },
      { id: "unrelated", title: "Unrelated queued work", description: "Do not dispatch", rationale: "Scope sentinel", predictedImpact: 100, evaluationIds: ["quality"], resources: [], status: "queued", source: "manual", createdAt: timestamp, updatedAt: timestamp },
    ];
    const fingerprint = fullMergeValidationFingerprint(state);
    state.agentRuns = [{ id: "agent", ideaId: "idea", branch, worktree: f.worktree, status: "completed", startedAt: timestamp, completedAt: timestamp,
      baseRef: "main", baseCommit: f.base, authorThreadId: "original-author", authoringComplete: true, lastMessage: "Reviewed implementation", resources: [],
      ...(leafQualificationPolicy ? { leafQualificationPolicy } : {}),
      prNumber: 42, prUrl: "https://example.test/pr/42", prState: "open", deltas: [], reviewApproved: true,
      reviewRounds: [{ id: "approval", round: 1, commit: f.reviewed, approved: true, findings: [], summary: "Approved", createdAt: timestamp,
        completedAt: timestamp, baseCommit: f.base, evaluationFingerprint: fingerprint }],
      continuation: { id: "delivered", head: f.reviewed, step: "done", outcome: "completed", completedAt: timestamp,
        identity: { baseRef: "main", baseCommit: f.base, branch, evaluationFingerprint: fingerprint, remote: "origin", baseBranch: "main",
          pullRequest: { number: 42, head: f.reviewed, url: "https://example.test/pr/42" } } },
    }];
    state.agentRuns[0].leafPr = fixtureLeafPr(state.agentRuns[0], { title: f.world.title, body: f.world.body, isDraft: f.world.isDraft, state: "OPEN" });
  });
  bindOrchestrator(f);
  assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", f.base), true, "fixture qualification uses the actual receipt-aware runner");
  assert.equal(f.calls.samples, 3);
  f.sealed = true;
  f.full = structuredClone(latestFullAssessment(f.run()));
  assert.equal(f.full.qualified, true);
  assert.equal(f.full.candidateCommit, f.reviewed);
  assert.equal(f.full.evaluation.identity.candidateCommit, f.reviewed);
  assert.equal(f.full.evaluation.candidateTree, await f.git.tree(f.reviewed));
  assert.equal(f.full.evaluation.purpose, "full");
  assert.ok(f.full.evaluation.result.completedAt, "the actual runner saved a completed receipt, not just aggregate scores");
  assert.equal(f.full.evaluation.evaluations[0].candidate.length, 3);
  f.rows = structuredClone(f.store.get().evaluationRuns);
  f.rounds = structuredClone(f.run().reviewRounds);
  f.trace = join(root, ".burner", "progress-git-effects.jsonl");
  process.env.GIT_TRACE2_EVENT = f.trace;
  f.effects = async (command) => (await readFile(f.trace, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; }))
    .split("\n").filter(Boolean).map(JSON.parse).filter((entry) => entry.event === "start" && entry.argv?.includes(command));
  f.restart = async () => {
    await f.orchestrator.close();
    f.store = new StateStore(root);
    await f.store.init();
    bindOrchestrator(f);
  };
  return f;
}

async function withFixture(t, action, options) {
  const f = await fixture(t, options);
  try { await action(f); }
  catch (error) { f.retain = true; throw error; }
}

async function assertStamped(f) {
  const run = f.run();
  assert.equal(run.continuation.step, "done");
  assert.equal(run.continuation.completedAt, timestamp);
  assert.equal(run.completedAt, timestamp);
  assert.equal(run.authorThreadId, "original-author");
  assert.equal(run.branch, branch);
  assert.equal(run.prNumber, 42);
  assert.deepEqual(run.reviewRounds, f.rounds);
  assert.deepEqual(latestFullAssessment(run), f.full);
  assert.deepEqual(f.store.get().evaluationRuns, f.rows);
  assert.equal(f.calls.samples, 3);
  assert.equal(f.store.get().ideas.find((idea) => idea.id === "unrelated").status, "queued");
  assert.equal(f.store.get().settings.autoRun, true);
  assert.equal(f.store.get().orchestrator.enabled, false);
  const certificate = run.generatedProgress;
  assert.equal(certificate.inputCommit, f.reviewed);
  assert.notEqual(certificate.outputCommit, f.reviewed);
  assert.equal(certificate.outputCommit, run.continuation.head);
  assert.equal(certificate.outputCommit, run.continuation.identity.pullRequest.head);
  assert.equal(await f.git.remoteBranchHead(f.root, "origin", branch), certificate.outputCommit);
  await f.git.verifyGeneratedProgress(certificate);
  for (const file of certificate.plan.files) assert.equal(await readFile(join(f.worktree, file.path), "utf8"), file.text);
  assert.equal((await f.effects("commit")).length, 1, "the generated stamp has exactly one actual Git commit effect");
  assert.equal((await f.effects("push")).length, 1, "already-published receipt heads skip their network effect");
  return certificate;
}

function interruptProgress(f, cut) {
  const failure = () => { throw new Error(`Injected progress cut: ${cut}`); };
  if (cut.startsWith("file-")) {
    const limit = Number(cut.slice(5));
    const rename = promises.rename;
    let completed = 0;
    promises.rename = async (from, to) => {
      const result = await rename(from, to);
      if (managedPaths.some((path) => join(f.worktree, path) === String(to)) && ++completed === limit) failure();
      return result;
    };
    syncBuiltinESMExports();
    return () => { promises.rename = rename; syncBuiltinESMExports(); };
  }
  if (cut === "prepared-tree") {
    const update = f.store.update.bind(f.store);
    f.store.update = (mutate) => update((state) => {
      mutate(state);
      if (state.agentRuns[0].continuation?.phase === "commit") failure();
    });
    return () => { f.store.update = update; };
  }
  const method = cut === "plan" ? "applyLeafManagedFiles" : cut === "commit" ? "finalizeLeafCommit" : "pushLeaf";
  const original = f.git[method].bind(f.git);
  f.git[method] = async (...args) => {
    if (cut === "plan" || cut === "before-push") failure();
    await original(...args);
    failure();
  };
  return () => { f.git[method] = original; };
}

test("public progress recovery consumes every durable file/commit/push cut without merging on retry", async (t) => {
  for (const cut of ["plan", "file-1", "file-2", "file-3", "prepared-tree", "commit", "push"]) await t.test(cut, async (t) => withFixture(t, async (f) => {
    const restore = interruptProgress(f, cut);
    try { await assert.rejects(f.orchestrator.mergeAgent("agent"), /Injected progress cut/); }
    finally { restore(); }
    assert.equal(f.run().continuation.step, "progress");
    const plan = structuredClone(f.run().continuation.plan);
    const completed = new Map();
    for (const file of plan.files) {
      const contents = await readFile(join(f.worktree, file.path), "utf8").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (contents === file.text) completed.set(file.path, (await lstat(join(f.worktree, file.path))).ino);
    }
    assert.equal(f.calls.mergeHeads.length, 0);
    await f.restart();
    const resumed = await f.orchestrator.retryAgent("agent");
    assert.equal(resumed.status, "completed");
    const certificate = await assertStamped(f);
    assert.deepEqual(certificate.plan, plan, "recovery does not recompute timestamps or managed output text");
    for (const [path, inode] of completed) assert.equal((await lstat(join(f.worktree, path))).ino, inode, "completed managed bytes are not rewritten");
    assert.equal(f.calls.mergeHeads.length, 0, "retry can drain progress but cannot merge");
    assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", f.base), true);
    assert.equal(f.calls.samples, 3, "the verified exact S inherits the completed R assessment without resampling");
    await assert.rejects(f.orchestrator.mergeAgent("agent"), /Fixture merge transport stop/);
    assert.deepEqual(f.calls.mergeHeads, [certificate.outputCommit]);
    await assertStamped(f);
  }));
});

test("progress completion persisted before acknowledgement is recognized without replaying durable effects", async (t) => withFixture(t, async (f) => {
  const update = f.store.update.bind(f.store);
  let interrupted = false;
  f.store.update = async (mutate) => {
    await update(mutate);
    if (!interrupted && f.run().generatedProgress && f.run().continuation.step === "done") {
      interrupted = true;
      throw new Error("Lost progress completion acknowledgement after state rename");
    }
  };
  await assert.rejects(f.orchestrator.mergeAgent("agent"), /Fixture merge transport stop/);
  f.store.update = update;
  assert.equal(interrupted, true);
  const certificate = await assertStamped(f);
  assert.deepEqual(f.calls.mergeHeads, [certificate.outputCommit], "the original explicit request alone reached the merge boundary");
  await f.restart();
  await assert.rejects(f.orchestrator.retryAgent("agent"), /Only a failed run/);
  assert.equal(f.calls.mergeHeads.length, 1);
  await assertStamped(f);
}));

test("public progress resume preserves foreign checkout and remote drift without sampling or publishing", async (t) => {
  for (const drift of ["dirty-file", "foreign-head", "remote-head"]) await t.test(drift, async (t) => withFixture(t, async (f) => {
    const restore = interruptProgress(f, drift === "remote-head" ? "before-push" : "plan");
    try { await assert.rejects(f.orchestrator.mergeAgent("agent"), /Injected progress cut/); }
    finally { restore(); }
    if (drift === "dirty-file") await writeFile(join(f.worktree, "code.txt"), "foreign edits must survive\n");
    else if (drift === "foreign-head") await gitCommand(f.worktree, "-c", "user.name=Foreign", "-c", "user.email=foreign@localhost", "commit", "--allow-empty", "-m", "foreign empty commit");
    else await gitCommand(f.root, "--git-dir", f.remote, "update-ref", `refs/heads/${branch}`, f.base);
    const head = await f.git.head(f.worktree);
    const remote = await f.git.remoteBranchHead(f.root, "origin", branch);
    const code = await readFile(join(f.worktree, "code.txt"), "utf8");
    const cursor = structuredClone(f.run().continuation);
    const pushes = (await f.effects("push")).length;
    await f.restart();
    await assert.rejects(f.orchestrator.retryAgent("agent"), /left untouched|saved input head|saved remote lease|identity or complete fields/);
    assert.equal(await f.git.head(f.worktree), head);
    assert.equal(await f.git.remoteBranchHead(f.root, "origin", branch), remote);
    assert.equal(await readFile(join(f.worktree, "code.txt"), "utf8"), code);
    assert.deepEqual(f.run().continuation, cursor);
    assert.deepEqual(f.store.get().evaluationRuns, f.rows);
    assert.equal(f.calls.mergeHeads.length, 0);
    assert.equal((await f.effects("push")).length, pushes);
  }));
});

test("a post-stamp required-check failure is recorded against S and repairs from its inherited managed bytes", async (t) => withFixture(t, async (f) => {
  f.world.checkFailure = true;
  await assert.rejects(f.orchestrator.mergeAgent("agent"), /required checks? failed/);
  const failed = f.run();
  const certificate = failed.generatedProgress;
  assert.equal(failed.status, "failed");
  assert.equal(failed.prState, "open");
  assert.equal(failed.leafPr.known.fields.isDraft, true);
  assert.equal(failed.continuation.head, certificate.outputCommit);
  assert.match(failed.error, new RegExp(certificate.outputCommit.slice(0, 8)));
  assert.deepEqual(latestFullAssessment(failed), f.full);
  assert.deepEqual(failed.reviewRounds, f.rounds);
  assert.deepEqual(f.calls.mergeHeads, []);
  assert.equal(f.calls.closes, 0);
  let authors = 0;
  f.orchestrator.codex.revise = async (cwd, thread, feedback) => {
    authors += 1;
    assert.equal(thread, "original-author");
    assert.equal(await f.git.head(cwd), certificate.outputCommit);
    assert.match(feedback.summary, /required-check/);
    for (const file of certificate.plan.files) assert.equal(await readFile(join(cwd, file.path), "utf8"), file.text);
    await writeFile(join(cwd, "code.txt"), "author repaired the required check\n");
    return { threadId: thread, message: "Repaired without changing Burner-managed bytes" };
  };
  f.orchestrator.codex.refreshAgentEvidence = async () => { throw new Error("Fixture stops before new review or evaluation"); };
  const repaired = await f.orchestrator.retryAgent("agent");
  assert.equal(authors, 1);
  assert.equal(repaired.reviewApproved, false, "new authored implementation does not inherit R approval");
  assert.deepEqual(latestFullAssessment(repaired), f.full);
  assert.deepEqual(f.store.get().evaluationRuns, f.rows);
  assert.equal(f.calls.samples, 3);
  assert.equal(f.calls.mergeHeads.length, 0);
  assert.equal(f.calls.reopens, 0);
  const authored = await f.git.head(f.worktree);
  assert.notEqual(authored, certificate.outputCommit);
  assert.equal(await gitCommand(f.worktree, "rev-parse", `${authored}^`), certificate.outputCommit);
  for (const file of certificate.plan.files) assert.equal(await readFile(join(f.worktree, file.path), "utf8"), file.text);
}));

test("ordinary public deliveries retain multiple stamps without intervening full samples and still reject restored historical A", async (t) => withFixture(t, async (f) => {
  assert.equal(f.run().leafQualificationPolicy, "ordinary", "the explicit initial full call must preserve the known ordinary origin");
  const originalTree = await f.git.tree(f.reviewed);
  const initialHistory = structuredClone(f.run().fullEvaluationHistory);
  const calls = { authors: 0, evidence: 0, reviews: 0, full: 3, delivery: 0 };
  let nextAuthor;
  let scoring;
  const installModels = () => {
    f.orchestrator.codex.revise = async (cwd, thread) => {
      assert.equal(thread, "original-author");
      assert.equal(f.run().continuation.step, "author");
      assert.equal(await f.git.head(cwd), f.run().continuation.head);
      assert.ok(nextAuthor, "no unrequested author call may fall through");
      const change = nextAuthor;
      nextAuthor = undefined;
      calls.authors += 1;
      await change(cwd);
      return { threadId: thread, message: `Authored revision ${calls.authors}` };
    };
    f.orchestrator.codex.refreshAgentEvidence = async (cwd, base, _title, thread, head) => {
      assert.equal(base, "main");
      assert.equal(thread, "original-author");
      assert.equal(await f.git.head(cwd), head);
      calls.evidence += 1;
      return { threadId: thread, message: `Committed fixture evidence at ${head}` };
    };
    f.orchestrator.codex.review = async (cwd, base) => {
      assert.equal(base, "main");
      assert.equal(await f.git.head(cwd), f.run().continuation.head);
      calls.reviews += 1;
      return { approved: true, summary: "Independent fixture approval", findings: [] };
    };
    f.orchestrator.codex.evaluate = async (cwd, evaluation, _settings, context) => {
      assert.ok(scoring, "manual merge and refused recovery must not invoke an evaluator");
      const run = f.run();
      const receipt = run.fullEvaluation?.step === "sampling" ? run.fullEvaluation.evaluation : run.continuation.evaluation;
      assert.equal(receipt.purpose, scoring.purpose);
      assert.equal(receipt.identity.candidateCommit, await f.git.head(cwd));
      assert.equal(receipt.identity.baseCommit, f.base);
      assert.equal(evaluation.id, "quality");
      assert.ok(context === "composite" || receipt.purpose === "delivery" && context === "agent");
      assert.equal(run.leafQualificationPolicy, "ordinary");
      f.calls.samples += 1;
      calls[receipt.purpose] += 1;
      return { score: scoring.score, summary: `${receipt.purpose} sample ${f.calls.samples}`, evidence: ["fixture evidence"], suggestions: [] };
    };
  };
  installModels();
  const retryDelivery = async (change, score) => {
    const history = structuredClone(f.run().fullEvaluationHistory);
    const samples = f.calls.samples;
    const merges = f.calls.mergeHeads.length;
    scoring = { purpose: "delivery", score };
    nextAuthor = change;
    const delivered = await f.orchestrator.retryAgent("agent");
    scoring = undefined;
    assert.equal(nextAuthor, undefined);
    assert.equal(delivered.status, "completed", delivered.error);
    assert.equal(delivered.leafQualificationPolicy, "ordinary");
    assert.equal(delivered.continuation.step, "done");
    assert.equal(delivered.continuation.evaluation.purpose, "delivery");
    assert.equal(delivered.continuation.evaluation.evaluations[0].candidate.length, 3);
    assert.ok(delivered.continuation.evaluation.result.completedAt);
    assert.equal(delivered.reviewRounds.at(-1).commit, delivered.continuation.head);
    assert.equal(delivered.continuation.evaluation.identity.candidateCommit, delivered.continuation.head);
    assert.equal(f.calls.samples - samples, 3);
    assert.equal(f.calls.mergeHeads.length, merges, "retry is delivery authority, never merge authority");
    assert.deepEqual(delivered.fullEvaluationHistory, history, "ordinary delivery does not supersede a full assessment");
    return delivered.continuation.head;
  };
  const stamp = async () => {
    const input = await f.git.resolveRef(branch);
    const history = structuredClone(f.run().fullEvaluationHistory);
    const samples = f.calls.samples;
    f.world.checkFailure = true;
    await assert.rejects(f.orchestrator.mergeAgent("agent"), /required checks? failed/);
    const certificate = structuredClone(f.run().generatedProgress);
    assert.equal(f.run().status, "failed");
    assert.equal(certificate.baseCommit, f.base);
    assert.equal(certificate.inputCommit, input);
    assert.notEqual(certificate.outputCommit, input);
    assert.equal(f.calls.mergeHeads.length, 0, "failed exact-head checks stop before a merge request");
    assert.equal(await f.git.remoteBranchHead(f.root, "origin", branch), certificate.outputCommit);
    assert.equal(f.calls.samples, samples, "an explicit merge consumes recorded evidence without sampling");
    assert.deepEqual(f.run().fullEvaluationHistory, history);
    await f.git.verifyGeneratedProgress(certificate);
    return certificate;
  };
  const full = async (score, qualified) => {
    const samples = f.calls.samples;
    f.world.checkFailure = false;
    scoring = { purpose: "full", score };
    assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", f.base), qualified);
    scoring = undefined;
    assert.equal(f.calls.samples - samples, 3);
    assert.equal(f.run().leafQualificationPolicy, "ordinary");
    return structuredClone(f.run().fullEvaluationHistory.at(-1));
  };
  const proofOutputs = (roots) => {
    const pending = [...roots];
    const outputs = [];
    while (pending.length) {
      const certificate = pending.pop();
      outputs.push(certificate.outputCommit);
      pending.push(...certificate.previous ?? []);
    }
    return outputs;
  };

  const first = await stamp();
  await retryDelivery((cwd) => writeFile(join(cwd, "code.txt"), "implementation B\n"), 73);
  const second = await stamp();
  assert.deepEqual(second.previous, [first]);
  assert.deepEqual(f.run().fullEvaluationHistory, initialHistory);
  assert.equal(calls.full, 3, "two generated stamps did not impose separate full sampling on ordinary delivery");
  await f.restart();
  installModels();
  const restoredA = await retryDelivery((cwd) => writeFile(join(cwd, "code.txt"), "reviewed implementation\n"), 74);
  assert.deepEqual(f.run().fullEvaluationHistory, initialHistory);
  const rejected = await full(69, false);
  assert.equal(rejected.kind, "assessment");
  assert.equal(rejected.assessment.candidateCommit, restoredA);
  assert.notEqual(rejected.assessment.candidateTree, originalTree, "generated files still differ in the raw restored-A tree");
  assert.equal(rejected.comparison.tree, originalTree, "both prior stamps reverse to exactly the original implementation A");
  assert.deepEqual(rejected.comparison.progress, [second]);
  assert.deepEqual(proofOutputs(rejected.comparison.progress), [second.outputCommit, first.outputCommit]);
  const rejectedHistory = structuredClone(f.run().fullEvaluationHistory);
  const samplesBeforeRefusal = f.calls.samples;
  assert.equal(await f.orchestrator.fullyValidateLeafForMerge("agent", f.base), false);
  assert.equal(f.calls.samples, samplesBeforeRefusal);
  assert.deepEqual(f.run().fullEvaluationHistory, rejectedHistory);

  const note = "\nAuthored C documentation.\n";
  const documentedC = await retryDelivery(async (cwd) => {
    assert.equal(await readFile(join(cwd, "code.txt"), "utf8"), "reviewed implementation\n");
    await writeFile(join(cwd, "README.md"), await readFile(join(cwd, "README.md"), "utf8") + note);
    await mkdir(join(cwd, "docs"), { recursive: true });
    await writeFile(join(cwd, "docs/usage.md"), "Ordinary authored documentation remains part of implementation identity.\n");
  }, 75);
  assert.equal(latestFullAssessment(f.run()).qualified, false, "a changed delivery cannot clear the saved full rejection");
  await assert.rejects(f.orchestrator.mergeAgent("agent"), /full.*(?:reject|qualif)|(?:reject|qualif).*full/i);
  assert.equal(f.calls.mergeHeads.length, 0);
  const positive = await full(75, true);
  assert.equal(positive.assessment.candidateCommit, documentedC);
  assert.notEqual(positive.comparison.tree, originalTree, "authored README and ordinary doc bytes are not normalized away");
  assert.equal(await gitCommand(f.root, "show", `${positive.comparison.tree}:code.txt`), "reviewed implementation");
  assert.match(await gitCommand(f.root, "show", `${positive.comparison.tree}:README.md`), /Authored C documentation/);
  assert.match(await gitCommand(f.root, "show", `${positive.comparison.tree}:docs/usage.md`), /Ordinary authored documentation/);
  const third = await stamp();
  await retryDelivery((cwd) => writeFile(join(cwd, "code.txt"), "implementation D\n"), 76);
  const fourth = await stamp();
  assert.deepEqual(fourth.previous, [third], "history's retained S2 root is embedded by S3 and must not be recursively copied again");
  assert.deepEqual(proofOutputs([fourth]), [fourth.outputCommit, third.outputCommit, second.outputCommit, first.outputCommit]);
  assert.deepEqual(third.previous, [second]);
  assert.equal(f.run().fullEvaluationHistory.length, 3);
  assert.deepEqual(f.run().fullEvaluationHistory[0], initialHistory[0]);
  assert.deepEqual(f.run().fullEvaluationHistory[1], rejected);

  const historyBeforeRestore = structuredClone(f.run().fullEvaluationHistory);
  const beforeRestore = { ...calls };
  nextAuthor = async (cwd) => {
    await writeFile(join(cwd, "code.txt"), "reviewed implementation\n");
    const readme = await readFile(join(cwd, "README.md"), "utf8");
    assert.ok(readme.endsWith(note));
    await writeFile(join(cwd, "README.md"), readme.slice(0, -note.length));
    await rm(join(cwd, "docs/usage.md"));
  };
  const refused = await f.orchestrator.retryAgent("agent");
  assert.equal(refused.status, "failed");
  assert.match(refused.error, /rejected tree unchanged.*no new review or evaluation samples/i);
  assert.equal(refused.continuation.step, "evidence");
  assert.deepEqual(calls, { ...beforeRestore, authors: beforeRestore.authors + 1 }, "restored historical A stops before evidence, review, or evaluation");
  assert.deepEqual(refused.fullEvaluationHistory, historyBeforeRestore);
  assert.equal(latestFullAssessment(refused).qualified, true, "historical rejection wins even when the latest assessment approved C");
  assert.equal(await f.git.normalizeLeafProgressHistoryTree(refused.continuation.head, f.base, [fourth]), originalTree);
  assert.equal(await f.git.remoteBranchHead(f.root, "origin", branch), fourth.outputCommit, "the refused authored head is not published");
  assert.deepEqual(f.calls.mergeHeads, [], "each failed-check stamp stops before the merge transport");
  assert.deepEqual(calls, { authors: 5, evidence: 4, reviews: 4, full: 9, delivery: 12 });
  assert.equal(f.calls.samples, 21);
  assert.equal((await f.effects("commit")).length, 9);
  assert.equal((await f.effects("push")).length, 8);
  assert.equal(f.calls.closes, 0);
  assert.equal(f.calls.reopens, 0);
  assert.equal(refused.reviewRounds.length, 5);
  assert.equal(refused.authorThreadId, "original-author");
  assert.equal(refused.branch, branch);
  assert.equal(refused.prNumber, 42);
  assert.equal(refused.baseCommit, f.base);
  assert.equal(refused.leafQualificationPolicy, "ordinary");
  assert.equal(refused.fullMergeValidation, undefined);
  assert.equal(f.store.get().settings.autoRun, true);
  assert.equal(f.store.get().orchestrator.enabled, false);
  assert.equal(f.store.get().ideas.find((idea) => idea.id === "unrelated").status, "queued");
  for (const row of f.rows) assert.deepEqual(f.store.get().evaluationRuns.find((item) => item.id === row.id), row);
}, { leafQualificationPolicy: "ordinary" }));
