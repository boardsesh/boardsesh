import { eq, and, asc, sql } from 'drizzle-orm';
import { type ConnectionContext, type Climb, type BoardName, SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { db } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { getClimbStars, getGradeLabel } from '@boardsesh/db/queries';
import { validateInput } from '../../shared/helpers';
import { GetPlaylistClimbsInputSchema } from '../../../../validation/schemas';
import { UNIFIED_TABLES, isValidBoardName } from '../../../../db/queries/util/table-select';
import { verifyPlaylistAccess } from '../helpers/enrichment';
import { hydrateClimbsByRefs } from '../helpers/hydrate-climbs';

export type PlaylistClimbsInput = {
  playlistId: string;
  boardName?: string;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  angle?: number;
  // All-boards mode only: render on-active-board climbs at the user's selected
  // angle instead of the added-at / most-ascents fallback.
  activeBoardName?: string;
  activeAngle?: number;
  page?: number;
  pageSize?: number;
};

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
    throw new Error(`Invalid board name: ${String(boardName)}. Must be one of: ${SUPPORTED_BOARDS.join(', ')}`);
  }

  const tables = UNIFIED_TABLES;

  // Build climb join conditions
  const climbJoinConditions = [
    eq(tables.climbs.uuid, dbSchema.playlistClimbs.climbUuid),
    eq(tables.climbs.boardType, boardName),
  ];

  if (input.layoutId != null) {
    climbJoinConditions.push(eq(tables.climbs.layoutId, input.layoutId));
  }

  if (input.sizeId != null) {
    climbJoinConditions.push(sql`${input.sizeId} = ANY(${tables.climbs.compatibleSizeIds})`);
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
      frames_count: tables.climbs.framesCount,
      frames_pace: tables.climbs.framesPace,
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
    framesCount: result.frames_count ?? null,
    framesPace: result.frames_pace ?? null,
    angle: inputAngle,
    ascensionist_count: Number(result.ascensionist_count || 0),
    difficulty: getGradeLabel(result.difficulty_id),
    quality_average: result.quality_average?.toString() || '0',
    stars: getClimbStars(result.quality_average),
    difficulty_error: result.difficulty_error?.toString() || '0',
    benchmark_difficulty:
      result.benchmark_difficulty && result.benchmark_difficulty > 0 ? result.benchmark_difficulty.toString() : null,
    boardType: boardName,
  }));

  return { climbs, hasMore };
}

/**
 * All-boards mode: fetch climbs across all board types.
 *
 * Two-step: first read the page of refs (uuid + boardType + per-row angle
 * override) from playlistClimbs in position order, then hand them to the
 * shared hydrator which owns the climbs/climbStats join. Lets schema changes
 * to climbStats live in exactly one file (`helpers/hydrate-climbs.ts`).
 */
async function fetchAllBoardsClimbs(
  playlistId: bigint,
  input: PlaylistClimbsInput,
  page: number,
  pageSize: number,
): Promise<{ climbs: Climb[]; hasMore: boolean }> {
  const tables = UNIFIED_TABLES;

  const refRows = await db
    .select({
      climbUuid: dbSchema.playlistClimbs.climbUuid,
      boardType: tables.climbs.boardType,
      playlistAngle: dbSchema.playlistClimbs.angle,
    })
    .from(dbSchema.playlistClimbs)
    .innerJoin(tables.climbs, eq(tables.climbs.uuid, dbSchema.playlistClimbs.climbUuid))
    .where(eq(dbSchema.playlistClimbs.playlistId, playlistId))
    .orderBy(asc(dbSchema.playlistClimbs.position), asc(dbSchema.playlistClimbs.addedAt))
    .limit(pageSize + 1)
    .offset(page * pageSize);

  const { items, hasMore } = paginateResults(refRows, pageSize);

  // Climbs on the active board render their grade at the user's selected angle;
  // every other climb keeps its added-at angle (most-ascents when null). The
  // hydrator drops back to most-ascents if a climb has no stats at the override
  // angle, so the selected angle never blanks a grade.
  const { activeBoardName, activeAngle } = input;
  const angleOverrides = new Map<string, number | null>();
  for (const row of items) {
    const useActiveAngle = activeBoardName != null && activeAngle != null && row.boardType === activeBoardName;
    angleOverrides.set(`${row.boardType}:${row.climbUuid}`, useActiveAngle ? activeAngle : (row.playlistAngle ?? null));
  }

  const climbs = await hydrateClimbsByRefs(
    items.map((row) => ({ climbUuid: row.climbUuid, boardType: row.boardType })),
    { angleOverrides },
  );

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
    const { climbs, hasMore } = await fetchAllBoardsClimbs(playlistId, input, page, pageSize);
    return { climbs, totalCount, hasMore };
  }
};
