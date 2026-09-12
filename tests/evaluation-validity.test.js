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

test("command evaluators can invalidate the measurement contract without accepting a numeric score", async () => {
  const client = new CodexClient();
  const payload = JSON.stringify({ ...result, baselineInvalid: true, summary: "Wrong compiler backend" });
  await assert.rejects(client.evaluate(".", { ...definition, command: `printf '%s\\n' '${payload}'` }, settings, "baseline"), /Evaluation baseline invalid: Wrong compiler backend/);
});
