#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createBurnerServer } from "./server.js";
import { EventHub } from "./lib/events.js";
import { Orchestrator } from "./lib/orchestrator.js";
import { StateStore, validateEvaluation } from "./lib/store.js";
import { errorMessage, id, now } from "./lib/utils.js";
import type { BurnerSettings, Idea } from "./types.js";

const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
const colors = {
  fire: (value: string) => `\x1b[38;2;255;107;53m${value}\x1b[0m`,
  cyan: (value: string) => `\x1b[36m${value}\x1b[0m`,
  red: (value: string) => `\x1b[31m${value}\x1b[0m`,
  dim: (value: string) => `\x1b[2m${value}\x1b[0m`,
};

const help = `Usage: burner [options] [directory]
       burner <command> [subcommand] -C <directory> [options]

SECURITY WARNING:
  Every Codex agent runs with --dangerously-bypass-approvals-and-sandbox.
  Authors, revisions, reviewers, planners, prompt evaluators, and composite
  integrators have unrestricted filesystem and command access as your user.
  Command-backed evaluations are separate direct local subprocesses.

Commands:
  eval add       Add an evaluation (--name, --prompt, [--command], [--weight])
  eval clear     Remove every evaluation (--yes is required)
  eval list      List evaluations and latest scores
  eval run       Run all enabled evaluations and wait for results
  idea add       Queue an idea (--title, --description, [--impact])
  idea list      List improvement ideas
  queue run-next Run exactly one queued idea through review and delivery
  queue retry    Resume a failed candidate (--run)
  pr merge       Merge an open agent PR and synchronize the base (--run)
  settings set   Update automation settings
  status         Print project state and runtime readiness as JSON

Server options:
  -p, --port <port>       port to listen on (default: 4321)
  --host <host>           host to bind (default: 127.0.0.1)
  --no-open               do not open a browser
  --yolo                  autonomously run and master-cook leaf PRs
  --yolo-batch-size <n>   leaf PRs per composite (default: 10; 1 merges leaves)

Command options:
  -C, --directory <path>  target repository (default: current directory)
  --json                  JSON output (commands already default to JSON)
  -V, --version           output the version number
  -h, --help              display help`;

function option(args: string[], name: string, short?: string): string | undefined {
  const index = args.findIndex((value) => value === name || Boolean(short && value === short));
  return index >= 0 ? args[index + 1] : undefined;
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

function required(args: string[], name: string): string {
  const value = option(args, name)?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function boolOption(args: string[], name: string, fallback: boolean): boolean {
  const value = option(args, name);
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function numberOption(args: string[], name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = option(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a number between ${minimum} and ${maximum}.`);
  }
  return value;
}

function commandRoot(args: string[]): string {
  return resolve(option(args, "--directory", "-C") ?? ".");
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function withOrchestrator<T>(root: string, task: (orchestrator: Orchestrator, store: StateStore) => Promise<T>): Promise<T> {
  const store = new StateStore(root);
  await store.init();
  const orchestrator = new Orchestrator(root, store, new EventHub());
  await orchestrator.init();
  try { return await task(orchestrator, store); }
  finally { await orchestrator.close(); }
}

async function runHeadless(args: string[]): Promise<boolean> {
  const [command, subcommand] = args;
  if (!new Set(["eval", "idea", "queue", "pr", "settings", "status"]).has(command)) return false;
  const root = commandRoot(args);

  if (command === "eval" && subcommand === "add") {
    const store = new StateStore(root);
    await store.init();
    const input = validateEvaluation({ name: required(args, "--name"), prompt: required(args, "--prompt"), command: option(args, "--command"), weight: numberOption(args, "--weight", 1, Number.EPSILON, 10), enabled: true });
    const evaluation = { ...input, id: id("eval"), createdAt: now() };
    await store.update((state) => state.evaluations.push(evaluation));
    print(evaluation);
    return true;
  }

  if (command === "eval" && subcommand === "clear") {
    if (!has(args, "--yes")) throw new Error("eval clear requires --yes.");
    const store = new StateStore(root);
    await store.init();
    const removed = store.get().evaluations.length;
    await store.update((state) => {
      state.evaluations = [];
      state.evaluationRuns = [];
      state.orchestrator.lastEvaluationAt = undefined;
      state.orchestrator.lastPlanningAt = undefined;
    });
    print({ removed });
    return true;
  }

  if (command === "eval" && subcommand === "list") {
    const store = new StateStore(root);
    await store.init();
    const latest = store.latestRuns();
    print(store.get().evaluations.map((evaluation) => ({ ...evaluation, latest: latest.get(evaluation.id) })));
    return true;
  }

  if (command === "eval" && subcommand === "run") {
    const runs = await withOrchestrator(root, (orchestrator) => orchestrator.runEvaluations("manual"));
    print(runs);
    if (runs.some((run) => run.status !== "completed")) process.exitCode = 2;
    return true;
  }

  if (command === "idea" && subcommand === "add") {
    const store = new StateStore(root);
    await store.init();
    const state = store.get();
    const timestamp = now();
    const idea: Idea = {
      id: id("idea"),
      title: required(args, "--title").slice(0, 120),
      description: required(args, "--description"),
      rationale: option(args, "--rationale")?.trim() || "Queued from the Burner CLI",
      predictedImpact: numberOption(args, "--impact", 50, 0, 100),
      evaluationIds: args.flatMap((value, index) => value === "--eval" && args[index + 1] ? [args[index + 1]] : []),
      resources: args.flatMap((value, index) => value === "--resource" && args[index + 1] ? [args[index + 1]] : []),
      status: "queued",
      source: "manual",
      createdAt: timestamp,
      updatedAt: timestamp,
      baseCompositeId: state.settings.preferLivingComposite ? state.orchestrator.livingCompositeId : undefined,
    };
    await store.update((draft) => draft.ideas.push(idea));
    print(idea);
    return true;
  }

  if (command === "idea" && subcommand === "list") {
    const store = new StateStore(root);
    await store.init();
    print(store.get().ideas);
    return true;
  }

  if (command === "queue" && subcommand === "run-next") {
    const run = await withOrchestrator(root, (orchestrator) => orchestrator.runNextIdea());
    print(run);
    if (!["completed", "absorbed", "rejected", "no_changes"].includes(run.status)) process.exitCode = 2;
    return true;
  }

  if (command === "queue" && subcommand === "retry") {
    const run = await withOrchestrator(root, (orchestrator) => orchestrator.retryAgent(required(args, "--run")));
    print(run);
    if (!["completed", "absorbed", "rejected", "no_changes"].includes(run.status)) process.exitCode = 2;
    return true;
  }

  if (command === "pr" && subcommand === "merge") {
    print(await withOrchestrator(root, (orchestrator) => orchestrator.mergeAgent(required(args, "--run"))));
    return true;
  }

  if (command === "settings" && subcommand === "set") {
    const store = new StateStore(root);
    await store.init();
    let updated!: BurnerSettings;
    await store.update((state) => {
      const settings = state.settings;
      const parallelism = option(args, "--parallelism");
      const reviewRounds = option(args, "--max-review-rounds");
      const threshold = option(args, "--absorb-threshold");
      if (parallelism !== undefined) settings.parallelism = numberOption(args, "--parallelism", settings.parallelism, 1, 12);
      if (reviewRounds !== undefined) settings.maxReviewRounds = numberOption(args, "--max-review-rounds", settings.maxReviewRounds, 1, 50);
      if (threshold !== undefined) settings.compositeAbsorbThreshold = numberOption(args, "--absorb-threshold", settings.compositeAbsorbThreshold, 0, 100);
      settings.autoCreatePrs = boolOption(args, "--auto-create-prs", settings.autoCreatePrs);
      settings.preferLivingComposite = boolOption(args, "--prefer-living", settings.preferLivingComposite);
      updated = structuredClone(settings);
    });
    print(updated);
    return true;
  }

  if (command === "status") {
    const output = await withOrchestrator(root, async (orchestrator, store) => {
      const scores = store.compositeScores();
      return { project: store.get(), runtime: await orchestrator.runtimeStatus(true), compositeScore: scores.current, previousCompositeScore: scores.previous };
    });
    print(output);
    return true;
  }

  throw new Error(`Unknown command: ${command}${subcommand ? ` ${subcommand}` : ""}. Run burner --help.`);
}

function parseServerArgs(argv: string[]) {
  let directory = ".";
  let host = "127.0.0.1";
  let port = "4321";
  let shouldOpen = true;
  let yolo = false;
  let yoloBatchSize = 10;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--no-open") { shouldOpen = false; continue; }
    if (arg === "--yolo") { yolo = true; continue; }
    if (arg === "--yolo-batch-size") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error("--yolo-batch-size must be an integer between 1 and 100.");
      yoloBatchSize = value;
      continue;
    }
    if (arg === "--dev") continue;
    if (arg === "--host") { host = argv[++index] ?? host; continue; }
    if (arg === "--port" || arg === "-p") { port = argv[++index] ?? port; continue; }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    directory = arg;
  }
  return { directory, host, port, shouldOpen, yolo, yoloBatchSize };
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-V")) { console.log(VERSION); return; }
  if (argv.includes("--help") || argv.includes("-h")) { console.log(help); return; }
  if (await runHeadless(argv)) return;

  const options = parseServerArgs(argv);
  const root = resolve(options.directory);
  const port = Number(options.port);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(options.host)) throw new Error("Burner only binds to the local machine. Use 127.0.0.1, localhost, or ::1.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be an integer between 1 and 65535.");

  const burner = await createBurnerServer({ root, host: options.host, port, yolo: options.yolo, yoloBatchSize: options.yoloBatchSize });
  const url = `http://${options.host}:${port}`;
  console.log(`\n${colors.fire("  ◉ BURNER")}\n${colors.dim("  Evaluation-driven repo improvement, running locally.")}\n`);
  console.log(`  ${colors.dim("Project")}  ${root}`);
  console.log(`  ${colors.dim("Control")}  ${colors.cyan(url)}\n`);
  console.log(colors.red("  ⚠ Codex agents have unrestricted filesystem and command access as your user.\n"));
  if (options.yolo) console.log(colors.red(options.yoloBatchSize === 1
    ? "  ⚠ YOLO autopilot is active: Burner may open and merge approved leaf PRs.\n"
    : `  ⚠ YOLO portfolio is active: Burner will cook batches of ${options.yoloBatchSize} leaf PRs into composites.\n`));
  console.log(colors.dim("  Press Ctrl+C to cool down.\n"));
  if (options.shouldOpen) openBrowser(url);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log(colors.dim("\n  Cooling down…"));
    await burner.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

try { await main(); }
catch (error) {
  console.error(colors.red(`Burner failed: ${errorMessage(error)}`));
  process.exit(1);
}
