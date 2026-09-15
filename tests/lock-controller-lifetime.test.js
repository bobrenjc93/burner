import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { EventHub } from "../dist/lib/events.js";
import { LockManager } from "../dist/lib/locks.js";
import { Orchestrator } from "../dist/lib/orchestrator.js";
import { runCommand } from "../dist/lib/process.js";
import { StateStore } from "../dist/lib/store.js";

async function workerState(pid) {
  try { return (await readFile(`/proc/${pid}/status`, "utf8")).match(/^State:\s+(.+)$/m)?.[1]; }
  catch (error) { if (error.code === "ENOENT") return "gone"; throw error; }
}

async function ownerMain(root) {
  const store = new StateStore(root);
  await store.init();
  const orchestrator = new Orchestrator(root, store, new EventHub());
  process.on("message", async (message) => {
    if (message !== "shutdown") return;
    await orchestrator.close();
    // The normal CLI boundary exits after close without joining the cohort.
    process.exit(0);
  });
  let stdout = "";
  await orchestrator.withEvaluationLease(undefined, () => runCommand(process.execPath, ["-e", [
    "process.on('SIGTERM', () => {});",
    "console.log(process.pid);",
    "setTimeout(() => process.exit(0), 30000);", // Safety bound if the test runner itself dies.
  ].join("\n")], {
    cwd: root,
    signal: orchestrator.codex.abortController.signal,
    onStdout: (chunk) => {
      stdout += chunk;
      if (stdout.includes("\n")) process.send({ workerPid: Number(stdout.trim()) });
    },
  }));
}

if (process.argv[2] === "fixture-owner") {
  await ownerMain(process.argv[3]);
} else {
  test("controller exit cannot admit an existing waiter while its direct managed child survives", {
    skip: process.platform !== "linux" && "requires Linux /proc to distinguish a live child from a zombie",
  }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "burner-controller-lifetime-test-"));
    const lockDirectory = join(root, ".burner", "locks");
    const path = join(lockDirectory, "cpu-heavy.lock");
    const owner = spawn(process.execPath, [fileURLToPath(import.meta.url), "fixture-owner", root], {
      cwd: root, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    owner.stderr.on("data", (chunk) => { stderr += chunk; });
    const ownerExit = once(owner, "exit");
    let workerPid;
    let workerStopped = false;
    let waiting;
    let replacement;
    let startup;
    const stopWorker = async () => {
      if (!workerPid || workerStopped) return;
      const state = await workerState(workerPid);
      if (state !== "gone" && !state?.startsWith("Z")) {
        // Only this fixture's direct child, whose PID came from its private IPC owner.
        try { process.kill(-workerPid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const stopped = await workerState(workerPid);
        if (stopped === "gone" || stopped?.startsWith("Z")) { workerStopped = true; return; }
        await delay(10);
      }
      throw new Error("The fixture's managed child did not stop during cleanup.");
    };
    try {
      const ready = await Promise.race([
        once(owner, "message").then(([message]) => message),
        ownerExit.then(() => { throw new Error(`Fixture owner exited before child readiness: ${stderr}`); }),
      ]);
      workerPid = ready.workerPid;
      assert.ok(Number.isSafeInteger(workerPid) && workerPid > 1 && workerPid !== process.pid && workerPid !== owner.pid);
      const original = await readFile(path, "utf8");
      const waiter = new LockManager(lockDirectory);
      let denied;
      const firstDenial = new Promise((resolve) => { denied = resolve; });
      const attempt = waiter.tryAcquireQueued.bind(waiter);
      waiter.tryAcquireQueued = async (...args) => {
        const held = await attempt(...args);
        if (!held) denied();
        return held;
      };
      let admitted = false;
      waiting = waiter.acquire("cpu/heavy", "already-waiting-controller", { timeoutMs: 2500, pollMs: 10 })
        .then((held) => { replacement = held; admitted = true; return { held }; }, (error) => ({ error }));
      await firstDenial;
      assert.equal(admitted, false, "the second controller is already waiting before shutdown");
      owner.send("shutdown");
      assert.deepEqual(await ownerExit, [0, null], stderr);
      const result = await waiting;
      assert.match(await workerState(workerPid), /^[SRD]/, "the ordinary direct child still runs after its controller exited");
      assert.equal(admitted, false, "parent PID death is not permission to launch a replacement measurement");
      assert.match(result.error.message, /Timed out waiting for resource lock/);
      assert.ok(result.error.message.includes(path), "diagnostics identify the canonical physical path despite the alias");
      assert.match(result.error.message, /quiescen/i);
      assert.equal(await readFile(path, "utf8"), original);
      assert.deepEqual(await waiter.reapOrphans(), [], "the compatibility entry point cannot delete the abandoned cohort lock");

      const store = new StateStore(root);
      await store.init();
      startup = new Orchestrator(root, store, new EventHub());
      startup.initializeProtectedParentRepository = async () => undefined;
      startup.git = { status: async () => ({ available: false }) };
      await startup.init({ manual: true });
      assert.equal(await readFile(path, "utf8"), original, "fresh startup cannot reclaim the same live-child resource");
      assert.ok(store.get().activity.some((entry) => entry.message === "Resource locks retained" && entry.detail.includes(lockDirectory)));
      await startup.close();
      startup = undefined;

      // Model deliberate operator recovery only after every fixture controller
      // has stopped/waited out, and the surviving child is observed stopped.
      await stopWorker();
      await rm(path);
      const recovered = await waiter.tryAcquire("cpu-heavy", "quiescent-operator-recovery");
      assert.ok(recovered);
      await recovered.release();
      t.diagnostic("Existing waiter and fresh startup preserved the dead controller's lock; direct child cleanup was observed before explicit private-fixture recovery.");
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
      await ownerExit;
      if (waiting) await waiting;
      await startup?.close();
      await stopWorker();
      await replacement?.release();
      await rm(root, { recursive: true, force: true });
    }
  });
}
