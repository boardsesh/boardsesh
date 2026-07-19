const AUTH_COOKIE_LOCK_NAME = 'boardsesh-nextauth-cookie-v1';

let fallbackMutationQueue: Promise<void> = Promise.resolve();

function getLockManager(): LockManager | null {
  try {
    return typeof navigator === 'undefined' ? null : navigator.locks;
  } catch {
    return null;
  }
}

/**
 * Serialize NextAuth cookie reads and writes across Expo browser tabs. Session
 * reads reissue the JWT cookie, so they share the same lock as login and logout.
 * The in-realm queue preserves ordering in browsers without Web Locks, but only
 * the origin-scoped Web Lock can close cross-tab response-order races.
 */
export function withAuthCookieLock<Result>(operation: () => Promise<Result>, signal?: AbortSignal): Promise<Result> {
  const lockManager = getLockManager();
  if (lockManager) {
    return lockManager.request(AUTH_COOKIE_LOCK_NAME, { mode: 'exclusive', ...(signal ? { signal } : {}) }, operation);
  }

  let stopListeningForAbort: (() => void) | undefined;
  const guardedOperation = () => {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Authentication cookie lock aborted'));
    // Web Locks uses `signal` only while waiting for acquisition. Match that
    // contract in the fallback so an operation that already owns the queue is
    // not rejected while its separately bounded network work continues.
    stopListeningForAbort?.();
    return operation();
  };
  const queuedResult = fallbackMutationQueue.then(guardedOperation, guardedOperation);
  fallbackMutationQueue = queuedResult.then(
    () => undefined,
    () => undefined,
  );
  if (!signal) return queuedResult;

  return new Promise<Result>((resolve, reject) => {
    const rejectFromAbort = () => reject(signal.reason ?? new Error('Authentication cookie lock aborted'));
    stopListeningForAbort = () => signal.removeEventListener('abort', rejectFromAbort);
    if (signal.aborted) {
      rejectFromAbort();
      return;
    }

    signal.addEventListener('abort', rejectFromAbort, { once: true });
    void queuedResult.then(
      (result) => {
        stopListeningForAbort?.();
        resolve(result);
      },
      (error: unknown) => {
        stopListeningForAbort?.();
        reject(error);
      },
    );
  });
}
