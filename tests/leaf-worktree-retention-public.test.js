import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { CodexClient } from "../dist/lib/codex.js";
import { GitService } from "../dist/lib/git.js";
import { canRetryAgent, latestFullAssessment } from "../dist/lib/orchestrator.js";
import { runCommand } from "../dist/lib/process.js";
import { StateStore } from "../dist/lib/store.js";
import { createBurnerServer } from "../dist/server.js";

const repository = { host: "example.test", id: "retention-fixture-repository", nameWithOwner: "fixture/retention" };
const prUrl = `https://${repository.host}/${repository.nameWithOwner}/pull/42`;
const clone = (value) => structuredClone(value);
const fields = (pr) => ({ title: pr.title, body: pr.body, isDraft: pr.isDraft, state: pr.state });
const sentinel = { "committed.txt": "committed sentinel\n", "staged.txt": "staged sentinel\n",
  "unstaged.txt": "unstaged sentinel\n", "untracked.txt": "untracked sentinel\n", "ignored/sentinel.bin": Buffer.from([0, 255, 10, 13, 7, 128]) };

async function git(cwd, ...args) {
  const result = await runCommand("git", args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function executable(path) {
  assert.equal(lstatSync(path).isFile(), true, "fixture executable must be a regular non-symlink file");
  assert.equal(realpathSync(path), path);
  accessSync(path, constants.X_OK);
  return path;
}

function installGuards(t, f) {
  const oldPath = process.env.PATH, oldTmp = process.env.TMPDIR;
  const actualGit = realpathSync(oldPath.split(delimiter).map((path) => join(path, "git")).find((path) => {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  }));
  const local = (path) => {
    const absolute = resolve(path);
    assert.ok(absolute === f.sandbox || absolute.startsWith(`${f.sandbox}${sep}`), `outside fixture: ${absolute}`);
    let existing = absolute;
    while (true) {
      try { lstatSync(existing); break; }
      catch (error) { if (error.code !== "ENOENT" || existing === f.sandbox) throw error; existing = dirname(existing); }
    }
    assert.equal(realpathSync(existing), existing, "subprocess paths cannot traverse a symlink");
  };
  process.env.PATH = `${f.bin}${delimiter}${oldPath}`;
  process.env.TMPDIR = join(f.sandbox, "tmp");
  f.modelBoundary = (cwd) => { local(cwd); executable(join(f.bin, "codex")); assert.equal(process.env.PATH.split(delimiter)[0], f.bin); };
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) => {
    try {
      local(options.cwd);
      const env = { PATH: `${dirname(actualGit)}${delimiter}/usr/bin${delimiter}/bin`, LANG: "C", GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" };
      if (options.env?.GIT_INDEX_FILE) { local(dirname(options.env.GIT_INDEX_FILE)); env.GIT_INDEX_FILE = options.env.GIT_INDEX_FILE; }
      if (options.env?.GIT_NO_REPLACE_OBJECTS !== undefined) { assert.equal(options.env.GIT_NO_REPLACE_OBJECTS, "1"); env.GIT_NO_REPLACE_OBJECTS = "1"; }
      if (options.env?.GIT_GRAFT_FILE !== undefined) { assert.equal(options.env.GIT_GRAFT_FILE, "/dev/null"); env.GIT_GRAFT_FILE = "/dev/null"; }
      if (command === "git") { f.calls.git.push({ cwd: options.cwd, args: [...args] }); return spawn(actualGit, args, { ...options, env }); }
      assert.equal(command, "gh", "model, shell and unrecognized executable fallthrough is forbidden");
      assert.ok(JSON.stringify(args) === '["--version"]' || JSON.stringify(args) === '["auth","status"]');
      return spawn(executable(join(f.bin, "gh")), args, { ...options, env });
    } catch (error) { f.calls.blocked.push({ command, args, message: error.message }); throw error; }
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.spawn = spawn;
    syncBuiltinESMExports();
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
  });
}

function installFakes(t, f) {
  const session = () => ({ threadId: "retained-author", message: "Fixture implementation" });
  const model = (cwd, name) => {
    f.modelBoundary(cwd);
    if (f.requireLatch) assert.equal(f.run().retainWorktree, true, "retention must be durable before any new model/sample work");
    f.calls.models.push(name);
  };
  const methods = {
    close: () => { f.cancelEvaluation?.(); f.cancelAuthor?.(); },
    preflight: async (cwd) => f.modelBoundary(cwd),
    available: async (cwd) => { f.modelBoundary(cwd); return false; },
    implement: async (cwd) => {
      model(cwd, "implement");
      await fs.writeFile(join(cwd, "code.txt"), "authored candidate\n");
      await fs.writeFile(join(cwd, "committed.txt"), sentinel["committed.txt"]);
      return session();
    },
    revise: async (cwd, thread) => {
      model(cwd, "revise"); assert.equal(thread, "retained-author");
      await f.onAuthor?.(cwd);
      if (f.failAuthor) throw new Error("Fixture interrupted authorized author");
      await fs.writeFile(join(cwd, "code.txt"), `genuine repair ${f.calls.models.filter((name) => name === "revise").length}\n`);
      return session();
    },
    reauthor: async (cwd, thread, guidance, _settings, historicalFeedback) => {
      model(cwd, "reauthor"); assert.equal(thread, "retained-author");
      f.calls.reauthors.push({ cwd, thread, guidance, historicalFeedback: clone(historicalFeedback) });
      await f.onReauthor?.(cwd);
      if (f.failReauthor) throw new Error("Fixture interrupted explicitly admitted re-author");
      await fs.writeFile(join(cwd, "code.txt"), `genuine operator repair ${f.calls.reauthors.length}\n`);
      return session();
    },
    refreshAgentEvidence: async (cwd) => { model(cwd, "evidence"); return session(); },
    review: async (cwd) => { model(cwd, "review"); return { approved: true, summary: "Fixture approval", findings: [] }; },
    evaluate: async (cwd, evaluation, _settings, context, _baseline, evidence) => {
      if (context !== "agent" && context !== "composite") {
        f.modelBoundary(cwd);
        if (!f.probeMissingBaseline) f.calls.blocked.push({ method: "baseline evaluator", context });
        assert.equal(f.probeMissingBaseline, true, "only an explicitly requested fallback probe may reach a baseline sampler");
        f.calls.baselineRequests.push({ id: evaluation.id, context });
        throw new Error("Fixture stopped the independently selected missing-baseline sampler");
      }
      model(cwd, `sample:${evaluation.id}`);
      assert.ok(context === "agent" || context === "composite", "no baseline/campaign sampling");
      f.calls.samples.push({ id: evaluation.id, context, phase: f.phase });
      await f.onEvaluate?.(cwd);
      if (f.failEvaluation) throw new Error("Fixture evaluation interrupted");
      const output = { score: f.scores[evaluation.id], summary: `Fixture ${f.phase} ${evaluation.id}`, evidence: ["isolated"], suggestions: [] };
      if (evaluation.command) {
        assert.ok(evidence);
        const stdout = JSON.stringify(output);
        evidence.startCommand(); evidence.append("stdout", stdout);
        await evidence.recordCommand({ exitCode: 0, stdout, stderr: "" });
        await evidence.recordNormalized(output);
      }
      return output;
    },
  };
  for (const name of Object.getOwnPropertyNames(CodexClient.prototype)) if (name !== "constructor") {
    t.mock.method(CodexClient.prototype, name, methods[name] ?? (() => { f.calls.blocked.push({ name }); assert.fail(`unmocked model: ${name}`); }));
  }
  const scope = (cwd, repo, number) => {
    assert.equal(cwd, f.root); assert.deepEqual(repo, repository);
    if (number !== undefined) assert.equal(number, 42);
  };
  const observe = async () => {
    const observed = { ...clone(f.pr), repository: clone(repository), headRepository: clone(repository), baseRepository: clone(repository),
      headRefOid: await f.git.remoteBranchHead(f.root, "origin", f.run().branch), baseRefName: "main", baseRefOid: f.target ?? f.base,
      mergeable: "MERGEABLE", statusCheckRollup: [{ name: "fixture", status: "COMPLETED", conclusion: "SUCCESS" }], ...clone(f.observationPatch ?? {}) };
    await f.onObserve?.(observed);
    return observed;
  };
  const effect = async (name, apply) => {
    const durable = await f.persistedRun();
    const pending = durable.leafPr.pending;
    assert.ok(pending?.effect, "the public PR owner must persist a concrete effect first");
    const actual = pending.effect.kind === "edit" ? `edit:${pending.effect.field}` : pending.effect.kind;
    assert.equal(actual, name);
    if (name !== "create") assert.deepEqual(fields(f.pr), pending.effect.before);
    f.calls.pr.push(name);
    await apply();
    assert.deepEqual(fields(f.pr), pending.effect.after);
  };
  const github = {
    leafRepository: async (cwd, remote) => { assert.equal(cwd, f.root); assert.equal(remote, "origin"); f.calls.repositories += 1; return clone(repository); },
    observeLeafPr: async (cwd, repo, number) => { f.calls.observations += 1; scope(cwd, repo, number); return observe(); },
    findLeafPrs: async (cwd, repo, branch) => { scope(cwd, repo); assert.equal(branch, f.run().branch); return f.pr ? [await observe()] : []; },
    createLeafPr: async (input) => {
      scope(input.cwd, input.repository); assert.equal(f.pr, undefined);
      await effect("create", async () => { f.pr = { number: 42, url: prUrl, headRefName: input.branch, title: input.title, body: input.body, isDraft: input.isDraft, state: "OPEN" }; });
      return { number: 42, url: prUrl };
    },
    editLeafPrField: async (cwd, repo, number, field, value) => { scope(cwd, repo, number); await effect(`edit:${field}`, async () => { f.pr[field] = value; }); },
    setLeafPrDraft: async (cwd, repo, number, value) => { scope(cwd, repo, number); await effect(value ? "draft" : "ready", async () => { f.pr.isDraft = value; }); },
    closeLeafPr: async (cwd, repo, number) => { scope(cwd, repo, number); await effect("close", async () => { f.pr.state = "CLOSED"; }); },
    listPullRequests: async () => { f.calls.batches += 1; return [...(f.pr ? [await observe()] : []), ...clone(f.historyBatch ?? [])]; },
    markPrDisposition: async (...args) => { f.calls.markups.push(args); },
    markPrQuarantined: async (...args) => { f.calls.markups.push(args); },
    mergeLeafPr: async () => assert.fail("retention tests do not authorize a remote merge"),
    leafMergePolling: () => ({ mergeAttempts: 1, checkAttempts: 1, noCheckGraceAttempts: 0, intervalMs: 0 }),
  };
  for (const [name, implementation] of Object.entries(github)) t.mock.method(GitService.prototype, name, implementation);
  for (const name of ["getPullRequest", "pullRequestsForBranch", "openPr", "editPr", "markPrReady", "markPrDraft", "isPrDraft", "closePr", "reopenPr", "mergePr"]) {
    t.mock.method(GitService.prototype, name, () => { f.calls.blocked.push({ name }); assert.fail(`generic PR authority: ${name}`); });
  }
  const create = GitService.prototype.createExistingWorktree;
  t.mock.method(GitService.prototype, "createExistingWorktree", async function (...args) {
    f.calls.creates.push([...args]);
    if (f.failCreate) throw new Error("Fixture stops before initial allocation");
    const path = await create.apply(this, args);
    await f.onCreate?.(path);
    return path;
  });
  const remove = GitService.prototype.removeWorktree;
  t.mock.method(GitService.prototype, "removeWorktree", async function (path) {
    f.calls.removes.push(path);
    return remove.call(this, path); // Never mask a deletion bug with a no-op fake.
  });
  const proof = GitService.prototype.proveLeafInclusion;
  t.mock.method(GitService.prototype, "proveLeafInclusion", async function (...args) {
    f.calls.proofs.push(clone(args[0]));
    const proved = await proof.apply(this, args);
    await f.afterProof?.(args[0], proved);
    return proved;
  });
  const syncBase = GitService.prototype.syncBase;
  t.mock.method(GitService.prototype, "syncBase", async function (...args) {
    f.calls.baseSyncs.push(clone(args));
    if (f.failBaseSync > 0) { f.failBaseSync -= 1; throw new Error("Fixture base synchronization is unavailable"); }
    return syncBase.apply(this, args);
  });
  const update = StateStore.prototype.update;
  t.mock.method(StateStore.prototype, "update", async function (mutator) {
    f.calls.updates += 1;
    const before = clone(this.get().agentRuns.find((run) => run.ideaId === "idea"));
    const beforeBasePending = this.get().orchestrator.baseSyncPending;
    const cut = f.stateCut;
    const result = await update.call(this, (draft) => {
      mutator(draft);
      const after = draft.agentRuns.find((run) => run.ideaId === "idea");
      if (cut && !cut.hit && cut.when === "before" && cut.matches(before, after)) { cut.hit = true; throw new Error("Fixture state cut before durable write"); }
    });
    const after = this.get().agentRuns.find((run) => run.ideaId === "idea");
    if (cut && !cut.hit && cut.when === "after" && cut.matches(before, after)) { cut.hit = true; throw new Error("Fixture state cut after durable write"); }
    if (f.latchAtFullAck && before?.fullEvaluation?.step === "publication" && !after?.fullEvaluation && !after.retainWorktree) {
      f.latchAtFullAck = false; f.racedLatch = true;
      await update.call(this, (draft) => { draft.agentRuns.find((run) => run.id === after.id).retainWorktree = true; });
    }
    if (f.cutAfterBaseClear && beforeBasePending && !this.get().orchestrator.baseSyncPending) {
      f.cutAfterBaseClear = false; f.baseClearCutHit = true;
      throw new Error("Fixture stopped after durable base-sync flag clearing");
    }
    return result;
  });
}

async function fixture(t, options = {}) {
  const sandbox = await fs.mkdtemp(join(tmpdir(), "burner-retained-worktree-"));
  const f = { sandbox, root: join(sandbox, "project"), bin: join(sandbox, "bin"), phase: "delivery", scores: { command: 60, prompt: 55, ...options.scores }, passed: false, operations: [],
    calls: { models: [], samples: [], pr: [], creates: [], removes: [], git: [], blocked: [], baselineRequests: [], reauthors: [],
      observations: 0, repositories: 0, batches: 0, proofs: [], updates: 0, markups: [], baseSyncs: [] } };
  t.after(async () => {
    await f.close?.();
    await Promise.allSettled(f.operations);
    if (f.passed) await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    else { await fs.writeFile(join(sandbox, "fixture-effects.json"), JSON.stringify(f.calls, null, 2)); t.diagnostic(`Retained failed worktree fixture: ${sandbox}`); }
  });
  await fs.mkdir(f.root); await fs.mkdir(f.bin); await fs.mkdir(join(sandbox, "tmp"));
  for (const [name, code] of [["codex", 97], ["gh", 0]]) { await fs.writeFile(join(f.bin, name), `#!/bin/sh\nexit ${code}\n`); await fs.chmod(join(f.bin, name), 0o700); executable(join(f.bin, name)); }
  installGuards(t, f);
  f.run = () => f.store?.get().agentRuns.find((run) => run.ideaId === "idea");
  f.persistedRun = async () => JSON.parse(await fs.readFile(join(f.root, ".burner", "state.json"), "utf8")).agentRuns.find((run) => run.ideaId === "idea");
  installFakes(t, f);
  await git(f.root, "init", "-b", "main");
  await git(f.root, "config", "gc.auto", "0"); await git(f.root, "config", "maintenance.auto", "false");
  await fs.writeFile(join(f.root, ".gitignore"), ".burner/\nignored/\n");
  await fs.writeFile(join(f.root, "README.md"), "# Retained checkout fixture\n");
  await fs.writeFile(join(f.root, "code.txt"), "base\n");
  await fs.writeFile(join(f.root, "unstaged.txt"), "original tracked bytes\n");
  f.git = new GitService(f.root, join(f.root, ".burner"));
  f.base = await f.git.commit(f.root, "fixture base");
  const remote = join(f.root, ".burner", "remote.git");
  await git(f.root, "init", "--bare", remote); await git(f.root, "remote", "add", "origin", remote); await f.git.push(f.root, "origin", "main");
  f.store = new StateStore(f.root); await f.store.init();
  const timestamp = new Date().toISOString();
  await f.store.update((state) => {
    Object.assign(state.settings, { autoRun: false, autoCreatePrs: options.published !== false, defaultResources: options.resources ?? [], parallelism: 1,
      preferLivingComposite: false, maxReviewRounds: options.reviewLimit ?? 4, portfolioReviewRounds: 6, stallTerminationHours: 0 });
    Object.assign(state.orchestrator, { enabled: false, lastEvaluationAt: timestamp, lastPlanningAt: timestamp });
    state.evaluations = [{ id: "command", name: "Command", command: "fixture-command-never-executed", prompt: "Fixture command", weight: 1, enabled: true, definitionVersion: "v1", createdAt: timestamp },
      { id: "prompt", name: "Prompt", prompt: "Fixture prompt", weight: 1, enabled: true, definitionVersion: "v1", createdAt: timestamp }];
    state.evaluationRuns = state.evaluations.map((evaluation) => ({ id: `baseline-${evaluation.id}`, evaluationId: evaluation.id, evaluationDefinitionVersion: "v1",
      commit: f.base, context: "baseline", status: "completed", score: 50, ...(evaluation.command ? {} : { promptSampleCount: 3 }), summary: "Frozen baseline", evidence: [], suggestions: [], durationMs: 1, createdAt: timestamp }));
    if (options.screening) {
      state.evaluations[0].screeningCommand = "fixture-screening-command-never-executed";
      state.evaluationRuns.push({ ...clone(state.evaluationRuns[0]), id: "screening-command-baseline", context: "screening_baseline" });
    }
    state.ideas = [{ id: "idea", title: "Retained target", description: "Repair this same fixture leaf", rationale: "Retention", predictedImpact: 10,
      evaluationIds: ["command", "prompt"], resources: [], status: "queued", source: "manual", createdAt: timestamp, updatedAt: timestamp }];
    state.agentRuns = []; state.composites = [];
  });
  f.close = async () => { if (f.server && !f.closed) { f.closed = true; await f.server.close(); } };
  f.restart = async () => {
    await f.close();
    f.server = await createBurnerServer({ root: f.root, host: "127.0.0.1", port: 0, manual: true,
      ...(options.screening ? { yolo: true, yoloBatchSize: 2 } : {}) });
    f.closed = false;
    f.store = f.server.store; f.git = f.server.orchestrator.git;
  };
  f.full = (options) => { const work = f.server.orchestrator.fullyValidateLeafForMerge(f.run().id, f.base, options); f.operations.push(work); return work; };
  f.retry = (options) => { const work = f.server.orchestrator.retryAgent(f.run().id, options); f.operations.push(work); return work; };
  f.reauthor = (input) => { const work = f.server.orchestrator.reauthorAgent(f.run().id, input); f.operations.push(work); return work; };
  f.sync = () => { const work = f.server.orchestrator.syncPullRequests(true); f.operations.push(work); return work; };
  f.paths = () => [join(f.root, ".burner", "worktrees", f.run().id), join(f.root, ".burner", "worktrees", `full-leaf-${f.run().id}`)];
  await f.restart();
  const delivered = await f.server.orchestrator.runNextIdea();
  assert.equal(delivered.status, "completed", delivered.error);
  assert.equal(delivered.continuation.step, "done");
  assert.ok(delivered.continuation.evaluation.result.completedAt, "fresh public delivery owns real measured evidence");
  if (options.published !== false) { assert.equal(delivered.prNumber, 42); assert.deepEqual(delivered.leafPr.known.fields, fields(f.pr)); }
  return f;
}

async function withFixture(t, options, action) {
  const f = await fixture(t, options);
  await action(f);
  assert.deepEqual(f.calls.blocked, []);
  f.passed = true;
}

async function ignored(path) { await fs.mkdir(join(path, "ignored"), { recursive: true }); await fs.writeFile(join(path, "ignored/sentinel.bin"), sentinel["ignored/sentinel.bin"]); }

async function dirty(path) {
  await ignored(path);
  await fs.writeFile(join(path, "staged.txt"), sentinel["staged.txt"]); await git(path, "add", "staged.txt");
  await fs.writeFile(join(path, "unstaged.txt"), sentinel["unstaged.txt"]);
  await fs.writeFile(join(path, "untracked.txt"), sentinel["untracked.txt"]);
}

async function namespace(f, path) {
  const files = {};
  for (const name of Object.keys(sentinel)) {
    try { files[name] = (await fs.readFile(join(path, name))).toString("base64"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const registration = (await git(f.root, "worktree", "list", "--porcelain")).split("\n\n").find((entry) => entry.startsWith(`worktree ${path}\n`));
  assert.ok(registration, "exact checkout registration must remain present");
  return { files, registration, gitfile: await fs.readFile(join(path, ".git"), "utf8"), head: await git(path, "rev-parse", "HEAD"),
    index: await git(path, "write-tree"), status: await git(path, "status", "--porcelain", "--untracked-files=all") };
}

function evidence(f) { return clone({ rows: f.store.get().evaluationRuns, history: f.run().fullEvaluationHistory,
  reviews: f.run().reviewRounds, delivery: f.run().continuation?.evaluation, samples: f.calls.samples, models: f.calls.models }); }

async function reaches(work, boundary) {
  await Promise.race([boundary, work.then(() => assert.fail("public operation completed before reaching the requested fixture boundary"))]);
}

function noRemoval(f, offset) { assert.deepEqual(f.calls.removes.slice(offset).filter((path) => f.paths().includes(path)), [], "the actual canonical removal primitive must never be called for a retained target"); }
function allocations(f) { return f.calls.git.filter(({ args }) => args[0] === "worktree" && args[1] === "add").length; }

async function allocate(f, which = 0) {
  const path = await f.git.createExistingWorktree(which ? `full-leaf-${f.run().id}` : f.run().id, f.run().branch);
  assert.equal(path, f.paths()[which]); await ignored(path); return path;
}

function reauthorInput(f, requestId = "ordinary-checkout-request") {
  return { requestId, expectedContinuationId: f.run().continuation.id, expectedHead: f.run().continuation.head,
    expectedPublishedHead: f.run().continuation.identity.pullRequest.head,
    guidance: "Make one genuine implementation change on this same PR; preserve the evaluation and review contracts." };
}

function admissionState(f) {
  return clone({ run: f.run(), ideas: f.store.get().ideas, definitions: f.store.get().evaluations, rows: f.store.get().evaluationRuns,
    pr: f.pr, effects: f.calls.pr, models: f.calls.models, samples: f.calls.samples });
}

async function missingCheckouts(f) {
  for (const path of f.paths()) await assert.rejects(fs.lstat(path), { code: "ENOENT" });
}

function assertOrdinaryHeld(f, input, source) {
  const run = f.run(), request = run.reauthorRequests.at(-1);
  assert.equal(run.status, "failed", run.error);
  assert.equal(run.continuation.step, "evidence", run.error);
  assert.equal(request.id, input.requestId);
  assert.deepEqual(request.source, source.continuation, "the exact completed ordinary receipt stays in the request source");
  assert.equal(request.assessment, undefined, "ordinary delivery is not a synthetic full assessment");
  assert.equal(request.checkFailures, undefined);
  assert.equal(request.releasedAt, undefined);
  assert.deepEqual(request.output, { continuationId: run.continuation.id, head: run.continuation.head });
  for (const key of ["id", "ideaId", "branch", "baseRef", "baseCommit", "prNumber", "prUrl", "prState", "authorThreadId", "resources",
    "leafPr", "reviewRounds", "fullEvaluationHistory", "fullMergeValidation", "deltas", "impact", "retainWorktree"]) assert.deepEqual(run[key], source[key], key);
  assert.equal(latestFullAssessment(run), undefined);
}

function reconciliationWork(f) {
  return { observations: f.calls.observations, repositories: f.calls.repositories, proofs: f.calls.proofs.length,
    writes: f.calls.updates, effects: f.calls.pr.length, markups: f.calls.markups.length,
    batches: f.calls.batches, baseSyncs: f.calls.baseSyncs.length, samples: f.calls.samples.length, models: f.calls.models.length };
}

function workSince(f, before) {
  return Object.fromEntries(Object.entries(reconciliationWork(f)).map(([key, value]) => [key, value - before[key]]));
}

function mergeCadence(f) {
  const value = f.store.get().orchestrator;
  return clone({ lastMergeAt: value.lastMergeAt, mergeWindowStartedAt: value.mergeWindowStartedAt, lastMergeCadenceAlertAt: value.lastMergeCadenceAlertAt });
}

async function landRetainedPr(f, { newer = false } = {}) {
  const head = await f.git.remoteBranchHead(f.root, "origin", f.run().branch);
  const serial = f.landingSequence = (f.landingSequence ?? 0) + 1;
  const path = join(f.sandbox, `historical-landing-${serial}`);
  await git(f.root, "worktree", "add", "-b", `fixture/historical-landing-${serial}`, path, f.base);
  await git(path, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "merge", "--no-ff", "--no-edit", head);
  const landing = await f.git.head(path);
  let targetCommit = landing;
  if (newer) {
    await fs.writeFile(join(path, "later-target.txt"), "different current target tree\n");
    targetCommit = await f.git.commit(path, "later fixture target");
  }
  await git(path, "push", "origin", `${targetCommit}:refs/heads/main`);
  f.target = targetCommit;
  Object.assign(f.pr, { state: "MERGED", isDraft: false, mergeCommit: landing });
  return { sourceBase: f.base, head, landing, targetCommit };
}

function assertOriginalRows(f, rows) {
  for (const row of rows) assert.deepEqual(f.store.get().evaluationRuns.find((item) => item.id === row.id), row,
    "history and original measurement rows are retained byte-for-byte");
}

function baselineAt(f, commit) {
  return f.store.get().evaluationRuns.filter((row) => row.context === "baseline" && row.commit === commit && row.status === "completed");
}

test("public full admission latches retention before initial allocation and retains clean ignored files after success/restart", async (t) => withFixture(t, {}, async (f) => {
  assert.equal(Object.hasOwn(f.run(), "retainWorktree"), false);
  for (const path of f.paths()) await assert.rejects(fs.lstat(path), { code: "ENOENT" });
  const offset = f.calls.removes.length;
  f.onCreate = ignored; f.requireLatch = true; f.phase = "full";
  assert.equal(await f.full({ retainWorktree: true }), true);
  const path = f.run().worktree, saved = await namespace(f, path), history = clone(f.run().fullEvaluationHistory);
  assert.equal(f.run().retainWorktree, true); assert.equal((await f.persistedRun()).retainWorktree, true);
  assert.equal(saved.status, "", "ignored bytes alone are invisible to porcelain cleanliness");
  assert.deepEqual(saved.files["ignored/sentinel.bin"], sentinel["ignored/sentinel.bin"].toString("base64"));
  noRemoval(f, offset);
  await f.restart();
  const before = evidence(f), creates = allocations(f);
  assert.equal(await f.full(), true);
  assert.equal(await f.full({ retainWorktree: true }), true, "repeated literal opt-in is idempotent");
  await assert.rejects(f.full({ retainWorktree: false }), /retainWorktree|retention/i);
  assert.equal(f.run().retainWorktree, true); assert.equal(allocations(f), creates);
  assert.deepEqual(await namespace(f, path), saved); assert.deepEqual(f.run().fullEvaluationHistory, history); assert.deepEqual(evidence(f), before);
  noRemoval(f, offset);
}));

test("a retained negative full, genuine repair delivery, and later full success reuse the exact checkout without releasing retention", async (t) => withFixture(t, {}, async (f) => {
  const path = await allocate(f), creates = allocations(f), offset = f.calls.removes.length;
  const committed = await fs.readFile(join(path, "committed.txt"));
  f.requireLatch = true; f.scores.prompt = 40; f.phase = "negative-full";
  assert.equal(await f.full({ retainWorktree: true }), false);
  const negative = clone(latestFullAssessment(f.run())), first = await namespace(f, path);
  assert.equal(negative.qualified, false); assert.equal(f.run().worktree, path); assert.equal(allocations(f), creates);
  await f.restart(); f.scores.prompt = 55; f.phase = "repair-delivery";
  const repaired = await f.retry();
  assert.equal(repaired.status, "completed", repaired.error); assert.equal(repaired.retainWorktree, true); assert.equal(repaired.worktree, path);
  assert.deepEqual(latestFullAssessment(repaired), negative); assert.equal(repaired.reviewRounds.length, 2);
  assert.equal(allocations(f), creates); assert.deepEqual(await fs.readFile(join(path, "committed.txt")), committed);
  assert.equal((await namespace(f, path)).files["ignored/sentinel.bin"], first.files["ignored/sentinel.bin"]);
  f.phase = "repaired-full"; assert.equal(await f.full(), true);
  assert.equal(f.run().retainWorktree, true); assert.equal(f.run().fullEvaluationHistory.length, 2);
  assert.equal(allocations(f), creates); noRemoval(f, offset);
  await f.close(); await f.restart();
  assert.equal(f.run().retainWorktree, true); assert.ok(await fs.lstat(path)); noRemoval(f, offset);
}));

test("dirty terminal checkpoints preserve committed, staged, unstaged, untracked and ignored bytes across refusal and public close", async (t) => withFixture(t, {}, async (f) => {
  const path = await allocate(f), offset = f.calls.removes.length;
  f.scores.prompt = 40; assert.equal(await f.full({ retainWorktree: true }), false);
  await dirty(path);
  const saved = await namespace(f, path), prior = evidence(f), creates = allocations(f);
  assert.equal(Object.keys(saved.files).length, 5);
  assert.match(saved.status, /A  staged\.txt/); assert.match(saved.status, / M unstaged\.txt/); assert.match(saved.status, /\?\? untracked\.txt/);
  await f.restart();
  await assert.rejects(f.retry());
  assert.deepEqual(await namespace(f, path), saved); assert.deepEqual(evidence(f), prior);
  assert.equal(allocations(f), creates); assert.equal(f.run().retainWorktree, true);
  await f.close();
  assert.deepEqual(await namespace(f, path), saved); noRemoval(f, offset);
}));

test("public base refresh inherits retention without a repeated opt-in and leaves the same registered checkout in place", async (t) => withFixture(t, {}, async (f) => {
  const path = await allocate(f), offset = f.calls.removes.length;
  f.scores.prompt = 40; assert.equal(await f.full({ retainWorktree: true }), false);
  const saved = await namespace(f, path), history = clone(f.run().fullEvaluationHistory);
  await fs.writeFile(join(f.root, "upstream.txt"), "legitimate newer base\n");
  f.target = await f.git.commit(f.root, "advance fixture base"); await f.git.push(f.root, "origin", "main");
  await f.store.update((state) => {
    for (const evaluation of state.evaluations) state.evaluationRuns.push({ id: `advanced-${evaluation.id}`, evaluationId: evaluation.id,
      evaluationDefinitionVersion: "v1", commit: f.target, context: "baseline", status: "completed", score: 50,
      ...(evaluation.command ? {} : { promptSampleCount: 3 }), summary: "New-base fixture baseline", evidence: [], suggestions: [], durationMs: 1, createdAt: new Date().toISOString() });
  });
  await f.restart(); f.scores.prompt = 55; f.requireLatch = true;
  const work = f.server.orchestrator.refreshAgentBaseAndRetry(f.run().id); f.operations.push(work);
  const refreshed = await work;
  assert.equal(refreshed.status, "completed", refreshed.error); assert.equal(refreshed.baseCommit, f.target);
  assert.equal(refreshed.retainWorktree, true); assert.equal(refreshed.worktree, path); assert.equal(refreshed.reviewRounds.length, 2);
  assert.deepEqual(refreshed.fullEvaluationHistory, history);
  const after = await namespace(f, path); assert.deepEqual(after.files, saved.files); assert.equal(after.gitfile, saved.gitfile);
  noRemoval(f, offset); await f.restart(); assert.equal(f.run().retainWorktree, true);
}));

test("an interrupted authorized author alone may resume its retained dirty namespace and finish delivery", async (t) => withFixture(t, {}, async (f) => {
  const path = await allocate(f), offset = f.calls.removes.length;
  f.scores.prompt = 40; assert.equal(await f.full({ retainWorktree: true }), false);
  f.failAuthor = true; f.onAuthor = dirty;
  assert.equal((await f.retry()).status, "failed");
  assert.equal(f.run().continuation.step, "author");
  const saved = await namespace(f, path), history = clone(f.run().fullEvaluationHistory), creates = allocations(f);
  await f.restart(); f.failAuthor = false; f.scores.prompt = 55;
  f.onAuthor = async (cwd) => { assert.equal(cwd, path); assert.deepEqual(await namespace(f, cwd), saved, "the author receives the same bytes/index, not a recreated checkout"); };
  const repaired = await f.retry();
  assert.equal(repaired.status, "completed", repaired.error); assert.equal(repaired.retainWorktree, true);
  assert.deepEqual(repaired.fullEvaluationHistory, history); assert.equal(allocations(f), creates);
  for (const [name, bytes] of Object.entries(saved.files)) assert.equal((await fs.readFile(join(path, name))).toString("base64"), bytes);
  noRemoval(f, offset);
}));

test("retention survives evaluation error, cancellation through public close, and checked terminal PR closure", async (t) => {
  for (const outcome of ["error", "cancel-clean", "cancel-dirty", "terminal-close"]) await t.test(outcome, async (t) => withFixture(t, { reviewLimit: outcome === "terminal-close" ? 1 : 4 }, async (f) => {
    const path = await allocate(f), offset = f.calls.removes.length;
    let before;
    if (outcome === "error") f.failEvaluation = true;
    if (outcome === "terminal-close") f.scores.prompt = 40;
    if (outcome.startsWith("cancel-")) {
      let entered;
      const started = new Promise((done) => { entered = done; });
      const stopped = new Promise((done) => { f.cancelEvaluation = done; });
      f.onEvaluate = async () => { entered(); await stopped; throw new Error("Fixture evaluation cancelled through public close"); };
      const work = f.full({ retainWorktree: true });
      await reaches(work, started);
      if (outcome === "cancel-dirty") await dirty(path);
      before = await namespace(f, path);
      await f.close();
      // A concurrent dirty writer invalidates scientific source identity;
      // retaining its bytes must not convert that independent refusal to a
      // normal cancelled score or relax the clean-source gate.
      if (outcome === "cancel-dirty") await assert.rejects(work, /clean pinned Git identity/);
      else assert.equal(await work, false);
      f.onEvaluate = undefined; f.cancelEvaluation = undefined;
      assert.deepEqual(await namespace(f, path), before);
    } else assert.equal(await f.full({ retainWorktree: true }), false);
    assert.equal(f.run().retainWorktree, true); noRemoval(f, offset);
    if (outcome === "terminal-close") {
      assert.equal(f.pr.state, "CLOSED"); assert.equal(f.run().leafPr.known.fields.state, "CLOSED"); assert.equal(canRetryAgent(f.run()), false);
      const prior = evidence(f); await assert.rejects(f.retry()); assert.deepEqual(evidence(f), prior);
    }
    const saved = await namespace(f, path);
    await f.restart(); assert.equal(f.run().retainWorktree, true); assert.deepEqual(await namespace(f, path), saved); noRemoval(f, offset);
  }));
});

test("invalid extant saved checkouts are preserved and never bypassed with a second allocation", async (t) => {
  for (const kind of ["foreign branch", "foreign repository", "foreign HEAD", "symlink", "unreadable", "dual paths"]) await t.test(kind, async (t) => withFixture(t, {}, async (f) => {
    const path = f.paths()[0]; let restore = async () => {};
    if (kind === "foreign repository") {
      await fs.mkdir(path, { recursive: true }); await git(path, "init", "-b", f.run().branch);
      await fs.writeFile(join(path, "foreign.txt"), "foreign repository bytes\n");
      await git(path, "add", "."); await git(path, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "foreign repository");
    } else {
      await allocate(f);
      if (kind === "foreign branch") await git(path, "switch", "-c", "fixture/foreign");
      if (kind === "foreign HEAD") await git(path, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "--allow-empty", "-m", "foreign head");
      if (kind === "symlink") {
        const moved = join(f.sandbox, "moved-checkout"); await git(f.root, "worktree", "move", path, moved); await fs.symlink(moved, path, "dir");
      }
      if (kind === "unreadable") { await fs.chmod(path, 0o000); restore = () => fs.chmod(path, 0o755); }
      if (kind === "dual paths") { await git(f.root, "worktree", "add", "--force", f.paths()[1], f.run().branch); await ignored(f.paths()[1]); }
    }
    const creates = allocations(f), removes = f.calls.removes.length, prior = evidence(f);
    const registrations = await git(f.root, "worktree", "list", "--porcelain");
    try {
      const result = await f.full({ retainWorktree: true }).then((value) => ({ value }), (error) => ({ error }));
      assert.ok(result.error || result.value === false, "invalid source cannot qualify");
      assert.equal(allocations(f), creates, "an extant invalid/ambiguous allocation is not absence");
      assert.equal(f.calls.removes.length, removes);
      assert.deepEqual(evidence(f), prior);
      assert.equal(await git(f.root, "worktree", "list", "--porcelain"), registrations);
    } finally { await restore(); }
    assert.ok(await fs.lstat(path));
    if (kind === "foreign repository") assert.equal(await fs.readFile(join(path, "foreign.txt"), "utf8"), "foreign repository bytes\n");
    else assert.deepEqual(await fs.readFile(join(path, "ignored/sentinel.bin")), sentinel["ignored/sentinel.bin"]);
    if (kind === "dual paths") assert.deepEqual(await fs.readFile(join(f.paths()[1], "ignored/sentinel.bin")), sentinel["ignored/sentinel.bin"]);
  }));
});

test("a latched restart with ambiguous absence reports reconciliation instead of creating or removing a checkout", async (t) => withFixture(t, {}, async (f) => {
  const offset = f.calls.removes.length;
  f.failCreate = true;
  await assert.rejects(f.full({ retainWorktree: true }), /Fixture stops before initial allocation/);
  assert.equal(f.run().retainWorktree, true); assert.equal(f.calls.creates.length, 1);
  for (const path of f.paths()) await assert.rejects(fs.lstat(path), { code: "ENOENT" });
  f.failCreate = false; await f.restart();
  const prior = evidence(f), creates = allocations(f);
  await assert.rejects(f.full(), /missing|unknown allocation|loss|reconcil/i);
  assert.equal(allocations(f), creates); assert.deepEqual(evidence(f), prior); noRemoval(f, offset);
  assert.equal(f.run().retainWorktree, true);
}));

test("proved MERGED terminal settlement records exact history and never releases the retained local checkout", async (t) => withFixture(t, {}, async (f) => {
  const path = await allocate(f), offset = f.calls.removes.length;
  assert.equal(await f.full({ retainWorktree: true }), true);
  const controlStart = reconciliationWork(f);
  await f.sync();
  const control = workSince(f, controlStart);
  const saved = await namespace(f, path), prior = evidence(f), known = clone(f.run().leafPr.known.fields);
  const landing = join(f.sandbox, "landing");
  await git(f.root, "worktree", "add", "-b", "fixture/landing", landing, f.base);
  await git(landing, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "merge", "--no-ff", "--no-edit", f.run().branch);
  const merge = await git(landing, "rev-parse", "HEAD");
  await fs.writeFile(join(landing, "newer-base.txt"), "later target change\n");
  f.target = await f.git.commit(landing, "later target");
  await git(landing, "push", "origin", `${f.target}:refs/heads/main`);
  Object.assign(f.pr, { state: "MERGED", isDraft: false, mergeCommit: merge });
  await f.restart(); await f.server.orchestrator.syncPullRequests(true);
  assert.equal(f.run().prState, "merged"); assert.equal(f.run().retainWorktree, true);
  assert.deepEqual(f.run().leafPr.merged, { sourceBase: f.base, head: saved.head, landing: merge, targetCommit: f.target },
    "the existing exact settlement must durably retain the concrete proved source/landing/target fact");
  assert.deepEqual((await f.persistedRun()).leafPr.merged, f.run().leafPr.merged);
  assert.deepEqual(f.run().leafPr.known.fields, known, "the observed merge does not rewrite acknowledged lifecycle");
  assert.deepEqual(await namespace(f, path), saved); assert.deepEqual(evidence(f), prior); noRemoval(f, offset);
  const settled = clone(f.run()), cadence = mergeCadence(f);
  await f.restart();
  const activity = clone(f.store.get().activity); // Manual server construction records its own one-time pause.
  const syncStart = reconciliationWork(f);
  await f.sync();
  assert.deepEqual(workSince(f, syncStart), { observations: 0, repositories: 0, proofs: 0, writes: control.writes,
    effects: 0, markups: 0, batches: 1, baseSyncs: 0, samples: 0, models: 0 },
  "acknowledged history contributes no exact leaf work; existing constant batch/composite housekeeping remains");
  const mergeStart = reconciliationWork(f);
  assert.equal((await f.server.orchestrator.mergeAgent(f.run().id)).prState, "merged");
  assert.deepEqual(workSince(f, mergeStart), { observations: 0, repositories: 0, proofs: 0, writes: 0,
    effects: 0, markups: 0, batches: 0, baseSyncs: 0, samples: 0, models: 0 });
  assert.deepEqual(f.run(), settled); assert.deepEqual(mergeCadence(f), cadence); assert.deepEqual(f.store.get().activity, activity);
  assert.deepEqual(await namespace(f, path), saved); assert.deepEqual(evidence(f), prior); noRemoval(f, offset);
}));

test("reconciliation history acquires an old owned merged display once without inventing a second merge event", async (t) => withFixture(t, {}, async (f) => {
  const path = await allocate(f); assert.equal(await f.full({ retainWorktree: true }), true);
  const graph = await landRetainedPr(f, { newer: true });
  await f.sync();
  assert.deepEqual(f.run().leafPr.merged, graph);
  // Compatibility representation of a genuinely proved owner from the old
  // writer: only the newly introduced fact is absent, not its retained evidence.
  await f.store.update((state) => { delete state.agentRuns.find((run) => run.id === f.run().id).leafPr.merged; });
  const cadence = mergeCadence(f), prior = evidence(f), saved = await namespace(f, path);
  await f.restart();
  const before = reconciliationWork(f);
  await f.sync();
  const acquired = workSince(f, before);
  assert.equal(acquired.proofs, 1); assert.ok(acquired.observations > 0);
  assert.deepEqual(f.run().leafPr.merged, graph);
  assert.deepEqual(mergeCadence(f), cadence); assert.equal(f.store.get().orchestrator.baseSyncPending, false);
  assert.equal(acquired.baseSyncs, 0, "adding an old acknowledgment is not a new merge");
  const after = reconciliationWork(f); await f.restart(); await f.sync();
  assert.equal(workSince(f, after).proofs, 0); assert.equal(workSince(f, after).observations, 0);
  assert.deepEqual(evidence(f), prior); assert.deepEqual(await namespace(f, path), saved);
}));

test("reconciliation history and base-sync intent share the real merge acknowledgment across durable write cuts", async (t) => {
  for (const when of ["before", "after"]) await t.test(when, async (t) => withFixture(t, {}, async (f) => {
    const path = await allocate(f), removes = f.calls.removes.length;
    assert.equal(await f.full({ retainWorktree: true }), true);
    const prior = evidence(f), saved = await namespace(f, path), known = clone(f.run().leafPr.known.fields);
    const graph = await landRetainedPr(f, { newer: true });
    f.failBaseSync = 1;
    f.stateCut = { when, hit: false, matches: (before, after) => before?.leafPr && !before.leafPr.merged && Boolean(after?.leafPr?.merged) };
    if (when === "before") {
      await f.sync(); // Sync reports this per-owner refusal as preserved activity.
      assert.equal(f.run().leafPr.merged, undefined); assert.equal(f.run().prState, "open");
      assert.notEqual(f.store.get().orchestrator.baseSyncPending, true);
      assert.match(f.store.get().activity[0].detail, /Fixture state cut before durable write/);
      assert.equal(f.stateCut.hit, true); f.stateCut = undefined; await f.restart();
      await assert.rejects(f.sync(), /Fixture base synchronization is unavailable/);
    } else {
      await assert.rejects(f.sync(), /Fixture base synchronization is unavailable/);
      assert.equal(f.stateCut.hit, true); f.stateCut = undefined;
    }
    assert.deepEqual(f.run().leafPr.merged, graph); assert.equal(f.run().prState, "merged");
    assert.equal(f.store.get().orchestrator.baseSyncPending, true);
    assert.deepEqual((await f.persistedRun()).leafPr.merged, graph);
    assert.deepEqual(f.run().leafPr.known.fields, known);
    const cadence = mergeCadence(f), work = reconciliationWork(f);
    await f.restart(); await f.sync();
    assert.equal(workSince(f, work).proofs, 0); assert.equal(workSince(f, work).observations, 0);
    assert.equal(f.store.get().orchestrator.baseSyncPending, false);
    assert.equal(f.store.get().orchestrator.lastMergeAt, cadence.lastMergeAt);
    assert.deepEqual(evidence(f), prior); assert.deepEqual(await namespace(f, path), saved); noRemoval(f, removes);
  }));
});

test("reconciliation history skips a checked CLOSED owner after restart while preserving its exact evidence and checkout", async (t) => withFixture(t, { reviewLimit: 1 }, async (f) => {
  const controlStart = reconciliationWork(f); await f.sync(); const control = workSince(f, controlStart);
  const path = await allocate(f), removes = f.calls.removes.length;
  f.scores.prompt = 40; assert.equal(await f.full({ retainWorktree: true }), false);
  assert.equal(f.run().leafPr.known.fields.state, "CLOSED"); assert.equal(f.run().leafPr.pending, undefined);
  const saved = await namespace(f, path), prior = evidence(f), owner = clone(f.run()), cadence = mergeCadence(f);
  await f.restart(); const activity = clone(f.store.get().activity), before = reconciliationWork(f); await f.sync();
  assert.deepEqual(workSince(f, before), { observations: 0, repositories: 0, proofs: 0, writes: control.writes,
    effects: 0, markups: 0, batches: 1, baseSyncs: 0, samples: 0, models: 0 });
  assert.deepEqual(f.run(), owner); assert.deepEqual(f.store.get().activity, activity); assert.deepEqual(mergeCadence(f), cadence);
  assert.deepEqual(evidence(f), prior); assert.deepEqual(await namespace(f, path), saved); noRemoval(f, removes);
}));

test("reconciliation history refuses dirty source and changed post-proof landing before recording any merged fact", async (t) => {
  for (const kind of ["dirty source", "changed landing"]) await t.test(kind, async (t) => withFixture(t, {}, async (f) => {
    const path = await allocate(f), removes = f.calls.removes.length;
    assert.equal(await f.full({ retainWorktree: true }), true);
    const graph = await landRetainedPr(f, { newer: true });
    if (kind === "dirty source") await dirty(path);
    else f.afterProof = async () => { f.pr.mergeCommit = graph.targetCommit; };
    const saved = await namespace(f, path), prior = evidence(f), owner = clone(f.run());
    await f.restart(); const before = reconciliationWork(f); await f.sync();
    assert.equal(f.run().leafPr.merged, undefined); assert.deepEqual(f.run(), owner);
    assert.equal(f.store.get().orchestrator.lastMergeAt, undefined);
    assert.notEqual(f.store.get().orchestrator.baseSyncPending, true);
    assert.equal(workSince(f, before).effects, 0); assert.equal(workSince(f, before).samples, 0);
    assert.equal(workSince(f, before).proofs, kind === "dirty source" ? 0 : 1);
    assert.ok(f.store.get().activity.some((entry) => entry.message.startsWith("Leaf PR settlement preserved") &&
      /dirty or mismatching existing checkout|landing identity changed/i.test(entry.detail)));
    assert.deepEqual(evidence(f), prior); assert.deepEqual(await namespace(f, path), saved); noRemoval(f, removes);
  }));
});

test("reconciliation history selection-only volume adds zero per-record work beside a genuine live owned leaf", async (t) => withFixture(t, {}, async (f) => {
  const path = await allocate(f); assert.equal(await f.full({ retainWorktree: true }), true);
  const prior = evidence(f), saved = await namespace(f, path);
  const controlStart = reconciliationWork(f); await f.sync(); const control = workSince(f, controlStart);
  assert.ok(control.observations > 0, "the single public-dispatch live owner is actually reconciled");
  const template = clone(f.run()), idea = clone(f.store.get().ideas[0]);
  const projections = [];
  // These 388 rows test selection cost and tracking only. They are not claimed
  // to be 388 real remote merges; genuine graph/settlement tests are separate.
  for (const [kind, count] of [["merged", 128], ["closed", 128], ["unknown-terminal", 128], ["unknown-open", 4]]) {
    for (let i = 0; i < count; i += 1) {
      const number = 1000 + projections.length, id = `selection-${kind}-${i}`;
      const run = { ...clone(template), id, ideaId: id, branch: `burner/${id}`, prNumber: number,
        prUrl: `https://${repository.host}/${repository.nameWithOwner}/pull/${number}`,
        prState: kind === "merged" ? "merged" : kind === "unknown-open" ? "open" : "closed" };
      run.leafPr.branch = run.branch; run.leafPr.known.number = number; run.leafPr.known.url = run.prUrl;
      if (kind === "merged") run.leafPr.merged = { sourceBase: f.base, head: template.continuation.head, landing: template.continuation.head, targetCommit: template.continuation.head };
      if (kind === "closed") run.leafPr.known.fields.state = "CLOSED";
      if (kind.startsWith("unknown")) delete run.leafPr;
      projections.push(run);
    }
  }
  await f.store.update((state) => {
    state.agentRuns.push(...clone(projections));
    state.ideas.push(...projections.map((run) => ({ ...clone(idea), id: run.ideaId })));
  });
  const retained = clone(f.store.get().agentRuns);
  assert.equal(retained.length, 389, "verify real trim retained the explicitly bounded recent history, without bypassing it");
  assert.deepEqual(retained.map((run) => run.id), [template.id, ...projections.map((run) => run.id)]);
  const cadence = mergeCadence(f);
  for (const batch of ["complete", "truncated"]) {
    f.historyBatch = batch === "complete" ? projections.map((run) => ({ number: run.prNumber, url: run.prUrl, headRefName: run.branch,
      state: run.prState === "open" ? "OPEN" : run.prState === "merged" ? "MERGED" : "CLOSED", labels: [{ name: "burner-unmerged" }] })) : [];
    await f.restart(); assert.equal(f.store.get().agentRuns.length, 389);
    const activity = clone(f.store.get().activity), before = reconciliationWork(f); await f.sync();
    assert.deepEqual(workSince(f, before), control, `${batch} batch: only the original live owner's work plus constant housekeeping is allowed`);
    assert.deepEqual(f.store.get().agentRuns, retained); assert.deepEqual(f.store.get().activity, activity);
    assert.deepEqual(mergeCadence(f), cadence); assert.deepEqual(evidence(f), prior); assert.deepEqual(await namespace(f, path), saved);
  }
}));

test("reconciliation history resumes failed base sync and promotes exact-tree evidence without visiting the settled leaf", async (t) => withFixture(t, {}, async (f) => {
  const path = await allocate(f), removes = f.calls.removes.length;
  assert.equal(await f.full({ retainWorktree: true }), true);
  const prior = evidence(f), saved = await namespace(f, path), graph = await landRetainedPr(f);
  f.failBaseSync = 1; await assert.rejects(f.sync(), /Fixture base synchronization is unavailable/);
  assert.deepEqual(f.run().leafPr.merged, graph); assert.equal(f.store.get().orchestrator.baseSyncPending, true);
  assert.equal(await f.git.resolveRef("main"), f.base); assert.deepEqual(baselineAt(f, graph.targetCommit), []);
  const cadence = mergeCadence(f), before = reconciliationWork(f);
  await f.restart(); await f.sync();
  assert.equal(workSince(f, before).observations, 0); assert.equal(workSince(f, before).proofs, 0);
  assert.equal(workSince(f, before).baseSyncs, 1); assert.equal(workSince(f, before).samples, 0); assert.equal(workSince(f, before).models, 0);
  assert.equal(await f.git.resolveRef("main"), graph.targetCommit); assert.equal(f.store.get().orchestrator.baseSyncPending, false);
  const promoted = baselineAt(f, graph.targetCommit);
  assert.deepEqual(promoted.map((row) => [row.evaluationId, row.score]).sort(), [["command", 60], ["prompt", 55]]);
  assert.equal(promoted.find((row) => row.evaluationId === "prompt").promptSampleCount, 3);
  for (const row of promoted) {
    assert.ok(row.sourceRunIds.length > 0); assert.equal(row.agentRunId, undefined); assert.equal(row.leafSample, undefined);
    assert.ok(row.sourceRunIds.every((id) => prior.rows.some((source) => source.id === id)));
  }
  assertOriginalRows(f, prior.rows); assert.deepEqual(f.run().fullEvaluationHistory, prior.history);
  assert.deepEqual(f.run().reviewRounds, prior.reviews); assert.deepEqual(mergeCadence(f), cadence);
  assert.deepEqual(await namespace(f, path), saved); noRemoval(f, removes);
}));

test("reconciliation history remains available to the public missing-baseline owner after flag-clearing acknowledgment is lost", async (t) => withFixture(t, {}, async (f) => {
  const path = await allocate(f); assert.equal(await f.full({ retainWorktree: true }), true);
  const prior = evidence(f), saved = await namespace(f, path), graph = await landRetainedPr(f);
  f.failBaseSync = 1; await assert.rejects(f.sync(), /Fixture base synchronization is unavailable/);
  const cadence = mergeCadence(f);
  await f.restart(); f.cutAfterBaseClear = true;
  await assert.rejects(f.sync(), /Fixture stopped after durable base-sync flag clearing/);
  assert.equal(f.baseClearCutHit, true); assert.equal(f.store.get().orchestrator.baseSyncPending, false);
  assert.equal(f.store.get().orchestrator.lastEvaluationAt, undefined); assert.deepEqual(baselineAt(f, graph.targetCommit), []);
  assert.equal(await f.git.resolveRef("main"), graph.targetCommit);
  await f.restart(); const before = reconciliationWork(f);
  await f.server.orchestrator.runBaselineEvaluations();
  assert.equal(baselineAt(f, graph.targetCommit).length, 2);
  assert.equal(workSince(f, before).samples, 0); assert.equal(workSince(f, before).models, 0);
  assert.equal(workSince(f, before).observations, 0); assert.equal(workSince(f, before).proofs, 0);
  assert.deepEqual(f.calls.baselineRequests, []); assertOriginalRows(f, prior.rows);
  assert.deepEqual(f.run().fullEvaluationHistory, prior.history); assert.deepEqual(f.run().reviewRounds, prior.reviews);
  assert.deepEqual(mergeCadence(f), cadence); assert.deepEqual(await namespace(f, path), saved);
}));

test("reconciliation history never qualifies current baseline reuse across policy, negative, screening, tree or unavailable-source refusals", async (t) => {
  for (const kind of ["policy", "negative", "screening", "wrong tree", "unavailable source"]) await t.test(kind, async (t) => withFixture(t, { screening: kind === "screening" }, async (f) => {
    const path = await allocate(f);
    if (kind === "negative") f.scores.prompt = 40;
    if (kind !== "screening") assert.equal(await f.full({ retainWorktree: true }), kind !== "negative");
    else {
      assert.ok(f.run().continuation.evaluation.evaluations.some((entry) => entry.mode === "screening-command"));
      assert.equal(f.run().leafQualificationPolicy, "separate-full"); assert.equal(latestFullAssessment(f.run()), undefined);
    }
    const graph = await landRetainedPr(f, { newer: kind === "wrong tree" });
    f.failBaseSync = 1; await assert.rejects(f.sync(), /Fixture base synchronization is unavailable/);
    assert.deepEqual(f.run().leafPr.merged, graph); assert.equal(f.store.get().orchestrator.baseSyncPending, true);
    if (kind === "policy") await f.store.update((state) => { state.evaluations[1].weight = 2; });
    // Rename only this disposable local source reference after its genuine
    // proof. The retained checkout/bytes stay intact; current source lookup fails.
    if (kind === "unavailable source") await git(path, "branch", "-m", "fixture/unavailable-source");
    const prior = evidence(f), saved = await namespace(f, path), fact = clone(f.run().leafPr.merged);
    await f.restart(); const before = reconciliationWork(f);
    const syncResult = await f.sync().then(() => undefined, (error) => error);
    if (kind === "unavailable source") assert.match(syncResult?.message ?? "", /unknown|ambiguous|revision|resolve|not found|valid/i);
    else assert.equal(syncResult, undefined);
    assert.equal(workSince(f, before).observations, 0); assert.equal(workSince(f, before).proofs, 0);
    assert.equal(workSince(f, before).samples, 0); assert.deepEqual(f.calls.baselineRequests, []);
    assert.deepEqual(baselineAt(f, graph.targetCommit), []); assert.equal(f.store.get().orchestrator.baseSyncPending, false);
    // The explicit baseline owner may now choose fresh sampling. Stop at that
    // external fake boundary; do not turn history into a fabricated success.
    f.probeMissingBaseline = true;
    await f.server.orchestrator.runBaselineEvaluations().catch((error) => {
      assert.match(error.message, /Fixture stopped|unknown|ambiguous|revision|resolve|not found|valid/i);
    });
    if (kind !== "unavailable source") assert.ok(f.calls.baselineRequests.length > 0);
    assert.deepEqual(baselineAt(f, graph.targetCommit), []); assertOriginalRows(f, prior.rows);
    assert.deepEqual(f.run().leafPr.merged, fact); assert.deepEqual(f.run().fullEvaluationHistory, prior.history);
    assert.deepEqual(f.run().reviewRounds, prior.reviews); assert.deepEqual(f.calls.samples, prior.samples); assert.deepEqual(f.calls.models, prior.models);
    assert.deepEqual(await namespace(f, path), saved);
  }));
});

test("creation before failed active-pointer save retains the deterministic checkout for exact restart discovery", async (t) => withFixture(t, {}, async (f) => {
  const oldPath = f.run().worktree, offset = f.calls.removes.length;
  f.onCreate = ignored;
  f.stateCut = { when: "before", hit: false, matches: (before, after) => before?.retainWorktree === true && after?.worktree !== before.worktree };
  await assert.rejects(f.full({ retainWorktree: true }), /Fixture state cut/);
  assert.equal(f.stateCut.hit, true); assert.equal(f.run().retainWorktree, true); assert.equal(f.run().worktree, oldPath);
  const path = f.paths()[1], saved = await namespace(f, path), creates = allocations(f);
  noRemoval(f, offset); f.stateCut = undefined; await f.restart();
  assert.equal(await f.full(), true); assert.equal(f.run().worktree, path); assert.equal(f.run().retainWorktree, true);
  assert.deepEqual(await namespace(f, path), saved); assert.equal(allocations(f), creates, "discovery reuses exact extant identity without another Git allocation"); noRemoval(f, offset);
}));

test("retention admission validates literal true and established ownership before execution, with durable latch write cuts", async (t) => {
  await t.test("false and malformed values", async (t) => withFixture(t, {}, async (f) => {
    const prior = evidence(f), creates = allocations(f), removes = f.calls.removes.length;
    for (const value of [false, null, "true", 1, {}, []]) await assert.rejects(f.full({ retainWorktree: value }), /retainWorktree|retention/i);
    assert.equal(Object.hasOwn(f.run(), "retainWorktree"), false); assert.deepEqual(evidence(f), prior);
    assert.equal(allocations(f), creates); assert.equal(f.calls.removes.length, removes);
  }));
  await t.test("unpublished leaf", async (t) => withFixture(t, { published: false }, async (f) => {
    const prior = evidence(f), path = f.run().worktree, saved = await namespace(f, path);
    await assert.rejects(f.full({ retainWorktree: true }), /numbered|published|pull request|PR/i);
    assert.equal(Object.hasOwn(f.run(), "retainWorktree"), false); assert.deepEqual(evidence(f), prior); assert.deepEqual(await namespace(f, path), saved);
  }));
  await t.test("unknown legacy ownership cannot latch before proof", async (t) => withFixture(t, {}, async (f) => {
    await f.store.update((state) => { delete state.agentRuns[0].leafPr; });
    const before = clone(f.run()), prior = evidence(f), creates = allocations(f), removes = f.calls.removes.length;
    await assert.rejects(f.full({ retainWorktree: true }), /legacy|proof|owner/i);
    assert.deepEqual(f.run(), before); assert.deepEqual(evidence(f), prior); assert.equal(Object.hasOwn(f.run(), "retainWorktree"), false);
    assert.equal(allocations(f), creates); assert.equal(f.calls.removes.length, removes);
  }));
  for (const when of ["before", "after"]) await t.test(`${when} durable latch write`, async (t) => withFixture(t, {}, async (f) => {
    const prior = evidence(f), creates = allocations(f), removes = f.calls.removes.length;
    f.onCreate = ignored; f.requireLatch = true;
    f.stateCut = { when, hit: false, matches: (before, after) => before && before.retainWorktree !== true && after?.retainWorktree === true };
    if (when === "before") {
      await assert.rejects(f.full({ retainWorktree: true }), /Fixture state cut/);
      assert.equal(Object.hasOwn(f.run(), "retainWorktree"), false); assert.deepEqual(evidence(f), prior);
      assert.equal(allocations(f), creates); assert.equal(f.calls.removes.length, removes);
    } else {
      assert.equal(await f.full({ retainWorktree: true }), true);
      assert.equal(f.run().retainWorktree, true); assert.equal((await f.persistedRun()).retainWorktree, true);
      assert.equal(allocations(f), creates + 1); noRemoval(f, removes);
      assert.equal(f.run().fullEvaluationHistory.length, 1, "lost acknowledgment cannot create a second full experiment");
    }
    assert.equal(f.stateCut.hit, true);
  }));
});

test("optional cleanup observes a retained durable successor rather than deleting from a stale claimed snapshot", async (t) => withFixture(t, {}, async (f) => {
  const path = await allocate(f), saved = await namespace(f, path), offset = f.calls.removes.length;
  f.latchAtFullAck = true;
  await f.full().catch(() => undefined); // Exact owner drift may refuse; optional destruction never gains authority.
  assert.equal(f.racedLatch, true, "the fixture writer must race only after real full publication acknowledgment");
  assert.equal(f.run().retainWorktree, true); assert.deepEqual(await namespace(f, path), saved); noRemoval(f, offset);
  await f.restart(); assert.equal(f.run().retainWorktree, true); assert.deepEqual(await namespace(f, path), saved);
}));

test("an exhausted numbered leaf latches retention and closes without allocating an absent repair checkout", async (t) => withFixture(t, {}, async (f) => {
  f.scores.prompt = 40;
  assert.equal(await f.full(), false);
  assert.equal(f.pr.state, "OPEN", "the full rejection was retryable under its original review capacity");
  assert.equal(latestFullAssessment(f.run()).qualified, false);
  for (const path of f.paths()) await assert.rejects(fs.lstat(path), { code: "ENOENT" });
  await f.store.update((state) => { state.settings.maxReviewRounds = f.run().reviewRounds.length; });
  await f.restart(); f.requireLatch = true;
  const prior = evidence(f), creates = allocations(f), removes = f.calls.removes.length;
  await f.retry({ retainWorktree: true }).catch(() => undefined);
  assert.equal((await f.persistedRun()).retainWorktree, true, "the admitted one-way latch survives terminal refusal");
  assert.equal(f.pr.state, "CLOSED"); assert.equal(f.run().leafPr.known.fields.state, "CLOSED");
  assert.equal(canRetryAgent(f.run()), false);
  assert.deepEqual(evidence(f), prior, "closing exhausted review capacity does not repeat scientific or model work");
  assert.equal(allocations(f), creates, "no repair checkout is allocated when no repair can be admitted");
  assert.equal(f.calls.removes.length, removes);
  for (const path of f.paths()) await assert.rejects(fs.lstat(path), { code: "ENOENT" });
}));

test("actual HTTP retry carries literal retention and HTTP retry/refresh reject coercible false or malformed values", async (t) => withFixture(t, {}, async (f) => {
  f.scores.prompt = 40; assert.equal(await f.full(), false);
  const address = f.server.server.address(); assert.equal(typeof address, "object");
  const post = (route, value) => fetch(`http://127.0.0.1:${address.port}/api/agents/${f.run().id}/${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ retainWorktree: value }),
  });
  for (const method of ["retryAgent", "refreshAgentBaseAndRetry"]) {
    const operation = f.server.orchestrator[method].bind(f.server.orchestrator);
    t.mock.method(f.server.orchestrator, method, (...args) => { const work = operation(...args); f.operations.push(work); return work; });
  }
  f.requireLatch = true;
  const prior = evidence(f), removes = f.calls.removes.length, creates = allocations(f);
  for (const route of ["retry", "rebase-retry"]) for (const value of [false, "true", 1, null]) {
    const response = await post(route, value); assert.equal(response.status, 400, await response.text());
  }
  assert.deepEqual(evidence(f), prior); assert.equal(allocations(f), creates); assert.equal(f.calls.removes.length, removes);
  let entered;
  const started = new Promise((done) => { entered = done; });
  const release = new Promise((done) => { f.cancelAuthor = done; });
  f.onAuthor = async () => { entered(); await release; };
  f.onCreate = ignored; f.scores.prompt = 55;
  const response = await post("retry", true); assert.equal(response.status, 202, await response.text());
  const work = f.operations.at(-1);
  await reaches(work, started);
  assert.equal((await f.persistedRun()).retainWorktree, true, "uncoerced HTTP opt-in must reach admission before author work");
  const path = f.run().worktree; assert.ok(f.paths().includes(path));
  f.cancelAuthor();
  const result = await work;
  assert.equal(result.status, "completed", result.error); assert.equal(result.retainWorktree, true);
  assert.deepEqual(await fs.readFile(join(path, "ignored/sentinel.bin")), sentinel["ignored/sentinel.bin"]);
  noRemoval(f, removes); f.cancelAuthor = undefined;
}));

test("unselected leaves retain the existing actual delivery/full cleanup behavior", async (t) => withFixture(t, {}, async (f) => {
  assert.equal(Object.hasOwn(f.run(), "retainWorktree"), false);
  assert.ok(f.calls.removes.includes(f.paths()[0]), "ordinary delivery still invokes real optional removal");
  f.onCreate = ignored;
  assert.equal(await f.full(), true);
  assert.ok(f.calls.removes.includes(f.paths()[1]), "ordinary completed full cleanup is unchanged by another run's opt-in API");
  for (const path of f.paths()) await assert.rejects(fs.lstat(path), { code: "ENOENT" });
  assert.equal(Object.hasOwn(f.run(), "retainWorktree"), false);
}));

test("ordinary re-author materializes a genuinely cleaned-up checkout under its lease and stops at the same-session committed output", async (t) => withFixture(t,
  { scores: { prompt: 40 }, resources: ["fixture-checkout-lease"] }, async (f) => {
    const source = clone(f.run()), prior = admissionState(f), creates = allocations(f), removes = f.calls.removes.length;
    assert.equal(source.leafQualificationPolicy, "ordinary");
    assert.equal(source.continuation.evaluation.purpose, "delivery");
    assert.equal(latestFullAssessment(source), undefined);
    assert.ok(f.calls.removes.includes(f.paths()[0]), "ordinary delivery really removed the original non-retained checkout");
    await missingCheckouts(f);
    const input = reauthorInput(f);
    let allocated;
    f.onCreate = async (path) => {
      assert.equal(path, f.paths()[0]);
      assert.deepEqual(f.run(), source, "allocation cannot rewrite the completed source or publish an author request");
      assert.deepEqual((await f.server.orchestrator.locks.list()).sort(), ["fixture-checkout-lease", "git-metadata"]);
      await ignored(path); allocated = await namespace(f, path);
      assert.equal(allocated.head, source.continuation.head);
    };
    await f.reauthor(input);
    assertOrdinaryHeld(f, input, source);
    assert.ok(allocated, "the public request reached the real existing-worktree allocator");
    assert.equal(allocations(f), creates + 1);
    assert.equal(f.calls.removes.length, removes);
    assert.deepEqual(f.store.get().evaluationRuns, prior.rows);
    assert.deepEqual(f.store.get().evaluations, prior.definitions);
    assert.deepEqual(f.calls.samples, prior.samples);
    assert.deepEqual(f.calls.models, [...prior.models, "reauthor"]);
    assert.deepEqual(f.pr, prior.pr); assert.deepEqual(f.calls.pr, prior.effects);
    assert.equal(f.calls.reauthors.length, 1);
    assert.equal(f.calls.reauthors[0].thread, source.authorThreadId);
    assert.equal(f.run().reauthorRequests.at(-1).guidance, input.guidance);
    assert.ok(f.calls.reauthors[0].guidance.includes(input.guidance), "existing contextual task scope retains the exact operator guidance");
    const path = f.run().worktree, output = await namespace(f, path);
    assert.equal(output.status, ""); assert.equal(output.gitfile, allocated.gitfile);
    assert.deepEqual(output.files, allocated.files, "committed and ignored sentinel bytes survive author-only allocation");
    assert.equal(await git(path, "rev-parse", "HEAD^"), source.continuation.head);
    assert.notEqual(await f.git.tree(output.head), await f.git.tree(source.continuation.head));
    assert.equal(await f.git.remoteBranchHead(f.root, "origin", source.branch), source.continuation.head, "held output is not pushed");
    assert.deepEqual(await f.server.orchestrator.locks.list(), []);
    const held = admissionState(f), createCalls = f.calls.creates.length;
    await f.restart(); await f.reauthor(input); await f.retry();
    assert.deepEqual(admissionState(f), held, "restart and exact replay do not authorize evidence, review, sampling or PR work");
    assert.equal(f.calls.reauthors.length, 1); assert.equal(f.calls.creates.length, createCalls);
    assert.deepEqual(await namespace(f, path), output); assert.equal(f.calls.removes.length, removes);
  }));

test("ordinary re-author reuses either exact canonical checkout and atomically saves an alternate pointer with its request", async (t) => {
  for (const which of [0, 1]) await t.test(which ? "full-leaf path" : "ordinary path", async (t) => withFixture(t, { scores: { prompt: 40 } }, async (f) => {
    const path = await allocate(f, which), saved = await namespace(f, path), source = clone(f.run());
    const creates = allocations(f), createCalls = f.calls.creates.length, removes = f.calls.removes.length;
    const input = reauthorInput(f), observedPointers = [];
    f.onReauthor = async (cwd) => { assert.equal(cwd, path); assert.deepEqual(await namespace(f, path), saved); };
    const unsubscribe = f.store.subscribe((state) => {
      const run = state.agentRuns.find((item) => item.id === source.id);
      observedPointers.push({ worktree: run.worktree, admitted: Boolean(run.reauthorRequests?.length) });
    });
    try { await f.reauthor(input); } finally { unsubscribe(); }
    // Lost-listener acknowledgments are deliberately recoverable in production;
    // assert observations afterward so that recovery cannot swallow a test failure.
    assert.ok(observedPointers.some((entry) => entry.admitted));
    for (const entry of observedPointers) assert.equal(entry.worktree, entry.admitted ? path : source.worktree,
      "the canonical pointer and author request must be saved atomically");
    assertOrdinaryHeld(f, input, source);
    assert.equal(f.run().worktree, path); assert.equal((await f.persistedRun()).worktree, path);
    assert.equal(allocations(f), creates); assert.equal(f.calls.creates.length, createCalls);
    assert.equal(f.calls.removes.length, removes);
    assert.equal((await namespace(f, path)).gitfile, saved.gitfile);
    assert.deepEqual(await fs.readFile(join(path, "ignored/sentinel.bin")), sentinel["ignored/sentinel.bin"]);
  }));
});

test("ordinary re-author refuses unproven completed sources before any checkout allocation", async (t) => {
  for (const kind of ["positive delivery", "missing receipt", "changed policy", "wrong approval", "wrong remote tuple", "exhausted budget"]) {
    await t.test(kind, async (t) => withFixture(t, kind === "positive delivery" ? {} : { scores: { prompt: 40 } }, async (f) => {
      if (kind === "wrong remote tuple") f.observationPatch = { headRepository: { ...repository, id: "foreign-repository" } };
      if (!["positive delivery", "wrong remote tuple"].includes(kind)) await f.store.update((state) => {
        const run = state.agentRuns.find((item) => item.id === f.run().id);
        if (kind === "missing receipt") delete run.continuation.evaluation;
        if (kind === "changed policy") state.evaluations[1].weight = 2;
        if (kind === "wrong approval") run.continuation.evaluation.approvalRoundId = "unrelated-approval";
        if (kind === "exhausted budget") state.settings.maxReviewRounds = run.reviewRounds.length;
      });
      const input = reauthorInput(f), before = admissionState(f), creates = allocations(f), createCalls = f.calls.creates.length, removes = f.calls.removes.length;
      await missingCheckouts(f);
      await assert.rejects(f.reauthor(input));
      assert.deepEqual(admissionState(f), before);
      assert.equal(allocations(f), creates); assert.equal(f.calls.creates.length, createCalls, "even the canonical allocator must not be entered before proof");
      assert.equal(f.calls.removes.length, removes); await missingCheckouts(f);
      assert.deepEqual(await f.server.orchestrator.locks.list(), []);
    }));
  }
});

test("ordinary re-author preserves invalid extant namespaces, including the other canonical candidate and clean pending Git work", async (t) => {
  const cases = ["dirty saved", "dirty alternate", "foreign branch", "foreign HEAD", "foreign repository", "foreign file",
    "checkout symlink", "ancestor symlink", "unreadable checkout", "unreadable ancestor", "dual paths", "pending merge"];
  for (const kind of cases) await t.test(kind, async (t) => withFixture(t, { scores: { prompt: 40 } }, async (f) => {
    const which = ["dirty alternate", "foreign repository", "foreign file"].includes(kind) ? 1 : 0;
    const path = f.paths()[which], directory = dirname(path);
    let saved, inspectPath = path, restore = async () => {}, mergeHead;
    if (kind === "foreign file") await fs.writeFile(path, "foreign namespace bytes\n");
    else if (kind === "foreign repository") {
      await fs.mkdir(path, { recursive: true }); await git(path, "init", "-b", f.run().branch);
      await fs.writeFile(join(path, "foreign.txt"), "foreign repository bytes\n");
      await git(path, "add", "."); await git(path, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "foreign repository");
    } else {
      await allocate(f, which);
      if (kind.startsWith("dirty")) await dirty(path);
      if (kind === "foreign branch") await git(path, "switch", "-c", "fixture/foreign");
      if (kind === "foreign HEAD") await git(path, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "--allow-empty", "-m", "foreign head");
      if (kind === "dual paths") { await git(f.root, "worktree", "add", "--force", f.paths()[1], f.run().branch); await ignored(f.paths()[1]); }
      if (kind === "pending merge") {
        await git(f.root, "switch", "-c", "fixture/pending-merge", f.base);
        await git(f.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "--allow-empty", "-m", "parallel empty change");
        const other = await f.git.head(f.root); await git(f.root, "switch", "main");
        await git(path, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "merge", "--no-ff", "--no-commit", other);
        assert.equal(await git(path, "status", "--porcelain"), "", "a pending merge is not necessarily a dirty tree");
        mergeHead = resolve(path, await git(path, "rev-parse", "--git-path", "MERGE_HEAD"));
        assert.equal((await fs.readFile(mergeHead, "utf8")).trim(), other);
      }
      if (kind === "checkout symlink") {
        inspectPath = join(f.sandbox, "moved-ordinary-checkout");
        await git(f.root, "worktree", "move", path, inspectPath); await fs.symlink(inspectPath, path, "dir");
      }
      saved = await namespace(f, inspectPath);
      if (kind === "ancestor symlink") {
        const moved = join(f.sandbox, "moved-ordinary-namespace");
        await fs.rename(directory, moved); await fs.symlink(moved, directory, "dir");
        restore = async () => { assert.equal((await fs.lstat(directory)).isSymbolicLink(), true); assert.equal(await fs.readlink(directory), moved);
          await fs.unlink(directory); await fs.rename(moved, directory); };
      }
      if (kind.startsWith("unreadable")) {
        const inaccessible = kind === "unreadable ancestor" ? directory : path;
        await fs.chmod(inaccessible, 0o000);
        restore = async () => { assert.equal((await fs.lstat(inaccessible)).mode & 0o777, 0); await fs.chmod(inaccessible, 0o755); };
      }
    }
    const before = admissionState(f), creates = allocations(f), createCalls = f.calls.creates.length, removes = f.calls.removes.length;
    const registrations = await git(f.root, "worktree", "list", "--porcelain"), pending = mergeHead && await fs.readFile(mergeHead, "utf8");
    try {
      await assert.rejects(f.reauthor(reauthorInput(f)));
      assert.deepEqual(admissionState(f), before); assert.equal(allocations(f), creates); assert.equal(f.calls.creates.length, createCalls);
      assert.equal(f.calls.removes.length, removes);
      assert.equal(await git(f.root, "worktree", "list", "--porcelain"), registrations);
      if (kind === "checkout symlink") { assert.equal((await fs.lstat(path)).isSymbolicLink(), true); assert.equal(await fs.readlink(path), inspectPath); }
      if (mergeHead) assert.equal(await fs.readFile(mergeHead, "utf8"), pending);
    } finally { await restore(); }
    if (saved) assert.deepEqual(await namespace(f, inspectPath), saved);
    if (kind === "foreign file") assert.equal(await fs.readFile(path, "utf8"), "foreign namespace bytes\n");
    if (kind === "foreign repository") assert.equal(await fs.readFile(join(path, "foreign.txt"), "utf8"), "foreign repository bytes\n");
    if (kind === "dual paths") assert.deepEqual(await fs.readFile(join(f.paths()[1], "ignored/sentinel.bin")), sentinel["ignored/sentinel.bin"]);
    assert.deepEqual(await f.server.orchestrator.locks.list(), []);
  }));
});

test("ordinary re-author allocation cannot recover a missing retained checkout or already-held author/commit", async (t) => {
  for (const checkpoint of ["retained", "author", "commit"]) await t.test(checkpoint, async (t) => withFixture(t, { scores: { prompt: 40 } }, async (f) => {
    const input = reauthorInput(f);
    if (checkpoint === "retained") {
      assert.equal(await f.full({ retainWorktree: true }), false, "establish the real one-way retention owner");
      assert.equal(f.run().retainWorktree, true);
    } else {
      if (checkpoint === "author") f.failReauthor = true;
      else f.stateCut = { when: "before", hit: false, matches: (before, after) => before?.continuation?.step === "commit" && after?.continuation?.step === "evidence" };
      await f.reauthor(input);
      assert.equal(f.run().continuation.step, checkpoint);
      assert.equal(f.run().reauthorRequests.at(-1).output, undefined);
      if (checkpoint === "commit") assert.equal(f.stateCut.hit, true);
      f.failReauthor = false; f.stateCut = undefined;
    }
    await f.git.removeWorktree(f.run().worktree); await missingCheckouts(f);
    await f.restart();
    const before = admissionState(f), creates = allocations(f), createCalls = f.calls.creates.length, removes = f.calls.removes.length;
    const request = checkpoint === "retained" ? reauthorInput(f) : input;
    await assert.rejects(f.reauthor(request), /missing|unknown allocation|loss|reconcil|worktree/i);
    if (checkpoint !== "retained") await assert.rejects(f.retry(), /missing|unknown allocation|loss|reconcil|worktree/i);
    assert.deepEqual(admissionState(f), before); assert.equal(allocations(f), creates); assert.equal(f.calls.creates.length, createCalls);
    assert.equal(f.calls.removes.length, removes); await missingCheckouts(f);
  }));
});

test("ordinary re-author rechecks source, policy, remote and cleanliness after allocation without removing the refused checkout", async (t) => {
  for (const race of ["dirty checkout", "moved branch", "policy", "receipt", "remote close"]) await t.test(race, async (t) => withFixture(t, { scores: { prompt: 40 } }, async (f) => {
    const input = reauthorInput(f), source = clone(f.run()), creates = allocations(f), removes = f.calls.removes.length;
    let allocated, afterRace;
    f.onCreate = async (path) => {
      assert.deepEqual(f.run(), source); await ignored(path);
      if (race === "dirty checkout") await dirty(path);
      if (race === "moved branch") await git(path, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "--allow-empty", "-m", "raced head");
      if (race === "remote close") f.pr.state = "CLOSED";
      if (race === "policy" || race === "receipt") await f.store.update((state) => {
        if (race === "policy") state.evaluations[1].weight = 2;
        else state.agentRuns.find((run) => run.id === source.id).continuation.evaluation.approvalRoundId = "raced-approval";
      });
      allocated = await namespace(f, path); afterRace = admissionState(f);
    };
    await assert.rejects(f.reauthor(input));
    assert.ok(allocated, "the race occurs only after a real checkout allocation");
    assert.equal(allocations(f), creates + 1); assert.equal(f.calls.removes.length, removes);
    assert.deepEqual(admissionState(f), afterRace, "refusal cannot rewrite the old source, ownership, evidence, or author-request ledger");
    assert.equal(f.run().reauthorRequests, undefined);
    assert.deepEqual(await namespace(f, f.paths()[0]), allocated);
    assert.deepEqual(await f.server.orchestrator.locks.list(), []);
  }));
});

test("ordinary re-author preserves a newly allocated checkout across admission write cuts and exactly discovers it on restart", async (t) => {
  for (const when of ["before", "after"]) await t.test(when, async (t) => withFixture(t, { scores: { prompt: 40 } }, async (f) => {
    const input = reauthorInput(f), source = clone(f.run()), before = admissionState(f), creates = allocations(f), removes = f.calls.removes.length;
    let allocated;
    f.onCreate = async (path) => { await ignored(path); allocated = await namespace(f, path); };
    f.stateCut = { when, hit: false, matches: (oldRun, newRun) => !oldRun?.reauthorRequests?.length && newRun?.reauthorRequests?.length === 1 };
    if (when === "before") {
      await assert.rejects(f.reauthor(input), /Fixture state cut/);
      assert.deepEqual(admissionState(f), before); assert.equal(f.calls.reauthors.length, 0);
      assert.deepEqual(await namespace(f, f.paths()[0]), allocated);
    } else {
      await f.reauthor(input); assertOrdinaryHeld(f, input, source);
      assert.equal(f.calls.reauthors.length, 1);
    }
    assert.equal(f.stateCut.hit, true); assert.equal(allocations(f), creates + 1); assert.equal(f.calls.removes.length, removes);
    const createCalls = f.calls.creates.length;
    f.stateCut = undefined; f.onCreate = undefined;
    await f.restart(); await f.reauthor(input);
    assertOrdinaryHeld(f, input, source);
    assert.equal(f.run().reauthorRequests.length, 1); assert.equal(f.calls.reauthors.length, 1);
    assert.equal(allocations(f), creates + 1); assert.equal(f.calls.creates.length, createCalls);
    assert.equal(f.calls.removes.length, removes);
    const saved = await namespace(f, f.run().worktree);
    assert.equal(saved.gitfile, allocated.gitfile); assert.deepEqual(saved.files, allocated.files);
    assert.deepEqual(f.store.get().evaluationRuns, before.rows); assert.deepEqual(f.calls.samples, before.samples);
    assert.deepEqual(f.calls.models, [...before.models, "reauthor"]); assert.deepEqual(f.pr, before.pr); assert.deepEqual(f.calls.pr, before.effects);
  }));
});
