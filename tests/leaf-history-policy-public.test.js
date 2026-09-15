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
import { canRetryAgent, fullAssessmentForIdentity, latestFullAssessment } from "../dist/lib/orchestrator.js";
import { runCommand } from "../dist/lib/process.js";
import { StateStore } from "../dist/lib/store.js";
import { createBurnerServer } from "../dist/server.js";

const portfolio = { yolo: true, yoloBatchSize: 3 };
const singleLeafAutopilot = { yolo: true, yoloBatchSize: 1 };
const mergeStop = "Isolated fixture reached the checked merge boundary";
const leafRepository = { host: "example.test", id: "policy-fixture-repository", nameWithOwner: "fixture/policy" };
const evaluations = [
  { id: "command", name: "Deterministic check", prompt: "Fixture command score", command: "fixture-command-must-never-execute", weight: 1, enabled: true, definitionVersion: "v1" },
  { id: "prompt", name: "Independent quality", prompt: "Fixture prompt score", weight: 1, enabled: true, definitionVersion: "v1" },
];

function executable(path) {
  assert.equal(lstatSync(path).isFile(), true, `${path} must be a regular non-symlink file`);
  assert.equal(realpathSync(path), path, `${path} must not resolve through a symlink`);
  accessSync(path, constants.X_OK);
  return path;
}

async function gitCommand(cwd, ...args) {
  const result = await runCommand("git", args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

// Model methods are mocked, but the fixture also installs an executable local
// Codex and denies every unrecognized subprocess. A newly added/missed method
// must fail closed, not find the developer's actual Codex/GitHub installation.
function installEffectGuards(t, f) {
  const pathBefore = process.env.PATH;
  const tmpBefore = process.env.TMPDIR;
  const gitExecutable = pathBefore.split(delimiter).map((path) => join(path, "git")).find((path) => {
    try { accessSync(path, constants.X_OK); return lstatSync(path).isFile() || lstatSync(path).isSymbolicLink(); }
    catch { return false; }
  });
  assert.ok(gitExecutable, "the existing Node Git fixtures require Git");
  const actualGit = realpathSync(gitExecutable);
  const spawn = childProcess.spawn;
  const local = (cwd) => {
    const absolute = resolve(cwd);
    assert.ok(absolute === f.sandbox || absolute.startsWith(`${f.sandbox}${sep}`), `outside isolated fixture: ${absolute}`);
    // A public merge/retry first probes the old checkout and legitimately gets
    // ENOENT after delivery removed it. Check containment through its nearest
    // existing ancestor, then let spawn report that ordinary missing-cwd error.
    let existing = absolute;
    while (true) {
      try { lstatSync(existing); break; }
      catch (error) {
        if (error.code !== "ENOENT" || existing === f.sandbox) throw error;
        existing = dirname(existing);
      }
    }
    assert.equal(realpathSync(existing), existing, "fixture subprocess cwd cannot traverse a symlink");
  };
  f.assertModelBoundary = (cwd) => {
    local(cwd);
    assert.equal(process.env.PATH.split(delimiter)[0], f.bin);
    executable(join(f.bin, "codex"));
  };
  process.env.PATH = `${f.bin}${delimiter}${pathBefore}`;
  process.env.TMPDIR = join(f.sandbox, "tmp");
  childProcess.spawn = (command, args, options) => {
    try {
      local(options.cwd);
      const environment = {
        PATH: `${dirname(actualGit)}${delimiter}/usr/bin${delimiter}/bin`, LANG: "C",
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0",
      };
      if (options.env?.GIT_INDEX_FILE) {
        local(dirname(options.env.GIT_INDEX_FILE));
        environment.GIT_INDEX_FILE = options.env.GIT_INDEX_FILE;
      }
      if (command === "git") return spawn(actualGit, args, { ...options, env: environment });
      assert.equal(command, "gh", "model, shell, and other executable fallthrough is forbidden");
      assert.ok(JSON.stringify(args) === '["--version"]' || JSON.stringify(args) === '["auth","status"]', "only fake GitHub readiness probes may execute");
      return spawn(executable(join(f.bin, "gh")), args, { ...options, env: environment });
    } catch (error) {
      f.calls.blocked.push({ command, args, message: error.message });
      throw error;
    }
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.spawn = spawn;
    syncBuiltinESMExports();
    if (pathBefore === undefined) delete process.env.PATH;
    else process.env.PATH = pathBefore;
    if (tmpBefore === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = tmpBefore;
  });
}

function installExternalFakes(t, f) {
  const session = () => ({ threadId: "fixture-author", message: "Fixture implementation and evidence" });
  const models = {
    close: () => undefined,
    preflight: async (cwd) => f.assertModelBoundary(cwd),
    available: async (cwd) => { f.assertModelBoundary(cwd); return false; },
    implement: async (cwd) => {
      f.assertModelBoundary(cwd);
      f.calls.models.push("implement");
      // Public pause lets the admitted fallback finish without a second
      // scheduler cycle starting unrelated work after this fixture's delivery.
      if (f.pauseOnAuthor) await f.server.orchestrator.setEnabled(false);
      await writeFile(join(cwd, "implementation.txt"), "authored candidate\n");
      return session();
    },
    refreshAgentEvidence: async (cwd) => {
      f.assertModelBoundary(cwd);
      f.calls.models.push("evidence");
      return session();
    },
    review: async (cwd) => {
      f.assertModelBoundary(cwd);
      f.calls.models.push("review");
      const round = f.calls.models.filter((method) => method === "review").length;
      const approved = round >= f.approveAtRound;
      return { approved, summary: approved ? "Fixture approved" : "Fixture requests a revision", findings: approved ? [] : [
        { severity: "high", title: "Revise implementation", detail: "A fixture review finding", file: "implementation.txt" },
      ] };
    },
    revise: async (cwd, threadId) => {
      f.assertModelBoundary(cwd);
      assert.equal(threadId, "fixture-author");
      f.calls.models.push("revise");
      const revision = f.calls.models.filter((method) => method === "revise").length;
      if (revision === f.interruptRevision) throw new Error("Fixture revision interruption before editing");
      await writeFile(join(cwd, "implementation.txt"), `revised candidate ${revision}\n`);
      return session();
    },
    evaluate: async (cwd, evaluation, _settings, context, _baseline, commandEvidence) => {
      f.assertModelBoundary(cwd);
      assert.ok(["agent", "composite"].includes(context), "no baseline or campaign evaluation is authorized");
      const sample = { phase: f.phase, evaluationId: evaluation.id, context, command: evaluation.command, screeningCommand: evaluation.screeningCommand };
      f.calls.samples.push(sample);
      f.calls.order.push(`sample:${f.phase}:${evaluation.id}`);
      if (f.failDeliverySamples && f.phase === "delivery") {
        const error = new Error("Fixture interrupted delivery evaluator");
        if (commandEvidence) {
          commandEvidence.startCommand();
          await commandEvidence.recordCommand(undefined, error);
        }
        throw error;
      }
      const output = { score: f.scores[evaluation.id], summary: `Fixture ${f.phase} ${evaluation.id}`, evidence: ["isolated fixture"], suggestions: [] };
      if (evaluation.command) {
        assert.ok(commandEvidence, "the actual evaluator runner owns command evidence retention");
        const stdout = JSON.stringify(output);
        commandEvidence.startCommand();
        commandEvidence.append("stdout", stdout);
        await commandEvidence.recordCommand({ exitCode: 0, stdout, stderr: "" });
        await commandEvidence.recordNormalized(output);
      }
      return output;
    },
  };
  for (const method of Object.getOwnPropertyNames(CodexClient.prototype)) {
    if (method === "constructor") continue;
    t.mock.method(CodexClient.prototype, method, models[method] ?? (() => assert.fail(`unexpected Codex effect: ${method}`)));
  }

  const pr = async () => {
    assert.ok(f.world.pr, "only the fixture's published PR may be inspected");
    return { ...f.world.pr, repository: structuredClone(leafRepository), headRepository: structuredClone(leafRepository),
      baseRepository: structuredClone(leafRepository), baseRefName: "main", baseRefOid: f.base,
      headRefOid: await f.git.remoteBranchHead(f.root, "origin", f.world.pr.headRefName), mergeable: "MERGEABLE",
      statusCheckRollup: [{ name: "fixture-check", status: "COMPLETED", conclusion: "SUCCESS" }] };
  };
  const numberIsFixture = (number) => assert.equal(number, 42);
  const leafScope = (cwd, repository, number) => {
    assert.equal(cwd, f.root);
    assert.deepEqual(repository, leafRepository);
    if (number !== undefined) numberIsFixture(number);
  };
  const github = {
    leafRepository: async (cwd, remote) => {
      assert.equal(cwd, f.root);
      assert.equal(remote, "origin");
      return structuredClone(leafRepository);
    },
    observeLeafPr: async (cwd, repository, number) => { leafScope(cwd, repository, number); return pr(); },
    findLeafPrs: async (cwd, repository, branch) => {
      leafScope(cwd, repository);
      return f.world.pr?.headRefName === branch ? [await pr()] : [];
    },
    createLeafPr: async (options) => {
      leafScope(options.cwd, options.repository);
      assert.equal(options.baseBranch, "main");
      assert.equal(f.world.pr, undefined, "delivery must create just one PR");
      f.world.pr = { number: 42, state: "OPEN", url: "https://example.test/fixture/policy/pull/42", headRefName: options.branch,
        title: options.title, body: options.body, isDraft: options.isDraft, labels: [] };
      f.calls.pr.push("open");
      return { number: 42, url: f.world.pr.url };
    },
    listPullRequests: async () => f.world.pr ? [await pr()] : [],
    editLeafPrField: async (cwd, repository, number, field, value) => {
      leafScope(cwd, repository, number);
      assert.ok(field === "title" || field === "body");
      f.world.pr[field] = value;
      f.calls.pr.push(`edit:${field}`);
    },
    setLeafPrDraft: async (cwd, repository, number, isDraft) => {
      leafScope(cwd, repository, number);
      if (!isDraft) assert.equal(f.run().leafPr.pending.owner.kind, "merge-ready", "readiness belongs to the admitted merge owner");
      f.world.pr.isDraft = isDraft;
      f.calls.pr.push(isDraft ? "draft" : "ready");
    },
    closeLeafPr: async (cwd, repository, number) => {
      leafScope(cwd, repository, number);
      f.world.pr.state = "CLOSED";
      f.calls.pr.push("close");
    },
    markPrDisposition: async (_cwd, number) => numberIsFixture(number),
    markPrQuarantined: async (_cwd, number) => numberIsFixture(number),
    mergeLeafPr: async (cwd, repository, number, head) => {
      leafScope(cwd, repository, number);
      assert.equal(head, (await pr()).headRefOid, "merge uses the exact published progress head");
      assert.equal(f.run().leafPr.pending, undefined);
      assert.equal(f.run().leafPr.known.fields.isDraft, false);
      assert.equal(f.world.pr.isDraft, false);
      f.calls.merges.push(head);
      f.calls.order.push("merge");
      // Exercise the public merge owner through its real gates/progress stamp,
      // then stop at the external transport seam; no remote/base merge occurs.
      throw new TransientMergeGateError(mergeStop);
    },
    leafMergePolling: () => ({ mergeAttempts: 1, checkAttempts: 2, noCheckGraceAttempts: 0, intervalMs: 0 }),
  };
  for (const [method, implementation] of Object.entries(github)) t.mock.method(GitService.prototype, method, implementation);
  for (const method of ["getPullRequest", "pullRequestsForBranch", "openPr", "editPr", "isPrDraft", "markPrReady", "markPrDraft", "reopenPr", "closePr", "mergePr"]) {
    t.mock.method(GitService.prototype, method, () => {
      f.calls.blocked.push({ method });
      assert.fail(`generic PR transport cannot supply leaf authority: ${method}`);
    });
  }
}

async function fixture(t, options = {}) {
  const sandbox = await mkdtemp(join(tmpdir(), "burner-public-leaf-policy-"));
  const root = join(sandbox, "project");
  const f = { sandbox, root, bin: join(root, "bin"), retain: true, phase: "delivery", approveAtRound: 1,
    scores: { command: 60, prompt: options.promptScore ?? 52 }, world: {},
    calls: { models: [], samples: [], merges: [], pr: [], order: [], blocked: [] } };
  await mkdir(f.bin, { recursive: true });
  await mkdir(join(sandbox, "tmp"));
  await writeFile(join(f.bin, "codex"), "#!/bin/sh\nexit 97\n");
  await writeFile(join(f.bin, "gh"), "#!/bin/sh\nexit 0\n");
  await chmod(join(f.bin, "codex"), 0o700);
  await chmod(join(f.bin, "gh"), 0o700);
  executable(join(f.bin, "codex"));
  installEffectGuards(t, f);
  installExternalFakes(t, f);
  t.after(async () => {
    await f.server?.close();
    if (f.retain) t.diagnostic(`Retained failed isolated policy fixture: ${sandbox}`);
    else await rm(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  await gitCommand(root, "init", "-b", "main");
  await gitCommand(root, "config", "maintenance.auto", "false");
  await gitCommand(root, "config", "gc.auto", "0");
  await writeFile(join(root, ".gitignore"), ".burner/\nbin/\n");
  await writeFile(join(root, "README.md"), "# Isolated policy fixture\n");
  await writeFile(join(root, "implementation.txt"), "base implementation\n");
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
    Object.assign(state.settings, { autoRun: false, autoCreatePrs: true, defaultResources: [], parallelism: 1,
      preferLivingComposite: false, maxReviewRounds: 2, portfolioReviewRounds: 4,
      mergeCadenceMinutes: 120, stallTerminationHours: 0 });
    Object.assign(state.orchestrator, { enabled: false, lastEvaluationAt: timestamp, lastPlanningAt: timestamp, mergeWindowStartedAt: timestamp });
    state.evaluations = structuredClone(evaluations).map((evaluation) => ({ ...evaluation, createdAt: timestamp }));
    state.evaluationRuns = state.evaluations.map((evaluation) => ({ id: `baseline-${evaluation.id}`, evaluationId: evaluation.id,
      evaluationDefinitionVersion: evaluation.definitionVersion, commit: f.base, context: "baseline", status: "completed", score: 50,
      ...(!evaluation.command ? { promptSampleCount: 3 } : {}), summary: "Frozen exact baseline", evidence: [], suggestions: [], durationMs: 1, createdAt: timestamp }));
    state.ideas = [{ id: "idea", title: "Isolated candidate", description: "Improve the fixture implementation", rationale: "Public policy contract",
      predictedImpact: 10, evaluationIds: ["command", "prompt"], resources: [], status: "queued", source: "manual", createdAt: timestamp, updatedAt: timestamp }];
    state.agentRuns = [];
    state.composites = [];
  });
  f.restart = async (mode = {}) => {
    await f.server?.close();
    const oldStore = f.store;
    f.server = await createBurnerServer({ root, host: "127.0.0.1", port: 0, manual: true, ...mode });
    f.store = f.server.store;
    assert.notEqual(f.store, oldStore, "restart reconstructs the real server and durable StateStore");
    f.git = f.server.orchestrator.git;
  };
  f.run = () => f.store.get().agentRuns.find((run) => run.ideaId === "idea");
  f.persistedRun = async () => JSON.parse(await readFile(join(root, ".burner", "state.json"), "utf8")).agentRuns.find((run) => run.ideaId === "idea");
  await f.restart(options.origin === "portfolio" ? portfolio : {});
  return f;
}

async function withFixture(t, options, action) {
  const f = await fixture(t, options);
  await action(f);
  assert.deepEqual(f.calls.blocked, [], "no subprocess escaped an effect fake, even if production caught its error");
  f.retain = false;
}

async function deliver(f) {
  const run = await f.server.orchestrator.runNextIdea();
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.continuation.step, "done");
  assert.equal(run.continuation.evaluation.purpose, "delivery");
  assert.ok(run.continuation.evaluation.result.completedAt);
  assert.ok(run.continuation.evaluation.evaluations.every((entry) => entry.mode !== "screening-command"));
  assert.equal(run.continuation.evaluation.evaluations.find((entry) => entry.evaluationId === "command").mode, "full-command");
  assert.equal(latestFullAssessment(run), undefined, "completed nonscreened delivery is not a separate full assessment");
  assert.equal(f.calls.merges.length, 0);
  return run;
}

async function qualify(f, expected = true) {
  f.phase = "full";
  assert.equal(await f.server.orchestrator.fullyValidateLeafForMerge(f.run().id, f.base), expected);
  const run = f.run();
  const full = latestFullAssessment(run);
  assert.equal(full.qualified, expected);
  assert.equal(full.evaluation.purpose, "full");
  assert.ok(full.evaluation.result.completedAt);
  assert.deepEqual(fullAssessmentForIdentity(run, full.evaluation.identity), full);
  assert.equal(run.fullEvaluation, undefined, "publication consumes the active cursor");
  assert.equal(Object.hasOwn(run, "fullMergeValidation"), false, "new history must not write a mutable latest alias");
  const entry = run.fullEvaluationHistory.find((entry) => entry.kind === "assessment");
  assert.deepEqual(entry.assessment, full);
  assert.equal(entry.comparison.tree, full.candidateTree);
  assert.deepEqual(entry.comparison.progress, []);
  assert.deepEqual((await f.persistedRun()).fullEvaluationHistory, run.fullEvaluationHistory);
  return full;
}

async function manualMergeReachesBoundary(f) {
  const samples = structuredClone(f.calls.samples);
  const history = structuredClone(f.run().fullEvaluationHistory);
  assert.equal(f.world.pr.isDraft, true);
  await assert.rejects(f.server.orchestrator.mergeAgent(f.run().id), { message: mergeStop });
  assert.equal(f.world.pr.isDraft, false, "public merge acknowledged its owned readiness effect");
  assert.equal(f.run().leafPr.known.fields.isDraft, false);
  assert.deepEqual(f.calls.samples, samples, "manual merge never launches samples");
  assert.deepEqual(f.run().fullEvaluationHistory, history);
  assert.equal(f.calls.merges.length, 1);
  assert.equal(f.run().continuation.step, "done");
  assert.equal(f.run().generatedProgress.outputCommit, f.calls.merges[0]);
  await f.git.verifyGeneratedProgress(f.run().generatedProgress);
}

async function waitForDispatchedLeaf(f) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (f.run()?.completedAt && (await f.server.orchestrator.runtimeStatus(true)).runningAgents === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`The public dispatch did not settle: ${JSON.stringify(f.store.get().activity.slice(0, 5))}`);
}

test("known ordinary admission retains delivery-only manual merge and ordinary one/three prompt sampling after default-server restart", async (t) => {
  for (const promptScore of [50, 52]) await t.test(`prompt ${promptScore === 50 ? "unchanged" : "changed"}`, async (t) => withFixture(t, { promptScore }, async (f) => {
    const delivered = await deliver(f);
    assert.equal(delivered.leafQualificationPolicy, "ordinary");
    assert.equal((await f.persistedRun()).leafQualificationPolicy, "ordinary");
    assert.equal(f.calls.samples.filter((sample) => sample.evaluationId === "command").length, 1);
    assert.equal(f.calls.samples.filter((sample) => sample.evaluationId === "prompt").length, promptScore === 50 ? 1 : 3);
    const receipt = structuredClone(delivered.continuation.evaluation);
    await f.restart();
    assert.equal(f.run().leafQualificationPolicy, "ordinary");
    await manualMergeReachesBoundary(f);
    assert.deepEqual(f.run().continuation.evaluation, receipt);
    assert.equal(latestFullAssessment(f.run()), undefined);
  }));
});

test("portfolio nonscreened delivery still needs separate full evidence after a default-server restart", async (t) => withFixture(t, { origin: "portfolio" }, async (f) => {
  const delivered = await deliver(f);
  assert.equal(delivered.leafQualificationPolicy, "separate-full");
  const receipt = structuredClone(delivered.continuation.evaluation);
  await f.restart();
  assert.equal((await f.persistedRun()).leafQualificationPolicy, "separate-full");
  const samples = structuredClone(f.calls.samples);
  const before = await f.persistedRun();
  await assert.rejects(f.server.orchestrator.mergeAgent(f.run().id), /exact authoritative nonscreened receipt|full qualification/i);
  assert.deepEqual(f.calls.samples, samples);
  assert.deepEqual(await f.persistedRun(), before, "a refused manual merge neither changes evidence nor manufactures authority");
  assert.equal(f.calls.merges.length, 0);
  const full = await qualify(f);
  assert.notEqual(full.evaluation.id, receipt.id);
  assert.deepEqual(f.run().continuation.evaluation, receipt);
  assert.equal(f.run().leafQualificationPolicy, "separate-full");
  assert.equal(f.calls.samples.filter((sample) => sample.phase === "full" && sample.evaluationId === "command").length, 0, "exact full-command reuse remains supported");
  assert.equal(f.calls.samples.filter((sample) => sample.phase === "full" && sample.evaluationId === "prompt").length, 3);
  await f.restart();
  await manualMergeReachesBoundary(f);
}));

test("public scheduler marks cadence-fallback admission and default restart cannot waive its separate full gate", async (t) => withFixture(t, { origin: "portfolio" }, async (f) => {
  const timestamp = new Date().toISOString();
  await f.store.update((state) => state.agentRuns.push({ id: "yielded", ideaId: "yielded-idea", branch: "burner/yielded", worktree: "",
    status: "failed", startedAt: timestamp, completedAt: timestamp, baseRef: "main", baseCommit: f.base, resources: [], reviewRounds: [], deltas: [],
    quarantinedAt: timestamp, quarantineReason: "Review yielded to preserve the merge reserve." }));
  f.pauseOnAuthor = true;
  await f.server.orchestrator.setEnabled(true);
  await waitForDispatchedLeaf(f);
  assert.equal(f.run()?.status, "completed", JSON.stringify(f.store.get().activity.slice(0, 5)));
  assert.equal(f.run().cadenceFallback, true);
  assert.equal(f.run().leafQualificationPolicy, "separate-full");
  assert.equal(f.run().continuation.evaluation.evaluations.find((entry) => entry.evaluationId === "command").mode, "full-command");
  assert.equal(f.store.get().orchestrator.enabled, false);
  await f.restart();
  const samples = structuredClone(f.calls.samples);
  await assert.rejects(f.server.orchestrator.mergeAgent(f.run().id), /exact authoritative nonscreened receipt|full qualification/i);
  assert.deepEqual(f.calls.samples, samples);
  assert.equal(f.calls.merges.length, 0);
  await qualify(f);
  assert.equal(f.run().cadenceFallback, true);
  assert.equal(f.run().leafQualificationPolicy, "separate-full");
  await manualMergeReachesBoundary(f);
}));

test("automatic single-leaf server restart requires full evidence for portfolio and unknown leaves, not known ordinary", async (t) => {
  for (const origin of ["ordinary", "portfolio", "unknown"]) await t.test(origin, async (t) => withFixture(t, { origin }, async (f) => {
    await deliver(f);
    if (origin === "unknown") await f.store.update((state) => { delete state.agentRuns.find((run) => run.ideaId === "idea").leafQualificationPolicy; });
    const deliveredSamples = f.calls.samples.length;
    assert.equal(f.world.pr.isDraft, true);
    f.phase = "automatic-full";
    await f.restart(singleLeafAutopilot);
    await f.server.orchestrator.runCycle();
    assert.equal(f.calls.merges.length, 1, JSON.stringify(f.store.get().activity.slice(0, 5)));
    assert.equal(f.calls.samples.length - deliveredSamples, origin === "ordinary" ? 0 : 3);
    assert.equal(f.run().leafQualificationPolicy, origin === "unknown" ? undefined : origin === "portfolio" ? "separate-full" : "ordinary");
    if (origin !== "ordinary") {
      assert.equal(latestFullAssessment(f.run()).qualified, true);
      assert.ok(f.calls.order.indexOf("sample:automatic-full:prompt") < f.calls.order.indexOf("merge"));
    } else assert.equal(latestFullAssessment(f.run()), undefined);
    assert.ok(f.store.get().activity.some((activity) => activity.message === "YOLO approved PR #42 for merge"));
  }));
});

test("unknown legacy nonscreened delivery is not inferred ordinary; explicit full evidence authorizes merge without inventing origin", async (t) => withFixture(t, {}, async (f) => {
  await deliver(f);
  await f.store.update((state) => { delete state.agentRuns.find((run) => run.ideaId === "idea").leafQualificationPolicy; });
  await f.restart();
  const before = await f.persistedRun();
  const samples = structuredClone(f.calls.samples);
  await assert.rejects(f.server.orchestrator.mergeAgent(f.run().id), /legacy leaf qualification policy is unknown.*full qualification/i);
  assert.deepEqual(await f.persistedRun(), before);
  assert.deepEqual(f.calls.samples, samples);
  assert.equal(f.calls.merges.length, 0);
  const rounds = structuredClone(f.run().reviewRounds);
  await qualify(f);
  assert.equal(Object.hasOwn(f.run(), "leafQualificationPolicy"), false, "a full experiment proves qualification, not portfolio review origin");
  assert.deepEqual(f.run().reviewRounds, rounds, "full qualification neither spends nor resets review rounds");
  await f.restart();
  await manualMergeReachesBoundary(f);
  assert.equal(Object.hasOwn(await f.persistedRun(), "leafQualificationPolicy"), false);
}));

test("a retained negative full assessment independently blocks the known ordinary delivery-only route", async (t) => withFixture(t, {}, async (f) => {
  const delivered = await deliver(f);
  const positiveDelivery = structuredClone(delivered.continuation.evaluation);
  f.scores.prompt = 40;
  const rejected = structuredClone(await qualify(f, false));
  assert.equal(f.run().leafQualificationPolicy, "ordinary", "explicit full qualification does not relabel known ordinary origin");
  assert.deepEqual(f.run().continuation.evaluation, positiveDelivery);
  await f.restart();
  const samples = structuredClone(f.calls.samples);
  await assert.rejects(f.server.orchestrator.mergeAgent(f.run().id), /retained negative full assessment/i);
  assert.deepEqual(latestFullAssessment(f.run()), rejected);
  assert.deepEqual(f.calls.samples, samples);
  assert.equal(f.calls.merges.length, 0);
}));

test("known portfolio review headroom survives default-server restart, while ordinary cannot borrow a portfolio budget", async (t) => {
  await t.test("portfolio retains third round", async (t) => withFixture(t, { origin: "portfolio" }, async (f) => {
    f.approveAtRound = 3;
    f.interruptRevision = 2;
    const failed = await f.server.orchestrator.runNextIdea();
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /Fixture revision interruption/);
    assert.equal(failed.reviewRounds.length, 2);
    const rounds = structuredClone(failed.reviewRounds);
    await f.restart();
    f.interruptRevision = undefined;
    const resumed = await f.server.orchestrator.retryAgent(f.run().id);
    assert.equal(resumed.status, "completed", resumed.error);
    assert.equal(resumed.reviewRounds.length, 3);
    assert.equal(resumed.leafQualificationPolicy, "separate-full");
    assert.deepEqual(resumed.reviewRounds.slice(0, 1), rounds.slice(0, 1));
    assert.equal(resumed.reviewRounds[1].id, rounds[1].id, "retry answers the retained second round, not a reset history");
    assert.equal(resumed.reviewRounds[2].approved, true);
    assert.equal(f.calls.models.filter((method) => method === "implement").length, 1);
  }));
  await t.test("ordinary retains two-round ceiling", async (t) => withFixture(t, {}, async (f) => {
    f.approveAtRound = 3;
    const failed = await f.server.orchestrator.runNextIdea();
    assert.equal(failed.status, "failed");
    assert.equal(failed.reviewRounds.length, 2);
    assert.match(failed.error, /2 total rounds|review budget/i);
    const rounds = structuredClone(failed.reviewRounds);
    assert.equal(failed.leafPr.known.fields.state, "CLOSED", "exhaustion reached checked terminal closure");
    assert.equal(failed.prState, "closed");
    assert.equal(canRetryAgent(failed), false, "terminal ownership, not process mode, refuses another author admission");
    const history = structuredClone(failed.fullEvaluationHistory);
    const rows = structuredClone(f.store.get().evaluationRuns);
    const samples = structuredClone(f.calls.samples);
    await f.restart(portfolio);
    const models = structuredClone(f.calls.models);
    await assert.rejects(f.server.orchestrator.retryAgent(f.run().id));
    assert.deepEqual(f.calls.models, models);
    assert.deepEqual(f.calls.samples, samples);
    assert.deepEqual(f.run().reviewRounds, rounds);
    assert.deepEqual(f.run().fullEvaluationHistory, history);
    assert.deepEqual(f.store.get().evaluationRuns, rows);
    assert.equal(f.run().leafPr.known.fields.state, "CLOSED");
    assert.equal(canRetryAgent(f.run()), false);
    assert.equal(f.run().leafQualificationPolicy, "ordinary");
  }));
});

test("unknown delivery retry preserves absent origin rather than adopting the default process", async (t) => withFixture(t, { origin: "portfolio" }, async (f) => {
  f.failDeliverySamples = true;
  const failed = await f.server.orchestrator.runNextIdea();
  assert.equal(failed.status, "failed");
  assert.equal(failed.continuation.step, "delivery");
  const receiptId = failed.continuation.evaluation.id;
  const rounds = structuredClone(failed.reviewRounds);
  await f.store.update((state) => { delete state.agentRuns.find((run) => run.ideaId === "idea").leafQualificationPolicy; });
  await f.restart();
  f.failDeliverySamples = false;
  const models = structuredClone(f.calls.models);
  const resumed = await f.server.orchestrator.retryAgent(f.run().id);
  assert.equal(resumed.status, "completed", resumed.error);
  assert.equal(resumed.continuation.evaluation.id, receiptId);
  assert.deepEqual(resumed.reviewRounds, rounds);
  assert.deepEqual(f.calls.models, models, "delivery retry does not repeat author or reviewer work");
  assert.equal(Object.hasOwn(await f.persistedRun(), "leafQualificationPolicy"), false);
  const samples = structuredClone(f.calls.samples);
  await assert.rejects(f.server.orchestrator.mergeAgent(f.run().id), /legacy leaf qualification policy is unknown/i);
  assert.deepEqual(f.calls.samples, samples);
}));

test("unknown origin keeps its conservative cumulative review ceiling after explicit negative full qualification", async (t) => withFixture(t, {}, async (f) => {
  await deliver(f);
  await f.store.update((state) => { delete state.agentRuns.find((run) => run.ideaId === "idea").leafQualificationPolicy; });
  f.scores.prompt = 40;
  const full = structuredClone(await qualify(f, false));
  assert.equal(Object.hasOwn(f.run(), "leafQualificationPolicy"), false);
  const approval = structuredClone(f.run().reviewRounds[0]);
  await f.restart(portfolio);
  f.approveAtRound = 3;
  const resumed = await f.server.orchestrator.retryAgent(f.run().id);
  assert.equal(resumed.status, "failed");
  assert.equal(resumed.reviewRounds.length, 2, "unknown origin does not acquire the current process's four-round budget");
  assert.match(resumed.error, /2 total rounds|review budget/i);
  assert.deepEqual(resumed.reviewRounds[0], approval);
  assert.equal(Object.hasOwn(resumed, "leafQualificationPolicy"), false);
  assert.deepEqual(latestFullAssessment(resumed), full);
  assert.equal(f.calls.models.filter((method) => method === "review").length, 2);
  assert.equal(f.calls.merges.length, 0);
}));
