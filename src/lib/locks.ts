import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, now } from "./utils.js";

export type HeldLock = { name: string; release: () => Promise<void> };
export type AcquireOptions = { timeoutMs?: number; pollMs?: number };

function lockKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export class LockManager {
  // FIFO admission is local to this manager; file locks still provide
  // cross-process exclusion. New job leases must not bypass waiting evals.
  private readonly waiters = new Map<string, symbol[]>();

  constructor(private readonly lockDir: string, private readonly staleMs = 6 * 60 * 60 * 1000) {}

  async init(): Promise<void> {
    await mkdir(this.lockDir, { recursive: true });
  }

  async tryAcquire(name: string, owner: string): Promise<HeldLock | undefined> {
    return this.tryAcquireQueued(name, owner);
  }

  private async tryAcquireQueued(name: string, owner: string, waiter?: symbol): Promise<HeldLock | undefined> {
    const safeName = lockKey(name);
    const first = this.waiters.get(safeName)?.[0];
    if (first !== undefined && first !== waiter) return undefined;
    await this.init();
    const path = join(this.lockDir, `${safeName}.lock`);
    try {
      // Publish complete metadata atomically without replacing another owner.
      // Opening the public path first exposes an empty file to concurrent readers.
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      const handle = await open(temporaryPath, "wx");
      try {
        try {
          await handle.writeFile(JSON.stringify({ owner, pid: process.pid, createdAt: now() }));
        } finally {
          await handle.close();
        }
        await link(temporaryPath, path);
      } finally {
        await rm(temporaryPath, { force: true });
      }
      let released = false;
      return {
        name,
        release: async () => {
          if (released) return;
          released = true;
          await rm(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const contents = JSON.parse(await readFile(path, "utf8")) as { createdAt?: string };
        if (contents.createdAt && Date.now() - new Date(contents.createdAt).getTime() > this.staleMs) {
          await rm(path, { force: true });
          return this.tryAcquireQueued(name, owner, waiter);
        }
      } catch (readError) {
        // Older publishers can still expose incomplete metadata. Treat that as
        // contention: never steal an unknown owner's lock or fail a waiting eval.
        if (readError instanceof SyntaxError) return undefined;
        if ((readError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error(`Could not inspect lock ${name}: ${errorMessage(readError)}`);
        }
      }
      return undefined;
    }
  }

  async acquire(name: string, owner: string, options: AcquireOptions = {}): Promise<HeldLock> {
    const timeoutMs = options.timeoutMs ?? 2 * 60 * 1000;
    const pollMs = Math.max(10, options.pollMs ?? 100);
    const deadline = Date.now() + timeoutMs;
    const key = lockKey(name);
    const waiter = Symbol(owner);
    const queue = this.waiters.get(key) ?? [];
    queue.push(waiter);
    this.waiters.set(key, queue);
    try {
      while (true) {
        const lock = await this.tryAcquireQueued(name, owner, waiter);
        if (lock) return lock;
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for resource lock '${name}'.`);
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
      }
    } finally {
      queue.splice(queue.indexOf(waiter), 1);
      if (!queue.length) this.waiters.delete(key);
    }
  }

  async tryAcquireAll(names: string[], owner: string): Promise<{ locks: HeldLock[]; release: () => Promise<void> } | undefined> {
    const locks: HeldLock[] = [];
    for (const name of [...new Set(names)].sort()) {
      const lock = await this.tryAcquire(name, owner);
      if (!lock) {
        await Promise.all(locks.map((held) => held.release()));
        return undefined;
      }
      locks.push(lock);
    }
    return { locks, release: async () => void (await Promise.all(locks.map((lock) => lock.release()))) };
  }

  async list(): Promise<string[]> {
    await this.init();
    return (await readdir(this.lockDir)).filter((name) => name.endsWith(".lock")).map((name) => name.slice(0, -5));
  }

  async reapOrphans(): Promise<string[]> {
    await this.init();
    const removed: string[] = [];
    for (const filename of await readdir(this.lockDir)) {
      if (!filename.endsWith(".lock")) continue;
      const path = join(this.lockDir, filename);
      try {
        const contents = JSON.parse(await readFile(path, "utf8")) as { pid?: number; createdAt?: string };
        const stale = contents.createdAt && Date.now() - new Date(contents.createdAt).getTime() > this.staleMs;
        let alive = false;
        if (contents.pid) {
          try { process.kill(contents.pid, 0); alive = true; } catch { alive = false; }
        }
        if (stale || !alive) {
          await rm(path, { force: true });
          removed.push(filename.slice(0, -5));
        }
      } catch {
        await rm(path, { force: true });
        removed.push(filename.slice(0, -5));
      }
    }
    return removed;
  }
}
