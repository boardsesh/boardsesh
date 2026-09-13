import type { OfflineDatabase } from '@boardsesh/offline-sync';
import type { Climb } from '@boardsesh/shared-schema';
import { effectiveStatsSql, isCrossAngleStats, mapRowToClimb, type LocalClimbRow } from './search-climbs-local';

/**
 * On-device climb detail read (board_climbs ⋈ board_climb_stats ⋈
 * board_climb_grades at one angle), used when offline and the board is
 * downloaded. Mirrors the server's get-climb-by-uuid LEFT JOINs, including the
 * Boardsesh grade + confidence for the angle. `mirrored` isn't stored locally (it's a
 * queue/playback property, not a climb column), so it's reported false; the
 * detail-screen satellite data (comments, beta, similar climbs, stats history)
 * is network-only and the caller hides it offline.
 *
 * No is_hidden predicate, matching the server's getClimbByUuid: opening a climb
 * directly still works after the community hides it. The flag rides along on the
 * row so the caller can say so.
 */
export type GetClimbLocalInput = {
  boardName: string;
  layoutId: number;
  angle: number;
  climbUuid: string;
};

export async function getClimbLocal(db: OfflineDatabase, input: GetClimbLocalInput): Promise<Climb | null> {
  const { boardName, layoutId, angle, climbUuid } = input;
  // Same resolution the list row used, so a badged row does not open a drawer that
  // silently claims its grade belongs to the browsed angle (issue #5405). There is
  // no search input here, so only the board capability can turn it on — which is
  // the whole of the default-on case, Woods and MoonBoard.
  const crossAngle = isCrossAngleStats({ boardName, crossAngleStats: false });
  const eff = (column: Parameters<typeof effectiveStatsSql>[0]) => effectiveStatsSql(column, crossAngle);
  const setAngleJoin = crossAngle
    ? `LEFT JOIN board_climb_stats s_set
      ON s_set.climb_uuid = c.uuid AND s_set.board_type = ? AND s_set.angle = c.angle`
    : '';
  const gradeAngleSql = crossAngle ? 'COALESCE(s.angle, s_set.angle, ?)' : '?';
  const query = `
    SELECT
      c.uuid, c.setter_username, c.user_id, c.name, c.description, c.frames, c.is_draft, c.is_hidden,
      c.characteristics,
      c.created_at, c.published_at, c.frames_count, c.frames_pace, c.compatible_size_ids,
      ${eff('ascensionist_count')} AS ascensionist_count,
      ${eff('display_difficulty')} AS display_difficulty,
      ${eff('difficulty_average')} AS difficulty_average,
      ${eff('quality_average')} AS quality_average,
      ${eff('benchmark_difficulty')} AS benchmark_difficulty,
      ${eff('angle')} AS stats_angle,
      COALESCE(g.universal_grade, g.local_grade) AS boardsesh_difficulty,
      g.confidence AS boardsesh_confidence,
      (SELECT COUNT(*) FROM boardsesh_ticks t
        WHERE t.climb_uuid = c.uuid AND t.board_type = ? AND t.angle = ? AND t.status IN ('flash', 'send')) AS user_ascents,
      (SELECT COUNT(*) FROM boardsesh_ticks t
        WHERE t.climb_uuid = c.uuid AND t.board_type = ? AND t.angle = ? AND t.status = 'attempt') AS user_attempts
    FROM board_climbs c
    LEFT JOIN board_climb_stats s
      ON s.climb_uuid = c.uuid AND s.board_type = ? AND s.angle = ?
    ${setAngleJoin}
    LEFT JOIN board_climb_grades g
      ON g.climb_uuid = c.uuid AND g.board_type = ? AND g.angle = ${gradeAngleSql}
    WHERE c.uuid = ? AND c.board_type = ?
    LIMIT 1
  `;
  // Bind order follows the SQL text: the two tick subqueries, the stats join, the
  // optional set-angle join, then the grades join.
  const binds = [
    boardName,
    angle,
    boardName,
    angle,
    boardName,
    angle,
    ...(crossAngle ? [boardName] : []),
    boardName,
    angle,
    climbUuid,
    boardName,
  ];
  const row = await db.getFirstAsync<LocalClimbRow>(query, binds);
  if (!row) return null;

  const climb = mapRowToClimb(row, boardName, layoutId, angle);
  // `description` now comes straight out of mapRowToClimb (the search read
  // carries it too since #4494), so only `mirrored` is patched on here.
  return { ...climb, mirrored: false };
}
