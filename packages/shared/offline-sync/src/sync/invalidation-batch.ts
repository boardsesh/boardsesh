import type { QueryInvalidator } from '../database';
import { scopedInvalidateFilters, type BoardScopeKey, type InvalidateKeys } from './invalidate-keys';

/** A filter that names its queries outright, with no table behind it: a retired wall's renderer keys. */
type DirectInvalidateFilters = { queryKey: readonly unknown[]; exact?: boolean };

/**
 * One pull cycle's query invalidations, held until `flush`.
 *
 * A cycle used to invalidate as it went: once per table that moved rows, once
 * per tombstone page. Several tables share a key, so one cycle refetched the
 * same on-screen query many times over, each refetch cancelling the one before
 * it (#6302). The pull client now queues here and flushes at the end of a
 * phase, so a key is invalidated once for everything the phase changed.
 *
 * Queuing only ever DELAYS an invalidation, and only until the caller's next
 * flush. The pull client flushes in a `finally`, so rows a cycle committed
 * before it threw or was torn down still reach the UI. A flush tries every
 * entry even when one throws.
 */
export type InvalidationBatch = {
  /**
   * Queue a table's keys. `scope` is the one board whose rows changed; leave it
   * out when the change names no board (a user table), and every board's entry
   * refreshes.
   */
  add(keys: InvalidateKeys, scope?: BoardScopeKey | null): void;
  /** Queue one filter as given. */
  addFilters(filters: DirectInvalidateFilters): void;
  /** Invalidate everything queued, once each, in the order it was queued. */
  flush(): void;
};

type PendingInvalidation = {
  filters: Parameters<QueryInvalidator['invalidateQueries']>[0];
  /** Set on a board-scoped entry: the id of the same key queued for every board. */
  unscopedId?: string;
};

export function createInvalidationBatch(queryClient: QueryInvalidator): InvalidationBatch {
  // A Map keeps insertion order, and re-queuing a key leaves it in its first slot.
  let pending = new Map<string, PendingInvalidation>();

  return {
    add(keys, scope) {
      for (const key of keys) {
        const filters = scopedInvalidateFilters(key, scope);
        const unscopedId = JSON.stringify([key, false]);
        if (filters.predicate && scope) {
          const scopedId = JSON.stringify([key, false, scope.boardType, scope.layoutId]);
          if (!pending.has(scopedId)) pending.set(scopedId, { filters, unscopedId });
        } else if (!pending.has(unscopedId)) {
          pending.set(unscopedId, { filters });
        }
      }
    },

    addFilters(filters) {
      const id = JSON.stringify([filters.queryKey, filters.exact === true]);
      if (!pending.has(id)) pending.set(id, { filters });
    },

    flush() {
      const flushing = pending;
      // Emptied first: a flush that throws must not replay on the next one.
      pending = new Map();
      let failure: { error: unknown } | undefined;
      for (const { filters, unscopedId } of flushing.values()) {
        // The same key queued for every board already covers this one board.
        if (unscopedId !== undefined && flushing.has(unscopedId)) continue;
        try {
          queryClient.invalidateQueries(filters);
        } catch (error) {
          // One key failing must not cost the rest of the phase its refresh.
          failure ??= { error };
        }
      }
      if (failure) throw failure.error instanceof Error ? failure.error : new Error(String(failure.error));
    },
  };
}
