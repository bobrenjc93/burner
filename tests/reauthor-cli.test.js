import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCommand } from "../dist/lib/process.js";
import { StateStore } from "../dist/lib/store.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const orchestratorUrl = new URL("../dist/lib/orchestrator.js", import.meta.url).href;
const input = { requestId: "operator-request", expectedContinuationId: "retained-source", expectedHead: "local-integration",
  expectedPublishedHead: "published-head", guidance: "Make a new implementation under the unchanged evaluator contract." };
const release = { requestId: input.requestId, continuationId: "author-output", head: "authored-head" };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "burner-reauthor-cli-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(root);
  await store.init();
  const source = { id: input.expectedContinuationId, step: "review", head: input.expectedHead, implementationCommit: input.expectedHead,
    evidence: "Unverified prior handoff", identity: { baseRef: "main", baseCommit: "base", branch: "burner/retained",
      evaluationFingerprint: "fixture", remote: "origin", baseBranch: "main", pullRequest: { number: 42, head: input.expectedPublishedHead } } };
  const run = { id: "agent", ideaId: "idea", status: "failed", branch: "burner/retained", worktree: root, startedAt: "2026-09-01T00:00:00.000Z",
    baseRef: "main", baseCommit: "base", prNumber: 42, prState: "open", authorThreadId: "author", reviewApproved: false, reviewRounds: [], resources: [], deltas: [],
    continuation: { ...source, id: release.continuationId, step: "evidence", head: release.head },
    reauthorRequests: [{ id: input.requestId, guidance: input.guidance, source, admittedAt: "2026-09-02T00:00:00.000Z",
      output: { continuationId: release.continuationId, head: release.head } }],
    lastMessage: "PRIVATE AUTHOR HANDOFF THAT A COMPACT RECEIPT MUST NOT PRINT" };
  await store.update((state) => {
    state.orchestrator.enabled = false;
    state.agentRuns = [run];
    state.ideas = [{ id: "idea", agentRunId: "agent", title: "Retained", description: "Original scope", rationale: "Test", predictedImpact: 1,
      evaluationIds: [], resources: [], status: "failed", source: "manual", createdAt: run.startedAt, updatedAt: run.startedAt }];
  });
  const requestFile = join(root, "request.json"), releaseFile = join(root, "release.json"), resultFile = join(root, "result.json");
  const log = join(root, "calls.jsonl"), guard = join(root, "guard.mjs");
  await writeFile(requestFile, JSON.stringify(input));
  await writeFile(releaseFile, JSON.stringify(release));
  await writeFile(resultFile, JSON.stringify(run));
  await writeFile(log, "");
  // Load the actual CLI in a child Node process. Only its lifecycle admission
  // methods are inert; real parsing, file reads, manual init, receipt and exits
  // remain intact. Any unexpected Git/GitHub/Codex process fails closed.
  await writeFile(guard, `
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Orchestrator, validateAgentReauthorInput, validateAgentRetryOptions } from ${JSON.stringify(orchestratorUrl)};
const record = (call) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(call) + "\\n");
childProcess.spawn = () => { throw new Error("Unexpected CLI subprocess"); };
syncBuiltinESMExports();
Orchestrator.prototype.init = async function (options) { assert.deepEqual(options, { manual: true }); record({ init: options }); };
Orchestrator.prototype.close = async function () { record({ close: true }); };
Orchestrator.prototype.reauthorAgent = async function (runId, input) {
  validateAgentReauthorInput(input);
  record({ reauthor: { runId, input } });
  return JSON.parse(readFileSync(${JSON.stringify(resultFile)}, "utf8"));
};
Orchestrator.prototype.retryAgent = async function (runId, options) {
  validateAgentRetryOptions(this.store.get().agentRuns[0], options);
  record({ retry: { runId, options } });
  return JSON.parse(readFileSync(${JSON.stringify(resultFile)}, "utf8"));
};
for (const method of ["tick", "scheduleComposites", "syncPullRequests", "runEvaluations", "runNextIdea"]) {
  Orchestrator.prototype[method] = async function () { throw new Error("Unexpected manual CLI scheduling: " + method); };
}
`);
  return { root, store, run, requestFile, releaseFile, resultFile,
    calls: async () => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    invoke: (args) => runCommand(process.execPath, ["--import", guard, cli, ...args, "-C", root], {
      cwd: root, env: { NODE_OPTIONS: "", GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 15_000,
    }),
  };
}

test("reauthor CLI uses manual initialization and reports a completed bounded output despite failed leaf status", async (t) => {
  const f = await fixture(t);
  const result = await f.invoke(["queue", "reauthor", "--run", "agent", "--request-file", f.requestFile]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { runId: "agent", requestId: input.requestId, status: "authored",
    output: { continuationId: release.continuationId, head: release.head }, leafStatus: "failed" });
  assert.doesNotMatch(result.stdout, /PRIVATE AUTHOR HANDOFF|reviewRounds|reauthorRequests/);
  assert.deepEqual(await f.calls(), [{ init: { manual: true } }, { reauthor: { runId: "agent", input } }, { close: true }]);
});

test("reauthor CLI reports an unfinished author honestly with pending receipt and nonzero exit", async (t) => {
  const f = await fixture(t);
  delete f.run.reauthorRequests[0].output;
  f.run.error = "Author response interrupted before its receipt was saved";
  await writeFile(f.resultFile, JSON.stringify(f.run));
  const result = await f.invoke(["queue", "reauthor", "--run", "agent", "--request-file", f.requestFile]);
  assert.equal(result.exitCode, 2, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { runId: "agent", requestId: input.requestId, status: "pending", leafStatus: "failed", error: f.run.error });
  assert.equal((await f.calls()).filter((call) => call.reauthor).length, 1);
});

test("reauthor CLI selects the requested historical receipt rather than a newer request output", async (t) => {
  const f = await fixture(t);
  f.run.reauthorRequests.push({ ...structuredClone(f.run.reauthorRequests[0]), id: "newer-request",
    output: { continuationId: "newer-output", head: "newer-head" } });
  await writeFile(f.resultFile, JSON.stringify(f.run));
  const result = await f.invoke(["queue", "reauthor", "--run", "agent", "--request-file", f.requestFile]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).output, { continuationId: release.continuationId, head: release.head });
});

test("reauthor CLI and release reject malformed file payloads without coercing their identities", async (t) => {
  for (const scenario of ["malformed-json", "nonobject", "missing-head", "numeric-id", "surrogate-id", "empty-guidance", "long-guidance", "release-numeric-head", "release-surrogate-head",
    "conflicting-repair-notes", "conflicting-retain-worktree", "conflicting-legacy-proof"]) await t.test(scenario, async (t) => {
    const f = await fixture(t);
    let payload = { ...input };
    if (scenario === "nonobject") payload = [];
    if (scenario === "missing-head") delete payload.expectedHead;
    if (scenario === "numeric-id") payload.requestId = 42;
    if (scenario === "surrogate-id") payload.requestId = "\ud800";
    if (scenario === "empty-guidance") payload.guidance = " ";
    if (scenario === "long-guidance") payload.guidance = "x".repeat(12_001);
    await writeFile(f.requestFile, scenario === "malformed-json" ? "{" : JSON.stringify(payload));
    if (scenario === "release-numeric-head") await writeFile(f.releaseFile, JSON.stringify({ ...release, head: 42 }));
    if (scenario === "release-surrogate-head") await writeFile(f.releaseFile, JSON.stringify({ ...release, head: "\ud800" }));
    const proofFile = join(f.root, "proof.json");
    if (scenario === "conflicting-legacy-proof") await writeFile(proofFile, JSON.stringify({ protocol: "executed-leaf-writer-v1", directory: f.root,
      startedSha256: "a".repeat(64), resultSha256: "b".repeat(64), stateSha256: "c".repeat(64) }));
    const result = await f.invoke(scenario.startsWith("release-") || scenario.startsWith("conflicting-")
      ? ["queue", "retry", "--run", "agent", "--continue-reauthor", f.releaseFile,
        ...(scenario === "conflicting-repair-notes" ? ["--repair-notes", "Conflicting replacement guidance"] : []),
        ...(scenario === "conflicting-retain-worktree" ? ["--retain-worktree"] : []),
        ...(scenario === "conflicting-legacy-proof" ? ["--legacy-pr-proof", proofFile] : [])]
      : ["queue", "reauthor", "--run", "agent", "--request-file", f.requestFile]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Burner failed/);
    if (scenario.startsWith("conflicting-")) assert.match(result.stderr, /continueReauthor cannot be combined/);
    assert.equal((await f.calls()).some((call) => call.reauthor || call.retry), false);
  });
});

test("reauthor CLI release forwards the exact acknowledged output through manual ordinary retry", async (t) => {
  const f = await fixture(t);
  const result = await f.invoke(["queue", "retry", "--run", "agent", "--continue-reauthor", f.releaseFile]);
  assert.equal(result.exitCode, 2, "a released but unfinished leaf is not reported as delivered");
  assert.deepEqual(await f.calls(), [{ init: { manual: true } }, { retry: { runId: "agent", options: { continueReauthor: release } } }, { close: true }]);
});
