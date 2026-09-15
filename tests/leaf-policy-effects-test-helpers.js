import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fsPromises from "node:fs/promises";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { CodexClient } from "../dist/lib/codex.js";
import { GitService, TransientMergeGateError } from "../dist/lib/git.js";
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
  // Fail at the actual StateStore rename boundary, not at a semantic owner.
  const rename = fsPromises.rename;
  t.mock.method(fsPromises, "rename", async (from, to) => {
    const fault = f.ackFault;
    if (fault && !fault.hit && to === join(f.root, ".burner", "state.json")) {
      const proposed = JSON.parse(await readFile(from, "utf8")).agentRuns.find((run) => run.ideaId === "idea");
      if (proposed?.leafPr?.pending?.id === fault.pending.id && !proposed.leafPr.pending.effect &&
          equal(proposed.leafPr.known.fields, fault.pending.effect.after)) {
        fault.hit = true;
        fault.proposed = clone(proposed);
        if (fault.cut === "after") await rename(from, to);
        fault.durable = await f.persistedRun();
        throw new Error(`Fixture acknowledgment rename failed ${fault.cut} durability`);
      }
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
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

}

async function fixture(t, options = {}) {
  const sandbox = await mkdtemp(join(tmpdir(), "burner-policy-effects-"));
  const root = join(sandbox, "project");
  const f = { sandbox, root, bin: join(root, "bin"), failed: false, ready: false, world: {}, phase: "delivery",
    mergeAttempts: 1, reviewApproval: true, scores: { command: 60, prompt: 55 },
    calls: { effects: [], merges: [], searches: 0, observations: 0, samples: [], models: [], gitPushes: [], blocked: [] } };
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

async function attempt(action) {
  try { return { value: await action() }; } catch (error) { return { error }; }
}

function evidenceSnapshot(f) {
  return clone({ samples: f.calls.samples, models: f.calls.models, reviews: f.run().reviewRounds,
    full: f.run().fullEvaluationHistory, delivery: f.run().continuation?.step === "progress"
      ? f.run().continuation.done.evaluation : f.run().continuation?.evaluation });
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

export { withFixture, attempt, clone, tuple, deliver, readyAtMergeBoundary, landFixturePr, evidenceSnapshot, assertEvidenceUnchanged };
