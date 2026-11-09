import { AUTH_ADMISSION_BATCH_SIZE } from './admission-read-runner';

type AdmissionWaiter = {
  resolve: (isActive: boolean) => void;
  reject: (error: unknown) => void;
};

/**
 * Callers arriving in one event-loop turn share one bounded primary read, so a
 * burst of requests or sockets costs one read slot rather than one slot each.
 *
 * A caller only ever joins a read that has not started, so its answer is never
 * older than its question. This coalesces work; it is not a cache.
 */
export function createAdmissionCoalescer(
  readActiveUserIds: (userIds: readonly string[]) => Promise<ReadonlySet<string>>,
): (userId: string) => Promise<boolean> {
  let waitersByUserId = new Map<string, AdmissionWaiter[]>();
  let isFlushScheduled = false;

  function flushWaiters() {
    isFlushScheduled = false;
    const claimedWaiters = waitersByUserId;
    waitersByUserId = new Map();
    const userIds = [...claimedWaiters.keys()];
    for (let offset = 0; offset < userIds.length; offset += AUTH_ADMISSION_BATCH_SIZE) {
      const batchUserIds = userIds.slice(offset, offset + AUTH_ADMISSION_BATCH_SIZE);
      void readActiveUserIds(batchUserIds).then(
        (activeUserIds) => {
          for (const userId of batchUserIds) {
            for (const waiter of claimedWaiters.get(userId) ?? []) waiter.resolve(activeUserIds.has(userId));
          }
        },
        (error: unknown) => {
          for (const userId of batchUserIds) {
            for (const waiter of claimedWaiters.get(userId) ?? []) waiter.reject(error);
          }
        },
      );
    }
  }

  return (userId) =>
    new Promise<boolean>((resolve, reject) => {
      const waiters = waitersByUserId.get(userId);
      if (waiters) waiters.push({ resolve, reject });
      else waitersByUserId.set(userId, [{ resolve, reject }]);
      if (!isFlushScheduled) {
        isFlushScheduled = true;
        setImmediate(flushWaiters);
      }
    });
}
