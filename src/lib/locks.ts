import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { now } from "./utils.js";

export type HeldLock = {
  name: string;
  release: () => Promise<void>;
  /** Return this live acquisition for a canonical resource, never an inferred owner. */
  forResource: (manager: LockManager, name: string) => HeldLock | undefined;
};
export type AcquireOptions = { timeoutMs?: number; pollMs?: number };

function lockKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export class LockManager {
  // FIFO admission is local to this manager; file locks still provide
  // cross-process exclusion. New job leases must not bypass waiting evals.
  private readonly waiters = new Map<string, symbol[]>();

  // Retain the old constructor argument for callers, but never expire a lock:
  // age or controller death does not prove its protected work has stopped.
  constructor(private readonly lockDir: string, _staleMs?: number) {}

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
      const token = randomUUID();
      let released = false;
      let borrowingClosed = false;
      let releaseInFlight: Promise<void> | undefined;
      const release = (): Promise<void> => {
        borrowingClosed = true;
        if (released) return Promise.resolve();
        if (releaseInFlight) return releaseInFlight;
        // Concurrent releases of one handle must join the same unlink. A second
        // token read followed by a delayed unlink could remove a replacement
        // published after the first caller completed its unlink.
        releaseInFlight = (async () => {
          try {
            const current = JSON.parse(await readFile(path, "utf8")) as { token?: string };
            if (current.token !== token) throw new Error(`Lock '${name}' no longer belongs to this acquisition.`);
            await rm(path, { force: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          released = true;
        })().finally(() => { releaseInFlight = undefined; });
        return releaseInFlight;
      };
      const handle = await open(temporaryPath, "wx");
      let published = false;
      let publicationError: unknown;
      try {
        const errors: unknown[] = [];
        try { await handle.writeFile(JSON.stringify({ owner, pid: process.pid, createdAt: now(), token })); }
        catch (error) { errors.push(error); }
        try { await handle.close(); } catch (error) { errors.push(error); }
        if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, `Could not write lock '${name}'.`);
        await link(temporaryPath, path);
        published = true;
      } catch (error) {
        publicationError = error;
      }
      try { await rm(temporaryPath, { force: true }); }
      catch (error) {
        // The hard link may already be public although no handle was returned.
        // Only its token owner may undo that publication; retain every failure.
        const errors = [...(publicationError ? [publicationError] : []), error];
        if (published) try { await release(); } catch (cleanupError) { errors.push(cleanupError); }
        throw new AggregateError(errors, `Could not clean up lock publication for '${name}'.`);
      }
      if (publicationError) throw publicationError;
      const held: HeldLock = {
        name, release,
        forResource: (manager, requestedName) => {
          if (manager !== this) throw new Error(`Lock '${name}' belongs to a different resource manager.`);
          if (safeName !== lockKey(requestedName)) return undefined;
          if (borrowingClosed) throw new Error(`Lock '${name}' is releasing or released; it cannot be borrowed.`);
          return held;
        },
      };
      return held;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
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
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for resource lock '${name}' at ${resolve(this.lockDir, `${key}.lock`)}. ` +
            "Burner does not expire or automatically reclaim occupied locks. Stopping a controller does not prove its work stopped. " +
            "Establish quiescence of every controller and its work for this project before operator recovery of this exact lock.");
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
      }
    } finally {
      queue.splice(queue.indexOf(waiter), 1);
      if (!queue.length) this.waiters.delete(key);
    }
  }

  async tryAcquireAll(names: string[], owner: string): Promise<{ locks: HeldLock[]; release: () => Promise<void> } | undefined> {
    const locks: HeldLock[] = [];
    const release = async () => {
      const results = await Promise.allSettled(locks.map((held) => held.release()));
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Could not release all acquired resource locks.");
    };
    try {
      for (const name of [...new Set(names)].sort()) {
        const lock = await this.tryAcquire(name, owner);
        if (!lock) {
          await release();
          return undefined;
        }
        locks.push(lock);
      }
    } catch (error) {
      try { await release(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Resource acquisition and partial cleanup failed."); }
      throw error;
    }
    return { locks, release };
  }

  async list(): Promise<string[]> {
    await this.init();
    return (await readdir(this.lockDir)).filter((name) => name.endsWith(".lock")).map((name) => name.slice(0, -5));
  }

  /** @deprecated Compatibility no-op. Only an operator with established project quiescence may recover abandoned locks. */
  async reapOrphans(): Promise<string[]> {
    await this.init();
    return [];
  }
}
