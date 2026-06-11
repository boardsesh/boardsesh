import { eq, and, sql, desc } from 'drizzle-orm';
import { type ConnectionContext, type Climb, type BoardName, SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { getClimbStars, getGradeLabel } from '@boardsesh/db/queries';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { GetUserFavoriteClimbsInputSchema } from '../../../validation/schemas';
import { UNIFIED_TABLES, isValidBoardName } from '../../../db/queries/util/table-select';

export const favoriteClimbsQuery = {
  userFavoriteClimbs: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        boardName: string;
        layoutId: number;
        sizeId: number;
        setIds: string;
        angle: number;
        page?: number;
        pageSize?: number;
      };
    },
    ctx: ConnectionContext,
  ): Promise<{ climbs: Climb[]; totalCount: number; hasMore: boolean }> => {
    requireAuthenticated(ctx);
    validateInput(GetUserFavoriteClimbsInputSchema, input, 'input');

    const userId = ctx.userId!;
    const boardName = input.boardName as BoardName;

    if (!isValidBoardName(boardName)) {
      throw new Error(`Invalid board name: ${String(boardName)}. Must be one of: ${SUPPORTED_BOARDS.join(', ')}`);
    }

    const page = input.page ?? 0;
    const pageSize = input.pageSize ?? 20;
    const tables = UNIFIED_TABLES;

    // Only count favorites whose climb belongs to the requested board.
    const countResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(dbSchema.userFavorites)
      .innerJoin(
        tables.climbs,
        and(eq(tables.climbs.uuid, dbSchema.userFavorites.climbUuid), eq(tables.climbs.boardType, boardName)),
      )
      .where(eq(dbSchema.userFavorites.userId, userId));

    const totalCount = countResult[0]?.count || 0;

    const results = await db
      .select({
        climbUuid: dbSchema.userFavorites.climbUuid,
        favoritedAt: dbSchema.userFavorites.createdAt,
        // Climb data
        uuid: tables.climbs.uuid,
        layoutId: tables.climbs.layoutId,
        setter_username: tables.climbs.setterUsername,
        name: tables.climbs.name,
        description: tables.climbs.description,
        frames: tables.climbs.frames,
        frames_count: tables.climbs.framesCount,
        frames_pace: tables.climbs.framesPace,
        // Stats data
        ascensionist_count: tables.climbStats.ascensionistCount,
        difficulty_id: sql<number | null>`ROUND(${tables.climbStats.displayDifficulty}::numeric, 0)`,
        quality_average: sql<number>`ROUND(${tables.climbStats.qualityAverage}::numeric, 2)`,
        difficulty_error: sql<number>`ROUND(${tables.climbStats.difficultyAverage}::numeric - ${tables.climbStats.displayDifficulty}::numeric, 2)`,
        benchmark_difficulty: tables.climbStats.benchmarkDifficulty,
      })
      .from(dbSchema.userFavorites)
      .innerJoin(
        tables.climbs,
        and(eq(tables.climbs.uuid, dbSchema.userFavorites.climbUuid), eq(tables.climbs.boardType, boardName)),
      )
      .leftJoin(
        tables.climbStats,
        and(
          eq(tables.climbStats.climbUuid, dbSchema.userFavorites.climbUuid),
          eq(tables.climbStats.boardType, boardName),
          eq(tables.climbStats.angle, input.angle),
        ),
      )
      .where(eq(dbSchema.userFavorites.userId, userId))
      .orderBy(desc(dbSchema.userFavorites.createdAt))
      .limit(pageSize + 1)
      .offset(page * pageSize);

    const hasMore = results.length > pageSize;
    const trimmedResults = hasMore ? results.slice(0, pageSize) : results;

    const climbs: Climb[] = trimmedResults.map((result) => ({
      uuid: result.uuid || result.climbUuid,
      layoutId: result.layoutId,
      setter_username: result.setter_username || '',
      name: result.name || '',
      description: result.description || '',
      frames: result.frames || '',
      framesCount: result.frames_count ?? null,
      framesPace: result.frames_pace ?? null,
      angle: input.angle,
      ascensionist_count: Number(result.ascensionist_count || 0),
      difficulty: getGradeLabel(result.difficulty_id),
      quality_average: result.quality_average?.toString() || '0',
      stars: getClimbStars(result.quality_average),
      difficulty_error: result.difficulty_error?.toString() || '0',
      benchmark_difficulty:
        result.benchmark_difficulty && result.benchmark_difficulty > 0 ? result.benchmark_difficulty.toString() : null,
    }));

    return {
      climbs,
      totalCount,
      hasMore,
    };
  },
};
