import { useQuery } from '@tanstack/react-query';
import { getLocalUserId } from '@boardsesh/offline-sync';
import { getDatabaseHandle } from '../db';
import { useOfflineDownloadsEnabled } from '../providers/feature-flags-provider';

/** The latest graded tick on this device for one climb+angle, unclamped. */
export type LocalMyGrade = { difficulty: number; climbedAt: string } | null;

/**
 * The query key. Deliberately under the `['localTicks', climbUuid]` prefix: an
 * offline tick save invalidates exactly that prefix (board-adapter), and the
 * drainer and the pull sync invalidate `['localTicks']` whenever a
 * `boardsesh_ticks` row lands or changes (TABLE_INVALIDATE_KEYS). So every path
 * that can change this answer already refreshes it.
 */
export function localMyGradeQueryKey(climbUuid: string, boardName: string, angle: number) {
  return ['localTicks', climbUuid, boardName, 'myGrade', angle] as const;
}

/**
 * The climber's own grade for one climb at one angle, read from the on-device
 * `boardsesh_ticks` table (#4828).
 *
 * This is the offline half of `useMyGrade`. The logbook that hook normally reads
 * is fetched over the network and is not persisted, so offline — a cold start,
 * or a climb whose logbook batch never loaded — it never resolves. The local
 * search still filters and sorts on the grade from this same table, so without
 * this read the play drawer would label a climb with the crowd's grade while the
 * list had placed it by the climber's own.
 *
 * Same rule as `MY_GRADE_SUBQUERY` in db/queries/search-climbs-local.ts, and the
 * server's `buildPersonalGradeSubquery`: the LATEST tick whose difficulty is not
 * NULL, ordered `(climbed_at DESC, uuid DESC)`, owned by the local user (or a
 * legacy row with no owner stamp). Returns the raw difficulty; the caller clamps
 * it with the same shared helper every other surface uses.
 *
 * One indexed lookup (`idx_ticks_climb`) per climb, so it is only enabled for
 * single-climb surfaces (the play drawer), never per list row — rows get the
 * number the search row already carries instead.
 *
 * Resolves `undefined` (query disabled or still loading) when there is nothing
 * to read from — offline downloads off, no database handle — so the caller keeps
 * treating the grade as unknown rather than as "never graded".
 */
export function useLocalMyGrade(
  climbUuid: string,
  boardName: string | null,
  angle: number,
  enabled: boolean,
): LocalMyGrade | undefined {
  const offlineEnabled = useOfflineDownloadsEnabled();
  const { data } = useQuery({
    queryKey: localMyGradeQueryKey(climbUuid, boardName ?? '', angle),
    // Never refetches on its own: the invalidations listed on the key own that.
    staleTime: Infinity,
    enabled: enabled && offlineEnabled && climbUuid.length > 0 && !!boardName,
    // A local read must run with no network — the whole point of this hook.
    networkMode: 'always',
    queryFn: async (): Promise<LocalMyGrade> => {
      const db = getDatabaseHandle();
      if (!db || !boardName) return null;
      const ownerUserId = await getLocalUserId(db);
      const row = await db.getFirstAsync<{ difficulty: number; climbed_at: string }>(
        `SELECT difficulty, climbed_at
         FROM boardsesh_ticks
         WHERE climb_uuid = ? AND board_type = ? AND angle = ?
           AND (user_id = ? OR user_id IS NULL)
           AND difficulty IS NOT NULL
         ORDER BY climbed_at DESC, uuid DESC
         LIMIT 1`,
        [climbUuid, boardName, angle, ownerUserId],
      );
      return row ? { difficulty: row.difficulty, climbedAt: row.climbed_at } : null;
    },
  });
  return data;
}
