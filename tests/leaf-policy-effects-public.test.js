import assert from "node:assert/strict";
import test from "node:test";
import { latestFullAssessment } from "../dist/lib/orchestrator.js";
import { withFixture, attempt, clone, tuple, deliver, readyAtMergeBoundary, landFixturePr,
  evidenceSnapshot, assertEvidenceUnchanged } from "./leaf-policy-effects-test-helpers.js";

const snapshot = (f) => clone({ evidence: evidenceSnapshot(f), rows: f.store.get().evaluationRuns,
  effects: f.calls.effects.length, merges: f.calls.merges.length, pushes: f.calls.gitPushes.length,
  id: f.run().id, branch: f.run().branch, prNumber: f.run().prNumber, token: f.run().leafPr.creationToken });

function unchanged(f, saved, effects = 0) {
  assertEvidenceUnchanged(f, saved.evidence);
  assert.deepEqual(f.store.get().evaluationRuns, saved.rows, "no new samples or baseline promotion");
  assert.equal(f.calls.effects.length, saved.effects + effects);
  assert.equal(f.calls.merges.length, saved.merges, "historical facts confer no merge authority");
  assert.equal(f.calls.gitPushes.length, saved.pushes);
  assert.equal(f.run().id, saved.id);
  assert.equal(f.run().branch, saved.branch);
  assert.equal(f.run().prNumber, saved.prNumber);
  assert.equal(f.run().leafPr.creationToken, saved.token, "no replacement PR owner");
}

const drift = (f) => f.store.update((state) => { state.evaluations.find((item) => item.id === "command").weight = 7; });

test("stale completed delivery distinguishes an applied create AFTER from unapplied BEFORE", async (t) => {
  for (const image of ["after", "before"]) await t.test(image, async (t) => withFixture(t, {}, async (f) => {
    f.fault = { name: "create", cut: image === "after" ? "lost-response" : "request-error", hit: false };
    await f.server.orchestrator.runNextIdea();
    assert.equal(f.fault.hit, true);
    const owner = clone(f.run().leafPr), receipt = clone(f.run().continuation.evaluation);
    assert.equal(owner.pending.effect.kind, "create");
    assert.equal(owner.pending.owner.kind, "delivery");
    assert.ok(receipt.result.completedAt);
    assert.equal(f.run().prNumber, undefined, "creation response has not established a numbered local owner");
    if (image === "after") assert.deepEqual(tuple(f.world.pr), owner.pending.effect.after);
    else assert.equal(f.world.pr, undefined);
    f.fault = undefined;
    await drift(f);
    const saved = snapshot(f);
    await f.restart();
    const result = await attempt(f.retry);
    if (image === "after") {
      assert.equal(result.error, undefined, result.error?.stack);
      assert.equal(f.run().status, "completed");
      assert.equal(f.run().continuation.step, "done");
      assert.equal(f.run().prNumber, 42);
      assert.equal(f.run().leafPr.pending, undefined);
      assert.deepEqual(f.run().leafPr.known.fields, owner.pending.target);
      assert.deepEqual(tuple(f.world.pr), owner.pending.target);
    } else {
      assert.ok(result.error);
      assert.deepEqual(f.run().leafPr, owner);
      assert.equal(f.run().prNumber, undefined);
      assert.equal(f.world.pr, undefined);
    }
    assert.deepEqual(f.run().continuation.evaluation, receipt);
    assertEvidenceUnchanged(f, saved.evidence);
    assert.deepEqual(f.store.get().evaluationRuns, saved.rows);
    assert.equal(f.calls.effects.length, saved.effects, "neither repeated create nor unapplied stale create can be sent");
    assert.equal(f.calls.merges.length, saved.merges);
    assert.equal(f.calls.gitPushes.length, saved.pushes);
    assert.equal(f.run().id, saved.id);
    assert.equal(f.run().branch, saved.branch);
    assert.equal(f.run().leafPr.creationToken, saved.token);
    await f.restart();
    if (image === "after") await f.sync(); else await attempt(f.retry);
    assert.equal(f.calls.effects.length, saved.effects);
    assert.deepEqual(f.store.get().evaluationRuns, saved.rows);
    assertEvidenceUnchanged(f, saved.evidence);
  }));
});

async function pending(f, kind, image, ready = false) {
  await deliver(f);
  if (ready) await readyAtMergeBoundary(f);
  let name;
  if (kind === "ready") {
    name = "ready";
    f.invoke = f.merge;
  } else if (kind === "weight") {
    name = "edit:body";
    await f.store.update((state) => { state.evaluations.find((item) => item.id === "command").weight = 2; });
    f.invoke = () => f.server.orchestrator.refreshEvaluationWeights();
  } else {
    name = "edit:body";
    f.phase = "full-publication";
    f.scores.prompt = 56;
    f.invoke = f.full;
  }
  f.fault = { name, cut: image === "after" ? "lost-response" : "request-error", hit: false };
  const result = await attempt(f.invoke);
  assert.equal(f.fault.hit, true, result.error?.stack ?? JSON.stringify(f.run()));
  const saved = clone(f.run().leafPr.pending);
  assert.ok(saved.effect);
  assert.equal(saved.owner.kind, kind === "ready" ? "merge-ready" : kind === "weight" ? "weight-presentation" : "full-publication");
  assert.deepEqual(tuple(f.world.pr), image === "after" ? saved.effect.after : saved.effect.before);
  assert.deepEqual(f.run().leafPr.known.fields, saved.effect.before);
  if (image === "third") f.world.pr.body += "\nIndependent foreign edit";
  f.fault = undefined;
  await drift(f);
  await f.restart();
  return saved;
}

test("stale readiness and weight intents distinguish exact BEFORE, AFTER, and THIRD tuples", async (t) => {
  for (const kind of ["ready", "weight"]) for (const image of ["before", "after", "third"]) {
    await t.test(`${kind}: ${image}`, async (t) => withFixture(t, {}, async (f) => {
      const intent = await pending(f, kind, image);
      const saved = snapshot(f), owner = clone(f.run().leafPr), remote = tuple(f.world.pr);
      const recover = kind === "weight" ? () => f.server.orchestrator.refreshEvaluationWeights() : f.merge;
      const result = await attempt(recover);
      if (image === "after") {
        assert.equal(f.run().leafPr.pending, undefined, result.error?.stack);
        assert.deepEqual(f.run().leafPr.known.fields, intent.effect.after);
        if (kind === "ready") assert.ok(result.error, "acknowledged readiness still cannot authorize a stale merge");
      } else {
        assert.ok(result.error, `${kind} ${image} must stop explicitly`);
        assert.deepEqual(f.run().leafPr, owner, "retain the unapplied or conflicting exact owner");
      }
      assert.deepEqual(tuple(f.world.pr), remote);
      unchanged(f, saved);
      await f.restart();
      if (image === "after" && kind === "weight") await f.sync();
      else await attempt(recover);
      unchanged(f, saved);
    }));
  }
});

test("stale saved full publication finishes factual BEFORE/AFTER but refuses THIRD", async (t) => {
  for (const image of ["before", "after", "third"]) await t.test(image, async (t) => withFixture(t, {}, async (f) => {
    const intent = await pending(f, "full", image);
    const saved = snapshot(f), owner = clone(f.run().leafPr), full = clone(latestFullAssessment(f.run()));
    assert.equal(f.run().fullEvaluation.step, "publication");
    assert.equal(full.qualified, true, "the saved factual verdict is positive under its original policy");
    const result = await attempt(f.full);
    if (image === "third") {
      assert.ok(result.error);
      assert.deepEqual(f.run().leafPr, owner);
      assert.equal(f.run().fullEvaluation.step, "publication");
    } else {
      if (result.error) assert.match(result.error.message, /changed.*definitions|policy|resampl/i);
      else assert.equal(result.value, false, "saved positive facts are not current qualification");
      assert.equal(f.run().fullEvaluation, undefined);
      assert.equal(f.run().leafPr.pending, undefined);
      assert.deepEqual(f.run().leafPr.known.fields, intent.target);
      assert.deepEqual(tuple(f.world.pr), intent.target);
    }
    assert.deepEqual(latestFullAssessment(f.run()), full, "historical verdict remains byte-for-byte equivalent");
    unchanged(f, saved, image === "before" ? 1 : 0);
    await f.restart();
    await attempt(f.full);
    unchanged(f, saved, image === "before" ? 1 : 0);
  }));
});

test("stale exact after-images recover acknowledgment rename failure before and after durability", async (t) => {
  for (const kind of ["ready", "weight", "full"]) for (const cut of ["before", "after"]) {
    await t.test(`${kind}: ${cut}`, async (t) => withFixture(t, {}, async (f) => {
      const intent = await pending(f, kind, "after");
      const saved = snapshot(f);
      f.ackFault = { pending: intent, cut, hit: false };
      const recover = kind === "weight" ? () => f.server.orchestrator.refreshEvaluationWeights() : kind === "ready" ? f.merge : f.full;
      await attempt(recover);
      assert.equal(f.ackFault.hit, true, "actual state rename acknowledgment boundary was reached");
      assert.deepEqual(f.ackFault.durable.leafPr.known.fields, cut === "before" ? intent.effect.before : intent.effect.after);
      if (cut === "before") assert.deepEqual(f.ackFault.durable.leafPr.pending.effect, intent.effect);
      else assert.equal(f.ackFault.durable.leafPr.pending.effect, undefined);
      unchanged(f, saved);
      f.ackFault = undefined;
      await f.restart();
      await attempt(kind === "weight" && !f.run().leafPr.pending ? f.sync : recover);
      assert.equal(f.run().leafPr.pending, undefined);
      assert.deepEqual(f.run().leafPr.known.fields, intent.effect.after);
      unchanged(f, saved);
    }));
  }
});

test("damaged pending ready provenance cannot acknowledge its remote after-image under drift", async (t) => withFixture(t, {}, async (f) => {
  await pending(f, "ready", "after");
  await f.store.update((state) => { state.agentRuns[0].leafPr.pending.owner.head = f.base; });
  const owner = clone(f.run().leafPr), saved = snapshot(f);
  await assert.rejects(f.merge);
  assert.deepEqual(f.run().leafPr, owner);
  unchanged(f, saved);
}));

test("damaged recorded provenance cannot acknowledge a stale weight-presentation after-image", async (t) => {
  for (const damage of ["delivery reduction", "presentation policy"]) await t.test(damage, async (t) => withFixture(t, {}, async (f) => {
    await pending(f, "weight", "after");
    await f.store.update((state) => {
      if (damage === "delivery reduction") state.agentRuns[0].continuation.evaluation.result.impact += 1;
      else state.agentRuns[0].leafPr.pending.owner.fingerprint = "{broken recorded policy";
    });
    const owner = clone(f.run().leafPr), saved = snapshot(f);
    await assert.rejects(() => f.server.orchestrator.refreshEvaluationWeights());
    assert.deepEqual(f.run().leafPr, owner);
    unchanged(f, saved);
  }));
});

test("MERGED with stale full-content BEFORE does not invent an unpublished content after-image", async (t) => withFixture(t, {}, async (f) => {
  const intent = await pending(f, "full", "before");
  await landFixturePr(f);
  const saved = snapshot(f), owner = clone(f.run().leafPr);
  await f.restart();
  await f.sync();
  assert.equal(f.run().prState, "open", "unpublished content must remain an explicit reconciliation conflict");
  assert.deepEqual(f.run().leafPr, owner);
  assert.deepEqual(f.run().leafPr.known.fields, intent.effect.before);
  assert.equal(f.run().fullEvaluation.step, "publication");
  unchanged(f, saved);
}));

test("stale pending readiness observes independent MERGED without inventing ready success", async (t) => withFixture(t, {}, async (f) => {
  const intent = await pending(f, "ready", "before");
  await landFixturePr(f);
  const saved = snapshot(f);
  await f.restart();
  await f.sync();
  assert.equal(f.run().prState, "merged", JSON.stringify(f.store.get().activity.slice(0, 5)));
  assert.equal(f.run().leafPr.pending, undefined);
  assert.deepEqual(f.run().leafPr.known.fields, intent.effect.before);
  assert.equal(f.run().leafPr.known.fields.isDraft, true);
  assert.equal(f.run().leafPr.known.fields.state, "OPEN");
  unchanged(f, saved);
}));

test("stale completed progress push settles proved MERGED without repeating source publication", async (t) => withFixture(t, {}, async (f) => {
  await deliver(f);
  const delivery = clone(f.run().continuation.evaluation);
  f.interruptProgressPush = true;
  await assert.rejects(f.merge, /progress push completed before semantic acknowledgment/);
  const progress = clone(f.interruptedProgress);
  assert.equal(progress.step, "progress");
  assert.equal(progress.phase, "push");
  assert.equal(await f.git.remoteBranchHead(f.root, "origin", f.run().branch), progress.head);
  assert.equal(f.run().generatedProgress, undefined);
  await drift(f);
  await landFixturePr(f);
  const saved = snapshot(f), known = clone(f.run().leafPr.known.fields);
  await f.restart();
  const result = await f.retry();
  assert.equal(result.prState, "merged");
  assert.equal(result.continuation.step, "done");
  assert.equal(result.continuation.head, progress.head);
  assert.deepEqual(result.continuation.evaluation, delivery);
  assert.equal(result.generatedProgress.outputCommit, progress.head);
  assert.equal(result.generatedProgress.inputCommit, progress.plan.inputHead);
  await f.git.verifyGeneratedProgress(result.generatedProgress);
  assert.deepEqual(result.leafPr.known.fields, known);
  unchanged(f, saved);
}));

test("stale saved full-content AFTER on MERGED freezes lifecycle rather than sending its draft target", async (t) => {
  for (const ready of [false, true]) await t.test(ready ? "previously ready" : "previously draft", async (t) => withFixture(t, {}, async (f) => {
    const intent = await pending(f, "full", "after", ready);
    const full = clone(latestFullAssessment(f.run()));
    assert.equal(intent.effect.after.isDraft, !ready);
    assert.equal(intent.target.isDraft, true);
    await landFixturePr(f);
    const saved = snapshot(f);
    await f.restart();
    await f.sync();
    assert.equal(f.run().prState, "merged", JSON.stringify(f.store.get().activity.slice(0, 5)));
    assert.equal(f.run().fullEvaluation, undefined);
    assert.equal(f.run().leafPr.pending, undefined);
    assert.deepEqual(f.run().leafPr.known.fields, intent.effect.after);
    assert.deepEqual(latestFullAssessment(f.run()), full);
    unchanged(f, saved);
    await f.restart();
    await f.sync();
    unchanged(f, saved);
  }));
});
