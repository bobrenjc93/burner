import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { createConnection } from "node:net";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LockManager } from "../dist/lib/locks.js";
import { CodexClient } from "../dist/lib/codex.js";
import { EventHub } from "../dist/lib/events.js";
import { agentReviewCadenceHeadroom, assertCompositeEvaluationRevisionChanged, cachedFullMergeValidationResult, compositeRevisionHeadroom, inferIdeaResources, Orchestrator, partitionReviewFallbacks, selectYoloLeafBatch, selectYoloMergeCandidate, shouldRefillIdeaQueue } from "../dist/lib/orchestrator.js";
import { updateProgressArtifacts } from "../dist/lib/progress.js";
import { runCommand } from "../dist/lib/process.js";
import { buildCompositeDraftPrBody, buildCompositePrBody, buildPrBody, GitService } from "../dist/lib/git.js";
import { createBurnerServer } from "../dist/server.js";
import { StateStore, validateEvaluation } from "../dist/lib/store.js";
import { clampScore, parseJsonObject, slugify, weightedScore } from "../dist/lib/utils.js";

const exec = (cwd, command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { cwd }, (error, stdout, stderr) => {
    if (error) reject(new Error(stderr || error.message));
    else resolve(stdout);
  });
});

test("CLI version matches the package version", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const output = await exec(process.cwd(), process.execPath, ["dist/cli.js", "--version"]);
  assert.equal(output.trim(), packageJson.version);
});

test("command timeouts terminate descendant processes and return exit code 124", async () => {
  const started = Date.now();
  const result = await runCommand("/bin/sh", ["-c", "sleep 30 & wait"], { cwd: process.cwd(), timeoutMs: 50 });
  assert.equal(result.exitCode, 124);
  assert.match(result.stderr, /Command timed out after 50ms/);
  assert.ok(Date.now() - started < 2_000, "timed-out descendants should not keep their inherited pipes open");
});

test("command aborts terminate descendant processes during Burner shutdown", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const running = runCommand("/bin/sh", ["-c", "sleep 30 & wait"], { cwd: process.cwd(), signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const result = await running;
  assert.equal(result.exitCode, 130);
  assert.match(result.stderr, /Command aborted during Burner shutdown/);
  assert.ok(Date.now() - started < 2_000, "aborted descendants should not survive Burner shutdown");
});

test("closing the orchestrator disables scheduling and aborts Codex work", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-close-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    await store.update((state) => { state.orchestrator.enabled = true; });
    const orchestrator = new Orchestrator(root, store, new EventHub());
    let closed = false;
    orchestrator.codex = { close: () => { closed = true; } };
    await orchestrator.close();
    assert.equal(store.get().orchestrator.enabled, false);
    assert.equal(closed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex external edits pause Burner without reverting the protected parent repository", async () => {
  const outer = await mkdtemp(join(tmpdir(), "burner-parent-boundary-test-"));
  const target = join(outer, "target");
  try {
    await exec(outer, "git", ["init", "-q"]);
    await exec(outer, "git", ["config", "user.email", "burner@example.test"]);
    await exec(outer, "git", ["config", "user.name", "Burner Test"]);
    await writeFile(join(outer, ".gitignore"), "target/\n");
    await writeFile(join(outer, "protected.txt"), "original\n");
    await exec(outer, "git", ["add", ".gitignore", "protected.txt"]);
    await exec(outer, "git", ["commit", "-qm", "seed"]);
    await import("node:fs/promises").then((fs) => fs.mkdir(target));
    const store = new StateStore(target);
    await store.init();
    await store.update((state) => { state.orchestrator.enabled = true; });
    const orchestrator = new Orchestrator(target, store, new EventHub());
    await orchestrator.initializeProtectedParentRepository();
    assert.ok(orchestrator.protectedParentRepository, `expected ${outer} to protect nested target ${target}; git discovered ${(await exec(outer, "git", ["rev-parse", "--show-toplevel"])).trim()}`);
    assert.equal(orchestrator.protectedParentRepository.root, await realpath(outer));
    await writeFile(join(outer, "protected.txt"), "changed externally\n");
    await assert.rejects(() => orchestrator.assertProtectedParentUnchanged(), /paused without reverting external files/);
    assert.equal(store.get().orchestrator.enabled, false);
    assert.equal(store.get().activity[0].message, "Codex crossed the target worktree boundary");
    assert.equal(await readFile(join(outer, "protected.txt"), "utf8"), "changed externally\n");
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

test("prompt evaluators fail early enough to leave targeted retry headroom", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-evaluator-timeout-test-"));
  const bin = join(root, "bin");
  await import("node:fs/promises").then((fs) => fs.mkdir(bin));
  const executable = join(bin, "codex");
  await writeFile(executable, `#!/usr/bin/env node\nconst args=process.argv.slice(2);if(args.includes("--help")){console.log("  --dangerously-bypass-approvals-and-sandbox  unrestricted");process.exit(0);}setTimeout(()=>{},30000);\n`);
  await chmod(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  try {
    const codex = new CodexClient(undefined, { promptEvaluationTimeoutMs: 50 });
    const evaluation = { id: "quality", name: "Quality", prompt: "Score quality", weight: 1, enabled: true, createdAt: new Date().toISOString() };
    const settings = { parallelism: 1, evaluationIntervalMinutes: 30, orchestratorIntervalMinutes: 15, autoRun: false, autoCreatePrs: true, evaluatorModel: "", agentModel: "", baseBranch: "main", remote: "origin", defaultResources: [], maxReviewRounds: 8, portfolioReviewRounds: 8, mergeCadenceMinutes: 60, preferLivingComposite: true, compositeAbsorbThreshold: 0 };
    const started = Date.now();
    await assert.rejects(() => codex.evaluate(root, evaluation, settings, "manual"), /Command timed out after 50ms/);
    assert.ok(Date.now() - started < 2_000, "a stuck evaluator must fail early enough for the suite's targeted retry");
  } finally {
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

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

test("merge progress artifacts deduplicate semantic baselines and PR retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-progress-test-"));
  try {
    await writeFile(join(root, "README.md"), "# Demo\n");
    const timestamp = "2026-01-01T00:00:00.000Z";
    const evaluations = [
      { id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp },
      { id: "speed", name: "Speed", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp },
    ];
    await updateProgressArtifacts(root, evaluations, [
      { key: "baseline:abc", commit: "abc", recordedAt: timestamp, label: "Baseline abc", kind: "baseline", title: "main", scores: { quality: 60, speed: 70 } },
      { key: "pr:12", recordedAt: "2026-01-02T00:00:00.000Z", label: "PR #12", kind: "composite", prNumber: 12, title: "Combined", scores: { quality: 75, speed: 80 } },
    ]);
    await updateProgressArtifacts(root, evaluations, [
      { key: "base:abc", commit: "abc", recordedAt: "2026-01-02T12:00:00.000Z", label: "base abc", kind: "baseline", title: "main", scores: { quality: 61, speed: 71 } },
      { key: "pr:12", recordedAt: "2026-01-03T00:00:00.000Z", label: "PR #12", kind: "composite", prNumber: 12, title: "Combined", scores: { quality: 76, speed: 81 } },
    ]);
    const readme = await readFile(join(root, "README.md"), "utf8");
    const history = JSON.parse(await readFile(join(root, "docs", "burner-evaluation-history.json"), "utf8"));
    const svg = await readFile(join(root, "docs", "burner-evaluation-progress.svg"), "utf8");
    assert.match(readme, /burner-progress:start/);
    assert.match(readme, /burner-evaluation-progress\.svg/);
    assert.equal(history.points.length, 2);
    assert.equal(history.points[0].key, "baseline:abc");
    assert.equal(history.points[0].recordedAt, timestamp);
    assert.equal(history.points[0].scores.quality, 61);
    assert.equal(history.points[1].recordedAt, "2026-01-02T00:00:00.000Z");
    assert.equal(history.points[1].scores.quality, 76);
    assert.match(svg, /Quality/);
    assert.match(svg, /PR #12/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("merge progress SVG preserves disabled gaps and late singleton scores", async () => {
  const gapRoot = await mkdtemp(join(tmpdir(), "burner-progress-gap-test-"));
  const singletonRoot = await mkdtemp(join(tmpdir(), "burner-progress-singleton-test-"));
  const timestamp = "2026-01-01T00:00:00.000Z";
  const quality = { id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp };
  const speed = { id: "speed", name: "Speed", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp };
  try {
    await writeFile(join(gapRoot, "README.md"), "# Demo\n");
    await updateProgressArtifacts(gapRoot, [quality, speed], [
      { key: "base:abc", commit: "abc", recordedAt: timestamp, label: "base abc", kind: "baseline", title: "main", scores: { quality: 60, speed: 70 } },
    ]);
    await updateProgressArtifacts(gapRoot, [{ ...quality, enabled: false }, speed], [
      { key: "pr:1", recordedAt: "2026-01-02T00:00:00.000Z", label: "PR #1", kind: "leaf", prNumber: 1, title: "Disabled", scores: { speed: 72 } },
    ]);
    await updateProgressArtifacts(gapRoot, [quality, speed], [
      { key: "pr:2", recordedAt: "2026-01-03T00:00:00.000Z", label: "PR #2", kind: "leaf", prNumber: 2, title: "Re-enabled", scores: { quality: 80, speed: 74 } },
    ]);
    const gapSvg = await readFile(join(gapRoot, "docs", "burner-evaluation-progress.svg"), "utf8");
    assert.doesNotMatch(gapSvg, /points="70\.0,164\.4 1168\.0,109\.2"/);
    assert.match(gapSvg, /points="70\.0,164\.4"[^>]+stroke="#ff6b35"/);
    assert.match(gapSvg, /points="1168\.0,109\.2"[^>]+stroke="#ff6b35"/);

    await writeFile(join(singletonRoot, "README.md"), "# Demo\n");
    const points = [
      { key: "base:abc", commit: "abc", recordedAt: timestamp, label: "base abc", kind: "baseline", title: "main", scores: { quality: 50 } },
      ...Array.from({ length: 60 }, (_value, index) => ({
        key: `pr:${index + 1}`,
        recordedAt: `2026-01-02T00:00:${String(index).padStart(2, "0")}.000Z`,
        label: `PR #${index + 1}`,
        kind: "leaf",
        prNumber: index + 1,
        title: "Existing evaluation",
        scores: { quality: 50 },
      })),
    ];
    await updateProgressArtifacts(singletonRoot, [quality], points);
    const late = { id: "late", name: "Late", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp };
    await updateProgressArtifacts(singletonRoot, [quality, late], [
      { key: "pr:61", recordedAt: "2026-01-03T00:00:00.000Z", label: "PR #61", kind: "leaf", prNumber: 61, title: "Late evaluation", scores: { quality: 55, late: 90 } },
    ]);
    const singletonSvg = await readFile(join(singletonRoot, "docs", "burner-evaluation-progress.svg"), "utf8");
    assert.match(singletonSvg, /<circle cx="1168\.0" cy="81\.6" r="3\.5" fill="#7c5cff"\/>/);
  } finally {
    await rm(gapRoot, { recursive: true, force: true });
    await rm(singletonRoot, { recursive: true, force: true });
  }
});

test("candidate work cannot replace Burner's merge-coupled progress ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-progress-boundary-test-"));
  try {
    await exec(root, "git", ["init", "-b", "main"]);
    const managedReadme = "# Demo\n\n<!-- burner-progress:start -->\n## Burner evaluation progress\n\n![Burner evaluation progress](docs/burner-evaluation-progress.svg)\n<!-- burner-progress:end -->\n";
    await writeFile(join(root, "README.md"), managedReadme);
    await exec(root, "git", ["add", "README.md"]);
    await exec(root, "git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "seed"]);
    const base = (await exec(root, "git", ["rev-parse", "HEAD"])).trim();
    const store = new StateStore(root);
    await store.init();
    const orchestrator = new Orchestrator(root, store, new EventHub());
    await import("node:fs/promises").then((fs) => fs.mkdir(join(root, "scripts")));
    await writeFile(join(root, "scripts", "evaluation_progress.py"), "duplicate\n");
    await assert.rejects(() => orchestrator.assertCandidateDoesNotOwnProgress(root, base), /Candidate attempted to own Burner's merge-coupled evaluation progress/);
    await rm(join(root, "scripts"), { recursive: true, force: true });
    const documentedReadme = managedReadme.replace("<!-- burner-progress:start -->", "## Catalog queries\n\nOrdinary candidate documentation.\n\n<!-- burner-progress:start -->");
    await writeFile(join(root, "README.md"), documentedReadme);
    await orchestrator.assertCandidateDoesNotOwnProgress(root, base);
    await writeFile(join(root, "README.md"), documentedReadme.replace("docs/burner-evaluation-progress.svg", "candidate-owned.svg"));
    await assert.rejects(() => orchestrator.assertCandidateDoesNotOwnProgress(root, base), /managed README section/);
    await writeFile(join(root, "README.md"), documentedReadme);
    await writeFile(join(root, "src.rs"), "ordinary candidate code\n");
    await orchestrator.assertCandidateDoesNotOwnProgress(root, base);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("benchmark-oriented ideas conservatively infer the shared CPU resource", () => {
  assert.deepEqual(inferIdeaResources({ title: "Emit benchmark evidence", description: "Prove results", rationale: "Integrity" }), ["cpu-heavy"]);
  assert.deepEqual(inferIdeaResources({ title: "Profile grouped queries", description: "Find hot paths", rationale: "Speed" }), ["cpu-heavy"]);
  assert.deepEqual(inferIdeaResources({ title: "Implement SQL NULL semantics", description: "Avoid special-casing benchmark queries", rationale: "Correctness" }), []);
  assert.deepEqual(inferIdeaResources({ title: "Improve SQL docs", description: "Add examples", rationale: "Clarity" }), []);
});

test("portfolio planning preserves the current generation until its queue and active work drain", () => {
  assert.equal(shouldRefillIdeaQueue(true, 1, 1, 0, 0), false, "an existing queued leaf must not be displaced by replanning");
  assert.equal(shouldRefillIdeaQueue(true, 0, 1, 1, 0), false, "an in-flight final leaf must finish before replenishment");
  assert.equal(shouldRefillIdeaQueue(true, 0, 1, 0, 1), false, "a composite generation must finish before replenishment");
  assert.equal(shouldRefillIdeaQueue(true, 0, 1, 0, 0), true, "an idle empty portfolio may refill");
  assert.equal(shouldRefillIdeaQueue(false, 1, 1, 1, 0), true, "non-portfolio mode retains its queue watermark behavior");
  assert.equal(shouldRefillIdeaQueue(false, 2, 1, 0, 0), false);
});

test("composite evaluation revisions reserve enough merge-cadence headroom", () => {
  const anchor = "2026-01-01T00:00:00.000Z";
  const started = Date.parse(anchor);
  assert.deepEqual(compositeRevisionHeadroom(anchor, 60, started + 49 * 60_000), { allowed: true, remainingMs: 11 * 60_000, reserveMs: 10 * 60_000 });
  assert.deepEqual(compositeRevisionHeadroom(anchor, 60, started + 51 * 60_000), { allowed: false, remainingMs: 9 * 60_000, reserveMs: 10 * 60_000 });
  assert.equal(compositeRevisionHeadroom(undefined, 60).allowed, true);
});

test("unchanged leaves reuse both accepted and rejected full merge validation", () => {
  const baseCommit = "base-commit";
  const candidateCommit = "candidate-commit";
  const evaluationFingerprint = "evaluation-fingerprint";
  const completedAt = "2026-01-01T00:00:00.000Z";
  assert.equal(cachedFullMergeValidationResult({
    fullMergeValidation: { baseCommit, candidateCommit, evaluationFingerprint, qualified: false, completedAt },
  }, baseCommit, candidateCommit, evaluationFingerprint), false, "a rejected unchanged leaf must not launch the full suite again");
  assert.equal(cachedFullMergeValidationResult({
    fullMergeValidation: { baseCommit, candidateCommit, evaluationFingerprint, qualified: true, completedAt },
  }, baseCommit, candidateCommit, evaluationFingerprint), true);
  assert.equal(cachedFullMergeValidationResult({
    fullMergeValidation: { baseCommit, candidateCommit, evaluationFingerprint, qualified: false, completedAt },
  }, "new-base", candidateCommit, evaluationFingerprint), undefined, "a new baseline requires fresh validation");
  assert.equal(cachedFullMergeValidationResult({
    fullMergeValidation: { baseCommit, candidateCommit, evaluationFingerprint, qualified: false, completedAt },
  }, baseCommit, "revised-candidate", evaluationFingerprint), undefined, "a revised leaf requires fresh validation");
  assert.equal(cachedFullMergeValidationResult({
    fullMergeValidation: { baseCommit, candidateCommit, evaluationFingerprint, qualified: false, completedAt },
  }, baseCommit, candidateCommit, "changed-evaluations"), undefined, "changed evaluation policy requires fresh validation");
});

test("cached leaf merge validation bypasses the full evaluation suite", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-leaf-validation-cache-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.evaluations = [];
      state.agentRuns = [{
        id: "leaf", ideaId: "idea", status: "completed", branch: "burner/leaf", worktree: "", startedAt: timestamp,
        prNumber: 1, prState: "open", baseCommit: "base", deltas: [], resources: [], reviewRounds: [],
        fullMergeValidation: { baseCommit: "base", candidateCommit: "candidate", evaluationFingerprint: JSON.stringify({ threshold: 0, evaluations: [] }), qualified: false, completedAt: timestamp },
      }];
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 3 });
    orchestrator.git = { resolveRef: async () => "candidate" };
    let evaluationSuites = 0;
    orchestrator.runCandidateEvaluations = async () => { evaluationSuites += 1; throw new Error("cache miss"); };
    assert.equal(await orchestrator.fullyValidateLeafForMerge("leaf", "base"), false);
    await store.update((state) => { state.agentRuns[0].fullMergeValidation.qualified = true; });
    assert.equal(await orchestrator.fullyValidateLeafForMerge("leaf", "base"), true);
    assert.equal(evaluationSuites, 0, "neither cached result should rerun all evaluations");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("composite evaluation revisions fail closed instead of resampling an unchanged tree", () => {
  assert.doesNotThrow(() => assertCompositeEvaluationRevisionChanged("before", "after", 1));
  assert.throws(
    () => assertCompositeEvaluationRevisionChanged("same", "same", 2),
    /will not resample an identical tree until prompt noise happens to pass/,
  );
});

test("YOLO yields a long review loop while an approved fallback can still use the merge reserve", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-review-cadence-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const currentTime = Date.now();
    const timestamp = new Date(currentTime).toISOString();
    const approvedRound = { id: "approved-review", round: 1, commit: "fallback-head", approved: true, summary: "Approved", findings: [], createdAt: timestamp, completedAt: timestamp };
    await store.update((state) => {
      state.settings.mergeCadenceMinutes = 60;
      state.orchestrator.mergeWindowStartedAt = new Date(currentTime - 41 * 60_000).toISOString();
      state.evaluations = [{ id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp }];
      state.agentRuns = [
        {
          id: "fallback", ideaId: "fallback-idea", status: "completed", branch: "burner/fallback", worktree: "", startedAt: timestamp, completedAt: timestamp,
          prNumber: 10, prUrl: "https://example.test/pull/10", prState: "open", baseCommit: "base", deltas: [{ evaluationId: "quality", name: "Quality", before: 80, after: 81, delta: 1 }],
          impact: 1, resources: [], reviewRounds: [approvedRound], reviewApproved: true,
        },
        {
          id: "current", ideaId: "current-idea", status: "reviewing", branch: "burner/current", worktree: root, startedAt: timestamp,
          baseCommit: "base", deltas: [], resources: [], reviewRounds: [], reviewApproved: false,
        },
      ];
    });

    assert.deepEqual(agentReviewCadenceHeadroom(store.get(), "base", "current", currentTime), {
      allowed: false,
      remainingMs: 19 * 60_000,
      requiredMs: 20 * 60_000,
    });

    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 3 });
    let reviewed = false;
    orchestrator.codex = { review: async () => { reviewed = true; throw new Error("review should not start"); } };
    await assert.rejects(
      () => orchestrator.reviewAgent(root, "current", "Current", "main", "thread", store.get().settings),
      /yielded its slot to preserve the merge cadence reserve/,
    );
    assert.equal(reviewed, false, "cadence yield must happen before another expensive review starts");

    await store.update((state) => {
      const fallback = state.agentRuns.find((run) => run.id === "fallback");
      fallback.deltas = [{ evaluationId: "quality", name: "Quality", before: 80, after: 79, delta: -1 }];
      fallback.impact = -1;
    });
    assert.deepEqual(agentReviewCadenceHeadroom(store.get(), "base", "current", currentTime), {
      allowed: true,
      remainingMs: 19 * 60_000,
      requiredMs: 0,
    }, "a reviewed but regressing fallback must not cause Burner to abandon the only other candidate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resuming the orchestrator does not force a redundant fresh baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-resume-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const orchestrator = new Orchestrator(root, store, new EventHub());
    const forced = [];
    orchestrator.tick = async (force) => { forced.push(force); };
    await orchestrator.setEnabled(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(forced, [false]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("structured output parser tolerates a fenced preamble", () => {
  assert.deepEqual(parseJsonObject("result follows\n{\"score\": 88}\nthanks"), { score: 88 });
  assert.equal(slugify("Polish the first-run UX!"), "polish-the-first-run-ux");
});

test("headless CLI configures evaluations, ideas, and conservative settings as JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-cli-test-"));
  const cli = join(process.cwd(), "dist", "cli.js");
  try {
    const help = await exec(root, "node", [cli, "--help"]);
    assert.match(help, /Codex agents?[\s\S]*unrestricted filesystem and command access/);
    assert.match(help, /--yolo\s+autonomously run and master-cook leaf PRs/);
    assert.match(help, /--yolo-batch-size <n>\s+leaf PRs per composite/);
    await assert.rejects(() => exec(root, "node", [cli, "--no-open", "--yolo-batch-size", "0"]), /integer between 1 and 100/);
    assert.deepEqual(JSON.parse(await exec(root, "node", [cli, "eval", "clear", "--yes", "-C", root])), { removed: 3 });
    const evaluation = JSON.parse(await exec(root, "node", [cli, "eval", "add", "-C", root, "--name", "Correctness", "--prompt", "Score correctness out of 100", "--command", "./full", "--screening-command", "./quick", "--weight", "2"]));
    assert.equal(evaluation.name, "Correctness");
    assert.equal(evaluation.screeningCommand, "./quick");
    const listed = JSON.parse(await exec(root, "node", [cli, "eval", "list", "-C", root]));
    assert.deepEqual(listed.map((item) => item.id), [evaluation.id]);
    const idea = JSON.parse(await exec(root, "node", [cli, "idea", "add", "-C", root, "--title", "Build core", "--description", "Implement the core", "--impact", "90", "--eval", evaluation.id, "--resource", "cpu"]));
    assert.equal(idea.predictedImpact, 90);
    assert.deepEqual(idea.evaluationIds, [evaluation.id]);
    assert.deepEqual(idea.resources, ["cpu"]);
    const settings = JSON.parse(await exec(root, "node", [cli, "settings", "set", "-C", root, "--parallelism", "1", "--max-review-rounds", "4", "--portfolio-review-rounds", "3", "--merge-cadence-minutes", "60", "--auto-create-prs", "true"]));
    assert.equal(settings.parallelism, 1);
    assert.equal(settings.maxReviewRounds, 4);
    assert.equal(settings.portfolioReviewRounds, 3);
    assert.equal(settings.mergeCadenceMinutes, 60);
    assert.equal(settings.autoCreatePrs, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("command evaluations return deterministic structured scores without Codex", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-command-eval-test-"));
  const evaluator = join(root, "evaluate");
  try {
    await writeFile(evaluator, `#!/bin/sh\nprintf '%s\\n' '{"score":42.25,"summary":"Measured locally","evidence":["same workload"],"suggestions":["go faster"]}'\n`);
    await chmod(evaluator, 0o755);
    const settings = { parallelism: 1, evaluationIntervalMinutes: 30, orchestratorIntervalMinutes: 15, autoRun: false, autoCreatePrs: true, evaluatorModel: "", agentModel: "", baseBranch: "main", remote: "origin", defaultResources: [], maxReviewRounds: 8, preferLivingComposite: true, compositeAbsorbThreshold: 0 };
    const output = await new CodexClient().evaluate(root, { id: "bench", name: "Benchmark", prompt: "Measure it", command: evaluator, weight: 1, enabled: true, createdAt: new Date().toISOString() }, settings, "manual");
    assert.equal(output.score, 42.3);
    assert.equal(output.summary, "Measured locally");
    assert.deepEqual(output.evidence, ["same workload"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("command evaluations reject fail-closed measurements instead of treating them as score zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-command-rejection-test-"));
  const evaluator = join(root, "evaluate");
  try {
    await writeFile(evaluator, `#!/bin/sh\nprintf '%s\\n' '{"score":0,"summary":"Benchmark rejected: no timing score was accepted.","evidence":["unstable timing: max/min spread exceeds the accepted limit"],"suggestions":[]}'\n`);
    await chmod(evaluator, 0o755);
    const settings = { parallelism: 1, evaluationIntervalMinutes: 30, orchestratorIntervalMinutes: 15, autoRun: false, autoCreatePrs: true, evaluatorModel: "", agentModel: "", baseBranch: "main", remote: "origin", defaultResources: [], maxReviewRounds: 12, portfolioReviewRounds: 12, mergeCadenceMinutes: 60, preferLivingComposite: true, compositeAbsorbThreshold: 0 };
    await assert.rejects(
      () => new CodexClient().evaluate(root, { id: "bench", name: "Benchmark", prompt: "Measure it", command: evaluator, weight: 1, enabled: true, createdAt: new Date().toISOString() }, settings, "manual"),
      /inconclusive measurement.*Benchmark rejected/s,
    );
    await writeFile(evaluator, `#!/bin/sh\nprintf '%s\\n' '{"score":0,"summary":"Benchmark rejected: no timing score was accepted.","evidence":["typed correctness mismatch for unsupported SELECT"],"suggestions":[]}'\n`);
    assert.equal((await new CodexClient().evaluate(root, { id: "bench", name: "Benchmark", prompt: "Measure it", command: evaluator, weight: 1, enabled: true, createdAt: new Date().toISOString() }, settings, "manual")).score, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portfolio leaf screens are comparable and composites retain the full command", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-screening-eval-test-"));
  const full = join(root, "full");
  const screen = join(root, "screen");
  try {
    await writeFile(full, `#!/bin/sh\nprintf '%s\\n' '{"score":90,"summary":"216 full cases","evidence":[],"suggestions":[]}'\n`);
    await writeFile(screen, `#!/bin/sh\nprintf '%s\\n' '{"score":80,"summary":"48 screening cases","evidence":[],"suggestions":[]}'\n`);
    await Promise.all([chmod(full, 0o755), chmod(screen, 0o755)]);
    const settings = { parallelism: 1, evaluationIntervalMinutes: 30, orchestratorIntervalMinutes: 15, autoRun: false, autoCreatePrs: true, evaluatorModel: "", agentModel: "", baseBranch: "main", remote: "origin", defaultResources: [], maxReviewRounds: 8, preferLivingComposite: true, compositeAbsorbThreshold: 0 };
    const evaluation = { id: "bench", name: "Benchmark", prompt: "Measure it", command: full, screeningCommand: screen, weight: 1, enabled: true, createdAt: new Date().toISOString() };
    const codex = new CodexClient();
    assert.equal((await codex.evaluate(root, evaluation, settings, "screening_baseline")).score, 80);
    assert.equal((await codex.evaluate(root, evaluation, settings, "agent")).score, 80);
    assert.equal((await codex.evaluate(root, evaluation, settings, "composite")).score, 90);
    assert.equal((await codex.evaluate(root, evaluation, settings, "baseline")).score, 90);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portfolio merge clock starts after full and screening baselines", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-screening-clock-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    await store.update((state) => {
      state.evaluations = [{ id: "bench", name: "Benchmark", prompt: "Measure", command: "full", screeningCommand: "quick", weight: 1, enabled: true, createdAt: new Date().toISOString() }];
      state.orchestrator.mergeWindowStartedAt = undefined;
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 10 });
    orchestrator.git = { resolveRef: async () => "base" };
    const contexts = [];
    orchestrator.runEvaluations = async (context) => {
      contexts.push(context);
      const run = { id: `run-${context}`, evaluationId: "bench", score: 80, commit: "base", createdAt: new Date().toISOString(), durationMs: 1, status: "completed", context };
      await store.update((state) => state.evaluationRuns.push(run));
      return [run];
    };
    await orchestrator.runBaselineEvaluations("baseline");
    assert.deepEqual(contexts, ["baseline", "screening_baseline"]);
    assert.ok(store.get().orchestrator.lastEvaluationAt);
    assert.ok(store.get().orchestrator.mergeWindowStartedAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("baseline recovery reruns only evaluations missing at the current commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-partial-baseline-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.evaluations = [
        { id: "done", name: "Done", prompt: "Measure", weight: 1, enabled: true, createdAt: timestamp },
        { id: "missing", name: "Missing", prompt: "Measure", screeningCommand: "quick", weight: 1, enabled: true, createdAt: timestamp },
      ];
      state.evaluationRuns.push({ id: "done-run", evaluationId: "done", score: 95, commit: "base", createdAt: timestamp, durationMs: 1, status: "completed", context: "baseline" });
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 10 });
    orchestrator.git = { resolveRef: async () => "base" };
    const calls = [];
    orchestrator.runEvaluations = async (context, _cwd, _agentRunId, _compositeId, evaluationIds) => {
      calls.push({ context, evaluationIds });
      const run = { id: `run-${context}`, evaluationId: "missing", score: 92, commit: "base", createdAt: new Date().toISOString(), durationMs: 1, status: "completed", context };
      await store.update((state) => state.evaluationRuns.push(run));
      return [run];
    };
    await orchestrator.runBaselineEvaluations("baseline");
    assert.deepEqual(calls, [
      { context: "baseline", evaluationIds: ["missing"] },
      { context: "screening_baseline", evaluationIds: ["missing"] },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("incomplete baselines block planning and agent dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-baseline-dispatch-barrier-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.git = { resolveRef: async () => "base" };
    orchestrator.syncPullRequests = async () => undefined;
    orchestrator.runBaselineEvaluations = async () => [];
    let plans = 0;
    let schedules = 0;
    orchestrator.plan = async () => { plans += 1; return []; };
    orchestrator.schedule = async () => { schedules += 1; };
    orchestrator.scheduleComposites = async () => { schedules += 1; };
    await orchestrator.tick(true);
    assert.equal(plans, 0);
    assert.equal(schedules, 0);
    assert.equal(store.get().agentRuns.length, 0);
    assert.match(store.get().activity[0].message, /baseline incomplete/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resource locks are exclusive and recover after release", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-lock-test-"));
  try {
    const locks = new LockManager(root);
    const first = await locks.tryAcquire("gpu", "agent-one");
    assert.ok(first);
    assert.equal(await locks.tryAcquire("gpu", "agent-two"), undefined);
    assert.deepEqual(await locks.list(), ["gpu"]);
    let waiterSettled = false;
    const waiting = locks.acquire("gpu", "agent-two", { timeoutMs: 1_000, pollMs: 10 }).then((lock) => { waiterSettled = true; return lock; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(waiterSettled, false);
    await first.release();
    const second = await waiting;
    assert.ok(second);
    await second.release();
    await writeFile(join(root, "orphan.lock"), JSON.stringify({ pid: 2_147_483_647, createdAt: new Date().toISOString() }));
    assert.deepEqual(await locks.reapOrphans(), ["orphan"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart recovery makes every interrupted agent phase resumable", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-agent-recovery-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const interrupted = ["starting", "running", "reviewing", "revising", "evaluating", "opening_pr"];
    await store.update((state) => {
      state.agentRuns = interrupted.map((status, index) => ({
        id: `agent-${index}`,
        ideaId: `idea-${index}`,
        status,
        branch: `branch-${index}`,
        worktree: root,
        startedAt: timestamp,
        deltas: [],
        resources: [],
        reviewRounds: [],
      }));
      state.ideas = interrupted.map((_status, index) => ({
        id: `idea-${index}`,
        title: `Idea ${index}`,
        description: "Recover me",
        rationale: "Test",
        predictedImpact: 1,
        evaluationIds: [],
        resources: [],
        status: "running",
        source: "manual",
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
    });
    const recovered = new StateStore(root);
    await recovered.init();
    assert.deepEqual(recovered.get().agentRuns.map((run) => run.status), interrupted.map(() => "failed"));
    assert.ok(recovered.get().agentRuns.every((run) => run.error === "Burner stopped before this run completed."));
    assert.ok(recovered.get().ideas.every((idea) => idea.status === "failed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent retries cannot exceed configured parallelism", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-retry-capacity-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.activeAgents.add("busy");
    await assert.rejects(() => orchestrator.retryAgent("missing"), /All configured agent slots are currently in use/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent retry preserves review history and applies unresolved feedback before reviewing again", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-retry-feedback-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.evaluations = [];
      state.ideas.push({ id: "idea", title: "Durability", description: "Fix storage", rationale: "Safety", predictedImpact: 80, evaluationIds: [], resources: [], status: "failed", source: "manual", createdAt: timestamp, updatedAt: timestamp });
      state.agentRuns.push({
        id: "agent", ideaId: "idea", status: "failed", branch: "burner/durability", worktree: root,
        startedAt: timestamp, completedAt: timestamp, deltas: [], resources: [], authorThreadId: "thread-1",
        baseRef: "main", baseCommit: "base", reviewRounds: [{ id: "review-5", round: 5, commit: "candidate", approved: false, summary: "Still unsafe", findings: [{ severity: "high", title: "Data loss", detail: "Fix fsync", file: "storage.rs" }], createdAt: timestamp }],
      });
    });
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.assertCandidateDoesNotOwnProgress = async () => undefined;
    orchestrator.git = {
      resolveRef: async () => "base",
      head: async () => "candidate",
      hasChanges: (() => { let calls = 0; return async () => ++calls > 1; })(),
      commit: async () => "fixed",
    };
    let revised;
    orchestrator.codex = { revise: async (_cwd, threadId, review) => { revised = { threadId, review }; return { threadId: "thread-2", message: "Fixed fsync" }; } };
    let delivered;
    orchestrator.reviewAndDeliverAgent = async (_idea, _base, runId, _worktree, _branch, _settings, threadId, message) => {
      delivered = { threadId, message };
      await store.update((state) => { const run = state.agentRuns.find((item) => item.id === runId); if (run) run.status = "completed"; });
    };
    await orchestrator.retryAgent("agent");
    const run = store.get().agentRuns.find((item) => item.id === "agent");
    assert.equal(revised.threadId, "thread-1");
    assert.equal(revised.review.findings[0].title, "Data loss");
    assert.deepEqual(delivered, { threadId: "thread-2", message: "Fixed fsync" });
    assert.equal(run.reviewRounds.length, 1);
    assert.equal(run.reviewRounds[0].authorResponse, "Fixed fsync");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compiled server closes connected event streams and stalled HTTP clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-server-test-"));
  const burner = await createBurnerServer({ root, host: "127.0.0.1", port: 0 });
  try {
    const address = burner.server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.deepEqual(health, { ok: true, project: root.split("/").at(-1) });
    const dashboard = await (await fetch(`${base}/api/dashboard`)).json();
    assert.equal(dashboard.runtime.yolo, false);

    const created = await fetch(`${base}/api/evaluations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Docs", prompt: "Score the docs", weight: 2, enabled: true }),
    });
    assert.equal(created.status, 201);
    const invalidComposite = await fetch(`${base}/api/composites`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentRunIds: [] }) });
    assert.equal(invalidComposite.status, 400);
    const missingRetry = await fetch(`${base}/api/agents/missing/retry`, { method: "POST" });
    assert.equal(missingRetry.status, 404);

    await new Promise((resolve, reject) => {
      const request = get(`${base}/api/events`, (response) => {
        response.once("data", resolve);
        response.on("error", reject);
      });
      request.on("error", reject);
    });
    const stalled = createConnection({ host: "127.0.0.1", port: address.port });
    await new Promise((resolve, reject) => {
      stalled.once("connect", resolve);
      stalled.once("error", reject);
    });
    stalled.write("GET /api/health HTTP/1.1\r\nHost: localhost\r\n");
    const stalledClosed = new Promise((resolve) => stalled.once("close", resolve));
    await Promise.race([
      Promise.all([burner.close(), stalledClosed]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Server shutdown timed out with connected clients")), 1_500)),
    ]);
  } finally {
    if (burner.server.listening) await burner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("git service assembles source branches into an actual composite worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-composite-test-"));
  try {
    await exec(root, "git", ["init", "-b", "main"]);
    await writeFile(join(root, "base.txt"), "base\n");
    await exec(root, "git", ["add", "."]);
    await exec(root, "git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "base"]);
    await exec(root, "git", ["switch", "-c", "feature-a"]);
    await writeFile(join(root, "a.txt"), "a\n");
    await exec(root, "git", ["add", "."]);
    await exec(root, "git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "a"]);
    await exec(root, "git", ["switch", "main"]);
    await exec(root, "git", ["switch", "-c", "feature-b"]);
    await writeFile(join(root, "b.txt"), "b\n");
    await exec(root, "git", ["add", "."]);
    await exec(root, "git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "b"]);
    await exec(root, "git", ["switch", "main"]);
    const git = new GitService(root, join(root, ".burner"));
    const worktree = await git.createWorktree("composite", "burner/composite-test", "main");
    assert.equal((await git.mergeBranch(worktree, "feature-a")).merged, true);
    assert.equal((await git.mergeBranch(worktree, "feature-b")).merged, true);
    assert.equal(await git.hasRef("burner/composite-test"), true);
    assert.equal(await import("node:fs/promises").then((fs) => fs.readFile(join(worktree, "a.txt"), "utf8")), "a\n");
    assert.equal(await import("node:fs/promises").then((fs) => fs.readFile(join(worktree, "b.txt"), "utf8")), "b\n");
    await git.removeWorktree(worktree);
    const experiment = await git.createWorktree("experiment", "burner/experiment-test", "burner/composite-test");
    await writeFile(join(experiment, "experiment.txt"), "win\n");
    await git.commit(experiment, "experiment");
    await git.removeWorktree(experiment);
    const evolving = await git.createExistingWorktree("evolving", "burner/composite-test");
    assert.equal((await git.mergeBranch(evolving, "burner/experiment-test")).merged, true);
    assert.equal(await import("node:fs/promises").then((fs) => fs.readFile(join(evolving, "experiment.txt"), "utf8")), "win\n");
    await git.removeWorktree(evolving);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub PR disposition labels are mutually exclusive and initialized once", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-label-test-"));
  const bin = join(root, "bin");
  const argsLog = join(root, "gh-args.jsonl");
  await import("node:fs/promises").then((fs) => fs.mkdir(bin));
  const executable = join(bin, "gh");
  await writeFile(executable, `#!/usr/bin/env node\nconst fs=require("fs");fs.appendFileSync(process.env.BURNER_TEST_GH_ARGS,JSON.stringify(process.argv.slice(2))+"\\n");\n`);
  await chmod(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.BURNER_TEST_GH_ARGS = argsLog;
  try {
    const git = new GitService(root, join(root, ".burner"));
    await git.openPr({ cwd: root, base: "main", branch: "composite", title: "Composite", body: "Draft", draft: true });
    await git.markPrReady(root, 42);
    await git.markPrDraft(root, 42);
    await git.markPrDisposition(root, 42, "unmerged");
    await git.markPrDisposition(root, 42, "merged");
    const calls = (await readFile(argsLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(calls.some((args) => args[0] === "pr" && args[1] === "create" && args.includes("--draft")));
    assert.ok(calls.some((args) => args[0] === "pr" && args[1] === "ready"));
    assert.ok(calls.some((args) => args[0] === "pr" && args[1] === "ready" && args.includes("--undo")));
    assert.equal(calls.filter((args) => args[0] === "label" && args[1] === "create").length, 3);
    assert.deepEqual(calls.at(-2), ["pr", "edit", "42", "--add-label", "burner-unmerged", "--remove-label", "burner-merged"]);
    assert.deepEqual(calls.at(-1), ["pr", "edit", "42", "--add-label", "burner-merged", "--remove-label", "burner-unmerged", "--remove-label", "burner-quarantined"]);
  } finally {
    process.env.PATH = previousPath;
    delete process.env.BURNER_TEST_GH_ARGS;
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub merge waits for the pushed head and retries transient not-mergeable responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-mergeability-test-"));
  const bin = join(root, "bin");
  const statePath = join(root, "gh-state.json");
  await import("node:fs/promises").then((fs) => fs.mkdir(bin));
  await exec(root, "git", ["init", "-b", "main"]);
  await writeFile(join(root, "README.md"), "# Test\n");
  await exec(root, "git", ["add", "."]);
  await exec(root, "git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "base"]);
  const head = "0123456789abcdef0123456789abcdef01234567";
  const executable = join(bin, "gh");
  await writeFile(executable, `#!/usr/bin/env node
const fs=require("fs");const args=process.argv.slice(2);const path=process.env.BURNER_TEST_GH_STATE;const state=fs.existsSync(path)?JSON.parse(fs.readFileSync(path,"utf8")):{views:0,checkViews:0,merges:0};
if(args[0]==="pr"&&args[1]==="view"&&args.includes("state,headRefOid,statusCheckRollup")){state.checkViews++;fs.writeFileSync(path,JSON.stringify(state));const pending=state.checkViews===1;const failed=process.env.BURNER_TEST_CHECK_FAIL==="1";const checks=process.env.BURNER_TEST_NO_CHECKS==="1"?[]:[{__typename:"CheckRun",name:"CI",status:pending?"IN_PROGRESS":"COMPLETED",conclusion:pending?null:failed?"FAILURE":"SUCCESS"}];console.log(JSON.stringify({state:"OPEN",headRefOid:process.env.BURNER_TEST_HEAD,statusCheckRollup:checks}));process.exit(0);}
if(args[0]==="pr"&&args[1]==="view"){state.views++;fs.writeFileSync(path,JSON.stringify(state));const mergeable=process.env.BURNER_TEST_CONFLICT==="1"?"CONFLICTING":state.views===1?"UNKNOWN":"MERGEABLE";console.log(JSON.stringify({state:"OPEN",mergeable,headRefOid:process.env.BURNER_TEST_HEAD}));process.exit(0);}
if(args[0]==="pr"&&args[1]==="merge"){state.merges++;fs.writeFileSync(path,JSON.stringify(state));if(state.merges===1){console.error("GraphQL: Pull Request is not mergeable (mergePullRequest)");process.exit(1);}process.exit(0);}
process.exit(0);
`);
  await chmod(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.BURNER_TEST_GH_STATE = statePath;
  process.env.BURNER_TEST_HEAD = head;
  try {
    const git = new GitService(root, join(root, ".burner"), { attempts: 4, intervalMs: 0, mergeAttempts: 2, checkAttempts: 4, noCheckGraceAttempts: 2 });
    await git.mergePr(root, 42, head);
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), { views: 3, checkViews: 3, merges: 2 });
    process.env.BURNER_TEST_CONFLICT = "1";
    await assert.rejects(() => git.mergePr(root, 43, head), /conflicts with its base branch/);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).merges, 2, "a real conflict must not call merge");
    process.env.BURNER_TEST_CONFLICT = "0";
    process.env.BURNER_TEST_CHECK_FAIL = "1";
    await assert.rejects(() => git.mergePr(root, 44, head), /required check failed.*Burner will not merge a failing head/);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).merges, 2, "a failed check must not call merge");
    process.env.BURNER_TEST_CHECK_FAIL = "0";
    process.env.BURNER_TEST_NO_CHECKS = "1";
    await git.mergePr(root, 45, head);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).merges, 3, "a repository with no checks may merge after the grace period");
  } finally {
    process.env.PATH = previousPath;
    delete process.env.BURNER_TEST_GH_STATE;
    delete process.env.BURNER_TEST_HEAD;
    delete process.env.BURNER_TEST_CONFLICT;
    delete process.env.BURNER_TEST_CHECK_FAIL;
    delete process.env.BURNER_TEST_NO_CHECKS;
    await rm(root, { recursive: true, force: true });
  }
});

test("leaf and composite merges poll the exact post-stamp candidate head", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-merge-head-plumbing-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.composites.push({
        id: "composite", title: "Combined", description: "Combined work", status: "open", branch: "burner/composite", worktree: "",
        sources: [], deltas: [], reviewRounds: [], reviewApproved: true, prNumber: 42, prUrl: "https://example.test/pull/42",
        createdAt: timestamp, updatedAt: timestamp, isLiving: true,
      });
      state.agentRuns.push({
        id: "leaf", ideaId: "idea", status: "completed", branch: "burner/leaf", worktree: "", startedAt: timestamp, completedAt: timestamp,
        prNumber: 43, prUrl: "https://example.test/pull/43", prState: "open", deltas: [], resources: [], reviewRounds: [], reviewApproved: true,
      });
    });
    const orchestrator = new Orchestrator(root, store, new EventHub());
    const merged = [];
    orchestrator.stampProgressBeforeMerge = async (kind) => `${kind}-post-stamp-head`;
    orchestrator.git = { mergePr: async (...args) => merged.push(args) };
    orchestrator.syncPullRequests = async () => undefined;
    await orchestrator.mergeComposite("composite");
    await orchestrator.mergeAgent("leaf");
    assert.deepEqual(merged, [
      [root, 42, "composite-post-stamp-head"],
      [root, 43, "agent-post-stamp-head"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PR bodies record review approval and recalculated composite scores", () => {
  const rounds = [{ id: "r1", round: 1, commit: "abc", approved: true, summary: "Approved", findings: [], createdAt: new Date().toISOString() }];
  const deltas = [{ evaluationId: "quality", name: "Quality", before: 70, after: 82, delta: 12 }];
  assert.match(buildPrBody("Change", "Done", deltas, 12, rounds), /Approved by an independent Codex reviewer/);
  const screened = buildPrBody("Change", "Done", [{ ...deltas[0], screening: true }], 12, rounds);
  assert.match(screened, /Quality \(leaf screen\)/);
  assert.match(screened, /Composite PRs rerun each full command/);
  const body = buildCompositePrBody({ description: "Combined", sources: [{ agentRunId: "a", prNumber: 12, title: "A", branch: "a" }, { agentRunId: "b", prNumber: 13, title: "B", branch: "b" }], deltas, compositeScore: 82, impact: 12, reviewRounds: rounds });
  assert.match(body, /Composite score: 82\.0 \/ 100/);
  assert.match(body, /#12/);
  assert.match(body, /never inferred by adding individual deltas/);
  const draft = buildCompositeDraftPrBody({ description: "Combined", sources: [{ agentRunId: "a", prNumber: 12, title: "A", branch: "a" }, { agentRunId: "b", prNumber: 13, title: "B", branch: "b" }], phase: "awaiting review" });
  assert.match(draft, /Master cook · draft/);
  assert.match(draft, /not mergeable until independent review and combined-code evaluation finish/);
});

test("YOLO merge selection prefers reviewed composites and rejects every evaluation regression", () => {
  const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: new Date().toISOString() };
  const deltas = [
    { evaluationId: "quality", name: "Quality", before: 70, after: 72, delta: 2 },
    { evaluationId: "speed", name: "Speed", before: 80, after: 80, delta: 0 },
  ];
  const state = {
    settings: { compositeAbsorbThreshold: 0 },
    evaluations: [{ id: "quality", enabled: true }, { id: "speed", enabled: true, command: "./benchmark" }],
    composites: [{ id: "composite", status: "open", prNumber: 20, baseCommit: "base", reviewApproved: true, reviewRounds: [approvedRound], deltas, impact: 1, sources: [{ agentRunId: "agent", kind: "pull_request" }] }],
    agentRuns: [{ id: "agent", status: "completed", prState: "open", prNumber: 10, baseCommit: "base", reviewApproved: true, reviewRounds: [approvedRound], deltas, impact: 5 }],
  };
  assert.deepEqual(selectYoloMergeCandidate(state, "base"), { kind: "composite", id: "composite", prNumber: 20, impact: 1 });
  state.composites[0].status = "closed";
  assert.equal(selectYoloMergeCandidate(state, "base", false), undefined);
  assert.deepEqual(selectYoloMergeCandidate(state, "base"), { kind: "agent", id: "agent", prNumber: 10, impact: 5 });
  assert.equal(selectYoloMergeCandidate(state, "new-base"), undefined);
  state.agentRuns[0].deltas = [{ ...deltas[0], delta: -0.1 }, deltas[1]];
  assert.equal(selectYoloMergeCandidate(state, "base"), undefined);
  state.agentRuns[0].deltas = [deltas[0], { ...deltas[1], delta: -0.1 }];
  assert.equal(selectYoloMergeCandidate(state, "base"), undefined);
  state.agentRuns[0].deltas = [deltas[0]];
  assert.equal(selectYoloMergeCandidate(state, "base"), undefined);
});

test("YOLO portfolio waits for a full leaf batch, ranks impact, and reserves composite sources", () => {
  const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: new Date().toISOString() };
  const deltas = [{ evaluationId: "speed", name: "Speed", before: 80, after: 81, delta: 1 }];
  const leaf = (id, impact) => ({ id, status: "completed", prState: "open", prNumber: Number(id.slice(1)), baseCommit: "base", reviewApproved: true, reviewRounds: [approvedRound], deltas, impact });
  const state = {
    settings: { compositeAbsorbThreshold: 0 },
    evaluations: [{ id: "speed", enabled: true, command: "./benchmark" }],
    composites: [],
    agentRuns: [leaf("a1", 1), leaf("a2", 8), leaf("a3", 5)],
  };
  assert.deepEqual(selectYoloLeafBatch(state, "base", 4), []);
  assert.deepEqual(selectYoloLeafBatch(state, "base", 4, 2), ["a2", "a3", "a1"]);
  assert.deepEqual(selectYoloLeafBatch(state, "base", 3), ["a2", "a3", "a1"]);
  state.composites.push({ id: "composite", status: "queued", sources: [{ agentRunId: "a2" }] });
  assert.deepEqual(selectYoloLeafBatch(state, "base", 3), []);
  state.agentRuns.push(leaf("a4", 4));
  assert.deepEqual(selectYoloLeafBatch(state, "base", 3), ["a3", "a4", "a1"]);
  state.agentRuns[2].baseCommit = "old-base";
  assert.deepEqual(selectYoloLeafBatch(state, "base", 3), []);
  state.agentRuns[1].quarantinedAt = new Date().toISOString();
  assert.deepEqual(selectYoloLeafBatch(state, "base", 3, 2), ["a4", "a1"]);
  state.composites[0].status = "failed";
  state.agentRuns[1].quarantinedAt = undefined;
  state.agentRuns[2].baseCommit = "base";
  assert.deepEqual(selectYoloLeafBatch(state, "base", 3), ["a2", "a3", "a4"]);
});

test("YOLO portfolio never recooks an identical failed source set", () => {
  const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: new Date().toISOString() };
  const deltas = [{ evaluationId: "speed", name: "Speed", before: 80, after: 81, delta: 1 }];
  const leaf = (id, impact) => ({ id, status: "completed", prState: "open", prNumber: Number(id.slice(1)), baseCommit: "base", reviewApproved: true, reviewRounds: [approvedRound], deltas, impact });
  const source = (agentRunId) => ({ agentRunId, kind: "pull_request", branch: `branch-${agentRunId}` });
  const state = {
    settings: { compositeAbsorbThreshold: 0 },
    evaluations: [{ id: "speed", enabled: true, command: "./benchmark" }],
    composites: [{ id: "failed", status: "failed", baseCommit: "base", sources: [source("a1"), source("a2"), source("a3")] }],
    agentRuns: [leaf("a1", 9), leaf("a2", 8), leaf("a3", 7)],
  };
  assert.deepEqual(selectYoloLeafBatch(state, "base", 3), [], "the identical three-leaf tree must remain tombstoned");
  assert.deepEqual(selectYoloLeafBatch(state, "base", 3, 2), ["a1", "a2"], "deadline recovery may try a genuinely smaller tree");
  state.agentRuns.push(leaf("a4", 6));
  assert.deepEqual(selectYoloLeafBatch(state, "base", 3), ["a1", "a2", "a4"], "new work may replace one failed source");
  state.composites[0].baseCommit = "old-base";
  assert.deepEqual(selectYoloLeafBatch(state, "base", 3), ["a1", "a2", "a3"], "failed sets do not leak across base commits");
});

test("YOLO leaf batches tolerate negative prompt impact but never command regressions", () => {
  const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: new Date().toISOString() };
  const state = {
    settings: { compositeAbsorbThreshold: 0 },
    evaluations: [
      { id: "benchmark", enabled: true, command: "./benchmark" },
      { id: "progress", enabled: true },
    ],
    composites: [],
    agentRuns: [
      { id: "leaf-a", status: "completed", prState: "open", prNumber: 1, baseCommit: "base", reviewApproved: true, reviewRounds: [approvedRound], impact: -5.5, deltas: [
        { evaluationId: "benchmark", name: "Benchmark", before: 50, after: 50, delta: 0 },
        { evaluationId: "progress", name: "Progress", before: 20, after: 0, delta: -20 },
      ] },
      { id: "leaf-b", status: "completed", prState: "open", prNumber: 2, baseCommit: "base", reviewApproved: true, reviewRounds: [approvedRound], impact: -3, deltas: [
        { evaluationId: "benchmark", name: "Benchmark", before: 50, after: 55, delta: 5 },
        { evaluationId: "progress", name: "Progress", before: 20, after: 20, delta: 0 },
      ] },
    ],
  };
  assert.deepEqual(selectYoloLeafBatch(state, "base", 2), ["leaf-b", "leaf-a"]);
  assert.equal(selectYoloMergeCandidate(state, "base"), undefined);
  state.agentRuns[0].deltas[0] = { ...state.agentRuns[0].deltas[0], after: 45, delta: -5 };
  assert.deepEqual(selectYoloLeafBatch(state, "base", 2), []);
  assert.equal(selectYoloMergeCandidate(state, "base"), undefined);
});

test("review-budget recovery partitions healthy leaves into balanced half-size composites", () => {
  assert.deepEqual(partitionReviewFallbacks(["a", "b", "c", "d", "e", "f", "g"], 8), [["a", "b", "c", "d"], ["e", "f", "g"]]);
  assert.deepEqual(partitionReviewFallbacks(["a", "b", "c"], 4), [["a", "b", "c"]]);
  assert.deepEqual(partitionReviewFallbacks(["a"], 2), []);
});

test("YOLO portfolio automatically cooks a complete batch as an evolving living line", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-yolo-portfolio-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: timestamp };
    const leaf = (id, number, impact) => ({ id, ideaId: `idea-${id}`, status: "completed", branch: `branch-${id}`, worktree: "", startedAt: timestamp, completedAt: timestamp, prUrl: `https://example.test/pull/${number}`, prNumber: number, prState: "open", baseCommit: "base", deltas: [{ evaluationId: "speed", name: "Speed", before: 80, after: 81, delta: 1 }], impact, resources: [], reviewRounds: [approvedRound], reviewApproved: true });
    await store.update((state) => {
      state.evaluations = [{ id: "speed", name: "Speed", prompt: "Measure speed", command: "./benchmark", weight: 1, enabled: true, createdAt: timestamp }];
      state.agentRuns = [leaf("slow", 1, 2), leaf("fast", 2, 7)];
      state.ideas.push(
        { id: "idea-slow", title: "Slow win", description: "", rationale: "", predictedImpact: 2, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "slow" },
        { id: "idea-fast", title: "Fast win", description: "", rationale: "", predictedImpact: 7, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "fast" },
      );
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 2 });
    orchestrator.git = { resolveRef: async () => "base" };
    let request;
    orchestrator.createComposite = async (...args) => { request = args; return {}; };
    assert.equal(await orchestrator.autoCookNext(), true);
    assert.deepEqual(request[0], ["fast", "slow"]);
    assert.match(request[1], /YOLO generation 1/);
    assert.deepEqual(request[3], { makeLiving: true });
    assert.equal(store.get().orchestrator.livingCompositeId, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("YOLO starts a partial cook early enough for the observed full suite to meet its deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-yolo-deadline-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.settings.mergeCadenceMinutes = 60;
      state.evaluations = [
        { id: "benchmark", name: "Benchmark", prompt: "Measure", command: "./full", weight: 1, enabled: true, createdAt: timestamp },
        { id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp },
      ];
      state.evaluationRuns = [
        { id: "benchmark-run", evaluationId: "benchmark", score: 80, commit: "base", createdAt: timestamp, durationMs: 40 * 60_000, status: "completed", context: "baseline" },
        { id: "quality-run", evaluationId: "quality", score: 80, commit: "base", createdAt: timestamp, durationMs: 3 * 60_000, status: "completed", context: "baseline" },
      ];
      state.orchestrator.mergeWindowStartedAt = new Date(Date.now() - 13 * 60_000).toISOString();
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 10 });
    assert.equal(orchestrator.mergeCadenceDue(), false);
    assert.equal(orchestrator.portfolioCookDue(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("YOLO cooks validated leaves before another observed leaf cycle can consume the merge reserve", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-yolo-authoring-headroom-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: timestamp };
    const leaf = (id, number, startedMinutesAgo, completedMinutesAgo) => ({
      id,
      ideaId: `idea-${id}`,
      status: "completed",
      branch: `branch-${id}`,
      worktree: "",
      startedAt: new Date(now - startedMinutesAgo * 60_000).toISOString(),
      completedAt: new Date(now - completedMinutesAgo * 60_000).toISOString(),
      prUrl: `https://example.test/pull/${number}`,
      prNumber: number,
      prState: "open",
      baseCommit: "base",
      deltas: [{ evaluationId: "quality", name: "Quality", before: 80, after: 81, delta: 1 }],
      impact: 1,
      resources: [],
      reviewRounds: [approvedRound],
      reviewApproved: true,
    });
    await store.update((state) => {
      state.settings.mergeCadenceMinutes = 60;
      state.orchestrator.mergeWindowStartedAt = new Date(now - 35 * 60_000).toISOString();
      state.evaluations = [{ id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp }];
      state.agentRuns = [leaf("first", 1, 30, 10), leaf("second", 2, 18, 1)];
      state.ideas.push(
        { id: "idea-first", title: "First", description: "", rationale: "", predictedImpact: 1, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "first" },
        { id: "idea-second", title: "Second", description: "", rationale: "", predictedImpact: 1, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "second" },
      );
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 3 });
    orchestrator.git = { resolveRef: async () => "base" };
    assert.equal(orchestrator.mergeCadenceDue(), false);
    assert.equal(orchestrator.portfolioCookDue(store.get(), "base"), true, "a recent 20-minute leaf must not be launched with only 25 minutes left");
    let cooked;
    orchestrator.createComposite = async (...args) => { cooked = args; return {}; };
    assert.equal(await orchestrator.autoCookNext(), true);
    assert.deepEqual(cooked[0], ["first", "second"]);
    assert.match(cooked[2], /shortened this batch early enough/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("YOLO cadence cooks a healthy partial batch and falls back to one reviewed leaf", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-yolo-cadence-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const old = new Date(Date.now() - 61 * 60_000).toISOString();
    const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: timestamp };
    const leaf = (id, number, impact) => ({ id, ideaId: `idea-${id}`, status: "completed", branch: `branch-${id}`, worktree: "", startedAt: timestamp, completedAt: timestamp, prUrl: `https://example.test/pull/${number}`, prNumber: number, prState: "open", baseCommit: "base", deltas: [{ evaluationId: "speed", name: "Speed", before: 80, after: 81, delta: 1 }], impact, resources: [], reviewRounds: [approvedRound], reviewApproved: true });
    await store.update((state) => {
      state.settings.mergeCadenceMinutes = 60;
      state.orchestrator.mergeWindowStartedAt = old;
      state.evaluations = [{ id: "speed", name: "Speed", prompt: "Measure speed", command: "./benchmark", weight: 1, enabled: true, createdAt: timestamp }];
      state.agentRuns = [leaf("a", 1, 3), leaf("b", 2, 2)];
      state.ideas.push(
        { id: "idea-a", title: "A", description: "", rationale: "", predictedImpact: 3, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "a" },
        { id: "idea-b", title: "B", description: "", rationale: "", predictedImpact: 2, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "b" },
      );
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 10 });
    orchestrator.git = { resolveRef: async () => "base" };
    let cooked;
    orchestrator.createComposite = async (...args) => { cooked = args; return {}; };
    assert.equal(await orchestrator.autoMergeNext(), false);
    assert.equal(await orchestrator.autoCookNext(), true);
    assert.deepEqual(cooked[0], ["a", "b"]);
    assert.match(cooked[2], /shortened this batch/);

    await store.update((state) => { state.agentRuns.find((run) => run.id === "b").quarantinedAt = timestamp; });
    orchestrator.activeAgents.add("in-flight");
    assert.equal(await orchestrator.shouldDrainForPortfolio(), true);
    orchestrator.activeAgents.clear();
    let merged;
    orchestrator.fullyValidateLeafForMerge = async () => true;
    orchestrator.mergeAgent = async (id) => { merged = id; return {}; };
    assert.equal(await orchestrator.autoMergeNext(), true);
    assert.equal(merged, "a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hard composite merge-gate failures retire the unchanged head instead of retrying in a loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-composite-merge-gate-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: timestamp, completedAt: timestamp };
    await store.update((state) => {
      state.evaluations = [{ id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp }];
      state.composites.push({
        id: "composite", title: "Composite", description: "", status: "open", branch: "burner/composite", worktree: "", baseCommit: "base",
        sources: [], deltas: [{ evaluationId: "quality", name: "Quality", before: 80, after: 81, delta: 1 }], compositeScore: 81, impact: 1,
        reviewRounds: [approvedRound], reviewApproved: true, prNumber: 234, prUrl: "https://example.test/pull/234", createdAt: timestamp, updatedAt: timestamp, isLiving: true,
      });
      state.orchestrator.livingCompositeId = "composite";
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 3 });
    orchestrator.git = { resolveRef: async () => "base" };
    let attempts = 0;
    orchestrator.mergeComposite = async () => { attempts += 1; throw new Error("required check failed at stamped-head"); };

    assert.equal(await orchestrator.autoMergeNext(), true);
    assert.equal(store.get().composites[0].status, "failed");
    assert.equal(store.get().composites[0].isLiving, false);
    assert.equal(store.get().orchestrator.livingCompositeId, undefined);
    assert.match(store.get().composites[0].error, /required check failed/);
    assert.equal(store.get().activity.filter((item) => item.message === "Merge gate blocked PR #234").length, 1);
    assert.equal(await orchestrator.autoMergeNext(), false);
    assert.equal(attempts, 1, "the same failed head must not be retried automatically");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hard direct-leaf merge-gate failures quarantine the leaf instead of retrying in a loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-leaf-merge-gate-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: timestamp, completedAt: timestamp };
    await store.update((state) => {
      state.evaluations = [{ id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp }];
      state.agentRuns.push({
        id: "leaf", ideaId: "idea", status: "completed", branch: "burner/leaf", worktree: "", startedAt: timestamp, completedAt: timestamp,
        prNumber: 10, prUrl: "https://example.test/pull/10", prState: "open", baseCommit: "base",
        deltas: [{ evaluationId: "quality", name: "Quality", before: 80, after: 81, delta: 1 }], impact: 1, resources: [], reviewRounds: [approvedRound], reviewApproved: true,
      });
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 1 });
    orchestrator.git = { resolveRef: async () => "base" };
    let attempts = 0;
    orchestrator.mergeAgent = async () => { attempts += 1; throw new Error("required check failed at stamped-head"); };

    assert.equal(await orchestrator.autoMergeNext(), true);
    assert.equal(store.get().agentRuns[0].status, "failed");
    assert.ok(store.get().agentRuns[0].quarantinedAt);
    assert.match(store.get().agentRuns[0].quarantineReason, /Merge gate rejected PR #10/);
    assert.equal(await orchestrator.autoMergeNext(), false);
    assert.equal(attempts, 1, "the same failed leaf head must not be retried automatically");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cadence-driven single leaves receive full evaluation validation before merge", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-full-leaf-validation-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: timestamp };
    await store.update((state) => {
      state.evaluations = [{ id: "bench", name: "Benchmark", prompt: "Measure", command: "full", screeningCommand: "quick", weight: 1, enabled: true, createdAt: timestamp }];
      state.evaluationRuns.push({ id: "baseline", evaluationId: "bench", score: 90, commit: "base", createdAt: timestamp, durationMs: 1, status: "completed", context: "baseline" });
      state.ideas.push({ id: "idea", title: "Fast leaf", description: "Improve", rationale: "", predictedImpact: 1, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "leaf" });
      state.agentRuns.push({ id: "leaf", ideaId: "idea", status: "completed", branch: "burner/leaf", worktree: "", startedAt: timestamp, completedAt: timestamp, prNumber: 10, prUrl: "https://example.test/pull/10", prState: "open", baseCommit: "base", deltas: [{ evaluationId: "bench", name: "Benchmark", before: 80, after: 100, delta: 20, screening: true }], impact: 20, resources: [], reviewRounds: [approvedRound], reviewApproved: true });
    });
    const edited = [];
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 10 });
    orchestrator.git = {
      createExistingWorktree: async () => root,
      removeWorktree: async () => undefined,
      resolveRef: async () => "base",
      editPr: async (...args) => edited.push(args),
    };
    orchestrator.runCandidateEvaluations = async (context) => {
      assert.equal(context, "composite");
      return [{ id: "full", evaluationId: "bench", score: 95, summary: "full", commit: "candidate", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite", agentRunId: "leaf" }];
    };
    await orchestrator.locks.init();
    assert.equal(await orchestrator.fullyValidateLeafForMerge("leaf", "base"), true);
    const run = store.get().agentRuns[0];
    assert.deepEqual(run.deltas.map(({ before, after, delta, screening }) => ({ before, after, delta, screening })), [{ before: 90, after: 95, delta: 5, screening: false }]);
    assert.equal(edited.length, 1);
    assert.doesNotMatch(edited[0][3], /leaf screen/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cadence-driven leaf validation confirms prompt regressions with a median without rerunning commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-prompt-confirmation-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: timestamp };
    await store.update((state) => {
      state.evaluations = [
        { id: "bench", name: "Benchmark", prompt: "Measure", command: "full", screeningCommand: "quick", weight: 1, enabled: true, createdAt: timestamp },
        { id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp },
      ];
      state.evaluationRuns.push(
        { id: "baseline-bench", evaluationId: "bench", score: 90, commit: "base", createdAt: timestamp, durationMs: 1, status: "completed", context: "baseline" },
        { id: "baseline-quality", evaluationId: "quality", score: 50, commit: "base", createdAt: timestamp, durationMs: 1, status: "completed", context: "baseline" },
      );
      state.ideas.push({ id: "idea", title: "Stable leaf", description: "Improve", rationale: "", predictedImpact: 1, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "leaf" });
      state.agentRuns.push({ id: "leaf", ideaId: "idea", status: "completed", branch: "burner/leaf", worktree: "", startedAt: timestamp, completedAt: timestamp, prNumber: 10, prUrl: "https://example.test/pull/10", prState: "open", baseCommit: "base", deltas: [], impact: 1, resources: [], reviewRounds: [approvedRound], reviewApproved: true });
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 10 });
    orchestrator.git = {
      createExistingWorktree: async () => root,
      removeWorktree: async () => undefined,
      resolveRef: async () => "base",
      editPr: async () => undefined,
    };
    orchestrator.runCandidateEvaluations = async () => [
      { id: "full-bench", evaluationId: "bench", score: 95, summary: "full", commit: "candidate", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite", agentRunId: "leaf" },
      { id: "quality-first", evaluationId: "quality", score: 45, summary: "noisy low", commit: "candidate", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite", agentRunId: "leaf" },
    ];
    const confirmationScores = [50, 55];
    let confirmationCalls = 0;
    orchestrator.runEvaluations = async (context, _cwd, agentRunId, compositeId, evaluationIds) => {
      assert.equal(context, "composite");
      assert.equal(agentRunId, "leaf");
      assert.equal(compositeId, undefined);
      assert.deepEqual(evaluationIds, ["quality"], "the command-backed benchmark must not be rerun or averaged");
      const score = confirmationScores[confirmationCalls++];
      return [{ id: `quality-${confirmationCalls}`, evaluationId: "quality", score, summary: "confirmation", commit: "candidate", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite", agentRunId: "leaf" }];
    };
    await orchestrator.locks.init();
    assert.equal(await orchestrator.fullyValidateLeafForMerge("leaf", "base"), true);
    assert.equal(confirmationCalls, 2);
    assert.deepEqual(store.get().agentRuns[0].deltas.map(({ evaluationId, delta }) => ({ evaluationId, delta })), [
      { evaluationId: "bench", delta: 5 },
      { evaluationId: "quality", delta: 0 },
    ]);
    assert.ok(store.get().activity.some((item) => item.message === "Confirming 1 prompt regression for PR #10"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("composite prompt regressions use a persisted median without rerunning commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-composite-prompt-confirmation-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.evaluations = [
        { id: "bench", name: "Benchmark", prompt: "Measure", command: "full", weight: 1, enabled: true, createdAt: timestamp },
        { id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp },
      ];
      state.evaluationRuns.push(
        { id: "baseline-bench", evaluationId: "bench", score: 90, commit: "base", createdAt: timestamp, durationMs: 1, status: "completed", context: "baseline" },
        { id: "baseline-quality", evaluationId: "quality", score: 50, commit: "base", createdAt: timestamp, durationMs: 1, status: "completed", context: "baseline" },
      );
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 3 });
    const calls = [];
    const confirmationScores = [50, 55];
    orchestrator.runEvaluations = async (context, _cwd, agentRunId, compositeId, evaluationIds) => {
      calls.push({ context, agentRunId, compositeId, evaluationIds });
      const score = confirmationScores.shift();
      return [{ id: `confirmation-${calls.length}`, evaluationId: "quality", score, summary: "confirmation", commit: "candidate", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite", compositeId }];
    };
    const initial = [
      { id: "bench-after", evaluationId: "bench", score: 95, summary: "faster", commit: "candidate", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite", compositeId: "combined" },
      { id: "quality-after", evaluationId: "quality", score: 45, summary: "noisy low", commit: "candidate", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite", compositeId: "combined" },
    ];
    const confirmed = await orchestrator.confirmPromptRegressions(root, store.latestRuns(), initial, "composite PR #99", undefined, "combined");
    assert.equal(confirmed.find((run) => run.evaluationId === "quality").score, 50);
    assert.equal(confirmed.find((run) => run.evaluationId === "bench").score, 95);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.context === "composite" && call.agentRunId === undefined && call.compositeId === "combined"));
    assert.ok(calls.every((call) => JSON.stringify(call.evaluationIds) === JSON.stringify(["quality"])), "command-backed evaluations must not be confirmed or softened");
    assert.equal(store.latestCompositeRuns("combined").get("quality").score, 50, "the promoted baseline must use the confirmed median");
    assert.ok(store.get().activity.some((item) => item.message === "Confirming 1 prompt regression for composite PR #99"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed current generation immediately unlocks a fully validated leaf fallback before cook lead time", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-failed-generation-fallback-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const freshWindow = new Date().toISOString();
    const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: timestamp };
    await store.update((state) => {
      state.settings.mergeCadenceMinutes = 60;
      state.orchestrator.mergeWindowStartedAt = freshWindow;
      state.evaluations = [{ id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp }];
      state.ideas.push({ id: "idea", title: "Healthy leaf", description: "Improve", rationale: "", predictedImpact: 1, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "leaf" });
      state.agentRuns.push({ id: "leaf", ideaId: "idea", status: "completed", branch: "burner/leaf", worktree: "", startedAt: timestamp, completedAt: timestamp, prNumber: 10, prUrl: "https://example.test/pull/10", prState: "open", baseCommit: "base", deltas: [{ evaluationId: "quality", name: "Quality", before: 50, after: 55, delta: 5 }], impact: 5, resources: [], reviewRounds: [approvedRound], reviewApproved: true });
      state.composites.push({ id: "failed", title: "Failed generation", description: "", status: "failed", branch: "burner/failed", worktree: "", baseCommit: "base", sources: [{ agentRunId: "leaf", prNumber: 10, title: "Healthy leaf", branch: "burner/leaf", kind: "pull_request" }], deltas: [], reviewRounds: [], createdAt: timestamp, updatedAt: timestamp, isLiving: false });
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 3 });
    orchestrator.git = { resolveRef: async () => "base" };
    let validated;
    let merged;
    orchestrator.fullyValidateLeafForMerge = async (id) => { validated = id; return true; };
    orchestrator.mergeAgent = async (id) => { merged = id; return {}; };
    assert.equal(await orchestrator.autoMergeNext(), true);
    assert.equal(validated, "leaf");
    assert.equal(merged, "leaf");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("YOLO portfolio caps reviews, quarantines the implicated leaf, and queues smaller healthy partitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-yolo-quarantine-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const run = (id, number, impact) => ({ id, ideaId: `idea-${id}`, status: "completed", branch: `branch-${id}`, worktree: "", startedAt: timestamp, completedAt: timestamp, prUrl: `https://example.test/pull/${number}`, prNumber: number, prState: "open", baseCommit: "base", deltas: [], impact, resources: [], reviewRounds: [], reviewApproved: true });
    await store.update((state) => {
      state.settings.portfolioReviewRounds = 3;
      state.agentRuns.push(run("a", 1, 8), run("b", 2, 7), run("c", 3, 6), run("d", 4, 5), run("e", 5, 4), run("f", 6, 3), run("g", 7, 2), run("h", 8, 1));
      state.composites.push({
        id: "blocked", title: "Blocked generation", description: "Combined", status: "reviewing", branch: "composite-blocked", worktree: "", baseCommit: "base",
        sources: [
          { agentRunId: "a", prNumber: 1, title: "A", branch: "branch-a", kind: "pull_request", impact: 8 },
          { agentRunId: "b", prNumber: 2, title: "B", branch: "branch-b", kind: "pull_request", impact: 7 },
          { agentRunId: "c", prNumber: 3, title: "C", branch: "branch-c", kind: "pull_request", impact: 6 },
          { agentRunId: "d", prNumber: 4, title: "D", branch: "branch-d", kind: "pull_request", impact: 5 },
          { agentRunId: "e", prNumber: 5, title: "E", branch: "branch-e", kind: "pull_request", impact: 4 },
          { agentRunId: "f", prNumber: 6, title: "F", branch: "branch-f", kind: "pull_request", impact: 3 },
          { agentRunId: "g", prNumber: 7, title: "G", branch: "branch-g", kind: "pull_request", impact: 2 },
          { agentRunId: "h", prNumber: 8, title: "H", branch: "branch-h", kind: "pull_request", impact: 1 },
        ],
        deltas: [], reviewRounds: [], prNumber: 100, prUrl: "https://example.test/pull/100", createdAt: timestamp, updatedAt: timestamp, isLiving: false,
      });
    });
    const quarantined = [];
    const closed = [];
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 10 });
    orchestrator.git = {
      resolveRef: async () => "base",
      changedFiles: async (_cwd, _base, head) => head.endsWith("branch-b") ? ["src/parser.ts"] : ["README.md"],
      markPrQuarantined: async (_cwd, number) => quarantined.push(number),
      closePr: async (_cwd, number) => closed.push(number),
    };
    const fallbacks = [];
    orchestrator.createComposite = async (ids, title, description) => {
      const fallback = { ids, title, description, id: `fallback-${fallbacks.length + 1}` };
      fallbacks.push(fallback);
      return fallback;
    };
    await orchestrator.quarantineCompositeBlocker("blocked", [{ severity: "high", title: "Parser bug", detail: "Fix", file: "src/parser.ts:42" }]);
    const state = store.get();
    assert.ok(state.agentRuns.find((item) => item.id === "b").quarantinedAt);
    assert.equal(state.composites.find((item) => item.id === "blocked").status, "closed");
    assert.equal(state.composites.find((item) => item.id === "blocked").supersededByCompositeId, "fallback-1");
    assert.deepEqual(fallbacks.map((fallback) => fallback.ids), [["a", "c", "d", "e"], ["f", "g", "h"]]);
    assert.deepEqual(quarantined, [2]);
    assert.deepEqual(closed, [100]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("YOLO portfolio opens a draft composite before review and bounds review rounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-yolo-draft-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.settings.portfolioReviewRounds = 3;
      state.composites.push({ id: "draft", title: "Visible composite", description: "Combined", status: "building", branch: "composite-draft", worktree: root, sources: [{ agentRunId: "a", prNumber: 1, title: "A", branch: "a", kind: "pull_request" }, { agentRunId: "b", prNumber: 2, title: "B", branch: "b", kind: "pull_request" }], deltas: [], reviewRounds: [], createdAt: timestamp, updatedAt: timestamp, isLiving: false });
      state.agentRuns.push({ id: "agent", ideaId: "idea", status: "reviewing", branch: "agent", worktree: root, startedAt: timestamp, deltas: [], resources: [], reviewRounds: [] });
    });
    const opened = [];
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 10 });
    orchestrator.assertCandidateDoesNotOwnProgress = async () => undefined;
    orchestrator.git = {
      push: async () => undefined,
      openPr: async (options) => { opened.push(options); return { url: "https://example.test/pull/10", number: 10 }; },
      head: async () => "head",
      hasChanges: async () => false,
    };
    await orchestrator.publishCompositeDraft(root, "draft", "awaiting review", store.get().settings);
    assert.equal(opened[0].draft, true);
    assert.equal(store.get().composites[0].prNumber, 10);

    let reviewCalls = 0;
    orchestrator.codex = {
      review: async () => { reviewCalls += 1; return { approved: false, summary: "Not yet", findings: [{ severity: "high", title: "Bug", detail: "Fix", file: "src/app.ts" }] }; },
      revise: async () => ({ threadId: "thread", message: "revised" }),
    };
    await assert.rejects(() => orchestrator.reviewAgent(root, "agent", "Agent", "main", "thread", store.get().settings), /bounded review budget/);
    assert.equal(reviewCalls, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review budgets are live and cumulative for agents and composites", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-live-review-budget-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const rejectedRound = (round) => ({ id: `review-${round}`, round, commit: `commit-${round}`, approved: false, summary: "Blocked", findings: [{ severity: "high", title: "Bug", detail: "Fix", file: "src/app.ts" }], createdAt: timestamp });
    await store.update((state) => {
      state.settings.portfolioReviewRounds = 3;
      state.agentRuns.push({ id: "agent", ideaId: "idea", status: "reviewing", branch: "agent", worktree: root, startedAt: timestamp, deltas: [], resources: [], reviewRounds: [rejectedRound(1)] });
      state.composites.push({ id: "composite", title: "Composite", description: "Combined", status: "reviewing", branch: "composite", worktree: root, sources: [], deltas: [], reviewRounds: [rejectedRound(1), rejectedRound(2)], createdAt: timestamp, updatedAt: timestamp, isLiving: false });
    });
    const capturedSettings = store.get().settings;
    let reviewCalls = 0;
    let revisionCalls = 0;
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 3 });
    orchestrator.git = { head: async () => "head", hasChanges: async () => false };
    orchestrator.codex = {
      review: async () => {
        reviewCalls += 1;
        await store.update((state) => { state.settings.portfolioReviewRounds = 2; });
        return { approved: false, summary: "Still blocked", findings: [{ severity: "high", title: "Bug", detail: "Fix", file: "src/app.ts" }] };
      },
      revise: async () => { revisionCalls += 1; return { threadId: "thread", message: "revised" }; },
    };

    await assert.rejects(() => orchestrator.reviewAgent(root, "agent", "Agent", "main", "thread", capturedSettings), /bounded review budget/);
    assert.equal(reviewCalls, 1);
    assert.equal(revisionCalls, 0);
    assert.equal(store.get().agentRuns[0].reviewRounds.length, 2);

    await assert.rejects(() => orchestrator.reviewComposite(root, "composite", "Composite", "main", "thread", capturedSettings), /bounded review budget/);
    assert.equal(reviewCalls, 1, "an already exhausted composite must not start another review");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retrying a failed composite preserves its cumulative review history", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-composite-retry-budget-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => state.composites.push({
      id: "failed", title: "Failed", description: "Combined", status: "failed", branch: "composite", worktree: root, sources: [], deltas: [],
      reviewRounds: [{ id: "review-1", round: 1, commit: "head", approved: false, summary: "Blocked", findings: [], createdAt: timestamp }],
      prNumber: 10, prUrl: "https://example.test/pull/10", createdAt: timestamp, updatedAt: timestamp, isLiving: false,
    }));
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 3 });
    orchestrator.scheduleComposites = async () => undefined;
    await orchestrator.retryComposite("failed");
    assert.equal(store.get().composites[0].status, "rebuilding");
    assert.equal(store.get().composites[0].reviewRounds.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review-budget exhaustion preserves leaf work as a quarantined draft PR", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-leaf-checkpoint-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.ideas.push({ id: "idea", title: "Large feature", description: "Keep the work", rationale: "", predictedImpact: 1, evaluationIds: [], resources: [], status: "failed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "run" });
      state.agentRuns.push({ id: "run", ideaId: "idea", status: "failed", branch: "burner/feature", worktree: root, startedAt: timestamp, completedAt: timestamp, deltas: [], resources: [], reviewRounds: [{ id: "review", round: 12, commit: "head", approved: false, summary: "Blocked", findings: [{ severity: "high", title: "Race", detail: "Fix the race", file: "src/app.ts" }], createdAt: timestamp }], reviewApproved: false });
    });
    const opened = [];
    const quarantined = [];
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 10 });
    orchestrator.git = {
      push: async () => undefined,
      openPr: async (options) => { opened.push(options); return { url: "https://example.test/pull/12", number: 12 }; },
      markPrQuarantined: async (_cwd, number) => quarantined.push(number),
    };
    await orchestrator.publishAgentCheckpoint(store.get().ideas[0], "run", root, "burner/feature", store.get().settings);
    assert.equal(opened[0].draft, true);
    assert.match(opened[0].body, /not approved, fully evaluated, or eligible for YOLO merge/);
    assert.deepEqual(quarantined, [12]);
    assert.equal(store.get().agentRuns[0].prState, "open");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("YOLO portfolio drains active agents instead of refilling slots when a batch is ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-yolo-drain-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: timestamp };
    const leaf = (id, number) => ({ id, ideaId: `idea-${id}`, status: "completed", branch: `branch-${id}`, worktree: "", startedAt: timestamp, completedAt: timestamp, prUrl: `https://example.test/pull/${number}`, prNumber: number, prState: "open", baseCommit: "base", deltas: [{ evaluationId: "speed", name: "Speed", before: 80, after: 81, delta: 1 }], impact: 1, resources: [], reviewRounds: [approvedRound], reviewApproved: true });
    await store.update((state) => {
      state.settings.parallelism = 5;
      state.orchestrator.enabled = true;
      state.evaluations = [{ id: "speed", name: "Speed", prompt: "Measure speed", command: "./benchmark", weight: 1, enabled: true, createdAt: timestamp }];
      state.agentRuns = [leaf("a", 1), leaf("b", 2)];
      state.ideas.push({ id: "queued", title: "Do more", description: "More work", rationale: "Improve", predictedImpact: 10, evaluationIds: [], resources: [], status: "queued", createdAt: timestamp, updatedAt: timestamp, source: "manual" });
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 2 });
    orchestrator.git = { resolveRef: async () => "base" };
    orchestrator.activeAgents.add("already-running");
    let dispatched = false;
    orchestrator.runIdea = async () => { dispatched = true; };
    await orchestrator.schedule();
    assert.equal(dispatched, false);
    assert.equal(orchestrator.portfolioDraining, true);
    assert.match(store.get().activity[0].message, /batch ready; draining active agents/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("command-backed evaluations are serialized across concurrent candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-command-serialization-test-"));
  const evaluator = join(root, "evaluate");
  const mutex = join(root, "command-running");
  const overlap = join(root, "overlap-detected");
  try {
    await exec(root, "git", ["init", "-b", "main"]);
    await writeFile(join(root, "README.md"), "test\n");
    await exec(root, "git", ["add", "README.md"]);
    await exec(root, "git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "base"]);
    await writeFile(evaluator, `#!/bin/sh\nif ! mkdir "$BURNER_TEST_EVAL_MUTEX" 2>/dev/null; then\n  printf overlap > "$BURNER_TEST_EVAL_OVERLAP"\n  exit 9\nfi\ntrap 'rmdir "$BURNER_TEST_EVAL_MUTEX" 2>/dev/null || true' EXIT\nsleep 0.3\nprintf '%s\\n' '{"score":50,"summary":"serialized","evidence":[],"suggestions":[]}'\n`);
    await chmod(evaluator, 0o755);
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.settings.parallelism = 5;
      state.evaluations = [{ id: "benchmark", name: "Benchmark", prompt: "Measure", command: evaluator, weight: 1, enabled: true, createdAt: timestamp }];
    });
    process.env.BURNER_TEST_EVAL_MUTEX = mutex;
    process.env.BURNER_TEST_EVAL_OVERLAP = overlap;
    const orchestrator = new Orchestrator(root, store, new EventHub());
    await orchestrator.locks.init();
    const [first, second] = await Promise.all([
      orchestrator.runEvaluations("agent", root, "agent-a"),
      orchestrator.runEvaluations("agent", root, "agent-b"),
    ]);
    assert.deepEqual([...first, ...second].map((run) => run.status), ["completed", "completed"]);
    await assert.rejects(() => readFile(overlap, "utf8"), /ENOENT/);
  } finally {
    delete process.env.BURNER_TEST_EVAL_MUTEX;
    delete process.env.BURNER_TEST_EVAL_OVERLAP;
    await rm(root, { recursive: true, force: true });
  }
});

test("prompt evaluations overlap across candidates while command checks remain independently locked", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-evaluation-suite-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.settings.parallelism = 5;
      state.evaluations = [
        { id: "prompt", name: "Prompt", prompt: "Inspect", weight: 1, enabled: true, createdAt: timestamp },
        { id: "command", name: "Command", prompt: "Measure", command: "./benchmark", weight: 1, enabled: true, createdAt: timestamp },
      ];
    });
    const order = [];
    let activeSuite;
    let overlapped = false;
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.git = { head: async () => "commit" };
    orchestrator.codex = {
      preflight: async () => undefined,
      evaluate: async (cwd, evaluation) => {
        if (activeSuite && activeSuite !== cwd) overlapped = true;
        activeSuite = cwd;
        order.push(`${cwd}:${evaluation.id}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        activeSuite = undefined;
        return { score: 50, summary: "measured", evidence: [], suggestions: [] };
      },
    };
    await orchestrator.locks.init();
    await Promise.all([
      orchestrator.runEvaluations("agent", "suite-a", "agent-a"),
      orchestrator.runEvaluations("agent", "suite-b", "agent-b"),
    ]);
    assert.equal(overlapped, true);
    assert.deepEqual(new Set(order), new Set(["suite-a:command", "suite-a:prompt", "suite-b:command", "suite-b:prompt"]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evaluation suites share cpu-heavy without deadlocking the owning agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-evaluation-resource-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.evaluations = [{ id: "command", name: "Command", prompt: "Measure", command: "./benchmark", weight: 1, enabled: true, createdAt: timestamp }];
      state.agentRuns.push({ id: "cpu-agent", ideaId: "cpu-idea", resources: ["cpu-heavy"] });
    });
    const order = [];
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.git = { head: async () => "commit" };
    orchestrator.codex = {
      evaluate: async (cwd) => {
        order.push(cwd);
        const held = await orchestrator.locks.list();
        assert.ok(held.includes("cpu-heavy"));
        assert.ok(!held.includes("evaluation-suite"));
        return { score: 50, summary: "measured", evidence: [], suggestions: [] };
      },
    };
    await orchestrator.locks.init();
    orchestrator.activeAgents.add("cpu-idea");
    const agentLease = await orchestrator.locks.acquire("cpu-heavy", "cpu-agent");
    let plainFinished = false;
    const plain = orchestrator.runEvaluations("agent", "plain-suite", "plain-agent").then(() => { plainFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(plainFinished, false);
    await orchestrator.runEvaluations("agent", "owned-suite", "cpu-agent");
    assert.deepEqual(order, ["owned-suite"]);
    await agentLease.release();
    orchestrator.activeAgents.delete("cpu-idea");
    await plain;
    assert.deepEqual(order, ["owned-suite", "plain-suite"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate evaluation recovery reruns only failed scores", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-evaluation-retry-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.evaluations = [
        { id: "stable", name: "Stable", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp },
        { id: "flaky", name: "Flaky", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp },
      ];
    });
    const calls = { stable: 0, flaky: 0 };
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.git = { head: async () => "candidate" };
    orchestrator.codex = {
      preflight: async () => undefined,
      evaluate: async (_cwd, evaluation) => {
        calls[evaluation.id] += 1;
        if (evaluation.id === "flaky" && calls.flaky === 1) throw new Error("transient evaluator failure");
        return { score: 80, summary: "complete", evidence: [], suggestions: [] };
      },
    };
    const runs = await orchestrator.runCandidateEvaluations("agent", root, "agent");
    assert.deepEqual(runs.map((run) => run.status), ["completed", "completed"]);
    assert.deepEqual(calls, { stable: 1, flaky: 2 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every Codex role and structured fallback uses unrestricted mode with correct flag placement", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-codex-test-"));
  const bin = join(root, "bin");
  await import("node:fs/promises").then((fs) => fs.mkdir(bin));
  const executable = join(bin, "codex");
  const argsLog = join(root, "args.jsonl");
  await writeFile(executable, `#!/usr/bin/env node\nconst fs=require("fs");const args=process.argv.slice(2);const input=fs.readFileSync(0,"utf8");fs.appendFileSync(process.env.BURNER_TEST_ARGS,JSON.stringify({args,input})+"\\n");if(args.includes("--help")){console.log("  --dangerously-bypass-approvals-and-sandbox  unrestricted");process.exit(0);}const i=args.indexOf("--output-last-message");const out=args[i+1];if(args.includes("--output-schema")){process.exit(9);}if(input.includes("improvement planner")){fs.writeFileSync(out,JSON.stringify({ideas:[]}));}else if(input.includes("rigorous repository evaluator")){fs.writeFileSync(out,JSON.stringify({score:77,summary:"Measured",evidence:["code"],suggestions:["improve"]}));}else if(input.includes("independent, rigorous reviewer")){fs.writeFileSync(out,JSON.stringify({approved:true,summary:"Ready",findings:[]}));}else{fs.writeFileSync(out,"Author complete");console.log(JSON.stringify({type:"thread.started",thread_id:"thread-test"}));}\n`);
  await chmod(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.BURNER_TEST_ARGS = argsLog;
  const settings = { parallelism: 1, evaluationIntervalMinutes: 30, orchestratorIntervalMinutes: 15, autoRun: false, autoCreatePrs: true, evaluatorModel: "", agentModel: "", baseBranch: "main", remote: "origin", defaultResources: [], maxReviewRounds: 8, preferLivingComposite: true, compositeAbsorbThreshold: 0 };
  try {
    const codex = new CodexClient();
    const evaluation = { id: "quality", name: "Quality", prompt: "Score quality", weight: 1, enabled: true, createdAt: new Date().toISOString() };
    assert.equal((await codex.evaluate(root, evaluation, settings, "manual")).score, 77);
    assert.equal((await codex.evaluate(root, evaluation, settings, "composite")).score, 77);
    assert.deepEqual(await codex.planIdeas(root, [evaluation], new Map(), [], settings), []);
    const author = await codex.implement(root, { id: "idea", title: "Improve", description: "Do it", rationale: "Quality", predictedImpact: 20, evaluationIds: ["quality"], resources: [], status: "running", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source: "manual" }, [{ ...evaluation, prompt: "Use read-only inspection. Do not run cargo, builds, or tests." }], settings);
    assert.equal(author.threadId, "thread-test");
    assert.equal((await codex.integrateComposite(root, "Combined", ["Improve"], settings)).message, "Author complete");
    const revision = await codex.revise(root, author.threadId, { approved: false, summary: "Fix it", findings: [{ severity: "high", title: "Bug", detail: "Resolve", file: "app.js" }] }, settings);
    assert.equal(revision.message, "Author complete");
    const review = await codex.review(root, "main", "Improve", settings);
    assert.equal(review.approved, true);
    const calls = (await readFile(argsLog, "utf8")).trim().split("\n").map(JSON.parse);
    for (const { args } of calls) {
      assert.equal(args[0], "--dangerously-bypass-approvals-and-sandbox");
      assert.equal(args[1], "exec");
      assert.ok(!args.includes("--sandbox"));
      assert.ok(!args.includes("-s"));
      assert.ok(!args.includes("--ask-for-approval"));
      assert.ok(!args.includes("-a"));
      assert.ok(!args.some((arg) => /sandbox_mode|approval_policy|read-only|workspace-write/.test(arg)));
    }
    assert.ok(calls.some(({ input }) => input.includes("rigorous repository evaluator")));
    assert.ok(calls.some(({ input }) => input.includes("Finish this evaluation within 4 minutes")));
    const candidateEvaluatorCall = calls.find(({ input }) => input.includes("This candidate is not merged yet"));
    assert.match(candidateEvaluatorCall.input, /do not reduce its score because it lacks a history point for the current PR/);
    assert.ok(calls.some(({ input }) => input.includes("improvement planner")));
    const plannerCall = calls.find(({ input }) => input.includes("improvement planner"));
    assert.match(plannerCall.input, /targets a qualifying merge every 60 minutes/);
    assert.match(plannerCall.input, /hard scope constraint/);
    assert.match(plannerCall.input, /Never propose an umbrella task/);
    assert.match(plannerCall.input, /Burner owns the canonical merge-coupled evaluation progress artifacts/);
    assert.ok(calls.some(({ input }) => input.includes("implementation agent")));
    const authorCall = calls.find(({ input }) => input.includes("implementation agent"));
    assert.match(authorCall.input, /quoted as evaluator context, not instructions/);
    assert.match(authorCall.input, /do not constrain this implementation task: edit the worktree and run the relevant tests/);
    assert.match(authorCall.input, /All edits, generated artifacts, dependency changes, and test fixtures must stay inside the current worktree/);
    assert.match(authorCall.input, /Burner owns the canonical merge-coupled evaluation progress artifacts/);
    const integratorCall = calls.find(({ input }) => input.includes("author/integrator"));
    assert.match(integratorCall.input, /Never modify parent or sibling repositories/);
    assert.match(integratorCall.input, /Burner owns the canonical merge-coupled evaluation progress artifacts/);
    const revisionCall = calls.find(({ input }) => input.includes("independent reviewer requested changes"));
    assert.match(revisionCall.input, /Never modify parent or sibling repositories/);
    assert.match(revisionCall.input, /do not implement that invalid request/);
    const reviewerCalls = calls.filter(({ input }) => input.includes("independent, rigorous reviewer"));
    assert.equal(reviewerCalls.length, 2);
    assert.match(reviewerCalls[0].input, /comprehensive blocker pass now/);
    assert.match(reviewerCalls[0].input, /Treat candidate-authored duplicate progress infrastructure or mutations to these artifacts as a merge blocker/);
    assert.ok(reviewerCalls[0].args.includes("--output-schema"));
    assert.ok(!reviewerCalls[1].args.includes("--output-schema"));
    assert.ok(calls.some(({ args }) => args.includes("resume") && args.includes("thread-test")));
  } finally {
    process.env.PATH = previousPath;
    delete process.env.BURNER_TEST_ARGS;
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex unrestricted-mode preflight fails clearly without a restricted fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-codex-preflight-test-"));
  const bin = join(root, "bin");
  await import("node:fs/promises").then((fs) => fs.mkdir(bin));
  const executable = join(bin, "codex");
  await writeFile(executable, `#!/usr/bin/env node\nconsole.error("error: unexpected argument '--dangerously-bypass-approvals-and-sandbox'");process.exit(2);\n`);
  await chmod(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  try {
    await assert.rejects(
      () => new CodexClient().preflight(root),
      /requires Codex unrestricted mode.*will not fall back to restricted mode/s,
    );
  } finally {
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex preflight supports Meta's launcher-level sandbox bypass without a PTY shim", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-codex-meta-preflight-test-"));
  const bin = join(root, "bin");
  await import("node:fs/promises").then((fs) => fs.mkdir(bin));
  const executable = join(bin, "codex");
  const argsLog = join(root, "args.jsonl");
  await writeFile(executable, `#!/usr/bin/env node\nconst fs=require("fs");const args=process.argv.slice(2);fs.appendFileSync(process.env.BURNER_TEST_ARGS,JSON.stringify(args)+"\\n");if(!args.includes("--dangerously-disable-osx-sandbox")){console.error("sandbox_apply: Operation not permitted");process.exit(2);}if(args.includes("--help")){console.log("--dangerously-bypass-approvals-and-sandbox");process.exit(0);}const out=args[args.indexOf("--output-last-message")+1];fs.writeFileSync(out,JSON.stringify({score:88,summary:"ok",evidence:[],suggestions:[]}));\n`);
  await chmod(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.BURNER_TEST_ARGS = argsLog;
  const settings = { parallelism: 1, evaluationIntervalMinutes: 30, orchestratorIntervalMinutes: 15, autoRun: false, autoCreatePrs: true, evaluatorModel: "", agentModel: "", baseBranch: "main", remote: "origin", defaultResources: [], maxReviewRounds: 8, preferLivingComposite: true, compositeAbsorbThreshold: 0 };
  try {
    const output = await new CodexClient().evaluate(root, { id: "quality", name: "Quality", prompt: "Score it", weight: 1, enabled: true, createdAt: new Date().toISOString() }, settings, "manual");
    assert.equal(output.score, 88);
    const calls = (await readFile(argsLog, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls[0].slice(0, 2), ["--dangerously-bypass-approvals-and-sandbox", "exec"]);
    assert.deepEqual(calls[1].slice(0, 3), ["--dangerously-disable-osx-sandbox", "--dangerously-bypass-approvals-and-sandbox", "exec"]);
    assert.deepEqual(calls[2].slice(0, 3), ["--dangerously-disable-osx-sandbox", "--dangerously-bypass-approvals-and-sandbox", "exec"]);
  } finally {
    process.env.PATH = previousPath;
    delete process.env.BURNER_TEST_ARGS;
    await rm(root, { recursive: true, force: true });
  }
});

test("merged composites supersede source PRs and queue overlapping composites for rebuild", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-reconcile-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const run = (id, number) => ({ id, ideaId: `idea-${id}`, status: "completed", branch: `branch-${id}`, worktree: "", startedAt: timestamp, completedAt: timestamp, prUrl: `https://example.test/pull/${number}`, prNumber: number, prState: "open", deltas: [], resources: [], reviewRounds: [], reviewApproved: true });
    await store.update((state) => {
      state.agentRuns.push(run("a", 1), run("b", 2), run("c", 3), run("d", 4));
      state.composites.push(
        { id: "merged", title: "Merged composite", description: "", status: "open", branch: "composite-merged", worktree: "", sources: [{ agentRunId: "a", prNumber: 1, title: "A", branch: "branch-a", kind: "pull_request" }, { agentRunId: "b", prNumber: 2, title: "B", branch: "branch-b", kind: "pull_request" }], deltas: [], reviewRounds: [], prNumber: 100, prUrl: "https://example.test/pull/100", createdAt: timestamp, updatedAt: timestamp, isLiving: true },
        { id: "overlap", title: "Overlap", description: "", status: "open", branch: "composite-overlap", worktree: "", sources: [{ agentRunId: "a", prNumber: 1, title: "A", branch: "branch-a", kind: "pull_request" }, { agentRunId: "c", prNumber: 3, title: "C", branch: "branch-c", kind: "pull_request" }, { agentRunId: "d", prNumber: 4, title: "D", branch: "branch-d", kind: "pull_request" }], deltas: [], reviewRounds: [], prNumber: 101, prUrl: "https://example.test/pull/101", createdAt: timestamp, updatedAt: timestamp, isLiving: false },
      );
      state.orchestrator.livingCompositeId = "merged";
    });
    const closed = [];
    const labeled = [];
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.git = {
      remoteExists: async () => true,
      listPullRequests: async () => [
        { number: 1, state: "OPEN", headRefName: "branch-a", url: "" }, { number: 2, state: "OPEN", headRefName: "branch-b", url: "" },
        { number: 3, state: "OPEN", headRefName: "branch-c", url: "" }, { number: 4, state: "OPEN", headRefName: "branch-d", url: "" },
        { number: 100, state: "MERGED", headRefName: "composite-merged", url: "" }, { number: 101, state: "OPEN", headRefName: "composite-overlap", url: "" },
      ],
      closePr: async (_cwd, number, _comment, disposition) => { closed.push([number, disposition]); },
      markPrDisposition: async (_cwd, number, disposition) => { labeled.push([number, disposition]); },
      syncBase: async () => "abcdef1234567890",
    };
    await orchestrator.syncPullRequests(true);
    const state = store.get();
    assert.equal(state.composites.find((item) => item.id === "merged").status, "merged");
    assert.equal(state.agentRuns.find((item) => item.id === "a").prState, "superseded");
    assert.equal(state.agentRuns.find((item) => item.id === "b").prState, "superseded");
    const overlap = state.composites.find((item) => item.id === "overlap");
    assert.equal(overlap.status, "rebuilding");
    assert.deepEqual(overlap.sources.map((source) => source.agentRunId), ["c", "d"]);
    assert.deepEqual(closed.sort(), [[1, "merged"], [2, "merged"]]);
    assert.deepEqual(labeled, [[100, "merged"]]);
    assert.equal(state.orchestrator.baseSyncPending, false);
    assert.equal(state.orchestrator.lastEvaluationAt, undefined);
    assert.ok(state.orchestrator.lastMergeAt);
    assert.equal(state.orchestrator.mergeWindowStartedAt, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an exactly merged composite becomes the next full baseline without rerunning it", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-promote-baseline-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.evaluations = [{ id: "quality", name: "Quality", prompt: "Score", command: "full", screeningCommand: "quick", weight: 1, enabled: true, createdAt: timestamp }];
      state.composites.push({ id: "combined", title: "Combined", description: "", status: "merged", branch: "burner/combined", worktree: "", sources: [], deltas: [], reviewRounds: [], createdAt: timestamp, updatedAt: timestamp, isLiving: false });
      state.evaluationRuns.push({ id: "combined-score", evaluationId: "quality", score: 88, commit: "combined-head", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite", compositeId: "combined" });
    });
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.git = { tree: async () => "same-tree" };
    assert.equal(await orchestrator.promoteMergedCompositeBaseline("combined", "new-main"), true);
    assert.equal(store.latestRuns().get("quality").score, 88);
    assert.equal(store.latestRuns().get("quality").commit, "new-main");
    assert.equal(store.latestScreeningRuns().size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evaluation weight changes restamp open leaf impacts and PR bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-reweight-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.evaluations = [
        { id: "capability", name: "Capability", prompt: "Score", weight: 2, enabled: true, createdAt: timestamp },
        { id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp },
        { id: "parity", name: "Parity", prompt: "Score", command: "bench", weight: 3, enabled: true, createdAt: timestamp },
        { id: "integrity", name: "Integrity", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp },
      ];
      state.ideas = [{ id: "idea", title: "Improve", description: "Change it", rationale: "", predictedImpact: 1, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "run" }];
      state.agentRuns = [{ id: "run", ideaId: "idea", status: "completed", branch: "branch", worktree: "", startedAt: timestamp, completedAt: timestamp, prNumber: 42, prState: "open", deltas: [
        { evaluationId: "capability", name: "Capability", before: 40, after: 45, delta: 5 },
        { evaluationId: "quality", name: "Quality", before: 75, after: 85, delta: 10 },
        { evaluationId: "parity", name: "Parity", before: 100, after: 100, delta: 0 },
        { evaluationId: "integrity", name: "Integrity", before: 85, after: 70, delta: -15 },
      ], impact: -1.2, resources: [], reviewRounds: [], reviewApproved: true }];
    });
    const edits = [];
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.git = { editPr: async (...args) => edits.push(args) };
    await orchestrator.refreshEvaluationWeights();
    assert.equal(store.get().agentRuns[0].impact, 0.7);
    assert.equal(edits.length, 1);
    assert.match(edits[0][3], /Burner impact score: \+0\.7/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("successful experiments bind to and incrementally evolve the living composite", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-living-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const evaluation = store.get().evaluations[0];
    await store.update((state) => {
      state.orchestrator.livingCompositeId = "living";
      state.composites.push({ id: "living", title: "Year-long line", description: "", status: "open", branch: "burner/living", worktree: "", sources: [{ agentRunId: "seed-a", prNumber: 1, title: "A", branch: "a", kind: "pull_request" }, { agentRunId: "seed-b", prNumber: 2, title: "B", branch: "b", kind: "pull_request" }], deltas: [{ evaluationId: evaluation.id, name: evaluation.name, before: 75, after: 80, delta: 5 }], impact: 5, compositeScore: 80, reviewRounds: [], reviewApproved: true, prNumber: 10, prUrl: "https://example.test/pull/10", createdAt: timestamp, updatedAt: timestamp, isLiving: true, pendingExperimentRunIds: [] });
      state.evaluationRuns.push({ id: "composite-eval", evaluationId: evaluation.id, score: 80, commit: "living-head", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite", compositeId: "living" });
      state.agentRuns.push({ id: "experiment", ideaId: "idea", status: "evaluating", branch: "burner/experiment", worktree: "/tmp/worktree", startedAt: timestamp, deltas: [], impact: 4, resources: [], reviewRounds: [], reviewApproved: true, baseRef: "burner/living", baseCommit: "living-head", parentCompositeId: "living" });
    });
    const pushed = [];
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 10 });
    orchestrator.git = { fetchBranch: async () => "origin/burner/living", resolveRef: async () => "living-head", push: async (_cwd, _remote, branch) => pushed.push(branch) };
    const base = await orchestrator.resolveAgentBase({ id: "idea", title: "Experiment", description: "", rationale: "", predictedImpact: 1, evaluationIds: [], resources: [], status: "queued", createdAt: timestamp, updatedAt: timestamp, source: "manual", baseCompositeId: "living" }, store.get());
    assert.equal(base.compositeId, "living");
    assert.equal(base.baseline.get(evaluation.id).score, 80);
    await orchestrator.absorbExperiment("living", "experiment", { id: "idea", title: "Experiment", description: "", rationale: "", predictedImpact: 1, evaluationIds: [], resources: [], status: "running", createdAt: timestamp, updatedAt: timestamp, source: "manual" }, "/tmp/worktree", "burner/experiment", 4, store.get().settings);
    const state = store.get();
    const living = state.composites.find((item) => item.id === "living");
    assert.equal(state.agentRuns.find((item) => item.id === "experiment").status, "absorbed");
    assert.equal(living.status, "rebuilding");
    assert.equal(living.rebuildMode, "incremental");
    assert.deepEqual(living.pendingExperimentRunIds, ["experiment"]);
    assert.equal(living.sources.at(-1).kind, "experiment");
    assert.deepEqual(pushed, ["burner/experiment"]);
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
        { id: "candidate", evaluationId: evaluation.id, score: 99, commit: "b", createdAt: "2026-01-02T00:00:00.000Z", durationMs: 1, status: "completed", context: "agent", error: "x".repeat(20_000) },
        { id: "rejected-screen", evaluationId: evaluation.id, score: 0, summary: "Benchmark rejected: no timing score was accepted.", evidence: ["unstable timing: max/min spread 11.7"], commit: "a", createdAt: "2026-01-03T00:00:00.000Z", durationMs: 1, status: "completed", context: "screening_baseline" },
      );
    });
    assert.equal(store.latestRuns().get(evaluation.id)?.score, 61);
    assert.equal(store.latestScreeningRuns().has(evaluation.id), false);
    assert.ok(store.get().evaluationRuns.find((run) => run.id === "candidate").error.length <= 8_020);
    const reloaded = new StateStore(root);
    await reloaded.init();
    assert.equal(reloaded.get().projectName, root.split("/").at(-1));
    assert.equal(reloaded.get().version, 3);
    assert.equal(reloaded.get().settings.maxReviewRounds, 12);
    assert.equal(reloaded.get().settings.portfolioReviewRounds, 12);
    assert.equal(reloaded.get().settings.mergeCadenceMinutes, 60);
    assert.equal(reloaded.get().settings.parallelism, 1);
    assert.equal(reloaded.latestRuns().get(evaluation.id)?.score, 61);
    assert.equal(reloaded.get().evaluationRuns.find((run) => run.id === "rejected-screen").status, "failed");
    assert.deepEqual(validateEvaluation({ name: " UX ", prompt: " Score it ", weight: 2 }), { name: "UX", prompt: "Score it", weight: 2, enabled: true });
    assert.deepEqual(validateEvaluation({ name: "Bench", prompt: "Score", command: " full ", screeningCommand: " quick " }), { name: "Bench", prompt: "Score", command: "full", screeningCommand: "quick", weight: 1, enabled: true });
    assert.throws(() => validateEvaluation({ name: "Bench", prompt: "Score", screeningCommand: "quick" }), /requires a full evaluation command/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
