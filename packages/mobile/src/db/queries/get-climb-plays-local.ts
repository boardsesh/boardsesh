import { isSizeScopedBoard } from '@boardsesh/board-config';
import { isScopeDownloadComplete, parseOfflineBoardKey, type OfflineDatabase } from '@boardsesh/offline-sync';
import { toPlayCount } from '@boardsesh/shared-schema';

export type LocalPlaysScope = { boardName: string; layoutId: number };
export type LocalPlaysTarget = { climbUuid: string; angle: number };
export type LocalPlaysRow = LocalPlaysTarget & { playCount: number | null };

// Two bind parameters per target, well within SQLite's 999-variable limit.
const TARGETS_PER_QUERY = 200;

/** Read exact stats for compatible climbs within a completed download. */
export async function getClimbPlaysLocal(
  db: OfflineDatabase,
  scope: LocalPlaysScope,
  targets: readonly LocalPlaysTarget[],
  candidateScopeKeys: readonly string[],
  viewerId: string | null,
): Promise<LocalPlaysRow[]> {
  if (targets.length === 0) return [];
  const { boardName, layoutId } = scope;
  const completeSizes: number[] = [];
  for (const scopeKey of candidateScopeKeys) {
    const candidate = parseOfflineBoardKey(scopeKey);
    if (candidate?.boardType !== boardName || candidate.layoutId !== layoutId) continue;
    if (await isScopeDownloadComplete(db, scopeKey)) completeSizes.push(candidate.sizeId);
  }
  if (completeSizes.length === 0) return [];
  const sizeScoped = isSizeScopedBoard(boardName);
  const result: LocalPlaysRow[] = [];
  for (let offset = 0; offset < targets.length; offset += TARGETS_PER_QUERY) {
    const batch = targets.slice(offset, offset + TARGETS_PER_QUERY);
    // With the exact stats row required by this join, a delisted alias with
    // no stats of its own cannot lend the canonical climb's counts.
    const rows = await db.getAllAsync<LocalPlaysTarget & { play_count: string | null }>(
      `WITH targets(climb_uuid, angle) AS (VALUES ${batch.map(() => '(?, ?)').join(', ')})
       SELECT climb.uuid AS climbUuid, stats.angle, CAST(stats.play_count AS TEXT) AS play_count
       FROM targets
       JOIN board_climbs climb ON climb.uuid = targets.climb_uuid
       JOIN board_climb_stats stats
         ON stats.board_type = climb.board_type AND stats.climb_uuid = climb.uuid AND stats.angle = targets.angle
       WHERE climb.board_type = ? AND climb.layout_id = ?
         AND (climb.board_type <> 'spray'
           OR EXISTS (SELECT 1 FROM spray_walls wall WHERE wall.layout_id = climb.layout_id))
         AND (COALESCE(climb.is_draft, 0) = 0 OR climb.user_id = ? OR climb.board_type = 'spray')
         ${
           sizeScoped
             ? `AND EXISTS (
           SELECT 1 FROM json_each(CASE WHEN json_valid(climb.compatible_size_ids) THEN climb.compatible_size_ids END) size
           JOIN json_each(?) downloaded ON downloaded.value = size.value
         )`
             : ''
         }`,
      [
        ...batch.flatMap(({ climbUuid, angle }) => [climbUuid, angle]),
        boardName,
        layoutId,
        viewerId,
        ...(sizeScoped ? [JSON.stringify(completeSizes)] : []),
      ],
    );
    for (const { climbUuid, angle, play_count } of rows) {
      result.push({ climbUuid, angle, playCount: toPlayCount(play_count) });
    }
  }
  return result;
}
