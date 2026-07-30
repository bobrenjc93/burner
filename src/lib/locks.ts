import { mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, now } from "./utils.js";

export type HeldLock = { name: string; release: () => Promise<void> };
export type AcquireOptions = { timeoutMs?: number; pollMs?: number };

export class LockManager {
  constructor(private readonly lockDir: string, private readonly staleMs = 6 * 60 * 60 * 1000) {}

  async init(): Promise<void> {
    await mkdir(this.lockDir, { recursive: true });
  }

  async tryAcquire(name: string, owner: string): Promise<HeldLock | undefined> {
    await this.init();
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "-");
    const path = join(this.lockDir, `${safeName}.lock`);
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(JSON.stringify({ owner, pid: process.pid, createdAt: now() }));
      await handle.close();
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
          return this.tryAcquire(name, owner);
        }
      } catch (readError) {
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
    while (true) {
      const lock = await this.tryAcquire(name, owner);
      if (lock) return lock;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for resource lock '${name}'.`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
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
