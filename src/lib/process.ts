import { spawn } from "node:child_process";

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; onStderr?: (line: string) => void },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      for (const line of chunk.split("\n").filter(Boolean)) options.onStderr?.(line);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
    if (options.timeoutMs) {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      }, options.timeoutMs);
      timer.unref();
      child.on("close", () => clearTimeout(timer));
    }
  });
}

export async function commandExists(command: string, cwd: string): Promise<boolean> {
  try {
    return (await runCommand(command, ["--version"], { cwd, timeoutMs: 5_000 })).exitCode === 0;
  } catch {
    return false;
  }
}
