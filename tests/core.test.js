import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LockManager } from "../dist/lib/locks.js";
import { createBurnerServer } from "../dist/server.js";
import { StateStore, validateEvaluation } from "../dist/lib/store.js";
import { clampScore, parseJsonObject, slugify, weightedScore } from "../dist/lib/utils.js";

test("score helpers clamp and weight enabled evaluations", () => {
  assert.equal(clampScore(105), 100);
  assert.equal(clampScore(-4), 0);
  assert.equal(clampScore(72.26), 72.3);
  const evaluations = [
    { id: "quality", weight: 2, enabled: true },
    { id: "speed", weight: 1, enabled: true },
    { id: "paused", weight: 10, enabled: false },
  ];
  assert.equal(weightedScore(evaluations, new Map([["quality", 80], ["speed", 50], ["paused", 0]])), 70);
});

test("structured output parser tolerates a fenced preamble", () => {
  assert.deepEqual(parseJsonObject("result follows\n{\"score\": 88}\nthanks"), { score: 88 });
  assert.equal(slugify("Polish the first-run UX!"), "polish-the-first-run-ux");
});

test("resource locks are exclusive and recover after release", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-lock-test-"));
  try {
    const locks = new LockManager(root);
    const first = await locks.tryAcquire("gpu", "agent-one");
    assert.ok(first);
    assert.equal(await locks.tryAcquire("gpu", "agent-two"), undefined);
    assert.deepEqual(await locks.list(), ["gpu"]);
    await first.release();
    const second = await locks.tryAcquire("gpu", "agent-two");
    assert.ok(second);
    await second.release();
    await writeFile(join(root, "orphan.lock"), JSON.stringify({ pid: 2_147_483_647, createdAt: new Date().toISOString() }));
    assert.deepEqual(await locks.reapOrphans(), ["orphan"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compiled server serves the API and closes connected event streams", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-server-test-"));
  const burner = await createBurnerServer({ root, host: "127.0.0.1", port: 0 });
  try {
    const address = burner.server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.deepEqual(health, { ok: true, project: root.split("/").at(-1) });

    const created = await fetch(`${base}/api/evaluations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Docs", prompt: "Score the docs", weight: 2, enabled: true }),
    });
    assert.equal(created.status, 201);

    await new Promise((resolve, reject) => {
      const request = get(`${base}/api/events`, (response) => {
        response.once("data", resolve);
        response.on("error", reject);
      });
      request.on("error", reject);
    });
    await Promise.race([
      burner.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Server shutdown timed out with an SSE client")), 1_500)),
    ]);
  } finally {
    if (burner.server.listening) await burner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("state persists evaluation configuration and excludes candidate scores from baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-store-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const evaluation = store.get().evaluations[0];
    await store.update((state) => {
      state.evaluationRuns.push(
        { id: "baseline", evaluationId: evaluation.id, score: 61, commit: "a", createdAt: "2026-01-01T00:00:00.000Z", durationMs: 1, status: "completed", context: "manual" },
        { id: "candidate", evaluationId: evaluation.id, score: 99, commit: "b", createdAt: "2026-01-02T00:00:00.000Z", durationMs: 1, status: "completed", context: "agent" },
      );
    });
    assert.equal(store.latestRuns().get(evaluation.id)?.score, 61);
    const reloaded = new StateStore(root);
    await reloaded.init();
    assert.equal(reloaded.get().projectName, root.split("/").at(-1));
    assert.equal(reloaded.latestRuns().get(evaluation.id)?.score, 61);
    assert.deepEqual(validateEvaluation({ name: " UX ", prompt: " Score it ", weight: 2 }), { name: "UX", prompt: "Score it", weight: 2, enabled: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
