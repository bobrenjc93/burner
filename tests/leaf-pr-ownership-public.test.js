import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { CodexClient } from "../dist/lib/codex.js";
import { GitService, TransientMergeGateError } from "../dist/lib/git.js";
import { canRetryAgent, latestFullAssessment, selectYoloLeafBatch, selectYoloMergeCandidate } from "../dist/lib/orchestrator.js";
import { runCommand } from "../dist/lib/process.js";
import { StateStore } from "../dist/lib/store.js";
import { createBurnerServer } from "../dist/server.js";

const repository = { host: "github.example.test", id: "R_public_fixture", nameWithOwner: "fixture/leaf-owner" };
const url = (number = 42) => `https://${repository.host}/${repository.nameWithOwner}/pull/${number}`;
const mergeStop = "Fixture merge transport unavailable";
const tuple = (value) => ({ title: value.title, body: value.body, isDraft: value.isDraft, state: value.state });
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const effectName = (effect) => effect.kind === "edit" ? `edit:${effect.field}` : effect.kind;
const clone = (value) => structuredClone(value);

async function gitCommand(cwd, ...args) {
  const result = await runCommand("git", args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function executable(path) {
  assert.equal(lstatSync(path).isFile(), true, "fixture executable must be a regular non-symlink file");
  assert.equal(realpathSync(path), path, "fixture executable must not resolve through symlinks");
  accessSync(path, constants.X_OK);
  return path;
}

function installGuards(t, f) {
  const savedPath = process.env.PATH;
  const savedTmp = process.env.TMPDIR;
  const gitPath = savedPath.split(delimiter).map((directory) => join(directory, "git")).find((path) => {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  });
  assert.ok(gitPath);
  const actualGit = realpathSync(gitPath);
  const local = (path) => {
    const absolute = resolve(path);
    assert.ok(absolute === f.sandbox || absolute.startsWith(`${f.sandbox}${sep}`), `outside fixture: ${absolute}`);
    let existing = absolute;
    while (true) {
      try { lstatSync(existing); break; }
      catch (error) {
        if (error.code !== "ENOENT" || existing === f.sandbox) throw error;
        existing = dirname(existing);
      }
    }
    // Removed delivery checkouts may be probed normally; symlink escapes may not.
    assert.equal(realpathSync(existing), existing);
  };
  process.env.PATH = `${f.bin}${delimiter}${savedPath}`;
  process.env.TMPDIR = join(f.sandbox, "tmp");
  f.modelBoundary = (cwd) => {
    local(cwd);
    assert.equal(process.env.PATH.split(delimiter)[0], f.bin);
    executable(join(f.bin, "codex"));
  };
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) => {
    try {
      local(options.cwd);
      const env = { PATH: `${dirname(actualGit)}${delimiter}/usr/bin${delimiter}/bin`, LANG: "C",
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" };
      if (options.env?.GIT_INDEX_FILE) { local(dirname(options.env.GIT_INDEX_FILE)); env.GIT_INDEX_FILE = options.env.GIT_INDEX_FILE; }
      if (options.env?.GIT_NO_REPLACE_OBJECTS !== undefined) {
        assert.equal(options.env.GIT_NO_REPLACE_OBJECTS, "1");
        env.GIT_NO_REPLACE_OBJECTS = "1";
      }
      if (options.env?.GIT_GRAFT_FILE !== undefined) {
        assert.equal(options.env.GIT_GRAFT_FILE, "/dev/null");
        env.GIT_GRAFT_FILE = "/dev/null";
      }
      if (command === "git") {
        if (args[0] === "push") f.calls.gitPushes.push({ cwd: options.cwd, args: [...args] });
        return spawn(actualGit, args, { ...options, env });
      }
      assert.equal(command, "gh", "no model, shell, or other executable fallthrough");
      assert.ok(equal(args, ["--version"]) || equal(args, ["auth", "status"]), "only isolated fake readiness probes may execute");
      return spawn(executable(join(f.bin, "gh")), args, { ...options, env });
    } catch (error) { f.calls.blocked.push({ command, args, error: error.message }); throw error; }
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.spawn = spawn;
    syncBuiltinESMExports();
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
  });
}

function installFakes(t, f) {
  const modelCall = (cwd, method) => { f.modelBoundary(cwd); f.calls.models.push(method); };
  const session = () => ({ threadId: "fixture-author", message: `Fixture author response ${f.calls.models.length}` });
  const models = {
    close: () => undefined,
    preflight: async (cwd) => f.modelBoundary(cwd),
    available: async (cwd) => { f.modelBoundary(cwd); return false; },
    implement: async (cwd) => { modelCall(cwd, "implement"); await writeFile(join(cwd, "code.txt"), "authored leaf\n"); return session(); },
    revise: async (cwd, threadId) => {
      modelCall(cwd, "revise");
      assert.equal(threadId, "fixture-author");
      await writeFile(join(cwd, "code.txt"), `revised leaf ${f.calls.models.length}\n`);
      return session();
    },
    refreshAgentEvidence: async (cwd) => { modelCall(cwd, "evidence"); return session(); },
    review: async (cwd) => {
      modelCall(cwd, "review");
      return { approved: f.reviewApproval, summary: f.reviewApproval ? "Fixture approval" : "Fixture rejected review",
        findings: f.reviewApproval ? [] : [{ severity: "high", title: "Unapproved fixture", detail: "Retain the unanswered review", file: "code.txt" }] };
    },
    evaluate: async (cwd, evaluation, _settings, context, _baseline, evidence) => {
      f.modelBoundary(cwd);
      if (context !== "agent" && context !== "composite") f.calls.blocked.push({ method: "evaluate", context });
      assert.ok(context === "agent" || context === "composite", "no campaign/baseline sampling");
      f.calls.samples.push({ id: evaluation.id, context, phase: f.phase });
      const output = { score: f.scores[evaluation.id], summary: `${f.phase} ${evaluation.id} evidence`, evidence: ["isolated fixture"], suggestions: [] };
      if (evaluation.command) {
        assert.ok(evidence);
        evidence.startCommand();
        if (f.commandArtifact) await writeFile(join(evidence.artifactDir, "fixture.bin"), f.commandArtifact);
        const stdout = JSON.stringify(output);
        evidence.append("stdout", stdout);
        await evidence.recordCommand({ stdout, stderr: "", exitCode: 0 });
        await evidence.recordNormalized(output);
      }
      return output;
    },
  };
  for (const method of Object.getOwnPropertyNames(CodexClient.prototype)) {
    if (method !== "constructor") t.mock.method(CodexClient.prototype, method, models[method] ?? (() => {
      f.calls.blocked.push({ method });
      assert.fail(`unmocked Codex effect: ${method}`);
    }));
  }

  f.observation = async (pr = f.world.pr) => {
    assert.ok(pr, "no fixture PR exists");
    const observed = { repository: clone(repository), headRepository: clone(repository), baseRepository: clone(repository),
      number: pr.number, url: pr.url, headRefName: pr.branch,
      headRefOid: await f.git.remoteBranchHead(f.root, "origin", pr.branch), baseRefName: "main", baseRefOid: f.world.target ?? f.base,
      ...(pr.mergeCommit ? { mergeCommit: pr.mergeCommit } : {}),
      ...tuple(pr), mergeable: "MERGEABLE", statusCheckRollup: [{ name: "fixture-check", status: "COMPLETED", conclusion: f.checkFailure ? "FAILURE" : "SUCCESS" }],
      ...clone(f.observationPatch ?? {}) };
    await f.onObserve?.(observed);
    return observed;
  };
  const scope = (cwd, repo, number) => {
    assert.equal(cwd, f.root);
    assert.deepEqual(repo, repository);
    if (number !== undefined) assert.equal(number, 42);
  };
  f.effect = async (name, apply) => {
    const saved = await f.persistedRun();
    const pending = saved.leafPr?.pending;
    assert.ok(pending?.effect, `${name}: durable concrete effect must precede the request`);
    assert.equal(effectName(pending.effect), name);
    const effect = clone(pending.effect);
    assert.deepEqual(Object.keys(effect.after).sort(), ["body", "isDraft", "state", "title"]);
    if (effect.kind !== "create") {
      assert.deepEqual(tuple(f.world.pr), effect.before, "request requires the complete saved before tuple");
      assert.deepEqual(saved.leafPr.known.fields, effect.before, "known cannot advance before acknowledgment");
    }
    const call = { name, pending: clone(pending), known: clone(saved.leafPr.known), applied: false };
    f.calls.effects.push(call);
    const cut = f.fault?.name === name && !f.fault.hit ? f.fault : undefined;
    if (cut) { cut.hit = true; cut.call = call; }
    if (cut?.cut === "request-error") throw new TransientMergeGateError(`Fixture ${name} request failed before effect`);
    await apply();
    call.applied = true;
    assert.deepEqual(tuple(f.world.pr), effect.after);
    await f.afterEffect?.(name, call);
    if (cut?.cut === "lost-response") throw new TransientMergeGateError(`Fixture ${name} response lost after effect`);
  };
  const github = {
    leafRepository: async (cwd, remote) => { assert.equal(cwd, f.root); assert.equal(remote, "origin"); return clone(repository); },
    observeLeafPr: async (cwd, repo, number) => { scope(cwd, repo, number); f.calls.observations += 1; return f.observation(); },
    findLeafPrs: async (cwd, repo, branch) => {
      scope(cwd, repo);
      assert.equal(branch, f.run().branch);
      f.calls.searches += 1;
      if (f.searchError) throw new Error("Fixture exhaustive all-state search unavailable");
      if (f.searchMatches) return clone(f.searchMatches);
      return f.world.pr ? [await f.observation()] : [];
    },
    createLeafPr: async (options) => {
      scope(options.cwd, options.repository);
      assert.equal(options.baseBranch, "main");
      assert.equal(options.branch, f.run().branch);
      assert.ok(f.calls.searches > 0, "exhaustive absence must precede creation");
      await f.effect("create", async () => {
        assert.equal(f.world.pr, undefined, "creation may not replace an existing PR");
        f.world.pr = { number: 42, url: url(), branch: options.branch, title: options.title, body: options.body, isDraft: options.isDraft, state: "OPEN" };
      });
      return { number: 42, url: url() };
    },
    editLeafPrField: async (cwd, repo, number, field, value) => {
      scope(cwd, repo, number);
      await f.effect(`edit:${field}`, async () => { f.world.pr[field] = value; });
    },
    setLeafPrDraft: async (cwd, repo, number, isDraft) => {
      scope(cwd, repo, number);
      await f.effect(isDraft ? "draft" : "ready", async () => {
        if (!isDraft && f.readyRace) await f.readyRace();
        f.world.pr.isDraft = isDraft;
      });
    },
    closeLeafPr: async (cwd, repo, number) => {
      scope(cwd, repo, number);
      await f.effect("close", async () => {
        if (f.closeRace) await f.closeRace();
        f.world.pr.state = "CLOSED";
      });
    },
    mergeLeafPr: async (cwd, repo, number, head) => {
      scope(cwd, repo, number);
      assert.equal(head, await f.git.remoteBranchHead(f.root, "origin", f.run().branch));
      assert.equal(f.run().leafPr.pending, undefined);
      assert.equal(f.world.pr.isDraft, false);
      assert.deepEqual(f.run().leafPr.known.fields, tuple(f.world.pr));
      f.calls.merges.push(head);
      await f.onMerge?.(head);
      throw new TransientMergeGateError(mergeStop);
    },
    leafMergePolling: () => ({ mergeAttempts: f.mergeAttempts, checkAttempts: 3, noCheckGraceAttempts: 1, intervalMs: 0 }),
    listPullRequests: async () => f.world.pr ? [{ ...await f.observation(), labels: [{ name: "burner-unmerged" }] }] : [],
    markPrDisposition: async () => undefined,
    markPrQuarantined: async () => undefined,
  };
  for (const [method, implementation] of Object.entries(github)) t.mock.method(GitService.prototype, method, implementation);
  for (const method of ["getPullRequest", "pullRequestsForBranch", "openPr", "editPr", "markPrReady", "markPrDraft", "isPrDraft", "closePr", "reopenPr", "mergePr"]) {
    t.mock.method(GitService.prototype, method, () => {
      f.calls.blocked.push({ method });
      assert.fail(`generic PR transport cannot supply leaf authority: ${method}`);
    });
  }
  const pushLeaf = GitService.prototype.pushLeaf;
  t.mock.method(GitService.prototype, "pushLeaf", async function (...args) {
    const result = await pushLeaf.apply(this, args);
    if (f.interruptProgressPush && f.run().continuation?.step === "progress" && f.run().continuation.phase === "push") {
      f.interruptProgressPush = false;
      f.interruptedProgress = clone(f.run().continuation);
      throw new Error("Fixture progress push completed before semantic acknowledgment");
    }
    return result;
  });
  const prove = GitService.prototype.proveLeafInclusion;
  t.mock.method(GitService.prototype, "proveLeafInclusion", async function (...args) {
    f.calls.proofs.push(clone(args[0]));
    return prove.apply(this, args);
  });
  const syncBase = GitService.prototype.syncBase;
  t.mock.method(GitService.prototype, "syncBase", async function (...args) {
    if (f.failBaseSync > 0) { f.failBaseSync -= 1; throw new Error("Fixture base synchronization is unavailable"); }
    return syncBase.apply(this, args);
  });
  const update = StateStore.prototype.update;
  t.mock.method(StateStore.prototype, "update", async function (mutator) {
    f.calls.writes += 1;
    const before = clone(this.get().agentRuns.find((item) => item.ideaId === "idea"));
    const result = await update.call(this, (draft) => {
      mutator(draft);
      const after = draft.agentRuns.find((item) => item.ideaId === "idea");
      const cut = f.stateCut;
      if (cut && !cut.hit && !cut.afterWrite && cut.matches(before, after)) {
        cut.hit = true;
        throw new Error("Fixture stopped before semantic acknowledgment was saved");
      }
    });
    const fault = f.fault;
    const run = this.get().agentRuns.find((item) => item.ideaId === "idea");
    const cut = f.stateCut;
    if (cut && !cut.hit && cut.afterWrite && cut.matches(before, run)) {
      cut.hit = true;
      cut.acknowledged = clone(run);
      throw new Error("Fixture semantic acknowledgment was lost after state write");
    }
    if (fault?.cut === "lost-state-ack" && fault.hit && !fault.ackHit &&
      run?.leafPr?.pending?.id === fault.call.pending.id && !run.leafPr.pending.effect &&
      equal(run.leafPr.known?.fields, fault.call.pending.effect.after)) {
      fault.ackHit = true;
      fault.acknowledged = clone(run);
      throw new Error("Fixture durable acknowledgment was lost after state write");
    }
    return result;
  });
}

async function fixture(t, options = {}) {
  const sandbox = await mkdtemp(join(tmpdir(), "burner-public-pr-owner-"));
  const root = join(sandbox, "project");
  const f = { sandbox, root, bin: join(root, "bin"), failed: false, ready: false, world: {}, phase: "delivery",
    mergeAttempts: 1, reviewApproval: true, scores: { command: 60, prompt: 55 },
    calls: { effects: [], merges: [], searches: 0, observations: 0, samples: [], models: [], gitPushes: [], blocked: [], proofs: [], writes: 0 } };
  t.after(async () => {
    await f.server?.close();
    if (f.failed || !f.ready) {
      await writeFile(join(sandbox, "fixture-effects.json"), JSON.stringify({ calls: f.calls, world: f.world, observationPatch: f.observationPatch }, null, 2));
      t.diagnostic(`Retained failed isolated PR-owner fixture: ${sandbox}`);
    } else await rm(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  await mkdir(f.bin, { recursive: true });
  await mkdir(join(sandbox, "tmp"));
  await writeFile(join(f.bin, "codex"), "#!/bin/sh\nexit 97\n");
  await writeFile(join(f.bin, "gh"), "#!/bin/sh\nexit 0\n");
  await chmod(join(f.bin, "codex"), 0o700);
  await chmod(join(f.bin, "gh"), 0o700);
  executable(join(f.bin, "codex"));
  installGuards(t, f);
  f.run = () => f.store?.get().agentRuns.find((run) => run.ideaId === "idea");
  f.persistedRun = async () => JSON.parse(await readFile(join(root, ".burner", "state.json"), "utf8")).agentRuns.find((run) => run.ideaId === "idea");
  installFakes(t, f);
  await gitCommand(root, "init", "-b", "main");
  await gitCommand(root, "config", "gc.auto", "0");
  await gitCommand(root, "config", "maintenance.auto", "false");
  await writeFile(join(root, ".gitignore"), ".burner/\nbin/\n");
  await writeFile(join(root, "README.md"), "# PR ownership fixture\n");
  await writeFile(join(root, "code.txt"), "base\n");
  f.git = new GitService(root, join(root, ".burner"));
  f.base = await f.git.commit(root, "fixture base");
  const remote = join(root, ".burner", "fixture-remote.git");
  await gitCommand(root, "init", "--bare", remote);
  await gitCommand(root, "remote", "add", "origin", remote);
  await f.git.push(root, "origin", "main");
  f.store = new StateStore(root);
  await f.store.init();
  const timestamp = new Date().toISOString();
  await f.store.update((state) => {
    Object.assign(state.settings, { autoRun: false, autoCreatePrs: true, defaultResources: [], parallelism: 1, preferLivingComposite: false,
      maxReviewRounds: options.reviewLimit ?? 4, portfolioReviewRounds: 6, stallTerminationHours: 0 });
    Object.assign(state.orchestrator, { enabled: false, lastEvaluationAt: timestamp, lastPlanningAt: timestamp });
    state.evaluations = [
      { id: "command", name: "Command", prompt: "Fixture deterministic score", command: "fixture-command-never-executed", weight: 1, enabled: true, definitionVersion: "v1", createdAt: timestamp },
      { id: "prompt", name: "Quality", prompt: "Fixture independent score", weight: 1, enabled: true, definitionVersion: "v1", createdAt: timestamp },
    ];
    state.evaluationRuns = state.evaluations.map((evaluation) => ({ id: `baseline-${evaluation.id}`, evaluationId: evaluation.id,
      evaluationDefinitionVersion: "v1", commit: f.base, context: "baseline", status: "completed", score: 50,
      ...(evaluation.command ? {} : { promptSampleCount: 3 }), summary: "Exact frozen baseline", evidence: [], suggestions: [], durationMs: 1, createdAt: timestamp }));
    state.ideas = [{ id: "idea", title: "Owned leaf", description: "Improve the isolated fixture", rationale: "PR owner public contract", predictedImpact: 10,
      evaluationIds: ["command", "prompt"], resources: [], status: "queued", source: "manual", createdAt: timestamp, updatedAt: timestamp }];
    state.agentRuns = [];
    state.composites = [];
  });
  f.restart = async () => {
    await f.server?.close();
    f.server = await createBurnerServer({ root, host: "127.0.0.1", port: 0, manual: true });
    f.store = f.server.store;
    f.git = f.server.orchestrator.git;
  };
  f.full = () => f.server.orchestrator.fullyValidateLeafForMerge(f.run().id, f.base);
  f.retry = () => f.server.orchestrator.retryAgent(f.run().id);
  f.merge = () => f.server.orchestrator.mergeAgent(f.run().id);
  f.sync = () => f.server.orchestrator.syncPullRequests(true);
  f.withdraw = (input = withdrawalInput(f)) => f.server.orchestrator.withdrawAgent(f.run().id, input);
  await f.restart();
  f.ready = true;
  return f;
}

async function withFixture(t, options, action) {
  const f = await fixture(t, options);
  try {
    await action(f);
    assert.deepEqual(f.calls.blocked, [], "every external effect stayed behind the exact leaf fakes");
  } catch (error) { f.failed = true; throw error; }
}

async function scenario(t, f, name, action) {
  await t.test(name, async () => {
    try { await action(); }
    catch (error) { f.failed = true; throw error; }
  });
}

async function attempt(action) {
  try { return { value: await action() }; } catch (error) { return { error }; }
}

function evidenceSnapshot(f) {
  return clone({ samples: f.calls.samples, models: f.calls.models, reviews: f.run().reviewRounds,
    full: f.run().fullEvaluationHistory, delivery: f.run().continuation?.evaluation });
}

function assertEvidenceUnchanged(f, saved) { assert.deepEqual(evidenceSnapshot(f), saved, "PR recovery must not sample, reauthor, rereview, or rewrite completed evidence"); }

async function deliver(f) {
  const run = await f.server.orchestrator.runNextIdea();
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.continuation.step, "done");
  assert.ok(run.continuation.evaluation.result.completedAt);
  assert.equal(run.continuation.evaluation.purpose, "delivery");
  assert.equal(run.leafPr.version, 1);
  assert.deepEqual(run.leafPr.known.fields, tuple(f.world.pr));
  assert.equal(run.leafPr.pending, undefined);
  assert.ok(run.leafPr.creationToken);
  assert.ok(f.world.pr.body.includes(`<!-- burner-leaf:${run.leafPr.creationToken} -->`));
  return run;
}

async function readyAtMergeBoundary(f) {
  const result = await attempt(f.merge);
  assert.match(result.error?.message ?? "", /Fixture merge transport unavailable/);
  assert.equal(f.run().leafPr.known.fields.isDraft, false);
  assert.equal(f.run().leafPr.pending, undefined);
  assert.equal(f.world.pr.state, "OPEN");
  assert.equal(f.run().status, "completed");
}

async function prepareEffect(f, name) {
  if (name === "create") {
    f.invoke = () => f.server.orchestrator.runNextIdea();
    f.recover = () => f.run().status === "completed" ? f.sync() : f.retry();
    return;
  }
  await deliver(f);
  if (name.startsWith("edit:")) {
    await f.store.update((state) => { state.ideas[0].title = "Updated owned title"; });
    f.phase = "full";
    f.scores.prompt = 56; // A real new full reduction changes the rendered score body.
    f.invoke = f.full;
    f.recover = f.full;
  } else if (name === "ready") {
    f.invoke = f.merge;
    f.recover = f.merge;
  } else {
    await readyAtMergeBoundary(f);
    f.checkFailure = true;
    f.invoke = f.sync;
    f.recover = f.sync;
  }
}

test("public leaf PR effects recover request failure, uncertain response, and lost durable acknowledgment without repeating work", async (t) => {
  for (const name of ["create", "edit:title", "edit:body", "ready", "draft", "close"]) {
    for (const cut of ["request-error", "lost-response", "lost-state-ack"]) await t.test(`${name}: ${cut}`, async (t) => withFixture(t,
      { reviewLimit: name === "close" || name === "create" ? 1 : 4 }, async (f) => {
        await prepareEffect(f, name);
        const earlier = f.calls.effects.filter((call) => call.name === name).length;
        f.fault = { name, cut, hit: false };
        const result = await attempt(f.invoke);
        assert.equal(f.fault.hit, true, result.error?.stack ?? JSON.stringify(f.run()));
        const effect = f.fault.call.pending.effect;
        const owner = clone(f.fault.call.pending.owner);
        const target = clone(f.fault.call.pending.target);
        const token = f.run().leafPr.creationToken;
        if (cut === "lost-state-ack") {
          assert.equal(f.fault.ackHit, true, result.error?.stack);
          assert.deepEqual(f.fault.acknowledged.leafPr.known.fields, effect.after);
          assert.deepEqual(f.fault.acknowledged.leafPr.pending.owner, owner);
          assert.deepEqual(f.fault.acknowledged.leafPr.pending.target, target);
        } else {
          assert.deepEqual(f.run().leafPr.pending.effect, effect);
          assert.deepEqual(f.run().leafPr.pending.owner, owner);
          assert.deepEqual(f.run().leafPr.pending.target, target);
          if (name !== "create") assert.deepEqual(f.run().leafPr.known.fields, effect.before);
          else assert.equal(f.run().leafPr.known, undefined);
          if (cut === "lost-response") assert.deepEqual(tuple(f.world.pr), effect.after);
        }
        const evidence = evidenceSnapshot(f);
        f.fault = undefined;
        await f.restart();
        await attempt(f.recover);
        assert.equal(f.run().leafPr.pending, undefined, JSON.stringify(f.store.get().activity.slice(0, 4)));
        assert.deepEqual(f.run().leafPr.known.fields, target);
        assert.deepEqual(tuple(f.world.pr), target);
        assert.equal(f.run().leafPr.creationToken, token);
        assert.ok(f.world.pr.body.includes(`<!-- burner-leaf:${token} -->`));
        assertEvidenceUnchanged(f, evidence);
        assert.equal(f.calls.effects.filter((call) => call.name === name).length - earlier, cut === "request-error" ? 2 : 1);
        if (name === "close") {
          assert.equal(f.run().prState, "closed");
          assert.equal(canRetryAgent(f.run()), false);
          const calls = f.calls.effects.length;
          await assert.rejects(f.retry);
          assert.equal(await f.full(), false);
          await assert.rejects(f.merge);
          await f.sync();
          assert.equal(f.calls.effects.length, calls, "terminal bookkeeping cannot reopen or close twice");
          assertEvidenceUnchanged(f, evidence);
        }
        if (name === "draft") {
          assert.equal(f.run().prState, "open");
          assert.equal(f.run().status, "failed");
          assert.equal(canRetryAgent(f.run()), true, "failed checks with real remaining review capacity stay explicitly resumable");
          assert.equal(f.calls.effects.some((call) => call.name === "close"), false);
        }
      }));
  }
});

async function pendingFullPublication(f, name = "edit:body") {
  await prepareEffect(f, name);
  f.fault = { name, cut: "request-error", hit: false };
  await attempt(f.invoke);
  assert.equal(f.fault.hit, true);
  f.fault = undefined;
  assert.equal(f.run().fullEvaluation.step, "publication");
  assert.equal(latestFullAssessment(f.run()).evaluation.purpose, "full");
  assert.ok(latestFullAssessment(f.run()).evaluation.result.completedAt);
}

test("each third PR identity/content/lifecycle state blocks retry, qualification, and manual merge without samples or adoption", async (t) => withFixture(t, {}, async (f) => {
  await pendingFullPublication(f);
  await f.restart();
  const before = clone(f.run().leafPr);
  const evidence = evidenceSnapshot(f);
  const variants = [
    ["title", { title: "foreign title" }], ["body", { body: "foreign body" }], ["draft", { isDraft: false }],
    ["closed", { state: "CLOSED" }], ["unproved merged", { state: "MERGED", mergeCommit: f.base }],
    ["missing title", { title: undefined }], ["missing body", { body: undefined }], ["missing draft", { isDraft: undefined }],
    ["missing lifecycle", { state: undefined }], ["repository", { repository: { ...repository, id: "foreign" } }],
    ["head repository", { headRepository: { ...repository, id: "foreign" } }], ["base repository", { baseRepository: { ...repository, id: "foreign" } }],
    ["number", { number: 43 }], ["url", { url: url(43) }], ["branch", { headRefName: "burner/foreign" }],
    ["head", { headRefOid: f.base }], ["base branch", { baseRefName: "foreign-main" }], ["missing base oid", { baseRefOid: undefined }],
  ];
  for (const [name, patch] of variants) {
    f.observationPatch = patch;
    await scenario(t, f, name, async () => {
      const calls = f.calls.effects.length;
      for (const operation of [f.retry, f.full, f.merge]) {
        const result = await attempt(operation);
        assert.ok(result.error, `${name}: a foreign observation must refuse explicitly`);
        assert.deepEqual(f.run().leafPr, before, `${name}: no third-state adoption`);
        assertEvidenceUnchanged(f, evidence);
      }
      assert.equal(f.calls.effects.length, calls);
      assert.equal(f.calls.merges.length, 0);
    });
    if (f.failed) return;
  }
  f.observationPatch = undefined;
  await f.retry();
  assert.equal(f.run().leafPr.pending, undefined, "restoring the exact preimage lets the same public owner finish");
  assert.deepEqual(f.run().leafPr.known.fields, before.pending.target);
  assertEvidenceUnchanged(f, evidence);
}));

test("mixed title/body images and a newer requested presentation cannot replace the immutable in-flight target", async (t) => withFixture(t, {}, async (f) => {
  await pendingFullPublication(f, "edit:title");
  const saved = clone(f.run().leafPr);
  const evidence = evidenceSnapshot(f);
  const effect = saved.pending.effect;
  assert.notEqual(effect.before.title, saved.pending.target.title);
  assert.notEqual(effect.before.body, saved.pending.target.body);
  for (const title of [effect.before.title, effect.after.title]) {
    f.observationPatch = { title, body: saved.pending.target.body };
    await assert.rejects(f.full, /third|tuple|changed|unknown/i);
    assert.deepEqual(f.run().leafPr, saved, "individual old/new fields do not make a whole authorized tuple");
    assertEvidenceUnchanged(f, evidence);
  }
  f.observationPatch = undefined;
  await f.store.update((state) => { state.ideas[0].title = "Later presentation request"; });
  await f.restart();
  assert.equal(await f.full(), true);
  assert.deepEqual(f.run().leafPr.known.fields, saved.pending.target, "recovery finishes the saved owner, not recomputed desired metadata");
  assert.notEqual(f.world.pr.title, "Later presentation request");
  assertEvidenceUnchanged(f, evidence);
}));

test("lost create response binds only one complete marker-correlated OPEN match, never an edited/closed/duplicate branch match", async (t) => withFixture(t, { reviewLimit: 1 }, async (f) => {
  f.fault = { name: "create", cut: "lost-response", hit: false };
  await f.server.orchestrator.runNextIdea();
  assert.equal(f.fault.hit, true);
  f.fault = undefined;
  const receipt = clone(f.run().leafPr);
  const matched = await f.observation();
  const evidence = evidenceSnapshot(f);
  const variants = [
    ["missing marker", [{ ...matched, body: matched.body.replace(/<!-- burner-leaf:[^>]+ -->/g, "") }]],
    ["edited title", [{ ...matched, title: "unowned edit" }]],
    ["closed", [{ ...matched, state: "CLOSED" }]],
    ["duplicate", [matched, { ...matched, number: 43, url: url(43) }]],
    ["unknown branch", [{ ...matched, headRefName: "burner/another" }]],
    ["wrong head", [{ ...matched, headRefOid: f.base }]],
  ];
  await f.restart();
  for (const [name, matches] of variants) {
    f.searchMatches = matches;
    await scenario(t, f, name, async () => {
      const result = await attempt(f.retry);
      assert.ok(result.error || f.run().status === "failed");
      assert.deepEqual(f.run().leafPr, receipt);
      assert.equal(f.run().prNumber, undefined);
      assert.equal(f.calls.effects.filter((call) => call.name === "create").length, 1);
      assertEvidenceUnchanged(f, evidence);
    });
    if (f.failed) return;
  }
  f.searchMatches = undefined;
  const recovered = await f.retry();
  assert.equal(recovered.status, "completed", recovered.error);
  assert.equal(recovered.prNumber, 42);
  assert.equal(recovered.leafPr.creationToken, receipt.creationToken);
  assert.deepEqual(recovered.leafPr.known.fields, receipt.pending.target);
  assert.equal(f.calls.effects.filter((call) => call.name === "create").length, 1, "an exact lost-response match is acknowledged without another create");
  assert.equal(recovered.reviewRounds.length, 1, "approved final delivery recovers even at the review limit");
  assertEvidenceUnchanged(f, evidence);
}));

test("creation requires renewed exhaustive absence and refuses an unrelated same-branch PR without creating a replacement", async (t) => withFixture(t, {}, async (f) => {
  f.searchError = true;
  await f.server.orchestrator.runNextIdea();
  assert.equal(f.run().status, "failed");
  assert.equal(f.calls.effects.length, 0);
  const owner = clone(f.run().leafPr);
  const evidence = evidenceSnapshot(f);
  f.searchError = false;
  f.searchMatches = [{ repository, headRepository: repository, baseRepository: repository, number: 55, url: url(55),
    headRefName: f.run().branch, headRefOid: f.run().continuation.head, baseRefName: "main", baseRefOid: f.base,
    title: "Other author", body: "No owned correlation marker", isDraft: true, state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [] }];
  await attempt(f.retry);
  assert.deepEqual(f.run().leafPr, owner);
  assert.equal(f.calls.effects.length, 0);
  assertEvidenceUnchanged(f, evidence);
  f.searchMatches = undefined;
  await f.restart();
  const run = await f.retry();
  assert.equal(run.status, "completed", run.error);
  assert.ok(f.calls.searches >= 3);
  assert.equal(f.calls.effects.filter((call) => call.name === "create").length, 1);
  assert.equal(run.leafPr.creationToken, owner.creationToken);
  assertEvidenceUnchanged(f, evidence);
}));

test("a pending full-publication target serializes the weight-presentation writer", async (t) => withFixture(t, {}, async (f) => {
  await pendingFullPublication(f);
  const pending = clone(f.run().leafPr);
  const history = clone(f.run().fullEvaluationHistory);
  const samples = clone(f.calls.samples);
  const effects = f.calls.effects.length;
  await f.store.update((state) => { state.evaluations.find((evaluation) => evaluation.id === "command").weight = 2; });
  await assert.rejects(() => f.server.orchestrator.refreshEvaluationWeights(), /pending|intent|owner|publication|changed/i);
  assert.deepEqual(f.run().leafPr, pending);
  assert.deepEqual(f.run().fullEvaluationHistory, history);
  assert.deepEqual(f.calls.samples, samples);
  assert.equal(f.calls.effects.length, effects, "another presentation writer cannot replace or overtake pending full publication");
}));

test("foreign content immediately after readiness is preserved and never reaches merge or a compensating draft", async (t) => withFixture(t, {}, async (f) => {
  await deliver(f);
  const evidence = evidenceSnapshot(f);
  f.afterEffect = async (name) => { if (name === "ready") f.world.pr.body += "\nForeign content after readiness"; };
  const result = await attempt(f.merge);
  assert.ok(result.error);
  assert.equal(f.calls.merges.length, 0);
  assert.equal(f.run().leafPr.pending.effect.kind, "ready");
  assert.equal(f.run().leafPr.known.fields.isDraft, true);
  assert.match(f.world.pr.body, /Foreign content after readiness/);
  assert.equal(f.world.pr.isDraft, false);
  assert.equal(f.calls.effects.filter((call) => call.name !== "create").length, 1, "third-state recovery cannot compensate with draft/content writes");
  assertEvidenceUnchanged(f, evidence);
}));

test("merge polling rechecks the complete tuple and a later merge attempt cannot use stale content authority", async (t) => {
  for (const cut of ["polling", "between requests"]) await t.test(cut, async (t) => withFixture(t, {}, async (f) => {
    await deliver(f);
    const evidence = evidenceSnapshot(f);
    f.mergeAttempts = 2;
    let changed = false;
    const change = (observed) => {
      changed = true;
      f.world.pr.title = "Foreign title while merge was checking";
      if (observed) observed.title = f.world.pr.title;
    };
    if (cut === "polling") f.onObserve = async (observed) => {
      if (!changed && f.run().leafPr.known?.fields.isDraft === false && !f.run().leafPr.pending) change(observed);
    };
    else f.onMerge = async () => { if (!changed) change(); };
    const result = await attempt(f.merge);
    assert.ok(result.error);
    assert.equal(changed, true);
    assert.equal(f.calls.merges.length, cut === "polling" ? 0 : 1);
    assert.match(f.world.pr.title, /Foreign title/);
    assert.notEqual(f.run().leafPr.known.fields.title, f.world.pr.title);
    assert.equal(f.calls.effects.filter((call) => call.name !== "create").length, 1, "only the already-authorized readiness effect occurred");
    assertEvidenceUnchanged(f, evidence);
  }));
});

test("negative full scores with real capacity retain the same OPEN draft for public retry, without reopening", async (t) => withFixture(t, {}, async (f) => {
  await deliver(f);
  const id = f.run().id, branch = f.run().branch, token = f.run().leafPr.creationToken;
  f.phase = "full-negative";
  f.scores.prompt = 40;
  assert.equal(await f.full(), false);
  const negative = clone(latestFullAssessment(f.run()));
  assert.equal(f.run().prState, "open");
  assert.equal(f.run().leafPr.known.fields.state, "OPEN");
  assert.equal(f.run().leafPr.known.fields.isDraft, true);
  assert.equal(f.calls.effects.some((call) => call.name === "close"), false);
  f.phase = "repair-delivery";
  f.scores.prompt = 55;
  await f.restart();
  const repaired = await f.retry();
  assert.equal(repaired.status, "completed", repaired.error);
  assert.equal(repaired.id, id);
  assert.equal(repaired.branch, branch);
  assert.equal(repaired.prNumber, 42);
  assert.equal(repaired.authorThreadId, "fixture-author");
  assert.equal(repaired.leafPr.creationToken, token);
  assert.equal(repaired.leafPr.known.fields.state, "OPEN");
  assert.equal(repaired.leafPr.known.fields.isDraft, true);
  assert.deepEqual(latestFullAssessment(repaired), negative);
  assert.equal(repaired.reviewRounds.length, 2);
  assert.equal(f.calls.effects.filter((call) => call.name === "create").length, 1);
  assert.equal(f.calls.effects.some((call) => call.name === "close"), false);
}));

// Construct remote facts, not a substitute for the production proof/settlement
// owner. All commits, refs, fetches and ancestry checks remain real fixture Git.
async function landFixturePr(f, kind = "first-parent", markMerged = true) {
  const head = await f.git.remoteBranchHead(f.root, "origin", f.run().branch);
  assert.ok(head);
  const serial = f.graphSequence = (f.graphSequence ?? 0) + 1;
  const checkout = async (name, start) => {
    const path = join(f.sandbox, `${name}-${serial}`);
    await gitCommand(f.root, "worktree", "add", "--quiet", "-b", `fixture/${name}-${serial}`, path, start);
    return path;
  };
  let landing, target, secondParent;
  if (kind === "squash") {
    const path = await checkout("squash", f.base);
    await gitCommand(path, "merge", "--squash", head);
    landing = await f.git.commit(path, "fixture squash with identical leaf tree");
    assert.equal(await f.git.tree(landing), await f.git.tree(head));
    await writeFile(join(path, "newer-target.txt"), "later legitimate target\n");
    target = await f.git.commit(path, "fixture newer target after squash");
    await gitCommand(path, "push", "origin", `${target}:refs/heads/main`);
  } else {
    const side = await checkout("side", f.base);
    await writeFile(join(side, "side.txt"), "independent side of composite landing\n");
    secondParent = await f.git.commit(side, "fixture side parent");
    const path = await checkout("landing", head);
    await gitCommand(path, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "merge", "--no-ff", "--no-edit", secondParent);
    landing = await f.git.head(path);
    const parents = (await gitCommand(path, "rev-list", "--parents", "-n", "1", landing)).split(" ");
    assert.deepEqual(parents.slice(1), [head, secondParent], "the leaf is the first parent, never the required second-parent special case");
    if (kind === "detached-landing") {
      const unrelated = await checkout("target", f.base);
      await writeFile(join(unrelated, "other-target.txt"), "target did not incorporate the landing\n");
      target = await f.git.commit(unrelated, "fixture target without landing");
    } else {
      await writeFile(join(path, "newer-target.txt"), "later legitimate target\n");
      target = await f.git.commit(path, "fixture newer target after landing");
    }
    await gitCommand(f.root, "push", "origin", `${landing}:refs/heads/fixture-landing-${serial}`, `${target}:refs/heads/main`);
  }
  const edge = async (ancestor, descendant) => {
    const result = await runCommand("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: f.root });
    assert.ok([0, 1].includes(result.exitCode), result.stderr);
    return result.exitCode === 0;
  };
  assert.equal(await edge(head, landing), kind !== "squash");
  assert.equal(await edge(landing, target), kind !== "detached-landing");
  assert.notEqual(await f.git.tree(head), await f.git.tree(target), "later target changes need not preserve the tested whole tree");
  assert.equal(await f.git.head(f.root), f.base, "the actual remote, not a silently advanced local main, must supply proof");
  f.world.target = target;
  if (markMerged) Object.assign(f.world.pr, { state: "MERGED", isDraft: false, mergeCommit: landing });
  f.graph = { head, landing, target, secondParent, kind };
  return f.graph;
}

function terminalSnapshot(f) {
  return clone({ evidence: evidenceSnapshot(f), evaluationRuns: f.store.get().evaluationRuns,
    effects: f.calls.effects.length, merges: f.calls.merges.length, pushes: f.calls.gitPushes.length });
}

function assertTerminalEvidence(f, saved) {
  assertEvidenceUnchanged(f, saved.evidence);
  assert.deepEqual(f.store.get().evaluationRuns, saved.evaluationRuns, "terminal graph recognition neither samples nor promotes scores for a different target tree");
}

test("public merge and synchronization prove a first-parent landing in a newer actual remote target", async (t) => {
  for (const route of ["uncertain merge response", "already merged manual", "synchronization"]) await t.test(route, async (t) => withFixture(t, {}, async (f) => {
    await deliver(f);
    const evidence = evidenceSnapshot(f);
    const evaluationRuns = clone(f.store.get().evaluationRuns);
    let known;
    if (route === "uncertain merge response") {
      f.onMerge = async () => {
        known = clone(f.run().leafPr.known.fields);
        await landFixturePr(f);
      };
      assert.equal((await f.merge()).prState, "merged", "the uncertain transport response must enter proof before another merge request");
      assert.equal(f.calls.merges.length, 1);
    } else {
      known = clone(f.run().leafPr.known.fields);
      await landFixturePr(f);
      await f.restart();
      if (route === "synchronization") await f.sync(); else await f.merge();
      assert.equal(f.calls.merges.length, 0);
      assert.equal(f.calls.effects.filter((call) => call.name !== "create").length, 0, "already merged proof does not publish or make a draft ready");
    }
    assert.equal(f.run().prState, "merged");
    assert.deepEqual(f.run().leafPr.known.fields, known, "MERGED freezes acknowledged lifecycle; it is not a synthetic ready/CLOSED acknowledgment");
    assert.equal(f.run().leafPr.pending, undefined);
    assert.equal(await f.git.head(f.root), f.graph.target);
    assert.notEqual(f.graph.head, f.graph.target);
    assert.ok(f.store.get().orchestrator.lastMergeAt);
    assert.equal(f.store.get().orchestrator.baseSyncPending, false);
    assertEvidenceUnchanged(f, evidence);
    assert.deepEqual(f.store.get().evaluationRuns, evaluationRuns);
    const saved = terminalSnapshot(f), mergedAt = f.store.get().orchestrator.lastMergeAt;
    await f.restart();
    await f.sync();
    await f.merge();
    assert.equal(f.store.get().orchestrator.lastMergeAt, mergedAt, "reproof does not create a second merge event");
    assert.equal(f.calls.merges.length, saved.merges);
    assert.equal(f.calls.effects.length, saved.effects);
    assert.equal(f.calls.gitPushes.length, saved.pushes);
    assertTerminalEvidence(f, saved);
  }));
});

test("already-merged negative-full and nonapproved leaves settle through public recovery without becoming qualified", async (t) => {
  for (const source of ["negative full", "nonapproved checkpoint"]) await t.test(source, async (t) => withFixture(t,
    { reviewLimit: source === "nonapproved checkpoint" ? 1 : 4 }, async (f) => {
      if (source === "negative full") {
        await deliver(f);
        f.phase = "full-negative";
        f.scores.prompt = 40;
        assert.equal(await f.full(), false);
        assert.equal(latestFullAssessment(f.run()).qualified, false);
      } else {
        f.reviewApproval = false;
        f.fault = { name: "close", cut: "request-error", hit: false };
        const failed = await f.server.orchestrator.runNextIdea();
        assert.equal(failed.status, "failed");
        assert.equal(failed.reviewApproved, false);
        assert.equal(failed.reviewRounds.length, 1);
        assert.equal(failed.leafPr.known.fields.state, "OPEN");
        assert.equal(f.calls.samples.length, 0, "a nonapproved checkpoint has no delivery qualification");
        assert.equal(f.fault.hit, true, "the ordinary exhausted checkpoint entered its checked close owner");
        assert.equal(failed.leafPr.pending.owner.kind, "terminal-close");
        assert.equal(failed.leafPr.pending.effect.kind, "close");
        f.fault = undefined;
        assert.equal(canRetryAgent(failed), false, "an interrupted terminal close cannot regain author/review authority");
        await assert.rejects(f.retry);
        assert.deepEqual(f.run(), failed);
      }
      const prior = clone(f.run()), known = clone(f.run().leafPr.known.fields);
      await landFixturePr(f);
      const saved = terminalSnapshot(f);
      await f.restart();
      const result = source === "negative full" ? await f.retry() : await f.merge();
      assert.equal(result.prState, "merged");
      assert.equal(result.reviewApproved, prior.reviewApproved);
      assert.deepEqual(result.leafPr.known.fields, known);
      assert.equal(result.error, prior.error, "graph incorporation does not clear an independent review/full failure");
      assert.deepEqual(latestFullAssessment(result), latestFullAssessment(prior));
      assert.equal(f.calls.effects.length, saved.effects);
      assert.equal(f.calls.merges.length, saved.merges);
      assert.equal(f.calls.gitPushes.length, saved.pushes);
      assertTerminalEvidence(f, saved);
      await f.sync();
      assert.equal(await f.git.head(f.root), f.graph.target);
      assertTerminalEvidence(f, saved);
    }));
});

test("valid inclusion cannot authorize a wrong same-number MERGED identity, edited content, or missing landing", async (t) => withFixture(t, {}, async (f) => {
  await deliver(f);
  await landFixturePr(f);
  const before = clone(f.run()), saved = terminalSnapshot(f);
  const lastMergeAt = f.store.get().orchestrator.lastMergeAt;
  const variants = [
    ["repository", { repository: { ...repository, id: "other" } }],
    ["base repository", { baseRepository: { ...repository, id: "other" } }],
    ["base branch", { baseRefName: "other-main" }],
    ["different descendant head", { headRefOid: f.graph.landing }],
    ["title", { title: "foreign merged title" }], ["body", { body: "foreign merged body" }],
    ["missing landing", { mergeCommit: undefined }], ["unavailable landing", { mergeCommit: "f".repeat(40) }],
  ];
  for (const [name, patch] of variants) {
    f.observationPatch = patch;
    await scenario(t, f, name, async () => {
      await assert.rejects(f.merge);
      await f.sync();
      assert.deepEqual(f.run(), before, "refused terminal observations do not gain disposition or replace saved owners");
      assert.equal(f.store.get().orchestrator.lastMergeAt, lastMergeAt);
      assert.equal(await f.git.head(f.root), f.base);
      assert.equal(f.calls.effects.length, saved.effects);
      assert.equal(f.calls.merges.length, saved.merges);
      assert.equal(f.calls.gitPushes.length, saved.pushes);
      assertTerminalEvidence(f, saved);
    });
    if (f.failed) return;
  }
  f.observationPatch = undefined;
  await f.merge();
  assert.equal(f.run().prState, "merged", "the same immutable graph succeeds when the exact owned observation is restored");
  assertTerminalEvidence(f, saved);
}));

test("actual squash-equivalent and detached landing graphs refuse terminal success", async (t) => {
  for (const kind of ["squash", "detached-landing"]) await t.test(kind, async (t) => withFixture(t, {}, async (f) => {
    await deliver(f);
    await landFixturePr(f, kind);
    const before = clone(f.run()), saved = terminalSnapshot(f);
    await f.restart();
    await assert.rejects(f.merge, /ancestry|inclusion/i);
    await f.sync();
    assert.deepEqual(f.run(), before);
    assert.equal(f.run().prState, "open");
    assert.equal(f.store.get().orchestrator.lastMergeAt, undefined);
    assert.equal(await f.git.head(f.root), f.base);
    assert.equal(f.calls.effects.length, saved.effects);
    assert.equal(f.calls.merges.length, saved.merges);
    assert.equal(f.calls.gitPushes.length, saved.pushes);
    assertTerminalEvidence(f, saved);
  }));
});

test("public synchronization consumes the original full-content after-image on a proved MERGED PR", async (t) => withFixture(t, {}, async (f) => {
  await prepareEffect(f, "edit:body");
  f.fault = { name: "edit:body", cut: "lost-response", hit: false };
  await attempt(f.full);
  assert.equal(f.fault.hit, true);
  const owner = clone(f.run().leafPr), assessment = clone(latestFullAssessment(f.run()));
  assert.equal(owner.pending.effect.kind, "edit");
  assert.deepEqual(tuple(f.world.pr), owner.pending.effect.after);
  assert.equal(f.run().fullEvaluation.step, "publication");
  f.fault = undefined;
  await landFixturePr(f);
  const saved = terminalSnapshot(f);
  await f.restart();
  await f.sync();
  assert.equal(f.run().prState, "merged", JSON.stringify(f.store.get().activity.slice(0, 5)));
  assert.equal(f.run().fullEvaluation, undefined);
  assert.equal(f.run().leafPr.pending, undefined);
  assert.deepEqual(f.run().leafPr.known.fields, owner.pending.target, "only the content after-image is acknowledged; MERGED supplies no draft/CLOSED value");
  assert.deepEqual(latestFullAssessment(f.run()), assessment);
  assert.equal(f.calls.effects.length, saved.effects);
  assert.equal(f.calls.merges.length, saved.merges);
  assert.equal(f.calls.gitPushes.length, saved.pushes);
  assertTerminalEvidence(f, saved);
}));

test("public retry consumes a real completed progress push followed by MERGED without repeating the push or evidence", async (t) => withFixture(t, {}, async (f) => {
  await deliver(f);
  const delivery = clone(f.run().continuation.evaluation);
  f.interruptProgressPush = true;
  await assert.rejects(f.merge, /progress push completed before semantic acknowledgment/);
  const progress = clone(f.interruptedProgress);
  assert.equal(progress.step, "progress");
  assert.equal(progress.phase, "push");
  assert.equal(await f.git.remoteBranchHead(f.root, "origin", f.run().branch), progress.head);
  assert.equal(f.run().generatedProgress, undefined, "the semantic acknowledgment is still pending");
  await landFixturePr(f);
  const saved = terminalSnapshot(f), known = clone(f.run().leafPr.known.fields);
  await f.restart();
  const result = await f.retry();
  assert.equal(result.prState, "merged");
  assert.equal(result.continuation.step, "done");
  assert.equal(result.continuation.head, progress.head);
  assert.deepEqual(result.continuation.evaluation, delivery);
  assert.equal(result.generatedProgress.outputCommit, progress.head);
  assert.equal(result.generatedProgress.inputCommit, progress.plan.inputHead);
  await f.git.verifyGeneratedProgress(result.generatedProgress);
  assert.deepEqual(result.leafPr.known.fields, known);
  assert.equal(f.calls.effects.length, saved.effects);
  assert.equal(f.calls.merges.length, saved.merges);
  assert.equal(f.calls.gitPushes.length, saved.pushes);
  // The pending cursor carries delivery under done; its restored top-level
  // location is semantic acknowledgment, not a rewritten evaluation receipt.
  assert.deepEqual(f.calls.samples, saved.evidence.samples);
  assert.deepEqual(f.calls.models, saved.evidence.models);
  assert.deepEqual(result.reviewRounds, saved.evidence.reviews);
  assert.deepEqual(result.fullEvaluationHistory, saved.evidence.full);
  assert.deepEqual(f.store.get().evaluationRuns, saved.evaluationRuns);
  await f.sync();
  assert.equal(await f.git.head(f.root), f.graph.target);
}));

test("close and readiness races require real MERGED proof without falsely acknowledging their lifecycle effect", async (t) => {
  for (const name of ["close", "ready"]) await t.test(name, async (t) => withFixture(t,
    { reviewLimit: name === "close" ? 1 : 4 }, async (f) => {
      await prepareEffect(f, name);
      const evidence = evidenceSnapshot(f), evaluationRuns = clone(f.store.get().evaluationRuns);
      const earlier = f.calls.effects.length;
      let raced;
      const race = async () => {
        raced = clone(f.run().leafPr.pending.effect);
        await landFixturePr(f);
        throw new TransientMergeGateError(`Fixture ${name} raced with MERGED before its own effect`);
      };
      if (name === "close") f.closeRace = race; else f.readyRace = race;
      await attempt(f.invoke);
      assert.equal(raced.kind, name);
      f.closeRace = f.readyRace = undefined;
      await f.restart();
      await f.sync();
      assert.equal(f.run().prState, "merged", JSON.stringify(f.store.get().activity.slice(0, 5)));
      assert.equal(f.run().leafPr.pending, undefined);
      assert.deepEqual(f.run().leafPr.known.fields, raced.before);
      assert.equal(f.run().leafPr.known.fields.state, "OPEN", "MERGED is never acknowledged as the close after-image");
      if (name === "ready") assert.equal(f.run().leafPr.known.fields.isDraft, true, "graph proof is not a missing readiness acknowledgment");
      assert.equal(f.calls.effects.length - earlier, 1);
      assert.equal(f.calls.effects.at(-1).applied, false);
      assert.equal(await f.git.head(f.root), f.graph.target);
      assertEvidenceUnchanged(f, evidence);
      assert.deepEqual(f.store.get().evaluationRuns, evaluationRuns);
  }));
});

test("MERGED after a ready leaf's full-content edit freezes readiness instead of attempting its unperformed draft target", async (t) => withFixture(t, {}, async (f) => {
  await deliver(f);
  await readyAtMergeBoundary(f);
  await f.store.update((state) => { state.ideas[0].title = "Ready leaf full publication"; });
  f.phase = "ready-full";
  f.scores.prompt = 56;
  f.fault = { name: "edit:body", cut: "lost-response", hit: false };
  await attempt(f.full);
  assert.equal(f.fault.hit, true);
  const owner = clone(f.run().leafPr), assessment = clone(latestFullAssessment(f.run()));
  assert.equal(owner.pending.effect.kind, "edit");
  assert.equal(owner.pending.effect.after.isDraft, false);
  assert.equal(owner.pending.target.isDraft, true);
  assert.deepEqual(tuple(f.world.pr), owner.pending.effect.after);
  f.fault = undefined;
  await landFixturePr(f);
  const saved = terminalSnapshot(f);
  await f.restart();
  await f.sync();
  assert.equal(f.run().prState, "merged", JSON.stringify(f.store.get().activity.slice(0, 5)));
  assert.equal(f.run().fullEvaluation, undefined);
  assert.equal(f.run().leafPr.pending, undefined);
  assert.deepEqual(f.run().leafPr.known.fields, owner.pending.effect.after, "only the exact content effect was acknowledged; the saved ready bit is frozen");
  assert.equal(f.run().leafPr.known.fields.isDraft, false);
  assert.deepEqual(latestFullAssessment(f.run()), assessment);
  assert.equal(f.calls.effects.length, saved.effects, "terminal content recovery must not issue the draft effect that never occurred");
  assert.equal(f.calls.merges.length, saved.merges);
  assert.equal(f.calls.gitPushes.length, saved.pushes);
  assertTerminalEvidence(f, saved);
  await f.sync();
  assert.equal(f.calls.effects.length, saved.effects, "synchronization cannot loop on the terminated draft target");
  assertTerminalEvidence(f, saved);
}));

test("a resumed superseded close re-proves actual remote inclusion before another close request", async (t) => withFixture(t, {}, async (f) => {
  await deliver(f);
  await landFixturePr(f, "first-parent", false);
  assert.equal(f.world.pr.state, "OPEN");
  assert.deepEqual(f.run().leafPr.known.fields, tuple(f.world.pr));
  const timestamp = new Date().toISOString();
  // Membership only nominates a source for discovery. The public owner must
  // independently prove its real immutable H is in the current bare remote B.
  await f.store.update((state) => state.composites.push({ id: "fixture-inclusion-nomination", title: "Previously merged composite",
    description: "Discovery only, never inclusion authority", status: "merged", branch: "fixture/composite-discovery", worktree: "",
    baseCommit: f.base, sources: [{ agentRunId: f.run().id, prNumber: 42, title: "Owned leaf", branch: f.run().branch, kind: "pull_request" }],
    deltas: [], reviewRounds: [], reviewApproved: false, isLiving: false, createdAt: timestamp, updatedAt: timestamp, mergedAt: timestamp }));
  f.fault = { name: "close", cut: "request-error", hit: false };
  await f.sync();
  assert.equal(f.fault.hit, true, JSON.stringify(f.store.get().activity.slice(0, 5)));
  assert.equal(f.run().leafPr.pending.owner.kind, "terminal-close");
  assert.equal(f.run().leafPr.pending.owner.reason.kind, "superseded");
  assert.equal(f.run().leafPr.pending.effect.kind, "close");
  assert.equal(f.world.pr.state, "OPEN");
  const prior = clone(f.run());
  f.fault = undefined;
  const replacement = join(f.sandbox, "replacement-target");
  await gitCommand(f.root, "worktree", "add", "--quiet", "-b", "fixture/replacement-target", replacement, f.base);
  await writeFile(join(replacement, "replacement.txt"), "remote target no longer contains the leaf\n");
  const target = await f.git.commit(replacement, "fixture replacement target excluding source");
  const ancestry = await runCommand("git", ["merge-base", "--is-ancestor", f.graph.head, target], { cwd: f.root });
  assert.equal(ancestry.exitCode, 1);
  await gitCommand(f.root, "push", `--force-with-lease=refs/heads/main:${f.graph.target}`, "origin", `${target}:refs/heads/main`);
  f.world.target = target;
  const saved = terminalSnapshot(f);
  await f.restart();
  await f.sync();
  assert.equal(f.calls.effects.length, saved.effects, "a changed remote graph must refuse before a second close request");
  assert.equal(f.world.pr.state, "OPEN");
  assert.deepEqual(f.run(), prior, "the concrete pending close and acknowledged OPEN tuple remain owned and unconsumed");
  assert.notEqual(f.run().prState, "superseded");
  assert.equal(f.run().supersededByCompositeId, undefined);
  assert.equal(f.store.get().orchestrator.lastMergeAt, undefined);
  assert.equal(await f.git.head(f.root), f.base);
  assert.equal(f.calls.merges.length, saved.merges);
  assert.equal(f.calls.gitPushes.length, saved.pushes);
  assertTerminalEvidence(f, saved);
}));

test("history selection preserves pending PR effects under a misleading terminal display and refuses invalid source or after-images", async (t) => {
  for (const name of ["create", "edit:title", "edit:body", "ready", "draft", "close"]) await t.test(name, async (t) => withFixture(t,
    { reviewLimit: name === "close" ? 1 : 4 }, async (f) => {
      await prepareEffect(f, name);
      f.fault = { name, cut: "lost-response", hit: false };
      await attempt(f.invoke);
      assert.equal(f.fault.hit, true);
      const pendingRun = clone(f.run()), evidence = evidenceSnapshot(f);
      assert.ok(pendingRun.leafPr.pending.effect);
      f.fault = undefined;
      // Explicit display-only fault injection, not a claim that a real merge
      // writer emitted this row. The concrete owner must still be inspected.
      await f.store.update((state) => {
        state.agentRuns.find((run) => run.id === pendingRun.id).prState = "merged";
        if (name === "create") state.evaluations[1].weight = 2; // Select recorded-delivery acknowledgment, never new sampling.
      });
      f.observationPatch = { title: "foreign controlled title" };
      await f.restart();
      const before = terminalSnapshot(f), observations = f.calls.observations + f.calls.searches;
      const activityIds = new Set(f.store.get().activity.map((entry) => entry.id));
      await f.sync();
      const refusals = f.store.get().activity.filter((entry) => !activityIds.has(entry.id) && entry.message === `Leaf PR settlement preserved ${f.run().id}`);
      assert.equal(refusals.length, 1, "pending work must produce a fresh exact-owner refusal, not a silent historical skip");
      if (name === "create") assert.match(refusals[0].detail, /leaf continuation or its source\/base\/evaluation\/PR identity changed/i);
      else assert.ok(f.calls.observations + f.calls.searches > observations, "the concrete foreign after-image must be inspected");
      assert.deepEqual(f.run().leafPr, pendingRun.leafPr);
      assert.equal(f.run().leafPr.merged, undefined, "a terminal display is not a merge fact");
      assert.ok(f.store.get().activity.some((entry) => entry.message.startsWith("Leaf PR settlement preserved")));
      assert.equal(f.calls.effects.length, before.effects); assert.equal(f.calls.merges.length, before.merges);
      assert.equal(f.calls.gitPushes.length, before.pushes); assertEvidenceUnchanged(f, evidence);
      f.observationPatch = undefined;
      await f.store.update((state) => {
        const run = state.agentRuns.find((item) => item.id === pendingRun.id);
        run.prState = pendingRun.prState; run.status = pendingRun.status;
      });
      await f.restart();
      if (name === "create") await f.sync(); else await attempt(f.recover);
      assert.equal(f.run().leafPr.pending, undefined, JSON.stringify(f.store.get().activity.slice(0, 5)));
      assertEvidenceUnchanged(f, evidence);
      assert.equal(f.calls.effects.filter((call) => call.name === name).length,
        before.effects ? f.calls.effects.slice(0, before.effects).filter((call) => call.name === name).length : 0,
        "observing the exact saved after-image does not repeat the same remote effect");
  }));
});

test("history selection drains a genuinely acknowledged CLOSED tuple's still-pending semantic owner before becoming quiet", async (t) => withFixture(t, { reviewLimit: 1 }, async (f) => {
  await prepareEffect(f, "close");
  f.checkFailure = false;
  const controlStart = f.calls.writes; await f.sync(); const controlWrites = f.calls.writes - controlStart;
  f.checkFailure = true;
  f.stateCut = { hit: false, matches: (before, after) => before?.leafPr?.pending?.owner.kind === "terminal-close" &&
    !before.leafPr.pending.effect && before.leafPr.known.fields.state === "CLOSED" && !after?.leafPr?.pending };
  await f.invoke();
  assert.equal(f.stateCut.hit, true);
  assert.equal(f.run().leafPr.known.fields.state, "CLOSED");
  assert.equal(f.run().leafPr.pending.owner.kind, "terminal-close");
  assert.equal(f.run().leafPr.pending.effect, undefined, "this is a semantic-only intent, not an unperformed close");
  const saved = terminalSnapshot(f);
  f.stateCut = undefined; await f.restart();
  const observations = f.calls.observations;
  await f.sync();
  assert.ok(f.calls.observations > observations, "known CLOSED cannot hide unfinished semantic acknowledgment");
  assert.equal(f.run().leafPr.pending, undefined); assert.equal(f.run().prState, "closed");
  assert.equal(canRetryAgent(f.run()), false); assert.equal(f.calls.effects.length, saved.effects);
  assertTerminalEvidence(f, saved);
  const settledObservations = f.calls.observations, writes = f.calls.writes;
  await f.sync();
  assert.equal(f.calls.observations, settledObservations);
  assert.equal(f.calls.writes - writes, controlWrites, "only measured constant housekeeping remains after the semantic owner finishes");
  assert.equal(f.calls.effects.length, saved.effects); assertTerminalEvidence(f, saved);
}));

function historicalCadence(f) {
  const state = f.store.get().orchestrator;
  return clone({ lastMergeAt: state.lastMergeAt, mergeWindowStartedAt: state.mergeWindowStartedAt, lastMergeCadenceAlertAt: state.lastMergeCadenceAlertAt });
}

async function restorePendingWithGenuineFact(f, pendingRun, fact) {
  // Constructed recovery combination of a saved real pending receipt and a
  // later real graph acknowledgment from this SAME source. It is deliberately
  // not claimed to be an output of the atomic settlement writer.
  await f.store.update((state) => {
    const index = state.agentRuns.findIndex((run) => run.id === pendingRun.id);
    state.agentRuns[index] = { ...clone(pendingRun), prState: "merged", leafPr: { ...clone(pendingRun.leafPr), merged: clone(fact) } };
  });
}

test("history selection drains or explicitly refuses saved creation and delivery without reopening a genuine historical merged display", async (t) => {
  for (const cut of ["creation after-image", "delivery semantic acknowledgment"]) await t.test(cut, async (t) => withFixture(t, {}, async (f) => {
    if (cut === "creation after-image") f.fault = { name: "create", cut: "lost-response", hit: false };
    else f.stateCut = { hit: false, matches: (before, after) => before?.continuation?.step === "delivery" &&
      before.leafPr?.pending?.owner.kind === "delivery" && !before.leafPr.pending.effect && after?.continuation?.step === "done" && !after.leafPr?.pending };
    await f.server.orchestrator.runNextIdea();
    assert.equal((f.fault ?? f.stateCut).hit, true);
    const pendingRun = clone(f.run()), afterImage = clone(f.world.pr);
    assert.equal(pendingRun.leafPr.pending.owner.kind, "delivery");
    assert.ok(pendingRun.continuation.publication);
    f.fault = f.stateCut = undefined;
    assert.equal((await f.retry()).status, "completed");
    await landFixturePr(f);
    f.failBaseSync = 1; await assert.rejects(f.sync, /Fixture base synchronization is unavailable/);
    const fact = clone(f.run().leafPr.merged), cadence = historicalCadence(f), saved = terminalSnapshot(f);
    assert.deepEqual(fact, { sourceBase: f.base, head: f.graph.head, landing: f.graph.landing, targetCommit: f.graph.target });
    await restorePendingWithGenuineFact(f, pendingRun, fact);
    await f.store.update((state) => { state.evaluations[1].weight = 2; });
    // The saved OPEN after-image is the historical transport response being
    // recovered. It does not overwrite the separately proved merge fact.
    f.world.pr = afterImage;
    await f.restart(); f.failBaseSync = 1;
    const beforeRecovery = clone(f.run()), activityIds = new Set(f.store.get().activity.map((entry) => entry.id));
    await assert.rejects(f.sync, /Fixture base synchronization is unavailable/);
    if (f.run().leafPr.pending) {
      const refusals = f.store.get().activity.filter((entry) => !activityIds.has(entry.id) && entry.message === `Leaf PR settlement preserved ${f.run().id}`);
      assert.equal(refusals.length, 1, "a terminal-looking owner with pending work cannot silently short-circuit");
      assert.match(refusals[0].detail, /leaf continuation or its source\/base\/evaluation\/PR identity changed/i);
      assert.deepEqual(f.run(), beforeRecovery, "explicit source refusal preserves the complete exact pending owner and history");
    } else {
      assert.equal(f.run().continuation.step, "done"); assert.equal(f.run().continuation.publication, undefined);
    }
    assert.equal(f.run().prState, "merged"); assert.equal(canRetryAgent(f.run()), false);
    assert.deepEqual(f.run().leafPr.merged, fact); assert.deepEqual(historicalCadence(f), cadence);
    assert.equal(f.calls.effects.length, saved.effects); assert.equal(f.calls.merges.length, saved.merges);
    assert.equal(f.calls.gitPushes.length, saved.pushes); assertTerminalEvidence(f, saved);
  }));
});

test("history selection consumes original full and progress receipts under a genuine same-source merged fact", async (t) => {
  for (const kind of ["full publication", "progress push"]) await t.test(kind, async (t) => withFixture(t, {}, async (f) => {
    if (kind === "full publication") {
      await prepareEffect(f, "edit:body");
      f.fault = { name: "edit:body", cut: "lost-response", hit: false };
      await attempt(f.full); assert.equal(f.fault.hit, true); f.fault = undefined;
      assert.equal(f.run().fullEvaluation.step, "publication");
    } else {
      await deliver(f); f.interruptProgressPush = true;
      await assert.rejects(f.merge, /progress push completed before semantic acknowledgment/);
      assert.equal(f.run().continuation.step, "progress"); assert.equal(f.run().continuation.phase, "push");
    }
    const pendingRun = clone(f.run());
    await landFixturePr(f);
    f.failBaseSync = 1; await assert.rejects(f.sync, /Fixture base synchronization is unavailable/);
    const fact = clone(f.run().leafPr.merged), cadence = historicalCadence(f), saved = terminalSnapshot(f);
    assert.deepEqual(fact, { sourceBase: f.base, head: f.graph.head, landing: f.graph.landing, targetCommit: f.graph.target });
    await restorePendingWithGenuineFact(f, pendingRun, fact);
    if (kind === "full publication") {
      const unchanged = clone(f.run());
      f.observationPatch = { mergeCommit: f.graph.target };
      f.failBaseSync = 1; await assert.rejects(f.sync, /Fixture base synchronization is unavailable/);
      assert.deepEqual(f.run(), unchanged, "an incompatible observed landing cannot replace an already recorded fact or consume the pending receipt");
      assert.ok(f.store.get().activity.some((entry) => /historical merge source or landing changed/.test(entry.detail ?? "")));
      assert.equal(f.calls.effects.length, saved.effects); f.observationPatch = undefined;
    }
    await f.restart(); f.failBaseSync = 1;
    const observations = f.calls.observations, proofs = f.calls.proofs.length;
    await assert.rejects(f.sync, /Fixture base synchronization is unavailable/);
    assert.ok(f.calls.observations > observations); assert.equal(f.calls.proofs.length - proofs, 1);
    assert.equal(f.run().leafPr.pending, undefined); assert.equal(f.run().fullEvaluation, undefined);
    assert.equal(f.run().continuation.step, "done"); assert.equal(f.run().prState, "merged"); assert.equal(canRetryAgent(f.run()), false);
    assert.deepEqual(f.run().leafPr.merged, fact); assert.deepEqual(historicalCadence(f), cadence);
    assert.equal(f.calls.effects.length, saved.effects); assert.equal(f.calls.merges.length, saved.merges);
    assert.equal(f.calls.gitPushes.length, saved.pushes); assertTerminalEvidence(f, saved);
    if (kind === "progress push") await f.git.verifyGeneratedProgress(f.run().generatedProgress);
  }));
});

function withdrawalInput(f, reason = "Declined in favor of the independently evaluated replacement.") {
  return { expectedHead: f.run().continuation.head, expectedContinuationId: f.run().continuation.id, reason };
}

function withdrawalActivities(f) {
  return f.store.get().activity.filter((entry) => entry.message === "Leaf PR #42 withdrawn");
}

function withdrawalHistory(f) {
  const { leafPr, prState, ...run } = clone(f.run());
  return clone({ run, ideas: f.store.get().ideas, evaluationRuns: f.store.get().evaluationRuns,
    evidence: evidenceSnapshot(f), pushes: f.calls.gitPushes, merges: f.calls.merges });
}

function postWithdrawal(f, input, runId = f.run().id) {
  return fetch(`http://127.0.0.1:${f.server.server.address().port}/api/agents/${runId}/withdraw`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
}

test("public withdrawal preserves a positive leaf's exact history, artifacts, and source while closing once", async (t) => withFixture(t, {}, async (f) => {
  f.commandArtifact = Buffer.from("retained command artifact\0\xff", "latin1");
  await deliver(f);
  f.phase = "full-before-withdrawal";
  assert.equal(await f.full(), true);
  assert.equal(latestFullAssessment(f.run()).qualified, true);
  assert.ok(f.run().impact > 0);
  assert.throws(() => lstatSync(f.run().worktree), { code: "ENOENT" }, "normal checkout cleanup must not prevent retirement");
  const archives = [];
  for (const row of f.store.get().evaluationRuns.filter((row) => row.commandEvidence?.manifest)) {
    const reference = row.commandEvidence;
    const manifestPath = join(f.root, reference.manifest), manifest = await readFile(manifestPath);
    archives.push([manifestPath, manifest]);
    for (const file of JSON.parse(manifest).files) {
      const path = join(f.root, reference.directory, file.path);
      archives.push([path, await readFile(path)]);
    }
  }
  assert.ok(archives.some(([path]) => path.endsWith("/artifacts/fixture.bin")), "the fixture must contain a real archived export");
  // A new current policy/base cannot retroactively replace the old experiment.
  await f.store.update((state) => { Object.assign(state.evaluations[1], { definitionVersion: "v2", prompt: "Later policy", weight: 2 }); });
  const targetPath = join(f.sandbox, "withdrawal-new-base");
  await gitCommand(f.root, "worktree", "add", "--quiet", "-b", "fixture/withdrawal-new-base", targetPath, f.base);
  await writeFile(join(targetPath, "later.txt"), "unrelated newer base\n");
  f.world.target = await f.git.commit(targetPath, "fixture newer base before withdrawal");
  await gitCommand(targetPath, "push", "origin", `${f.world.target}:refs/heads/main`);
  const input = withdrawalInput(f, "  Replacement PR #43; preserve the measured source and archive.\n");
  const decision = clone(input), before = withdrawalHistory(f), known = clone(f.run().leafPr.known);
  const effects = f.calls.effects.length;
  f.onObserve = async () => {
    Object.assign(input, { expectedHead: f.base, expectedContinuationId: "mutated-caller", reason: "A different decision" });
    f.onObserve = undefined;
  };
  const result = await f.withdraw(input);
  assert.equal(result.prState, "closed");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.leafPr.terminal, { kind: "withdrawn", head: decision.expectedHead,
    continuationId: decision.expectedContinuationId, detail: decision.reason.trim() }, "the public method snapshots primitive decision fields before awaiting");
  assert.equal(result.leafPr.pending, undefined);
  assert.deepEqual(result.leafPr.known, { ...known, fields: { ...known.fields, state: "CLOSED" } });
  assert.deepEqual(tuple(f.world.pr), result.leafPr.known.fields);
  assert.deepEqual(f.calls.effects.slice(effects).map((call) => call.name), ["close"], "no presentation or readiness write accompanies withdrawal");
  assert.deepEqual(withdrawalHistory(f), before);
  assert.deepEqual(await f.persistedRun(), result);
  assert.equal(withdrawalActivities(f).length, 1);
  assert.equal(withdrawalActivities(f)[0].detail, decision.reason.trim());
  const activity = clone(withdrawalActivities(f));
  await f.restart();
  assert.deepEqual(await f.withdraw(decision), result);
  await f.sync();
  assert.equal(canRetryAgent(f.run()), false);
  await assert.rejects(f.retry);
  assert.equal(await f.full(), false);
  await assert.rejects(f.merge);
  await assert.rejects(() => f.server.orchestrator.refreshAgentBaseAndRetry(f.run().id));
  assert.deepEqual(withdrawalActivities(f), activity);
  assert.equal(f.calls.effects.length, effects + 1);
  assert.deepEqual(withdrawalHistory(f), before);
  assert.equal(await f.git.resolveRef(f.run().branch), decision.expectedHead);
  assert.equal(await f.git.remoteBranchHead(f.root, "origin", f.run().branch), decision.expectedHead);
  for (const [path, bytes] of archives) assert.deepEqual(await readFile(path), bytes, `withdrawal preserves ${path}`);
}));

test("public and HTTP withdrawal reject malformed or stale decision fields without acquiring terminal authority", async (t) => withFixture(t, {}, async (f) => {
  await deliver(f);
  const input = withdrawalInput(f), before = clone(f.run()), history = withdrawalHistory(f), effects = f.calls.effects.length;
  const malformed = [
    ["missing body", undefined], ["null body", null], ["array body", []], ["primitive body", "withdraw"], ["missing fields", {}],
    ...["expectedHead", "expectedContinuationId", "reason"].flatMap((field) =>
      [undefined, null, false, 42, {}, [input[field]], "", " \n"].map((value) => [`${field}: ${JSON.stringify(value)}`, { ...input, [field]: value }])),
    ["oversized reason", { ...input, reason: "r".repeat(12_001) }],
    ["oversized untrimmed reason", { ...input, reason: `${"r".repeat(12_000)} ` }],
    ["stale head", { ...input, expectedHead: f.base }],
    ["stale continuation", { ...input, expectedContinuationId: "earlier-continuation" }],
    ["head whitespace is not normalized", { ...input, expectedHead: ` ${input.expectedHead}` }],
    ["continuation whitespace is not normalized", { ...input, expectedContinuationId: `${input.expectedContinuationId} ` }],
  ];
  for (const [name, value] of malformed) {
    await scenario(t, f, name, async () => {
      await assert.rejects(() => f.server.orchestrator.withdrawAgent(before.id, value), /Withdrawal|withdrawal|exact source continuation/);
      const response = await postWithdrawal(f, value), body = await response.json();
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.ok(body.error);
      assert.deepEqual(f.run(), before);
      assert.deepEqual(await f.persistedRun(), before);
      assert.equal(f.server.orchestrator.agentClaims.size, 0);
      assert.equal(f.calls.effects.length, effects);
    });
    if (f.failed) return;
  }
  await assert.rejects(() => f.server.orchestrator.withdrawAgent("missing", input), /existing numbered leaf/);
  const missing = await postWithdrawal(f, input, "missing");
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /not found/i);
  assert.deepEqual(withdrawalHistory(f), history);
  assert.deepEqual(withdrawalActivities(f), []);
}));

test("public withdrawal refuses unknown, unfinished, active, and composite-owned sources", async (t) => withFixture(t, {}, async (f) => {
  await deliver(f);
  const original = clone(f.run()), input = withdrawalInput(f), effects = f.calls.effects.length;
  // Admission fault states derived from a genuine delivery. Only the public
  // method is invoked; none of these rows claim a completed terminal effect.
  const variants = [
    ["unknown legacy owner", (run) => { delete run.leafPr; }],
    ["unknown numbered owner", (run) => { delete run.leafPr.known; }],
    ["wrong owned number", (run) => { run.leafPr.known.number = 43; }],
    ["unnumbered leaf", (run) => { delete run.prNumber; }],
    ["missing continuation", (run) => { delete run.continuation; }],
    ["unfinished run", (run) => { run.status = "running"; }],
    ["failed run", (run) => { run.status = "failed"; }],
    ["unfinished continuation", (run) => { run.continuation.step = "delivery"; }],
    ["different outcome", (run) => { run.continuation.outcome = "no_changes"; }],
    ["different published head", (run) => { run.continuation.identity.pullRequest.head = f.base; }],
    ["unfinished publication", (run) => { run.continuation.publication = { branch: run.branch, head: input.expectedHead, prOwnerId: "unfinished" }; }],
    ["unfinished evaluation", (run) => { run.fullEvaluation = { step: "sampling", evaluation: clone(run.continuation.evaluation) }; }],
    ["parent composite experiment", (run) => { run.parentCompositeId = "parent"; }],
    ["unrelated PR intent", (run) => { run.leafPr.pending = { id: "unrelated", owner: { kind: "review-checkpoint", continuationId: run.continuation.id }, target: clone(run.leafPr.known.fields) }; }],
    ["unexplained closed owner", (run) => { run.prState = "closed"; run.leafPr.known.fields.state = "CLOSED"; }],
    ["unexplained CLOSED tuple under stale OPEN display", (run) => { run.leafPr.known.fields.state = "CLOSED"; }],
    ["terminal display without proof", (run) => { run.prState = "merged"; }],
  ];
  for (const [name, change] of variants) {
    await f.store.update((state) => { state.agentRuns[0] = clone(original); change(state.agentRuns[0]); });
    await scenario(t, f, name, async () => {
      const before = clone(f.run());
      await assert.rejects(() => f.withdraw(input));
      assert.deepEqual(f.run(), before);
      assert.deepEqual(await f.persistedRun(), before);
      assert.equal(f.calls.effects.length, effects);
      assert.equal(f.server.orchestrator.agentClaims.size, 0);
    });
    if (f.failed) return;
  }
  await f.store.update((state) => { state.agentRuns[0] = clone(original); });
  f.server.orchestrator.activeAgents.add(original.ideaId);
  try { await assert.rejects(() => f.withdraw(input), /idle completed source/); }
  finally { f.server.orchestrator.activeAgents.delete(original.ideaId); }
  assert.deepEqual(f.run(), original);
  const source = { agentRunId: original.id, prNumber: original.prNumber, title: "Owned source", branch: original.branch, kind: "pull_request" };
  for (const status of ["queued", "building", "reviewing", "revising", "evaluating", "rebuilding", "open"]) {
    await f.store.update((state) => { state.composites = [{ id: "reservation", title: "Reserved source", description: "Admission fixture", status,
      branch: "fixture/reservation", worktree: "", sources: [source], deltas: [], reviewRounds: [], isLiving: false,
      createdAt: original.startedAt, updatedAt: original.startedAt }]; });
    await scenario(t, f, `composite ${status}`, async () => {
      const composite = clone(f.store.get().composites);
      await assert.rejects(() => f.withdraw(input), /idle completed source/);
      assert.deepEqual(f.run(), original);
      assert.deepEqual(f.store.get().composites, composite);
      assert.equal(f.calls.effects.length, effects);
    });
    if (f.failed) return;
  }
  await f.store.update((state) => { state.composites[0].status = "failed"; });
  assert.equal((await f.withdraw(input)).prState, "closed", "a failed historical composite is not a live source reservation");
  assert.equal(f.calls.effects.length, effects + 1);
}));

test("public withdrawal preserves dirty and foreign extant checkouts, then accepts the exact clean source", async (t) => withFixture(t, {}, async (f) => {
  await deliver(f);
  const input = withdrawalInput(f), before = clone(f.run()), effects = f.calls.effects.length;
  await gitCommand(f.root, "worktree", "add", "--quiet", before.worktree, before.branch);
  const code = join(before.worktree, "code.txt"), bytes = await readFile(code);
  await writeFile(code, "operator's uncommitted changes\n");
  await assert.rejects(() => f.withdraw(input), /dirty|mismatching/i);
  assert.equal(await readFile(code, "utf8"), "operator's uncommitted changes\n");
  assert.deepEqual(f.run(), before);
  await writeFile(code, bytes);
  await gitCommand(before.worktree, "switch", "-c", "fixture/foreign-withdrawal", f.base);
  await assert.rejects(() => f.withdraw(input), /worktree|branch/i);
  assert.equal(await gitCommand(before.worktree, "branch", "--show-current"), "fixture/foreign-withdrawal");
  await gitCommand(f.root, "branch", "-f", before.branch, f.base);
  await assert.rejects(() => f.withdraw(input), /local leaf branch changed/);
  assert.equal(await f.git.resolveRef(before.branch), f.base);
  assert.deepEqual(f.run(), before);
  assert.equal(f.calls.effects.length, effects);
  await gitCommand(f.root, "branch", "-f", before.branch, input.expectedHead);
  await gitCommand(before.worktree, "switch", before.branch);
  assert.equal((await f.withdraw(input)).prState, "closed");
  assert.deepEqual(await readFile(code), bytes);
  assert.equal(await f.git.head(before.worktree), input.expectedHead, "withdrawal does not remove a valid extant checkout");
}));

test("public withdrawal refuses every third remote identity/content tuple and unexplained external closure", async (t) => withFixture(t, {}, async (f) => {
  await deliver(f);
  const input = withdrawalInput(f), before = clone(f.run()), history = withdrawalHistory(f), effects = f.calls.effects.length;
  const variants = [
    ["title", { title: "foreign title" }], ["body", { body: "foreign body" }], ["draft", { isDraft: false }],
    ["external close", { state: "CLOSED" }], ["unknown lifecycle", { state: undefined }],
    ["repository", { repository: { ...repository, id: "other" } }],
    ["head repository", { headRepository: { ...repository, id: "other" } }],
    ["base repository", { baseRepository: { ...repository, id: "other" } }],
    ["number", { number: 43 }], ["URL", { url: url(43) }], ["branch", { headRefName: "fixture/other" }],
    ["head", { headRefOid: f.base }], ["base branch", { baseRefName: "other-main" }], ["unknown base", { baseRefOid: undefined }],
  ];
  for (const [name, patch] of variants) {
    f.observationPatch = patch;
    await scenario(t, f, name, async () => {
      await assert.rejects(() => f.withdraw(input));
      assert.deepEqual(f.run(), before);
      assert.deepEqual(await f.persistedRun(), before);
      assert.equal(f.calls.effects.length, effects);
      assert.deepEqual(withdrawalActivities(f), []);
    });
    if (f.failed) return;
  }
  f.observationPatch = { state: "CLOSED" };
  const response = await postWithdrawal(f, input), body = await response.json();
  assert.equal(response.status, 400, JSON.stringify(body));
  assert.match(body.error, /third.*tuple/);
  assert.deepEqual(withdrawalHistory(f), history);
  f.observationPatch = undefined;
  assert.equal((await f.withdraw(input)).prState, "closed");
}));

test("public withdrawal does not overtake real unfinished full, progress, or readiness owners", async (t) => {
  for (const owner of ["full publication", "progress push", "merge readiness"]) await t.test(owner, async (t) => withFixture(t, {}, async (f) => {
    if (owner === "full publication") await pendingFullPublication(f);
    else {
      await deliver(f);
      if (owner === "progress push") f.interruptProgressPush = true;
      else f.fault = { name: "ready", cut: "request-error", hit: false };
      await assert.rejects(f.merge);
      if (owner === "progress push") assert.equal(f.run().continuation.step, "progress");
      else { assert.equal(f.fault.hit, true); assert.equal(f.run().leafPr.pending.owner.kind, "merge-ready"); }
      f.fault = undefined;
    }
    const before = clone(f.run()), history = withdrawalHistory(f), effects = f.calls.effects.length;
    await assert.rejects(() => f.withdraw());
    assert.deepEqual(f.run(), before);
    assert.deepEqual(withdrawalHistory(f), history);
    assert.equal(f.calls.effects.length, effects);
    assert.equal(f.run().leafPr.terminal, undefined);
  }));
});

test("public withdrawal recovers effect and semantic acknowledgment cuts with one completed activity", async (t) => {
  for (const cut of ["request-error", "lost-response", "before-state-ack", "lost-state-ack", "before-semantic-ack", "lost-semantic-ack"]) {
    await t.test(cut, async (t) => withFixture(t, {}, async (f) => {
      await deliver(f);
      const input = withdrawalInput(f), history = withdrawalHistory(f), known = clone(f.run().leafPr.known);
      const effects = f.calls.effects.length;
      if (["request-error", "lost-response", "lost-state-ack"].includes(cut)) f.fault = { name: "close", cut, hit: false };
      else f.stateCut = { hit: false, afterWrite: cut === "lost-semantic-ack", matches: (before, after) =>
        before?.leafPr?.pending?.owner.kind === "terminal-close" && (cut === "before-state-ack"
          ? before.leafPr.pending.effect?.kind === "close" && !after?.leafPr?.pending?.effect && after?.leafPr?.known.fields.state === "CLOSED"
          : !before.leafPr.pending.effect && before.leafPr.known.fields.state === "CLOSED" && !after?.leafPr?.pending) };
      const result = await attempt(() => f.withdraw(input)), fault = f.fault ?? f.stateCut;
      assert.equal(fault.hit, true, result.error?.stack);
      const request = f.calls.effects.at(-1);
      assert.equal(request.pending.owner.kind, "terminal-close");
      assert.equal(request.pending.owner.reason.kind, "withdrawn");
      assert.deepEqual(request.pending.effect.before, known.fields);
      assert.deepEqual(request.pending.target, { ...known.fields, state: "CLOSED" });
      if (cut === "lost-state-ack") {
        assert.equal(fault.ackHit, true);
        assert.equal(fault.acknowledged.leafPr.pending.effect, undefined);
      }
      if (cut === "lost-semantic-ack") {
        assert.equal(fault.acknowledged.leafPr.pending, undefined);
        assert.equal(fault.acknowledged.prState, "closed");
      }
      if (["lost-state-ack", "lost-semantic-ack"].includes(cut)) {
        assert.equal(result.value?.prState, "closed", "a recognized durable successor may complete despite a lost acknowledgment");
        assert.equal(withdrawalActivities(f).length, 1);
      } else {
        assert.ok(result.error, "an unfinished request cannot claim success");
        assert.equal(f.run().prState, "open");
        assert.equal(f.run().leafPr.pending.id, request.pending.id);
        assert.deepEqual(f.run().leafPr.pending.owner, request.pending.owner);
        assert.equal(f.run().leafPr.known.fields.state, cut === "before-semantic-ack" ? "CLOSED" : "OPEN");
        assert.deepEqual(withdrawalActivities(f), []);
      }
      const decision = clone(f.run().leafPr.terminal), pending = clone(f.run());
      await assert.rejects(() => f.withdraw({ ...input, reason: "Conflicting repeat" }), /different.*reason/i);
      assert.deepEqual(f.run(), pending);
      f.fault = f.stateCut = undefined;
      await f.restart();
      if (cut === "request-error") await f.withdraw(input); else await f.sync();
      assert.equal(f.run().prState, "closed", JSON.stringify(f.store.get().activity.slice(0, 4)));
      assert.equal(f.run().leafPr.pending, undefined);
      assert.deepEqual(f.run().leafPr.terminal, decision);
      assert.deepEqual(f.run().leafPr.known.fields, request.pending.target);
      assert.equal(withdrawalActivities(f).length, 1);
      assert.equal(withdrawalActivities(f)[0].detail, input.reason);
      const activity = clone(withdrawalActivities(f)), settled = clone(f.run());
      await f.restart();
      assert.deepEqual(await f.withdraw(input), settled);
      await f.sync();
      assert.deepEqual(withdrawalActivities(f), activity);
      assert.deepEqual(withdrawalHistory(f), history);
      assert.equal(f.calls.effects.length - effects, cut === "request-error" ? 2 : 1);
      assert.equal(f.calls.effects.slice(effects).filter((call) => call.applied).length, 1);
    }));
  }
});

test("pending public withdrawal excludes new qualification, merge selection, and composite admission while still OPEN", async (t) => withFixture(t, {}, async (f) => {
  await deliver(f);
  assert.equal(await f.full(), true, "a positive cache exists before the withdrawal latch");
  const original = clone(f.run());
  // A second display-only source makes the selection/admission checks sensitive
  // to this leaf's terminal latch, not just a minimum-size or missing-ID error.
  await f.store.update((state) => { state.agentRuns.push({ ...clone(original), id: "other-leaf", ideaId: "other-idea", prNumber: 43,
    prUrl: url(43), branch: "fixture/other-leaf", impact: original.impact - 1 }); state.ideas[0].lane = "foundational"; });
  const planningFlags = [];
  t.mock.method(f.server.orchestrator.codex, "planIdeas", async (cwd, _evaluations, _latest, _ideas, _settings, pending) => {
    f.modelBoundary(cwd); f.calls.models.push("planIdeas"); planningFlags.push(pending); return [];
  });
  await f.server.orchestrator.plan();
  assert.deepEqual(planningFlags, [true]);
  assert.equal(selectYoloMergeCandidate(f.store.get(), f.base).id, original.id);
  assert.deepEqual(selectYoloLeafBatch(f.store.get(), f.base, 2), [original.id, "other-leaf"]);
  f.fault = { name: "close", cut: "request-error", hit: false };
  const input = withdrawalInput(f);
  await assert.rejects(() => f.withdraw(input), /request failed/);
  assert.equal(f.fault.hit, true);
  f.fault = undefined;
  assert.equal(f.run().prState, "open");
  assert.equal(f.world.pr.state, "OPEN");
  assert.equal(f.run().leafPr.terminal.kind, "withdrawn");
  const before = clone(f.run()), history = withdrawalHistory(f), effects = f.calls.effects.length;
  assert.equal(await f.full(), false, "cached positive qualification cannot bypass terminal ownership");
  assert.equal(selectYoloMergeCandidate(f.store.get(), f.base).id, "other-leaf");
  assert.deepEqual(selectYoloLeafBatch(f.store.get(), f.base, 2), []);
  for (const kind of ["review-limit", "superseded"]) {
    const projected = clone(f.store.get());
    projected.agentRuns.find((run) => run.id === original.id).leafPr.terminal = { kind, continuationId: input.expectedContinuationId };
    assert.equal(selectYoloMergeCandidate(projected, f.base).id, "other-leaf", "selection obeys the generic terminal latch");
    assert.deepEqual(selectYoloLeafBatch(projected, f.base, 2), []);
  }
  await assert.rejects(() => f.server.orchestrator.createComposite([original.id, "other-leaf"]), /nonterminal/);
  assert.deepEqual(f.store.get().composites, []);
  assert.equal(f.server.orchestrator.agentClaims.size, 0);
  assert.deepEqual(f.run(), before);
  assert.deepEqual(withdrawalHistory(f), history);
  assert.equal(f.calls.effects.length, effects);
  await f.server.orchestrator.plan();
  assert.deepEqual(planningFlags, [true, false], "a pending withdrawal frees the foundational delivery slot without changing idea history");
  // A changed after-image must keep this same immutable pending owner unresolved.
  f.observationPatch = { body: "foreign edit while withdrawal is pending" };
  await assert.rejects(() => f.withdraw(input), /third.*tuple/);
  assert.deepEqual(f.run(), before);
  assert.equal(f.calls.effects.length, effects);
  f.observationPatch = undefined;
  await assert.rejects(f.merge, /closed|open/i);
  assert.equal(f.run().prState, "closed", "manual merge may settle the pending close, but cannot revive it");
  assert.equal(f.calls.merges.length, 0);
}));

test("HTTP withdrawal reports failures, awaits actual settlement, and serializes a competing public request", async (t) => withFixture(t, {}, async (f) => {
  await deliver(f);
  const input = withdrawalInput(f, "r".repeat(12_000));
  f.fault = { name: "close", cut: "request-error", hit: false };
  const failed = await postWithdrawal(f, input), failure = await failed.json();
  assert.equal(failed.status, 400, JSON.stringify(failure));
  assert.match(failure.error, /request failed before effect/);
  assert.equal(f.run().prState, "open");
  assert.deepEqual(withdrawalActivities(f), []);
  f.fault = undefined;
  let entered, release;
  const observed = new Promise((done) => { entered = done; }), paused = new Promise((done) => { release = done; });
  f.onObserve = async () => { f.onObserve = undefined; entered(); await paused; };
  let returned = false;
  const responsePromise = postWithdrawal(f, input).then((response) => { returned = true; return response; });
  try {
    await Promise.race([observed, responsePromise.then(() => assert.fail("HTTP returned before observing the exact source"))]);
    assert.equal(returned, false, "the route must not send a premature 202 response");
    assert.equal(f.world.pr.state, "OPEN");
    await assert.rejects(() => f.withdraw(input), /already reserved/);
    assert.equal(await f.full(), false);
  } finally { release(); }
  const response = await responsePromise, result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.prState, "closed");
  assert.equal(result.status, "completed");
  assert.equal(result.leafPr.terminal.detail, input.reason, "the exact 12000-character boundary is accepted");
  assert.deepEqual(result, await f.persistedRun());
  assert.equal(f.server.orchestrator.agentClaims.size, 0);
  const repeated = await postWithdrawal(f, input);
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), result);
  assert.equal(withdrawalActivities(f).length, 1);
  assert.equal(f.calls.effects.filter((call) => call.name === "close" && call.applied).length, 1);
}));

test("Unicode withdrawal reasons survive direct admission, HTTP recovery, and identical retries after restart", async (t) => {
  for (const [name, reason, expected] of [
    ["lone high surrogate", "  Archive \ud800 before replacement.\n", "Archive \ufffd before replacement."],
    ["lone low surrogate", "\tArchive \udfff before replacement.  ", "Archive \ufffd before replacement."],
    ["valid pair and international text", "  Use \ud83d\udd25 replacement; retain 実測 and café.  ", "Use \ud83d\udd25 replacement; retain 実測 and café."],
  ]) await t.test(name, async (t) => withFixture(t, {}, async (f) => {
    await deliver(f);
    const input = withdrawalInput(f, reason), history = withdrawalHistory(f), effects = f.calls.effects.length;
    f.fault = { name: "close", cut: "request-error", hit: false };
    await assert.rejects(() => f.withdraw(input), /request failed before effect/);
    assert.equal(f.fault.hit, true, "normalization must not break ownership before the admitted close request");
    assert.deepEqual(f.run().leafPr.terminal, { kind: "withdrawn", continuationId: input.expectedContinuationId, head: input.expectedHead, detail: expected });
    assert.deepEqual(await f.persistedRun(), f.run(), "the in-memory owner and serialized owner agree before recovery");
    assert.deepEqual(withdrawalActivities(f), []);
    f.fault = undefined;
    await f.restart();
    const response = await postWithdrawal(f, input), result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.prState, "closed");
    assert.equal(result.leafPr.terminal.detail, expected);
    assert.deepEqual(result, await f.persistedRun());
    assert.equal(withdrawalActivities(f).length, 1);
    assert.equal(withdrawalActivities(f)[0].detail, expected);
    const activity = clone(withdrawalActivities(f));
    await f.restart();
    assert.deepEqual(await f.withdraw(input), result, "the identical original Unicode input resumes the canonical decision");
    assert.deepEqual(await f.withdraw({ ...input, reason: expected }), result, "the stored human-readable reason is the same decision");
    const repeated = await postWithdrawal(f, input);
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), result);
    await f.sync();
    assert.deepEqual(withdrawalActivities(f), activity);
    assert.deepEqual(withdrawalHistory(f), history);
    assert.deepEqual(f.calls.effects.slice(effects).map((call) => [call.name, call.applied]), [["close", false], ["close", true]]);
  }));
});

test("public withdrawal reports a proved merge race but refuses squash-equivalent and detached landings", async (t) => {
  for (const [kind, timing] of [["first-parent", "before intent"], ["first-parent", "close request"], ["squash", "close request"], ["detached-landing", "close request"]]) {
    await t.test(`${kind}: ${timing}`, async (t) => withFixture(t, {}, async (f) => {
      await deliver(f);
      const input = withdrawalInput(f), known = clone(f.run().leafPr.known), saved = terminalSnapshot(f);
      if (timing === "before intent") await landFixturePr(f, kind);
      else f.closeRace = async () => {
        await landFixturePr(f, kind);
        throw new TransientMergeGateError("Fixture withdrawal raced with MERGED before its close effect");
      };
      const result = await attempt(() => f.withdraw(input));
      f.closeRace = undefined;
      assert.deepEqual(f.run().leafPr.known, known, "MERGED does not invent a CLOSED after-image");
      assert.deepEqual(withdrawalActivities(f), []);
      assertTerminalEvidence(f, saved);
      const effects = f.calls.effects.length, pushes = f.calls.gitPushes.length;
      assert.equal(effects - saved.effects, timing === "before intent" ? 0 : 1);
      if (timing === "close request") assert.equal(f.calls.effects.at(-1).applied, false);
      if (kind === "first-parent") {
        assert.equal(result.value?.prState, "merged", result.error?.stack);
        assert.equal(f.run().leafPr.pending, undefined);
        assert.deepEqual(f.run().leafPr.merged, { sourceBase: f.base, head: input.expectedHead, landing: f.graph.landing, targetCommit: f.graph.target });
        if (timing === "before intent") assert.equal(f.run().leafPr.terminal, undefined, "an already-won merge cannot gain invented withdrawal proof");
        else assert.equal(f.run().leafPr.terminal.kind, "withdrawn");
      } else {
        assert.match(result.error?.message ?? "", /ancestry|inclusion/i);
        assert.equal(f.run().prState, "open");
        assert.equal(f.run().leafPr.merged, undefined);
        assert.equal(f.run().leafPr.pending.effect.kind, "close");
      }
      const prior = clone(f.run());
      await f.restart();
      await f.sync();
      assert.deepEqual(f.run(), prior);
      if (kind === "first-parent") assert.equal((await f.withdraw(input)).prState, "merged");
      else await assert.rejects(() => f.withdraw(input), /ancestry|inclusion/i);
      assert.equal(f.calls.effects.length, effects);
      assert.equal(f.calls.gitPushes.length, pushes, "recovery must not rewrite either actual fixture graph");
      assert.equal(f.calls.merges.length, saved.merges);
      assert.deepEqual(withdrawalActivities(f), []);
      assertTerminalEvidence(f, saved);
    }));
  }
});
