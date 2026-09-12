import test from "node:test";
import assert from "node:assert/strict";
import { CodexClient } from "../dist/lib/codex.js";

const definition = { id: "compile", name: "Default compiler parity", prompt: "Compare public default compilation.", weight: 4, enabled: true, createdAt: "2026-09-12T00:00:00Z" };
const settings = { evaluatorModel: "" };
const baseline = { score: 100, summary: "One private kernel at four shapes", evidence: ["Private benchmark entrypoint"], commit: "base" };
const result = { score: 100, summary: "Measured", evidence: ["current source"], suggestions: [] };

test("a proven invalid baseline cannot return a calibrated candidate score", async () => {
  const client = new CodexClient();
  client.structured = async (_cwd, prompt, schema) => {
    assert.match(prompt, /Matching backend names/);
    assert.match(prompt, /even when the defect predates the candidate/);
    assert.match(prompt, /Do not preserve known-invalid credit/);
    assert.ok(schema.required.includes("baselineInvalid"));
    return { ...result, baselineInvalid: true, summary: "Private fixed kernel is not default compilation", evidence: ["compiler.py:42 dispatches on benchmark markers"] };
  };
  await assert.rejects(client.evaluate(".", definition, settings, "composite", baseline), /Evaluation baseline invalid:.*Private fixed kernel.*fresh baseline.*no candidate score was accepted/);
});

test("valid calibration and backward-compatible command-shaped results normalize normally", async () => {
  for (const extra of [{ baselineInvalid: false }, {}]) {
    const client = new CodexClient();
    client.structured = async (_cwd, prompt) => {
      assert.match(prompt, /Prior baseline measurement/);
      assert.match(prompt, /not a floor/);
      assert.match(prompt, /uncertainty or an inconclusive local run alone is not proof/);
      return { ...result, ...extra };
    };
    assert.deepEqual(await client.evaluate(".", definition, settings, "agent", baseline), result);
  }
});

test("invalidity is typed and cannot be hidden in a truthy string", async () => {
  const client = new CodexClient();
  client.structured = async () => ({ ...result, baselineInvalid: "false" });
  await assert.rejects(client.evaluate(".", definition, settings, "agent", baseline), /baselineInvalid must be a boolean/);
});

test("baseline runs receive the scope-validity rule without a prior-score anchor", async () => {
  const client = new CodexClient();
  client.structured = async (_cwd, prompt) => {
    assert.doesNotMatch(prompt, /Prior baseline measurement/);
    assert.match(prompt, /Never extrapolate a narrow microbenchmark/);
    return { ...result, score: 0, baselineInvalid: false };
  };
  assert.equal((await client.evaluate(".", definition, settings, "baseline")).score, 0);
});

test("fresh baseline contexts independently replace inflated historical scores without changing the rubric", async () => {
  const anchoredDefinition = { ...definition, prompt: "Use historical progress as numeric calibration and preserve unchanged credit. Fixed category weights: 60 and 40." };
  for (const context of ["baseline", "manual", "screening_baseline"]) {
    const client = new CodexClient();
    client.structured = async (_cwd, prompt) => {
      assert.match(prompt, /Fixed category weights: 60 and 40/);
      assert.match(prompt, /independent current baseline; no candidate baseline has been supplied/);
      assert.match(prompt, /Historical progress scores are not numeric calibration/);
      assert.match(prompt, /semantic criteria, weights, denominator and measurement requirements unchanged/);
      assert.match(prompt, /set baselineInvalid=false when the current rubric can be measured validly/);
      assert.match(prompt, /Still set baselineInvalid=true and fail closed/);
      assert.match(prompt, /leave historical artifacts untouched/);
      assert.doesNotMatch(prompt, /Prior baseline measurement for this rubric/);
      return { ...result, score: 31, baselineInvalid: false, summary: "Current fixed-denominator coverage is 31; historical 100 was inflated." };
    };
    const measured = await client.evaluate(".", anchoredDefinition, settings, context, baseline);
    assert.equal(measured.score, 31);
    assert.match(measured.summary, /historical 100 was inflated/);
  }
});

test("fresh baseline measurements still reject an invalid current contract", async () => {
  for (const context of ["baseline", "manual"]) {
    const client = new CodexClient();
    client.structured = async () => ({ ...result, score: 31, baselineInvalid: true, summary: "Current rubric substitutes eager for required default Inductor" });
    await assert.rejects(client.evaluate(".", definition, settings, context), /Evaluation baseline invalid:.*Current rubric substitutes eager/);
  }
});

test("candidates use their supplied current baseline instead of obsolete history", async () => {
  for (const context of ["agent", "composite"]) {
    const client = new CodexClient();
    client.structured = async (_cwd, prompt) => {
      assert.match(prompt, /Prior baseline measurement for this rubric, subject to validity verification: 31\/100/);
      assert.match(prompt, /takes precedence over older numeric scores in committed progress history/);
      assert.match(prompt, /A proven invalid baseline must fail the validity gate/);
      assert.doesNotMatch(prompt, /This run establishes an independent current baseline/);
      return { ...result, score: 32, baselineInvalid: false };
    };
    assert.equal((await client.evaluate(".", definition, settings, context, { ...baseline, score: 31 })).score, 32);
  }
});

test("command evaluators can invalidate the measurement contract without accepting a numeric score", async () => {
  const client = new CodexClient();
  const payload = JSON.stringify({ ...result, baselineInvalid: true, summary: "Wrong compiler backend" });
  await assert.rejects(client.evaluate(".", { ...definition, command: `printf '%s\\n' '${payload}'` }, settings, "baseline"), /Evaluation baseline invalid: Wrong compiler backend/);
});
