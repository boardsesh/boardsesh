import { sql } from 'drizzle-orm';
import { db } from '../../client';
import { UNIFIED_TABLES, type BoardName } from '../util/table-select';
import { getGradeLabel } from '@boardsesh/db/queries';
import type { Climb } from '@boardsesh/shared-schema';

interface GetClimbParams {
  board_name: BoardName;
  layout_id: number;
  size_id: number;
  angle: number;
  climb_uuid: string;
}

export const getClimbByUuid = async (params: GetClimbParams): Promise<Climb | null> => {
  const tables = UNIFIED_TABLES;

  try {
    const result = await db
      .select({
        uuid: tables.climbs.uuid,
        setter_username: tables.climbs.setterUsername,
        user_id: tables.climbs.userId,
        name: tables.climbs.name,
        description: tables.climbs.description,
        frames: tables.climbs.frames,
        angle: sql<number>`COALESCE(${tables.climbStats.angle}, ${params.angle})`,
        ascensionist_count: sql<number>`COALESCE(${tables.climbStats.ascensionistCount}, 0)`,
        difficulty_id: sql<number | null>`ROUND(${tables.climbStats.displayDifficulty}::numeric, 0)`,
        quality_average: sql<number>`ROUND(${tables.climbStats.qualityAverage}::numeric, 2)`,
        difficulty_error: sql<number>`ROUND(${tables.climbStats.difficultyAverage}::numeric - ${tables.climbStats.displayDifficulty}::numeric, 2)`,
        benchmark_difficulty: tables.climbStats.benchmarkDifficulty,
        is_draft: tables.climbs.isDraft,
        created_at: tables.climbs.createdAt,
        published_at: tables.climbs.publishedAt,
        board_type: tables.climbs.boardType,
        layout_id: tables.climbs.layoutId,
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
        AND ${tables.climbs.uuid} = ${params.climb_uuid}
        AND ${tables.climbs.framesCount} = 1`,
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
      angle: Number(params.angle),
      ascensionist_count: Number(row.ascensionist_count || 0),
      difficulty: getGradeLabel(row.difficulty_id),
      quality_average: row.quality_average?.toString() || '0',
      stars: Math.round((Number(row.quality_average) || 0) * 5),
      difficulty_error: row.difficulty_error?.toString() || '0',
      benchmark_difficulty:
        row.benchmark_difficulty && row.benchmark_difficulty > 0 ? row.benchmark_difficulty.toString() : null,
      is_draft: row.is_draft ?? false,
      created_at: row.created_at ?? null,
      published_at: row.published_at ?? null,
      boardType: row.board_type ?? params.board_name,
      layoutId: row.layout_id ?? params.layout_id,
    };

    return climb;
  } catch (error) {
    console.error('Error in getClimbByUuid:', error);
    throw error;
  }
};
