// Git/model effect helpers for focused tests of the production leaf loop.
// Durable restart/fault tests live in evaluation-repair.test.js; the actual
// prepare/finalize contract is tested in leaf-continuation-git.test.js.
export function leafGitEffects(orchestrator, cwd, baseRef, baseCommit, branch) {
  const git = orchestrator.git;
  git.head ??= async () => "candidate";
  git.hasChanges ??= async () => false;
  const resolve = git.resolveRef;
  git.resolveRef = async (ref) => ref === branch ? git.head(cwd) : resolve ? resolve(ref) : baseCommit;
  git.assertWorktree ??= async () => undefined;
  git.tree ??= async (ref) => ref;
  let prepared = 0;
  git.prepareLeafCommit ??= async (_cwd, _branch, inputHead) => ({ inputHead, tree: await git.hasChanges(cwd) ? `prepared-${++prepared}` : inputHead });
  git.finalizeLeafCommit ??= async (_cwd, _branch, _receipt, message) => {
    if (await git.hasChanges(cwd)) await git.commit(cwd, message);
    return git.head(cwd);
  };
  void baseRef;
}

export function finishLeafDeliveryForTest(orchestrator, observe = () => {}) {
  orchestrator.deliverReviewedAgent = async (idea, base, run, claim) => {
    await observe(idea, base, run);
    await orchestrator.store.update((state) => orchestrator.finishLeafInState(state, run, claim, "completed"));
  };
}

export async function reviewLeaf(orchestrator, cwd, runId, title, baseRef, threadId, _settings, { deliver = false, baseline } = {}) {
  const store = orchestrator.store;
  const before = store.get().agentRuns.find((run) => run.id === runId);
  const baseCommit = before.baseCommit ?? "base";
  leafGitEffects(orchestrator, cwd, baseRef, baseCommit, before.branch);
  if (!Object.hasOwn(orchestrator, "assertCandidateDoesNotOwnProgress")) orchestrator.assertCandidateDoesNotOwnProgress = async () => undefined;
  orchestrator.codex.refreshAgentEvidence ??= async () => ({ threadId, message: "No measured artifacts" });
  await store.update((state) => {
    const run = state.agentRuns.find((item) => item.id === runId);
    // This helper admits a freshly constructed loop fixture. Record that
    // fixture's originating mode just as public runIdea admission does; restart
    // policy tests use the public entry points rather than this setup helper.
    Object.assign(run, { baseRef, baseCommit, authorThreadId: threadId, worktree: cwd, reviewApproved: false,
      leafQualificationPolicy: run.leafQualificationPolicy ?? (orchestrator.portfolioMode() ? "separate-full" : "ordinary") });
  });
  const head = await orchestrator.git.head(cwd);
  // Published loop fixtures must supply an explicit typed observation. Do
  // not infer a PR preimage from its branch or from desired local fields.
  const remote = before.prNumber === undefined ? undefined : await orchestrator.git.observeLeafPr(cwd, before.leafPr.repository, before.prNumber);
  await store.update((state) => {
    const run = state.agentRuns.find((item) => item.id === runId);
    run.continuation = { id: "focused-evidence", identity: orchestrator.continuationIdentity(run, state, remote), head, step: "evidence" };
  });
  const run = store.get().agentRuns.find((item) => item.id === runId);
  const idea = { ...store.get().ideas.find((item) => item.id === run.ideaId), id: run.ideaId, title };
  const base = { ref: baseRef, commit: baseCommit, baseline: baseline ?? store.latestRuns(), compositeId: run.parentCompositeId };
  if (!deliver) finishLeafDeliveryForTest(orchestrator);
  const claim = orchestrator.claimAgents([runId]);
  try { await orchestrator.continueLeaf(idea, base, runId, claim); }
  finally { claim.release(); }
  const result = store.get().agentRuns.find((item) => item.id === runId);
  return { threadId: result.authorThreadId, message: result.lastMessage ?? "" };
}
