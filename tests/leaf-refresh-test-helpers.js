import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitService } from "../dist/lib/git.js";
import { runCommand } from "../dist/lib/process.js";

export async function fixtureGit(cwd, ...args) {
  const result = await runCommand("git", args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

// All refs, worktrees, and publications belong to the test directory. Git is
// real, including its two-parent merge and saved-lease bare-remote push; only
// GitHub reads/writes and the later author/evaluator are supplied by callers.
export async function leafRefreshRepository(root, { branch, parentBranch = "main", published = false, deferTarget = false } = {}) {
  await fixtureGit(root, "init", "-b", "main");
  await fixtureGit(root, "config", "gc.auto", "0");
  await fixtureGit(root, "config", "maintenance.auto", "false");
  await writeFile(join(root, ".gitignore"), ".burner/\n");
  await writeFile(join(root, "README.md"), "# Isolated refresh fixture\n\nAuthored documentation.\n");
  await writeFile(join(root, "base.txt"), "base\n");
  const git = new GitService(root, join(root, ".burner"));
  const base = await git.commit(root, "fixture base");
  const worktree = await git.createWorktree("refresh-fixture", branch, base);
  await writeFile(join(worktree, "leaf.txt"), "candidate implementation\n");
  const head = await git.commit(worktree, "fixture candidate");
  let target = base;
  const advance = async () => {
    await writeFile(join(root, "upstream.txt"), "pinned upstream implementation\n");
    target = await git.commit(root, "fixture next base");
    return target;
  };
  if (!deferTarget) await advance();
  if (parentBranch !== "main") await fixtureGit(root, "branch", parentBranch, target);
  const remote = join(root, ".burner", "fixture-remote.git");
  await fixtureGit(root, "init", "--bare", remote);
  await fixtureGit(root, "remote", "add", "origin", remote);
  await git.push(root, "origin", parentBranch);
  if (published) await git.push(worktree, "origin", branch);
  const calls = { merges: [], pushes: [], fetched: [] };
  const prepare = git.prepareLeafMerge.bind(git);
  git.prepareLeafMerge = async (cwd, actualBranch, plan) => { calls.merges.push(plan.targetCommit); return prepare(cwd, actualBranch, plan); };
  const push = git.pushLeaf.bind(git);
  git.pushLeaf = async (...args) => { calls.pushes.push(args); return push(...args); };
  const fetch = git.fetchBranch.bind(git);
  git.fetchBranch = async (...args) => { calls.fetched.push(args); return fetch(...args); };
  return { git, base, head, target, worktree, remote, calls, advance: async () => {
    const next = await advance();
    await git.push(root, "origin", "main");
    return next;
  } };
}
