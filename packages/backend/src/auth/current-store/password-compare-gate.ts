/**
 * Where a staged web sign-in's password compares wait. `first` is for a client
 * with no rejected password in its current minute and always goes ahead;
 * `repeat` is everyone else, including a sign-in with no client address.
 */
export type PasswordCompareLane = 'first' | 'repeat';

/**
 * One compare at a time per process. bcryptjs runs on the event loop that also
 * serves every WebSocket: a cost-12 compare takes about 200 ms, in slices of up
 * to 100 ms, and compares running together stack their slices, so ten at once
 * hold the loop for a second at a time. One at a time keeps each stall to one
 * slice and costs no throughput, since a process has one thread to compare on.
 */
export const PASSWORD_COMPARE_CONCURRENCY = 1;
/** Compares that may wait in each lane: about 1.6 s of work at 200 ms each. */
export const MAX_WAITING_PASSWORD_COMPARES = 8;
/** About how long a full lane takes to drain. */
export const PASSWORD_COMPARES_RETRY_AFTER_SECONDS = 2;

/** The sign-in's lane is full. Answered with a 503 and `Retry-After`. */
export class PasswordComparesSaturatedError extends Error {
  constructor() {
    super('Password compares are saturated');
    this.name = 'PasswordComparesSaturatedError';
  }
}

export interface PasswordCompareGate {
  /** Runs one compare in its turn. Rejects with `PasswordComparesSaturatedError` when the lane is full. */
  run<Result>(lane: PasswordCompareLane, compare: () => Promise<Result>): Promise<Result>;
  /** True when a compare in this lane would be refused now. */
  isFull(lane: PasswordCompareLane): boolean;
  /** Compares waiting in this lane. */
  waiting(lane: PasswordCompareLane): number;
}

/**
 * A FIFO gate with two capped lanes. A client that keeps getting its password
 * wrong fills only the `repeat` lane, so it can delay or refuse other repeat
 * attempts but never a climber's first try.
 */
export function createPasswordCompareGate(
  concurrency = PASSWORD_COMPARE_CONCURRENCY,
  maxWaiting = MAX_WAITING_PASSWORD_COMPARES,
): PasswordCompareGate {
  let active = 0;
  const queues: Record<PasswordCompareLane, Array<() => void>> = { first: [], repeat: [] };
  const release = () => {
    const next = queues.first.shift() ?? queues.repeat.shift();
    // Hand the slot straight to the next waiter; `active` stays put.
    if (next) next();
    else active -= 1;
  };
  return {
    isFull: (lane) => active >= concurrency && queues[lane].length >= maxWaiting,
    waiting: (lane) => queues[lane].length,
    async run(lane, compare) {
      // Synchronous up to the first await, so no other request can take the slot in between.
      if (active < concurrency) active += 1;
      else if (queues[lane].length >= maxWaiting) throw new PasswordComparesSaturatedError();
      else await new Promise<void>((resolve) => queues[lane].push(resolve));
      try {
        return await compare();
      } finally {
        release();
      }
    },
  };
}

/** The process-wide gate the staged web sign-in route uses. */
export const passwordCompareGate = createPasswordCompareGate();
