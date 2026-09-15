import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runCommand } from "../dist/lib/process.js";

function fakeSpawn(t) {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const signals = [];
  child.kill = (signal) => { signals.push(signal); return true; };
  const mocked = t.mock.method(childProcess, "spawn", () => child);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  });
  return { child, signals };
}

for (const termination of ["timeout", "abort"]) {
  test(`${termination} cannot finish a managed invocation before the child closes`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { child, signals } = fakeSpawn(t);
    const controller = new AbortController();
    let settled = false;
    const running = runCommand("fixture-only", [], {
      cwd: "/unused-fixture-path", signal: controller.signal,
      ...(termination === "timeout" ? { timeoutMs: 10 } : {}),
    }).finally(() => { settled = true; });
    child.emit("spawn");
    if (termination === "abort") controller.abort();
    try {
      if (termination === "timeout") t.mock.timers.tick(10);
      t.mock.timers.tick(6_000);
      await new Promise(setImmediate);
      assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
      assert.equal(settled, false, "the old six-second synthetic completion must not release admission");
    } finally {
      child.emit("close", null, "SIGKILL");
    }
    const result = await running;
    assert.equal(result.termination, termination);
    assert.equal(result.exitCode, termination === "timeout" ? 124 : 130);
  });
}

test("a genuine failed spawn rejects without waiting for an impossible child exit", async (t) => {
  const { child } = fakeSpawn(t);
  const error = Object.assign(new Error("spawn fixture ENOENT"), { code: "ENOENT" });
  const rejected = assert.rejects(runCommand("fixture-only", [], { cwd: "/unused-fixture-path" }), (actual) => actual === error);
  child.emit("error", error);
  await rejected;
});

test("an error from an already-started child is retained but cannot finish before close", async (t) => {
  const { child } = fakeSpawn(t);
  const error = new Error("started child error");
  let settled = false;
  const running = runCommand("fixture-only", [], { cwd: "/unused-fixture-path" }).finally(() => { settled = true; });
  const rejected = assert.rejects(running, (actual) => actual === error);
  child.emit("spawn");
  child.emit("error", error);
  try {
    await new Promise(setImmediate);
    assert.equal(settled, false);
  } finally {
    child.emit("close", 1, null);
  }
  await rejected;
});

test("a synchronous spawn PID is enough to retain multiple later errors until close", async (t) => {
  const { child } = fakeSpawn(t);
  child.pid = 987654; // No signal path is exercised; this is a synchronous spawn-return fixture.
  const first = new Error("first started-child error");
  const second = new Error("second started-child error");
  let settled = false;
  const running = runCommand("fixture-only", [], { cwd: "/unused-fixture-path" }).finally(() => { settled = true; });
  const rejected = assert.rejects(running, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [first, second]);
    return true;
  });
  child.emit("error", first);
  child.emit("error", second);
  try {
    await new Promise(setImmediate);
    assert.equal(settled, false);
  } finally { child.emit("close", 1, null); }
  await rejected;
});
