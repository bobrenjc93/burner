import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexClient } from "../dist/lib/codex.js";
import { EventHub } from "../dist/lib/events.js";
import { Orchestrator } from "../dist/lib/orchestrator.js";
import { runCommand } from "../dist/lib/process.js";
import { StateStore } from "../dist/lib/store.js";

const threadEvent = (threadId) => JSON.stringify({ type: "thread.started", thread_id: threadId });
const commandResult = (stdout = "", exitCode = 0) => ({ stdout, stderr: exitCode ? "credential expired" : "", exitCode });
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("author session IDs are checkpointed from fragmented stdout before Codex exits", async () => {
  const saved = deferred();
  const checkpoints = [];
  let commandFinished = false;
  const codex = new CodexClient(undefined, {
    onSessionStarted: async (cwd, threadId) => {
      assert.equal(commandFinished, false);
      checkpoints.push({ cwd, threadId });
      saved.resolve();
    },
  });
  codex.runCodex = async (_args, options) => {
    options.onStdout("wrapper diagnostic\nnull\n{}\n");
    options.onStdout(`${threadEvent(null)}\n${threadEvent(123)}\n${threadEvent(" ")}\n`);
    options.onStdout(`${JSON.stringify({ type: "item.completed", thread_id: "not-a-session" })}\n`);
    const event = threadEvent("author-live");
    options.onStdout(event.slice(0, 17));
    options.onStdout(`${event.slice(17)}\r\n${threadEvent("duplicate")}\n`);
    await saved.promise;
    assert.deepEqual(checkpoints, [{ cwd: "/candidate", threadId: "author-live" }]);
    commandFinished = true;
    return commandResult();
  };
  const session = await codex.unstructuredSession("/candidate", "Implement the change", "gpt-6-astra");
  assert.equal(session.threadId, "author-live");
  assert.equal(checkpoints.length, 1);
});

test("failed Codex commands wait for the durable checkpoint before returning", async () => {
  const started = deferred();
  const persisted = deferred();
  const codex = new CodexClient(undefined, {
    onSessionStarted: async () => { started.resolve(); await persisted.promise; },
  });
  codex.runCodex = async (_args, options) => {
    options.onStdout(`${threadEvent("interrupted-author")}\n`);
    return commandResult("", 1);
  };
  let settled = false;
  const result = codex.unstructuredSession("/candidate", "Continue", "gpt-6-astra");
  const rejected = assert.rejects(result.finally(() => { settled = true; }), /credential expired/);
  await started.promise;
  await nextTurn();
  assert.equal(settled, false);
  persisted.resolve();
  await rejected;
});

test("a thrown command or parent guard cannot race an emitted session checkpoint", async () => {
  const started = deferred();
  const persisted = deferred();
  const codex = new CodexClient(undefined, {
    onSessionStarted: async () => { started.resolve(); await persisted.promise; },
  });
  codex.runCodex = async (_args, options) => {
    options.onStdout(`${threadEvent("guarded-author")}\n`);
    throw new Error("parent worktree guard failed");
  };
  let settled = false;
  const result = codex.unstructuredSession("/candidate", "Continue", "gpt-6-astra");
  const rejected = assert.rejects(result.finally(() => { settled = true; }), /parent worktree guard failed/);
  await started.promise;
  await nextTurn();
  assert.equal(settled, false);
  persisted.resolve();
  await rejected;
});

test("buffered and unterminated thread events are retained even after a nonzero exit", async () => {
  for (const stream of [false, true]) {
    const checkpoints = [];
    const codex = new CodexClient(undefined, {
      onSessionStarted: async (_cwd, threadId) => { checkpoints.push(threadId); },
    });
    codex.runCodex = async (_args, options) => {
      const stdout = threadEvent("buffered-author");
      if (stream) options.onStdout(stdout);
      return commandResult(stdout, 1);
    };
    await assert.rejects(() => codex.unstructuredSession("/candidate", "Continue", "gpt-6-astra"), /credential expired/);
    assert.deepEqual(checkpoints, ["buffered-author"]);
  }
});

test("resumed implementations use the original thread and original task scope", async () => {
  const checkpoints = [];
  const codex = new CodexClient(undefined, {
    onSessionStarted: async (_cwd, threadId) => { checkpoints.push(threadId); },
  });
  codex.runCodex = async (args, options) => {
    assert.deepEqual(args.slice(0, 3), ["exec", "resume", "--json"]);
    assert.deepEqual(args.slice(-2), ["original-author", "-"]);
    assert.match(options.input, /Implement native CUDA scalar multiplication/);
    assert.match(options.input, /Do not forward to installed PyTorch/);
    return commandResult("Finished the original task");
  };
  const session = await codex.implement("/candidate", {
    title: "Implement native CUDA scalar multiplication",
    description: "Do not forward to installed PyTorch",
    rationale: "Broaden compilation",
    evaluationIds: [],
  }, [], { agentModel: "gpt-6-astra" }, "original-author");
  assert.deepEqual(session, { threadId: "original-author", message: "Finished the original task" });
  assert.deepEqual(checkpoints, ["original-author"]);
});

test("checkpoint persistence errors fail closed, including falsy rejection reasons", async () => {
  for (const reason of [new Error("disk full"), undefined, null, 0, ""]) {
    const codex = new CodexClient(undefined, { onSessionStarted: async () => { throw reason; } });
    codex.runCodex = async (_args, options) => {
      options.onStdout(`${threadEvent("unsaved-author")}\n`);
      return commandResult();
    };
    await assert.rejects(() => codex.unstructuredSession("/candidate", "Continue", "gpt-6-astra"), /Could not persist Codex author checkpoint/);
  }
});

test("successful commands without a resumable session ID still fail closed", async () => {
  const codex = new CodexClient();
  codex.runCodex = async () => commandResult("no session event");
  await assert.rejects(() => codex.unstructuredSession("/candidate", "Continue", "gpt-6-astra"), /did not return a resumable author thread id/);
});

test("runCommand streams stdout without losing the captured result or exit status", async () => {
  const chunks = [];
  const result = await runCommand(process.execPath, ["-e", "process.stdout.write('session ✓\\n'); process.exitCode = 7;"], {
    cwd: process.cwd(),
    onStdout: (chunk) => chunks.push(chunk),
  });
  assert.ok(chunks.length > 0);
  assert.equal(chunks.join(""), "session ✓\n");
  assert.equal(result.stdout, chunks.join(""));
  assert.equal(result.exitCode, 7);
});

async function retryFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "burner-session-checkpoint-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, "candidate");
  await mkdir(worktree);
  const store = new StateStore(root);
  await store.init();
  const timestamp = new Date().toISOString();
  const idea = {
    id: "idea", title: "Recover the original implementation", description: "Preserve its full scope", rationale: "Durability",
    predictedImpact: 0, evaluationIds: [], resources: ["cpu-heavy", "gpu"], status: "failed", source: "manual",
    createdAt: timestamp, updatedAt: timestamp,
  };
  await store.update((state) => {
    state.evaluations = [];
    state.ideas.push(idea);
    if (options.seedRun !== false) state.agentRuns.push({
      id: "agent", ideaId: idea.id, status: "failed", branch: "burner/original", worktree,
      startedAt: timestamp, completedAt: timestamp, deltas: [], resources: idea.resources, authorThreadId: "original-author",
      authoringComplete: Object.hasOwn(options, "authoringComplete") ? options.authoringComplete : false,
      baseRef: "main", baseCommit: "base", reviewRounds: [], prNumber: 7, prState: "open",
    });
  });
  const orchestrator = new Orchestrator(root, store, new EventHub());
  const calls = [];
  orchestrator.scheduleComposites = async () => undefined;
  orchestrator.assertCandidateDoesNotOwnProgress = async () => { calls.push("progress-guard"); };
  orchestrator.locks = {
    acquire: async () => ({ release: async () => undefined }),
    tryAcquireAll: async (resources) => {
      assert.deepEqual(resources, idea.resources);
      return { locks: [], release: async () => { calls.push("release"); } };
    },
  };
  orchestrator.git = {
    status: async () => ({ available: true, dirty: false }),
    resolveRef: async () => "base",
    createWorktree: async () => worktree,
    head: async () => "candidate",
    hasChanges: async () => true,
    commit: async (_cwd, message) => { calls.push(message); return "checkpoint"; },
  };
  orchestrator.reviewAndDeliverAgent = async (_idea, base, runId, cwd, branch, _settings, threadId, message) => {
    assert.equal(cwd, worktree);
    assert.equal(base.commit, "base");
    assert.equal(branch, "burner/original");
    calls.push({ review: { threadId, message } });
    await store.update((state) => {
      state.agentRuns.find((run) => run.id === runId).status = "completed";
      state.ideas.find((item) => item.id === idea.id).status = "completed";
    });
  };
  return { root, worktree, store, idea, orchestrator, calls };
}

test("session checkpoints persist to the unique agent or composite worktree", async (t) => {
  const { root, worktree, store, orchestrator } = await retryFixture(t);
  const compositeWorktree = join(root, "composite");
  await store.update((state) => {
    const timestamp = new Date().toISOString();
    state.composites.push({
      id: "composite", title: "Combined", status: "building", branch: "burner/combined", worktree: compositeWorktree,
      sources: [], deltas: [], reviewRounds: [], createdAt: timestamp, updatedAt: timestamp,
    });
  });
  await orchestrator.checkpointAuthorSession(worktree, "saved-agent");
  await orchestrator.checkpointAuthorSession(compositeWorktree, "saved-integrator");
  const persisted = JSON.parse(await readFile(store.statePath, "utf8"));
  assert.equal(persisted.agentRuns[0].authorThreadId, "saved-agent");
  assert.equal(persisted.agentRuns[0].authoringComplete, false);
  assert.equal(persisted.composites[0].authorThreadId, "saved-integrator");
  await assert.rejects(() => orchestrator.checkpointAuthorSession(join(root, "unknown"), "wrong"), /unique Burner worktree/);
  await store.update((state) => { state.composites[0].worktree = worktree; });
  await assert.rejects(() => orchestrator.checkpointAuthorSession(worktree, "ambiguous"), /unique Burner worktree/);
  assert.equal(store.get().agentRuns[0].authorThreadId, "saved-agent");
  assert.equal(store.get().composites[0].authorThreadId, "saved-integrator");
});

test("an interrupted initial author retains its session and incomplete phase across restart", async (t) => {
  const { root, worktree, store, idea, orchestrator, calls } = await retryFixture(t, { seedRun: false });
  orchestrator.codex.runCodex = async (_args, options) => {
    options.onStdout(`${threadEvent("initial-author")}\n`);
    return commandResult("", 1);
  };
  await orchestrator.runIdea(idea, { ref: "main", commit: "base", baseline: new Map() }, idea.resources, [], async () => { calls.push("release"); });
  assert.deepEqual(calls, ["release"]);
  const interrupted = store.get().agentRuns[0];
  assert.equal(interrupted.status, "failed");
  assert.equal(interrupted.authorThreadId, "initial-author");
  assert.equal(interrupted.authoringComplete, false);
  assert.equal(interrupted.worktree, worktree);
  assert.match(interrupted.error, /credential expired/);
  const restarted = new StateStore(root);
  await restarted.init();
  assert.equal(restarted.get().agentRuns[0].authorThreadId, "initial-author");
  assert.equal(restarted.get().agentRuns[0].authoringComplete, false);
});

test("retry completes interrupted authoring on the same candidate before review", async (t) => {
  const { worktree, store, idea, orchestrator, calls } = await retryFixture(t);
  orchestrator.codex.implement = async (cwd, originalIdea, evaluations, _settings, threadId) => {
    assert.equal(cwd, worktree);
    assert.equal(originalIdea.id, idea.id);
    assert.equal(originalIdea.description, idea.description);
    assert.deepEqual(evaluations, []);
    assert.equal(threadId, "original-author");
    assert.equal(store.get().agentRuns[0].status, "running");
    assert.equal(store.get().agentRuns[0].authoringComplete, false);
    calls.push("resume-author");
    return { threadId, message: "Finished original scope" };
  };
  const run = await orchestrator.retryAgent("agent");
  assert.equal(run.authoringComplete, true);
  assert.equal(run.prNumber, 7);
  assert.equal(run.branch, "burner/original");
  assert.equal(run.status, "completed");
  assert.deepEqual(calls, [
    "burner: preserve interrupted revision", "resume-author", "progress-guard", "burner: complete interrupted implementation",
    { review: { threadId: "original-author", message: "Finished original scope" } }, "release",
  ]);
  assert.equal(orchestrator.activeAgents.size, 0);
  assert.equal(orchestrator.retryingAgentIds.size, 0);
});

test("completed-author and legacy retries do not repeat the implementation phase", async (t) => {
  for (const authoringComplete of [true, undefined]) {
    const { orchestrator, calls } = await retryFixture(t, { authoringComplete });
    orchestrator.codex.implement = async () => { assert.fail("completed author must not be restarted"); };
    const run = await orchestrator.retryAgent("agent");
    assert.equal(run.status, "completed");
    assert.deepEqual(calls, ["burner: preserve interrupted revision", { review: { threadId: "original-author", message: "" } }, "release"]);
  }
});

test("another author interruption retains its checkpoint and releases the candidate slot", async (t) => {
  const { store, orchestrator, calls } = await retryFixture(t);
  orchestrator.codex.runCodex = async (_args, options) => {
    options.onStdout(`${threadEvent("resumed-author")}\n`);
    return commandResult("", 1);
  };
  const run = await orchestrator.retryAgent("agent");
  assert.equal(run.status, "failed");
  assert.equal(run.authoringComplete, false);
  assert.equal(run.authorThreadId, "resumed-author");
  assert.equal(run.prNumber, 7);
  assert.equal(store.get().agentRuns.length, 1);
  assert.deepEqual(calls, ["burner: preserve interrupted revision", "release"]);
  assert.equal(orchestrator.activeAgents.size, 0);
  assert.equal(orchestrator.retryingAgentIds.size, 0);
});
