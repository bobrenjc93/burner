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
    assert.throws(() => held.forResource(manager, "a"), /releasing or released/);
    assert.equal(attempts, 1);
    await held.release();
    assert.equal(attempts, 2);
    assert.deepEqual(await manager.list(), []);
  } finally {
    fs.rm = originalRm;
    syncBuiltinESMExports();
  }
});

const canonicalRecord = (overrides = {}) => ({
  owner: "fixture-owner", pid: 987654, createdAt: "2000-01-01T00:00:00.000Z", token: "fixture-dead-token", ...overrides,
});

test("borrowing uses the canonical physical key and rejects foreign or released authority", async (t) => {
  const { root, manager } = await fixture(t);
  const held = await manager.acquire("cpu/heavy", "caller");
  assert.equal(held.name, "cpu/heavy");
  assert.equal(held.forResource(manager, "cpu-heavy"), held);
  assert.equal(held.forResource(manager, "gpu"), undefined);
  assert.throws(() => held.forResource(new LockManager(root), "cpu-heavy"), /different resource manager/);
  await held.release();
  assert.throws(() => held.forResource(manager, "cpu-heavy"), /releasing or released/);
});

test("live owners never age out, including the ignored legacy constructor argument", async (t) => {
  const { root, manager } = await fixture(t);
  const probes = t.mock.method(process, "kill", () => assert.fail("admission must not infer work completion from a PID"));
  const held = await manager.acquire("cpu-heavy", "live-owner");
  const path = join(root, "cpu-heavy.lock");
  const record = JSON.parse(await fs.readFile(path, "utf8"));
  record.createdAt = "2000-01-01T00:00:00.000Z";
  await fs.writeFile(path, JSON.stringify(record));
  const other = new LockManager(root, 1);
  try {
    assert.equal(await other.tryAcquire("cpu/heavy", "contender"), undefined);
    assert.deepEqual(await other.reapOrphans(), []);
    assert.equal(JSON.parse(await fs.readFile(path, "utf8")).token, record.token);
    assert.equal(held.forResource(manager, "cpu-heavy"), held);
    assert.equal(probes.mock.callCount(), 0);
  } finally { await held.release(); }
});

test("dead-controller metadata never authorizes admission or automatic reclamation for any resource", async (t) => {
  const { root, manager } = await fixture(t);
  const probes = t.mock.method(process, "kill", () => { throw Object.assign(new Error("dead fixture PID"), { code: "ESRCH" }); });
  const raw = JSON.stringify(canonicalRecord());
  for (const name of ["cpu-heavy", "gpu", "git-metadata"]) await fs.writeFile(join(root, `${name}.lock`), raw);
  const others = Array.from({ length: 6 }, () => new LockManager(root, 0));
  const results = await Promise.all(others.map(async (other) => [
    await other.tryAcquire("cpu/heavy", "contender"),
    await other.tryAcquire("gpu", "contender"),
    await other.tryAcquire("git-metadata", "contender"),
    await other.reapOrphans(),
  ]));
  assert.deepEqual(results, others.map(() => [undefined, undefined, undefined, []]));
  assert.equal(await manager.tryAcquireAll(["aaa", "cpu-heavy"], "partial-contender"), undefined);
  await assert.rejects(manager.acquire("cpu/heavy", "blocking-contender", { timeoutMs: 0 }), (error) => {
    assert.ok(error.message.includes(join(root, "cpu-heavy.lock")));
    assert.match(error.message, /does not prove its work stopped/);
    assert.match(error.message, /quiescence.*every controller.*operator recovery/);
    return true;
  });
  assert.deepEqual((await fs.readdir(root)).sort(), ["cpu-heavy.lock", "git-metadata.lock", "gpu.lock"]);
  for (const name of ["cpu-heavy", "gpu", "git-metadata"]) assert.equal(await fs.readFile(join(root, `${name}.lock`), "utf8"), raw);
  assert.equal(probes.mock.callCount(), 0, "even ESRCH must not be used to reclaim somebody else's resource");
  assert.equal(manager.waiters.size, 0, "a timeout still retires its local FIFO reservation");
});

test("all malformed, legacy and unknown ownership bytes remain occupied without interpretation", async (t) => {
  const { root, manager } = await fixture(t);
  const probes = t.mock.method(process, "kill", () => assert.fail("unknown ownership must never be probed as authority"));
  const records = [
    "", "{", "null", JSON.stringify(canonicalRecord({ pid: undefined })),
    JSON.stringify(canonicalRecord({ token: undefined })), JSON.stringify(canonicalRecord({ pid: 0 })),
    JSON.stringify(canonicalRecord({ pid: -1 })), JSON.stringify(canonicalRecord({ pid: 1.5 })),
    JSON.stringify(canonicalRecord({ createdAt: "unknown" })), JSON.stringify(canonicalRecord()),
  ];
  for (const [index, raw] of records.entries()) {
    const name = `unknown-${index}`;
    const path = join(root, `${name}.lock`);
    await fs.writeFile(path, raw);
    assert.equal(await manager.tryAcquire(name, "contender"), undefined);
    assert.deepEqual(await manager.reapOrphans(), []);
    assert.equal(await fs.readFile(path, "utf8"), raw);
  }
  assert.equal(probes.mock.callCount(), 0);
  assert.equal((await fs.readdir(root)).every((name) => name.endsWith(".lock")), true);
});

test("unreadable ownership cannot bypass an occupied path and is not inspected during admission", async (t) => {
  const { root, manager } = await fixture(t);
  const path = join(root, "a.lock");
  const raw = JSON.stringify(canonicalRecord());
  await fs.writeFile(path, raw);
  const read = fs.readFile;
  let reads = 0;
  fs.readFile = async (candidate, ...args) => {
    if (candidate === path) { reads += 1; throw Object.assign(new Error("fixture metadata unavailable"), { code: "EPERM" }); }
    return read(candidate, ...args);
  };
  syncBuiltinESMExports();
  try {
    assert.equal(await manager.tryAcquire("a", "contender"), undefined);
    assert.deepEqual(await manager.reapOrphans(), []);
    assert.deepEqual(await manager.list(), ["a"]);
    assert.equal(reads, 0);
    assert.equal(await read(path, "utf8"), raw);
  } finally {
    fs.readFile = read;
    syncBuiltinESMExports();
  }
});

test("legacy recovery guard files are inert and never participate in admission", async (t) => {
  const { root, manager } = await fixture(t);
  const path = join(root, ".recovery.guard");
  await fs.writeFile(join(root, "a.lock"), JSON.stringify(canonicalRecord()));
  for (const raw of [JSON.stringify(canonicalRecord()), "{unknown"]) {
    await fs.writeFile(path, raw);
    assert.deepEqual(await manager.reapOrphans(), []);
    assert.equal(await manager.tryAcquire("a", "contender"), undefined);
    assert.equal(await fs.readFile(path, "utf8"), raw);
    assert.deepEqual(await manager.list(), ["a"]);
    const free = await manager.tryAcquire("free", "unrelated");
    assert.ok(free);
    await free.release();
    assert.deepEqual((await fs.readdir(root)).sort(), [".recovery.guard", "a.lock"]);
  }
});

test("deprecated reapOrphans retains its call shape without claiming removal or publishing state", async (t) => {
  const { root } = await fixture(t);
  const path = join(root, "compatibility");
  const manager = new LockManager(path, -1);
  assert.deepEqual(await manager.reapOrphans(), []);
  assert.deepEqual(await fs.readdir(path), []);
});
