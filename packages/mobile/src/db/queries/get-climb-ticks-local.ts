import { canServeLocalUserData, getLocalUserId, type SqlExecutor } from '@boardsesh/offline-sync';
import { toLogbookEntry, type LogbookEntry, type TickStatus } from '@boardsesh/board-react';
import { tickRevisionKnownLocalSql } from './climb-revisions-local';

type LocalTickRow = {
  uuid: string;
  climb_uuid: string;
  angle: number;
  is_mirror: number | null;
  status: TickStatus;
  attempt_count: number | null;
  quality: number | null;
  difficulty: number | null;
  comment: string | null;
  climbed_at: string;
  climb_revision: number | null;
  revision_known: number;
};

// Stay below SQLite's older 999-bound-parameter limit, including board/owner.
const UUIDS_PER_STATEMENT = 400;

/**
 * Complete, account-scoped ticks for a set of climbs, at every angle and mirror
 * direction. User-data sync is independent of board downloads. A declined
 * ownership/completeness gate returns null; a valid empty logbook returns [].
 *
 * Aurora twins collapse by the full ascent natural key and identical payload.
 * The holds revision stays outside that key so a stamped copy can supply it
 * to its unstamped twin. A pending write with no known revision stays unknown,
 * rather than becoming an import with the implicit first holds revision.
 */
export async function readClimbTicksLocal(
  db: SqlExecutor,
  boardName: string,
  climbUuids: readonly string[],
  viewerId: string,
): Promise<LogbookEntry[] | null> {
  if (!(await canServeLocalUserData(db, viewerId))) return null;
  const ownerUserId = await getLocalUserId(db);
  // Recheck the stamp after the asynchronous completeness gate. A sign-out
  // between those reads must not let the next owner's rows answer this query.
  if (ownerUserId !== viewerId) return null;
  const uniqueClimbUuids = [...new Set(climbUuids)];
  const entries: LogbookEntry[] = [];
  for (let start = 0; start < uniqueClimbUuids.length; start += UUIDS_PER_STATEMENT) {
    const chunk = uniqueClimbUuids.slice(start, start + UUIDS_PER_STATEMENT);
    const rows = await db.getAllAsync<LocalTickRow>(
      `SELECT MIN(t.uuid) AS uuid, t.climb_uuid, t.angle, t.is_mirror, t.status, t.attempt_count,
         t.quality, t.difficulty, t.comment, t.climbed_at,
         MAX(t.climb_revision) AS climb_revision,
         MAX(CASE WHEN ${tickRevisionKnownLocalSql('t')} THEN 1 ELSE 0 END) AS revision_known
       FROM boardsesh_ticks t
       WHERE t.board_type = ? AND t.climb_uuid IN (${chunk.map(() => '?').join(', ')})
         AND (t.user_id = ? OR t.user_id IS NULL)
         AND t.status IN ('flash', 'send', 'attempt')
         AND t.angle IS NOT NULL AND t.climbed_at IS NOT NULL
       GROUP BY t.climb_uuid, t.angle, t.climbed_at, t.is_mirror, t.status, t.attempt_count,
         t.quality, t.difficulty, t.is_benchmark, t.comment`,
      [boardName, ...chunk, ownerUserId],
    );
    for (const row of rows) {
      entries.push(
        toLogbookEntry({
          uuid: row.uuid,
          climbUuid: row.climb_uuid,
          angle: row.angle,
          isMirror: row.is_mirror === 1,
          status: row.status,
          attemptCount: row.attempt_count ?? 1,
          quality: row.quality,
          difficulty: row.difficulty,
          comment: row.comment ?? '',
          climbedAt: row.climbed_at,
          climbRevision: row.revision_known ? row.climb_revision : undefined,
        }),
      );
    }
  }
  // Do not publish a partially read batch after a wipe or re-stamp while the
  // SQLite statements yielded. The caller also fences credential changes.
  return (await canServeLocalUserData(db, viewerId)) ? entries : null;
}
