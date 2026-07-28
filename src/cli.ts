#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createBurnerServer } from "./server.js";
import { errorMessage } from "./lib/utils.js";

const colors = {
  fire: (value: string) => `\x1b[38;2;255;107;53m${value}\x1b[0m`,
  cyan: (value: string) => `\x1b[36m${value}\x1b[0m`,
  red: (value: string) => `\x1b[31m${value}\x1b[0m`,
  dim: (value: string) => `\x1b[2m${value}\x1b[0m`,
};

function parseArgs(argv: string[]) {
  let directory = ".";
  let host = "127.0.0.1";
  let port = "4321";
  let shouldOpen = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: burner [options] [directory]\n\nOptions:\n  -p, --port <port>  port to listen on (default: 4321)\n  --host <host>      host to bind (default: 127.0.0.1)\n  --no-open          do not open a browser\n  -V, --version      output the version number\n  -h, --help         display help");
      process.exit(0);
    }
    if (arg === "--version" || arg === "-V") { console.log("0.2.0"); process.exit(0); }
    if (arg === "--no-open") { shouldOpen = false; continue; }
    if (arg === "--dev") continue;
    if (arg === "--host") { host = argv[++index] ?? host; continue; }
    if (arg === "--port" || arg === "-p") { port = argv[++index] ?? port; continue; }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    directory = arg;
  }
  return { directory, host, port, shouldOpen };
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

const options = parseArgs(process.argv.slice(2));
const root = resolve(options.directory);
const port = Number(options.port);
if (!new Set(["127.0.0.1", "localhost", "::1"]).has(options.host)) {
  console.error(colors.red("Burner only binds to the local machine. Use 127.0.0.1, localhost, or ::1."));
  process.exit(1);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(colors.red("Port must be an integer between 1 and 65535."));
  process.exit(1);
}

try {
  const burner = await createBurnerServer({ root, host: options.host, port });
  const url = `http://${options.host}:${port}`;
  console.log();
  console.log(colors.fire("  ◉ BURNER"));
  console.log(colors.dim("  Evaluation-driven repo improvement, running locally."));
  console.log();
  console.log(`  ${colors.dim("Project")}  ${root}`);
  console.log(`  ${colors.dim("Control")}  ${colors.cyan(url)}`);
  console.log();
  console.log(colors.dim("  Press Ctrl+C to cool down."));
  console.log();
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
} catch (error) {
  console.error(colors.red(`Burner failed to start: ${errorMessage(error)}`));
  process.exit(1);
}
