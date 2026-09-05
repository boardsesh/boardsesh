// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

/**
 * A minimal FIFO concurrency limiter.
 *
 * Board rendering is CPU- *and* memory-heavy: every concurrent render holds a
 * WASM overlay plane plus libvips working buffers, so an unbounded number of
 * simultaneous requests is what turns a busy minute into an OOM kill rather
 * than a slow response. Queueing keeps peak memory proportional to `limit`
 * instead of to the arrival rate — requests wait instead of the instance dying.
 *
 * Request waiters are FIFO and run before queued low-priority background work;
 * each priority is FIFO. A slot is released in `finally`, so a rejecting task
 * never strands one.
 */
export type Semaphore = {
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Run background work only after any queued request work. */
  runLowPriority<T>(fn: () => Promise<T>): Promise<T>;
  /** Tasks currently holding a slot. */
  readonly active: number;
  /** Tasks waiting for a slot. */
  readonly pending: number;
};

export function createSemaphore(limit: number): Semaphore {
  // A non-finite or sub-1 limit would deadlock every caller — clamp instead.
  const slots = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;

  const waiters: Array<() => void> = [];
  const lowPriorityWaiters: Array<() => void> = [];
  let active = 0;

  const acquire = (lowPriority: boolean): Promise<void> =>
    new Promise<void>((resolve) => {
      if (active < slots) {
        active += 1;
        resolve();
        return;
      }
      (lowPriority ? lowPriorityWaiters : waiters).push(resolve);
    });

  const release = (): void => {
    const next = waiters.shift() ?? lowPriorityWaiters.shift();
    if (next) {
      // Hand the slot straight to the next waiter — `active` stays put.
      next();
      return;
    }
    active -= 1;
  };

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire(false);
      try {
        return await fn();
      } finally {
        release();
      }
    },
    async runLowPriority<T>(fn: () => Promise<T>): Promise<T> {
      await acquire(true);
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
      return waiters.length + lowPriorityWaiters.length;
    },
  };
}
