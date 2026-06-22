import { sql } from 'drizzle-orm';
import { db } from '../../client';
import { UNIFIED_TABLES, type BoardName } from '../util/table-select';
import { getClimbStars, getGradeLabel } from '@boardsesh/db/queries';
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
        frames_count: tables.climbs.framesCount,
        frames_pace: tables.climbs.framesPace,
        angle: sql<number>`COALESCE(${tables.climbStats.angle}, ${params.angle})`,
        ascensionist_count: sql<number>`COALESCE(${tables.climbStats.ascensionistCount}, 0)`,
        // Raw per-source counts (nullable bigint columns) — select directly so
        // the client can derive the "Board app" = GREATEST(kilter, aurora) view.
        kilter_ascensionist_count: tables.climbStats.kilterAscensionistCount,
        aurora_ascensionist_count: tables.climbStats.auroraAscensionistCount,
        boardsesh_ascensionist_count: tables.climbStats.boardseshAscensionistCount,
        difficulty_id: sql<number | null>`ROUND(${tables.climbStats.displayDifficulty}::numeric, 0)`,
        quality_average: sql<number>`ROUND(${tables.climbStats.qualityAverage}::numeric, 2)`,
        difficulty_error: sql<number>`ROUND(${tables.climbStats.difficultyAverage}::numeric - ${tables.climbStats.displayDifficulty}::numeric, 2)`,
        benchmark_difficulty: tables.climbStats.benchmarkDifficulty,
        is_draft: tables.climbs.isDraft,
        created_at: tables.climbs.createdAt,
        published_at: tables.climbs.publishedAt,
        characteristics: tables.climbs.characteristics,
      })
      .from(tables.climbs)
      .leftJoin(
        tables.climbStats,
        sql`${tables.climbStats.climbUuid} = ${tables.climbs.uuid}
        AND ${tables.climbStats.boardType} = ${params.board_name}
        AND ${tables.climbStats.angle} = ${params.angle}`,
      )
      .where(
        sql`${tables.climbs.boardType} = ${params.board_name}
        AND ${tables.climbs.layoutId} = ${params.layout_id}
        AND ${tables.climbs.uuid} = ${params.climb_uuid}`,
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
      // Scoped by the WHERE clause to this board + layout — carry them so the
      // queue's BLE spill guard can tell a climb set for another board apart.
      boardType: params.board_name,
      layoutId: params.layout_id,
      angle: Number(params.angle),
      ascensionist_count: Number(row.ascensionist_count || 0),
      // Keep null distinct from 0 so the client can tell "not tracked" apart
      // from a genuine zero per source.
      kilterAscensionistCount: row.kilter_ascensionist_count ?? null,
      auroraAscensionistCount: row.aurora_ascensionist_count ?? null,
      boardseshAscensionistCount: row.boardsesh_ascensionist_count ?? null,
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
    };

    return climb;
  } catch (error) {
    logger.error('Error in getClimbByUuid:', error);
    throw error;
  }
};
