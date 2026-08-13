import { dehydrate, type QueryClient } from '@tanstack/react-query';
import { matchPersistRule } from './allowlist';
import type { PersistedQueryEntry } from './envelope';

/**
 * Dehydrate exactly the allowlisted entries and nothing else.
 *
 * The allowlist check lives INSIDE `shouldDehydrateQuery`, so a non-allowlisted
 * key is never serialized in the first place — there is no post-filter step to
 * forget. `status === 'success'` does double duty: it keeps errored and
 * in-flight entries out, and it guarantees query-core's `dehydrateQuery` never
 * attaches the non-serializable `promise` it adds for pending queries.
 */
export function dehydrateAllowlisted(client: QueryClient, ownerUserId: string): PersistedQueryEntry[] {
  const state = dehydrate(client, {
    // Hard-coded false, never a variable and never a parameter: `pending_mutations`
    // in SQLite is the outbox, and a second persisted outbox is a double-submit
    // hazard. `PersistedCacheEnvelope` has no `mutations` field either, so this
    // is one of two independent defences (issue #4353).
    shouldDehydrateMutation: () => false,
    shouldDehydrateQuery: (query) =>
      query.state.status === 'success' &&
      query.state.data !== undefined &&
      query.state.fetchStatus === 'idle' &&
      matchPersistRule(query.queryKey, ownerUserId) !== undefined,
  });
  return state.queries;
}
