import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { EventHub } from "../dist/lib/events.js";
import { GitService } from "../dist/lib/git.js";
import { Orchestrator } from "../dist/lib/orchestrator.js";
import { runCommand } from "../dist/lib/process.js";
import { StateStore } from "../dist/lib/store.js";
import { fixtureLeafRepository, installLeafPrFixtureTransport } from "./leaf-pr-test-helpers.js";

const timestamp = "2026-09-01T00:00:00.000Z";
const clone = (value) => structuredClone(value);

async function fixture(t, { conflict = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "burner-public-leaf-source-"));
  const calls = { blocked: [], models: [], samples: [], merges: [], fetches: [], leafEffects: [], compositeEffects: [] };
  let passed = false;
  const spawn = childProcess.spawn;
  const gitPath = process.env.PATH.split(delimiter).map((part) => join(part, "git")).find((path) => {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  });
  assert.ok(gitPath);
  const executable = realpathSync(gitPath);
  const local = (cwd) => {
    const absolute = resolve(cwd);
    assert.ok(absolute === root || absolute.startsWith(`${root}${sep}`), `outside isolated source fixture: ${absolute}`);
    let existing = absolute;
    while (true) {
      try { lstatSync(existing); break; }
      catch (error) { if (error.code !== "ENOENT" || existing === root) throw error; existing = dirname(existing); }
    }
    assert.equal(realpathSync(existing), existing);
  };
  childProcess.spawn = (command, args, options) => {
    try {
      local(options.cwd);
      assert.equal(command, "git", "this fixture never executes a model, GitHub client, or shell");
      assert.ok(!args.includes("--global") && !args.includes("--system"));
      const env = { PATH: `${dirname(executable)}${delimiter}/usr/bin${delimiter}/bin`, LANG: "C",
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" };
      if (options.env?.GIT_INDEX_FILE) { local(dirname(options.env.GIT_INDEX_FILE)); env.GIT_INDEX_FILE = options.env.GIT_INDEX_FILE; }
      if (options.env?.GIT_NO_REPLACE_OBJECTS) env.GIT_NO_REPLACE_OBJECTS = options.env.GIT_NO_REPLACE_OBJECTS;
      if (options.env?.GIT_GRAFT_FILE) { assert.equal(options.env.GIT_GRAFT_FILE, "/dev/null"); env.GIT_GRAFT_FILE = "/dev/null"; }
      return spawn(executable, args, { ...options, env });
    } catch (error) { calls.blocked.push({ command, args, error: error.message }); throw error; }
  };
  syncBuiltinESMExports();
  const command = async (cwd, ...args) => {
    const result = await runCommand("git", args, { cwd });
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const store = new StateStore(root);
  await store.init();
  const git = new GitService(root, join(root, ".burner"));
  const orchestrator = new Orchestrator(root, store, new EventHub());
  orchestrator.git = git;
  t.after(async () => {
    assert.equal(orchestrator.activeAgents.size, 0);
    assert.equal(orchestrator.activeComposites.size, 0);
    assert.equal(orchestrator.agentClaims.size, 0);
    childProcess.spawn = spawn;
    syncBuiltinESMExports();
    if (passed) await rm(root, { recursive: true, force: true });
    else {
      await writeFile(join(root, ".burner", "fixture-effects.json"), JSON.stringify(calls, null, 2));
      t.diagnostic(`Failed source fixture retained: ${root}`);
    }
  });
  await command(root, "init", "-b", "main");
  await command(root, "config", "user.name", "Fixture");
  await command(root, "config", "user.email", "fixture@localhost");
  await command(root, "config", "gc.auto", "0");
  await writeFile(join(root, ".gitignore"), ".burner/\n");
  await writeFile(join(root, "README.md"), "# Isolated source integration\n");
  await writeFile(join(root, "shared.txt"), "Base shared implementation\n");
  const base = await git.commit(root, "fixture base");
  const remote = join(root, ".burner", "fixture-remote.git");
  await command(root, "init", "--bare", remote);
  await command(root, "remote", "add", "origin", remote);
  await git.push(root, "origin", "main");
  await store.update((state) => {
    Object.assign(state.settings, { autoRun: false, autoCreatePrs: true, parallelism: 1,
      maxReviewRounds: 4, portfolioReviewRounds: 4, preferLivingComposite: true });
    state.orchestrator.enabled = false;
    state.evaluations = [{ id: "quality", name: "Quality", prompt: "Fixture rubric", weight: 1, enabled: true,
      definitionVersion: "v1", createdAt: timestamp }];
    state.evaluationRuns = [{ id: "baseline", evaluationId: "quality", score: 70, promptSampleCount: 3,
      evaluationDefinitionVersion: "v1", commit: base, context: "baseline", status: "completed", durationMs: 1, createdAt: timestamp }];
  });
  const prs = new Map();
  let nextPr = 42;
  const observe = async (_cwd, number) => {
    const pr = prs.get(number);
    assert.ok(pr?.leaf, "typed leaf API must address a known fixture leaf");
    return { ...clone(pr), headRefOid: await git.remoteBranchHead(root, "origin", pr.headRefName),
      baseRefName: "main", baseRefOid: await git.remoteBranchHead(root, "origin", "main"),
      statusCheckRollup: [{ state: "SUCCESS" }], mergeable: "MERGEABLE" };
  };
  installLeafPrFixtureTransport(git, {
    observe, base: async () => base,
    search: async (_cwd, _repository, branch) => Promise.all([...prs.values()].filter((pr) => pr.leaf && pr.headRefName === branch).map((pr) => observe(root, pr.number))),
    create: async (input) => {
      const run = store.get().agentRuns.find((item) => item.branch === input.branch);
      assert.equal(run.leafPr.pending.effect.kind, "create");
      const number = nextPr++;
      const pr = { number, url: `https://example.test/pr/${number}`, headRefName: input.branch,
        title: input.title, body: input.body, isDraft: input.isDraft, state: "OPEN", leaf: true };
      prs.set(number, pr); calls.leafEffects.push({ kind: "create", number });
      return { number, url: pr.url };
    },
    edit: async (_cwd, number, field, value) => { assert.ok(prs.get(number)?.leaf); prs.get(number)[field] = value; calls.leafEffects.push({ kind: field, number }); },
    draft: async (_cwd, number, value) => { assert.ok(prs.get(number)?.leaf); prs.get(number).isDraft = value; calls.leafEffects.push({ kind: "draft", number }); },
    close: async (_cwd, number) => { assert.ok(prs.get(number)?.leaf); prs.get(number).state = "CLOSED"; calls.leafEffects.push({ kind: "close", number }); },
  });
  const compositePr = (number) => { const pr = prs.get(number); assert.ok(pr && !pr.leaf, "generic PR writers may only address the composite"); return pr; };
  git.openPr = async (input) => {
    const number = nextPr++;
    const pr = { number, url: `https://example.test/pr/${number}`, headRefName: input.branch,
      title: input.title, body: input.body, isDraft: input.draft, state: "OPEN", leaf: false };
    prs.set(number, pr); calls.compositeEffects.push({ kind: "create", number });
    return { number, url: pr.url };
  };
  git.editPr = async (_cwd, number, title, body) => { Object.assign(compositePr(number), { title, body }); calls.compositeEffects.push({ kind: "edit", number }); };
  git.markPrDraft = async (_cwd, number) => { compositePr(number).isDraft = true; };
  git.closePr = async (_cwd, number) => { compositePr(number).state = "CLOSED"; calls.compositeEffects.push({ kind: "close", number }); };
  for (const method of ["reopenPr", "mergePr", "markPrReady", "listPullRequests"]) git[method] = async () => assert.fail(`Unexpected generic ${method}`);
  const merge = git.mergeBranch.bind(git);
  git.mergeBranch = async (cwd, oid) => { assert.match(oid, /^[a-f0-9]{40}$/); calls.merges.push(oid); return merge(cwd, oid); };
  const fetch = git.fetchLeafSource.bind(git);
  git.fetchLeafSource = async (input) => {
    const run = store.get().agentRuns.find((item) => item.branch === input.branch);
    assert.ok(run && orchestrator.agentClaims.has(run.id), "source claim must cover the real immutable fetch");
    calls.fetches.push(clone(input)); return fetch(input);
  };
  const controls = { score: 71, afterIntegration: undefined };
  const session = { threadId: "fixture-session", message: "Fixture implementation/evidence" };
  orchestrator.codex = {
    preflight: async (cwd) => local(cwd),
    implement: async (cwd, idea) => { local(cwd); calls.models.push("author"); await writeFile(join(cwd, conflict ? "shared.txt" : `${idea.id}.txt`), `${idea.title}\n`); return session; },
    revise: async () => assert.fail("No extra author revision is expected in this source-consumption fixture"),
    refreshAgentEvidence: async (cwd) => { local(cwd); calls.models.push("leaf-evidence"); return session; },
    refreshCompositeEvidence: async (cwd) => { local(cwd); calls.models.push("composite-evidence"); return session; },
    review: async (cwd) => { local(cwd); calls.models.push("review"); return { approved: true, summary: "Independent fixture approval", findings: [] }; },
    evaluate: async (cwd, evaluation, _settings, context, baseline) => {
      local(cwd); assert.equal(evaluation.id, "quality"); assert.ok(baseline);
      calls.samples.push({ cwd, context, baseline: clone(baseline) });
      return { score: controls.score, summary: `Fixture score ${controls.score}`, evidence: [], suggestions: [] };
    },
    integrateComposite: async (cwd, _title, _sources, _settings, context) => {
      local(cwd); calls.models.push(context.phase === "resolve-conflicts" ? "resolve-conflicts" : "integrate");
      if (context.phase === "resolve-conflicts") await writeFile(join(cwd, "shared.txt"), "Combined first and second capabilities\n");
      else await controls.afterIntegration?.();
      return session;
    },
  };
  const waitIdle = async () => {
    const until = Date.now() + 60_000;
    while (orchestrator.activeComposites.size || orchestrator.activeAgents.size) {
      if (Date.now() > until) throw new Error("Isolated composite operation did not reach a terminal fixture state");
      await new Promise((done) => setTimeout(done, 10));
    }
  };
  const addLeaf = async (id, parent) => {
    await store.update((state) => state.ideas.push({ id, title: `Capability ${id}`, description: `Implement ${id}`, rationale: "Isolated fixture", predictedImpact: 1,
      evaluationIds: ["quality"], resources: [], status: "queued", source: "manual", createdAt: timestamp, updatedAt: timestamp,
      ...(parent ? { baseCompositeId: parent } : {}) }));
    const run = await orchestrator.runNextIdea();
    assert.equal(run.continuation.step, "done", run.error);
    assert.equal(run.continuation.evaluation.purpose, "delivery");
    assert.equal(run.continuation.evaluation.agentRunId, run.id);
    assert.ok(run.continuation.evaluation.result.completedAt);
    assert.equal(run.reviewRounds.at(-1).commit, run.continuation.head);
    await waitIdle();
    return store.get().agentRuns.find((item) => item.id === run.id);
  };
  const first = await addLeaf("first");
  const second = await addLeaf("second");
  const create = async () => {
    const composite = await orchestrator.createComposite([first.id, second.id], "Exact source composite", "Keep both capabilities", { makeLiving: true });
    await waitIdle();
    return store.get().composites.find((item) => item.id === composite.id);
  };
  return { root, remote, base, store, git, orchestrator, calls, prs, controls, first, second, addLeaf, create, command,
    pass: () => { assert.deepEqual(calls.blocked, []); passed = true; } };
}

test("public composite creation merges exact receipt heads through real conflict resolution", async (t) => {
  const f = await fixture(t, { conflict: true });
  const before = [clone(f.first), clone(f.second)];
  const composite = await f.create();
  assert.equal(composite.status, "open", composite.error);
  assert.deepEqual(f.calls.merges, before.map((run) => run.continuation.head));
  assert.equal(f.calls.models.filter((name) => name === "resolve-conflicts").length, 1);
  const head = await f.git.resolveRef(composite.branch);
  for (const run of before) {
    assert.equal(await f.git.isCommitAncestor(run.continuation.head, head), true);
    assert.deepEqual(f.store.get().agentRuns.find((item) => item.id === run.id), run);
  }
  assert.equal(await f.command(f.root, "show", `${head}:shared.txt`), "Combined first and second capabilities");
  assert.equal(f.calls.samples.length, 9, "two leaf receipts and the composite use the existing three-sample policy");
  assert.equal(f.calls.leafEffects.filter((item) => item.kind !== "create").length, 0);
  f.pass();
});

test("public composite consumption refuses changed remote source, PR content, and retained evidence", async (t) => {
  for (const drift of ["remote-head", "content", "evidence", "integration-content"]) await t.test(drift, async (t) => {
    const f = await fixture(t);
    if (drift === "remote-head") {
      const foreign = await f.command(f.root, "commit-tree", await f.git.tree(f.first.continuation.head), "-p", f.first.continuation.head, "-m", "foreign descendant");
      await f.command(f.root, "push", `--force-with-lease=refs/heads/${f.first.branch}:${f.first.continuation.head}`,
        "origin", `${foreign}:refs/heads/${f.first.branch}`);
    } else if (drift === "content") f.prs.get(f.first.prNumber).body += "\nExternal content must survive";
    else if (drift === "evidence") await f.store.update((state) => {
      const id = f.first.continuation.evaluation.result.selections[0].candidate;
      state.evaluationRuns.find((row) => row.id === id).score += 1;
    });
    else f.controls.afterIntegration = async () => { f.prs.get(f.first.prNumber).title = "External integration-time title"; };
    const before = clone(f.store.get().agentRuns);
    const leafEffects = clone(f.calls.leafEffects);
    const samples = f.calls.samples.length;
    const composite = await f.create();
    assert.equal(composite.status, "failed");
    assert.match(composite.error, /identity|tuple|evidence|changed/i);
    assert.deepEqual(f.store.get().agentRuns, before);
    assert.deepEqual(f.calls.leafEffects, leafEffects);
    assert.equal(f.calls.samples.length, samples);
    assert.equal(f.calls.merges.length, drift === "integration-content" ? 2 : 0);
    assert.equal(f.store.get().orchestrator.enabled, false);
    f.pass();
  });
});

test("public living-line absorption retains the exact transfer receipt for real incremental consumption", async (t) => {
  const f = await fixture(t);
  const composite = await f.create();
  assert.equal(composite.status, "open", composite.error);
  const priorHead = await f.git.resolveRef(composite.branch);
  const beforeMerges = f.calls.merges.length;
  f.controls.score = 72;
  const experiment = await f.addLeaf("experiment", composite.id);
  assert.equal(experiment.status, "absorbed", experiment.error);
  assert.equal(experiment.baseCommit, priorHead);
  assert.equal(experiment.continuation.outcome, "absorbed");
  assert.equal(experiment.continuation.evaluation.identity.baseCommit, priorHead);
  assert.equal(experiment.prNumber, undefined, "never-published experiments do not open a throwaway PR");
  assert.deepEqual(experiment.leafPr.repository, fixtureLeafRepository);
  const rebuilt = f.store.get().composites.find((item) => item.id === composite.id);
  assert.equal(rebuilt.status, "open", rebuilt.error);
  assert.equal(rebuilt.sources.find((source) => source.agentRunId === experiment.id).absorbedAt, experiment.absorbedAt);
  assert.deepEqual(rebuilt.pendingExperimentRunIds, []);
  assert.deepEqual(f.calls.merges.slice(beforeMerges), [experiment.continuation.head]);
  assert.equal(await f.git.isCommitAncestor(experiment.continuation.head, await f.git.resolveRef(composite.branch)), true);
  assert.equal(f.calls.models.filter((name) => name === "author").length, 3);
  assert.equal(f.store.get().orchestrator.enabled, false);
  f.pass();
});
