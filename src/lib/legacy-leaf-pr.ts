import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { AgentRun, BurnerState, LeafPrFields, LeafPrOwnership, LegacyLeafPrProofInput } from "../types.js";
import { buildPrBody, leafPrRendererFingerprint } from "./git.js";

// These identify the actually inspected executed writer, not a Git commit or
// a caller's declaration that arbitrary code followed the same protocol.
const WRITER = {
  runtime: "1e02ba520aac2aa070055c1fa598ef76057c5979ab048c46f6aae03fdd6043ea",
  driver: "c71791f4ac4f1d270e843f1f9425850456ec173847853ed986f08709726e7629",
  orchestrator: "f1e84314997f565ef6041d9b55c42051c06298c665186168ca325868bf7b39e3",
  git: "d70b0d160fa23af3e513b11e69047ca3ecd242fd2db101bc67b3c692efa3e49a",
  renderer: "726a3ef672c24e4a88f6943ca130b3b1ae178a80321ccce36e39fef961835ca6",
} as const;

const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
function refuse(detail: string): never { throw new Error(`Legacy PR writer proof refused: ${detail}.`); }
const hashPattern = /^[a-f0-9]{64}$/;

export function validateLegacyLeafPrProofInput(value: LegacyLeafPrProofInput): void {
  if (!value || typeof value !== "object" || value.protocol !== "executed-leaf-writer-v1" ||
    typeof value.directory !== "string" || !isAbsolute(value.directory) || value.directory !== resolve(value.directory) ||
    ![value.startedSha256, value.resultSha256, value.stateSha256].every((hash) => typeof hash === "string" && hashPattern.test(hash)) ||
    Object.keys(value).sort().join(",") !== "directory,protocol,resultSha256,startedSha256,stateSha256") {
    refuse("expected an exact absolute archive directory and started/result/state SHA256 pins");
  }
}

type Pin = { retained: { path: string; sha256: string } };
type Operation = { enteredAt: string; returned: boolean; returnedAt: string; error?: unknown };
type Execution = {
  kind: string; directory: string; runId: string; ideaId: string; mainCommit: string; publicMethod: string;
  startedAt: string; finishedAt: string; inputs: Record<string, Pin>; operations: Record<string, Operation>;
  errors: unknown[]; qualificationReturned: boolean; firstPublishedPr: { number: number; url: string };
  candidateCommit: string; run: AgentRun; runAfterReentry: AgentRun; returnedRun: AgentRun;
  canonicalStateAfterSha256: string; canonicalOutcomeUnconfirmed: boolean; finalStateVerified: boolean;
  teardownCompleted: boolean; terminalOutcomeSealed: boolean; closeCompleted: boolean; interrupted: unknown;
};

/** Reads a bounded, explicitly supplied archive. It never imports archived code or writes state. */
export async function readLegacyLeafPrProof(input: LegacyLeafPrProofInput, run: AgentRun, state: BurnerState): Promise<{
  fields: LeafPrFields; head: string; provenance: NonNullable<LeafPrOwnership["legacy"]>;
}> {
  validateLegacyLeafPrProofInput(input);
  const directory = await realpath(input.directory);
  const stat = await lstat(input.directory);
  if (directory !== input.directory || !stat.isDirectory() || stat.isSymbolicLink()) refuse("archive directory identity changed");
  const read = async (name: string, expected?: string): Promise<Buffer> => {
    if (basename(name) !== name) refuse("archive entry is not a direct retained file");
    const path = join(directory, name);
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 64 * 1024 * 1024 || await realpath(path) !== path) refuse(`unknown retained file ${name}`);
    const bytes = await readFile(path);
    if (expected && digest(bytes) !== expected) refuse(`changed retained file ${name}`);
    return bytes;
  };
  const startBytes = await read("started.json", input.startedSha256);
  const resultBytes = await read("result.json", input.resultSha256);
  const afterBytes = await read("after-state.json", input.stateSha256);
  const start = JSON.parse(startBytes.toString()) as Execution;
  const result = JSON.parse(resultBytes.toString()) as Execution;
  const after = JSON.parse(afterBytes.toString()) as BurnerState;
  const runtimeBytes = await read("runtime.input", WRITER.runtime);
  await read("driver.input", WRITER.driver);
  const runtime = JSON.parse(runtimeBytes.toString()) as { manualInitializationVerified: boolean; compiledFiles: Record<string, string> };
  if (runtime.manualInitializationVerified !== true || !runtime.compiledFiles ||
    runtime.compiledFiles["lib/orchestrator.js"] !== WRITER.orchestrator || runtime.compiledFiles["lib/git.js"] !== WRITER.git ||
    leafPrRendererFingerprint() !== WRITER.renderer) refuse("unrecognized writer or changed historical renderer");
  const pins = new Map<string, { name: string; hash: string }>([
    ["runtime", { name: "runtime.input", hash: WRITER.runtime }], ["driver", { name: "driver.input", hash: WRITER.driver }],
    ...Object.entries(runtime.compiledFiles).map(([name, hash]) => {
      const key = `runtime-${name.replaceAll("/", "-")}`;
      return [key, { name: `${key}.input`, hash }] as const;
    }),
  ]);
  for (const [key, pin] of pins) {
    const started = start.inputs?.[key]?.retained;
    if (!started || !same(started, result.inputs?.[key]?.retained) || started.sha256 !== pin.hash ||
      started.path !== join(start.directory, pin.name) || result.directory !== start.directory) refuse(`execution does not bind ${key}`);
    await read(pin.name, pin.hash);
  }
  if (start.kind !== "structured-outputs-local-repair-reentry-result-v1" || result.kind !== start.kind ||
    start.runId !== run.id || result.runId !== run.id || start.ideaId !== run.ideaId || result.ideaId !== run.ideaId ||
    start.mainCommit !== run.baseCommit || result.mainCommit !== run.baseCommit ||
    start.publicMethod !== "refreshAgentBaseAndRetry" || result.publicMethod !== start.publicMethod ||
    !same(result.errors, []) || result.canonicalOutcomeUnconfirmed !== false || result.finalStateVerified !== true ||
    result.teardownCompleted !== true || result.terminalOutcomeSealed !== true || result.closeCompleted !== true ||
    result.interrupted !== null || result.canonicalStateAfterSha256 !== input.stateSha256) refuse("execution is incomplete or belongs to another target");
  let previous = Date.parse(result.startedAt);
  if (!Number.isFinite(previous) || start.startedAt !== result.startedAt) refuse("missing operation start");
  for (const name of ["server", "reentry", "qualification", "close"]) {
    const operation = result.operations?.[name];
    const entered = Date.parse(operation?.enteredAt), returned = Date.parse(operation?.returnedAt);
    if (!operation || operation.returned !== true || operation.error !== undefined ||
      !Number.isFinite(entered) || !Number.isFinite(returned) || entered < previous || returned < entered) refuse(`unproved ${name} return ordering`);
    previous = returned;
  }
  if (!Number.isFinite(Date.parse(result.finishedAt)) || Date.parse(result.finishedAt) < previous ||
    Object.keys(result.operations).sort().join(",") !== "close,qualification,reentry,server") refuse("ambiguous operation sequence");
  const saved = after.agentRuns?.find((item) => item.id === run.id);
  const idea = after.ideas?.find((item) => item.id === run.ideaId);
  if (!saved || !idea || !same(saved, run) || !same(result.run, run) ||
    !same(idea, state.ideas.find((item) => item.id === run.ideaId)) || !same(after.evaluations, state.evaluations) ||
    after.settings.baseBranch !== state.settings.baseBranch || after.settings.remote !== state.settings.remote ||
    run.leafPr || run.prState !== "open" || run.status !== "completed" || !run.prNumber || !run.prUrl || !run.baseCommit ||
    run.baseRef !== state.settings.baseBranch || run.parentCompositeId || !run.authorThreadId || run.authoringComplete !== true) refuse("retained target or writer inputs changed");
  const delivered = result.runAfterReentry;
  const { fullMergeValidation: full, deltas: _deltas, impact: _impact, ...identity } = run;
  const { deltas: _deliveryDeltas, impact: _deliveryImpact, ...deliveryIdentity } = delivered ?? {};
  if (!delivered || !same(delivered, result.returnedRun) || !same(identity, deliveryIdentity) || !full ||
    full.qualified !== false || result.qualificationReturned !== false || full.baseCommit !== run.baseCommit ||
    full.candidateCommit !== result.candidateCommit || run.reviewRounds.at(-1)?.commit !== result.candidateCommit ||
    run.reviewRounds.at(-1)?.approved !== true || !run.reviewRounds.at(-1)?.completedAt || run.reviewApproved !== true ||
    run.reviewRounds.at(-1)!.findings.length !== 0 || !same(result.firstPublishedPr, { number: run.prNumber, url: run.prUrl })) refuse("publication has no exact completed draft/full writer sequence");
  const deliveryEnd = Date.parse(result.operations.reentry.returnedAt);
  const fullStart = Date.parse(result.operations.qualification.enteredAt);
  const fullEnd = Date.parse(result.operations.qualification.returnedAt);
  const completed = Date.parse(run.completedAt ?? ""), verdict = Date.parse(full.completedAt);
  const opened = after.activity.filter((item) => item.type === "pr" && item.message === `PR opened: ${idea.title}` &&
    item.detail === run.prUrl && Date.parse(item.createdAt) >= completed && Date.parse(item.createdAt) <= deliveryEnd);
  const published = after.activity.filter((item) => item.type === "agent" && item.message === `Leaf rejected by full merge validation: ${idea.title}` &&
    item.detail === "At least one full evaluation regressed or total impact was not positive; the PR remains unmerged." &&
    Date.parse(item.createdAt) >= verdict && Date.parse(item.createdAt) <= fullEnd);
  if (!Number.isFinite(completed) || completed < Date.parse(result.operations.reentry.enteredAt) || completed > deliveryEnd ||
    !Number.isFinite(verdict) || verdict < fullStart || verdict > fullEnd || opened.length !== 1 || published.length !== 1 ||
    !after.activity.some((item) => Date.parse(item.createdAt) < completed)) refuse("missing complete publication activity window");
  const currentRows = new Map(state.evaluationRuns.map((row) => [row.id, row]));
  for (const row of after.evaluationRuns.filter((item) => item.agentRunId === run.id ||
    (item.commit === run.baseCommit && ["baseline", "manual", "screening_baseline"].includes(item.context)))) {
    if (!same(row, currentRows.get(row.id))) refuse(`retained measurement ${row.id} changed`);
  }
  const currentActivities = new Map(state.activity.map((item) => [item.id, item]));
  for (const activity of after.activity.filter((item) => Date.parse(item.createdAt) >= completed)) {
    if (!same(activity, currentActivities.get(activity.id))) refuse(`retained publication activity ${activity.id} changed`);
  }
  return {
    head: result.candidateCommit,
    fields: { title: idea.title, body: buildPrBody(idea.description, run.lastMessage ?? "", run.deltas, run.impact ?? 0, run.reviewRounds), isDraft: true, state: "OPEN" },
    provenance: { protocol: input.protocol, proofDigest: digest(JSON.stringify(input)), stateDigest: input.stateSha256,
      runtimeDigest: WRITER.runtime, driverDigest: WRITER.driver },
  };
}
