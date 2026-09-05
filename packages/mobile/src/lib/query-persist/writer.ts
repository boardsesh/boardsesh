import type { QueryClient } from '@tanstack/react-query';
import { matchPersistRule } from './allowlist';
import { applyBudget, type BudgetCandidate } from './budget';
import { dehydrateAllowlisted } from './dehydrate';
import { PERSISTED_CACHE_VERSION, serializePersistedCache, type PersistedQueryEntry } from './envelope';
import { getLastWrittenQueries, setLastWrittenQueries } from './runtime';

const DEFAULT_THROTTLE_MS = 1000;

export type CacheWriter = {
  /** Subscribe to the query cache. Returns the unsubscribe. */
  start(): () => void;
  /** Write now (if an owner is set), cancelling any pending throttle. */
  flush(): void;
  /** Cancel the pending throttle. Stays subscribed — see `suspendCacheWriter`. */
  suspend(): void;
};

export type CacheWriterInput = {
  client: QueryClient;
  write: (serialized: string) => void | Promise<void>;
  /** Read at FIRE time, never at schedule time. */
  getOwner: () => string | null;
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
  throttleMs?: number;
  onError?: (error: unknown) => void;
};

/**
 * Merge the fresh dehydrate with the previous write.
 *
 * React Query's 30-minute `gcTime` deletes any entry with no observer, so a
 * replace-on-write persister would erode toward "only what you looked at in the
 * last 30 minutes" — `['angles', board, layout]` for a board you did not open
 * today would vanish from disk. Fresh entries win by `queryHash`; previously
 * written entries survive when they are absent from the fresh set AND still
 * inside their rule's `maxAge`.
 */
function mergeWithPrevious(
  fresh: readonly PersistedQueryEntry[],
  previous: readonly PersistedQueryEntry[],
  ownerUserId: string,
  now: number,
): PersistedQueryEntry[] {
  const freshHashes = new Set(fresh.map((entry) => entry.queryHash));
  const merged = [...fresh];
  for (const entry of previous) {
    if (freshHashes.has(entry.queryHash)) continue;
    const rule = Array.isArray(entry.queryKey) ? matchPersistRule(entry.queryKey, ownerUserId) : undefined;
    if (!rule) continue;
    if (now - (entry.state?.dataUpdatedAt ?? 0) > rule.maxAgeMs) continue;
    merged.push(entry);
  }
  return merged;
}

export function createCacheWriter(input: CacheWriterInput): CacheWriter {
  const throttleMs = input.throttleMs ?? DEFAULT_THROTTLE_MS;
  let pendingHandle: unknown = null;

  function cancelPending(): void {
    if (pendingHandle === null) return;
    input.cancel(pendingHandle);
    pendingHandle = null;
  }

  function writeNow(): void {
    // THE owner read. Doing it here rather than at schedule time is the whole
    // correctness story: a write queued moments before sign-out finds a null
    // owner and does nothing, so it cannot re-create the blob between the delete
    // and the next tick — and re-arming after any anonymous transition is just
    // `setPersistOwner`, with no latched "stopped" state to get stuck in.
    const ownerUserId = input.getOwner();
    if (ownerUserId === null) return;

    try {
      const now = input.now();
      const fresh = dehydrateAllowlisted(input.client, ownerUserId);
      const merged = mergeWithPrevious(fresh, getLastWrittenQueries(), ownerUserId, now);
      const candidates: BudgetCandidate[] = [];
      for (const entry of merged) {
        const rule = Array.isArray(entry.queryKey) ? matchPersistRule(entry.queryKey, ownerUserId) : undefined;
        if (!rule) continue;
        candidates.push({ entry, priority: rule.priority });
      }
      const budgeted = applyBudget(candidates);
      const serialized = serializePersistedCache({
        version: PERSISTED_CACHE_VERSION,
        userId: ownerUserId,
        savedAt: now,
        ...(budgeted.droppedEvicted > 0 ? { evicted: true as const } : {}),
        queries: budgeted.kept,
      });
      setLastWrittenQueries(budgeted.kept);
      const written = input.write(serialized);
      if (written && typeof written.then === 'function') {
        void written.catch((error: unknown) => input.onError?.(error));
      }
    } catch (error) {
      input.onError?.(error);
    }
  }

  return {
    start() {
      const unsubscribe = input.client.getQueryCache().subscribe(() => {
        // Trailing edge: the first event of a burst schedules one write
        // `throttleMs` later, and every further event in that window rides it.
        if (pendingHandle !== null) return;
        pendingHandle = input.schedule(() => {
          pendingHandle = null;
          writeNow();
        }, throttleMs);
      });
      return unsubscribe;
    },
    flush() {
      cancelPending();
      writeNow();
    },
    suspend() {
      cancelPending();
    },
  };
}
