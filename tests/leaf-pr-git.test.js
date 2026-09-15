import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import * as gitModule from "../dist/lib/git.js";
import { runCommand } from "../dist/lib/process.js";

const { GitService } = gitModule;
const repository = { host: "github.example.test", id: "R_fixture", nameWithOwner: "fixture/project" };
const branch = "burner/owned-leaf";
const repositoryUrl = `https://${repository.host}/${repository.nameWithOwner}`;
const apiRepository = (identity = repository) => ({ id: identity.id, nameWithOwner: identity.nameWithOwner, url: `https://${identity.host}/${identity.nameWithOwner}` });

async function gitCommand(cwd, ...args) {
  const result = await runCommand("git", args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function fakeProcess(action) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let input = "";
  child.stdin = new Writable({
    write(chunk, _encoding, callback) { input += chunk.toString(); callback(); },
    final(callback) {
      callback();
      Promise.resolve().then(() => action(input)).then((result) => {
        child.stdout.end(result.stdout ?? "");
        child.stderr.end(result.stderr ?? "");
        child.emit("close", result.exitCode ?? 0, null);
      }, (error) => child.emit("error", error));
    },
  });
  child.kill = () => undefined;
  return child;
}

function rawPr(f, patch = {}) {
  return { number: 42, url: `${repositoryUrl}/pull/42`, headRefName: branch, headRefOid: f.base,
    baseRefName: "main", baseRefOid: f.base, state: "OPEN", title: "Owned title", body: "Owned body\n", isDraft: true,
    headRepository: apiRepository(), baseRepository: apiRepository(), mergeCommit: null, mergeable: "MERGEABLE",
    commits: { nodes: [{ commit: { oid: f.base, statusCheckRollup: null } }] }, ...patch };
}

function page(nodes, { totalCount = nodes.length, hasNextPage = false, prefix = "page" } = {}) {
  const edges = nodes.map((node, index) => ({ cursor: `${prefix}-${index}`, node }));
  return { totalCount, edges, pageInfo: { hasNextPage, endCursor: edges.at(-1)?.cursor ?? null } };
}

async function fixture(t, action) {
  const root = await mkdtemp(join(tmpdir(), "burner-leaf-pr-git-"));
  const f = { root, seed: join(root, "seed"), checkout: join(root, "checkout"), remote: join(root, "remote.git"),
    ghCalls: [], gitCalls: [], apiRepository: apiRepository(), retain: false };
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) => {
    assert.ok(options.cwd === root || options.cwd.startsWith(`${root}/`), "subprocesses stay in the isolated fixture");
    if (command === "gh") return fakeProcess(async (input) => {
      f.ghCalls.push({ args: [...args], input });
      if (f.gh) return f.gh(args, input);
      assert.equal(args[0], "api");
      assert.equal(args[1], "graphql");
      assert.equal(args[args.indexOf("--hostname") + 1], repository.host);
      const request = JSON.parse(input);
      let data;
      if (request.operationName === "LeafRepository") data = { repository: f.apiRepository };
      else if (request.operationName === "LeafPullRequest") data = { node: { ...f.apiRepository, pullRequest: f.pr } };
      else if (request.operationName === "LeafPullRequests") {
        f.cursors ??= [];
        f.cursors.push(request.variables.after);
        assert.ok(f.pages?.length, "every cursor page must be explicitly supplied by the fixture");
        data = { node: { ...f.apiRepository, pullRequests: f.pages.shift() } };
      } else assert.fail(`Unexpected fake GraphQL operation ${request.operationName}`);
      return { stdout: JSON.stringify({ data }) };
    });
    assert.equal(command, "git", "no model, GitHub executable, or unrelated process may fall through");
    f.gitCalls.push([...args]);
    const networkOperation = ["fetch", "ls-remote", "push", "clone"].find((operation) => args.includes(operation));
    let isolated = args;
    if (networkOperation) {
      assert.ok(args.includes("origin") || args.includes(f.remote), "all Git transports are mapped to this fixture's bare remote");
      isolated = args.map((arg) => arg === "origin" ? f.remote : arg);
    }
    f.beforeGit?.(args);
    const child = spawn(command, isolated, options);
    child.once("close", () => f.afterGit?.(args));
    return child;
  };
  syncBuiltinESMExports();
  t.after(async () => {
    childProcess.spawn = spawn;
    syncBuiltinESMExports();
    if (f.retain) t.diagnostic(`Retained failed isolated fixture: ${root}`);
    else await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  try {
    await mkdir(f.seed);
    await gitCommand(f.seed, "init", "-b", "main");
    await gitCommand(f.seed, "config", "user.name", "Fixture");
    await gitCommand(f.seed, "config", "user.email", "fixture@example.test");
    await writeFile(join(f.seed, "code.txt"), "source base\n");
    const seedGit = new GitService(f.seed, join(f.seed, ".burner"));
    f.base = await seedGit.commit(f.seed, "source base");
    await gitCommand(f.seed, "init", "--bare", f.remote);
    await gitCommand(f.seed, "push", f.remote, "main");
    await gitCommand(root, "clone", "--no-hardlinks", "--branch", "main", f.remote, f.checkout);
    await gitCommand(f.checkout, "remote", "set-url", "origin", `${repositoryUrl}.git`);
    f.git = new GitService(f.checkout, join(f.checkout, ".burner"), { intervalMs: 0, mergeAttempts: 2, checkAttempts: 3, noCheckGraceAttempts: 2 });
    f.seedGit = seedGit;
    f.pr = rawPr(f);
    f.ghCalls.length = 0;
    f.gitCalls.length = 0;
    await action(f);
  } catch (error) { f.retain = true; throw error; }
}

async function landedGraph(f, { composite = false } = {}) {
  await gitCommand(f.seed, "switch", "-c", branch);
  await writeFile(join(f.seed, "code.txt"), "leaf implementation\n");
  const head = await f.seedGit.commit(f.seed, "leaf implementation");
  await gitCommand(f.seed, "push", f.remote, `${head}:refs/heads/${branch}`);
  await gitCommand(f.seed, "switch", "main");
  await writeFile(join(f.seed, "upstream.txt"), "upstream advancement\n");
  await f.seedGit.commit(f.seed, "upstream advancement");
  let included = head;
  if (composite) {
    await gitCommand(f.seed, "switch", "-c", "composite-source");
    await gitCommand(f.seed, "merge", "--no-ff", "-m", "integrate leaf in composite", head);
    await writeFile(join(f.seed, "composite.txt"), "another source\n");
    included = await f.seedGit.commit(f.seed, "complete composite");
    await gitCommand(f.seed, "switch", "main");
  }
  await gitCommand(f.seed, "merge", "--no-ff", "-m", "land in main", included);
  const landing = await f.seedGit.head();
  await writeFile(join(f.seed, "code.txt"), "legitimate later base edit\n");
  const target = await f.seedGit.commit(f.seed, "later target advancement");
  await gitCommand(f.seed, "push", f.remote, "main");
  return { head, landing, target };
}

test("leaf repository identity binds expanded fetch and push URLs to the explicit GitHub host and node", async (t) => fixture(t, async (f) => {
  await gitCommand(f.checkout, "remote", "set-url", "--push", "origin", `git@${repository.host}:${repository.nameWithOwner}.git`);
  assert.deepEqual(await f.git.leafRepository(f.checkout, "origin"), repository);
  assert.equal(f.ghCalls.length, 1);
  const before = f.ghCalls.length;
  await gitCommand(f.checkout, "remote", "set-url", "--push", "origin", `https://${repository.host}/foreign/project.git`);
  await assert.rejects(f.git.leafRepository(f.checkout, "origin"), /fetch.*push|remote.*identity/i);
  assert.equal(f.ghCalls.length, before, "URL disagreement is refused before an API query");
}));

test("leaf repository identity rejects non-GitHub URLs, ambiguous remotes and incomplete API identities", async (t) => fixture(t, async (f) => {
  for (const remote of [f.remote, "file:///tmp/foreign.git", `${repositoryUrl}/extra.git`, `${repositoryUrl}.git?redirect=foreign`]) {
    await gitCommand(f.checkout, "remote", "set-url", "origin", remote);
    await assert.rejects(f.git.leafRepository(f.checkout, "origin"), /remote|repository|GitHub/i);
  }
  await gitCommand(f.checkout, "remote", "set-url", "origin", `${repositoryUrl}.git`);
  await gitCommand(f.checkout, "config", "--add", "remote.origin.url", `https://${repository.host}/foreign/project.git`);
  await assert.rejects(f.git.leafRepository(f.checkout, "origin"), /fetch.*push|remote.*identity/i);
  await gitCommand(f.checkout, "config", "--unset-all", "remote.origin.url");
  await gitCommand(f.checkout, "config", "remote.origin.url", `${repositoryUrl}.git`);
  for (const patch of [{ id: undefined }, { nameWithOwner: "foreign/project" }, { url: "https://foreign.example.test/fixture/project" }]) {
    f.apiRepository = { ...apiRepository(), ...patch };
    await assert.rejects(f.git.leafRepository(f.checkout, "origin"), /repository|identity|host/i);
  }
}));

test("leaf GraphQL refuses malformed and partial-error responses rather than defaulting missing observation fields", async (t) => fixture(t, async (f) => {
  for (const response of ["not JSON", "null", "{}", JSON.stringify({ data: null }),
    JSON.stringify({ data: { node: { ...apiRepository(), pullRequest: f.pr } }, errors: [{ message: "partial response" }] })]) {
    f.gh = async () => ({ stdout: response });
    await assert.rejects(f.git.observeLeafPr(f.checkout, repository, 42), /GraphQL|observation|GitHub|data/i);
  }
  f.gh = async () => ({ exitCode: 1, stderr: "fixture transport unavailable" });
  const before = f.ghCalls.length;
  await assert.rejects(f.git.observeLeafPr(f.checkout, repository, 42), /fixture transport unavailable/);
  assert.equal(f.ghCalls.length - before, 1, "the leaf owner decides whether another observation is appropriate");
}));

test("leaf PR observations require exact repository/ref/OID/content/check fields and associated merged landing", async (t) => fixture(t, async (f) => {
  const observed = await f.git.observeLeafPr(f.checkout, repository, 42);
  assert.deepEqual(observed, { repository, headRepository: repository, baseRepository: repository, number: 42,
    url: `${repositoryUrl}/pull/42`, headRefName: branch, headRefOid: f.base, baseRefName: "main", baseRefOid: f.base,
    state: "OPEN", title: "Owned title", body: "Owned body\n", isDraft: true, mergeable: "MERGEABLE", statusCheckRollup: [] });
  for (const missing of ["number", "url", "headRefName", "headRefOid", "baseRefName", "baseRefOid", "headRepository", "baseRepository", "state", "title", "body", "isDraft", "mergeable", "mergeCommit", "commits"]) {
    f.pr = rawPr(f);
    delete f.pr[missing];
    await assert.rejects(f.git.observeLeafPr(f.checkout, repository, 42), /observation|repository|identity|head|field|check|PR/i, missing);
  }
  for (const patch of [{ number: 41 }, { headRefOid: "main" }, { baseRefOid: "" }, { headRefName: "invalid ref" },
    { body: null }, { isDraft: "false" }, { mergeable: "MAYBE" }, { state: ["OPEN"] }, { mergeable: ["MERGEABLE"] }, { state: "MERGED", mergeCommit: null }]) {
    f.pr = rawPr(f, patch);
    await assert.rejects(f.git.observeLeafPr(f.checkout, repository, 42), /observation|identity|commit|head|field|PR|ref/i);
  }
  for (const url of [`${repositoryUrl}/pull/43`, `${repositoryUrl}/pull/42?redirect=foreign`, "https://foreign.example.test/fixture/project/pull/42"]) {
    f.pr = rawPr(f, { url });
    await assert.rejects(f.git.observeLeafPr(f.checkout, repository, 42), /URL|identity/i);
  }
  f.pr = rawPr(f, { state: "MERGED", mergeCommit: { oid: f.base } });
  assert.equal((await f.git.observeLeafPr(f.checkout, repository, 42)).mergeCommit, f.base);
  f.apiRepository = { ...apiRepository(), id: "R_foreign" };
  await assert.rejects(f.git.observeLeafPr(f.checkout, repository, 42), /repository.*identity|identity.*repository/i);
}));

test("leaf PR branch observations reject checkout expressions instead of interpreting local reflogs", async (t) => fixture(t, async (f) => {
  await gitCommand(f.checkout, "switch", "-c", "previous-branch");
  await gitCommand(f.checkout, "switch", "main");
  assert.equal(await gitCommand(f.checkout, "check-ref-format", "--branch", "@{-1}"), "previous-branch",
    "the normal Git branch parser would silently expand this invalid literal");
  f.pr = rawPr(f, { headRefName: "@{-1}" });
  await assert.rejects(f.git.observeLeafPr(f.checkout, repository, 42), /ref|branch/i);
  f.pages = [page([])];
  const before = f.ghCalls.length;
  await assert.rejects(f.git.findLeafPrs(f.checkout, repository, "@{-1}"), /ref|branch/i);
  f.gh = async () => ({ stdout: `${repositoryUrl}/pull/42\n` });
  await assert.rejects(f.git.createLeafPr({ cwd: f.checkout, repository, baseBranch: "main", branch: "@{-1}",
    title: "Title", body: "Body", isDraft: true }), /ref|branch/i);
  assert.equal(f.ghCalls.length, before, "invalid requested refs cannot reach discovery or mutation transport");
}));

test("leaf check observations preserve failure/pending facts and refuse missing or truncated checks", async (t) => fixture(t, async (f) => {
  const checks = [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "FAILURE" },
    { __typename: "StatusContext", context: "external", state: "PENDING" }];
  const commit = f.pr.commits.nodes[0].commit;
  commit.statusCheckRollup = { contexts: { nodes: checks, totalCount: 2, pageInfo: { hasNextPage: false } } };
  assert.deepEqual((await f.git.observeLeafPr(f.checkout, repository, 42)).statusCheckRollup, checks);
  for (const mutation of [
    () => { delete commit.statusCheckRollup; },
    () => { commit.statusCheckRollup = { contexts: { nodes: checks, totalCount: 3, pageInfo: { hasNextPage: true } } }; },
    () => { commit.statusCheckRollup = { contexts: { nodes: [{ __typename: "CheckRun", name: "unknown" }], totalCount: 1, pageInfo: { hasNextPage: false } } }; },
    () => { commit.oid = "f".repeat(40); },
  ]) {
    mutation();
    await assert.rejects(f.git.observeLeafPr(f.checkout, repository, 42), /check|head|observation|commit/i);
  }
  commit.oid = f.base;
  for (const invalid of [{ __typename: "CheckRun", name: "ci", status: "MAYBE", conclusion: null },
    { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "MAYBE" },
    { __typename: "StatusContext", context: "external", state: "MAYBE" }, { __typename: "UnknownCheck" }]) {
    commit.statusCheckRollup = { contexts: { nodes: [invalid], totalCount: 1, pageInfo: { hasNextPage: false } } };
    await assert.rejects(f.git.observeLeafPr(f.checkout, repository, 42), /check|observation/i);
  }
  commit.statusCheckRollup = { contexts: { nodes: [{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS", conclusion: null }],
    totalCount: 1, pageInfo: { hasNextPage: false } } };
  assert.deepEqual((await f.git.observeLeafPr(f.checkout, repository, 42)).statusCheckRollup,
    [{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS" }]);
}));

test("leaf branch discovery exhausts all-state cursor pages without granting ownership", async (t) => fixture(t, async (f) => {
  const closed = rawPr(f, { number: 43, url: `${repositoryUrl}/pull/43`, state: "CLOSED" });
  f.pages = [page([f.pr], { totalCount: 2, hasNextPage: true, prefix: "first" }), page([closed], { totalCount: 2, prefix: "last" })];
  const found = await f.git.findLeafPrs(f.checkout, repository, branch);
  assert.deepEqual(found.map((pr) => [pr.number, pr.state]), [[42, "OPEN"], [43, "CLOSED"]]);
  assert.deepEqual(f.cursors, [null, "first-0"]);
  for (const call of f.ghCalls) assert.match(JSON.parse(call.input).query, /OPEN[\s,]+CLOSED[\s,]+MERGED/);
  assert.equal(f.gitCalls.some((args) => args.includes("push")), false);
  f.pages = [page([])];
  assert.deepEqual(await f.git.findLeafPrs(f.checkout, repository, branch), []);
}));

test("leaf branch discovery refuses duplicates, moving counts, repeated cursors, missing pages and truncation", async (t) => fixture(t, async (f) => {
  for (const invalid of ["duplicate", "count", "cursor", "empty", "truncated", "missing-page-info", "foreign-branch"]) {
    const next = rawPr(f, { number: 43, url: `${repositoryUrl}/pull/43` });
    const first = page([f.pr], { totalCount: 2, hasNextPage: true, prefix: "first" });
    const last = page([next], { totalCount: 2, prefix: "last" });
    if (invalid === "duplicate") last.edges[0].node = structuredClone(f.pr);
    if (invalid === "count") last.totalCount = 3;
    if (invalid === "cursor") { last.edges[0].cursor = "first-0"; last.pageInfo.endCursor = "first-0"; }
    if (invalid === "empty") last.edges = [];
    if (invalid === "truncated") first.pageInfo.hasNextPage = false;
    if (invalid === "missing-page-info") delete first.pageInfo;
    if (invalid === "foreign-branch") last.edges[0].node.headRefName = "foreign/branch";
    f.pages = [first, last];
    await assert.rejects(f.git.findLeafPrs(f.checkout, repository, branch), /page|cursor|duplicate|branch|complete|count|truncat/i, invalid);
  }
}));

test("leaf mutations issue one field/effect request with explicit repository and never reopen, poll or label", async (t) => fixture(t, async (f) => {
  f.gh = async () => ({ stdout: `${repositoryUrl}/pull/42\n` });
  const scope = [f.checkout, repository, 42];
  const operations = [
    () => f.git.createLeafPr({ cwd: f.checkout, repository, baseBranch: "main", branch, title: "Title", body: "Body", isDraft: true }),
    () => f.git.editLeafPrField(...scope, "title", "Title changed"),
    () => f.git.editLeafPrField(...scope, "body", ""),
    () => f.git.setLeafPrDraft(...scope, true),
    () => f.git.setLeafPrDraft(...scope, false),
    () => f.git.closeLeafPr(...scope),
    () => f.git.mergeLeafPr(...scope, f.base),
  ];
  for (const [index, operation] of operations.entries()) {
    f.ghCalls.length = 0;
    const result = await operation();
    if (index === 0) assert.deepEqual(result, { url: `${repositoryUrl}/pull/42`, number: 42 });
    assert.equal(f.ghCalls.length, 1);
    const args = f.ghCalls[0].args;
    assert.equal(args[args.indexOf("--repo") + 1], `${repository.host}/${repository.nameWithOwner}`);
    assert.ok(!args.some((arg) => ["reopen", "view", "list", "label", "--comment", "--auto"].includes(arg)));
    if (args[1] === "edit") assert.equal(Number(args.includes("--title")) + Number(args.includes("--body")), 1);
    if (args[1] === "merge") assert.deepEqual(args.slice(3, 6), ["--merge", "--match-head-commit", f.base]);
  }
  assert.deepEqual(f.git.leafMergePolling(), { mergeAttempts: 2, checkAttempts: 3, noCheckGraceAttempts: 2, intervalMs: 0 });
  assert.deepEqual(new GitService(f.checkout, join(f.checkout, ".burner")).leafMergePolling(),
    { mergeAttempts: 24, checkAttempts: 360, noCheckGraceAttempts: 4, intervalMs: 2500 });
}));

test("leaf mutation targets reject invalid repository, number, content and head inputs before transport", async (t) => fixture(t, async (f) => {
  f.gh = async () => ({ stdout: `${repositoryUrl}/pull/42\n` });
  const invalid = [
    () => f.git.closeLeafPr(f.checkout, { ...repository, id: "" }, 42),
    () => f.git.closeLeafPr(f.checkout, { ...repository, host: `${repository.host}/other` }, 42),
    () => f.git.closeLeafPr(f.checkout, { ...repository, nameWithOwner: "fixture/.." }, 42),
    () => f.git.closeLeafPr(f.checkout, repository, 0),
    () => f.git.closeLeafPr(f.checkout, repository, 1.5),
    () => f.git.editLeafPrField(f.checkout, repository, 42, "labels", "foreign"),
    () => f.git.editLeafPrField(f.checkout, repository, 42, "title", ""),
    () => f.git.editLeafPrField(f.checkout, repository, 42, "body", null),
    () => f.git.setLeafPrDraft(f.checkout, repository, 42, "false"),
    () => f.git.mergeLeafPr(f.checkout, repository, 42, "main"),
    () => f.git.createLeafPr({ cwd: f.checkout, repository, baseBranch: "main", branch, title: "Title", body: "Body" }),
  ];
  for (const operation of invalid) await assert.rejects(operation);
  assert.equal(f.ghCalls.length, 0, "malformed targets have no external effects");
}));

test("leaf transport errors including already-merged close do not trigger retries or terminal shortcuts", async (t) => fixture(t, async (f) => {
  for (const message of ["already merged", "connection reset", "not mergeable"]) {
    f.gh = async () => ({ exitCode: 1, stderr: message });
    f.ghCalls.length = 0;
    await assert.rejects(f.git.closeLeafPr(f.checkout, repository, 42), new RegExp(message));
    assert.equal(f.ghCalls.length, 1);
    f.ghCalls.length = 0;
    await assert.rejects(f.git.mergeLeafPr(f.checkout, repository, 42, f.base), new RegExp(message));
    assert.equal(f.ghCalls.length, 1);
  }
}));

test("leaf inclusion fetches immutable graph objects from fresh remote main without updating checkout or requiring whole-tree equality", async (t) => fixture(t, async (f) => {
  const graph = await landedGraph(f);
  assert.notEqual((await runCommand("git", ["cat-file", "-e", `${graph.head}^{commit}`], { cwd: f.checkout })).exitCode, 0,
    "head is not present in the consumer clone before immutable acquisition");
  await writeFile(join(f.checkout, "untracked.txt"), "preserve unknown local work\n");
  await writeFile(join(f.checkout, ".git/FETCH_HEAD"), "retained prior fetch receipt\n");
  const before = await gitCommand(f.checkout, "show-ref");
  assert.deepEqual(await f.git.proveLeafInclusion({ remote: "origin", repository, baseBranch: "main", sourceBase: f.base, ...graph }), { targetCommit: graph.target });
  assert.equal(await f.git.head(), f.base);
  assert.equal(await gitCommand(f.checkout, "show-ref"), before);
  assert.equal(await readFile(join(f.checkout, ".git/FETCH_HEAD"), "utf8"), "retained prior fetch receipt\n");
  assert.equal(await readFile(join(f.checkout, "untracked.txt"), "utf8"), "preserve unknown local work\n");
  assert.notEqual(await f.git.tree(graph.head), await f.git.tree(graph.target));
  const fetch = f.gitCalls.find((args) => args.includes("fetch"));
  assert.ok(fetch.includes("--no-write-fetch-head"));
  assert.ok(!fetch.some((arg) => arg.includes("refs/heads/") || arg.includes("refs/remotes/")));
}));

test("leaf inclusion accepts composite ancestry without making the source a direct landing parent", async (t) => fixture(t, async (f) => {
  const graph = await landedGraph(f, { composite: true });
  const parents = await gitCommand(f.seed, "rev-list", "--parents", "-n", "1", graph.landing);
  assert.ok(!parents.split(" ").slice(1).includes(graph.head));
  assert.deepEqual(await f.git.proveLeafInclusion({ remote: "origin", repository, baseBranch: "main", sourceBase: f.base,
    head: graph.head, landing: graph.landing }), { targetCommit: graph.target });
  assert.deepEqual(await f.git.proveLeafInclusion({ remote: "origin", repository, baseBranch: "main", sourceBase: f.base, head: graph.head }), { targetCommit: graph.target });
}));

test("leaf inclusion refuses missing, rewritten, foreign-lineage and wrongly associated landing facts", async (t) => {
  for (const invalid of ["missing-target", "missing-object", "wrong-landing", "unlanded-descendant", "source-base", "rewritten-target", "rewritten-lineage", "wrong-repository", "symbolic-head"]) await t.test(invalid, async (t) => fixture(t, async (f) => {
    const graph = await landedGraph(f);
    const input = { remote: "origin", repository, baseBranch: "main", sourceBase: f.base, head: graph.head, landing: graph.landing };
    if (invalid === "missing-target") await gitCommand(f.seed, "--git-dir", f.remote, "update-ref", "-d", "refs/heads/main");
    if (invalid === "missing-object") input.landing = "f".repeat(40);
    if (invalid === "wrong-landing") input.landing = f.base;
    if (invalid === "unlanded-descendant") {
      await gitCommand(f.seed, "switch", "-c", "unlanded", graph.head);
      await writeFile(join(f.seed, "unlanded.txt"), "not part of main\n");
      input.landing = await f.seedGit.commit(f.seed, "unlanded descendant");
      await gitCommand(f.seed, "push", f.remote, `${input.landing}:refs/heads/unlanded`);
    }
    if (invalid === "source-base") input.sourceBase = graph.target;
    if (invalid === "rewritten-target") await gitCommand(f.seed, "--git-dir", f.remote, "update-ref", "refs/heads/main", f.base);
    if (invalid === "rewritten-lineage") {
      const rewritten = await gitCommand(f.seed, "commit-tree", await f.seedGit.tree(graph.target), "-m", "same-tree unrelated root");
      await gitCommand(f.seed, "push", "--force", f.remote, `${rewritten}:refs/heads/main`);
    }
    if (invalid === "wrong-repository") input.repository = { ...repository, id: "R_foreign" };
    if (invalid === "symbolic-head") input.head = "main";
    await assert.rejects(f.git.proveLeafInclusion(input), /remote|target|commit|ancestor|inclusion|repository|lineage|fetch/i);
    assert.equal(await f.git.head(), f.base);
  }));
});

test("leaf graph acquisition refuses a moved remote or interrupted fetch instead of adopting a newer target", async (t) => {
  for (const cut of ["fetch", "moved-target", "changed-repository"]) await t.test(cut, async (t) => fixture(t, async (f) => {
    const graph = await landedGraph(f);
    if (cut === "fetch") f.beforeGit = (args) => { if (args.includes("fetch")) throw new Error("Injected immutable fetch failure"); };
    else f.afterGit = (args) => {
      if (!args.includes("fetch")) return;
      f.afterGit = undefined;
      if (cut === "changed-repository") f.apiRepository = { ...apiRepository(), id: "R_foreign" };
      else childProcess.execFileSync("git", ["--git-dir", f.remote, "update-ref", "refs/heads/main", graph.landing]);
    };
    await assert.rejects(f.git.proveLeafInclusion({ remote: "origin", repository, baseBranch: "main", sourceBase: f.base,
      head: graph.head, landing: graph.landing }), /fetch|changed|moved|repository|identity/i);
    assert.equal(await f.git.head(), f.base);
  }));
});

test("leaf source acquisition pins the actual remote source before and after immutable fetching", async (t) => fixture(t, async (f) => {
  const graph = await landedGraph(f);
  assert.notEqual((await runCommand("git", ["cat-file", "-e", `${graph.head}^{commit}`], { cwd: f.checkout })).exitCode, 0);
  await f.git.fetchLeafSource({ remote: "origin", repository, branch, head: graph.head });
  assert.equal((await runCommand("git", ["cat-file", "-e", `${graph.head}^{commit}`], { cwd: f.checkout })).exitCode, 0);
  assert.equal(await f.git.hasRef(branch), false, "source acquisition does not create a mutable source branch");
  assert.equal(await f.git.head(), f.base);
  await assert.rejects(f.git.fetchLeafSource({ remote: "origin", repository, branch: "missing-source", head: graph.head }), /source|head/i);
  await assert.rejects(f.git.fetchLeafSource({ remote: "origin", repository, branch, head: graph.target }), /source|head/i);
  f.afterGit = (args) => {
    if (!args.includes("fetch")) return;
    f.afterGit = undefined;
    childProcess.execFileSync("git", ["--git-dir", f.remote, "update-ref", `refs/heads/${branch}`, f.base]);
  };
  await assert.rejects(f.git.fetchLeafSource({ remote: "origin", repository, branch, head: graph.head }), /source|changed|head/i);
}));

test("leaf inclusion ignores local replacement and graft ancestry without removing that foreign metadata", async (t) => {
  for (const kind of ["replacement", "graft"]) await t.test(kind, async (t) => fixture(t, async (f) => {
    const graph = await landedGraph(f);
    await f.git.proveLeafInclusion({ remote: "origin", repository, baseBranch: "main", sourceBase: f.base, head: graph.head, landing: graph.landing });
    await gitCommand(f.seed, "switch", "-c", "foreign-source", f.base);
    await writeFile(join(f.seed, "foreign.txt"), "not incorporated into the remote target\n");
    const foreign = await f.seedGit.commit(f.seed, "foreign source");
    await gitCommand(f.seed, "push", f.remote, `${foreign}:refs/heads/foreign-source`);
    await f.git.fetchLeafSource({ remote: "origin", repository, branch: "foreign-source", head: foreign });
    if (kind === "replacement") {
      await gitCommand(f.checkout, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "replace", "--graft", graph.target, graph.landing, foreign);
    } else await writeFile(join(f.checkout, ".git/info/grafts"), `${graph.target} ${graph.landing} ${foreign}\n`);
    assert.equal((await runCommand("git", ["merge-base", "--is-ancestor", foreign, graph.target], { cwd: f.checkout })).exitCode, 0,
      "the unprotected local graph falsely reports this source included");
    const refs = await gitCommand(f.checkout, "show-ref");
    await assert.rejects(f.git.proveLeafInclusion({ remote: "origin", repository, baseBranch: "main", sourceBase: f.base,
      head: foreign, landing: graph.target }), /ancestry|inclusion/i);
    assert.equal(await gitCommand(f.checkout, "show-ref"), refs);
    if (kind === "graft") assert.equal(await readFile(join(f.checkout, ".git/info/grafts"), "utf8"), `${graph.target} ${graph.landing} ${foreign}\n`);
  }));
});

test("leaf PR renderer fingerprint is stable and identifies the existing renderer bytes", () => {
  assert.match(gitModule.leafPrRendererFingerprint(), /^[a-f0-9]{64}$/);
  assert.equal(gitModule.leafPrRendererFingerprint(), gitModule.leafPrRendererFingerprint());
});
