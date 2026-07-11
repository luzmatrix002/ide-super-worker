import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ConcurrencyTicket {
  release: () => void;
}

export interface CrossProcessSemaphoreOptions {
  root: string;
  lane: string;
  maxActive: number;
  maxQueue: number;
  acquireTimeoutMs: number;
  pollMs?: number;
}

interface OwnerRecord {
  pid: number;
  created_at: number;
  id: string;
}

export class GlobalConcurrencyBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobalConcurrencyBusyError";
  }
}

const ownedFiles = new Set<string>();
let cleanupRegistered = false;

function cleanupOwnedFiles(): void {
  for (const file of ownedFiles) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Best effort during process shutdown.
    }
  }
  ownedFiles.clear();
}

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once("exit", cleanupOwnedFiles);
}

function ownerIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function readOwner(file: string): OwnerRecord | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as OwnerRecord;
    return Number.isInteger(value.pid) && typeof value.id === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CrossProcessSemaphore {
  private readonly laneDir: string;
  private readonly queueDir: string;
  private readonly activeDir: string;
  private readonly stateLock: string;
  private readonly sequenceFile: string;
  private readonly pollMs: number;

  constructor(private readonly options: CrossProcessSemaphoreOptions) {
    this.laneDir = path.join(options.root, options.lane);
    this.queueDir = path.join(this.laneDir, "queue");
    this.activeDir = path.join(this.laneDir, "active");
    this.stateLock = path.join(this.laneDir, "state.lock");
    this.sequenceFile = path.join(this.laneDir, "sequence");
    this.pollMs = options.pollMs ?? 50;
    fs.mkdirSync(this.queueDir, { recursive: true });
    fs.mkdirSync(this.activeDir, { recursive: true });
    registerCleanup();
  }

  async acquire(signal?: AbortSignal): Promise<ConcurrencyTicket> {
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const owner: OwnerRecord = { pid: process.pid, created_at: createdAt, id };
    let ticketFile: string | undefined;

    await this.withStateLock(() => {
      this.cleanupDeadOwners();
      const waiting = this.listJson(this.queueDir).length;
      if (waiting >= this.options.maxQueue) {
        throw new GlobalConcurrencyBusyError(
          `Global ${this.options.lane} queue is full (limit ${this.options.maxQueue}); retry later.`
        );
      }
      let previousSequence = 0;
      try {
        previousSequence = Number(fs.readFileSync(this.sequenceFile, "utf8")) || 0;
      } catch {
        // First ticket in this lane.
      }
      const sequence = Math.max(previousSequence, Date.now() * 1_000) + 1;
      fs.writeFileSync(this.sequenceFile, String(sequence));
      ticketFile = path.join(this.queueDir, `${String(sequence).padStart(20, "0")}-${id}.json`);
      fs.writeFileSync(ticketFile, JSON.stringify(owner), { flag: "wx" });
      ownedFiles.add(ticketFile);
    });
    if (!ticketFile) throw new Error(`Failed to enqueue global ${this.options.lane} ticket.`);

    const deadline = createdAt + this.options.acquireTimeoutMs;
    try {
      while (true) {
        if (signal?.aborted) throw new Error(`Global ${this.options.lane} acquire cancelled.`);
        if (Date.now() >= deadline) {
          throw new GlobalConcurrencyBusyError(
            `Timed out waiting ${this.options.acquireTimeoutMs}ms for global ${this.options.lane} capacity.`
          );
        }

        const leaseFile = await this.withStateLock(() => {
          this.cleanupDeadOwners();
          const queue = this.listJson(this.queueDir).sort();
          const active = this.listJson(this.activeDir);
          if (queue[0] !== ticketFile || active.length >= this.options.maxActive) return undefined;
          const lease = path.join(this.activeDir, `${id}.json`);
          fs.writeFileSync(lease, JSON.stringify(owner), { flag: "wx" });
          fs.unlinkSync(ticketFile);
          ownedFiles.delete(ticketFile);
          ownedFiles.add(lease);
          return lease;
        });

        if (leaseFile) {
          let released = false;
          return {
            release: () => {
              if (released) return;
              released = true;
              ownedFiles.delete(leaseFile);
              try {
                fs.unlinkSync(leaseFile);
              } catch (error: any) {
                if (error?.code !== "ENOENT") throw error;
              }
            }
          };
        }
        await delay(this.pollMs);
      }
    } catch (error) {
      ownedFiles.delete(ticketFile);
      try {
        fs.unlinkSync(ticketFile);
      } catch {
        // Another cleanup path may already have removed it.
      }
      throw error;
    }
  }

  private listJson(dir: string): string[] {
    try {
      return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => path.join(dir, name));
    } catch {
      return [];
    }
  }

  private cleanupDeadOwners(): void {
    for (const file of [...this.listJson(this.queueDir), ...this.listJson(this.activeDir)]) {
      const owner = readOwner(file);
      if (owner && ownerIsAlive(owner.pid)) continue;
      try {
        fs.unlinkSync(file);
      } catch {
        // A concurrent cleanup may have won the race.
      }
    }
  }

  private async withStateLock<T>(operation: () => T): Promise<T> {
    const deadline = Date.now() + Math.min(5_000, this.options.acquireTimeoutMs);
    while (true) {
      let fd: number | undefined;
      try {
        fd = fs.openSync(this.stateLock, "wx");
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: Date.now(), id: "state-lock" }));
        return operation();
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const owner = readOwner(this.stateLock);
          if (owner ? !ownerIsAlive(owner.pid) : Date.now() - fs.statSync(this.stateLock).mtimeMs > 30_000) {
            fs.unlinkSync(this.stateLock);
          }
        } catch {
          // The lock changed between stat and unlink.
        }
        if (Date.now() >= deadline) {
          throw new GlobalConcurrencyBusyError(`Timed out acquiring global ${this.options.lane} state lock.`);
        }
        await delay(this.pollMs);
      } finally {
        if (fd !== undefined) {
          fs.closeSync(fd);
          try {
            fs.unlinkSync(this.stateLock);
          } catch {
            // Best effort; stale-lock cleanup handles interruption.
          }
        }
      }
    }
  }
}
