import { eq, and, asc, sql } from 'drizzle-orm';

import type { RequestDbInstance } from '../../../../db/client';import type { ConnectionContext, Climb, BoardName } from '@boardsesh/shared-schema';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { db } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { getGradeLabel } from '@boardsesh/db/queries';
import { validateInput } from '../../shared/helpers';
import { GetPlaylistClimbsInputSchema } from '../../../../validation/schemas';
import { getBoardTables, isValidBoardName } from '../../../../db/queries/util/table-select';
import { verifyPlaylistAccess } from '../helpers/enrichment';

export interface PlaylistClimbsInput {
  playlistId: string;
  boardName?: string;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  angle?: number;
  page?: number;
  pageSize?: number;
}

function paginateResults<T>(results: T[], pageSize: number) {
  const hasMore = results.length > pageSize;
  return { items: hasMore ? results.slice(0, pageSize) : results, hasMore };
}

/**
 * Specific-board mode: fetch climbs filtered by board type, layout, and size edges.
 */
async function fetchSpecificBoardClimbs(
  playlistId: bigint,
  input: PlaylistClimbsInput,
  page: number,
  pageSize: number,
): Promise<{ climbs: Climb[]; hasMore: boolean }> {
  const boardName = input.boardName as BoardName;
  if (!isValidBoardName(boardName)) {
    throw new Error(`Invalid board name: ${boardName}. Must be one of: ${SUPPORTED_BOARDS.join(', ')}`);
  }

  const tables = getBoardTables(boardName);

  // Build climb join conditions
  const climbJoinConditions = [
    eq(tables.climbs.uuid, dbSchema.playlistClimbs.climbUuid),
    eq(tables.climbs.boardType, boardName),
  ];

  if (input.layoutId != null) {
    climbJoinConditions.push(eq(tables.climbs.layoutId, input.layoutId));
  }

  if (input.sizeId != null) {
    climbJoinConditions.push(
      sql`${input.sizeId} = ANY(${tables.climbs.compatibleSizeIds})`,
    );
  }

  const inputAngle = input.angle ?? 40;

  const results = await db
    .select({
      climbUuid: dbSchema.playlistClimbs.climbUuid,
      playlistAngle: dbSchema.playlistClimbs.angle,
      position: dbSchema.playlistClimbs.position,
      uuid: tables.climbs.uuid,
      layoutId: tables.climbs.layoutId,
      setter_username: tables.climbs.setterUsername,
      name: tables.climbs.name,
      description: tables.climbs.description,
      frames: tables.climbs.frames,
      ascensionist_count: tables.climbStats.ascensionistCount,
      difficulty_id: sql<number | null>`ROUND(${tables.climbStats.displayDifficulty}::numeric, 0)`,
      quality_average: sql<number>`ROUND(${tables.climbStats.qualityAverage}::numeric, 2)`,
      difficulty_error: sql<number>`ROUND(${tables.climbStats.difficultyAverage}::numeric - ${tables.climbStats.displayDifficulty}::numeric, 2)`,
      benchmark_difficulty: tables.climbStats.benchmarkDifficulty,
    })
    .from(dbSchema.playlistClimbs)
    .innerJoin(tables.climbs, and(...climbJoinConditions))
    .leftJoin(
      tables.climbStats,
      and(
        eq(tables.climbStats.climbUuid, dbSchema.playlistClimbs.climbUuid),
        eq(tables.climbStats.boardType, boardName),
        eq(tables.climbStats.angle, inputAngle),
      ),
    )
    .where(eq(dbSchema.playlistClimbs.playlistId, playlistId))
    .orderBy(asc(dbSchema.playlistClimbs.position), asc(dbSchema.playlistClimbs.addedAt))
    .limit(pageSize + 1)
    .offset(page * pageSize);

  const { items, hasMore } = paginateResults(results, pageSize);

  const climbs: Climb[] = items.map((result) => ({
    uuid: result.uuid || result.climbUuid,
    layoutId: result.layoutId,
    setter_username: result.setter_username || '',
    name: result.name || '',
    description: result.description || '',
    frames: result.frames || '',
    angle: inputAngle,
    ascensionist_count: Number(result.ascensionist_count || 0),
    difficulty: getGradeLabel(result.difficulty_id),
    quality_average: result.quality_average?.toString() || '0',
    stars: Math.round((Number(result.quality_average) || 0) * 5),
    difficulty_error: result.difficulty_error?.toString() || '0',
    benchmark_difficulty: result.benchmark_difficulty && result.benchmark_difficulty > 0 ? result.benchmark_difficulty.toString() : null,
    boardType: boardName,
  }));

  return { climbs, hasMore };
}

/**
 * All-boards mode: fetch climbs across all board types.
 */
async function fetchAllBoardsClimbs(
  playlistId: bigint,
  page: number,
  pageSize: number,
): Promise<{ climbs: Climb[]; hasMore: boolean }> {
  const DEFAULT_ANGLE = 40;
  const tables = getBoardTables('kilter'); // All unified — just need table refs

  const results = await db
    .select({
      climbUuid: dbSchema.playlistClimbs.climbUuid,
      position: dbSchema.playlistClimbs.position,
      playlistAngle: dbSchema.playlistClimbs.angle,
      uuid: tables.climbs.uuid,
      layoutId: tables.climbs.layoutId,
      boardType: tables.climbs.boardType,
      setter_username: tables.climbs.setterUsername,
      name: tables.climbs.name,
      description: tables.climbs.description,
      frames: tables.climbs.frames,
      statsAngle: tables.climbStats.angle,
      ascensionist_count: tables.climbStats.ascensionistCount,
      difficulty_id: sql<number | null>`ROUND(${tables.climbStats.displayDifficulty}::numeric, 0)`,
      quality_average: sql<number>`ROUND(${tables.climbStats.qualityAverage}::numeric, 2)`,
      difficulty_error: sql<number>`ROUND(${tables.climbStats.difficultyAverage}::numeric - ${tables.climbStats.displayDifficulty}::numeric, 2)`,
      benchmark_difficulty: tables.climbStats.benchmarkDifficulty,
    })
    .from(dbSchema.playlistClimbs)
    .innerJoin(
      tables.climbs,
      eq(tables.climbs.uuid, dbSchema.playlistClimbs.climbUuid),
    )
    .leftJoin(
      tables.climbStats,
      and(
        eq(tables.climbStats.boardType, tables.climbs.boardType),
        eq(tables.climbStats.climbUuid, tables.climbs.uuid),
        eq(tables.climbStats.angle, sql`(
          SELECT s.angle FROM board_climb_stats s
          WHERE s.board_type = ${tables.climbs.boardType}
            AND s.climb_uuid = ${tables.climbs.uuid}
          ORDER BY s.ascensionist_count DESC NULLS LAST
          LIMIT 1
        )`),
      ),
    )
    .where(eq(dbSchema.playlistClimbs.playlistId, playlistId))
    .orderBy(asc(dbSchema.playlistClimbs.position), asc(dbSchema.playlistClimbs.addedAt))
    .limit(pageSize + 1)
    .offset(page * pageSize);

  const { items, hasMore } = paginateResults(results, pageSize);

  const climbs: Climb[] = items.map((result) => {
    const bt = (result.boardType || 'kilter') as BoardName;
    return {
      uuid: result.uuid || result.climbUuid,
      layoutId: result.layoutId,
      setter_username: result.setter_username || '',
      name: result.name || '',
      description: result.description || '',
      frames: result.frames || '',
      angle: result.playlistAngle ?? result.statsAngle ?? DEFAULT_ANGLE,
      ascensionist_count: Number(result.ascensionist_count || 0),
      difficulty: getGradeLabel(result.difficulty_id),
      quality_average: result.quality_average?.toString() || '0',
      stars: Math.round((Number(result.quality_average) || 0) * 5),
      difficulty_error: result.difficulty_error?.toString() || '0',
      benchmark_difficulty: result.benchmark_difficulty && result.benchmark_difficulty > 0 ? result.benchmark_difficulty.toString() : null,
      boardType: bt,
    };
  });

  return { climbs, hasMore };
}

/**
 * Get climbs in a playlist with full climb data.
 * Supports specific-board mode (boardName provided) or all-boards mode (boardName omitted).
 */
export const playlistClimbs = async (
  _: unknown,
  { input }: { input: PlaylistClimbsInput },
  ctx: ConnectionContext,
): Promise<{ climbs: Climb[]; totalCount: number; hasMore: boolean }> => {
  validateInput(GetPlaylistClimbsInputSchema, input, 'input');

  const page = input.page ?? 0;
  const pageSize = input.pageSize ?? 20;

  // Verify access (throws if denied)
  const playlistId = await verifyPlaylistAccess(input.playlistId, ctx.userId ?? null);

  // Get total count
  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dbSchema.playlistClimbs)
    .where(eq(dbSchema.playlistClimbs.playlistId, playlistId));

  const totalCount = countResult[0]?.count || 0;

  if (input.boardName) {
    const { climbs, hasMore } = await fetchSpecificBoardClimbs(playlistId, input, page, pageSize);
    return { climbs, totalCount, hasMore };
  } else {
    const { climbs, hasMore } = await fetchAllBoardsClimbs(playlistId, page, pageSize);
    return { climbs, totalCount, hasMore };
  }
};
