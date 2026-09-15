import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LockManager } from "../dist/lib/locks.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// These are private fixture directories, never a repository's resource locks.
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "burner-lock-failure-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, manager: new LockManager(root) };
}

test("a thrown second acquisition releases previously owned locks", async (t) => {
  const { manager } = await fixture(t);
  const acquire = manager.tryAcquire.bind(manager);
  manager.tryAcquire = async (name, owner) => {
    if (name === "b") throw new Error("second acquisition failed");
    return acquire(name, owner);
  };
  await assert.rejects(manager.tryAcquireAll(["b", "a"], "test-owner"), /second acquisition failed/);
  assert.deepEqual(await manager.list(), []);
});

test("partial cleanup retains acquisition and every release failure", async (t) => {
  const { manager } = await fixture(t);
  const released = [];
  manager.tryAcquire = async (name) => {
    if (name === "c") throw new Error("acquisition failed");
    return { name, release: async () => { released.push(name); throw new Error(`release ${name} failed`); } };
  };
  await assert.rejects(manager.tryAcquireAll(["a", "b", "c"], "test-owner"), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[0].message, /acquisition failed/);
    assert.deepEqual(error.errors[1].errors.map((item) => item.message), ["release a failed", "release b failed"]);
    return true;
  });
  assert.deepEqual(released, ["a", "b"]);
});

test("publication cleanup failure undoes only its own already-published lock", async (t) => {
  const { root, manager } = await fixture(t);
  const originalRm = fs.rm;
  let sawPublished = false;
  fs.rm = async (path, options) => {
    if (String(path).startsWith(root) && String(path).endsWith(".tmp")) {
      const record = JSON.parse(await fs.readFile(join(root, "a.lock"), "utf8"));
      assert.equal(record.owner, "test-owner");
      assert.equal(typeof record.token, "string");
      sawPublished = true;
      throw Object.assign(new Error("temporary cleanup failed"), { code: "EACCES" });
    }
    return originalRm(path, options);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(manager.tryAcquire("a", "test-owner"), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.errors[0].message, /temporary cleanup failed/);
      return true;
    });
    assert.equal(sawPublished, true);
    assert.deepEqual(await manager.list(), []);
    assert.equal((await fs.readdir(root)).filter((path) => path.endsWith(".tmp")).length, 1, "failed temporary cleanup is retained for recovery, not claimed absent");
  } finally {
    fs.rm = originalRm;
    syncBuiltinESMExports();
  }
});

test("publication failure cannot unlink a replacement owner and reports both failures", async (t) => {
  const { root, manager } = await fixture(t);
  const originalRm = fs.rm;
  fs.rm = async (path, options) => {
    if (String(path).startsWith(root) && String(path).endsWith(".tmp")) {
      const replacement = join(root, "replacement.fixture");
      await fs.writeFile(replacement, JSON.stringify({ owner: "replacement-owner", token: "replacement-token" }));
      await fs.rename(replacement, join(root, "a.lock"));
      throw new Error("temporary cleanup failed");
    }
    return originalRm(path, options);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(manager.tryAcquire("a", "test-owner"), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(error.errors[0].message, /temporary cleanup failed/);
      assert.match(error.errors[1].message, /no longer belongs/);
      return true;
    });
    assert.equal(JSON.parse(await fs.readFile(join(root, "a.lock"), "utf8")).owner, "replacement-owner");
  } finally {
    fs.rm = originalRm;
    syncBuiltinESMExports();
  }
});

test("an old handle cannot release a newer token owner", async (t) => {
  const { root, manager } = await fixture(t);
  const held = await manager.tryAcquire("a", "first");
  const path = join(root, "a.lock");
  await fs.writeFile(path, JSON.stringify({ owner: "second", token: "different" }));
  await assert.rejects(held.release(), /no longer belongs/);
  assert.equal(JSON.parse(await fs.readFile(path, "utf8")).owner, "second");
});

test("concurrent releases join one unlink even when a new owner publishes before completion", async (t) => {
  const { root, manager } = await fixture(t);
  const held = await manager.tryAcquire("a", "first-owner");
  const path = join(root, "a.lock");
  const originalRead = fs.readFile;
  const originalRm = fs.rm;
  const firstMetadata = await originalRead(path, "utf8");
  const entered = deferred();
  const allowUnlink = deferred();
  const unlinked = deferred();
  const replacementPublished = deferred();
  const finishFirst = deferred();
  let unlinkCalls = 0;
  // Both old concurrent readers would have observed the same first-owner token.
  // Pin that snapshot so this interleaving does not depend on filesystem timing.
  fs.readFile = async (candidate, ...args) => candidate === path ? firstMetadata : originalRead(candidate, ...args);
  fs.rm = async (candidate, options) => {
    if (candidate !== path) return originalRm(candidate, options);
    if (++unlinkCalls === 1) {
      entered.resolve();
      await allowUnlink.promise;
      await originalRm(candidate, options);
      unlinked.resolve();
      await finishFirst.promise;
    } else {
      await replacementPublished.promise;
      await originalRm(candidate, options);
    }
  };
  syncBuiltinESMExports();
  try {
    const firstRelease = held.release();
    await entered.promise;
    const concurrentRelease = held.release();
    await Promise.resolve();
    allowUnlink.resolve();
    await unlinked.promise;
    const replacement = await manager.tryAcquire("a", "replacement-owner");
    assert.ok(replacement);
    replacementPublished.resolve();
    finishFirst.resolve();
    await Promise.all([firstRelease, concurrentRelease]);
    assert.equal(JSON.parse(await originalRead(path, "utf8")).owner, "replacement-owner");
    assert.equal(unlinkCalls, 1);
    assert.equal(firstRelease, concurrentRelease, "callers join the in-flight release promise");
  } finally {
    allowUnlink.resolve(); replacementPublished.resolve(); finishFirst.resolve();
    fs.readFile = originalRead;
    fs.rm = originalRm;
    syncBuiltinESMExports();
  }
});

test("a failed joined release remains retryable after the filesystem recovers", async (t) => {
  const { root, manager } = await fixture(t);
  const held = await manager.tryAcquire("a", "owner");
  const path = join(root, "a.lock");
  const originalRm = fs.rm;
  let attempts = 0;
  fs.rm = async (candidate, options) => {
    if (candidate === path && ++attempts === 1) throw new Error("temporary unlink failure");
    return originalRm(candidate, options);
  };
  syncBuiltinESMExports();
  try {
    const first = held.release();
    const joined = held.release();
    assert.equal(first, joined);
    await assert.rejects(first, /temporary unlink failure/);
    assert.equal(attempts, 1);
    await held.release();
    assert.equal(attempts, 2);
    assert.deepEqual(await manager.list(), []);
  } finally {
    fs.rm = originalRm;
    syncBuiltinESMExports();
  }
});
