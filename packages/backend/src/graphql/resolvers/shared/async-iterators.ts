import { logger } from '../../../utils/logger';
// Maximum queue size for subscriptions to prevent memory issues with slow clients
const MAX_SUBSCRIPTION_QUEUE_SIZE = 1000;

/**
 * Logs the first overflow drop for an iterator, then every 100th thereafter.
 * A single persistently-slow-or-absent consumer would otherwise flood the log
 * with one warn per dropped event; this still surfaces that it's happening
 * (and how much) without the spam.
 */
function logOverflowDrop(label: string, droppedCount: number): void {
  if (droppedCount === 1 || droppedCount % 100 === 0) {
    logger.warn(
      `[Subscription] Queue full for "${label}", dropping oldest eligible event (${droppedCount} dropped so far)`,
    );
  }
}

export type CancellableAsyncIterator<T> = AsyncIterableIterator<T> & {
  return: (value?: unknown) => Promise<IteratorResult<T>>;
  throw: (error?: unknown) => Promise<IteratorResult<T>>;
};

export type SubscriptionQueueOptions<T> = {
  /** Synchronous, pure predicate. On overflow, evict ordinary events first. */
  isPriority?: (event: T) => boolean;
};

/**
 * Helper to create an async iterator from an async callback-based subscription.
 * Used for GraphQL subscriptions.
 * Includes bounded queue to prevent memory issues with slow clients.
 *
 * NOTE: This function is async because the subscribe function may need to
 * establish Redis connections before returning. We must await subscription
 * setup to ensure multi-instance pub/sub is ready before yielding events.
 *
 * @param label identifies this iterator in overflow logs (e.g.
 *   `boardNowPlaying:42`). Defaults to 'unknown' for call sites that haven't
 *   been updated to pass one.
 */
export async function createAsyncIterator<T>(
  subscribe: (push: (value: T) => void) => Promise<() => void>,
  label = 'unknown',
  options: SubscriptionQueueOptions<T> = {},
): Promise<CancellableAsyncIterator<T>> {
  return createCallbackAsyncIterator(subscribe, label, options);
}

/**
 * Helper to create an async iterator that subscribes IMMEDIATELY (eagerly).
 * Unlike createAsyncIterator which subscribes lazily when iteration starts,
 * this version subscribes right away to avoid missing events during setup.
 * This is critical for preventing race conditions where events could be
 * published between fetching initial state and starting to listen.
 *
 * NOTE: This function is async because the subscribe function may need to
 * establish Redis connections before returning. We must await subscription
 * setup to ensure multi-instance pub/sub is ready before yielding events.
 *
 * @param label identifies this iterator in overflow logs (e.g.
 *   `boardNowPlaying:42`). Defaults to 'unknown' for call sites that haven't
 *   been updated to pass one.
 */
export async function createEagerAsyncIterator<T>(
  subscribe: (push: (value: T) => void) => Promise<() => void>,
  label = 'unknown',
  options: SubscriptionQueueOptions<T> = {},
): Promise<CancellableAsyncIterator<T>> {
  return createCallbackAsyncIterator(subscribe, label, options);
}

async function createCallbackAsyncIterator<T>(
  subscribe: (push: (value: T) => void) => Promise<() => void>,
  label: string,
  { isPriority }: SubscriptionQueueOptions<T> = {},
): Promise<CancellableAsyncIterator<T>> {
  const queue: T[] = [];
  const pending: Array<(value: IteratorResult<T>) => void> = [];
  let done = false;
  let droppedCount = 0;

  // Subscribe and await Redis channel setup before returning the iterator.
  const unsubscribe = await subscribe((value: T) => {
    if (done) return;
    if (pending.length > 0) {
      pending.shift()!({ value, done: false });
    } else {
      // Keep FIFO order among retained events. Priority callers preserve their
      // latest state across ordinary-event bursts; even all-priority floods
      // remain bounded by evicting the oldest priority event as a last resort.
      if (queue.length >= MAX_SUBSCRIPTION_QUEUE_SIZE) {
        const ordinaryIndex = isPriority ? queue.findIndex((event) => !isPriority(event)) : 0;
        queue.splice(Math.max(0, ordinaryIndex), 1);
        droppedCount += 1;
        logOverflowDrop(label, droppedCount);
      }
      queue.push(value);
    }
  });

  const completedResult = (): IteratorResult<T> => ({ value: undefined as unknown as T, done: true });
  const close = (): void => {
    if (done) return;
    done = true;
    queue.length = 0;
    const result = completedResult();
    for (const resolvePending of pending.splice(0)) resolvePending(result);
    unsubscribe();
  };

  const iterator: CancellableAsyncIterator<T> = {
    async next(): Promise<IteratorResult<T>> {
      if (queue.length > 0) {
        return { value: queue.shift()!, done: false };
      }
      if (done) return completedResult();
      return new Promise((resolve) => pending.push(resolve));
    },
    async return(_value?: unknown): Promise<IteratorResult<T>> {
      close();
      return completedResult();
    },
    async throw(error?: unknown): Promise<IteratorResult<T>> {
      close();
      throw error;
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };

  return iterator;
}
