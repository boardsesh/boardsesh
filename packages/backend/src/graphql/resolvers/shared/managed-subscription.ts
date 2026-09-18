import { logger } from '../../../utils/logger';
import type { CancellableAsyncIterator } from './async-iterators';

class SubscriptionCancelled extends Error {}

export type SubscriptionLifetime = {
  readonly closed: boolean;
  own: <T>(source: Promise<CancellableAsyncIterator<T>>) => Promise<CancellableAsyncIterator<T>>;
};

/**
 * Async generators queue return() behind an outstanding next(). On a quiet
 * pubsub feed that also blocks graphql-ws's onDisconnect forever. Own the
 * underlying sources outside the generator so cancellation can wake them up.
 * The outer next() also settles during a pending seed or permission lookup;
 * late setup is closed immediately and cannot publish after cancellation.
 * return() signals cancellation, not completion of async generator finalizers;
 * cleanup that must run immediately belongs in an owned source's return().
 */
export function withSubscriptionCleanup<Args extends unknown[], Payload>(
  subscribe: (lifetime: SubscriptionLifetime, ...args: Args) => AsyncGenerator<Payload>,
): (...args: Args) => CancellableAsyncIterator<Payload> {
  return (...args) => {
    let closed = false;
    const sources = new Set<() => Promise<unknown>>();
    const completed = (): IteratorResult<Payload> => ({ value: undefined, done: true });
    const pendingReads = new Set<(result: IteratorResult<Payload>) => void>();
    const logCleanupError = (error: unknown): void => {
      if (!(error instanceof SubscriptionCancelled)) logger.warn('[Subscription] Cleanup failed:', error);
    };
    const lifetime: SubscriptionLifetime = {
      get closed() {
        return closed;
      },
      async own(sourcePromise) {
        const source = await sourcePromise;
        if (closed) {
          await source.return();
          throw new SubscriptionCancelled();
        }
        sources.add(() => source.return());
        return source;
      },
    };
    const generator = subscribe(lifetime, ...args);
    const close = (): void => {
      if (closed) return;
      closed = true;
      for (const resolvePending of pendingReads) resolvePending(completed());
      pendingReads.clear();
      for (const release of sources) void release().catch(logCleanupError);
      sources.clear();
      // Don't await an in-flight seed/permission check. Its eventual result is
      // discarded; return still runs the generator's finally when it settles.
      void generator.return(undefined).catch(logCleanupError);
    };
    const iterator: CancellableAsyncIterator<Payload> = {
      async next() {
        if (closed) return completed();
        let resolveCancelled!: (result: IteratorResult<Payload>) => void;
        const cancelled = new Promise<IteratorResult<Payload>>((resolve) => {
          resolveCancelled = resolve;
          pendingReads.add(resolve);
        });
        const next = generator.next().then(
          (result) => {
            if (closed) return completed();
            if (result.done) close();
            return result;
          },
          (error: unknown) => {
            if (closed) return completed();
            // This read must reject with the resolver error. Waking it via
            // cancellation first would win Promise.race and hide auth failures.
            pendingReads.delete(resolveCancelled);
            close();
            throw error;
          },
        );
        try {
          return await Promise.race([next, cancelled]);
        } finally {
          pendingReads.delete(resolveCancelled);
        }
      },
      async return() {
        close();
        return completed();
      },
      async throw(error?: unknown) {
        close();
        throw error;
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    return iterator;
  };
}
