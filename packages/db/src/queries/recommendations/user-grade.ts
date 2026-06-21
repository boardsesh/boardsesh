import { sql, type SQL } from 'drizzle-orm';
import { effectiveSendVNumber } from '@boardsesh/board-constants/grade-conversion';

/**
 * A user's hardest send per board (flash/send). One grouped row per board the
 * user has logged on. Converted to a cross-board ability estimate by
 * {@link computeUserMaxVGrade} (which applies the MoonBoard de-sandbag).
 */
export function buildUserSendGradesByBoardSql(userId: string): SQL {
  // Many sends are logged without a personal difficulty; fall back to the
  // community consensus grade at the tick's angle so those sends still count.
  return sql`
    SELECT t.board_type, MAX(COALESCE(t.difficulty, ROUND(s.display_difficulty)::int))::int AS max_difficulty
    FROM boardsesh_ticks t
    LEFT JOIN board_climb_stats s
      ON s.board_type = t.board_type AND s.climb_uuid = t.climb_uuid AND s.angle = t.angle
    WHERE t.user_id = ${userId}
      AND t.status IN ('flash', 'send')
      AND (t.difficulty IS NOT NULL OR s.display_difficulty IS NOT NULL)
    GROUP BY t.board_type
  `;
}

/**
 * The user's max V-grade across all boards. Difficulty-id -> V is monotonic, so
 * each board's max difficulty gives its max V; MoonBoard is shifted up by the
 * sandbag offset before taking the overall max. Returns null with no graded
 * sends (the "At your level" card is then hidden).
 */
export function computeUserMaxVGrade(
  rows: Array<{ board_type: string; max_difficulty: number | null }>,
): number | null {
  let maxV: number | null = null;
  for (const row of rows) {
    if (row.max_difficulty == null) continue;
    const v = effectiveSendVNumber(row.board_type, Number(row.max_difficulty));
    if (v === null) continue;
    if (maxV === null || v > maxV) maxV = v;
  }
  return maxV;
}
