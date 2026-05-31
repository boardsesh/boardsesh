'use client';

// Thin web binding over the shared `@boardsesh/board-react` logbook hook. The
// data logic (incremental fetch, accumulated cache, board-switch reset) lives in
// the shared package and is identical on mobile; web-only I/O (NextAuth session,
// ws-auth token, HTTP GraphQL client) is injected via `useWebLogbookDeps`.
//
// The pure transforms / query-key builders / types are re-exported so existing
// web import paths (`@/app/hooks/use-logbook`) keep working unchanged.

import type { BoardName, ClimbUuid } from '@/app/lib/types';
import {
  useLogbook as useSharedLogbook,
  useInvalidateLogbook as useSharedInvalidateLogbook,
} from '@boardsesh/board-react';
import { useWebLogbookDeps } from '@/app/components/board-provider/web-board-data-deps';

export {
  toLogbookEntry,
  mergeLogbookEntries,
  accumulatedLogbookQueryKey,
  fetchLogbookQueryKeyPrefix,
  logbookQueryKey,
} from '@boardsesh/board-react';
export type { TickStatus, LogbookEntry } from '@boardsesh/board-react';

/**
 * Hook to fetch logbook entries (ticks) for specific climbs. See
 * `@boardsesh/board-react`'s `useLogbook` for the fetch/accumulate semantics.
 */
export function useLogbook(boardName: BoardName, climbUuids: ClimbUuid[]) {
  const deps = useWebLogbookDeps();
  return useSharedLogbook(deps, boardName, climbUuids);
}

/** Returns a function to invalidate logbook queries for a given board. */
export function useInvalidateLogbook(boardName: BoardName) {
  return useSharedInvalidateLogbook(boardName);
}
