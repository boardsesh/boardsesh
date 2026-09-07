// The caches an APPLIED proposal invalidates, in one place.
//
// Two paths apply a proposal: a moderator resolving it outright, and a vote that
// carries it past its threshold (the backend applies the effect and hands back a
// proposal whose `status` is no longer `'open'`). Both change the climb itself —
// an approved hide flips `is_hidden`, an approved grade rewrites the community
// grade — so both have to bust the same reads, and a list left holding the old
// row is the bug this file exists to prevent.
//
// A leaf on purpose: keys and a QueryClient, no hooks. Both mutation hooks
// import it, and the keys themselves come from `../query-keys` so the reading
// hooks and this writer can never drift apart.

import type { QueryClient } from '@tanstack/react-query';
import {
  CLIMB_QUERY_KEY,
  SEARCH_CLIMBS_QUERY_KEY,
  INFINITE_SEARCH_CLIMBS_QUERY_KEY,
  SEARCH_CLIMBS_COUNT_QUERY_KEY,
} from '../query-keys';
import { PROPOSALS_QUERY_KEY } from './use-report-climb';

/**
 * Every root key holding climb rows a proposal's effect changes: the detail
 * query plus the three search reads (paged, infinite, and the count the filter
 * bar shows). Exported so a test can assert the set rather than restate it.
 */
export const CLIMB_EFFECT_QUERY_KEYS = [
  CLIMB_QUERY_KEY,
  SEARCH_CLIMBS_QUERY_KEY,
  INFINITE_SEARCH_CLIMBS_QUERY_KEY,
  SEARCH_CLIMBS_COUNT_QUERY_KEY,
] as const;

/**
 * Bust every climb read a proposal's effect touched.
 *
 * The offline mirror is NOT refreshed here. There is no cheap "pull now"
 * trigger on this side — `triggerSync` wants the SQLite handle, the enabled
 * board list and the drain queue, none of which a mutation hook holds — so the
 * local row catches up on the next scheduled pull, which the backend's
 * `updated_at` bump puts in the delta. The invalidation above is what makes the
 * screen honest in the meantime: it sends the reads back to the server.
 */
export function invalidateClimbEffectCaches(queryClient: QueryClient): void {
  for (const queryKey of CLIMB_EFFECT_QUERY_KEYS) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

/**
 * The full set an applied proposal invalidates: the proposal lists (their rows
 * carry the new status) plus every climb read above.
 */
export function invalidateAppliedProposalCaches(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: PROPOSALS_QUERY_KEY });
  invalidateClimbEffectCaches(queryClient);
}
