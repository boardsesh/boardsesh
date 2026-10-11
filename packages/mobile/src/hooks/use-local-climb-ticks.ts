import { useQuery } from '@tanstack/react-query';
import type { LogbookEntry } from '@boardsesh/board-react';
import { getDatabaseHandle } from '../db';
import { readClimbTicksLocal } from '../db/queries/get-climb-ticks-local';
import { useOfflineDownloadsEnabled } from '../providers/feature-flags-provider';
import { useStoredUserId } from './use-current-user-id';

/**
 * The query key. Under the `['localTicks', climbUuid]` prefix for the same
 * reason as `localMyGradeQueryKey`: an offline tick save invalidates that
 * prefix, and the drainer and the pull sync invalidate `['localTicks']` whenever
 * a `boardsesh_ticks` row lands or changes. Ends in the viewer's id, so one
 * account's rows are never handed to another from the cache.
 */
export function localClimbTicksQueryKey(climbUuid: string, boardName: string, viewerId: string) {
  return ['localTicks', climbUuid, boardName, 'rows', viewerId] as const;
}

/**
 * The climber's own ticks on one climb, read from the on-device
 * `boardsesh_ticks` table and shaped like the server's logbook entries.
 *
 * A placeholder for the play drawer's Logbook card while `GET_TICKS` is in
 * flight, and nothing more: the server's answer replaces these rows the moment
 * it lands. Local rows carry no `upvotes`, `downvotes` or `commentCount`, so
 * those read 0 until then. Display only. Whether a new ascent is a flash is
 * still decided from the server-backed logbook (#3940). The table is only as
 * current as the last sync, so a tick deleted elsewhere since (the You tab
 * deletes on the server) can show here until that answer lands.
 *
 * Satisfies the auth-scoping contract in docs/offline-reads.md: it serves only
 * when `canServeLocalUserData` says the rows on disk are complete and belong to
 * the signed-in climber, and filters rows to the owner stamp (or a legacy row
 * with no owner). Resolves `undefined` when the gate declines, when the query
 * is disabled, or while it loads, so the caller keeps its spinner.
 *
 * Aurora sometimes stores one ascent several times, and the sync carries every
 * copy. The server hides them with `notAuroraTwinDuplicate`; here, rows sharing
 * the full natural key and an identical payload collapse to `MIN(uuid)`.
 *
 * `climb_revision` is read as `MAX(...)` and kept out of the GROUP BY. The
 * group says "the same ascent stored twice", and which version it was on is
 * not part of that: the copies are imports, which carry no version. Grouping
 * by it would split one ascent into two rows if only one copy were ever
 * stamped; MAX skips NULLs, so the collapsed row keeps a version when any copy
 * has one. The shared batch reader leaves the revision absent for an unanswered
 * offline write whose holds version is unknown, matching the send-mark reader.
 */
export function useLocalClimbTicks(
  boardName: string | null,
  climbUuid: string | null,
  enabled: boolean,
): LogbookEntry[] | undefined {
  const offlineEnabled = useOfflineDownloadsEnabled();
  const wanted = enabled && offlineEnabled && !!climbUuid && !!boardName;
  const { userId: viewerId } = useStoredUserId(wanted);
  const { data } = useQuery({
    queryKey: localClimbTicksQueryKey(climbUuid ?? '', boardName ?? '', viewerId ?? ''),
    // Rows never refetch on their own: the invalidations listed on the key own
    // that. "Cannot serve" (`null`) is stale at once instead, so the next open
    // of the climb reads again: the gate that declined, typically a first sync
    // still running, opens without any `boardsesh_ticks` row changing.
    staleTime: (query) => (query.state.data === null ? 0 : Infinity),
    enabled: wanted && !!viewerId,
    // A local read must not wait on the network. Not waiting is the point.
    networkMode: 'always',
    queryFn: async (): Promise<LogbookEntry[] | null> => {
      const db = getDatabaseHandle();
      if (!db || !climbUuid || !boardName || !viewerId) return null;
      return readClimbTicksLocal(db, boardName, [climbUuid], viewerId);
    },
  });
  return data ?? undefined;
}
