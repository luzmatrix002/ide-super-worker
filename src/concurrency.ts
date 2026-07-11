import { LITE_MAX_CONCURRENCY, FANOUT_MAX_ACTIVE } from "./config.js";

/**
 * FIFO semaphore that limits concurrent lite-path gateway calls.
 *
 * The semaphore covers normal analyze/review, failure digest, fan-out branch
 * execution, fan-out reviewer, and semantic reviewer. It does NOT cover Claude
 * Code `start` traffic — those are bounded by MAX_RUNNING_JOBS separately.
 */
export class FIFOSemaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<{ release: () => void }> {
    if (this.active < this.max) {
      this.active += 1;
    } else {
      await new Promise<void>((resolve) => this.queue.push(resolve));
      this.active += 1;
    }
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        const next = this.queue.shift();
        if (next) next();
      }
    };
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.queue.length;
  }
}

/**
 * Singleton semaphore for all lite-path gateway calls.
 * Limits concurrent calls to WORKER_LITE_MAX_CONCURRENCY (default 3).
 */
export const liteSemaphore = new FIFOSemaphore(LITE_MAX_CONCURRENCY);

/**
 * Singleton semaphore for concurrent fan-out operations.
 * Limits concurrent fan-out executions to WORKER_FANOUT_MAX_ACTIVE (default 1).
 * This prevents nested or overlapping fan-out operations.
 */
export const fanoutSlotSemaphore = new FIFOSemaphore(FANOUT_MAX_ACTIVE);
