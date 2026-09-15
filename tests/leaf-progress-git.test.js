import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { GitService } from "../dist/lib/git.js";
import { runCommand } from "../dist/lib/process.js";
import { planProgressArtifacts, planProgressRestore, progressReadmeBlock, replaceProgressReadmeBlock, updateProgressArtifacts } from "../dist/lib/progress.js";

const branch = "burner/progress-receipt";
const historyPath = "docs/burner-evaluation-history.json";
const graphPath = "docs/burner-evaluation-progress.svg";
const block = (body) => `<!-- burner-progress:start -->\n${body}\n<!-- burner-progress:end -->`;
const gitIdentity = ["-c", "user.name=Test", "-c", "user.email=test@localhost"];

async function gitCommand(cwd, ...args) {
  const result = await runCommand("git", args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function put(cwd, path, contents, mode = "100644") {
  if (contents === null) { await rm(join(cwd, path), { force: true }); return; }
  await mkdir(dirname(join(cwd, path)), { recursive: true });
  await writeFile(join(cwd, path), contents);
  await chmod(join(cwd, path), mode === "100755" ? 0o755 : 0o644);
}

async function repository(t, { managed = true, readme = `# Demo  \n\n${block("old progress")}\n\nAuthored footer.  \n`, executable = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "burner-leaf-progress-git-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  await gitCommand(root, "init", "-b", "main");
  await gitCommand(root, "config", "maintenance.auto", "false");
  await gitCommand(root, "config", "gc.auto", "0");
  await put(root, ".gitignore", ".burner/\ntarget/\n");
  await put(root, "code.txt", "base\n");
  if (readme !== null) await put(root, "README.md", readme, executable ? "100755" : "100644");
  if (managed) {
    await put(root, historyPath, '{"old":true}\n');
    await put(root, graphPath, "<svg>old</svg>\n");
  }
  const git = new GitService(root, join(root, ".burner"));
  const base = await git.commit(root, "base");
  const worktree = await git.createWorktree("leaf", branch, "main");
  return { root, git, base, worktree };
}

async function traceGit(t, root) {
  const path = join(root, ".burner", "git-trace.jsonl");
  const previous = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = path;
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previous;
  });
  return async (command) => {
    const contents = await readFile(path, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
    return contents.split("\n").filter(Boolean).map(JSON.parse).filter((event) => event.event === "start" && event.argv?.includes(command));
  };
}

async function bareRemote(f) {
  const bare = join(f.root, ".burner", "remote.git");
  await gitCommand(f.root, "init", "--bare", bare);
  await gitCommand(f.root, "remote", "add", "origin", bare);
  return bare;
}

async function managedPlan(f) {
  const readme = await readFile(join(f.worktree, "README.md"), "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
  return f.git.planLeafManagedFiles(f.worktree, branch, await f.git.head(f.worktree), {
    [historyPath]: '{"new":true}\n',
    [graphPath]: "<svg>new</svg>\n",
    "README.md": replaceProgressReadmeBlock(readme, block("new progress")),
  });
}

async function generatedStamp(f, name, { previous, legacy = false, baseCommit = f.base, cwd = f.worktree, targetBranch = branch } = {}) {
  const inputCommit = await f.git.head(cwd);
  const readme = await readFile(join(cwd, "README.md"), "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
  const plan = await f.git.planLeafManagedFiles(cwd, targetBranch, inputCommit, {
    [historyPath]: `${JSON.stringify({ stamp: name })}\n`,
    [graphPath]: `<svg>${name}</svg>\n`,
    "README.md": replaceProgressReadmeBlock(readme, block(name)),
  });
  await f.git.applyLeafManagedFiles(cwd, targetBranch, plan);
  const prepared = await f.git.prepareLeafCommit(cwd, targetBranch, inputCommit);
  const outputCommit = await f.git.finalizeLeafCommit(cwd, targetBranch, prepared, `generated ${name}`);
  return { ...(!legacy ? { baseCommit } : {}), inputCommit, inputTree: plan.inputTree, outputCommit, outputTree: plan.tree, plan,
    ...(previous ? { previous } : {}) };
}

async function snapshot(f) {
  return {
    head: await f.git.head(f.worktree),
    index: await gitCommand(f.worktree, "ls-files", "--stage", "-z"),
    status: await gitCommand(f.worktree, "status", "--porcelain=v1", "--untracked-files=all", "-z"),
  };
}

test("clean pinned merge plans are read-only and prepare/commit recovery creates exactly one two-parent merge", async (t) => {
  const f = await repository(t);
  await put(f.root, "upstream.txt", "upstream\n");
  const target = await f.git.commit(f.root, "upstream");
  await put(f.worktree, "leaf.txt", "leaf\n");
  const input = await f.git.commit(f.worktree, "leaf");
  const before = await snapshot(f);
  const effects = await traceGit(t, f.root);
  const plan = await f.git.planLeafMerge(f.worktree, branch, input, target);
  assert.equal(plan.conflict, false);
  assert.equal(plan.contained, false);
  assert.deepEqual(await snapshot(f), before);
  await f.git.prepareLeafMerge(f.worktree, branch, structuredClone(plan));
  const prepared = await snapshot(f);
  await f.git.prepareLeafMerge(f.worktree, branch, structuredClone(plan));
  assert.deepEqual(await snapshot(f), prepared);
  assert.equal((await effects("merge")).length, 1, "prepared merge is observed, not repeated");
  const receipt = { inputHead: input, tree: plan.tree, parents: [input, target] };
  const head = await f.git.finalizeLeafCommit(f.worktree, branch, receipt, "pinned base refresh");
  assert.equal(await f.git.finalizeLeafCommit(f.worktree, branch, structuredClone(receipt), "resume"), head);
  await f.git.prepareLeafMerge(f.worktree, branch, structuredClone(plan));
  assert.equal((await effects("merge")).length, 1);
  assert.equal((await effects("commit")).length, 1);
  assert.equal(await gitCommand(f.worktree, "rev-list", "--parents", "-n", "1", head), `${head} ${input} ${target}`);
  assert.equal(await f.git.tree(head), plan.tree);
  assert.equal(await f.git.hasChanges(f.worktree), false);
});

test("a genuine same-tree base merge is not collapsed to the single-parent no-op", async (t) => {
  const f = await repository(t);
  await put(f.root, "code.txt", "same implementation\n");
  const target = await f.git.commit(f.root, "upstream implementation");
  await put(f.worktree, "code.txt", "same implementation\n");
  const input = await f.git.commit(f.worktree, "independent leaf implementation");
  const plan = await f.git.planLeafMerge(f.worktree, branch, input, target);
  assert.equal(plan.tree, await f.git.tree(input));
  assert.equal(plan.contained, false);
  await f.git.prepareLeafMerge(f.worktree, branch, plan);
  const receipt = { inputHead: input, tree: plan.tree, parents: [input, target] };
  const result = await f.git.finalizeLeafCommit(f.worktree, branch, receipt, "record actual base ancestry");
  assert.notEqual(result, input);
  assert.equal(await gitCommand(f.worktree, "rev-list", "--parents", "-n", "1", result), `${result} ${input} ${target}`);
  assert.equal(await f.git.finalizeLeafCommit(f.worktree, branch, receipt, "resume"), result);
});

test("contained and fast-forward targets retain their different merge effects", async (t) => {
  const f = await repository(t);
  const effects = await traceGit(t, f.root);
  const contained = await f.git.planLeafMerge(f.worktree, branch, f.base, f.base);
  assert.equal(contained.contained, true);
  await f.git.prepareLeafMerge(f.worktree, branch, contained);
  assert.equal(await f.git.head(f.worktree), f.base);
  assert.equal((await effects("merge")).length, 0);
  await put(f.root, "upstream.txt", "new base\n");
  const target = await f.git.commit(f.root, "advance main");
  const advancing = await f.git.planLeafMerge(f.worktree, branch, f.base, target);
  await f.git.prepareLeafMerge(f.worktree, branch, advancing);
  assert.equal(await f.git.head(f.worktree), f.base, "--no-ff prevents an unreceipted fast-forward");
  const result = await f.git.finalizeLeafCommit(f.worktree, branch, { inputHead: f.base, tree: advancing.tree, parents: [f.base, target] }, "merge pinned base");
  assert.equal(await gitCommand(f.worktree, "rev-list", "--parents", "-n", "1", result), `${result} ${f.base} ${target}`);
});

test("pinned merge preserves ignored retained evidence that the incoming base starts tracking", async (t) => {
  const f = await repository(t);
  await put(f.root, "target/evidence.json", '{"upstream":true}\n');
  await gitCommand(f.root, "add", "--force", "target/evidence.json");
  const target = await f.git.commit(f.root, "upstream begins tracking evidence");
  await put(f.worktree, "target/evidence.json", '{"retained":true}\n');
  const plan = await f.git.planLeafMerge(f.worktree, branch, f.base, target);
  const before = await snapshot(f);
  await assert.rejects(f.git.prepareLeafMerge(f.worktree, branch, plan), /overwritten|untracked|left untouched/);
  assert.deepEqual(await snapshot(f), before);
  assert.equal(await readFile(join(f.worktree, "target/evidence.json"), "utf8"), '{"retained":true}\n');
});

test("merge receipt rejects changed targets, staged trees, reversed parents, and later heads without mutation", async (t) => {
  for (const mismatch of ["target", "tree", "parents", "later-head", "normal-author"]) await t.test(mismatch, async (t) => {
    const f = await repository(t);
    await put(f.root, "upstream.txt", "upstream\n");
    const target = await f.git.commit(f.root, "upstream");
    const plan = await f.git.planLeafMerge(f.worktree, branch, f.base, target);
    await f.git.prepareLeafMerge(f.worktree, branch, plan);
    const receipt = { inputHead: f.base, tree: plan.tree, parents: [f.base, target] };
    if (mismatch === "target") {
      const mergeHeadPath = await gitCommand(f.worktree, "rev-parse", "--git-path", "MERGE_HEAD");
      await writeFile(mergeHeadPath, `${f.base}\n`);
    } else if (mismatch === "tree") {
      await put(f.worktree, "foreign.txt", "preserve staged foreign edit\n");
      await gitCommand(f.worktree, "add", "foreign.txt");
    } else if (mismatch === "parents") {
      const foreign = await gitCommand(f.worktree, ...gitIdentity, "commit-tree", plan.tree, "-p", target, "-p", f.base, "-m", "reversed parents");
      await gitCommand(f.worktree, "merge", "--quit");
      await gitCommand(f.worktree, "update-ref", `refs/heads/${branch}`, foreign);
    } else if (mismatch === "later-head") {
      await f.git.finalizeLeafCommit(f.worktree, branch, receipt, "planned merge");
      await gitCommand(f.worktree, ...gitIdentity, "commit", "--allow-empty", "-m", "foreign later commit");
    }
    const before = await snapshot(f);
    if (mismatch === "normal-author") await assert.rejects(f.git.prepareLeafCommit(f.worktree, branch, f.base), /MERGE_HEAD/);
    else await assert.rejects(f.git.finalizeLeafCommit(f.worktree, branch, receipt, "must not commit"), /left untouched/);
    assert.deepEqual(await snapshot(f), before);
  });
});

test("conflict plans recognize their exact index/worktree and finalize a durable same-session resolution once", async (t) => {
  const f = await repository(t);
  await put(f.root, "code.txt", "main version\n");
  const target = await f.git.commit(f.root, "main conflict");
  await put(f.worktree, "code.txt", "leaf version\n");
  const input = await f.git.commit(f.worktree, "leaf conflict");
  const before = await snapshot(f);
  const plan = await f.git.planLeafMerge(f.worktree, branch, input, target);
  assert.equal(plan.conflict, true);
  assert.deepEqual(await snapshot(f), before);
  const effects = await traceGit(t, f.root);
  await f.git.prepareLeafMerge(f.worktree, branch, plan);
  const conflictText = await readFile(join(f.worktree, "code.txt"), "utf8");
  assert.match(conflictText, /<<<<<<< HEAD/);
  await f.git.prepareLeafMerge(f.worktree, branch, structuredClone(plan));
  await f.git.assertLeafMerge(f.worktree, branch, input, target);
  assert.equal((await effects("merge")).length, 1);
  await put(f.worktree, "code.txt", "resolved by the same author\n");
  const receipt = await f.git.prepareLeafCommit(f.worktree, branch, input, [input, target]);
  assert.deepEqual(receipt.parents, [input, target]);
  const head = await f.git.finalizeLeafCommit(f.worktree, branch, receipt, "resolved pinned base");
  assert.equal(await f.git.finalizeLeafCommit(f.worktree, branch, structuredClone(receipt), "resume returned author result"), head);
  assert.equal((await effects("commit")).length, 1);
  assert.equal(await gitCommand(f.worktree, "rev-list", "--parents", "-n", "1", head), `${head} ${input} ${target}`);
});

test("conflict verification finishes write-tree before an index-refreshing diff starts", async (t) => {
  const f = await repository(t);
  await put(f.root, "code.txt", "main conflict\n");
  const target = await f.git.commit(f.root, "main conflict");
  await put(f.worktree, "code.txt", "leaf conflict\n");
  const input = await f.git.commit(f.worktree, "leaf conflict");
  const plan = await f.git.planLeafMerge(f.worktree, branch, input, target);
  await f.git.prepareLeafMerge(f.worktree, branch, plan);
  const before = await snapshot(f);
  const spawn = childProcess.spawn;
  const events = [];
  childProcess.spawn = (command, args, options) => {
    const tracked = command === "git" && options?.env?.GIT_INDEX_FILE?.includes("burner-leaf-index-") &&
      ["write-tree", "diff"].includes(args[0]);
    if (tracked) events.push(`${args[0]} start`);
    const child = spawn(command, args, options);
    if (tracked) child.once("close", () => events.push(`${args[0]} close`));
    return child;
  };
  syncBuiltinESMExports();
  try { await f.git.assertLeafMerge(f.worktree, branch, input, target); }
  finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
  assert.deepEqual(events, ["write-tree start", "write-tree close", "diff start", "diff close"],
    "write-tree and diff both acquire the index lock and must not overlap");
  assert.deepEqual(await snapshot(f), before, "verification leaves the real conflict index and files unchanged");
});

test("foreign conflict edits are preserved, not mistaken for a returned author result", async (t) => {
  for (const mismatch of ["tracked", "untracked", "staged", "merge-head"]) await t.test(mismatch, async (t) => {
    const f = await repository(t);
    await put(f.root, "code.txt", "main\n");
    const target = await f.git.commit(f.root, "main conflict");
    await put(f.worktree, "code.txt", "leaf\n");
    const input = await f.git.commit(f.worktree, "leaf conflict");
    const plan = await f.git.planLeafMerge(f.worktree, branch, input, target);
    await f.git.prepareLeafMerge(f.worktree, branch, plan);
    if (mismatch === "merge-head") await writeFile(await gitCommand(f.worktree, "rev-parse", "--git-path", "MERGE_HEAD"), `${f.base}\n`);
    else {
      await put(f.worktree, mismatch === "untracked" ? "external.txt" : "code.txt", "foreign edit to retain\n");
      if (mismatch === "staged") await gitCommand(f.worktree, "add", "code.txt");
    }
    const before = await snapshot(f);
    await assert.rejects(f.git.assertLeafMerge(f.worktree, branch, input, target), /left untouched/);
    assert.deepEqual(await snapshot(f), before);
    if (mismatch !== "merge-head") assert.equal(await readFile(join(f.worktree, mismatch === "untracked" ? "external.txt" : "code.txt"), "utf8"), "foreign edit to retain\n");
  });
});

test("managed plans resume every partial file boundary without rewriting completed outputs or adding commits", async (t) => {
  for (let cut = 0; cut <= 3; cut++) await t.test(`after ${cut} files`, async (t) => {
    const f = await repository(t, { executable: true });
    const before = await snapshot(f);
    const plan = await managedPlan(f);
    assert.deepEqual(await snapshot(f), before, "planning does not touch index or worktree");
    const completed = new Map();
    for (const file of plan.files.slice(0, cut)) {
      await put(f.worktree, file.path, file.text, file.mode);
      completed.set(file.path, (await lstat(join(f.worktree, file.path))).ino);
    }
    const effects = await traceGit(t, f.root);
    await f.git.applyLeafManagedFiles(f.worktree, branch, JSON.parse(JSON.stringify(plan)));
    for (const file of plan.files) {
      assert.equal(await readFile(join(f.worktree, file.path), "utf8"), file.text);
      if (completed.has(file.path)) assert.equal((await lstat(join(f.worktree, file.path))).ino, completed.get(file.path), "completed outputs are not rewritten");
    }
    const inodes = await Promise.all(plan.files.map(async (file) => (await lstat(join(f.worktree, file.path))).ino));
    await f.git.applyLeafManagedFiles(f.worktree, branch, structuredClone(plan));
    assert.deepEqual(await Promise.all(plan.files.map(async (file) => (await lstat(join(f.worktree, file.path))).ino)), inodes);
    assert.equal((await effects("commit")).length, 0);
    assert.equal((await effects("add")).length, 0, "applying files leaves the commit receipt to its owner");
    const receipt = await f.git.prepareLeafCommit(f.worktree, branch, f.base);
    assert.equal(receipt.tree, plan.tree);
    const head = await f.git.finalizeLeafCommit(f.worktree, branch, receipt, "generated progress");
    assert.equal(await f.git.finalizeLeafCommit(f.worktree, branch, receipt, "resume progress commit"), head);
    assert.equal((await effects("commit")).length, 1);
    await assert.rejects(f.git.applyLeafManagedFiles(f.worktree, branch, plan), /saved input head/);
    assert.equal(await gitCommand(f.worktree, "rev-list", "--count", "HEAD"), "2");
  });
});

test("managed temporary files resume only their exact planned bytes and preserve ignored evidence", async (t) => {
  for (let cut = 0; cut < 3; cut++) await t.test(`temporary for file ${cut + 1}`, async (t) => {
    const f = await repository(t, { managed: false, readme: "# Demo \n\n" });
    const plan = await managedPlan(f);
    for (const file of plan.files.slice(0, cut)) await put(f.worktree, file.path, file.text, file.mode);
    const pending = plan.files[cut];
    await put(f.worktree, pending.temporary, pending.text, pending.mode);
    const inode = (await lstat(join(f.worktree, pending.temporary))).ino;
    await put(f.worktree, "target/evidence.json", '{"original":true}\n');
    await f.git.applyLeafManagedFiles(f.worktree, branch, plan);
    assert.equal((await lstat(join(f.worktree, pending.path))).ino, inode, "exact temporary is renamed rather than recreated");
    await assert.rejects(lstat(join(f.worktree, pending.temporary)), /ENOENT/);
    assert.equal(await readFile(join(f.worktree, "target/evidence.json"), "utf8"), '{"original":true}\n');
  });
});

test("managed restore deletions and staged partial outputs are idempotent", async (t) => {
  const f = await repository(t);
  const readme = await readFile(join(f.worktree, "README.md"), "utf8");
  const plan = await f.git.planLeafManagedFiles(f.worktree, branch, f.base, {
    [historyPath]: null, [graphPath]: null, "README.md": replaceProgressReadmeBlock(readme, undefined),
  });
  await unlink(join(f.worktree, historyPath));
  await gitCommand(f.worktree, "add", "-u", "--", historyPath);
  await f.git.applyLeafManagedFiles(f.worktree, branch, plan);
  await f.git.applyLeafManagedFiles(f.worktree, branch, plan);
  await assert.rejects(readFile(join(f.worktree, historyPath)), /ENOENT/);
  await assert.rejects(readFile(join(f.worktree, graphPath)), /ENOENT/);
  assert.equal(await readFile(join(f.worktree, "README.md"), "utf8"), replaceProgressReadmeBlock(readme, undefined));
  assert.equal((await f.git.prepareLeafCommit(f.worktree, branch, f.base)).tree, plan.tree);
});

test("managed drift is refused before any file effect and foreign files survive", async (t) => {
  for (const mismatch of ["code", "untracked", "managed", "readme", "staged", "temporary", "unowned-temporary", "mode", "symlink"]) await t.test(mismatch, async (t) => {
    const f = await repository(t);
    const plan = await managedPlan(f);
    const first = plan.files[0];
    let foreignPath;
    if (mismatch === "code") foreignPath = "code.txt";
    if (mismatch === "untracked") foreignPath = "external.txt";
    if (mismatch === "managed" || mismatch === "staged") foreignPath = graphPath;
    if (mismatch === "readme") foreignPath = "README.md";
    if (mismatch === "temporary") foreignPath = first.temporary;
    if (mismatch === "unowned-temporary") foreignPath = `${historyPath}.tmp-other-process`;
    if (foreignPath) {
      await put(f.worktree, foreignPath, "foreign data must survive\n");
      if (mismatch === "staged") {
        await gitCommand(f.worktree, "add", "--", foreignPath);
        await put(f.worktree, foreignPath, plan.files.find((file) => file.path === foreignPath).oldText);
      }
    } else if (mismatch === "mode") await chmod(join(f.worktree, graphPath), 0o755);
    else {
      await put(f.root, ".burner/external.svg", "outside file stays untouched\n");
      await unlink(join(f.worktree, graphPath));
      await symlink(join(f.root, ".burner/external.svg"), join(f.worktree, graphPath));
    }
    const before = await snapshot(f);
    const readme = await readFile(join(f.worktree, "README.md"), "utf8");
    const history = await readFile(join(f.worktree, historyPath), "utf8");
    await assert.rejects(f.git.applyLeafManagedFiles(f.worktree, branch, plan), /left untouched/);
    assert.deepEqual(await snapshot(f), before);
    assert.equal(await readFile(join(f.worktree, "README.md"), "utf8"), readme);
    assert.equal(await readFile(join(f.worktree, historyPath), "utf8"), history);
    if (foreignPath && mismatch !== "staged") assert.equal(await readFile(join(f.worktree, foreignPath), "utf8"), "foreign data must survive\n");
    if (mismatch === "symlink") assert.equal(await readFile(join(f.root, ".burner/external.svg"), "utf8"), "outside file stays untouched\n");
  });
});

test("managed plans do not authorize arbitrary paths, trees, old blobs, or README rewrites", async (t) => {
  const f = await repository(t);
  await assert.rejects(f.git.planLeafManagedFiles(f.worktree, branch, f.base, { "code.txt": "not managed\n" }), /Unexpected managed progress path/);
  const plan = await managedPlan(f);
  for (const mutate of [
    (copy) => { copy.tree = copy.inputTree; },
    (copy) => { copy.files[0].oldBlob = "0".repeat(40); },
    (copy) => { copy.files[0].temporary = "../external"; },
    (copy) => { copy.files.push(copy.files[0]); },
    (copy) => { copy.files[0].text = `foreign README header\n${copy.files[0].text}`; },
  ]) {
    const copy = structuredClone(plan);
    mutate(copy);
    const before = await snapshot(f);
    await assert.rejects(f.git.applyLeafManagedFiles(f.worktree, branch, copy), /progress|README/);
    assert.deepEqual(await snapshot(f), before);
  }
});

test("an absent README cannot be created empty under a managed-block-only plan", async (t) => {
  const f = await repository(t, { managed: false, readme: null });
  await assert.rejects(f.git.planLeafManagedFiles(f.worktree, branch, f.base, { "README.md": "" }), /authored README bytes/);
  assert.equal(await f.git.hasChanges(f.worktree), false);
  await assert.rejects(readFile(join(f.worktree, "README.md")), /ENOENT/);
});

test("leaf publication uses the saved exact lease and skips a completed remote effect", async (t) => {
  const f = await repository(t);
  await bareRemote(f);
  const effects = await traceGit(t, f.root);
  assert.equal(await f.git.remoteBranchHead(f.worktree, "origin", branch), null);
  await f.git.pushLeaf(f.worktree, "origin", branch, f.base, null);
  await f.git.pushLeaf(f.worktree, "origin", branch, f.base, null);
  assert.equal((await effects("push")).length, 1);
  await put(f.worktree, "code.txt", "approved candidate\n");
  const head = await f.git.commit(f.worktree, "candidate");
  await f.git.pushLeaf(f.worktree, "origin", branch, head, f.base);
  await f.git.pushLeaf(f.worktree, "origin", branch, head, f.base);
  const pushes = await effects("push");
  assert.equal(pushes.length, 2);
  assert.ok(pushes[1].argv.includes(`--force-with-lease=refs/heads/${branch}:${f.base}`));
  assert.ok(pushes[1].argv.includes(`${head}:refs/heads/${branch}`));
  assert.equal(await f.git.remoteBranchHead(f.worktree, "origin", branch), head);
});

test("leaf publication refuses absent, third, and non-descendant remote heads without overwriting them", async (t) => {
  for (const mismatch of ["absent", "third-ancestor", "third-descendant", "non-descendant"]) await t.test(mismatch, async (t) => {
    const f = await repository(t);
    const bare = await bareRemote(f);
    await f.git.pushLeaf(f.worktree, "origin", branch, f.base, null);
    await put(f.worktree, "code.txt", "first candidate\n");
    const previous = await f.git.commit(f.worktree, "first candidate");
    await f.git.pushLeaf(f.worktree, "origin", branch, previous, f.base);
    await put(f.worktree, "code.txt", "second candidate\n");
    const desired = await f.git.commit(f.worktree, "second candidate");
    let remote = null;
    let expected = previous;
    if (mismatch === "absent") await gitCommand(f.root, "--git-dir", bare, "update-ref", "-d", `refs/heads/${branch}`);
    else {
      if (mismatch === "third-ancestor") remote = f.base;
      else {
        remote = await gitCommand(f.worktree, ...gitIdentity, "commit-tree", await f.git.tree(desired), "-p", mismatch === "third-descendant" ? desired : f.base, "-m", "foreign commit");
        await gitCommand(f.worktree, "push", "origin", `${remote}:refs/heads/fixture-object-copy`);
      }
      if (mismatch === "non-descendant") expected = remote;
      await gitCommand(f.root, "--git-dir", bare, "update-ref", `refs/heads/${branch}`, remote);
    }
    const effects = await traceGit(t, f.root);
    await assert.rejects(f.git.pushLeaf(f.worktree, "origin", branch, desired, expected), /saved remote lease|discard published history/);
    assert.equal(await f.git.remoteBranchHead(f.worktree, "origin", branch), remote);
    assert.equal((await effects("push")).length, 0);
    assert.equal(await f.git.head(f.worktree), desired);
  });
});

test("saved lease rejects a remote race after observation instead of adopting the newer head", async (t) => {
  const f = await repository(t);
  const bare = await bareRemote(f);
  await f.git.pushLeaf(f.worktree, "origin", branch, f.base, null);
  await put(f.worktree, "code.txt", "desired\n");
  const desired = await f.git.commit(f.worktree, "desired");
  const third = await gitCommand(f.worktree, ...gitIdentity, "commit-tree", await f.git.tree(desired), "-p", f.base, "-m", "racing foreign commit");
  await gitCommand(f.worktree, "push", "origin", `${third}:refs/heads/fixture-object-copy`);
  const observe = f.git.remoteBranchHead.bind(f.git);
  let observations = 0;
  f.git.remoteBranchHead = async (...args) => {
    const observed = await observe(...args);
    if (observations++ === 0) await gitCommand(f.root, "--git-dir", bare, "update-ref", `refs/heads/${branch}`, third);
    return observed;
  };
  const effects = await traceGit(t, f.root);
  await assert.rejects(f.git.pushLeaf(f.worktree, "origin", branch, desired, f.base), /stale info|rejected|failed to push/);
  assert.equal(await observe(f.worktree, "origin", branch), third);
  assert.equal((await effects("push")).length, 1);
  assert.equal(await f.git.head(f.worktree), desired);
});

test("leaf publication never pushes a wrong local head, branch, or dirty checkout", async (t) => {
  for (const mismatch of ["head", "branch", "staged", "unstaged", "untracked"]) await t.test(mismatch, async (t) => {
    const f = await repository(t);
    await bareRemote(f);
    let desired = f.base;
    if (mismatch === "head") {
      await put(f.worktree, "code.txt", "intended implementation\n");
      desired = await f.git.commit(f.worktree, "desired");
      await gitCommand(f.worktree, ...gitIdentity, "commit", "--allow-empty", "-m", "foreign later head");
    } else if (mismatch === "branch") await gitCommand(f.worktree, "switch", "-c", "burner/foreign");
    else {
      await put(f.worktree, mismatch === "untracked" ? "foreign.txt" : "code.txt", "retain foreign edit\n");
      if (mismatch === "staged") await gitCommand(f.worktree, "add", "code.txt");
    }
    const before = await snapshot(f);
    const effects = await traceGit(t, f.root);
    await assert.rejects(f.git.pushLeaf(f.worktree, "origin", branch, desired, null), /left untouched/);
    assert.deepEqual(await snapshot(f), before);
    assert.equal((await effects("push")).length, 0);
    assert.equal((await effects("ls-remote")).length, 0, "local identity is verified before contacting the remote");
  });
});

test("progress certificates normalize only the exact inherited managed transformation", async (t) => {
  for (const readme of [`# Demo \n\n${block("old progress")}\nFooter.  \n`, "# Demo with trailing space  \n\n", null]) await t.test(readme === null ? "new README" : readme.includes("start") ? "existing block" : "appended block", async (t) => {
    const f = await repository(t, { managed: false, readme });
    const plan = await managedPlan(f);
    await f.git.applyLeafManagedFiles(f.worktree, branch, plan);
    const prepared = await f.git.prepareLeafCommit(f.worktree, branch, f.base);
    const output = await f.git.finalizeLeafCommit(f.worktree, branch, prepared, "generated stamp");
    const certificate = { inputCommit: f.base, inputTree: plan.inputTree, outputCommit: output, outputTree: plan.tree, plan };
    await f.git.verifyGeneratedProgress(certificate);
    const before = await snapshot(f);
    assert.equal(await f.git.normalizeLeafProgressTree(output, certificate), plan.inputTree);
    assert.deepEqual(await snapshot(f), before);
    await put(f.worktree, "code.txt", "authored fix\n");
    const fix = await f.git.commit(f.worktree, "authored code fix");
    assert.notEqual(await f.git.normalizeLeafProgressTree(fix, certificate), plan.inputTree, "real authored implementation differences remain visible");
    await put(f.worktree, "code.txt", "base\n");
    const reverted = await f.git.commit(f.worktree, "reverted code leaving only generated stamp");
    assert.equal(await f.git.normalizeLeafProgressTree(reverted, certificate), plan.inputTree, "a code revert cannot be disguised by its inherited stamp");
    await gitCommand(f.worktree, ...gitIdentity, "commit", "--allow-empty", "-m", "empty retry");
    assert.equal(await f.git.normalizeLeafProgressTree(await f.git.head(f.worktree), certificate), plan.inputTree);
    const stampedReadme = await readFile(join(f.worktree, "README.md"), "utf8");
    await put(f.worktree, "README.md", `Authored heading.\n\n${stampedReadme}Authored ending.\n`);
    const documented = await f.git.commit(f.worktree, "authored README work");
    const normalized = await f.git.normalizeLeafProgressTree(documented, certificate);
    assert.equal(await gitCommand(f.worktree, "show", `${normalized}:README.md`), `Authored heading.\n\n${readme ?? ""}Authored ending.`);
    await put(f.worktree, graphPath, "<svg>author altered generated bytes</svg>\n");
    const invalid = await f.git.commit(f.worktree, "foreign managed change");
    await assert.rejects(f.git.normalizeLeafProgressTree(invalid, certificate), /changed inherited certified managed/);
    await assert.rejects(f.git.normalizeLeafProgressTree(f.base, certificate), /does not descend/);
    await assert.rejects(f.git.verifyGeneratedProgress({ ...certificate, outputCommit: documented }), /output tree/);
  });
});

test("progress certificate rejects a same-tree foreign commit with wrong parents", async (t) => {
  const f = await repository(t);
  const plan = await managedPlan(f);
  const foreign = await gitCommand(f.worktree, ...gitIdentity, "commit-tree", plan.tree, "-m", "foreign root with familiar generated bytes");
  await assert.rejects(f.git.verifyGeneratedProgress({ inputCommit: f.base, inputTree: plan.inputTree, outputCommit: foreign, outputTree: plan.tree, plan }), /exact parent/);
});

test("no-op certificates keep their original commit rather than approving a fabricated empty successor", async (t) => {
  const f = await repository(t);
  const plan = await f.git.planLeafManagedFiles(f.worktree, branch, f.base, {});
  const certificate = { inputCommit: f.base, inputTree: plan.inputTree, outputCommit: f.base, outputTree: plan.tree, plan };
  await f.git.verifyGeneratedProgress(certificate);
  assert.equal(await f.git.normalizeLeafProgressTree(f.base, certificate), plan.inputTree);
  await gitCommand(f.worktree, ...gitIdentity, "commit", "--allow-empty", "-m", "not a generated effect");
  await assert.rejects(f.git.verifyGeneratedProgress({ ...certificate, outputCommit: await f.git.head(f.worktree) }), /no-op progress certificate/);
});

test("history normalization composes stamps newest first and recognizes restored A without erasing changed C or authored docs", async (t) => {
  for (const readme of [`# Original  \n\n${block("old progress")}\nFooter.  \n`, "# Original without managed block  \n\n", null]) {
    await t.test(readme === null ? "new README" : readme.includes("start") ? "existing block" : "appended block", async (t) => {
      const f = await repository(t, { readme });
      await put(f.worktree, "code.txt", "implementation A\n");
      await put(f.worktree, "docs/author-guide.md", "Original authored guide.\n");
      const candidateA = await f.git.commit(f.worktree, "candidate A");
      const treeA = await f.git.tree(candidateA);
      const first = await generatedStamp(f, "first");
      await put(f.worktree, "code.txt", "implementation B\n");
      const candidateB = await f.git.commit(f.worktree, "candidate B");
      const second = await generatedStamp(f, "second", { previous: [first] });
      await put(f.worktree, "code.txt", "implementation A\n");
      const restoredA = await f.git.commit(f.worktree, "restored A with two generated stamps");
      assert.notEqual(await f.git.normalizeLeafProgressTree(restoredA, second), treeA,
        "reversing only the newest stamp leaves older generated bytes and misses restored A");
      const roots = [second, structuredClone(first)];
      const savedProofs = JSON.stringify(roots);
      const before = await snapshot(f);
      assert.equal(await f.git.normalizeLeafProgressHistoryTree(restoredA, f.base, roots), treeA);
      assert.equal(await f.git.normalizeLeafProgressHistoryTree(restoredA, f.base, [...roots].reverse()), treeA,
        "caller array order is not authority for transformation order");
      assert.equal(await f.git.normalizeLeafProgressHistoryTree(candidateA, f.base, [second]), treeA,
        "future stamps do not apply to an earlier assessment");
      const normalizedB = await f.git.normalizeLeafProgressHistoryTree(candidateB, f.base, [second]);
      assert.notEqual(normalizedB, treeA);
      assert.equal(await gitCommand(f.worktree, "show", `${normalizedB}:code.txt`), "implementation B");
      assert.deepEqual(await snapshot(f), before);
      assert.equal(JSON.stringify(roots), savedProofs, "history proofs remain immutable");
      await assert.rejects(f.git.normalizeLeafProgressHistoryTree(treeA, f.base, roots), /exact available commit/,
        "a returned tree is never an input commit");

      await put(f.worktree, "code.txt", "implementation C\n");
      const candidateC = await f.git.commit(f.worktree, "genuinely changed C");
      const normalizedC = await f.git.normalizeLeafProgressHistoryTree(candidateC, f.base, roots);
      assert.notEqual(normalizedC, treeA);
      assert.equal(await gitCommand(f.worktree, "show", `${normalizedC}:code.txt`), "implementation C");

      await put(f.worktree, "code.txt", "implementation A\n");
      const currentReadme = await readFile(join(f.worktree, "README.md"), "utf8");
      await put(f.worktree, "README.md", `Authored prefix.\n\n${currentReadme}Authored suffix.\n`);
      const documented = await f.git.commit(f.worktree, "real README edit outside generated block");
      const normalizedReadme = await f.git.normalizeLeafProgressHistoryTree(documented, f.base, roots);
      assert.notEqual(normalizedReadme, treeA, "README is not ignored wholesale");
      const read = await runCommand("git", ["show", `${normalizedReadme}:README.md`], { cwd: f.worktree });
      assert.equal(read.exitCode, 0);
      assert.equal(read.stdout, `Authored prefix.\n\n${readme ?? ""}Authored suffix.\n`);
      await put(f.worktree, "docs/author-guide.md", "Genuinely changed authored guide.\n");
      const changedDoc = await f.git.commit(f.worktree, "real ordinary documentation edit");
      const normalizedDoc = await f.git.normalizeLeafProgressHistoryTree(changedDoc, f.base, roots);
      assert.notEqual(normalizedDoc, normalizedReadme, "ordinary documentation paths are not ignored wholesale");
      assert.equal(await gitCommand(f.worktree, "show", `${normalizedDoc}:docs/author-guide.md`), "Genuinely changed authored guide.");
    });
  }
});

test("history normalization skips valid non-applicable certificates and deduplicates a no-op proof chain", async (t) => {
  const f = await repository(t);
  const first = await generatedStamp(f, "first");
  const second = await generatedStamp(f, "second", { previous: [first] });
  const third = await generatedStamp(f, "third", { previous: [second] });
  const foreignBranch = "burner/foreign-progress";
  const foreignWorktree = await f.git.createWorktree("foreign", foreignBranch, f.base);
  await put(foreignWorktree, "code.txt", "foreign implementation\n");
  await f.git.commit(foreignWorktree, "foreign authored candidate");
  const foreign = await generatedStamp(f, "foreign", { cwd: foreignWorktree, targetBranch: foreignBranch });
  assert.equal(await f.git.normalizeLeafProgressHistoryTree(first.outputCommit, f.base, [foreign, third]), first.inputTree,
    "only the ancestor first stamp applies; a valid foreign branch is not generated ownership here");
  const plan = await f.git.planLeafManagedFiles(f.worktree, branch, third.outputCommit, {});
  const noop = { baseCommit: f.base, inputCommit: third.outputCommit, inputTree: plan.inputTree,
    outputCommit: third.outputCommit, outputTree: plan.tree, plan, previous: [third] };
  const before = await snapshot(f);
  const effects = await traceGit(t, f.root);
  assert.equal(await f.git.normalizeLeafProgressHistoryTree(third.outputCommit, f.base, [noop, first, structuredClone(second)]), first.inputTree);
  assert.deepEqual(await snapshot(f), before);
  assert.equal((await effects("commit")).length, 0);
  assert.equal((await effects("push")).length, 0);
  assert.equal(await f.git.normalizeLeafProgressHistoryTree(f.base, f.base, []), await f.git.tree(f.base));
});

test("history proof compaction validates every root before retaining only the exact predecessor frontier", async (t) => {
  const f = await repository(t);
  const first = await generatedStamp(f, "first");
  const second = await generatedStamp(f, "second", { previous: [first] });
  const third = await generatedStamp(f, "third", { previous: [second] });
  const foreignBranch = "burner/uncovered-legacy-proof";
  const foreignWorktree = await f.git.createWorktree("uncovered", foreignBranch, f.base);
  const uncovered = await generatedStamp(f, "independent legacy", { legacy: true, cwd: foreignWorktree, targetBranch: foreignBranch });
  const roots = [structuredClone(first), third, structuredClone(second), uncovered, structuredClone(third)];
  const saved = structuredClone(roots);
  const before = await snapshot(f);
  const effects = await traceGit(t, f.root);
  const compacted = await f.git.compactLeafProgressHistory(f.base, roots);
  assert.deepEqual(compacted, [third, uncovered], "an unrelated valid legacy root is not hidden by another branch's proof");
  assert.equal(compacted[0], third, "compaction returns the retained original proof rather than rewriting its provenance");
  assert.deepEqual(roots, saved);
  assert.equal(await f.git.normalizeLeafProgressHistoryTree(third.outputCommit, f.base, compacted), first.inputTree);

  const plan = await f.git.planLeafManagedFiles(f.worktree, branch, third.outputCommit, {});
  const noop = { baseCommit: f.base, inputCommit: third.outputCommit, inputTree: plan.inputTree,
    outputCommit: third.outputCommit, outputTree: plan.tree, plan, previous: [third] };
  assert.deepEqual(await f.git.compactLeafProgressHistory(f.base, [...roots, noop]), [uncovered, noop],
    "a no-op proof at S is distinct from the generated transformation that produced S");
  assert.deepEqual(await f.git.compactLeafProgressHistory(f.base, []), []);
  assert.deepEqual(await snapshot(f), before);
  assert.equal((await effects("commit")).length, 0);
  assert.equal((await effects("push")).length, 0);
});

test("history proof compaction refuses conflicting independently retained provenance even when the output is embedded", async (t) => {
  const f = await repository(t);
  const first = await generatedStamp(f, "first");
  const second = await generatedStamp(f, "second", { previous: [first] });
  const third = await generatedStamp(f, "third", { previous: [second] });
  const conflicting = { ...structuredClone(second), previous: [] };
  await f.git.verifyGeneratedProgress(conflicting);
  const before = await snapshot(f);
  for (const roots of [[third, conflicting], [conflicting, third]]) {
    await assert.rejects(f.git.compactLeafProgressHistory(f.base, roots), /conflicting.*(?:certificate|proof|provenance)/i);
    await assert.rejects(f.git.normalizeLeafProgressHistoryTree(third.outputCommit, f.base, roots), /conflicting.*(?:certificate|proof|provenance)/i);
  }
  assert.deepEqual(await snapshot(f), before);
});

test("history proof compaction refuses malformed, cyclic, deep, and other-base roots before pruning", async (t) => {
  const f = await repository(t);
  const first = await generatedStamp(f, "first");
  const second = await generatedStamp(f, "second", { previous: [first] });
  const before = await snapshot(f);
  for (const invalid of ["roots-shape", "root-shape", "previous-shape", "cycle", "deep", "deep-shared-prefix", "other-base", "invalid-embedded-duplicate"]) {
    await t.test(invalid, async () => {
      let roots = [second, structuredClone(first)];
      let error = /malformed|certificate roots/i;
      if (invalid === "roots-shape") roots = { previous: roots };
      if (invalid === "root-shape") roots.push({ plan: null });
      if (invalid === "previous-shape") roots[1].previous = {};
      if (invalid === "cycle") { roots[1].previous = [roots[1]]; error = /cyclic predecessor/i; }
      if (invalid.startsWith("deep")) {
        let proof = structuredClone(first);
        const prefixes = [proof];
        for (let index = 0; index < 257; index += 1) {
          proof = { ...first, previous: [proof] };
          prefixes.push(proof);
        }
        roots = invalid === "deep" ? [proof] : prefixes;
        error = /predecessor.*depth|depth.*predecessor/i;
      }
      if (invalid === "other-base") { roots[1].baseCommit = first.outputCommit; error = /another comparison base/i; }
      if (invalid === "invalid-embedded-duplicate") { roots[1].outputTree = first.inputTree; error = /certificate|transformation/i; }
      await assert.rejects(f.git.compactLeafProgressHistory(f.base, roots), error);
      await assert.rejects(f.git.normalizeLeafProgressHistoryTree(second.outputCommit, f.base, roots), error);
    });
  }
  assert.deepEqual(await snapshot(f), before);
});

test("history normalization rejects parallel ancestral stamps even when a merge retains identical generated bytes", async (t) => {
  const f = await repository(t);
  const first = await generatedStamp(f, "identical bytes");
  const foreignBranch = "burner/parallel-progress";
  const foreignWorktree = await f.git.createWorktree("parallel", foreignBranch, f.base);
  await put(foreignWorktree, "foreign-authored.txt", "foreign branch content\n");
  await f.git.commit(foreignWorktree, "parallel input");
  const parallel = await generatedStamp(f, "identical bytes", { cwd: foreignWorktree, targetBranch: foreignBranch });
  await f.git.mergeBranch(f.worktree, parallel.outputCommit);
  const head = await f.git.head(f.worktree);
  const before = await snapshot(f);
  await assert.rejects(f.git.normalizeLeafProgressHistoryTree(head, f.base, [first, parallel]), /ancestral transformation chain/);
  assert.deepEqual(await snapshot(f), before);
});

test("history certificates refuse malformed, foreign-parent, other-base, and unestablished predecessor proofs", async (t) => {
  for (const invalid of ["output-tree", "foreign-parent", "other-base", "missing-object", "previous-shape", "previous-cycle", "foreign-predecessor", "conflicting-duplicate"]) {
    await t.test(invalid, async (t) => {
      const f = await repository(t);
      const certificate = await generatedStamp(f, "first");
      const proof = structuredClone(certificate);
      const roots = [proof];
      if (invalid === "output-tree") proof.outputTree = proof.inputTree;
      if (invalid === "foreign-parent") proof.outputCommit = await gitCommand(f.worktree, ...gitIdentity, "commit-tree", proof.outputTree, "-m", "foreign same-tree root");
      if (invalid === "other-base") {
        await put(f.root, "base-only.txt", "different comparison base with identical managed bytes\n");
        proof.baseCommit = await f.git.commit(f.root, "different base");
      }
      if (invalid === "missing-object") proof.outputCommit = "f".repeat(40);
      if (invalid === "previous-shape") proof.previous = { not: "a proof array" };
      if (invalid === "previous-cycle") proof.previous = [proof];
      if (invalid === "foreign-predecessor") {
        const foreignBranch = "burner/unrelated-proof";
        const foreignWorktree = await f.git.createWorktree("unrelated", foreignBranch, f.base);
        proof.previous = [await generatedStamp(f, "foreign", { cwd: foreignWorktree, targetBranch: foreignBranch })];
      }
      if (invalid === "conflicting-duplicate") roots.push({ ...structuredClone(certificate), outputTree: certificate.inputTree });
      const before = await snapshot(f);
      await assert.rejects(f.git.normalizeLeafProgressHistoryTree(certificate.outputCommit, f.base, roots),
        /certificate|progress|base|parent|predecessor|available commit/i);
      assert.deepEqual(await snapshot(f), before);
    });
  }
});

test("history normalization requires the recorded base to precede the certificate input, not merely the current head", async (t) => {
  const f = await repository(t);
  const certificate = await generatedStamp(f, "old-base stamp");
  await put(f.root, "base-only.txt", "new comparison base\n");
  const nextBase = await f.git.commit(f.root, "new base");
  await f.git.mergeBranch(f.worktree, nextBase);
  const head = await f.git.head(f.worktree);
  const before = await snapshot(f);
  await assert.rejects(f.git.normalizeLeafProgressHistoryTree(head, nextBase, [{ ...certificate, baseCommit: nextBase }]), /base.*input|input.*base/i);
  await assert.rejects(f.git.normalizeLeafProgressHistoryTree(certificate.outputCommit, nextBase, []), /base|descend/i);
  assert.deepEqual(await snapshot(f), before);
});

test("exact commit ancestry distinguishes base advance from sibling/reset refs without accepting trees", async (t) => {
  const f = await repository(t);
  await put(f.worktree, "code.txt", "leaf implementation\n");
  const leaf = await f.git.commit(f.worktree, "leaf advance");
  await put(f.root, "base-only.txt", "base advancement\n");
  const advanced = await f.git.commit(f.root, "base advance");
  const before = await snapshot(f);
  assert.equal(await f.git.isCommitAncestor(f.base, f.base), true);
  assert.equal(await f.git.isCommitAncestor(f.base, advanced), true);
  assert.equal(await f.git.isCommitAncestor(advanced, f.base), false);
  assert.equal(await f.git.isCommitAncestor(leaf, advanced), false);
  await assert.rejects(f.git.isCommitAncestor("main", advanced), /exact available commit/);
  await assert.rejects(f.git.isCommitAncestor(await f.git.tree(f.base), advanced), /exact available commit/);
  assert.deepEqual(await snapshot(f), before);
});

test("legacy history chains require exact old-base managed content while explicit certificates preserve certified pre-stamp edits", async (t) => {
  for (const incompatible of [false, true]) await t.test(incompatible ? "unestablished old-base content" : "compatible old-base chain", async (t) => {
    const f = await repository(t);
    await put(f.worktree, "code.txt", "implementation A\n");
    if (incompatible) await put(f.worktree, historyPath, "uncertified old-base document\n");
    const input = await f.git.commit(f.worktree, "authored input");
    const first = await generatedStamp(f, "legacy first", { legacy: true });
    const second = await generatedStamp(f, "legacy second", { legacy: true, previous: [first] });
    const before = await snapshot(f);
    if (incompatible) {
      await assert.rejects(f.git.normalizeLeafProgressHistoryTree(second.outputCommit, f.base, [second]), /legacy|old-base|managed.*base/i);
      await assert.rejects(f.git.compactLeafProgressHistory(f.base, [second]), /legacy|old-base|managed.*base/i);
      const explicit = { ...second, baseCommit: f.base, previous: [{ ...first, baseCommit: f.base }] };
      assert.equal(await f.git.normalizeLeafProgressHistoryTree(second.outputCommit, f.base, [explicit]), await f.git.tree(input),
        "base-bound exact old text is restored rather than replaced wholesale with canonical documents");
    } else {
      assert.equal(await f.git.normalizeLeafProgressHistoryTree(second.outputCommit, f.base, [second]), await f.git.tree(input));
      assert.deepEqual(await f.git.compactLeafProgressHistory(f.base, [first, second]), [second]);
    }
    assert.deepEqual(await snapshot(f), before);
  });
});

test("history normalization retains refusal of unowned edits inside dedicated generated documents", async (t) => {
  for (const path of [historyPath, graphPath, "README.md"]) await t.test(path, async (t) => {
    const f = await repository(t);
    const first = await generatedStamp(f, "first");
    const second = await generatedStamp(f, "second", { previous: [first] });
    if (path === "README.md") {
      const readme = await readFile(join(f.worktree, path), "utf8");
      await put(f.worktree, path, replaceProgressReadmeBlock(readme, block("unowned managed edit")));
    } else await put(f.worktree, path, "unowned generated document edit\n");
    const head = await f.git.commit(f.worktree, "foreign managed bytes");
    const before = await snapshot(f);
    await assert.rejects(f.git.normalizeLeafProgressHistoryTree(head, f.base, [second]), /changed inherited certified managed/);
    assert.deepEqual(await snapshot(f), before);
    assert.match(await readFile(join(f.worktree, path), "utf8"), /unowned/);
  });
});

test("progress planning validates/render without writes and keeps composite updater behavior", async (t) => {
  const f = await repository(t, { managed: false, readme: "# Authored README  \n\n\n" });
  const evaluation = { id: "quality", name: "Quality", enabled: true, weight: 1, prompt: "Score", createdAt: "2026-01-01T00:00:00.000Z" };
  const point = { key: "pr:12", recordedAt: "2026-01-02T00:00:00.000Z", label: "PR #12", kind: "leaf", prNumber: 12, title: "Candidate", scores: { quality: 80 } };
  const before = await snapshot(f);
  const plan = await planProgressArtifacts(f.worktree, [evaluation], [point]);
  assert.deepEqual(await snapshot(f), before);
  await assert.rejects(readFile(join(f.worktree, historyPath)), /ENOENT/);
  assert.ok(plan.files["README.md"].startsWith("# Authored README  \n\n\n"), "existing trailing whitespace is not trimmed");
  assert.deepEqual(await updateProgressArtifacts(f.worktree, [evaluation], [point]), plan.history);
  for (const [path, contents] of Object.entries(plan.files)) assert.equal(await readFile(join(f.worktree, path), "utf8"), contents);
  const retry = await planProgressArtifacts(f.worktree, [evaluation], [{ ...point, recordedAt: "2026-02-01T00:00:00.000Z" }]);
  assert.equal(retry.history.points.length, 1);
  assert.equal(retry.history.points[0].recordedAt, point.recordedAt);
  assert.deepEqual(retry.files, plan.files);
});

test("pinned progress restoration changes only managed documents and the README block", async (t) => {
  const f = await repository(t);
  const original = await readFile(join(f.worktree, "README.md"), "utf8");
  const authored = `Authored prefix.\n\n${original.replace("old progress", "generated leaf progress")}Authored suffix.\n`;
  await put(f.worktree, "README.md", authored);
  await put(f.worktree, historyPath, "candidate progress\n");
  const before = await snapshot(f);
  const plan = await planProgressRestore(f.worktree, f.base);
  assert.deepEqual(await snapshot(f), before);
  assert.equal(plan["README.md"], authored.replace("generated leaf progress", "old progress"));
  assert.equal(plan[historyPath], '{"old":true}\n');
  assert.equal(plan[graphPath], "<svg>old</svg>\n");
  await assert.rejects(planProgressRestore(f.worktree, "main"), /exact pinned/);
  await put(f.worktree, "README.md", "# Preserve malformed README\n<!-- burner-progress:start -->\n");
  await assert.rejects(planProgressRestore(f.worktree, f.base), /Malformed/);
  assert.equal(await readFile(join(f.worktree, "README.md"), "utf8"), "# Preserve malformed README\n<!-- burner-progress:start -->\n");
  assert.throws(() => progressReadmeBlock(`${block("one")}\n${block("two")}`), /Malformed/);
});

test("exact PR observations include title, body, and draft state without mutation", async (t) => {
  const f = await repository(t);
  const bin = join(f.root, ".burner", "bin");
  await mkdir(bin);
  const log = join(f.root, ".burner", "pr-observations.jsonl");
  const observed = { number: 42, state: "OPEN", headRefName: branch, headRefOid: f.base, url: "https://example.test/pull/42", title: "Frozen title", body: "Frozen body\n", isDraft: true, statusCheckRollup: [] };
  await writeFile(join(bin, "gh"), `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n'); if(args[0] !== 'pr' || !['view', 'list'].includes(args[1])) process.exit(93); console.log(JSON.stringify(args[1] === 'list' ? [${JSON.stringify(observed)}] : ${JSON.stringify(observed)}));\n`);
  await chmod(join(bin, "gh"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });
  assert.deepEqual(await f.git.getPullRequest(f.root, 42), observed);
  assert.deepEqual(await f.git.pullRequestsForBranch(f.root, branch), [observed]);
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const fields = call[call.indexOf("--json") + 1].split(",");
    assert.ok(["headRefOid", "title", "body", "isDraft"].every((field) => fields.includes(field)));
  }
});
