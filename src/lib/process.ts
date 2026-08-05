import { spawn } from "node:child_process";

const DEFAULT_SUSPEND_GAP_MS = 30_000;

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    input?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
    onStderr?: (line: string) => void;
    /** Test seam for simulating a host suspend without making the suite sleep for 30 seconds. */
    timeoutSuspendGapMs?: number;
  },
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
    let aborted = false;
    let timeout: NodeJS.Timeout | undefined;
    let activeTimeoutMs = 0;
    let lastTimeoutCheckAt = Date.now();
    let forceKill: NodeJS.Timeout | undefined;
    let forceResolve: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (forceResolve) clearTimeout(forceResolve);
      if (abortListener) options.signal?.removeEventListener("abort", abortListener);
    };
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimers();
      const termination = timedOut
        ? `Command timed out after ${options.timeoutMs}ms.`
        : aborted ? "Command aborted during Burner shutdown." : "";
      resolve({
        stdout,
        stderr: termination ? `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}${termination}` : stderr,
        exitCode: timedOut ? 124 : aborted ? 130 : exitCode,
      });
    };
    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The process group may already have exited between the timeout and signal.
      }
    };
    const terminate = (reason: "timeout" | "abort") => {
      if (settled || timedOut || aborted) return;
      timedOut = reason === "timeout";
      aborted = reason === "abort";
      killTree("SIGTERM");
      forceKill = setTimeout(() => killTree("SIGKILL"), 5_000);
      forceKill.unref();
      forceResolve = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        finish(reason === "timeout" ? 124 : 130);
      }, 6_000);
      forceResolve.unref();
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
      const heartbeatMs = Math.min(1_000, Math.max(10, Math.floor(options.timeoutMs / 10)));
      const suspendGapMs = options.timeoutSuspendGapMs ?? DEFAULT_SUSPEND_GAP_MS;
      const checkTimeout = () => {
        if (settled || timedOut || aborted) return;
        const now = Date.now();
        const wallElapsedMs = Math.max(0, now - lastTimeoutCheckAt);
        lastTimeoutCheckAt = now;
        // A local Burner server commonly runs on a laptop. System suspend stops the
        // child process too, so suspended wall time is not part of its execution
        // budget. Normal scheduling delay still counts and true hangs fail closed.
        activeTimeoutMs += wallElapsedMs >= suspendGapMs ? Math.min(wallElapsedMs, heartbeatMs) : wallElapsedMs;
        if (activeTimeoutMs >= options.timeoutMs!) terminate("timeout");
        else {
          timeout = setTimeout(checkTimeout, Math.min(heartbeatMs, options.timeoutMs! - activeTimeoutMs));
          timeout.unref();
        }
      };
      timeout = setTimeout(checkTimeout, heartbeatMs);
      timeout.unref();
    }
    if (options.signal) {
      abortListener = () => terminate("abort");
      if (options.signal.aborted) abortListener();
      else options.signal.addEventListener("abort", abortListener, { once: true });
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
