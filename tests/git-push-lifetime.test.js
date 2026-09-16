import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import { GitService } from "../dist/lib/git.js";

const branch = "burner/push-budget";
const destination = `refs/heads/${branch}`;
const head = "a".repeat(40);
const cwd = "/unused-git-push-fixture";
const remote = "fixture";
const cases = [
  { name: "ordinary", invoke: (git) => git.push(cwd, remote, branch),
    args: ["push", "-u", remote, `${destination}:${destination}`] },
  { name: "saved leaf", invoke: (git) => git.pushLeaf(cwd, remote, branch, head, null),
    args: ["push", `--force-with-lease=${destination}:`, remote, `${head}:${destination}`] },
  { name: "composite", invoke: (git) => git.forcePush(cwd, remote, branch),
    args: ["push", `--force-with-lease=${destination}:`, "-u", remote, `${destination}:${destination}`] },
  { name: "checkpoint", invoke: (git) => git.pushCheckpoint(cwd, remote, branch),
    args: ["push", "--force", remote, `HEAD:${destination}`] },
];

async function pendingPush(t, scenario) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const children = [], signals = [], pushes = [];
  let started;
  const pushStarted = new Promise((resolve) => { started = resolve; });
  const mocked = t.mock.method(childProcess, "spawn", (command, args, options) => {
    assert.equal(command, "git");
    assert.equal(options.cwd, cwd);
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.kill = (signal) => { signals.push(signal); return true; };
    children.push(child);
    queueMicrotask(() => child.emit("spawn"));
    if (args[0] === "push") {
      assert.deepEqual(args, scenario.args);
      pushes.push(args);
      started(child);
    } else {
      // forcePush's separate read-only remote observation stays out of this
      // virtual transfer clock. Real-Git tests cover ref/lease authority.
      assert.deepEqual(args, ["ls-remote", "--heads", remote, destination]);
      queueMicrotask(() => child.emit("close", 0, null));
    }
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
    for (const child of children) {
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    }
  });

  const git = new GitService(cwd, "/unused-git-push-data");
  // Isolate transfer lifetime from filesystem fixtures; existing real-Git
  // suites exercise these preconditions and the post-push acknowledgement.
  t.mock.method(git, "assertWorktree", async () => {});
  t.mock.method(git, "head", async () => head);
  t.mock.method(git, "hasChanges", async () => false);
  t.mock.method(git, "leafMergeHeads", async () => []);
  let observations = 0;
  t.mock.method(git, "remoteBranchHead", async () => observations++ === 0 ? null : head);
  let settled = false;
  const running = scenario.invoke(git).then(
    () => { settled = true; return { ok: true }; },
    (error) => { settled = true; return { ok: false, error }; },
  );
  const child = await Promise.race([pushStarted, running.then((result) => {
    throw result.error ?? new Error("The push finished without starting its transfer");
  })]);
  const advanceSeconds = (seconds) => {
    // One-second steps exercise active time; a single large jump deliberately
    // counts as host suspension in the production process-lifetime helper.
    for (let second = 0; second < seconds; second += 1) t.mock.timers.tick(1_000);
  };
  return { child, signals, pushes, running, advanceSeconds, settled: () => settled };
}

for (const scenario of cases) {
  test(`${scenario.name} push can complete after ten active minutes`, { concurrency: false }, async (t) => {
    const f = await pendingPush(t, scenario);
    try {
      f.advanceSeconds(10 * 60 + 1);
      await new Promise(setImmediate);
      assert.deepEqual(f.signals, [], "a slow transfer must survive the former ten-minute budget");
      assert.equal(f.settled(), false);
      assert.equal(f.pushes.length, 1, "the existing transfer is not retried");
    } finally {
      f.child.emit("close", 0, null);
    }
    assert.deepEqual(await f.running, { ok: true });
  });

  test(`${scenario.name} push stays bounded and awaits close after timeout`, { concurrency: false }, async (t) => {
    const f = await pendingPush(t, scenario);
    try {
      f.advanceSeconds(30 * 60 - 1);
      assert.deepEqual(f.signals, []);
      f.advanceSeconds(1);
      assert.deepEqual(f.signals, ["SIGTERM"]);
      f.advanceSeconds(5);
      await new Promise(setImmediate);
      assert.deepEqual(f.signals, ["SIGTERM", "SIGKILL"]);
      assert.equal(f.settled(), false, "signals cannot release the publisher before child close");
      assert.equal(f.pushes.length, 1);
    } finally {
      f.child.emit("close", null, "SIGKILL");
    }
    const result = await f.running;
    assert.equal(result.ok, false);
    assert.match(result.error.message, /Command timed out after 1800000ms\./);
  });
}
