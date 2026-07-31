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
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    let forceResolve: NodeJS.Timeout | undefined;
    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (forceResolve) clearTimeout(forceResolve);
    };
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ stdout, stderr: timedOut ? `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}Command timed out after ${options.timeoutMs}ms.` : stderr, exitCode: timedOut ? 124 : exitCode });
    };
    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The process group may already have exited between the timeout and signal.
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      for (const line of chunk.split("\n").filter(Boolean)) options.onStderr?.(line);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    });
    child.on("close", (code) => finish(code ?? 1));
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        killTree("SIGTERM");
        forceKill = setTimeout(() => killTree("SIGKILL"), 5_000);
        forceKill.unref();
        forceResolve = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          child.stdin.destroy();
          finish(124);
        }, 6_000);
        forceResolve.unref();
      }, options.timeoutMs);
      timeout.unref();
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
