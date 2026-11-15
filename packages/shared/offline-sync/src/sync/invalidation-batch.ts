import type { QueryInvalidator } from '../database';
import { scopedInvalidateFilters, type BoardScopeKey, type InvalidateKeys } from './invalidate-keys';
import { holdSyncRequest } from '../network/request-context';

type DirectInvalidateFilters = { queryKey: readonly unknown[]; exact?: boolean };
export type InvalidationBatch = {
  add(keys: InvalidateKeys, scope?: BoardScopeKey | null, assertCurrent?: () => void): void;
  addFilters(filters: DirectInvalidateFilters, assertCurrent?: () => void): void;
  flush(): void;
};
type PendingInvalidation = {
  filters: Parameters<QueryInvalidator['invalidateQueries']>[0];
  unscopedId?: string;
  unconditional: boolean;
  causes: Set<() => void>;
};

/** Existing native batches stay unconditional. Selected batches retain at most
 * ten independent original mutation causes, then flush before disposing them. */
export function createInvalidationBatch(queryClient: QueryInvalidator): InvalidationBatch {
  let pending = new Map<string, PendingInvalidation>();
  const add = (
    id: string,
    filters: PendingInvalidation['filters'],
    unscopedId: string | undefined,
    assertCurrent?: () => void,
  ) => {
    let entry = pending.get(id);
    if (!entry) {
      entry = { filters, unscopedId, unconditional: false, causes: new Set() };
      pending.set(id, entry);
    }
    if (!assertCurrent) entry.unconditional = true;
    else {
      if (!entry.causes.has(assertCurrent) && entry.causes.size >= 10) throw holdSyncRequest();
      entry.causes.add(assertCurrent);
    }
  };
  const isCurrent = (entry: PendingInvalidation) => {
    if (entry.unconditional) return true;
    for (const assertCurrent of entry.causes) {
      try {
        assertCurrent();
        return true;
      } catch {
        /* Retired causes authorize nothing. */
      }
    }
    return false;
  };
  return {
    add(keys, scope, assertCurrent) {
      for (const key of keys) {
        const filters = scopedInvalidateFilters(key, scope);
        const unscopedId = JSON.stringify([key, false]);
        if (filters.predicate && scope)
          add(JSON.stringify([key, false, scope.boardType, scope.layoutId]), filters, unscopedId, assertCurrent);
        else add(unscopedId, filters, undefined, assertCurrent);
      }
    },
    addFilters(filters, assertCurrent) {
      add(JSON.stringify([filters.queryKey, filters.exact === true]), filters, undefined, assertCurrent);
    },
    flush() {
      const flushing = pending;
      pending = new Map();
      let failure: { error: unknown } | undefined;
      for (const entry of flushing.values()) {
        const unscoped = entry.unscopedId ? flushing.get(entry.unscopedId) : undefined;
        if (unscoped && isCurrent(unscoped)) continue;
        if (!isCurrent(entry)) continue;
        try {
          queryClient.invalidateQueries(entry.filters);
        } catch (error) {
          failure ??= { error };
        }
      }
      if (failure) throw failure.error instanceof Error ? failure.error : new Error(String(failure.error));
    },
  };
}
