import { and, eq, or, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { ConnectionContext, Climb, BoardName } from '@boardsesh/shared-schema';
import { resolveRenderBoard } from '@boardsesh/board-config';
import { executeRows } from '@boardsesh/db/client';
import * as dbSchema from '@boardsesh/db/schema';
import {
  createPlaylistClimbFilters,
  getClimbStars,
  getGradeLabel,
  sprayClimbVisibilityCondition,
  toConfidenceTier,
  type PlaylistActiveBoard,
  type SerialPlanDb,
} from '@boardsesh/db/queries';
import { db } from '../../../db/client';
import { canViewUserActivity } from '../../../services/privacy';
import { fetchOwnerBoards } from './render-board';

const DEFAULT_ANGLE = 40;

export type UserClimbMapping = { boardType: string; boardUsername: string };

/** Load once so ownership stays an indexable user-id OR setter-name predicate. */
export async function readUserClimbMappings(userId: string, executor: SerialPlanDb = db): Promise<UserClimbMapping[]> {
  const mappings = await executor
    .select({
      boardType: dbSchema.userBoardMappings.boardType,
      boardUsername: dbSchema.userBoardMappings.boardUsername,
    })
    .from(dbSchema.userBoardMappings)
    .where(eq(dbSchema.userBoardMappings.userId, userId));
  return mappings.filter(
    (mapping): mapping is UserClimbMapping => mapping.boardUsername !== null && mapping.boardUsername.length > 0,
  );
}

/** Membership shared by profile climbs, the generated list and its card count. */
export function userClimbsWhereCondition({
  userId,
  viewerUserId,
  isSelf,
  linkedMappings,
  boardName,
}: {
  userId: string;
  viewerUserId: string | null | undefined;
  isSelf: boolean;
  linkedMappings: readonly UserClimbMapping[];
  boardName?: string;
}) {
  const climbs = dbSchema.boardClimbs;
  return and(
    or(
      eq(climbs.userId, userId),
      ...linkedMappings.map(({ boardType, boardUsername }) =>
        and(eq(climbs.boardType, boardType), eq(climbs.setterUsername, boardUsername)),
      ),
    ),
    eq(climbs.isDraft, false),
    isSelf ? undefined : eq(climbs.isListed, true),
    isSelf ? undefined : eq(climbs.isHidden, false),
    boardName ? eq(climbs.boardType, boardName) : undefined,
    sprayClimbVisibilityCondition({ boardType: climbs.boardType, layoutId: climbs.layoutId }, viewerUserId),
  );
}

/** Published climbs set directly or under the owner's linked board logins. */
export async function fetchUserClimbs(
  {
    userId,
    sortBy = 'newest',
    limit = 20,
    offset = 0,
    boardName,
    activeBoard,
  }: {
    userId: string;
    sortBy?: string;
    limit?: number;
    offset?: number;
    boardName?: string;
    activeBoard?: PlaylistActiveBoard | null;
  },
  ctx: ConnectionContext,
): Promise<{ climbs: Climb[]; totalCount: number; hasMore: boolean }> {
  const viewerUserId = ctx.isAuthenticated ? ctx.userId : null;
  const isSelf = !!viewerUserId && viewerUserId === userId;
  const includeLinkedLogins = isSelf || (await canViewUserActivity(viewerUserId, userId));
  const linkedMappings = includeLinkedLogins ? await readUserClimbMappings(userId) : [];
  const tables = { climbs: dbSchema.boardClimbs };
  const boardFilters = activeBoard
    ? createPlaylistClimbFilters(activeBoard, { onlyActiveBoard: true }, viewerUserId ?? undefined)
    : null;
  const whereCondition = and(
    userClimbsWhereCondition({ userId, viewerUserId, isSelf, linkedMappings, boardName }),
    ...(boardFilters?.allRows ?? []),
    ...(boardFilters?.activeBoardOnly ?? []),
  );

  // 3. Get total count
  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tables.climbs)
    .where(whereCondition);

  const totalCount = Number(countResult?.count ?? 0);

  // 4. Get climbs with stats at the most popular angle, but only compute stats for owned climbs.
  // Build the owned CTE with the same table predicates as the count. This
  // also applies active-board geometry before either pagination query.
  const ownedClimbsQuery = new QueryBuilder()
    .select({
      uuid: tables.climbs.uuid,
      layoutId: tables.climbs.layoutId,
      boardType: tables.climbs.boardType,
      setterUsername: tables.climbs.setterUsername,
      name: tables.climbs.name,
      description: tables.climbs.description,
      frames: tables.climbs.frames,
      framesCount: tables.climbs.framesCount,
      framesPace: tables.climbs.framesPace,
      compatibleSizeIds: tables.climbs.compatibleSizeIds,
      missingHoldCount: tables.climbs.missingHoldCount,
      revisionNumber: tables.climbs.revisionNumber,
      holdsRevisionNumber: tables.climbs.holdsRevisionNumber,
      characteristics: tables.climbs.characteristics,
      requiredSetIds: tables.climbs.requiredSetIds,
      isHidden: tables.climbs.isHidden,
      createdAt: tables.climbs.createdAt,
    })
    .from(tables.climbs)
    .where(whereCondition)
    .getSQL();

  const orderSql =
    sortBy === 'popular'
      ? sql`COALESCE(best.ascensionist_count, 0) DESC`
      : sql`owned_climbs.created_at DESC NULLS LAST`;

  type RawRow = {
    uuid: string;
    layout_id: number | null;
    board_type: string;
    setter_username: string | null;
    name: string | null;
    description: string | null;
    frames: string | null;
    frames_count: number | null;
    frames_pace: number | null;
    compatible_size_ids: number[] | null;
    missing_hold_count: number | null;
    revision_number: number | null;
    holds_revision_number: number | null;
    characteristics: string[] | null;
    required_set_ids: number[] | null;
    is_hidden: boolean | null;
    stats_angle: number | null;
    ascensionist_count: number | null;
    difficulty_id: number | null;
    quality_average: number | null;
    difficulty_error: number | null;
    benchmark_difficulty: number | null;
    boardsesh_difficulty: number | null;
    boardsesh_confidence: string | null;
  };

  const rawRows = await executeRows<RawRow>(
    db,
    sql`
      WITH owned_climbs AS (${ownedClimbsQuery}),
      best_angle AS (
        SELECT DISTINCT ON (stats.board_type, stats.climb_uuid)
          stats.board_type,
          stats.climb_uuid,
          stats.angle,
          stats.ascensionist_count,
          stats.display_difficulty,
          stats.quality_average,
          stats.difficulty_average,
          stats.benchmark_difficulty
        FROM board_climb_stats stats
        INNER JOIN owned_climbs
          ON owned_climbs.board_type = stats.board_type
         AND owned_climbs.uuid = stats.climb_uuid
        ORDER BY stats.board_type, stats.climb_uuid, stats.ascensionist_count DESC NULLS LAST, stats.angle ASC
      )
      SELECT
        owned_climbs.uuid,
        owned_climbs.layout_id,
        owned_climbs.board_type,
        owned_climbs.setter_username,
        owned_climbs.name,
        owned_climbs.description,
        owned_climbs.frames,
        owned_climbs.frames_count,
        owned_climbs.frames_pace,
        owned_climbs.compatible_size_ids,
        owned_climbs.missing_hold_count,
        owned_climbs.revision_number,
        owned_climbs.holds_revision_number,
        owned_climbs.characteristics,
        owned_climbs.required_set_ids,
        owned_climbs.is_hidden,
        best.angle AS stats_angle,
        best.ascensionist_count,
        ROUND(best.display_difficulty::numeric, 0)::int AS difficulty_id,
        ROUND(best.quality_average::numeric, 2) AS quality_average,
        ROUND(best.difficulty_average::numeric - best.display_difficulty::numeric, 2) AS difficulty_error,
        best.benchmark_difficulty,
        COALESCE(grades.universal_grade, grades.local_grade) AS boardsesh_difficulty,
        grades.confidence AS boardsesh_confidence
      FROM owned_climbs
      LEFT JOIN best_angle best
        ON best.board_type = owned_climbs.board_type
       AND best.climb_uuid = owned_climbs.uuid
      LEFT JOIN board_climb_grades grades
        ON grades.board_type = owned_climbs.board_type
       AND grades.climb_uuid = owned_climbs.uuid
       AND grades.angle = best.angle
      ORDER BY ${orderSql}, owned_climbs.board_type DESC, owned_climbs.uuid DESC
      LIMIT ${limit + 1}
      OFFSET ${offset}
    `,
  );

  const hasMore = rawRows.length > limit;
  const trimmedResults = hasMore ? rawRows.slice(0, limit) : rawRows;

  // Draw a setter's climbs on their own wall rather than on the biggest size
  // the layout comes in — the profile Climbs tab has no board in its route.
  const ownerBoards = (await fetchOwnerBoards([userId])).get(userId) ?? [];

  const climbs: Climb[] = trimmedResults.map((result) => {
    const boardName = (result.board_type || 'kilter') as BoardName;
    return {
      uuid: result.uuid,
      layoutId: result.layout_id,
      setter_username: result.setter_username || '',
      name: result.name || '',
      description: result.description || '',
      frames: result.frames || '',
      framesCount: result.frames_count ?? null,
      framesPace: result.frames_pace ?? null,
      compatibleSizeIds: result.compatible_size_ids ?? null,
      requiredSetIds: result.required_set_ids ?? null,
      missingHoldCount: result.missing_hold_count ?? null,
      revisionNumber: result.revision_number ?? null,
      holdsRevisionNumber: result.holds_revision_number ?? null,
      characteristics: result.characteristics ?? null,
      is_hidden: result.is_hidden ?? false,
      angle: result.stats_angle ?? DEFAULT_ANGLE,
      statsAngle: result.stats_angle ?? null,
      ascensionist_count: Number(result.ascensionist_count || 0),
      difficulty: getGradeLabel(result.difficulty_id, boardName),
      quality_average: result.quality_average?.toString() || '0',
      stars: getClimbStars(result.quality_average),
      difficulty_error: result.difficulty_error?.toString() || '0',
      benchmark_difficulty:
        result.benchmark_difficulty && result.benchmark_difficulty > 0 ? result.benchmark_difficulty.toString() : null,
      boardType: boardName,
      boardseshDifficulty: result.boardsesh_difficulty == null ? null : Number(result.boardsesh_difficulty),
      boardseshConfidence: toConfidenceTier(result.boardsesh_confidence),
      renderBoard: resolveRenderBoard({
        boardType: boardName,
        climbLayoutId: result.layout_id,
        compatibleSizeIds: result.compatible_size_ids,
        requiredSetIds: result.required_set_ids,
        ownerBoards,
      }),
    };
  });

  return { climbs, totalCount, hasMore };
}
