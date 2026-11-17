/**
 * The staged web password command's bcrypt compares, one sign-in at a time per
 * process.
 *
 * bcryptjs is plain JavaScript on the event loop that also serves every
 * WebSocket. A cost-12 compare takes about 200 ms, in slices of up to 100 ms,
 * and compares running together stack their slices: ten at once hold the loop
 * for a second at a time. One sign-in at a time, its compares one after another,
 * keeps this route's share of each stall to one slice.
 *
 * What this does NOT bound: it covers the staged web password command only.
 * Registration, password reset and set-password hashes and every native
 * compare still run beside it, so the loop can still see several slices at
 * once.
 */
export const PASSWORD_COMPARE_CONCURRENCY = 1;
/** Sign-ins that may wait for their turn: about 3 s of work at 200 ms each. */
export const MAX_WAITING_PASSWORD_COMPARES = 16;
/**
 * How long a sign-in waits for its turn before it is answered 503. Well inside
 * the web server's 8 s give-up, so the climber sees a retry, not a timeout.
 */
export const PASSWORD_COMPARE_WAIT_MS = 2_500;
/** About how long a full queue takes to drain at one sign-in per 200 ms. */
export const PASSWORD_COMPARES_RETRY_AFTER_SECONDS = 3;

/** The queue was full, or the wait ran past its deadline. Answered with a 503 and `Retry-After`. */
export class PasswordComparesSaturatedError extends Error {
  constructor() {
    super('Password compares are saturated');
    this.name = 'PasswordComparesSaturatedError';
  }
}

/** The caller went away while the sign-in waited; its compares never ran. */
export class PasswordCompareAbortedError extends Error {
  constructor() {
    super('Password compare abandoned by its caller');
    this.name = 'PasswordCompareAbortedError';
  }
}

export interface PasswordCompareGate {
  /**
   * Runs one sign-in's compares in its turn: all of them, inside one slot, so a
   * sign-in is never partly shed. Rejects with `PasswordComparesSaturatedError`
   * when the queue is full or the wait passes its deadline, and with
   * `PasswordCompareAbortedError`, without running anything, when `signal`
   * aborts first.
   */
  run<Result>(compares: () => Promise<Result>, signal?: AbortSignal): Promise<Result>;
  /** True when a sign-in arriving now would be refused. */
  isFull(): boolean;
  /** Sign-ins waiting for their turn. */
  waiting(): number;
}

/** A FIFO gate with a capped queue and a deadline on every wait. */
export function createPasswordCompareGate({
  concurrency = PASSWORD_COMPARE_CONCURRENCY,
  maxWaiting = MAX_WAITING_PASSWORD_COMPARES,
  waitMs = PASSWORD_COMPARE_WAIT_MS,
}: { concurrency?: number; maxWaiting?: number; waitMs?: number } = {}): PasswordCompareGate {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = () => {
    const next = queue.shift();
    // Hand the slot straight to the next waiter; `active` stays put.
    if (next) next();
    else active -= 1;
  };
  const acquire = (signal: AbortSignal | undefined) =>
    new Promise<void>((resolve, reject) => {
      // Exactly one of these runs: the slot arrives, the deadline passes, or the caller leaves.
      function start() {
        cleanup();
        resolve();
      }
      function leave(error: Error) {
        const index = queue.indexOf(start);
        if (index !== -1) queue.splice(index, 1);
        cleanup();
        reject(error);
      }
      function onAbort() {
        leave(new PasswordCompareAbortedError());
      }
      function cleanup() {
        clearTimeout(deadline);
        signal?.removeEventListener('abort', onAbort);
      }
      const deadline = setTimeout(() => leave(new PasswordComparesSaturatedError()), waitMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(start);
    });
  return {
    isFull: () => active >= concurrency && queue.length >= maxWaiting,
    waiting: () => queue.length,
    async run(compares, signal) {
      if (signal?.aborted) throw new PasswordCompareAbortedError();
      // Synchronous up to the first await, so no other sign-in can take the slot in between.
      if (active < concurrency) active += 1;
      else if (queue.length >= maxWaiting) throw new PasswordComparesSaturatedError();
      else await acquire(signal);
      try {
        // An abort that landed while the slot was being handed over still skips the work.
        if (signal?.aborted) throw new PasswordCompareAbortedError();
        return await compares();
      } finally {
        release();
      }
    },
  };
}

/** The process-wide gate the staged web password command uses. */
export const passwordCompareGate = createPasswordCompareGate();
