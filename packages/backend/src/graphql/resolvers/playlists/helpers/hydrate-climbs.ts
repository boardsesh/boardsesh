import { eq, and, inArray, sql } from 'drizzle-orm';
import { type Climb, type BoardName } from '@boardsesh/shared-schema';
import { db } from '../../../../db/client';
import { getClimbStars, getGradeLabel, toConfidenceTier } from '@boardsesh/db/queries';
import { boardClimbGrades } from '@boardsesh/db/schema';
import { UNIFIED_TABLES } from '../../../../db/queries/util/table-select';

const DEFAULT_ANGLE = 40;

export type ClimbRef = { climbUuid: string; boardType: string };

export type HydrateClimbsOptions = {
  /**
   * Per-ref angle override (e.g. a playlistClimbs.angle that should win over
   * the climb's stats angle). Map keys are `${boardType}:${climbUuid}`.
   * `null` values are treated as "no override" (same as omitting the entry).
   */
  angleOverrides?: Map<string, number | null>;
  /**
   * Single angle applied to every ref — the wall the user is actually on. Stats
   * still fall back to the most-ascended angle when the climb has nothing at
   * this angle (so the grade never blanks), but the returned `angle` stays the
   * requested one, because downstream consumers (queue tick badges, board
   * presence, logged ascents) read it as the live wall angle.
   *
   * Takes precedence over `angleOverrides`, which stays the right choice when
   * each ref genuinely carries its own angle.
   */
  wallAngle?: number;
};

/**
 * Hydrate `(climbUuid, boardType)` refs into full Climb objects in caller-supplied order.
 *
 * Single source of truth for the climbs/climbStats join used by every "fetch a
 * page of climbs by uuid" path (smart playlists, all-boards user playlists).
 * The angle picked for each row is the one the most ascenders have logged at
 * — overridden by `angleOverrides` when the caller has a stronger signal
 * (e.g. the playlist itself stores a per-climb angle).
 */
export async function hydrateClimbsByRefs(refs: ClimbRef[], options?: HydrateClimbsOptions): Promise<Climb[]> {
  if (refs.length === 0) return [];

  const tables = UNIFIED_TABLES;
  const uuids = refs.map((ref) => ref.climbUuid);

  // When the caller supplies per-ref angle overrides (recommendations rank at
  // the board's angle; playlists store a per-climb angle), join board_climb_stats
  // at THAT angle so difficulty/quality/ascents/benchmark all match — not just
  // the returned `angle` field. Falls back to the most-ascended angle.
  const wallAngle = typeof options?.wallAngle === 'number' ? options.wallAngle : null;
  const overrideEntries =
    wallAngle != null
      ? []
      : [...(options?.angleOverrides ?? new Map<string, number | null>())].filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number',
        );
  // The override only wins when the climb actually has a stats row at that
  // angle — the EXISTS guard makes a missing row yield NULL so the COALESCE
  // falls through to the most-ascended angle rather than blanking the grade
  // (a climb with no ascents at the user's selected angle still shows one).
  // One wall angle for every ref needs no VALUES list — just the same guard
  // around a constant.
  const wallAngleExpr =
    wallAngle == null
      ? null
      : sql`(SELECT ${wallAngle}::int WHERE EXISTS (
            SELECT 1 FROM board_climb_stats s_ov
            WHERE s_ov.board_type = ${tables.climbs.boardType}
              AND s_ov.climb_uuid = ${tables.climbs.uuid}
              AND s_ov.angle = ${wallAngle}::int
          ))`;
  const overrideAngleExpr = overrideEntries.length
    ? sql`(SELECT ov.angle FROM (VALUES ${sql.join(
        overrideEntries.map(([key, angle]) => {
          const separator = key.indexOf(':');
          const boardType = key.slice(0, separator);
          const climbUuid = key.slice(separator + 1);
          return sql`(${boardType}::text, ${climbUuid}::text, ${angle}::int)`;
        }),
        sql`, `,
      )}) AS ov(board_type, climb_uuid, angle)
        WHERE ov.board_type = ${tables.climbs.boardType} AND ov.climb_uuid = ${tables.climbs.uuid}
          AND EXISTS (
            SELECT 1 FROM board_climb_stats s_ov
            WHERE s_ov.board_type = ${tables.climbs.boardType}
              AND s_ov.climb_uuid = ${tables.climbs.uuid}
              AND s_ov.angle = ov.angle
          ))`
    : (wallAngleExpr ?? sql`NULL::int`);

  const rows = await db
    .select({
      climbUuid: tables.climbs.uuid,
      layoutId: tables.climbs.layoutId,
      boardType: tables.climbs.boardType,
      setter_username: tables.climbs.setterUsername,
      name: tables.climbs.name,
      description: tables.climbs.description,
      frames: tables.climbs.frames,
      frames_count: tables.climbs.framesCount,
      frames_pace: tables.climbs.framesPace,
      // The sizes the climb fits on. Playlist rows and the activation canary
      // both run `canAddClimbToBoard` over these climbs, and on Woods this is
      // the only field that stops an 8x10 climb reading as an exact fit on a
      // 12x12 wall whose hold ids happen to cover the same numbers.
      compatible_size_ids: tables.climbs.compatibleSizeIds,
      // Structured climb rules ('no_match', 'any_feet', 'campus', method_*). The
      // play drawer states both Woods rules from this array and every board draws
      // its glyphs from it, so a playlist climb without it reads as "not
      // recorded" rather than as the rules its setter chose (issue #5214).
      characteristics: tables.climbs.characteristics,
      statsAngle: tables.climbStats.angle,
      ascensionist_count: tables.climbStats.ascensionistCount,
      difficulty_id: sql<number | null>`ROUND(${tables.climbStats.displayDifficulty}::numeric, 0)`,
      quality_average: sql<number>`ROUND(${tables.climbStats.qualityAverage}::numeric, 2)`,
      difficulty_error: sql<number>`ROUND(${tables.climbStats.difficultyAverage}::numeric - ${tables.climbStats.displayDifficulty}::numeric, 2)`,
      benchmark_difficulty: tables.climbStats.benchmarkDifficulty,
      // Boardsesh grade at the SAME angle the stats row was joined at (climbStats.angle
      // resolves to the override / most-ascended angle below), so grade and shown
      // difficulty always agree. NULL when no grade row — safe.
      boardsesh_difficulty: sql<
        number | null
      >`COALESCE(${boardClimbGrades.universalGrade}, ${boardClimbGrades.localGrade})`,
      boardsesh_confidence: boardClimbGrades.confidence,
    })
    .from(tables.climbs)
    .leftJoin(
      tables.climbStats,
      and(
        eq(tables.climbStats.boardType, tables.climbs.boardType),
        eq(tables.climbStats.climbUuid, tables.climbs.uuid),
        // Inner self-correlated subquery: the outer leftJoin target is
        // `board_climb_stats` (unaliased), and we alias the inner copy as
        // `s`. Using a bare `FROM board_climb_stats s` rather than
        // `${tables.climbStats}` interpolation makes the correlation
        // alias-stable — a future Drizzle release that aliases the outer
        // target wouldn't silently break the resolution to it.
        eq(
          tables.climbStats.angle,
          sql`COALESCE(${overrideAngleExpr}, (
            SELECT s.angle FROM board_climb_stats s
            WHERE s.board_type = ${tables.climbs.boardType}
              AND s.climb_uuid = ${tables.climbs.uuid}
            ORDER BY s.ascensionist_count DESC NULLS LAST
            LIMIT 1
          ))`,
        ),
      ),
    )
    // Grades join reuses climbStats.angle (the effective override / most-ascended
    // angle resolved just above) so the grade matches the difficulty being shown.
    .leftJoin(
      boardClimbGrades,
      and(
        eq(boardClimbGrades.boardType, tables.climbs.boardType),
        eq(boardClimbGrades.climbUuid, tables.climbs.uuid),
        eq(boardClimbGrades.angle, tables.climbStats.angle),
      ),
    )
    .where(inArray(tables.climbs.uuid, uuids));

  // Climb UUIDs can collide across boards in principle, so key by both.
  const rowsByKey = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    rowsByKey.set(`${row.boardType}:${row.climbUuid}`, row);
  }

  const climbs: Climb[] = [];
  for (const ref of refs) {
    const key = `${ref.boardType}:${ref.climbUuid}`;
    const row = rowsByKey.get(key);
    if (!row) continue;
    const override = options?.angleOverrides?.get(key);
    // Prefer the angle the stats row was actually joined at, so the returned
    // `angle` always matches the difficulty/quality/ascents shown — the
    // override can fall back to most-ascents (via the EXISTS guard above) when
    // the climb has no stats at the requested angle.
    // A caller-supplied wall angle is the live board angle and is returned
    // verbatim, even when the stats join fell back to the most-ascended angle
    // for the displayed grade. Otherwise prefer the angle the stats row was
    // actually joined at, so `angle` matches the difficulty shown.
    const angle = wallAngle ?? row.statsAngle ?? override ?? DEFAULT_ANGLE;
    const boardName = (row.boardType || ref.boardType) as BoardName;
    climbs.push({
      uuid: row.climbUuid,
      layoutId: row.layoutId,
      setter_username: row.setter_username || '',
      name: row.name || '',
      description: row.description || '',
      frames: row.frames || '',
      framesCount: row.frames_count ?? null,
      framesPace: row.frames_pace ?? null,
      compatibleSizeIds: row.compatible_size_ids ?? null,
      characteristics: row.characteristics ?? null,
      angle,
      ascensionist_count: Number(row.ascensionist_count || 0),
      difficulty: getGradeLabel(row.difficulty_id),
      quality_average: row.quality_average?.toString() || '0',
      stars: getClimbStars(row.quality_average),
      difficulty_error: row.difficulty_error?.toString() || '0',
      benchmark_difficulty:
        row.benchmark_difficulty && row.benchmark_difficulty > 0 ? row.benchmark_difficulty.toString() : null,
      boardType: boardName,
      boardseshDifficulty: row.boardsesh_difficulty == null ? null : Number(row.boardsesh_difficulty),
      boardseshConfidence: toConfidenceTier(row.boardsesh_confidence),
    });
  }

  return climbs;
}
