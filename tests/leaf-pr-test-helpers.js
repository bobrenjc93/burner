import assert from "node:assert/strict";

export const fixtureLeafRepository = { host: "example.test", id: "fixture-repository", nameWithOwner: "fixture/burner" };

// Arranged prior ownership for tests of other continuation owners. This is
// deliberately not a legacy-import test: that public boundary has separate
// pinned executed-writer tests and never accepts these fixture digests.
export function fixtureLeafPr(run, fields, { historical = false, repository = fixtureLeafRepository } = {}) {
  return {
    version: 1, repository: structuredClone(repository), branch: run.branch, baseBranch: "main",
    known: { number: run.prNumber, url: run.prUrl, fields: structuredClone(fields) },
    ...(historical ? { legacy: { protocol: "executed-leaf-writer-v1", proofDigest: "fixture-only",
      stateDigest: "fixture-only", runtimeDigest: "fixture-only", driverDigest: "fixture-only" } } : {}),
  };
}

// Replace only the GitHub transport boundary. All continuation/receipt,
// comparison, retry and semantic-ack code remains production code. Missing
// effects fail closed; real fixture Git graph helpers remain in place.
export function installLeafPrFixtureTransport(git, options) {
  const repository = options.repository ?? fixtureLeafRepository;
  const denied = (name) => async () => assert.fail(`Unexpected fixture leaf PR transport: ${name}`);
  git.leafRepository = async () => structuredClone(repository);
  const observe = async (cwd, number) => ({
    repository: structuredClone(repository), headRepository: structuredClone(repository), baseRepository: structuredClone(repository),
    baseRefName: "main", baseRefOid: await (options.base?.() ?? git.resolveRef("main")),
    ...await options.observe(cwd, number),
  });
  git.observeLeafPr = async (cwd, requestedRepository, number) => {
    assert.deepEqual(requestedRepository, repository);
    return observe(cwd, number);
  };
  git.findLeafPrs = options.search ? async (cwd, requestedRepository, branch) => {
    assert.deepEqual(requestedRepository, repository);
    const matches = await options.search(cwd, branch);
    return Promise.all(matches.map((pr) => observe(cwd, pr.number)));
  } : denied("search");
  git.createLeafPr = options.create ? async (input) => {
    assert.deepEqual(input.repository, repository);
    return options.create(input);
  } : denied("create");
  git.editLeafPrField = options.edit ? async (cwd, requestedRepository, number, field, value) => {
    assert.deepEqual(requestedRepository, repository);
    assert.ok(field === "title" || field === "body");
    return options.edit(cwd, number, field, value);
  } : denied("edit");
  git.setLeafPrDraft = options.draft ? async (cwd, requestedRepository, number, value) => {
    assert.deepEqual(requestedRepository, repository);
    return options.draft(cwd, number, value);
  } : denied("draft/ready");
  git.closeLeafPr = options.close ? async (cwd, requestedRepository, number) => {
    assert.deepEqual(requestedRepository, repository);
    return options.close(cwd, number);
  } : denied("close");
  git.mergeLeafPr = options.merge ? async (cwd, requestedRepository, number, head) => {
    assert.deepEqual(requestedRepository, repository);
    return options.merge(cwd, number, head);
  } : denied("merge");
  git.leafMergePolling = () => ({ mergeAttempts: 1, checkAttempts: 2, noCheckGraceAttempts: 0, intervalMs: 0 });
  if (options.prove) git.proveLeafInclusion = options.prove;
  git.proveLeafInclusion ??= denied("graph proof");
  if (options.fetch) git.fetchLeafSource = options.fetch;
  git.fetchLeafSource ??= denied("immutable source fetch");
}
