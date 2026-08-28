/**
 * A minimal FIFO concurrency limiter.
 *
 * Board rendering is CPU- *and* memory-heavy: every concurrent render holds a
 * WASM overlay plane plus libvips working buffers, so an unbounded number of
 * simultaneous requests is what turns a busy minute into an OOM kill rather
 * than a slow response. Queueing keeps peak memory proportional to `limit`
 * instead of to the arrival rate — requests wait instead of the instance dying.
 *
 * Waiters are served in arrival order; a slot is released in `finally`, so a
 * rejecting task never strands one.
 */
export type Semaphore = {
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Tasks currently holding a slot. */
  readonly active: number;
  /** Tasks waiting for a slot. */
  readonly pending: number;
};

export function createSemaphore(limit: number): Semaphore {
  // A non-finite or sub-1 limit would deadlock every caller — clamp instead.
  const slots = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;

  const waiters: Array<() => void> = [];
  let active = 0;

  const acquire = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (active < slots) {
        active += 1;
        resolve();
        return;
      }
      waiters.push(resolve);
    });

  const release = (): void => {
    const next = waiters.shift();
    if (next) {
      // Hand the slot straight to the next waiter — `active` stays put.
      next();
      return;
    }
    active -= 1;
  };

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
    get pending() {
      return waiters.length;
    },
  };
}
