import { sql } from 'drizzle-orm';
import { db } from '../../client';
import { UNIFIED_TABLES, type BoardName } from '../util/table-select';
import { getClimbStars, getGradeLabel, toConfidenceTier, resolveCanonicalClimbUuid } from '@boardsesh/db/queries';
import { boardClimbGrades } from '@boardsesh/db/schema';
import type { Climb } from '@boardsesh/shared-schema';
import { logger } from '../../../utils/logger';

type GetClimbParams = {
  board_name: BoardName;
  layout_id: number;
  size_id: number;
  angle: number;
  climb_uuid: string;
};

export const getClimbByUuid = async (params: GetClimbParams): Promise<Climb | null> => {
  const tables = UNIFIED_TABLES;

  try {
    // Resolve through board_climb_aliases first: an old/bookmarked/shared
    // link to a climb that's since been merged into another (e.g. the
    // MoonBoard angle-dedup migration 0193_moonboard_angle_dedup_backfill)
    // must still resolve to where its stats/ticks/favorites actually live now,
    // not render an empty husk.
    const climbUuid = await resolveCanonicalClimbUuid(db, params.board_name, params.climb_uuid);

    // Direct-by-UUID lookups intentionally do NOT filter `framesCount = 1`.
    // Search/dedupe still skip multi-frame climbs, but the player needs to
    // be able to render variable-speed Aurora routes when navigated to by URL.
    const result = await db
      .select({
        uuid: tables.climbs.uuid,
        setter_username: tables.climbs.setterUsername,
        user_id: tables.climbs.userId,
        name: tables.climbs.name,
        description: tables.climbs.description,
        frames: tables.climbs.frames,
        controller_route_uuid: tables.climbs.controllerRouteUuid,
        frames_count: tables.climbs.framesCount,
        frames_pace: tables.climbs.framesPace,
        angle: sql<number>`COALESCE(${tables.climbStats.angle}, ${params.angle})`,
        ascensionist_count: sql<number>`COALESCE(${tables.climbStats.ascensionistCount}, 0)`,
        difficulty_id: sql<number | null>`ROUND(${tables.climbStats.displayDifficulty}::numeric, 0)`,
        quality_average: sql<number>`ROUND(${tables.climbStats.qualityAverage}::numeric, 2)`,
        difficulty_error: sql<number>`ROUND(${tables.climbStats.difficultyAverage}::numeric - ${tables.climbStats.displayDifficulty}::numeric, 2)`,
        benchmark_difficulty: tables.climbStats.benchmarkDifficulty,
        is_draft: tables.climbs.isDraft,
        created_at: tables.climbs.createdAt,
        published_at: tables.climbs.publishedAt,
        characteristics: tables.climbs.characteristics,
        // The sizes this climb fits on — the queue judges size compatibility
        // client-side, and on Woods it is the only signal separating the 8x10
        // from the 12x12 (their hold ids overlap as different holds).
        compatible_size_ids: tables.climbs.compatibleSizeIds,
        // Boardsesh grade at the requested angle. The queue's angle-change refetch
        // routes through this query, so the fresh grade rides along for free.
        boardsesh_difficulty: sql<
          number | null
        >`COALESCE(${boardClimbGrades.universalGrade}, ${boardClimbGrades.localGrade})`,
        boardsesh_confidence: boardClimbGrades.confidence,
      })
      .from(tables.climbs)
      .leftJoin(
        tables.climbStats,
        sql`${tables.climbStats.climbUuid} = ${tables.climbs.uuid}
        AND ${tables.climbStats.boardType} = ${params.board_name}
        AND ${tables.climbStats.angle} = ${params.angle}`,
      )
      .leftJoin(
        boardClimbGrades,
        sql`${boardClimbGrades.climbUuid} = ${tables.climbs.uuid}
        AND ${boardClimbGrades.boardType} = ${params.board_name}
        AND ${boardClimbGrades.angle} = ${params.angle}`,
      )
      .where(
        sql`${tables.climbs.boardType} = ${params.board_name}
        AND ${tables.climbs.layoutId} = ${params.layout_id}
        AND ${tables.climbs.uuid} = ${climbUuid}`,
      )
      .limit(1);

    if (result.length === 0) {
      return null;
    }

    const row = result[0];

    const climb: Climb = {
      uuid: row.uuid,
      setter_username: row.setter_username || '',
      userId: row.user_id ?? null,
      name: row.name || '',
      description: row.description || '',
      frames: row.frames || '',
      controllerRouteUuid: row.controller_route_uuid ?? null,
      // Scoped by the WHERE clause to this board + layout — carry them so the
      // queue's BLE spill guard can tell a climb set for another board apart.
      boardType: params.board_name,
      layoutId: params.layout_id,
      angle: Number(params.angle),
      ascensionist_count: Number(row.ascensionist_count || 0),
      difficulty: getGradeLabel(row.difficulty_id),
      quality_average: row.quality_average?.toString() || '0',
      stars: getClimbStars(row.quality_average),
      difficulty_error: row.difficulty_error?.toString() || '0',
      benchmark_difficulty:
        row.benchmark_difficulty && row.benchmark_difficulty > 0 ? row.benchmark_difficulty.toString() : null,
      is_draft: row.is_draft ?? false,
      created_at: row.created_at ?? null,
      published_at: row.published_at ?? null,
      framesCount: row.frames_count ?? null,
      framesPace: row.frames_pace ?? null,
      characteristics: row.characteristics ?? null,
      compatibleSizeIds: row.compatible_size_ids ?? null,
      boardseshDifficulty: row.boardsesh_difficulty == null ? null : Number(row.boardsesh_difficulty),
      boardseshConfidence: toConfidenceTier(row.boardsesh_confidence),
    };

    return climb;
  } catch (error) {
    logger.error('Error in getClimbByUuid:', error);
    throw error;
  }
};
