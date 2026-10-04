import { useQuery } from '@tanstack/react-query';
import { canServeLocalUserData, getLocalUserId } from '@boardsesh/offline-sync';
import { toLogbookEntry, type LogbookEntry, type TickStatus } from '@boardsesh/board-react';
import { getDatabaseHandle } from '../db';
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

type LocalTickRow = {
  uuid: string;
  angle: number;
  is_mirror: number | null;
  status: TickStatus;
  attempt_count: number | null;
  quality: number | null;
  difficulty: number | null;
  comment: string | null;
  climbed_at: string;
};

/**
 * The climber's own ticks on one climb, read from the on-device
 * `boardsesh_ticks` table and shaped like the server's logbook entries.
 *
 * A placeholder for the play drawer's Logbook card while `GET_TICKS` is in
 * flight, and nothing more: the server's answer replaces these rows the moment
 * it lands. Local rows carry no `upvotes`, `downvotes` or `commentCount`, so
 * those read 0 until then. Display only. Whether a new ascent is a flash is
 * still decided from the server-backed logbook (#3940).
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
    // Never refetches on its own: the invalidations listed on the key own that.
    staleTime: Infinity,
    enabled: wanted && !!viewerId,
    // A local read must not wait on the network. Not waiting is the point.
    networkMode: 'always',
    queryFn: async (): Promise<LogbookEntry[] | null> => {
      const db = getDatabaseHandle();
      if (!db || !climbUuid || !boardName) return null;
      if (!(await canServeLocalUserData(db, viewerId))) return null;
      const ownerUserId = await getLocalUserId(db);
      const rows = await db.getAllAsync<LocalTickRow>(
        `SELECT MIN(uuid) AS uuid, angle, is_mirror, status, attempt_count, quality, difficulty, comment, climbed_at
         FROM boardsesh_ticks
         WHERE climb_uuid = ? AND board_type = ?
           AND (user_id = ? OR user_id IS NULL)
           AND status IN ('flash', 'send', 'attempt')
           AND angle IS NOT NULL AND climbed_at IS NOT NULL
         GROUP BY angle, climbed_at, is_mirror, status, attempt_count, quality, difficulty, is_benchmark, comment`,
        [climbUuid, boardName, ownerUserId],
      );
      return rows.map((row) =>
        toLogbookEntry({
          uuid: row.uuid,
          climbUuid,
          angle: row.angle,
          isMirror: row.is_mirror === 1,
          status: row.status,
          attemptCount: row.attempt_count ?? 1,
          quality: row.quality,
          difficulty: row.difficulty,
          comment: row.comment ?? '',
          climbedAt: row.climbed_at,
        }),
      );
    },
  });
  return data ?? undefined;
}
