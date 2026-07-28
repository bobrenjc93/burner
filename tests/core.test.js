import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LockManager } from "../dist/lib/locks.js";
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
  } finally {
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
