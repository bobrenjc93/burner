import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import test from "node:test";
import { GitService } from "../dist/lib/git.js";
import { runCommand } from "../dist/lib/process.js";

const branch = "burner/publication";
const fullBranch = `refs/heads/${branch}`;
const redirected = "refs/heads/burner/other";
const remoteName = "fixture";

async function gitCommand(cwd, ...args) {
  const result = await runCommand("git", args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function refs(cwd, ...prefixes) {
  const output = await gitCommand(cwd, "for-each-ref", "--format=%(refname) %(objectname)", ...prefixes);
  return Object.fromEntries(output.split("\n").filter(Boolean).map((line) => line.split(" ")));
}

async function fixture(t, action) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "burner-generic-push-")));
  const checkout = join(root, "checkout"), remote = join(root, "remote.git"), template = join(root, "empty-template");
  const spawn = childProcess.spawn;
  let passed = false;
  t.after(async () => {
    childProcess.spawn = spawn;
    syncBuiltinESMExports();
    if (passed) await rm(root, { recursive: true, force: true });
    else t.diagnostic(`Failed isolated Git push fixture retained: ${root}`);
  });
  const gitPath = process.env.PATH.split(delimiter).map((part) => join(part, "git")).find((path) => {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  });
  assert.ok(gitPath, "a real Git executable is required");
  const executable = realpathSync(gitPath);
  await mkdir(template);
  // Preserve the real process/transport behavior, but admit only private Git
  // children with no inherited config, hooks, trace paths, or network protocol.
  childProcess.spawn = (command, args, options) => {
    assert.equal(command, "git", "no shell, GitHub client, model, or unrelated subprocess is allowed");
    const cwd = realpathSync(options.cwd);
    assert.ok(cwd === root || cwd.startsWith(`${root}${sep}`), "Git stays inside this fixture");
    assert.ok(!args.includes("--global") && !args.includes("--system"));
    if (args[0] === "push") assert.ok(args.includes(remoteName), "only the private named remote is used");
    return spawn(executable, args, { ...options, env: {
      PATH: `${dirname(executable)}${delimiter}/usr/bin${delimiter}/bin`, LANG: "C", LC_ALL: "C", TMPDIR: root,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TEMPLATE_DIR: template,
      GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0",
    } });
  };
  syncBuiltinESMExports();
  await gitCommand(root, "init", "-b", "main", checkout);
  await gitCommand(root, "init", "--bare", "-b", "main", remote);
  const local = (...args) => gitCommand(checkout, ...args);
  await local("config", "user.name", "Fixture");
  await local("config", "user.email", "fixture@localhost");
  await local("commit", "--allow-empty", "-m", "base");
  const base = await local("rev-parse", "HEAD");
  const commit = (parent, message) => local("commit-tree", `${base}^{tree}`, "-p", parent, "-m", message);
  const candidate = await commit(base, "candidate branch");
  const current = await commit(base, "different current checkout");
  await local("update-ref", fullBranch, candidate);
  await local("update-ref", "refs/heads/main", current);
  await local("remote", "add", remoteName, remote);
  // Seed independently of the helper under test, with exact private refspecs.
  await local("push", remoteName, "refs/heads/main:refs/heads/main", `${base}:${redirected}`);
  const git = new GitService(checkout, join(root, "unused-data"));
  await action({ checkout, remote, local, git, commit, base, candidate, current });
  passed = true;
}

async function setOtherUpstream(f) {
  await f.local("config", `branch.${branch}.remote`, remoteName);
  await f.local("config", `branch.${branch}.merge`, redirected);
}

async function assertOwnUpstream(f) {
  assert.equal(await f.local("config", "--get", `branch.${branch}.remote`), remoteName);
  assert.equal(await f.local("config", "--get", `branch.${branch}.merge`), fullBranch);
  assert.equal(await f.local("for-each-ref", "--format=%(upstream)", fullBranch), `refs/remotes/${remoteName}/${branch}`);
}

test("generic Git push publishes the exact heads ref despite source ambiguity and configured remapping", { concurrency: false }, async (t) => {
  const cases = [
    { name: "short input, different checkout and same-named tag", input: branch, tag: true },
    { name: "qualified input, different checkout and same-named tag", input: fullBranch, tag: true },
    { name: "upstream remapping", input: branch, upstream: true },
    { name: "remote.push remapping", input: fullBranch, mapping: `${fullBranch}:${redirected}` },
    { name: "forced remote.push remapping", input: branch, mapping: `+${fullBranch}:${redirected}` },
  ];
  for (const scenario of cases) await t.test(scenario.name, async (t) => fixture(t, async (f) => {
    if (scenario.tag) await f.local("tag", branch, f.base);
    if (scenario.upstream) {
      await f.local("config", "push.default", "upstream");
      await setOtherUpstream(f);
    }
    if (scenario.mapping) await f.local("config", `remote.${remoteName}.push`, scenario.mapping);
    const expected = await refs(f.remote);
    for (const phase of ["first publication", "fast-forward"]) {
      const head = phase === "first publication" ? f.candidate : await f.commit(f.candidate, "fast-forward candidate");
      await f.local("update-ref", fullBranch, head);
      const localRefs = await refs(f.checkout, "refs/heads", "refs/tags");
      await f.git.push(f.checkout, remoteName, scenario.input);
      expected[fullBranch] = head;
      assert.deepEqual(await refs(f.remote), expected, `${phase} changes only the same-named remote branch`);
      assert.deepEqual(await refs(f.checkout, "refs/heads", "refs/tags"), localRefs, "local branches and tags stay intact");
      assert.equal(await f.local("symbolic-ref", "HEAD"), "refs/heads/main");
      await assertOwnUpstream(f);
    }
    // -u must establish the correct upstream even when no commit is sent.
    await setOtherUpstream(f);
    await f.git.push(f.checkout, remoteName, scenario.input);
    assert.deepEqual(await refs(f.remote), expected, "an up-to-date push changes no remote ref");
    await assertOwnUpstream(f);
  }));
});

test("generic Git push rejects divergent updates without inheriting configured force or changing refs/tracking", { concurrency: false }, async (t) => {
  const cases = [
    { name: "ordinary untracked branch", input: branch },
    { name: "forced same-name mapping", input: fullBranch, mapping: `+${fullBranch}:${fullBranch}` },
    { name: "forced other-name mapping and existing upstream", input: branch, mapping: `+${fullBranch}:${redirected}`, upstream: true },
  ];
  for (const scenario of cases) await t.test(scenario.name, async (t) => fixture(t, async (f) => {
    // The bare remote already owns this sibling of the local candidate.
    await gitCommand(f.remote, "update-ref", fullBranch, f.current);
    if (scenario.mapping) await f.local("config", `remote.${remoteName}.push`, scenario.mapping);
    if (scenario.upstream) await setOtherUpstream(f);
    const remoteRefs = await refs(f.remote), localRefs = await refs(f.checkout);
    const config = await f.local("config", "--local", "--list");
    await assert.rejects(f.git.push(f.checkout, remoteName, scenario.input), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /non-fast-forward|fetch first/, "the actual Git rejection must propagate");
      return true;
    });
    assert.deepEqual(await refs(f.remote), remoteRefs, "neither the named branch nor a configured alternate may move");
    assert.deepEqual(await refs(f.checkout), localRefs);
    assert.equal(await f.local("config", "--local", "--list"), config, "rejection neither creates nor replaces upstream tracking");
    assert.equal(await f.local("symbolic-ref", "HEAD"), "refs/heads/main");
  }));
});
