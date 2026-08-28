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
import { agentDispatchCadenceHeadroom, agentReviewCadenceHeadroom, assertCompositeEvaluationRevisionChanged, cachedFullMergeValidationResult, compositeRevisionHeadroom, inferIdeaResources, isAuthoritativeFullBaseline, leafPromptRecoveryHeadroom, leafValidationHeadroom, Orchestrator, partitionReviewFallbacks, portfolioMergeTailHeadroom, recoveryCompositeTitle, reusableFullAgentCommandRuns, selectYoloLeafBatch, selectYoloMergeCandidate, shouldRefillIdeaQueue } from "../dist/lib/orchestrator.js";
import { updateProgressArtifacts } from "../dist/lib/progress.js";
import { runCommand } from "../dist/lib/process.js";
import { buildCompositeDraftPrBody, buildCompositePrBody, buildPrBody, GitService, TransientMergeGateError } from "../dist/lib/git.js";
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

test("command timeouts exclude host-suspend-sized event-loop gaps", async () => {
  const started = Date.now();
  const running = runCommand("/bin/sh", ["-c", "sleep 30 & wait"], {
    cwd: process.cwd(),
    timeoutMs: 80,
    timeoutSuspendGapMs: 30,
  });
  const blockedUntil = Date.now() + 100;
  while (Date.now() < blockedUntil) {
    // Simulate the event loop resuming after a host-suspend-sized gap.
  }
  const result = await running;
  assert.equal(result.exitCode, 124);
  assert.match(result.stderr, /Command timed out after 80ms/);
  assert.ok(Date.now() - started >= 140, "suspended wall time should not consume the active execution timeout");
  assert.ok(Date.now() - started < 2_000, "the active execution timeout must still fail closed");
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

test("independent untracked sibling repositories do not trip the protected parent boundary", async () => {
  const outer = await mkdtemp(join(tmpdir(), "burner-sibling-boundary-test-"));
  const target = join(outer, "target");
  const sibling = join(outer, "another-project");
  try {
    await exec(outer, "git", ["init", "-q"]);
    await exec(outer, "git", ["config", "user.email", "burner@example.test"]);
    await exec(outer, "git", ["config", "user.name", "Burner Test"]);
    await writeFile(join(outer, ".gitignore"), "target/\n");
    await exec(outer, "git", ["add", ".gitignore"]);
    await exec(outer, "git", ["commit", "-qm", "seed"]);
    await import("node:fs/promises").then((fs) => fs.mkdir(target));
    const store = new StateStore(target);
    await store.init();
    await store.update((state) => { state.orchestrator.enabled = true; });
    const orchestrator = new Orchestrator(target, store, new EventHub());
    await orchestrator.initializeProtectedParentRepository();

    await import("node:fs/promises").then((fs) => fs.mkdir(sibling));
    await exec(sibling, "git", ["init", "-q"]);
    await writeFile(join(sibling, "README.md"), "separate workspace\n");

    await orchestrator.assertProtectedParentUnchanged();
    assert.equal(store.get().orchestrator.enabled, true);
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

test("prompt evaluators keep a four-minute default with bounded override support", async () => {
  const { DEFAULT_PROMPT_EVALUATION_TIMEOUT_MS } = await import("../dist/lib/codex.js");
  assert.equal(DEFAULT_PROMPT_EVALUATION_TIMEOUT_MS, 4 * 60 * 1000);
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

test("baseline authority is bound to the exact evaluation definition", () => {
  const evaluation = { id: "quality", name: "Quality", prompt: "Score quality", weight: 1, enabled: true, createdAt: "2026-01-01T00:00:00.000Z", definitionVersion: "definition-v2" };
  const run = { id: "run", evaluationId: "quality", score: 80, commit: "base", createdAt: "2026-01-01T00:00:00.000Z", durationMs: 1, status: "completed", context: "baseline", promptSampleCount: 3, evaluationDefinitionVersion: "definition-v2" };
  assert.equal(isAuthoritativeFullBaseline(evaluation, run, "base"), true);
  assert.equal(isAuthoritativeFullBaseline(evaluation, { ...run, evaluationDefinitionVersion: "definition-v1" }, "base"), false);
  assert.equal(isAuthoritativeFullBaseline({ ...evaluation, definitionVersion: undefined }, { ...run, evaluationDefinitionVersion: undefined }, "base"), true, "legacy definitions remain compatible until edited");
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
    await updateProgressArtifacts(root, evaluations, [
      { key: "base:def", commit: "def", recordedAt: "2026-01-04T00:00:00.000Z", label: "base def", kind: "baseline", title: "main", scores: { quality: 76, speed: 81 } },
      { key: "pr:13", recordedAt: "2026-01-04T00:00:00.000Z", label: "PR #13", kind: "composite", prNumber: 13, title: "Next", scores: { quality: 80, speed: 84 } },
    ]);
    const readme = await readFile(join(root, "README.md"), "utf8");
    const history = JSON.parse(await readFile(join(root, "docs", "burner-evaluation-history.json"), "utf8"));
    const svg = await readFile(join(root, "docs", "burner-evaluation-progress.svg"), "utf8");
    assert.match(readme, /burner-progress:start/);
    assert.match(readme, /burner-evaluation-progress\.svg/);
    assert.match(readme, /retrying a merge replaces the existing point instead of duplicating it/i);
    assert.match(readme, /malformed scores abort artifact generation/i);
    assert.equal(history.version, 2);
    assert.equal(history.updatePolicy.trigger, "successful_merge");
    assert.equal(history.updatePolicy.retryBehavior, "upsert_existing_key_preserving_original_timestamp");
    assert.equal(history.updatePolicy.scoreValidation, "all_enabled_evaluations_finite_0_to_100");
    assert.equal(history.points.length, 3);
    assert.equal(history.points[0].key, "baseline:abc");
    assert.equal(history.points[0].recordedAt, timestamp);
    assert.equal(history.points[0].scores.quality, 61);
    assert.equal(history.points[1].recordedAt, "2026-01-02T00:00:00.000Z");
    assert.equal(history.points[1].scores.quality, 76);
    assert.equal(history.points[2].key, "pr:13");
    assert.ok(!history.points.some((point) => point.key === "base:def"), "an unchanged post-merge base must not add a flat duplicate dot");
    assert.match(svg, /Quality/);
    assert.match(svg, /PR #12/);
    assert.match(svg, /PR #13/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("progress updates reject incomplete or malformed score maps before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-progress-validation-test-"));
  try {
    await writeFile(join(root, "README.md"), "# Demo\n");
    const timestamp = "2026-01-01T00:00:00.000Z";
    const evaluations = [
      { id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp },
      { id: "speed", name: "Speed", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp },
    ];
    await assert.rejects(
      updateProgressArtifacts(root, evaluations, [
        { key: "pr:1", recordedAt: timestamp, label: "PR #1", kind: "leaf", prNumber: 1, title: "Incomplete", scores: { quality: 80 } },
      ]),
      /must contain exactly every enabled evaluation score/,
    );
    await assert.rejects(
      updateProgressArtifacts(root, evaluations, [
        { key: "pr:2", recordedAt: timestamp, label: "PR #2", kind: "leaf", prNumber: 2, title: "Malformed", scores: { quality: 80, speed: Number.NaN } },
      ]),
      /invalid score/,
    );
    await assert.rejects(readFile(join(root, "docs", "burner-evaluation-history.json"), "utf8"), /ENOENT/);
    assert.equal(await readFile(join(root, "README.md"), "utf8"), "# Demo\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("merge progress causally reorders a late retry baseline before its candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-progress-retry-order-test-"));
  try {
    await writeFile(join(root, "README.md"), "# Demo\n");
    const evaluation = { id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: "2026-01-01T00:00:00.000Z" };
    await updateProgressArtifacts(root, [evaluation], [
      { key: "pr:1", recordedAt: "2026-01-01T00:00:00.000Z", label: "PR #1", kind: "composite", prNumber: 1, title: "First", scores: { quality: 60 } },
      { key: "pr:2", recordedAt: "2026-01-02T00:00:00.000Z", label: "PR #2", kind: "leaf", prNumber: 2, title: "Retried", scores: { quality: 80 } },
      { key: "base:base-1", commit: "base-1", recordedAt: "2026-01-03T00:00:00.000Z", label: "base base-1", kind: "baseline", title: "main", scores: { quality: 60 } },
    ]);
    const history = await updateProgressArtifacts(root, [evaluation], [], { 2: "base-1" });
    assert.deepEqual(history.points.map((point) => point.key), ["pr:1", "pr:2"]);
    assert.equal(history.points.at(-1).scores.quality, 80, "the graph must end at the retried candidate instead of its older base");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("progress keeps a base point when the evaluation registry changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-progress-registry-test-"));
  try {
    await writeFile(join(root, "README.md"), "# Demo\n");
    const timestamp = "2026-01-01T00:00:00.000Z";
    const quality = { id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp };
    await updateProgressArtifacts(root, [quality], [
      { key: "base:abc", commit: "abc", recordedAt: timestamp, label: "base abc", kind: "baseline", title: "main", scores: { quality: 60 } },
      { key: "pr:1", recordedAt: "2026-01-02T00:00:00.000Z", label: "PR #1", kind: "composite", prNumber: 1, title: "First", scores: { quality: 70 } },
    ]);
    const integrity = { id: "integrity", name: "Integrity", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp };
    const history = await updateProgressArtifacts(root, [quality, integrity], [
      { key: "base:def", commit: "def", recordedAt: "2026-01-03T00:00:00.000Z", label: "base def", kind: "baseline", title: "main", scores: { quality: 70, integrity: 85 } },
      { key: "pr:2", recordedAt: "2026-01-03T00:00:00.000Z", label: "PR #2", kind: "composite", prNumber: 2, title: "Second", scores: { quality: 75, integrity: 90 } },
    ]);
    assert.deepEqual(history.points.map((point) => point.key), ["base:abc", "pr:1", "base:def", "pr:2"]);
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

test("composite source normalization removes inherited Burner stamps without discarding README work", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-progress-normalization-test-"));
  try {
    await exec(root, "git", ["init", "-b", "main"]);
    await import("node:fs/promises").then((fs) => fs.mkdir(join(root, "docs")));
    const managedReadme = "# Demo\n\n<!-- burner-progress:start -->\n## Burner evaluation progress\n\nbaseline\n<!-- burner-progress:end -->\n";
    await writeFile(join(root, "README.md"), managedReadme);
    await writeFile(join(root, "docs", "burner-evaluation-history.json"), "{\"baseline\":true}\n");
    await writeFile(join(root, "docs", "burner-evaluation-progress.svg"), "<svg>baseline</svg>\n");
    await exec(root, "git", ["add", "."]);
    await exec(root, "git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "seed"]);
    const base = (await exec(root, "git", ["rev-parse", "HEAD"])).trim();
    await writeFile(join(root, "README.md"), managedReadme.replace("# Demo", "# Demo\n\nCandidate documentation").replace("baseline", "leaf stamp"));
    await writeFile(join(root, "docs", "burner-evaluation-history.json"), "{\"leaf\":true}\n");
    await writeFile(join(root, "docs", "burner-evaluation-progress.svg"), "<svg>leaf</svg>\n");
    const store = new StateStore(root);
    await store.init();
    const orchestrator = new Orchestrator(root, store, new EventHub());
    assert.equal(await orchestrator.restoreBurnerProgressFromCommit(root, base), true);
    assert.match(await readFile(join(root, "README.md"), "utf8"), /Candidate documentation/);
    assert.match(await readFile(join(root, "README.md"), "utf8"), /baseline/);
    assert.doesNotMatch(await readFile(join(root, "README.md"), "utf8"), /leaf stamp/);
    assert.equal(await readFile(join(root, "docs", "burner-evaluation-history.json"), "utf8"), "{\"baseline\":true}\n");
    assert.equal(await readFile(join(root, "docs", "burner-evaluation-progress.svg"), "utf8"), "<svg>baseline</svg>\n");
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

test("portfolio planning refills genuinely idle author slots without disrupting active work", () => {
  assert.equal(shouldRefillIdeaQueue(true, 1, 1, 0, 0), false, "an existing queued leaf must not be displaced by replanning");
  assert.equal(shouldRefillIdeaQueue(true, 0, 1, 1, 0), false, "a full author pool must not be replenished");
  assert.equal(shouldRefillIdeaQueue(true, 0, 3, 1, 0), true, "an under-filled author pool should replenish while healthy work continues");
  assert.equal(shouldRefillIdeaQueue(true, 0, 1, 0, 1), false, "a composite generation must finish before replenishment");
  assert.equal(shouldRefillIdeaQueue(true, 0, 1, 0, 0), true, "an idle empty portfolio may refill");
  assert.equal(shouldRefillIdeaQueue(false, 1, 1, 1, 0), true, "non-portfolio mode retains its queue watermark behavior");
  assert.equal(shouldRefillIdeaQueue(false, 2, 1, 0, 0), false);
});

test("composite evaluation revisions reserve enough merge-cadence headroom", () => {
  const anchor = "2026-01-01T00:00:00.000Z";
  const started = Date.parse(anchor);
  assert.deepEqual(compositeRevisionHeadroom(anchor, 60, started + 35 * 60_000), { allowed: true, remainingMs: 25 * 60_000, reserveMs: 24 * 60_000 });
  assert.deepEqual(compositeRevisionHeadroom(anchor, 60, started + 37 * 60_000), { allowed: false, remainingMs: 23 * 60_000, reserveMs: 24 * 60_000 });
  assert.equal(compositeRevisionHeadroom(undefined, 60).allowed, true);
});

test("composite admission uses the observed full validation tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-observed-composite-tail-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const currentTime = Date.now();
    const timestamp = new Date(currentTime).toISOString();
    await store.update((state) => {
      state.settings.mergeCadenceMinutes = 60;
      state.orchestrator.mergeWindowStartedAt = new Date(currentTime - 35 * 60_000).toISOString();
      state.evaluations = [
        { id: "benchmark", name: "Benchmark", prompt: "Measure", command: "./full", weight: 1, enabled: true, createdAt: timestamp, definitionVersion: "v1" },
        { id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp, definitionVersion: "v1" },
      ];
      state.evaluationRuns = [
        { id: "benchmark-run", evaluationId: "benchmark", score: 100, commit: "base", createdAt: timestamp, durationMs: 23 * 60_000, status: "completed", context: "composite", evaluationDefinitionVersion: "v1" },
        { id: "quality-run", evaluationId: "quality", score: 95, commit: "base", createdAt: timestamp, durationMs: 2 * 60_000, status: "completed", context: "composite", evaluationDefinitionVersion: "v1" },
      ];
    });

    assert.deepEqual(portfolioMergeTailHeadroom(store.get(), currentTime), {
      allowed: false,
      remainingMs: 25 * 60_000,
      requiredMs: 38 * 60_000,
    });
    assert.deepEqual(portfolioMergeTailHeadroom(store.get(), currentTime, "evaluation"), {
      allowed: false,
      remainingMs: 25 * 60_000,
      requiredMs: 33 * 60_000,
    }, "integration margin is consumed before the full-evaluation recheck");
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 2 });
    assert.equal(orchestrator.cadenceCompositeTailExhausted(store.get()), true,
      "Burner must not begin a composite whose observed validation tail cannot meet cadence");
    assert.throws(() => orchestrator.assertCompositeEvaluationHeadroom(store.get()),
      /stopped before full evaluation.*25\.0 minutes remain.*33 minutes/i,
      "headroom must be rechecked against only the still-unrun tail after integration and review");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    fullMergeValidation: { baseCommit, candidateCommit, evaluationFingerprint, qualified: false, completedAt },
  }, baseCommit, candidateCommit, evaluationFingerprint, true), true, "cached scores are reinterpreted when qualification semantics change");
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

test("full leaf validation reuses exact-head full command results but not quick screens", () => {
  const createdAt = "2026-01-01T00:00:00.000Z";
  const completed = (evaluationId, overrides = {}) => ({
    id: `run-${evaluationId}`,
    evaluationId,
    commit: "candidate",
    createdAt,
    durationMs: 1,
    status: "completed",
    score: 80,
    context: "agent",
    agentRunId: "leaf",
    evaluationDefinitionVersion: "v1",
    ...overrides,
  });
  const state = {
    evaluations: [
      { id: "full", enabled: true, command: "full", definitionVersion: "v1" },
      { id: "screened", enabled: true, command: "full", screeningCommand: "quick", definitionVersion: "v1" },
      { id: "prompt", enabled: true, definitionVersion: "v1" },
      { id: "disabled", enabled: false, command: "full", definitionVersion: "v1" },
    ],
    evaluationRuns: [
      completed("full"),
      completed("screened"),
      completed("screened", { id: "run-screened-full", context: "composite" }),
      completed("prompt"),
      completed("disabled"),
      completed("full", { id: "wrong-commit", commit: "old" }),
      completed("full", { id: "wrong-definition", evaluationDefinitionVersion: "v0" }),
    ],
  };
  assert.deepEqual(reusableFullAgentCommandRuns(state, "leaf", "candidate").map((run) => run.id), ["run-full", "run-screened-full"]);
  assert.deepEqual(reusableFullAgentCommandRuns(state, "other-leaf", "candidate"), []);
});

test("full leaf validation runs only evaluations missing from exact-head seeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-leaf-partial-validation-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    await store.update((state) => {
      state.evaluations = [
        { id: "command", name: "Command", prompt: "Measure", command: "full", weight: 1, enabled: true, createdAt: new Date().toISOString() },
        { id: "prompt", name: "Prompt", prompt: "Inspect", weight: 1, enabled: true, createdAt: new Date().toISOString() },
      ];
    });
    const commandRun = {
      id: "command-run", evaluationId: "command", commit: "candidate", createdAt: new Date().toISOString(), durationMs: 1,
      status: "completed", score: 99, context: "agent", agentRunId: "leaf",
    };
    const promptRun = {
      id: "prompt-run", evaluationId: "prompt", commit: "candidate", createdAt: new Date().toISOString(), durationMs: 1,
      status: "completed", score: 80, context: "composite", agentRunId: "leaf",
    };
    const orchestrator = new Orchestrator(root, store, new EventHub());
    const requested = [];
    orchestrator.runEvaluations = async (_context, _cwd, _agentRunId, _compositeId, evaluationIds) => {
      requested.push([...evaluationIds]);
      return [promptRun];
    };
    const runs = await orchestrator.runCandidateEvaluations("composite", root, "leaf", undefined, [commandRun]);
    assert.deepEqual(requested, [["prompt"]]);
    assert.deepEqual(runs.map((run) => run.id), ["command-run", "prompt-run"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
        fullMergeValidation: { baseCommit: "base", candidateCommit: "candidate", evaluationFingerprint: JSON.stringify({ candidateEvaluationProtocol: "baseline-anchored-v1", threshold: 0, evaluations: [] }), qualified: false, completedAt: timestamp },
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

test("leaf validation reserves the complete confirmation and merge tail", () => {
  const currentTime = Date.now();
  assert.deepEqual(leafValidationHeadroom(new Date(currentTime - 41 * 60_000).toISOString(), 60, currentTime), {
    allowed: true,
    remainingMs: 19 * 60_000,
    reserveMs: 18 * 60_000,
  });
  assert.deepEqual(leafValidationHeadroom(new Date(currentTime - 43 * 60_000).toISOString(), 60, currentTime), {
    allowed: false,
    remainingMs: 17 * 60_000,
    reserveMs: 18 * 60_000,
  });
});

test("exact-head command completion permits a shorter prompt-only recovery tail", () => {
  const currentTime = Date.now();
  assert.deepEqual(leafPromptRecoveryHeadroom(new Date(currentTime - 47 * 60_000).toISOString(), 60, currentTime), {
    allowed: true,
    remainingMs: 13 * 60_000,
    reserveMs: 12 * 60_000,
  });
  assert.deepEqual(leafPromptRecoveryHeadroom(new Date(currentTime - 49 * 60_000).toISOString(), 60, currentTime), {
    allowed: false,
    remainingMs: 11 * 60_000,
    reserveMs: 12 * 60_000,
  });
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
    assert.equal(agentDispatchCadenceHeadroom(store.get(), "base", currentTime).allowed, false,
      "a late replacement must not displace an independently mergeable fallback");

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

    await store.update((state) => {
      state.ideas.push({ id: "replacement-idea", title: "Smaller fallback", description: "Narrow work", rationale: "", predictedImpact: 1, evaluationIds: [], resources: [], status: "queued", createdAt: timestamp, updatedAt: timestamp, source: "planner" });
    });
    assert.deepEqual(agentReviewCadenceHeadroom(store.get(), "base", "current", currentTime), {
      allowed: true,
      remainingMs: 19 * 60_000,
      requiredMs: 0,
    }, "a queued idea must not discard a candidate that already reached review");

    assert.deepEqual(agentDispatchCadenceHeadroom(store.get(), "base", currentTime), {
      allowed: true,
      remainingMs: 19 * 60_000,
      requiredMs: 0,
    }, "without a mergeable fallback, idling would only make the cadence miss worse");

    await store.update((state) => {
      state.orchestrator.mergeWindowStartedAt = new Date(currentTime - 9 * 60_000).toISOString();
    });
    assert.deepEqual(agentReviewCadenceHeadroom(store.get(), "base", "current", currentTime), {
      allowed: true,
      remainingMs: 51 * 60_000,
      requiredMs: 0,
    });

    await store.update((state) => {
      state.orchestrator.mergeWindowStartedAt = new Date(currentTime - 41 * 60_000).toISOString();
      const current = state.agentRuns.find((run) => run.id === "current");
      current.cadenceFallback = true;
    });
    assert.deepEqual(agentReviewCadenceHeadroom(store.get(), "base", "current", currentTime), {
      allowed: true,
      remainingMs: 19 * 60_000,
      requiredMs: 0,
    }, "a queued replacement cannot recursively evict a cadence fallback");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("YOLO keeps authoring when idling cannot preserve the merge cadence", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-dispatch-cadence-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const currentTime = Date.now();
    const timestamp = new Date(currentTime).toISOString();
    await store.update((state) => {
      state.settings.mergeCadenceMinutes = 40;
      state.settings.parallelism = 1;
      state.orchestrator.enabled = true;
      state.orchestrator.mergeWindowStartedAt = new Date(currentTime - 20 * 60_000).toISOString();
      state.ideas.push({ id: "queued", title: "Candidate", description: "Narrow work", rationale: "Improve", predictedImpact: 1, evaluationIds: [], resources: [], status: "queued", createdAt: timestamp, updatedAt: timestamp, source: "planner" });
    });

    assert.deepEqual(agentDispatchCadenceHeadroom(store.get(), "base", currentTime), {
      allowed: true,
      remainingMs: 20 * 60_000,
      requiredMs: 0,
    });

    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 2 });
    orchestrator.git = { resolveRef: async () => "base" };
    orchestrator.locks = { tryAcquireAll: async () => ({ locks: [], release: async () => {} }) };
    let dispatched = false;
    let cadenceFallback = false;
    orchestrator.runIdea = async (...args) => { dispatched = true; cadenceFallback = args[5]; };
    await orchestrator.schedule();
    assert.equal(dispatched, true, "Burner must start the only path to a candidate instead of idling until the deadline");

    await store.update((state) => {
      state.orchestrator.mergeWindowStartedAt = new Date(currentTime - 10 * 60_000).toISOString();
      state.agentRuns.push({
        id: "yielded", ideaId: "yielded-idea", status: "failed", branch: "burner/yielded", worktree: "", startedAt: timestamp,
        completedAt: timestamp, baseCommit: "base", deltas: [], resources: [], reviewRounds: [],
        quarantinedAt: timestamp, quarantineReason: "Review yielded with 30 minutes left so fallback work can use the merge reserve.",
      });
    });
    assert.equal(agentDispatchCadenceHeadroom(store.get(), "base", currentTime).allowed, true);
    dispatched = false;
    orchestrator.activeAgents.clear();
    await orchestrator.schedule();
    assert.equal(dispatched, true);
    assert.equal(cadenceFallback, true, "the replacement dispatched after a cadence yield must be marked as the fallback");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("living-composite experiments reserve cadence against the mergeable main-based composite", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-living-cadence-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const currentTime = Date.now();
    const timestamp = new Date(currentTime).toISOString();
    const evaluation = store.get().evaluations[0];
    const approvedRound = { id: "approved", round: 1, commit: "living-head", approved: true, summary: "Approved", findings: [], createdAt: timestamp };
    await store.update((state) => {
      state.evaluations = [evaluation];
      state.settings.mergeCadenceMinutes = 40;
      state.settings.parallelism = 1;
      state.orchestrator.enabled = true;
      state.orchestrator.mergeWindowStartedAt = new Date(currentTime - 20 * 60_000).toISOString();
      state.orchestrator.livingCompositeId = "living";
      state.ideas.push({ id: "queued", title: "Extend living", description: "Narrow work", rationale: "Improve", predictedImpact: 1, evaluationIds: [], resources: [], status: "queued", createdAt: timestamp, updatedAt: timestamp, source: "planner" });
      state.composites.push({
        id: "living", title: "Living line", description: "", status: "open", branch: "burner/living", worktree: "", baseCommit: "main-base",
        sources: [], deltas: [{ evaluationId: evaluation.id, name: evaluation.name, before: 80, after: 80, delta: 0 }], impact: 0,
        reviewRounds: [approvedRound], reviewApproved: true, prNumber: 10, prState: "open", createdAt: timestamp, updatedAt: timestamp, isLiving: true,
      });
      state.agentRuns.push({
        id: "experiment", ideaId: "experiment-idea", status: "reviewing", branch: "burner/experiment", worktree: root, startedAt: timestamp,
        baseRef: "burner/living", baseCommit: "living-head", parentCompositeId: "living", deltas: [], resources: [], reviewRounds: [],
      });
    });

    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 2 });
    orchestrator.git = {
      fetchBranch: async () => "origin/burner/living",
      resolveRef: async (ref) => ref === "main" ? "main-base" : "living-head",
    };
    orchestrator.locks = { tryAcquireAll: async () => ({ locks: [], release: async () => {} }) };
    let dispatched = false;
    orchestrator.runIdea = async () => { dispatched = true; };
    await orchestrator.schedule();
    assert.equal(dispatched, false, "the open living composite must keep the remaining merge reserve");
    assert.match(store.get().activity[0].message, /dispatch held for merge cadence/i);

    await store.update((state) => {
      state.orchestrator.mergeWindowStartedAt = new Date(currentTime - 28 * 60_000).toISOString();
    });
    let reviewed = false;
    orchestrator.codex = { review: async () => { reviewed = true; throw new Error("review should not start"); } };
    await assert.rejects(
      () => orchestrator.reviewAgent(root, "experiment", "Experiment", "burner/living", "thread", store.get().settings),
      /yielded its slot to preserve the merge cadence reserve/,
    );
    assert.equal(reviewed, false, "a living experiment must yield review time to its main-based composite fallback");
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

test("headless CLI mutations preserve live daemon state and are refreshed without lost updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-cli-live-state-test-"));
  const cli = join(process.cwd(), "dist", "cli.js");
  try {
    const daemonStore = new StateStore(root);
    await daemonStore.init();
    const timestamp = new Date().toISOString();
    await daemonStore.update((state) => {
      state.orchestrator.enabled = true;
      state.ideas.push({ id: "live-idea", title: "Live work", description: "Keep running", rationale: "Test", predictedImpact: 1, evaluationIds: [], resources: [], status: "running", source: "manual", createdAt: timestamp, updatedAt: timestamp, agentRunId: "live-agent" });
      state.agentRuns.push({ id: "live-agent", ideaId: "live-idea", status: "evaluating", branch: "burner/live", worktree: root, startedAt: timestamp, deltas: [], resources: [], reviewRounds: [] });
    });

    const queued = JSON.parse(await exec(root, "node", [cli, "idea", "add", "-C", root, "--title", "External idea", "--description", "Must survive the daemon's next write", "--impact", "99"]));
    assert.equal(queued.status, "queued");
    assert.equal(daemonStore.get().ideas.some((idea) => idea.id === queued.id), false, "the daemon refresh boundary is explicit");
    assert.equal(await daemonStore.refresh(), true);
    assert.equal(daemonStore.get().ideas.some((idea) => idea.id === queued.id), true);
    assert.equal(daemonStore.get().orchestrator.enabled, true);
    assert.equal(daemonStore.get().agentRuns.find((run) => run.id === "live-agent")?.status, "evaluating");

    await daemonStore.addActivity({ type: "system", message: "Daemon kept running" });
    const reloaded = new StateStore(root);
    await reloaded.init({ recoverInterrupted: false });
    assert.equal(reloaded.get().ideas.some((idea) => idea.id === queued.id), true, "a later daemon write must retain the CLI idea");
    assert.equal(reloaded.get().orchestrator.enabled, true, "CLI initialization must not pause a live server");
    assert.equal(reloaded.get().agentRuns.find((run) => run.id === "live-agent")?.status, "evaluating", "CLI initialization must not fail live work");

    await assert.rejects(
      () => exec(root, "node", [cli, "queue", "run-next", "-C", root]),
      /Burner server is active/,
      "orchestration commands must fail clearly instead of starting a competing orchestrator",
    );
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
    await writeFile(evaluator, `#!/bin/sh\nprintf '%s\\n' '{"score":0,"summary":"Benchmark rejected: no timing score was accepted.","evidence":["primary timing saturated: every case reached the parity cap"],"suggestions":[]}'\n`);
    await assert.rejects(
      () => new CodexClient().evaluate(root, { id: "bench", name: "Benchmark", prompt: "Measure it", command: evaluator, weight: 1, enabled: true, createdAt: new Date().toISOString() }, settings, "manual"),
      /inconclusive measurement.*Benchmark rejected/s,
    );
    await writeFile(evaluator, `#!/bin/sh\nprintf '%09000d\\n' 0 >&2\nprintf '%s\\n' '{"score":0,"summary":"Benchmark rejected: no timing score was accepted.","evidence":["primary timing saturated: every case reached the parity cap"],"suggestions":[]}'\nexit 1\n`);
    await assert.rejects(
      () => new CodexClient().evaluate(root, { id: "bench", name: "Benchmark", prompt: "Measure it", command: evaluator, weight: 1, enabled: true, createdAt: new Date().toISOString() }, settings, "manual"),
      /primary timing saturated/,
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

test("baseline completion rechecks evaluations added while the suite is running", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-live-evaluation-registry-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.evaluations = [{ id: "first", name: "First", prompt: "Measure", command: "full", weight: 1, enabled: true, createdAt: timestamp }];
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 3 });
    orchestrator.git = { resolveRef: async () => "base" };
    orchestrator.runEvaluations = async (context) => {
      const run = { id: "first-run", evaluationId: "first", score: 80, commit: "base", createdAt: timestamp, durationMs: 1, status: "completed", context };
      await store.update((state) => {
        state.evaluationRuns.push(run);
        state.evaluations.push({ id: "second", name: "Second", prompt: "Measure", command: "full-2", weight: 1, enabled: true, createdAt: timestamp });
      });
      return [run];
    };
    await orchestrator.runBaselineEvaluations("baseline");
    assert.equal(store.get().orchestrator.lastEvaluationAt, undefined);
    assert.equal(store.get().orchestrator.mergeWindowStartedAt, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prompt baselines are median-confirmed before the cadence clock starts and then reused", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-baseline-median-clock-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.evaluations = [{ id: "quality", name: "Quality", prompt: "Score quality", weight: 1, enabled: true, createdAt: timestamp }];
      state.evaluationRuns.push({ id: "baseline-seed", evaluationId: "quality", score: 90, commit: "base", createdAt: timestamp, durationMs: 1, status: "completed", context: "baseline" });
      state.orchestrator.lastEvaluationAt = undefined;
      state.orchestrator.mergeWindowStartedAt = undefined;
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 3 });
    orchestrator.git = { resolveRef: async () => "base" };
    const calls = [];
    orchestrator.runEvaluations = async (context, _cwd, _agentRunId, _compositeId, evaluationIds) => {
      assert.equal(store.get().orchestrator.mergeWindowStartedAt, undefined, "the clock must remain stopped during every confirmation attempt");
      calls.push({ context, evaluationIds });
      if (calls.length === 1) return [{ id: "timeout", evaluationId: "quality", commit: "base", createdAt: timestamp, durationMs: 1, status: "failed", error: "timed out", context: "baseline" }];
      const score = calls.length === 2 ? 85 : 80;
      return [{ id: `sample-${calls.length}`, evaluationId: "quality", score, commit: "base", createdAt: timestamp, durationMs: 1, status: "completed", context: "baseline" }];
    };
    await orchestrator.runBaselineEvaluations("baseline");
    assert.deepEqual(calls, [
      { context: "baseline", evaluationIds: ["quality"] },
      { context: "baseline", evaluationIds: ["quality"] },
      { context: "baseline", evaluationIds: ["quality"] },
    ]);
    assert.equal(store.latestRuns().get("quality").score, 85);
    assert.equal(store.latestRuns().get("quality").promptSampleCount, 3);
    assert.ok(store.get().orchestrator.lastEvaluationAt);
    assert.ok(store.get().orchestrator.mergeWindowStartedAt);
    assert.ok(store.get().activity.some((item) => item.message === "Retrying 1 incomplete prompt confirmation sample for the baseline"));
    const anchoredAt = store.get().orchestrator.mergeWindowStartedAt;
    await orchestrator.runBaselineEvaluations("baseline");
    assert.equal(calls.length, 3, "a persisted baseline median must not be sampled again");
    assert.equal(store.get().orchestrator.mergeWindowStartedAt, anchoredAt);
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
      state.evaluationRuns.push({ id: "done-run", evaluationId: "done", score: 95, commit: "base", createdAt: timestamp, durationMs: 1, status: "completed", context: "baseline", promptSampleCount: 3 });
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 10 });
    orchestrator.git = { resolveRef: async () => "base" };
    const calls = [];
    orchestrator.runEvaluations = async (context, _cwd, _agentRunId, _compositeId, evaluationIds) => {
      calls.push({ context, evaluationIds });
      const run = { id: `run-${calls.length}`, evaluationId: "missing", score: 92, commit: "base", createdAt: new Date().toISOString(), durationMs: 1, status: "completed", context };
      await store.update((state) => state.evaluationRuns.push(run));
      return [run];
    };
    await orchestrator.runBaselineEvaluations("baseline");
    assert.deepEqual(calls, [
      { context: "baseline", evaluationIds: ["missing"] },
      { context: "screening_baseline", evaluationIds: ["missing"] },
      { context: "baseline", evaluationIds: ["missing"] },
      { context: "baseline", evaluationIds: ["missing"] },
    ]);
    assert.equal(store.latestRuns().get("missing").promptSampleCount, 3);
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

test("merge-gate retry recreates a delivered worktree and sends the failure to the author", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-merge-gate-retry-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.evaluations = [];
      state.ideas.push({ id: "idea", title: "Stable CLI", description: "Fix CLI", rationale: "CI", predictedImpact: 80, evaluationIds: [], resources: [], status: "failed", source: "manual", createdAt: timestamp, updatedAt: timestamp });
      state.agentRuns.push({
        id: "agent", ideaId: "idea", status: "failed", branch: "burner/stable-cli", worktree: join(root, "removed"),
        startedAt: timestamp, completedAt: timestamp, deltas: [], resources: [], authorThreadId: "thread-1",
        baseRef: "main", baseCommit: "base", prNumber: 7, prUrl: "https://example.test/pr/7", prState: "closed",
        error: "PR #7 required check failed: Rust quality gate", quarantinedAt: timestamp,
        quarantineReason: "Merge gate rejected PR #7: Rust quality gate failed.",
        reviewApproved: true,
        reviewRounds: [{ id: "review-1", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: timestamp, completedAt: timestamp }],
        fullMergeValidation: { baseCommit: "base", candidateCommit: "candidate", evaluationFingerprint: "old", qualified: true, completedAt: timestamp },
      });
    });
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.assertCandidateDoesNotOwnProgress = async () => undefined;
    let recreated = 0;
    let changeChecks = 0;
    const reopened = [];
    orchestrator.git = {
      resolveRef: async () => "base",
      head: async (cwd) => { if (cwd.endsWith("removed")) throw new Error("missing"); return "candidate"; },
      createExistingWorktree: async () => { recreated += 1; return root; },
      hasChanges: async () => ++changeChecks > 1,
      commit: async () => "fixed",
      reopenPr: async (_cwd, number) => reopened.push(number),
    };
    let retryReview;
    orchestrator.codex = {
      revise: async (_cwd, _threadId, review) => { retryReview = review; return { threadId: "thread-2", message: "Tolerated the expected broken pipe" }; },
    };
    orchestrator.reviewAndDeliverAgent = async (_idea, _base, runId, worktree) => {
      assert.equal(worktree, root);
      await store.update((state) => { const run = state.agentRuns.find((item) => item.id === runId); if (run) run.status = "completed"; });
    };
    await orchestrator.retryAgent("agent");
    const run = store.get().agentRuns.find((item) => item.id === "agent");
    assert.equal(recreated, 1);
    assert.deepEqual(reopened, [7]);
    assert.equal(retryReview.findings[0].title, "Repair the failed merge gate");
    assert.match(retryReview.findings[0].detail, /Rust quality gate/);
    assert.equal(run.worktree, root);
    assert.equal(run.quarantinedAt, undefined);
    assert.equal(run.fullMergeValidation, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second Burner takes the next free port instead of failing", async () => {
  const first = await mkdtemp(join(tmpdir(), "burner-port-a-"));
  const second = await mkdtemp(join(tmpdir(), "burner-port-b-"));
  const occupied = await createBurnerServer({ root: first, host: "127.0.0.1", port: 0 });
  const busyPort = occupied.server.address().port;
  try {
    const scanned = await createBurnerServer({
      root: second, host: "127.0.0.1", port: busyPort, portScanLimit: 16,
    });
    try {
      assert.equal(scanned.port, scanned.server.address().port);
      assert.ok(scanned.port > busyPort, "should have moved past the busy port");
      const health = await (await fetch(`http://127.0.0.1:${scanned.port}/api/health`)).json();
      assert.equal(health.ok, true);
    } finally {
      await scanned.close();
    }

    // An explicit --port must fail loudly rather than silently moving.
    await assert.rejects(
      createBurnerServer({ root: second, host: "127.0.0.1", port: busyPort, portScanLimit: 1 }),
      /already in use/,
    );
  } finally {
    await occupied.close();
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
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
    const createdEvaluation = await created.json();
    assert.match(createdEvaluation.definitionVersion, /^evaldef_/);
    const definitionBeforeEdit = createdEvaluation.definitionVersion;
    await burner.store.update((state) => state.evaluationRuns.push({
      id: "docs-baseline", evaluationId: createdEvaluation.id, score: 80, commit: "base", createdAt: new Date().toISOString(), durationMs: 1,
      status: "completed", context: "baseline", promptSampleCount: 3, evaluationDefinitionVersion: definitionBeforeEdit,
    }));
    const updated = await fetch(`${base}/api/evaluations/${createdEvaluation.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Docs", prompt: "Score documentation comprehensively", weight: 2, enabled: true }),
    });
    assert.equal(updated.status, 200);
    const editedEvaluation = burner.store.get().evaluations.find((evaluation) => evaluation.id === createdEvaluation.id);
    assert.notEqual(editedEvaluation.definitionVersion, definitionBeforeEdit);
    assert.equal(isAuthoritativeFullBaseline(editedEvaluation, burner.store.latestRuns().get(createdEvaluation.id), "base"), false);

    const commandCreated = await fetch(`${base}/api/evaluations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bench", prompt: "Measure performance", command: "./full", weight: 3, enabled: true }),
    });
    const commandEvaluation = await commandCreated.json();
    const commandDefinition = commandEvaluation.definitionVersion;
    await burner.store.update((state) => state.evaluationRuns.push({
      id: "bench-baseline", evaluationId: commandEvaluation.id, score: 70, commit: "base", createdAt: new Date().toISOString(), durationMs: 1,
      status: "completed", context: "baseline", evaluationDefinitionVersion: commandDefinition,
    }));
    const screeningAdded = await fetch(`${base}/api/evaluations/${commandEvaluation.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bench", prompt: "Measure performance", command: "./full", screeningCommand: "./quick", weight: 3, enabled: true }),
    });
    assert.equal(screeningAdded.status, 200);
    let screenedEvaluation = burner.store.get().evaluations.find((evaluation) => evaluation.id === commandEvaluation.id);
    assert.equal(screenedEvaluation.definitionVersion, commandDefinition, "adding an unmeasured screen must preserve the unchanged full baseline");
    assert.equal(isAuthoritativeFullBaseline(screenedEvaluation, burner.store.latestRuns().get(commandEvaluation.id), "base"), true);
    await burner.store.update((state) => state.evaluationRuns.push({
      id: "bench-screen", evaluationId: commandEvaluation.id, score: 72, commit: "base", createdAt: new Date().toISOString(), durationMs: 1,
      status: "completed", context: "screening_baseline", evaluationDefinitionVersion: commandDefinition,
    }));
    const screeningChanged = await fetch(`${base}/api/evaluations/${commandEvaluation.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bench", prompt: "Measure performance", command: "./full", screeningCommand: "./quick-v2", weight: 3, enabled: true }),
    });
    assert.equal(screeningChanged.status, 200);
    screenedEvaluation = burner.store.get().evaluations.find((evaluation) => evaluation.id === commandEvaluation.id);
    assert.notEqual(screenedEvaluation.definitionVersion, commandDefinition, "changing a measured screen must invalidate its prior authority");
    assert.equal(isAuthoritativeFullBaseline(screenedEvaluation, burner.store.latestRuns().get(commandEvaluation.id), "base"), false);
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
    await rm(evolving, { recursive: true, force: true });
    const recovered = await git.createExistingWorktree("evolving", "burner/composite-test");
    assert.equal(await import("node:fs/promises").then((fs) => fs.readFile(join(recovered, "experiment.txt"), "utf8")), "win\n", "missing but registered worktrees must self-heal");
    await git.removeWorktree(recovered);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent worktrees based on remote living branches do not inherit the composite upstream", async () => {
  const outer = await mkdtemp(join(tmpdir(), "burner-agent-upstream-test-"));
  const root = join(outer, "repo");
  const remote = join(outer, "remote.git");
  try {
    await exec(outer, "git", ["init", "--bare", remote]);
    await exec(outer, "git", ["init", "-b", "main", root]);
    await writeFile(join(root, "base.txt"), "base\n");
    await exec(root, "git", ["add", "."]);
    await exec(root, "git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "base"]);
    await exec(root, "git", ["remote", "add", "origin", remote]);
    await exec(root, "git", ["push", "-u", "origin", "main"]);
    await exec(root, "git", ["switch", "-c", "burner/living"]);
    await writeFile(join(root, "living.txt"), "living\n");
    await exec(root, "git", ["add", "."]);
    await exec(root, "git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "living"]);
    await exec(root, "git", ["push", "-u", "origin", "burner/living"]);
    await exec(root, "git", ["switch", "main"]);
    await exec(root, "git", ["branch", "-D", "burner/living"]);

    const git = new GitService(root, join(root, ".burner"));
    const worktree = await git.createWorktree("agent", "burner/agent", "origin/burner/living");
    const branch = await runCommand("git", ["branch", "--show-current"], { cwd: worktree });
    const upstream = await runCommand("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: worktree });
    assert.equal(branch.stdout.trim(), "burner/agent");
    assert.notEqual(upstream.exitCode, 0, "a living-line agent must not push to the composite branch through an inherited upstream");
    await git.removeWorktree(worktree);
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

test("force-pushing a Burner-owned branch refreshes its lease before replacing a remote advance", async () => {
  const outer = await mkdtemp(join(tmpdir(), "burner-owned-push-test-"));
  const root = join(outer, "repo");
  const remote = join(outer, "remote.git");
  const other = join(outer, "other");
  try {
    await exec(outer, "git", ["init", "--bare", remote]);
    await exec(outer, "git", ["init", "-b", "main", root]);
    await writeFile(join(root, "base.txt"), "base\n");
    await exec(root, "git", ["add", "."]);
    await exec(root, "git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "base"]);
    await exec(root, "git", ["remote", "add", "origin", remote]);
    await exec(root, "git", ["push", "-u", "origin", "main"]);
    await exec(root, "git", ["switch", "-c", "burner/composite"]);
    await writeFile(join(root, "composite.txt"), "initial\n");
    await exec(root, "git", ["add", "."]);
    await exec(root, "git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "initial composite"]);
    await exec(root, "git", ["push", "-u", "origin", "burner/composite"]);
    await exec(root, "git", ["switch", "main"]);

    const git = new GitService(root, join(root, ".burner"));
    const worktree = await git.createExistingWorktree("owned", "burner/composite");
    await writeFile(join(worktree, "local.txt"), "validated\n");
    await git.commit(worktree, "validated composite");
    const validatedHead = await git.head(worktree);

    await exec(outer, "git", ["clone", remote, other]);
    await exec(other, "git", ["switch", "burner/composite"]);
    await writeFile(join(other, "remote.txt"), "unexpected\n");
    await exec(other, "git", ["add", "."]);
    await exec(other, "git", ["-c", "user.name=Other", "-c", "user.email=other@localhost", "commit", "-m", "unexpected remote advance"]);
    await exec(other, "git", ["push", "origin", "burner/composite"]);

    await git.forcePush(worktree, "origin", "burner/composite");
    const remoteHead = await runCommand("git", ["ls-remote", "--heads", "origin", "refs/heads/burner/composite"], { cwd: root });
    assert.equal(remoteHead.stdout.trim().split(/\s+/)[0], validatedHead);
    await git.removeWorktree(worktree);
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

test("GitHub PR disposition labels are mutually exclusive and initialized once", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-label-test-"));
  const bin = join(root, "bin");
  const argsLog = join(root, "gh-args.jsonl");
  await import("node:fs/promises").then((fs) => fs.mkdir(bin));
  const executable = join(bin, "gh");
  await writeFile(executable, `#!/usr/bin/env node\nconst fs=require("fs");const args=process.argv.slice(2);fs.appendFileSync(process.env.BURNER_TEST_GH_ARGS,JSON.stringify(args)+"\\n");if(args[0]==="pr"&&args[1]==="view")console.log(JSON.stringify({state:"CLOSED"}));\n`);
  await chmod(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.BURNER_TEST_GH_ARGS = argsLog;
  try {
    const git = new GitService(root, join(root, ".burner"));
    await git.openPr({ cwd: root, base: "main", branch: "composite", title: "Composite", body: "Draft", draft: true });
    await git.markPrReady(root, 42);
    await git.markPrDraft(root, 42);
    await git.reopenPr(root, 42);
    await git.markPrDisposition(root, 42, "unmerged");
    await git.markPrDisposition(root, 42, "merged");
    const calls = (await readFile(argsLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(calls.some((args) => args[0] === "pr" && args[1] === "create" && args.includes("--draft")));
    assert.ok(calls.some((args) => args[0] === "pr" && args[1] === "ready"));
    assert.ok(calls.some((args) => args[0] === "pr" && args[1] === "ready" && args.includes("--undo")));
    assert.ok(calls.some((args) => args[0] === "pr" && args[1] === "reopen"));
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
if(args[0]==="pr"&&args[1]==="view"){state.views++;if(process.env.BURNER_TEST_RESET_ONCE==="1"&&!state.reset){state.reset=1;fs.writeFileSync(path,JSON.stringify(state));console.error("read: connection reset by peer");process.exit(1);}fs.writeFileSync(path,JSON.stringify(state));const mergeable=process.env.BURNER_TEST_CONFLICT==="1"?"CONFLICTING":process.env.BURNER_TEST_ALWAYS_UNKNOWN==="1"?"UNKNOWN":state.views===1?"UNKNOWN":"MERGEABLE";const prState=process.env.BURNER_TEST_CLOSED_ONCE==="1"&&!state.reopened?"CLOSED":"OPEN";console.log(JSON.stringify({state:prState,mergeable,headRefOid:process.env.BURNER_TEST_HEAD}));process.exit(0);}
if(args[0]==="pr"&&args[1]==="reopen"){state.reopened=(state.reopened||0)+1;fs.writeFileSync(path,JSON.stringify(state));process.exit(0);}
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
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), { views: 2, checkViews: 3, merges: 2 });
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
    process.env.BURNER_TEST_NO_CHECKS = "0";
    process.env.BURNER_TEST_ALWAYS_UNKNOWN = "1";
    await git.mergePr(root, 46, head);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).merges, 4, "an exact checked head must reach the authoritative merge mutation even while GitHub reports UNKNOWN");
    process.env.BURNER_TEST_ALWAYS_UNKNOWN = "0";
    process.env.BURNER_TEST_RESET_ONCE = "1";
    await git.mergePr(root, 47, head);
    const recovered = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(recovered.reset, 1);
    assert.equal(recovered.merges, 5, "a transient GitHub inspection reset must retry without losing the validated head");
    process.env.BURNER_TEST_RESET_ONCE = "0";
    process.env.BURNER_TEST_CLOSED_ONCE = "1";
    await git.mergePr(root, 48, head);
    const reopened = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(reopened.reopened, 1, "an externally closed exact head must be reopened before merge");
    assert.equal(reopened.merges, 6);
  } finally {
    process.env.PATH = previousPath;
    delete process.env.BURNER_TEST_GH_STATE;
    delete process.env.BURNER_TEST_HEAD;
    delete process.env.BURNER_TEST_CONFLICT;
    delete process.env.BURNER_TEST_CHECK_FAIL;
    delete process.env.BURNER_TEST_NO_CHECKS;
    delete process.env.BURNER_TEST_ALWAYS_UNKNOWN;
    delete process.env.BURNER_TEST_RESET_ONCE;
    delete process.env.BURNER_TEST_CLOSED_ONCE;
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

test("composite progress stamping lease-updates the Burner-owned PR branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-composite-progress-push-test-"));
  try {
    await writeFile(join(root, "README.md"), "# Demo\n");
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.evaluations = [{ id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp }];
      state.evaluationRuns = [{ id: "baseline", evaluationId: "quality", score: 80, commit: "base", createdAt: timestamp, durationMs: 1, status: "completed", context: "baseline" }];
      state.composites.push({
        id: "composite", title: "Combined", description: "Combined work", status: "open", branch: "burner/composite", worktree: "",
        baseCommit: "base", sources: [], deltas: [{ evaluationId: "quality", name: "Quality", before: 80, after: 81, delta: 1 }],
        reviewRounds: [], reviewApproved: true, prNumber: 42, prUrl: "https://example.test/pull/42", createdAt: timestamp, updatedAt: timestamp,
      });
    });
    const orchestrator = new Orchestrator(root, store, new EventHub());
    const pushes = [];
    orchestrator.git = {
      resolveRef: async () => "base",
      createExistingWorktree: async () => root,
      hasChanges: async () => true,
      commit: async () => "stamped-head",
      forcePush: async (_cwd, _remote, branch) => pushes.push(["force", branch]),
      push: async (_cwd, _remote, branch) => pushes.push(["plain", branch]),
      head: async () => "stamped-head",
      removeWorktree: async () => undefined,
    };
    assert.equal(await orchestrator.stampProgressBeforeMerge("composite", "composite"), "stamped-head");
    assert.deepEqual(pushes, [["force", "burner/composite"]]);
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

test("YOLO merge selection prefers reviewed composites, accepts threshold-equal monotonic work, and rejects every regression", () => {
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
  state.agentRuns[0].impact = 0;
  state.agentRuns[0].deltas = deltas.map((delta) => ({ ...delta, after: delta.before, delta: 0 }));
  assert.deepEqual(selectYoloMergeCandidate(state, "base"), { kind: "agent", id: "agent", prNumber: 10, impact: 0 });
  state.settings.compositeAbsorbThreshold = 0.1;
  assert.equal(selectYoloMergeCandidate(state, "base"), undefined);
  state.settings.compositeAbsorbThreshold = 0;
  state.agentRuns[0].impact = 5;
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

test("YOLO cadence forecasting ignores one suspended-host duration outlier", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-yolo-duration-outlier-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    await store.update((state) => {
      state.settings.mergeCadenceMinutes = 60;
      state.evaluations = [
        { id: "benchmark", name: "Benchmark", prompt: "Measure", command: "./full", weight: 1, enabled: true, createdAt: timestamp },
        { id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp },
      ];
      state.evaluationRuns = [
        { id: "benchmark-a", evaluationId: "benchmark", score: 100, commit: "a", createdAt: new Date(now - 30_000).toISOString(), durationMs: 11 * 60_000, status: "completed", context: "baseline" },
        { id: "benchmark-b", evaluationId: "benchmark", score: 100, commit: "b", createdAt: new Date(now - 20_000).toISOString(), durationMs: 12 * 60_000, status: "completed", context: "composite" },
        { id: "benchmark-slept", evaluationId: "benchmark", score: 100, commit: "c", createdAt: new Date(now - 10_000).toISOString(), durationMs: 62 * 60_000, status: "completed", context: "baseline" },
        { id: "quality-a", evaluationId: "quality", score: 90, commit: "a", createdAt: new Date(now - 30_000).toISOString(), durationMs: 2 * 60_000, status: "completed", context: "baseline" },
        { id: "quality-b", evaluationId: "quality", score: 90, commit: "b", createdAt: new Date(now - 20_000).toISOString(), durationMs: 3 * 60_000, status: "completed", context: "composite" },
        { id: "quality-c", evaluationId: "quality", score: 90, commit: "c", createdAt: new Date(now - 10_000).toISOString(), durationMs: 2 * 60_000, status: "completed", context: "baseline" },
      ];
      state.orchestrator.mergeWindowStartedAt = new Date(now - 5 * 60_000).toISOString();
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 2 });
    assert.equal(orchestrator.portfolioCookDue(store.get(), "base"), false, "one sleep-inflated run must not force an immediate singleton cook");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("YOLO validates one reviewed leaf before another leaf cycle would miss cadence", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-yolo-singleton-deadline-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: timestamp };
    await store.update((state) => {
      state.settings.mergeCadenceMinutes = 60;
      state.evaluations = [
        { id: "benchmark", name: "Benchmark", prompt: "Measure", command: "./full", weight: 1, enabled: true, createdAt: timestamp },
        { id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp },
      ];
      state.evaluationRuns = [
        { id: "benchmark-run", evaluationId: "benchmark", score: 100, commit: "base", createdAt: timestamp, durationMs: 21 * 60_000, status: "completed", context: "baseline" },
        { id: "quality-run", evaluationId: "quality", score: 95, commit: "base", createdAt: timestamp, durationMs: 60_000, status: "completed", context: "baseline" },
      ];
      state.agentRuns = [{
        id: "leaf", ideaId: "idea-leaf", status: "completed", branch: "branch-leaf", worktree: "",
        startedAt: new Date(now - 14 * 60_000).toISOString(), completedAt: timestamp,
        prUrl: "https://example.test/pull/1", prNumber: 1, prState: "open", baseCommit: "base",
        deltas: [
          { evaluationId: "benchmark", name: "Benchmark", before: 100, after: 100, delta: 0 },
          { evaluationId: "quality", name: "Quality", before: 95, after: 96, delta: 1 },
        ],
        impact: 0.5, resources: [], reviewRounds: [approvedRound], reviewApproved: true,
      }];
      state.ideas.push({
        id: "idea-leaf", title: "Ready leaf", description: "", rationale: "", predictedImpact: 0.5,
        evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp,
        source: "manual", agentRunId: "leaf",
      });
      state.orchestrator.mergeWindowStartedAt = new Date(now - 5 * 60_000).toISOString();
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 2 });
    orchestrator.git = { resolveRef: async () => "base" };
    assert.equal(orchestrator.portfolioCookDue(store.get(), "base"), false, "the singleton should not merge prematurely while another leaf still fits");

    await store.update((state) => { state.orchestrator.mergeWindowStartedAt = new Date(now - 10 * 60_000).toISOString(); });
    assert.equal(orchestrator.portfolioCookDue(store.get(), "base"), true, "a nominal four-minute surplus is not enough to risk another leaf cycle");
    let merged;
    orchestrator.fullyValidateLeafForMerge = async () => true;
    orchestrator.mergeAgent = async (id) => { merged = id; return {}; };
    assert.equal(await orchestrator.autoMergeNext(), true);
    assert.equal(merged, "leaf");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("YOLO rechecks merge urgency after planning before dispatching an author", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-yolo-post-plan-cadence-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.orchestrator.enabled = true;
      state.orchestrator.lastEvaluationAt = timestamp;
      state.evaluations = [{ id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp }];
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 2 });
    orchestrator.syncPullRequests = async () => {};
    orchestrator.recordCadenceBreach = async () => {};
    orchestrator.git = { resolveRef: async () => "base" };
    orchestrator.missingBaselineEvaluations = () => [];
    orchestrator.shouldDrainForPortfolio = async () => false;
    orchestrator.scheduleComposites = async () => {};
    let mergeChecks = 0;
    orchestrator.autoMergeNext = async () => { mergeChecks += 1; return mergeChecks === 2; };
    orchestrator.autoCookNext = async () => false;
    let planned = false;
    orchestrator.plan = async () => { planned = true; return []; };
    let dispatched = false;
    orchestrator.schedule = async () => { dispatched = true; };

    await orchestrator.tick(false);
    assert.equal(planned, true);
    assert.equal(mergeChecks, 2, "merge urgency must be recomputed after planning returns");
    assert.equal(dispatched, false, "a newly urgent merge must preempt author dispatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("YOLO cooks a ready leaf batch in a free slot while an unrelated author drains", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-concurrent-cook-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.settings.parallelism = 2;
      state.orchestrator.enabled = true;
      state.orchestrator.lastEvaluationAt = timestamp;
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 2 });
    orchestrator.activeAgents.add("draining-author");
    orchestrator.syncPullRequests = async () => {};
    orchestrator.recordCadenceBreach = async () => {};
    let mergeChecks = 0;
    let cookChecks = 0;
    orchestrator.autoMergeNext = async () => { mergeChecks += 1; return false; };
    orchestrator.autoCookNext = async () => { cookChecks += 1; return true; };

    await orchestrator.tick(false);
    assert.equal(mergeChecks, 0, "main must not merge while an author still depends on the current base");
    assert.equal(cookChecks, 1, "the free slot must integrate the ready batch before its validation margin expires");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missed merge cadence opens a bounded recovery window without losing urgency", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-yolo-cadence-recovery-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.settings.mergeCadenceMinutes = 60;
      state.orchestrator.mergeWindowStartedAt = new Date(Date.now() - 61 * 60_000).toISOString();
      state.orchestrator.lastMergeCadenceAlertAt = new Date(Date.now() - 30 * 60_000).toISOString();
      state.evaluations = [{ id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp }];
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 3 });
    orchestrator.git = { resolveRef: async () => "base" };
    assert.equal(orchestrator.mergeCadenceDue(), true);
    await orchestrator.recordCadenceBreach();
    const recovered = store.get();
    assert.equal(recovered.orchestrator.mergeWindowStartedAt, recovered.orchestrator.lastMergeCadenceAlertAt);
    assert.equal(orchestrator.mergeCadenceDue(), false, "the new recovery window must have revision headroom");
    assert.equal(orchestrator.mergeCadenceUrgent(), true, "recovery must still prioritize a shortened cook or leaf fallback");
    assert.equal(compositeRevisionHeadroom(recovered.orchestrator.mergeWindowStartedAt, 60).allowed, true);
    assert.match(recovered.activity[0].detail, /fresh bounded recovery window/);
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
      state.orchestrator.mergeWindowStartedAt = new Date(now - 30 * 60_000).toISOString();
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
    assert.equal(orchestrator.portfolioCookDue(store.get(), "base"), true, "a recent 20-minute leaf must not be launched with only 30 minutes left");
    let cooked;
    orchestrator.createComposite = async (...args) => { cooked = args; return {}; };
    assert.equal(await orchestrator.autoCookNext(), true);
    assert.deepEqual(cooked[0], ["first", "second"]);
    assert.match(cooked[2], /shortened this batch early enough/);

    await store.update((state) => {
      state.orchestrator.mergeWindowStartedAt = new Date(now - 20 * 60_000).toISOString();
      for (const run of state.agentRuns) {
        run.startedAt = new Date(now - 6 * 60_000).toISOString();
        run.completedAt = new Date(now - 1 * 60_000).toISOString();
      }
      state.agentRuns.push({
        id: "failed", ideaId: "idea-failed", status: "failed", branch: "branch-failed", worktree: "",
        startedAt: new Date(now - 50 * 60_000).toISOString(), completedAt: new Date(now - 1 * 60_000).toISOString(),
        baseCommit: "base", deltas: [], resources: [], reviewRounds: [], error: "interrupted",
      });
    });
    assert.equal(orchestrator.portfolioCookDue(store.get(), "base"), false, "a failed 49-minute run must not force two healthy 5-minute leaves into an early partial batch");
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
    assert.equal(orchestrator.mergeCadenceDue(), true);
    await orchestrator.recordCadenceBreach();
    assert.equal(orchestrator.mergeCadenceDue(), false, "the real tick opens a fresh bounded window before recovery work starts");
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
    const closed = [];
    orchestrator.git = { resolveRef: async () => "base", closePr: async (_cwd, number) => closed.push(number) };
    let attempts = 0;
    orchestrator.mergeComposite = async () => { attempts += 1; throw new Error("required check failed at stamped-head"); };

    assert.equal(await orchestrator.autoMergeNext(), true);
    assert.equal(store.get().composites[0].status, "failed");
    assert.equal(store.get().composites[0].isLiving, false);
    assert.equal(store.get().orchestrator.livingCompositeId, undefined);
    assert.match(store.get().composites[0].error, /required check failed/);
    assert.equal(store.get().activity.filter((item) => item.message === "Merge gate blocked PR #234").length, 1);
    assert.deepEqual(closed, [234]);
    assert.equal(await orchestrator.autoMergeNext(), false);
    assert.equal(attempts, 1, "the same failed head must not be retried automatically");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transient merge-gate failures defer the same validated head without retiring it", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-transient-merge-gate-test-"));
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
        reviewRounds: [approvedRound], reviewApproved: true, prNumber: 235, prUrl: "https://example.test/pull/235", createdAt: timestamp, updatedAt: timestamp, isLiving: true,
      });
      state.orchestrator.livingCompositeId = "composite";
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 3 });
    orchestrator.git = { resolveRef: async () => "base" };
    let attempts = 0;
    orchestrator.mergeComposite = async () => { attempts += 1; throw new TransientMergeGateError("connection reset by peer"); };

    assert.equal(await orchestrator.autoMergeNext(), true);
    assert.equal(store.get().composites[0].status, "open");
    assert.equal(store.get().composites[0].isLiving, true);
    assert.equal(store.get().orchestrator.livingCompositeId, "composite");
    assert.equal(store.get().composites[0].error, undefined);
    assert.equal(store.get().activity.filter((item) => item.message === "Merge gate deferred PR #235").length, 1);
    assert.equal(await orchestrator.autoMergeNext(), false);
    assert.equal(attempts, 1, "the transient head must observe a retry cooldown instead of hot-looping");
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
    const closed = [];
    orchestrator.git = { resolveRef: async () => "base", closePr: async (_cwd, number, comment) => closed.push([number, comment]) };
    let attempts = 0;
    orchestrator.mergeAgent = async () => { attempts += 1; throw new Error("required check failed at stamped-head"); };

    assert.equal(await orchestrator.autoMergeNext(), true);
    assert.equal(store.get().agentRuns[0].status, "failed");
    assert.equal(store.get().agentRuns[0].prState, "closed");
    assert.ok(store.get().agentRuns[0].quarantinedAt);
    assert.match(store.get().agentRuns[0].quarantineReason, /Merge gate rejected PR #10/);
    assert.deepEqual(closed.map(([number]) => number), [10]);
    assert.match(closed[0][1], /retry the failed run to repair the same PR/i);
    assert.equal(await orchestrator.autoMergeNext(), false);
    assert.equal(attempts, 1, "the same failed leaf head must not be retried automatically");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct YOLO fully validates relaxed fallback leaves before merge", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-direct-leaf-validation-test-"));
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
        deltas: [{ evaluationId: "quality", name: "Quality", before: 80, after: 79, delta: -1 }], impact: -1,
        resources: [], reviewRounds: [approvedRound], reviewApproved: true,
      });
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 1 });
    orchestrator.git = { resolveRef: async (ref) => ref === "main" ? "base" : "candidate" };
    let validated;
    let merged = false;
    orchestrator.fullyValidateLeafForMerge = async (id) => { validated = id; return false; };
    orchestrator.mergeAgent = async () => { merged = true; return {}; };

    assert.equal(await orchestrator.autoMergeNext(), false);
    assert.equal(validated, "leaf");
    assert.equal(merged, false);
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

test("cadence-driven leaf validation symmetrically confirms prompt changes without rerunning commands", async () => {
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
    const candidateScores = [50, 55];
    const baselineScores = [50, 45];
    const confirmationCalls = [];
    orchestrator.runEvaluations = async (context, _cwd, agentRunId, compositeId, evaluationIds) => {
      assert.deepEqual(evaluationIds, ["quality"], "the command-backed benchmark must not be rerun or averaged");
      confirmationCalls.push({ context, agentRunId, compositeId });
      if (context === "baseline") {
        assert.equal(agentRunId, undefined);
        assert.equal(compositeId, undefined);
        const score = baselineScores.shift();
        return [{ id: `baseline-quality-${confirmationCalls.length}`, evaluationId: "quality", score, summary: "baseline confirmation", commit: "base", createdAt: timestamp, durationMs: 1, status: "completed", context: "baseline" }];
      }
      assert.equal(context, "composite");
      assert.equal(agentRunId, "leaf");
      assert.equal(compositeId, undefined);
      const score = candidateScores.shift();
      return [{ id: `quality-${confirmationCalls.length}`, evaluationId: "quality", score, summary: "candidate confirmation", commit: "candidate", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite", agentRunId: "leaf" }];
    };
    await orchestrator.locks.init();
    assert.equal(await orchestrator.fullyValidateLeafForMerge("leaf", "base"), true);
    assert.equal(confirmationCalls.filter((call) => call.context === "composite").length, 2);
    assert.equal(confirmationCalls.filter((call) => call.context === "baseline").length, 2);
    assert.deepEqual(store.get().agentRuns[0].deltas.map(({ evaluationId, delta }) => ({ evaluationId, delta })), [
      { evaluationId: "bench", delta: 5 },
      { evaluationId: "quality", delta: 0 },
    ]);
    assert.equal(store.latestRuns().get("quality").score, 50);
    assert.equal(store.latestRuns().get("quality").promptSampleCount, 3);
    assert.ok(store.get().activity.some((item) => item.message === "Confirming 1 prompt change for PR #10"));
    assert.ok(store.get().activity.some((item) => item.detail.includes("both the baseline and candidate")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("composite prompt gains use a persisted median without rerunning commands", async () => {
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
        { id: "baseline-quality", evaluationId: "quality", score: 50, commit: "base", createdAt: timestamp, durationMs: 1, status: "completed", context: "baseline", promptSampleCount: 3 },
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
      { id: "quality-after", evaluationId: "quality", score: 60, summary: "noisy high", commit: "candidate", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite", compositeId: "combined" },
    ];
    const confirmed = await orchestrator.confirmPromptChanges(root, store.latestRuns(), initial, "composite PR #99", undefined, "combined");
    assert.equal(confirmed.find((run) => run.evaluationId === "quality").score, 55);
    assert.equal(confirmed.find((run) => run.evaluationId === "bench").score, 95);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.context === "composite" && call.agentRunId === undefined && call.compositeId === "combined"));
    assert.ok(calls.every((call) => JSON.stringify(call.evaluationIds) === JSON.stringify(["quality"])), "command-backed evaluations must not be confirmed or softened");
    assert.equal(store.latestCompositeRuns("combined").get("quality").score, 55, "the promoted baseline must use the confirmed median");
    assert.ok(store.get().activity.some((item) => item.message === "Confirming 1 prompt change for composite PR #99"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a confirmed baseline median prevents a noisy single sample from inventing a regression", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-symmetric-baseline-confirmation-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.evaluations = [{ id: "integrity", name: "Integrity", prompt: "Score integrity", weight: 1, enabled: true, createdAt: timestamp }];
      state.evaluationRuns.push({ id: "baseline-high", evaluationId: "integrity", score: 90, commit: "base", createdAt: timestamp, durationMs: 1, status: "completed", context: "baseline" });
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 3 });
    const candidateScores = [85, 90];
    const baselineScores = [85, 85];
    const calls = [];
    orchestrator.runEvaluations = async (context, _cwd, _agentRunId, _compositeId, evaluationIds) => {
      assert.deepEqual(evaluationIds, ["integrity"]);
      calls.push(context);
      const baseline = context === "baseline";
      const score = (baseline ? baselineScores : candidateScores).shift();
      return [{
        id: `${context}-${calls.length}`,
        evaluationId: "integrity",
        score,
        summary: "confirmation",
        commit: baseline ? "base" : "candidate",
        createdAt: timestamp,
        durationMs: 1,
        status: "completed",
        context,
      }];
    };
    const baseline = store.latestRuns();
    const initial = [{ id: "candidate-low", evaluationId: "integrity", score: 85, commit: "candidate", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite" }];
    const confirmed = await orchestrator.confirmPromptChanges(root, baseline, initial, "composite PR #99", undefined, "combined");
    assert.equal(confirmed.find((run) => run.evaluationId === "integrity").score, 85);
    assert.equal(baseline.get("integrity").score, 85, "comparison must use the confirmed baseline median, not its noisy first sample");
    assert.equal(baseline.get("integrity").promptSampleCount, 3);
    assert.equal(store.latestRuns().get("integrity").score, 85);
    assert.equal(store.latestRuns().get("integrity").promptSampleCount, 3);
    assert.equal(calls.filter((context) => context === "baseline").length, 2);
    assert.equal(calls.filter((context) => context === "composite").length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prompt change confirmation retries only incomplete samples once", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-prompt-confirmation-retry-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.evaluations = [
        { id: "quality", name: "Quality", prompt: "Score quality", weight: 1, enabled: true, createdAt: timestamp },
        { id: "integrity", name: "Integrity", prompt: "Score integrity", weight: 1, enabled: true, createdAt: timestamp },
      ];
      state.evaluationRuns.push(
        { id: "baseline-quality", evaluationId: "quality", score: 80, commit: "base", createdAt: timestamp, durationMs: 1, status: "completed", context: "baseline", promptSampleCount: 3 },
        { id: "baseline-integrity", evaluationId: "integrity", score: 90, commit: "base", createdAt: timestamp, durationMs: 1, status: "completed", context: "baseline", promptSampleCount: 3 },
      );
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 3 });
    const calls = [];
    orchestrator.runEvaluations = async (_context, _cwd, _agentRunId, _compositeId, evaluationIds) => {
      calls.push(evaluationIds);
      if (calls.length === 1) return [
        { id: "quality-a", evaluationId: "quality", score: 80, commit: "candidate", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite" },
        { id: "integrity-timeout", evaluationId: "integrity", commit: "candidate", createdAt: timestamp, durationMs: 1, status: "failed", error: "timed out", context: "composite" },
      ];
      if (calls.length === 2) return [
        { id: "quality-b", evaluationId: "quality", score: 85, commit: "candidate", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite" },
        { id: "integrity-b", evaluationId: "integrity", score: 90, commit: "candidate", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite" },
      ];
      return [{ id: "integrity-retry", evaluationId: "integrity", score: 95, commit: "candidate", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite" }];
    };
    const initial = [
      { id: "quality-low", evaluationId: "quality", score: 75, commit: "candidate", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite" },
      { id: "integrity-low", evaluationId: "integrity", score: 85, commit: "candidate", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite" },
    ];
    const confirmed = await orchestrator.confirmPromptChanges(root, store.latestRuns(), initial, "PR #10", "leaf");
    assert.deepEqual(calls, [["quality", "integrity"], ["quality", "integrity"], ["integrity"]]);
    assert.equal(confirmed.find((run) => run.evaluationId === "quality").score, 80);
    assert.equal(confirmed.find((run) => run.evaluationId === "integrity").score, 90);
    assert.ok(store.get().activity.some((item) => item.message === "Retrying 1 incomplete prompt confirmation sample for PR #10"));
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

test("cadence fallback skips an unchanged rejected leaf and validates the next candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-fallback-skip-rejected-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: timestamp };
    const fingerprint = JSON.stringify({ candidateEvaluationProtocol: "baseline-anchored-v1", threshold: 0, evaluations: [{ id: "quality", name: "Quality", prompt: "Score", weight: 1 }] });
    const leaf = (id, number, commit, impact) => ({
      id, ideaId: `idea-${id}`, status: "completed", branch: `burner/${id}`, worktree: "", startedAt: timestamp, completedAt: timestamp,
      prNumber: number, prUrl: `https://example.test/pull/${number}`, prState: "open", baseCommit: "base",
      deltas: [{ evaluationId: "quality", name: "Quality", before: 50, after: 45, delta: -5 }], impact, resources: [],
      reviewRounds: [approvedRound], reviewApproved: true,
      ...(id === "first" ? { fullMergeValidation: { baseCommit: "base", candidateCommit: commit, evaluationFingerprint: fingerprint, qualified: false, completedAt: timestamp } } : {}),
    });
    await store.update((state) => {
      state.evaluations = [{ id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp }];
      state.ideas.push(
        { id: "idea-first", title: "First", description: "", rationale: "", predictedImpact: 1, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "first" },
        { id: "idea-second", title: "Second", description: "", rationale: "", predictedImpact: 1, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "second" },
      );
      state.agentRuns.push(leaf("first", 10, "first-head", -1), leaf("second", 11, "second-head", -2));
      state.composites.push({ id: "failed", title: "Failed", description: "", status: "failed", branch: "burner/failed", worktree: "", baseCommit: "base", sources: [], deltas: [], reviewRounds: [], createdAt: timestamp, updatedAt: timestamp, isLiving: false });
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 3 });
    orchestrator.git = { resolveRef: async (ref) => ref === "main" ? "base" : ref === "burner/first" ? "first-head" : "second-head" };
    let validated;
    let merged;
    orchestrator.fullyValidateLeafForMerge = async (id) => {
      validated = id;
      await store.update((state) => {
        const run = state.agentRuns.find((item) => item.id === id);
        run.deltas = [{ evaluationId: "quality", name: "Quality", before: 50, after: 55, delta: 5 }];
        run.impact = 5;
      });
      return true;
    };
    orchestrator.mergeAgent = async (id) => { merged = id; return {}; };
    assert.equal(await orchestrator.autoMergeNext(), true);
    assert.equal(validated, "second");
    assert.equal(merged, "second");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("late cadence tail keeps the only merge path moving and prefers reusable full commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-late-leaf-validation-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: timestamp };
    await store.update((state) => {
      state.settings.mergeCadenceMinutes = 60;
      state.orchestrator.mergeWindowStartedAt = new Date(Date.now() - 43 * 60_000).toISOString();
      state.evaluations = [{ id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp }];
      state.ideas.push({ id: "idea", title: "Healthy leaf", description: "Improve", rationale: "", predictedImpact: 1, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "leaf" });
      state.agentRuns.push({
        id: "leaf", ideaId: "idea", status: "completed", branch: "burner/leaf", worktree: "", startedAt: timestamp, completedAt: timestamp,
        prNumber: 10, prUrl: "https://example.test/pull/10", prState: "open", baseCommit: "base",
        deltas: [{ evaluationId: "quality", name: "Quality", before: 50, after: 55, delta: 5 }], impact: 5,
        resources: [], reviewRounds: [approvedRound], reviewApproved: true,
      });
      state.composites.push({ id: "failed", title: "Failed", description: "", status: "failed", branch: "burner/failed", worktree: "", baseCommit: "base", sources: [], deltas: [], reviewRounds: [], createdAt: timestamp, updatedAt: timestamp, isLiving: false });
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 3 });
    orchestrator.git = { resolveRef: async (ref) => ref === "main" ? "base" : "candidate" };
    let validated = 0;
    let merged;
    orchestrator.fullyValidateLeafForMerge = async () => { validated += 1; return true; };
    orchestrator.mergeAgent = async (id) => { merged = id; return {}; };

    assert.equal(await orchestrator.autoMergeNext(), true);
    assert.equal(validated, 1, "idling cannot preserve cadence when no cheaper validated fallback exists");
    assert.equal(merged, "leaf");

    await store.update((state) => {
      state.evaluations.push({ id: "bench", name: "Benchmark", prompt: "Measure", command: "full", screeningCommand: "quick", definitionVersion: "v1", weight: 1, enabled: true, createdAt: timestamp });
      state.agentRuns[0].deltas.push({ evaluationId: "bench", name: "Benchmark", before: 90, after: 90, delta: 0, screening: true });
      state.evaluationRuns.push({
        id: "full-bench", evaluationId: "bench", score: 90, commit: "candidate", createdAt: timestamp,
        durationMs: 1, status: "completed", context: "composite", agentRunId: "leaf", evaluationDefinitionVersion: "v1",
      });
    });
    validated = 0;
    merged = undefined;
    assert.equal(await orchestrator.autoMergeNext(), true);
    assert.equal(validated, 1);
    assert.equal(merged, "leaf");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("composite tail falls back to one reviewed leaf even when two leaves could form a late batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-composite-tail-leaf-fallback-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: timestamp };
    const leaf = (id, number, impact) => ({
      id,
      ideaId: `idea-${id}`,
      status: "completed",
      branch: `burner/${id}`,
      worktree: "",
      startedAt: timestamp,
      completedAt: timestamp,
      prNumber: number,
      prState: "open",
      baseCommit: "base",
      deltas: [{ evaluationId: "quality", name: "Quality", before: 50, after: 55, delta: 5 }],
      impact,
      resources: [],
      reviewRounds: [approvedRound],
      reviewApproved: true,
    });
    await store.update((state) => {
      state.settings.mergeCadenceMinutes = 60;
      state.orchestrator.mergeWindowStartedAt = new Date(Date.now() - 40 * 60_000).toISOString();
      state.evaluations = [{ id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp }];
      state.ideas.push(
        { id: "idea-first", title: "First", description: "", rationale: "", predictedImpact: 5, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "first" },
        { id: "idea-second", title: "Second", description: "", rationale: "", predictedImpact: 4, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "second" },
      );
      state.agentRuns.push(leaf("first", 10, 5), leaf("second", 11, 4));
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 3 });
    orchestrator.git = { resolveRef: async (ref) => ref === "main" ? "base" : `${ref}-head` };
    let validated;
    let merged;
    orchestrator.fullyValidateLeafForMerge = async (id) => { validated = id; return true; };
    orchestrator.mergeAgent = async (id) => { merged = id; return {}; };

    assert.deepEqual(selectYoloLeafBatch(store.get(), "base", 3, 2), ["first", "second"]);
    assert.equal(orchestrator.cadenceCompositeTailExhausted(), true);
    assert.equal(await orchestrator.autoMergeNext(), true);
    assert.equal(validated, "first");
    assert.equal(merged, "first");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("late cadence tail holds new composites and agent dispatch before or after a breach", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-late-recovery-hold-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.settings.mergeCadenceMinutes = 60;
      state.orchestrator.mergeWindowStartedAt = new Date(Date.now() - 40 * 60_000).toISOString();
      state.evaluations = [{ id: "quality", name: "Quality", prompt: "Score", weight: 1, enabled: true, createdAt: timestamp }];
    });
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 3 });
    let cooked = false;
    orchestrator.createComposite = async () => { cooked = true; return {}; };
    assert.equal(orchestrator.cadenceCompositeTailExhausted(), true);
    assert.equal(await orchestrator.autoCookNext(), false);
    assert.equal(cooked, false);
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

test("recovery composites advertise and review only their authoritative surviving sources", async () => {
  assert.equal(
    recoveryCompositeTitle("YOLO generation 7: 3 reviewed improvements", 2, 1, 1),
    "YOLO generation 7: 2 reviewed improvements · recovery 1/1",
  );

  const root = await mkdtemp(join(tmpdir(), "burner-recovery-review-scope-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.settings.portfolioReviewRounds = 1;
      state.composites.push({
        id: "recovery", title: "YOLO generation 7: 2 reviewed improvements · recovery 1/1",
        description: "Burner removed quarantined PR #310; only the surviving sources belong in this recovery.",
        status: "reviewing", branch: "recovery", worktree: root,
        sources: [
          { agentRunId: "a", prNumber: 309, title: "Stream SELECT results", branch: "a", kind: "pull_request" },
          { agentRunId: "b", prNumber: 311, title: "Persist one table", branch: "b", kind: "pull_request" },
        ],
        deltas: [], reviewRounds: [], createdAt: timestamp, updatedAt: timestamp, isLiving: false,
      });
    });
    let reviewedScope = "";
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 3 });
    orchestrator.git = { head: async () => "head" };
    orchestrator.publishCompositeDraft = async () => undefined;
    orchestrator.codex = {
      review: async (_cwd, _base, scope) => {
        reviewedScope = scope;
        return { approved: true, summary: "Approved", findings: [] };
      },
    };
    await orchestrator.reviewComposite(root, "recovery", "YOLO generation 7: 2 reviewed improvements · recovery 1/1", "main", "thread", store.get().settings);
    assert.match(reviewedScope, /Authoritative composite scope/);
    assert.match(reviewedScope, /PR #309: Stream SELECT results/);
    assert.match(reviewedScope, /PR #311: Persist one table/);
    assert.match(reviewedScope, /removed quarantined PR #310/);
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
    const reopened = [];
    orchestrator.git = { reopenPr: async (_cwd, number) => reopened.push(number) };
    orchestrator.scheduleComposites = async () => undefined;
    await orchestrator.retryComposite("failed");
    assert.deepEqual(reopened, [10]);
    assert.equal(store.get().composites[0].status, "rebuilding");
    assert.equal(store.get().composites[0].reviewRounds.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PR synchronization retires untracked Burner PRs and failed composites", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-orphan-pr-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const run = (id, number) => ({
      id, ideaId: `idea-${id}`, status: "completed", branch: `burner/${id}`, worktree: "", startedAt: timestamp,
      completedAt: timestamp, prNumber: number, prState: "open", deltas: [], resources: [], reviewRounds: [], reviewApproved: true,
    });
    await store.update((state) => {
      const failedLeaf = run("gate", 3);
      failedLeaf.status = "failed";
      failedLeaf.error = "Python 3.14 compatibility failed";
      failedLeaf.quarantinedAt = timestamp;
      failedLeaf.quarantineReason = "Merge gate rejected PR #3: Python 3.14 compatibility failed";
      const yieldedLeaf = run("yielded", 4);
      yieldedLeaf.status = "failed";
      yieldedLeaf.error = "Portfolio agent yielded its slot to preserve the merge cadence reserve.";
      yieldedLeaf.quarantinedAt = timestamp;
      yieldedLeaf.quarantineReason = "Review yielded with 10 minutes left so fallback work can use the merge reserve.";
      state.agentRuns.push(run("a", 1), run("b", 2), failedLeaf, yieldedLeaf);
      state.composites.push({
        id: "failed", title: "Interrupted composite", description: "Combined", status: "failed", branch: "burner/composite-failed", worktree: "",
        sources: [
          { agentRunId: "a", prNumber: 1, title: "A", branch: "burner/a", kind: "pull_request" },
          { agentRunId: "b", prNumber: 2, title: "B", branch: "burner/b", kind: "pull_request" },
        ],
        deltas: [], reviewRounds: [],
        error: "Burner stopped before this composite run completed.", createdAt: timestamp, updatedAt: timestamp, isLiving: false,
      });
    });
    const closed = [];
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.git = {
      remoteExists: async () => true,
      listPullRequests: async () => [
        { number: 1, state: "OPEN", headRefName: "burner/a", url: "", labels: [{ name: "burner-unmerged" }] },
        { number: 2, state: "OPEN", headRefName: "burner/b", url: "", labels: [{ name: "burner-unmerged" }] },
        { number: 3, state: "OPEN", headRefName: "burner/gate", url: "", labels: [{ name: "burner-unmerged" }] },
        { number: 4, state: "OPEN", headRefName: "burner/yielded", url: "", isDraft: true, labels: [{ name: "burner-unmerged" }] },
        { number: 100, state: "OPEN", headRefName: "burner/composite-failed", url: "", isDraft: true, labels: [{ name: "burner-unmerged" }] },
        { number: 200, state: "OPEN", headRefName: "burner/composite-orphan", url: "", isDraft: true, labels: [{ name: "burner-unmerged" }] },
        { number: 201, state: "OPEN", headRefName: "burner/orphan-leaf", url: "", labels: [{ name: "burner-unmerged" }] },
        { number: 202, state: "OPEN", headRefName: "feature/manual", url: "", labels: [{ name: "burner-unmerged" }] },
        { number: 203, state: "OPEN", headRefName: "burner/manual", url: "", labels: [] },
      ],
      closePr: async (_cwd, number, comment) => closed.push([number, comment]),
      markPrDisposition: async () => undefined,
    };

    await orchestrator.syncPullRequests(true);

    assert.deepEqual(closed.map(([number]) => number), [200, 201, 100, 3, 4]);
    assert.match(closed.find(([number]) => number === 200)[1], /no longer represented/);
    assert.match(closed.find(([number]) => number === 100)[1], /failed composite/);
    assert.equal(store.get().composites[0].prNumber, 100, "an interrupted publication must be recovered by its exact branch before cleanup");
    assert.equal(store.get().composites[0].status, "failed", "retirement must preserve explicit retry state");
    assert.equal(store.get().agentRuns.find((item) => item.id === "a").prState, "open", "tracked source leaves remain available for fallback");
    assert.equal(store.get().agentRuns.find((item) => item.id === "b").prState, "open", "tracked source leaves remain available for fallback");
    assert.equal(store.get().agentRuns.find((item) => item.id === "gate").prState, "closed", "hard-gate failures are retired on reconciliation");
    assert.equal(store.get().agentRuns.find((item) => item.id === "yielded").prState, "closed", "cadence-yielded drafts are retired on reconciliation");
    assert.match(closed.find(([number]) => number === 4)[1], /explicit retry will reopen this same PR/i);
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

test("cadence-yielded checkpoints close immediately and retain their retry PR", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-cadence-checkpoint-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => state.agentRuns.push({
      id: "run", ideaId: "idea", status: "failed", branch: "burner/yielded", worktree: root,
      startedAt: timestamp, completedAt: timestamp, deltas: [], resources: [], reviewRounds: [],
      prNumber: 12, prUrl: "https://example.test/pull/12", prState: "open",
      error: "Portfolio agent yielded its slot to preserve the merge cadence reserve.",
      quarantinedAt: timestamp,
      quarantineReason: "Review yielded with 10 minutes left so fallback work can use the merge reserve.",
    }));
    const closed = [];
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.git = { closePr: async (_cwd, number, comment) => closed.push([number, comment]) };

    await orchestrator.retireCadenceYieldedAgentPr("run");

    assert.deepEqual(closed.map(([number]) => number), [12]);
    assert.match(closed[0][1], /explicit retry will reopen this same PR/i);
    assert.equal(store.get().agentRuns[0].prNumber, 12);
    assert.equal(store.get().agentRuns[0].prState, "closed");
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
      state.evaluationRuns.push({ id: "prompt-baseline", evaluationId: "prompt", score: 60, summary: "Calibrated", evidence: ["Category: 6/10"], commit: "base", createdAt: timestamp, durationMs: 1, status: "completed", context: "baseline", promptSampleCount: 3 });
    });
    const order = [];
    const promptBaselines = [];
    let activeSuite;
    let overlapped = false;
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.git = { head: async () => "commit" };
    orchestrator.codex = {
      preflight: async () => undefined,
      evaluate: async (cwd, evaluation, _settings, _context, baseline) => {
        if (activeSuite && activeSuite !== cwd) overlapped = true;
        activeSuite = cwd;
        order.push(`${cwd}:${evaluation.id}`);
        if (evaluation.id === "prompt") promptBaselines.push(baseline?.score);
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
    assert.deepEqual(promptBaselines, [60, 60]);
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

test("candidate prompt retries do not wait for the long command lane", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-independent-evaluation-lanes-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.evaluations = [
        { id: "command", name: "Command", prompt: "Measure", command: "benchmark", weight: 1, enabled: true, createdAt: timestamp },
        { id: "prompt", name: "Prompt", prompt: "Inspect", weight: 1, enabled: true, createdAt: timestamp },
      ];
    });
    const orchestrator = new Orchestrator(root, store, new EventHub());
    const order = [];
    let releaseCommand;
    const commandGate = new Promise((resolve) => { releaseCommand = resolve; });
    let promptAttempt = 0;
    const run = (evaluationId, status, score) => ({
      id: `run-${evaluationId}-${promptAttempt}`,
      evaluationId,
      commit: "candidate",
      createdAt: timestamp,
      durationMs: 1,
      status,
      score,
      context: "composite",
    });
    orchestrator.runEvaluations = async (_context, _cwd, _agentRunId, _compositeId, evaluationIds) => {
      if (evaluationIds[0] === "command") {
        order.push("command:start");
        await commandGate;
        order.push("command:end");
        return [run("command", "completed", 100)];
      }
      promptAttempt += 1;
      order.push(`prompt:${promptAttempt}`);
      return [run("prompt", promptAttempt === 1 ? "failed" : "completed", promptAttempt === 1 ? undefined : 90)];
    };
    const evaluationPromise = orchestrator.runCandidateEvaluations("composite", root, undefined, "composite");
    for (let attempt = 0; attempt < 20 && !order.includes("prompt:2"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(order, ["command:start", "prompt:1", "prompt:2"]);
    releaseCommand();
    const runs = await evaluationPromise;
    assert.deepEqual(runs.map((item) => [item.evaluationId, item.status]), [["command", "completed"], ["prompt", "completed"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every Codex role and structured fallback uses unrestricted mode without automation hooks", async () => {
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
    assert.equal((await codex.evaluate(root, evaluation, settings, "composite", { score: 65, summary: "Baseline category allocation", evidence: ["Docs: 6/10"] })).score, 77);
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
      if (!args.includes("--help")) assert.deepEqual(args.slice(2, 4), ["--disable", "hooks"]);
      assert.ok(!args.includes("--sandbox"));
      assert.ok(!args.includes("-s"));
      assert.ok(!args.includes("--ask-for-approval"));
      assert.ok(!args.includes("-a"));
      assert.ok(!args.some((arg) => /sandbox_mode|approval_policy|read-only|workspace-write/.test(arg)));
    }
    assert.ok(calls.some(({ input }) => input.includes("rigorous repository evaluator")));
    assert.ok(calls.some(({ input }) => input.includes("Finish this evaluation within 3 minutes")));
    const candidateEvaluatorCall = calls.find(({ input }) => input.includes("This candidate is not merged yet"));
    assert.match(candidateEvaluatorCall.input, /do not reduce its score because it lacks a history point for the current PR/);
    assert.match(candidateEvaluatorCall.input, /Authoritative base calibration for this exact rubric: 65\/100/);
    assert.match(candidateEvaluatorCall.input, /Preserve existing category credit unless concrete current-tree or branch-diff evidence proves a regression/);
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
    const resumeCall = calls.find(({ args }) => args.includes("resume") && args.includes("thread-test"));
    assert.deepEqual(resumeCall.args.slice(1, 5), ["exec", "--disable", "hooks", "resume"]);
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
      const alreadyClosedSource = run("b", 2);
      alreadyClosedSource.prState = "closed";
      state.agentRuns.push(run("a", 1), alreadyClosedSource, run("c", 3), run("d", 4));
      state.composites.push(
        { id: "merged", title: "Merged composite", description: "", status: "open", branch: "composite-merged", worktree: "", sources: [{ agentRunId: "a", prNumber: 1, title: "A", branch: "branch-a", kind: "pull_request" }, { agentRunId: "b", prNumber: 2, title: "B", branch: "branch-b", kind: "pull_request" }], deltas: [], reviewRounds: [], prNumber: 100, prUrl: "https://example.test/pull/100", createdAt: timestamp, updatedAt: timestamp, isLiving: true, error: "stale mergeability diagnostic" },
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
        { number: 1, state: "OPEN", headRefName: "branch-a", url: "" }, { number: 2, state: "CLOSED", headRefName: "branch-b", url: "" },
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
    assert.equal(state.composites.find((item) => item.id === "merged").error, undefined);
    assert.equal(state.agentRuns.find((item) => item.id === "a").prState, "superseded");
    assert.equal(state.agentRuns.find((item) => item.id === "b").prState, "superseded");
    const overlap = state.composites.find((item) => item.id === "overlap");
    assert.equal(overlap.status, "rebuilding");
    assert.deepEqual(overlap.sources.map((source) => source.agentRunId), ["c", "d"]);
    assert.deepEqual(closed, [[1, "merged"]]);
    assert.deepEqual(labeled, [[100, "merged"], [2, "merged"]]);
    assert.equal(state.orchestrator.baseSyncPending, false);
    assert.equal(state.orchestrator.lastEvaluationAt, undefined);
    assert.ok(state.orchestrator.lastMergeAt);
    assert.equal(state.orchestrator.mergeWindowStartedAt, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct merges requeue reviewed stale sibling experiments on the new base", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-requeue-stale-leaf-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    const approvedRound = { id: "review", round: 1, commit: "candidate", approved: true, summary: "Approved", findings: [], createdAt: timestamp };
    const run = (id, number) => ({
      id,
      ideaId: `idea-${id}`,
      status: "completed",
      branch: `branch-${id}`,
      worktree: "",
      startedAt: timestamp,
      completedAt: timestamp,
      prNumber: number,
      prState: "open",
      baseCommit: "old-base",
      deltas: [],
      resources: [],
      reviewRounds: [approvedRound],
      reviewApproved: true,
    });
    await store.update((state) => {
      const merged = run("merged", 10);
      Object.assign(merged, { status: "failed", error: "connection reset by peer", quarantinedAt: timestamp, quarantineReason: "Merge gate rejected PR #10: connection reset by peer" });
      state.agentRuns.push(merged, run("sibling", 11));
      state.ideas.push(
        { id: "idea-merged", title: "Merged", description: "", rationale: "", predictedImpact: 1, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "merged" },
        { id: "idea-sibling", title: "Reviewed sibling", description: "", rationale: "", predictedImpact: 1, evaluationIds: [], resources: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, source: "manual", agentRunId: "sibling" },
      );
    });
    const closed = [];
    const orchestrator = new Orchestrator(root, store, new EventHub(), { yolo: true, yoloBatchSize: 3 });
    orchestrator.git = {
      remoteExists: async () => true,
      listPullRequests: async () => [
        { number: 10, state: "MERGED", headRefName: "branch-merged", url: "" },
        { number: 11, state: "OPEN", headRefName: "branch-sibling", url: "" },
      ],
      markPrDisposition: async () => undefined,
      syncBase: async () => "new-base",
      closePr: async (_cwd, number, comment) => { closed.push([number, comment]); },
    };

    await orchestrator.syncPullRequests(true);

    const state = store.get();
    assert.equal(state.agentRuns.find((item) => item.id === "merged").prState, "merged");
    assert.equal(state.agentRuns.find((item) => item.id === "merged").status, "completed");
    assert.equal(state.agentRuns.find((item) => item.id === "merged").error, undefined);
    assert.equal(state.agentRuns.find((item) => item.id === "merged").quarantinedAt, undefined);
    assert.equal(state.agentRuns.find((item) => item.id === "sibling").prState, "closed");
    assert.equal(state.ideas.find((item) => item.id === "idea-merged").status, "completed");
    const sibling = state.ideas.find((item) => item.id === "idea-sibling");
    assert.equal(sibling.status, "queued");
    assert.equal(sibling.agentRunId, undefined);
    assert.equal(closed.length, 1);
    assert.equal(closed[0][0], 11);
    assert.match(closed[0][1], /reviewed experiment was requeued/);
    assert.match(state.activity[0].detail, /1 fully reviewed experiment was requeued/);
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
      state.evaluations = [
        { id: "quality", name: "Quality", prompt: "Score", command: "full", screeningCommand: "quick", weight: 1, enabled: true, createdAt: timestamp },
        { id: "docs", name: "Docs", prompt: "Score docs", weight: 1, enabled: true, createdAt: timestamp },
      ];
      state.composites.push({ id: "combined", title: "Combined", description: "", status: "merged", branch: "burner/combined", worktree: "", sources: [], deltas: [], reviewRounds: [], createdAt: timestamp, updatedAt: timestamp, isLiving: false });
      state.evaluationRuns.push(
        { id: "baseline-docs", evaluationId: "docs", score: 75, commit: "old-main", createdAt: timestamp, durationMs: 1, status: "completed", context: "baseline", promptSampleCount: 3 },
        { id: "combined-score", evaluationId: "quality", score: 88, commit: "combined-head", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite", compositeId: "combined" },
        { id: "combined-docs", evaluationId: "docs", score: 75, commit: "combined-head", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite", compositeId: "combined" },
      );
    });
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.git = { tree: async () => "same-tree" };
    assert.equal(await orchestrator.promoteMergedCompositeBaseline("combined", "new-main"), true);
    assert.equal(store.latestRuns().get("quality").score, 88);
    assert.equal(store.latestRuns().get("quality").commit, "new-main");
    assert.equal(store.latestRuns().get("docs").score, 75);
    assert.equal(store.latestRuns().get("docs").promptSampleCount, 3, "an unchanged prompt score must carry the confirmed baseline median forward");
    assert.equal(store.latestScreeningRuns().size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an exactly merged fully validated leaf becomes the next full baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-promote-leaf-baseline-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const timestamp = new Date().toISOString();
    await store.update((state) => {
      state.evaluations = [
        { id: "quality", name: "Quality", prompt: "Score", command: "full", screeningCommand: "quick", weight: 1, enabled: true, createdAt: timestamp },
        { id: "docs", name: "Docs", prompt: "Score docs", weight: 1, enabled: true, createdAt: timestamp },
      ];
      state.ideas = [{ id: "idea", title: "Improve", description: "", rationale: "", predictedImpact: 1, evaluationIds: [], resources: [], status: "completed", source: "manual", createdAt: timestamp, updatedAt: timestamp, agentRunId: "leaf" }];
      state.agentRuns = [{
        id: "leaf", ideaId: "idea", status: "completed", branch: "burner/leaf", worktree: "", startedAt: timestamp, completedAt: timestamp,
        prNumber: 10, prState: "merged", baseCommit: "old-main", deltas: [
          { evaluationId: "quality", name: "Quality", before: 80, after: 88, delta: 8, summary: "Quality improved" },
          { evaluationId: "docs", name: "Docs", before: 75, after: 80, delta: 5, summary: "Docs improved" },
        ], impact: 6.5, resources: [], reviewApproved: true, reviewRounds: [],
        fullMergeValidation: { baseCommit: "old-main", candidateCommit: "candidate", evaluationFingerprint: "fingerprint", qualified: true, completedAt: timestamp },
      }];
      state.evaluationRuns.push(
        { id: "old-docs", evaluationId: "docs", score: 75, commit: "old-main", createdAt: timestamp, durationMs: 1, status: "completed", context: "baseline", promptSampleCount: 3 },
        { id: "leaf-quality", evaluationId: "quality", score: 88, commit: "candidate", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite", agentRunId: "leaf" },
        { id: "leaf-docs", evaluationId: "docs", score: 78, commit: "candidate", createdAt: timestamp, durationMs: 1, status: "completed", context: "composite", agentRunId: "leaf" },
      );
    });
    const orchestrator = new Orchestrator(root, store, new EventHub());
    orchestrator.git = { tree: async () => "same-tree" };
    assert.equal(await orchestrator.promoteMergedAgentBaseline("leaf", "new-main"), true);
    assert.equal(store.latestRuns().get("quality").score, 88);
    assert.equal(store.latestRuns().get("quality").commit, "new-main");
    assert.equal(store.latestRuns().get("docs").score, 80, "the confirmed delta score must override an arbitrary confirmation sample");
    assert.equal(store.latestRuns().get("docs").summary, "Docs improved");
    assert.equal(store.latestRuns().get("docs").promptSampleCount, 3, "a changed prompt score was already median-confirmed by the full merge gate");
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
    const config = JSON.parse(await readFile(join(root, ".burner", "evaluations.json"), "utf8"));
    assert.equal(config.version, 1);
    assert.deepEqual(config.evaluations, store.get().evaluations);
    assert.match(await readFile(join(root, ".burner", ".gitignore"), "utf8"), /!evaluations\.json/);
    await store.update((state) => {
      state.evaluationRuns.push(
        { id: "baseline", evaluationId: evaluation.id, score: 61, commit: "a", createdAt: "2026-01-01T00:00:00.000Z", durationMs: 1, status: "completed", context: "manual" },
        { id: "candidate", evaluationId: evaluation.id, score: 99, commit: "b", createdAt: "2026-01-02T00:00:00.000Z", durationMs: 1, status: "completed", context: "agent", error: "x".repeat(20_000) },
        { id: "rejected-screen", evaluationId: evaluation.id, score: 0, summary: "Benchmark rejected: no timing score was accepted.", evidence: ["unstable timing: max/min spread 11.7"], commit: "a", createdAt: "2026-01-03T00:00:00.000Z", durationMs: 1, status: "completed", context: "screening_baseline" },
        { id: "rejected-saturated", evaluationId: evaluation.id, score: 0, summary: "Benchmark rejected: no timing score was accepted.", evidence: ["primary timing saturated: every case reached the parity cap"], commit: "a", createdAt: "2026-01-04T00:00:00.000Z", durationMs: 1, status: "completed", context: "baseline" },
        { id: "split-surrogate", evaluationId: evaluation.id, score: 80, summary: `split low ${"\uDC00"}`, evidence: [`split high ${"\uD83D"}`], commit: "a", createdAt: "2026-01-05T00:00:00.000Z", durationMs: 1, status: "completed", context: "agent" },
      );
    });
    assert.equal(store.latestRuns().get(evaluation.id)?.score, 61);
    assert.equal(store.latestScreeningRuns().has(evaluation.id), false);
    assert.ok(store.get().evaluationRuns.find((run) => run.id === "candidate").error.length <= 8_020);
    assert.equal(store.get().evaluationRuns.find((run) => run.id === "split-surrogate").summary, "split low �");
    assert.deepEqual(store.get().evaluationRuns.find((run) => run.id === "split-surrogate").evidence, ["split high �"]);
    const serializedState = await readFile(join(root, ".burner", "state.json"), "utf8");
    assert.doesNotMatch(serializedState, /\\ud83d|\\udc00/i, "persisted state must contain only well-formed Unicode strings");
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
    assert.equal(reloaded.get().evaluationRuns.find((run) => run.id === "rejected-saturated").status, "failed");
    assert.deepEqual(validateEvaluation({ name: " UX ", prompt: " Score it ", weight: 2 }), { name: "UX", prompt: "Score it", weight: 2, enabled: true });
    assert.deepEqual(validateEvaluation({ name: "Bench", prompt: "Score", command: " full ", screeningCommand: " quick " }), { name: "Bench", prompt: "Score", command: "full", screeningCommand: "quick", weight: 1, enabled: true });
    assert.throws(() => validateEvaluation({ name: "Bench", prompt: "Score", screeningCommand: "quick" }), /requires a full evaluation command/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Burner exposes only repository-owned evaluation files to Git", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-evaluation-ignore-test-"));
  try {
    await exec(root, "git", ["init", "-q"]);
    const store = new StateStore(root);
    await store.init();
    const status = await exec(root, "git", ["status", "--short", "--untracked-files=all"]);
    assert.deepEqual(status.trim().split("\n").sort(), ["?? .burner/.gitignore", "?? .burner/evaluations.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checked-in evaluations override local state and invalidate changed definitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "burner-evaluation-config-test-"));
  try {
    const store = new StateStore(root);
    await store.init();
    const evaluation = store.get().evaluations[0];
    await store.update((state) => {
      const configured = state.evaluations.find((item) => item.id === evaluation.id);
      configured.definitionVersion = "definition-v1";
      state.evaluationRuns.push({
        id: "baseline", evaluationId: evaluation.id, score: 80, commit: "base", createdAt: new Date().toISOString(), durationMs: 1,
        status: "completed", context: "baseline", promptSampleCount: 3, evaluationDefinitionVersion: "definition-v1",
      });
    });
    const config = JSON.parse(await readFile(store.evaluationsPath, "utf8"));
    config.evaluations[0].prompt = "Score the changed repository definition out of 100.";
    await writeFile(store.evaluationsPath, `${JSON.stringify(config, null, 2)}\n`);

    const reloaded = new StateStore(root);
    await reloaded.init();
    const changed = reloaded.get().evaluations[0];
    assert.equal(changed.prompt, "Score the changed repository definition out of 100.");
    assert.notEqual(changed.definitionVersion, "definition-v1");
    assert.equal(isAuthoritativeFullBaseline(changed, reloaded.latestRuns().get(changed.id), "base"), false);
    const persisted = JSON.parse(await readFile(reloaded.evaluationsPath, "utf8"));
    assert.equal(persisted.evaluations[0].definitionVersion, changed.definitionVersion);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function stallHarness(hours, runs) {
  const root = await mkdtemp(join(tmpdir(), "burner-stall-test-"));
  const store = new StateStore(root);
  await store.init();
  await store.update((state) => {
    state.settings.stallTerminationHours = hours;
    state.orchestrator.enabled = true;
    state.evaluations = [{ id: "eval_a", name: "A", prompt: "p", weight: 1, enabled: true, createdAt: "2026-01-01T00:00:00.000Z", definitionVersion: "definition-a" }];
    state.evaluationRuns = runs.map((score, index) => ({
      id: `run_${index}`,
      evaluationId: "eval_a",
      context: "baseline",
      status: "completed",
      score,
      attempts: 1,
      commit: "base",
      evaluationDefinitionVersion: "definition-a",
      promptSampleCount: 3,
      createdAt: new Date(Date.UTC(2026, 0, 1, index)).toISOString(),
    }));
  });
  const terminations = [];
  const orchestrator = new Orchestrator(root, store, new EventHub(), { onTerminate: (reason) => terminations.push(reason) });
  orchestrator.git = { resolveRef: async () => "base" };
  return { root, store, orchestrator, terminations };
}

test("stall termination arms on the first score and resets on a new best", async () => {
  const { root, store, orchestrator } = await stallHarness(24, [40]);
  try {
    assert.equal(await orchestrator.terminateIfStalled(), false);
    const armedAt = store.get().orchestrator.bestScoreAt;
    assert.equal(store.get().orchestrator.bestScore, 40);
    assert.ok(armedAt, "the first score should arm the stall clock");

    // Backdate the clock well past the window, then beat the record: the
    // improvement must restart the window rather than terminate the run.
    await store.update((state) => { state.orchestrator.bestScoreAt = "2020-01-01T00:00:00.000Z"; });
    await store.update((state) => { state.evaluationRuns.push({ id: "run_best", evaluationId: "eval_a", context: "baseline", status: "completed", score: 55, attempts: 1, commit: "base", evaluationDefinitionVersion: "definition-a", promptSampleCount: 3, createdAt: "2026-06-01T00:00:00.000Z" }); });
    assert.equal(await orchestrator.terminateIfStalled(), false);
    assert.equal(store.get().orchestrator.bestScore, 55);
    assert.ok(store.get().orchestrator.bestScoreAt > "2020-01-01T00:00:00.000Z");
    assert.equal(store.get().orchestrator.enabled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stall termination stops the orchestrator after the configured window", async () => {
  const { root, store, orchestrator, terminations } = await stallHarness(24, [70]);
  try {
    await orchestrator.terminateIfStalled();
    await store.update((state) => { state.orchestrator.bestScoreAt = new Date(Date.now() - 25 * 3_600_000).toISOString(); });
    // A later run that merely ties the record is not progress.
    await store.update((state) => { state.evaluationRuns.push({ id: "run_flat", evaluationId: "eval_a", context: "baseline", status: "completed", score: 70, attempts: 1, commit: "base", evaluationDefinitionVersion: "definition-a", promptSampleCount: 3, createdAt: "2026-06-01T00:00:00.000Z" }); });

    assert.equal(await orchestrator.terminateIfStalled(), true);
    assert.equal(store.get().orchestrator.enabled, false);
    assert.ok(store.get().orchestrator.stalledAt, "termination should be recorded");
    assert.deepEqual(terminations, ["stalled"]);
    assert.match(store.get().activity[0].message, /Terminated after 24h without evaluation progress/);

    // Terminating is idempotent: a second pass must not re-fire the callback.
    assert.equal(await orchestrator.terminateIfStalled(), false);
    assert.deepEqual(terminations, ["stalled"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stall termination is disabled when the window is zero", async () => {
  const { root, store, orchestrator, terminations } = await stallHarness(0, [70]);
  try {
    await store.update((state) => { state.orchestrator.bestScoreAt = new Date(Date.now() - 400 * 3_600_000).toISOString(); });
    assert.equal(await orchestrator.terminateIfStalled(), false);
    assert.equal(store.get().orchestrator.enabled, true);
    assert.deepEqual(terminations, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stall termination re-arms against an authoritative baseline when the evaluation rubric changes", async () => {
  const { root, store, orchestrator } = await stallHarness(24, [90]);
  try {
    await orchestrator.terminateIfStalled();
    const originalFingerprint = store.get().orchestrator.bestScoreEvaluationFingerprint;
    await store.update((state) => {
      state.orchestrator.bestScoreAt = "2020-01-01T00:00:00.000Z";
      state.evaluations.push({ id: "eval_b", name: "B", prompt: "new rubric", weight: 1, enabled: true, createdAt: "2026-01-02T00:00:00.000Z", definitionVersion: "definition-b" });
      state.evaluationRuns.push({ id: "run_b", evaluationId: "eval_b", context: "baseline", status: "completed", score: 10, attempts: 1, commit: "base", evaluationDefinitionVersion: "definition-b", promptSampleCount: 3, createdAt: "2026-06-02T00:00:00.000Z" });
    });

    assert.equal(await orchestrator.terminateIfStalled(), false);
    assert.equal(store.get().orchestrator.bestScore, 50);
    assert.notEqual(store.get().orchestrator.bestScoreEvaluationFingerprint, originalFingerprint);
    assert.ok(store.get().orchestrator.bestScoreAt > "2020-01-01T00:00:00.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
