import {
  AUTH_ADMISSION_BATCH_SIZE,
  AUTH_ADMISSION_RESPONSE_DEADLINE_MS,
  AuthAdmissionUnavailableError,
} from './admission-read-runner';

/**
 * Reads this coalescer runs at once. It stays under the runner's eight slots so
 * ordinary requests cannot crowd out the WebSocket sweep, which calls the runner
 * directly. During a stall, timed-out reads can still hold every slot.
 */
export const MAX_CONCURRENT_COALESCED_ADMISSION_READS = 4;

/** Distinct users allowed to wait for a read before new callers are refused. */
export const MAX_WAITING_ADMISSION_USERS = 1024;

type AdmissionWaiter = {
  enqueuedAt: number;
  resolve: (isActive: boolean) => void;
  reject: (error: unknown) => void;
};

/**
 * Callers share primary reads, so a burst of requests or sockets costs a few
 * read slots rather than one slot each. While every read is in flight, callers
 * wait for the next one instead of being refused, up to the response deadline.
 *
 * A caller only ever joins a read that has not started, so its answer is never
 * older than its question. This coalesces work; it is not a cache.
 */
export function createAdmissionCoalescer(
  readActiveUserIds: (userIds: readonly string[]) => Promise<ReadonlySet<string>>,
): (userId: string) => Promise<boolean> {
  const waitersByUserId = new Map<string, AdmissionWaiter[]>();
  let inFlightReads = 0;
  let isFlushScheduled = false;

  function scheduleFlush() {
    if (isFlushScheduled) return;
    isFlushScheduled = true;
    setImmediate(flushWaiters);
  }

  /** Removes up to one batch of waiters, refusing any that outlived the deadline. */
  function claimNextBatch(): Map<string, AdmissionWaiter[]> {
    const claimedWaiters = new Map<string, AdmissionWaiter[]>();
    const oldestAllowed = performance.now() - AUTH_ADMISSION_RESPONSE_DEADLINE_MS;
    for (const [userId, waiters] of waitersByUserId) {
      if (claimedWaiters.size === AUTH_ADMISSION_BATCH_SIZE) break;
      waitersByUserId.delete(userId);
      const liveWaiters = waiters.filter((waiter) => {
        if (waiter.enqueuedAt > oldestAllowed) return true;
        waiter.reject(new AuthAdmissionUnavailableError());
        return false;
      });
      if (liveWaiters.length > 0) claimedWaiters.set(userId, liveWaiters);
    }
    return claimedWaiters;
  }

  function flushWaiters() {
    isFlushScheduled = false;
    while (inFlightReads < MAX_CONCURRENT_COALESCED_ADMISSION_READS && waitersByUserId.size > 0) {
      const claimedWaiters = claimNextBatch();
      if (claimedWaiters.size === 0) continue;
      inFlightReads += 1;
      void readActiveUserIds([...claimedWaiters.keys()])
        .then(
          (activeUserIds) => {
            for (const [userId, waiters] of claimedWaiters) {
              for (const waiter of waiters) waiter.resolve(activeUserIds.has(userId));
            }
          },
          (error: unknown) => {
            for (const waiters of claimedWaiters.values()) {
              for (const waiter of waiters) waiter.reject(error);
            }
          },
        )
        .finally(() => {
          inFlightReads -= 1;
          if (waitersByUserId.size > 0) scheduleFlush();
        });
    }
  }

  return (userId) =>
    new Promise<boolean>((resolve, reject) => {
      const waiters = waitersByUserId.get(userId);
      if (!waiters && waitersByUserId.size >= MAX_WAITING_ADMISSION_USERS) {
        reject(new AuthAdmissionUnavailableError());
        return;
      }
      const waiter = { enqueuedAt: performance.now(), resolve, reject };
      if (waiters) waiters.push(waiter);
      else waitersByUserId.set(userId, [waiter]);
      scheduleFlush();
    });
}
