import { eq, and, count, sql, ilike, inArray } from 'drizzle-orm';
import { type ConnectionContext, type Climb, type BoardName, SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { executeRows } from '@boardsesh/db/client';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { getClimbStars, getGradeLabel } from '@boardsesh/db/queries';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import {
  FollowSetterInputSchema,
  SetterProfileInputSchema,
  SetterClimbsInputSchema,
  SetterClimbsFullInputSchema,
  SearchUsersInputSchema,
  UserClimbsInputSchema,
} from '../../../validation/schemas';
import { publishSocialEvent } from '../../../events/index';
import { UNIFIED_TABLES, isValidBoardName } from '../../../db/queries/util/table-select';
import { logger } from '../../../utils/logger';

/** Default angle fallback when no angle specified or no stats exist. 40 is the most common training angle. */
const DEFAULT_ANGLE = 40;

export const setterFollowQueries = {
  /**
   * Get a setter profile by username
   */
  setterProfile: async (_: unknown, { input }: { input: { username: string } }, ctx: ConnectionContext) => {
    const validatedInput = validateInput(SetterProfileInputSchema, input, 'input');
    const username = validatedInput.username;

    // Get distinct board types and climb count
    const boardTypeResults = await db
      .select({
        boardType: dbSchema.boardClimbs.boardType,
        climbCount: count(),
      })
      .from(dbSchema.boardClimbs)
      .where(eq(dbSchema.boardClimbs.setterUsername, username))
      .groupBy(dbSchema.boardClimbs.boardType);

    if (boardTypeResults.length === 0) {
      return null;
    }

    const boardTypes = boardTypeResults.map((r) => r.boardType);
    const totalClimbCount = boardTypeResults.reduce((sum, r) => sum + Number(r.climbCount), 0);

    // Count followers
    const [followerResult] = await db
      .select({ count: count() })
      .from(dbSchema.setterFollows)
      .where(eq(dbSchema.setterFollows.setterUsername, username));

    const followerCount = Number(followerResult?.count ?? 0);

    // Check isFollowedByMe
    let isFollowedByMe = false;
    if (ctx.isAuthenticated && ctx.userId) {
      const [followCheck] = await db
        .select({ count: count() })
        .from(dbSchema.setterFollows)
        .where(
          and(eq(dbSchema.setterFollows.followerId, ctx.userId), eq(dbSchema.setterFollows.setterUsername, username)),
        );
      isFollowedByMe = Number(followCheck?.count ?? 0) > 0;
    }

    // Check for linked Boardsesh user
    const linkedUsers = await db
      .select({
        userId: dbSchema.userBoardMappings.userId,
        displayName: dbSchema.userProfiles.displayName,
        avatarUrl: dbSchema.userProfiles.avatarUrl,
        userName: dbSchema.users.name,
        userImage: dbSchema.users.image,
      })
      .from(dbSchema.userBoardMappings)
      .innerJoin(dbSchema.users, eq(dbSchema.userBoardMappings.userId, dbSchema.users.id))
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.userBoardMappings.userId, dbSchema.userProfiles.userId))
      .where(eq(dbSchema.userBoardMappings.boardUsername, username))
      .limit(1);

    const linkedUser = linkedUsers[0];

    return {
      username,
      climbCount: totalClimbCount,
      boardTypes,
      followerCount,
      isFollowedByMe,
      linkedUserId: linkedUser?.userId ?? null,
      linkedUserDisplayName: linkedUser?.displayName || linkedUser?.userName || null,
      linkedUserAvatarUrl: linkedUser?.avatarUrl || linkedUser?.userImage || null,
    };
  },

  /**
   * Get climbs created by a setter
   */
  setterClimbs: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        username: string;
        boardType?: string;
        layoutId?: number;
        sortBy?: string;
        limit?: number;
        offset?: number;
      };
    },
    _ctx: ConnectionContext,
  ) => {
    const validatedInput = validateInput(SetterClimbsInputSchema, input, 'input');
    const { username, boardType, layoutId, sortBy, limit, offset } = validatedInput;

    // Build conditions
    const conditions = [eq(dbSchema.boardClimbs.setterUsername, username)];
    if (boardType) {
      conditions.push(eq(dbSchema.boardClimbs.boardType, boardType));
    }
    if (layoutId != null) {
      conditions.push(eq(dbSchema.boardClimbs.layoutId, layoutId));
    }

    // Get total count
    const [countResult] = await db
      .select({ count: count() })
      .from(dbSchema.boardClimbs)
      .where(and(...conditions));

    const totalCount = Number(countResult?.count ?? 0);

    // Get climbs with stats at the most popular angle (most ascensionists)
    const climbs = await db
      .select({
        uuid: dbSchema.boardClimbs.uuid,
        name: dbSchema.boardClimbs.name,
        boardType: dbSchema.boardClimbs.boardType,
        layoutId: dbSchema.boardClimbs.layoutId,
        createdAt: dbSchema.boardClimbs.createdAt,
        statsAngle: dbSchema.boardClimbStats.angle,
        qualityAverage: dbSchema.boardClimbStats.qualityAverage,
        ascensionistCount: dbSchema.boardClimbStats.ascensionistCount,
        difficultyId: sql<number | null>`ROUND(${dbSchema.boardClimbStats.displayDifficulty}::numeric, 0)`,
      })
      .from(dbSchema.boardClimbs)
      .leftJoin(
        dbSchema.boardClimbStats,
        and(
          eq(dbSchema.boardClimbStats.boardType, dbSchema.boardClimbs.boardType),
          eq(dbSchema.boardClimbStats.climbUuid, dbSchema.boardClimbs.uuid),
          eq(
            dbSchema.boardClimbStats.angle,
            sql`(
            SELECT s.angle FROM board_climb_stats s
            WHERE s.board_type = ${dbSchema.boardClimbs.boardType}
              AND s.climb_uuid = ${dbSchema.boardClimbs.uuid}
            ORDER BY s.ascensionist_count DESC NULLS LAST
            LIMIT 1
          )`,
          ),
        ),
      )
      .where(and(...conditions))
      .orderBy(
        sortBy === 'popular'
          ? sql`COALESCE(${dbSchema.boardClimbStats.ascensionistCount}, 0) DESC`
          : sql`${dbSchema.boardClimbs.createdAt} DESC NULLS LAST`,
      )
      .limit(limit)
      .offset(offset);

    return {
      climbs: climbs.map((c) => ({
        uuid: c.uuid,
        name: c.name,
        boardType: c.boardType,
        layoutId: c.layoutId,
        angle: c.statsAngle ?? null,
        difficultyName: getGradeLabel(c.difficultyId),
        qualityAverage: c.qualityAverage ?? null,
        ascensionistCount: c.ascensionistCount ?? null,
        createdAt: c.createdAt ?? null,
      })),
      totalCount,
      hasMore: offset + climbs.length < totalCount,
    };
  },

  /**
   * Get climbs created by a setter with full Climb data (for thumbnails).
   * Supports multi-board mode when boardType is omitted.
   */
  setterClimbsFull: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        username: string;
        boardType?: string;
        layoutId?: number;
        sizeId?: number;
        setIds?: string;
        angle?: number;
        sortBy?: string;
        limit?: number;
        offset?: number;
      };
    },
    _ctx: ConnectionContext,
  ): Promise<{ climbs: Climb[]; totalCount: number; hasMore: boolean }> => {
    const validatedInput = validateInput(SetterClimbsFullInputSchema, input, 'input');
    const { username, boardType, sortBy, limit, offset } = validatedInput;

    if (boardType) {
      // === Specific board mode ===
      const boardName = boardType;
      if (!isValidBoardName(boardName)) {
        throw new Error(`Invalid board name: ${String(boardName)}. Must be one of: ${SUPPORTED_BOARDS.join(', ')}`);
      }

      const angle = validatedInput.angle ?? DEFAULT_ANGLE;
      const { layoutId, sizeId } = validatedInput;
      const tables = UNIFIED_TABLES;

      // Build WHERE conditions for board filter
      const filterConditions: ReturnType<typeof eq>[] = [
        eq(tables.climbs.setterUsername, username),
        eq(tables.climbs.boardType, boardName),
      ];

      // Filter by layout if provided
      if (layoutId != null) {
        filterConditions.push(eq(tables.climbs.layoutId, layoutId));
      }

      // Filter by compatible size if sizeId is provided
      if (sizeId != null) {
        filterConditions.push(sql`${sizeId} = ANY(${tables.climbs.compatibleSizeIds})`);
      }

      // Get total count
      const [countResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(tables.climbs)
        .where(and(...filterConditions));

      const totalCount = Number(countResult?.count ?? 0);

      // Get climbs with stats at specified angle
      const results = await db
        .select({
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
        .from(tables.climbs)
        .leftJoin(
          tables.climbStats,
          and(
            eq(tables.climbStats.climbUuid, tables.climbs.uuid),
            eq(tables.climbStats.boardType, boardName),
            eq(tables.climbStats.angle, angle),
          ),
        )
        .where(and(...filterConditions))
        .orderBy(
          sortBy === 'popular'
            ? sql`COALESCE(${tables.climbStats.ascensionistCount}, 0) DESC`
            : sql`${tables.climbs.createdAt} DESC NULLS LAST`,
        )
        .limit(limit + 1)
        .offset(offset);

      const hasMore = results.length > limit;
      const trimmedResults = hasMore ? results.slice(0, limit) : results;

      const climbs: Climb[] = trimmedResults.map((result) => ({
        uuid: result.uuid,
        layoutId: result.layoutId,
        setter_username: result.setter_username || '',
        name: result.name || '',
        description: result.description || '',
        frames: result.frames || '',
        framesCount: result.frames_count ?? null,
        framesPace: result.frames_pace ?? null,
        angle,
        ascensionist_count: Number(result.ascensionist_count || 0),
        difficulty: getGradeLabel(result.difficulty_id),
        quality_average: result.quality_average?.toString() || '0',
        stars: getClimbStars(result.quality_average),
        difficulty_error: result.difficulty_error?.toString() || '0',
        benchmark_difficulty:
          result.benchmark_difficulty && result.benchmark_difficulty > 0
            ? result.benchmark_difficulty.toString()
            : null,
        boardType: boardName,
      }));

      return { climbs, totalCount, hasMore };
    } else {
      // === All boards mode ===
      // Get distinct board types for this setter
      const boardTypeResults = await db
        .select({
          boardType: dbSchema.boardClimbs.boardType,
        })
        .from(dbSchema.boardClimbs)
        .where(eq(dbSchema.boardClimbs.setterUsername, username))
        .groupBy(dbSchema.boardClimbs.boardType);

      const setterBoardTypes = boardTypeResults
        .map((row) => row.boardType)
        .filter((boardType): boardType is string => boardType !== null && isValidBoardName(boardType));

      if (setterBoardTypes.length === 0) {
        return { climbs: [], totalCount: 0, hasMore: false };
      }

      // Get total count across all boards
      const [countResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(dbSchema.boardClimbs)
        .where(eq(dbSchema.boardClimbs.setterUsername, username));

      const totalCount = Number(countResult?.count ?? 0);

      // Query climbs across all board types using most popular angle
      const tables = UNIFIED_TABLES;
      const results = await db
        .select({
          uuid: tables.climbs.uuid,
          layoutId: tables.climbs.layoutId,
          boardType: tables.climbs.boardType,
          setter_username: tables.climbs.setterUsername,
          name: tables.climbs.name,
          description: tables.climbs.description,
          frames: tables.climbs.frames,
          frames_count: tables.climbs.framesCount,
          frames_pace: tables.climbs.framesPace,
          statsAngle: tables.climbStats.angle,
          ascensionist_count: tables.climbStats.ascensionistCount,
          difficulty_id: sql<number | null>`ROUND(${tables.climbStats.displayDifficulty}::numeric, 0)`,
          quality_average: sql<number>`ROUND(${tables.climbStats.qualityAverage}::numeric, 2)`,
          difficulty_error: sql<number>`ROUND(${tables.climbStats.difficultyAverage}::numeric - ${tables.climbStats.displayDifficulty}::numeric, 2)`,
          benchmark_difficulty: tables.climbStats.benchmarkDifficulty,
        })
        .from(tables.climbs)
        .leftJoin(
          tables.climbStats,
          and(
            eq(tables.climbStats.boardType, tables.climbs.boardType),
            eq(tables.climbStats.climbUuid, tables.climbs.uuid),
            eq(
              tables.climbStats.angle,
              sql`(
              SELECT s.angle FROM board_climb_stats s
              WHERE s.board_type = ${tables.climbs.boardType}
                AND s.climb_uuid = ${tables.climbs.uuid}
              ORDER BY s.ascensionist_count DESC NULLS LAST
              LIMIT 1
            )`,
            ),
          ),
        )
        .where(eq(tables.climbs.setterUsername, username))
        .orderBy(
          sortBy === 'popular'
            ? sql`COALESCE(${tables.climbStats.ascensionistCount}, 0) DESC`
            : sql`${tables.climbs.createdAt} DESC NULLS LAST`,
        )
        .limit(limit + 1)
        .offset(offset);

      const hasMore = results.length > limit;
      const trimmedResults = hasMore ? results.slice(0, limit) : results;

      const climbs: Climb[] = trimmedResults.map((result) => {
        const boardName = (result.boardType || 'kilter') as BoardName;
        return {
          uuid: result.uuid,
          layoutId: result.layoutId,
          setter_username: result.setter_username || '',
          name: result.name || '',
          description: result.description || '',
          frames: result.frames || '',
          framesCount: result.frames_count ?? null,
          framesPace: result.frames_pace ?? null,
          angle: result.statsAngle ?? DEFAULT_ANGLE,
          ascensionist_count: Number(result.ascensionist_count || 0),
          difficulty: getGradeLabel(result.difficulty_id),
          quality_average: result.quality_average?.toString() || '0',
          stars: getClimbStars(result.quality_average),
          difficulty_error: result.difficulty_error?.toString() || '0',
          benchmark_difficulty:
            result.benchmark_difficulty && result.benchmark_difficulty > 0
              ? result.benchmark_difficulty.toString()
              : null,
          boardType: boardName,
        };
      });

      return { climbs, totalCount, hasMore };
    }
  },

  /**
   * Get all non-draft climbs created by a user.
   * Includes both directly created climbs and Aurora-imported climbs linked via board credentials.
   */
  userClimbs: async (
    _: unknown,
    { input }: { input: { userId: string; sortBy?: string; limit?: number; offset?: number } },
    _ctx: ConnectionContext,
  ): Promise<{ climbs: Climb[]; totalCount: number; hasMore: boolean }> => {
    const validatedInput = validateInput(UserClimbsInputSchema, input, 'input');
    const { userId, sortBy, limit, offset } = validatedInput;

    // 1. Look up linked Aurora usernames
    const mappings = await db
      .select({
        boardType: dbSchema.userBoardMappings.boardType,
        boardUsername: dbSchema.userBoardMappings.boardUsername,
      })
      .from(dbSchema.userBoardMappings)
      .where(eq(dbSchema.userBoardMappings.userId, userId));

    const linkedMappings = mappings.filter(
      (mapping): mapping is { boardType: string; boardUsername: string } =>
        mapping.boardUsername !== null && mapping.boardUsername.length > 0,
    );

    // 2. Build WHERE condition: userId match OR (boardType + setterUsername) in linked mappings, AND not draft
    const tables = UNIFIED_TABLES;
    const linkedOwnershipCondition =
      linkedMappings.length > 0
        ? sql.join(
            linkedMappings.map(
              ({ boardType, boardUsername }) =>
                sql`(${tables.climbs.boardType} = ${boardType} AND ${tables.climbs.setterUsername} = ${boardUsername})`,
            ),
            sql` OR `,
          )
        : null;

    const ownershipCondition = linkedOwnershipCondition
      ? sql`(${tables.climbs.userId} = ${userId} OR ${linkedOwnershipCondition})`
      : eq(tables.climbs.userId, userId);

    const whereCondition = and(ownershipCondition, eq(tables.climbs.isDraft, false));

    // 3. Get total count
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tables.climbs)
      .where(whereCondition);

    const totalCount = Number(countResult?.count ?? 0);

    // 4. Get climbs with stats at the most popular angle, but only compute stats for owned climbs.
    const ownershipSql =
      linkedMappings.length > 0
        ? sql`(c.user_id = ${userId} OR ${sql.join(
            linkedMappings.map(
              ({ boardType, boardUsername }) =>
                sql`(c.board_type = ${boardType} AND c.setter_username = ${boardUsername})`,
            ),
            sql` OR `,
          )})`
        : sql`c.user_id = ${userId}`;

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
      stats_angle: number | null;
      ascensionist_count: number | null;
      difficulty_id: number | null;
      quality_average: number | null;
      difficulty_error: number | null;
      benchmark_difficulty: number | null;
    };

    const rawRows = await executeRows<RawRow>(
      db,
      sql`
      WITH owned_climbs AS (
        SELECT
          c.uuid,
          c.layout_id,
          c.board_type,
          c.setter_username,
          c.name,
          c.description,
          c.frames,
          c.frames_count,
          c.frames_pace,
          c.created_at
        FROM board_climbs c
        WHERE ${ownershipSql} AND c.is_draft = false
      ),
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
        best.angle AS stats_angle,
        best.ascensionist_count,
        ROUND(best.display_difficulty::numeric, 0)::int AS difficulty_id,
        ROUND(best.quality_average::numeric, 2) AS quality_average,
        ROUND(best.difficulty_average::numeric - best.display_difficulty::numeric, 2) AS difficulty_error,
        best.benchmark_difficulty
      FROM owned_climbs
      LEFT JOIN best_angle best
        ON best.board_type = owned_climbs.board_type
       AND best.climb_uuid = owned_climbs.uuid
      ORDER BY ${orderSql}, owned_climbs.uuid DESC
      LIMIT ${limit + 1}
      OFFSET ${offset}
    `,
    );

    const hasMore = rawRows.length > limit;
    const trimmedResults = hasMore ? rawRows.slice(0, limit) : rawRows;

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
        angle: result.stats_angle ?? DEFAULT_ANGLE,
        ascensionist_count: Number(result.ascensionist_count || 0),
        difficulty: getGradeLabel(result.difficulty_id),
        quality_average: result.quality_average?.toString() || '0',
        stars: getClimbStars(result.quality_average),
        difficulty_error: result.difficulty_error?.toString() || '0',
        benchmark_difficulty:
          result.benchmark_difficulty && result.benchmark_difficulty > 0
            ? result.benchmark_difficulty.toString()
            : null,
        boardType: boardName,
      };
    });

    return { climbs, totalCount, hasMore };
  },

  /**
   * Unified search for users and setters
   */
  searchUsersAndSetters: async (
    _: unknown,
    { input }: { input: { query: string; boardType?: string; limit?: number; offset?: number } },
    ctx: ConnectionContext,
  ) => {
    await applyRateLimit(ctx, 20, 'searchUsersAndSetters');

    const validatedInput = validateInput(SearchUsersInputSchema, input, 'input');
    const query = validatedInput.query;
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;

    const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
    const searchPattern = `%${escapedQuery}%`;
    const prefixPattern = `${escapedQuery}%`;

    // 1. Search Boardsesh users (same as existing searchUsers)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoIso = thirtyDaysAgo.toISOString();

    const userResults = await db
      .select({
        id: dbSchema.users.id,
        name: dbSchema.users.name,
        image: dbSchema.users.image,
        displayName: dbSchema.userProfiles.displayName,
        avatarUrl: dbSchema.userProfiles.avatarUrl,
        followerCount: sql<number>`(select count(*)::int from user_follows where following_id = ${dbSchema.users.id})`,
        followingCount: sql<number>`(select count(*)::int from user_follows where follower_id = ${dbSchema.users.id})`,
        recentAscentCount: sql<number>`(select count(*)::int from boardsesh_ticks where user_id = ${dbSchema.users.id} and created_at > ${thirtyDaysAgoIso})`,
        isFollowedByMe:
          ctx.isAuthenticated && ctx.userId
            ? sql<boolean>`exists(select 1 from user_follows where follower_id = ${ctx.userId} and following_id = ${dbSchema.users.id})`
            : sql<boolean>`false`,
      })
      .from(dbSchema.users)
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
      .where(
        sql`(${dbSchema.userProfiles.displayName} ILIKE ${searchPattern} OR ${dbSchema.users.name} ILIKE ${searchPattern})`,
      )
      .orderBy(
        sql`case when ${dbSchema.userProfiles.displayName} ilike ${prefixPattern} or ${dbSchema.users.name} ilike ${prefixPattern} then 0 else 1 end`,
        sql`(select count(*)::int from boardsesh_ticks where user_id = ${dbSchema.users.id} and created_at > ${thirtyDaysAgoIso}) DESC`,
      )
      .limit(limit + offset);

    // 2. Search setters from board_climbs
    const setterResults = await db
      .select({
        setterUsername: dbSchema.boardClimbs.setterUsername,
        boardTypes: sql<string[]>`array_agg(DISTINCT ${dbSchema.boardClimbs.boardType})`,
        climbCount: sql<number>`count(DISTINCT ${dbSchema.boardClimbs.uuid})::int`,
      })
      .from(dbSchema.boardClimbs)
      .where(
        and(
          ilike(dbSchema.boardClimbs.setterUsername, searchPattern),
          sql`${dbSchema.boardClimbs.setterUsername} IS NOT NULL`,
        ),
      )
      .groupBy(dbSchema.boardClimbs.setterUsername)
      .orderBy(sql`count(DISTINCT ${dbSchema.boardClimbs.uuid}) DESC`)
      .limit(limit + offset);

    // 3. Get linked usernames to de-duplicate
    const linkedUsernames = new Set<string>();
    if (userResults.length > 0) {
      const userIds = userResults.map((r) => r.id);
      const mappings = await db
        .select({
          userId: dbSchema.userBoardMappings.userId,
          boardUsername: dbSchema.userBoardMappings.boardUsername,
        })
        .from(dbSchema.userBoardMappings)
        .where(inArray(dbSchema.userBoardMappings.userId, userIds));

      for (const m of mappings) {
        if (m.boardUsername) {
          linkedUsernames.add(m.boardUsername);
        }
      }
    }

    // 4. Check isFollowedByMe for setter results
    let setterFollowedSet = new Set<string>();
    if (ctx.isAuthenticated && ctx.userId && setterResults.length > 0) {
      const setterUsernames = setterResults.map((r) => r.setterUsername).filter((u): u is string => u !== null);
      if (setterUsernames.length > 0) {
        const followedSetters = await db
          .select({ setterUsername: dbSchema.setterFollows.setterUsername })
          .from(dbSchema.setterFollows)
          .where(
            and(
              eq(dbSchema.setterFollows.followerId, ctx.userId),
              inArray(dbSchema.setterFollows.setterUsername, setterUsernames),
            ),
          );
        setterFollowedSet = new Set(followedSetters.map((f) => f.setterUsername));
      }
    }

    // 5. Build unified results
    const results: Array<{
      user?: {
        id: string;
        displayName?: string;
        avatarUrl?: string;
        followerCount: number;
        followingCount: number;
        isFollowedByMe: boolean;
      };
      setter?: {
        username: string;
        climbCount: number;
        boardTypes: string[];
        isFollowedByMe: boolean;
      };
      recentAscentCount: number;
      matchReason?: string;
    }> = [];

    // Add user results
    for (const row of userResults) {
      results.push({
        user: {
          id: row.id,
          displayName: row.displayName || row.name || undefined,
          avatarUrl: row.avatarUrl || row.image || undefined,
          followerCount: Number(row.followerCount ?? 0),
          followingCount: Number(row.followingCount ?? 0),
          isFollowedByMe: Boolean(row.isFollowedByMe),
        },
        recentAscentCount: Number(row.recentAscentCount ?? 0),
        matchReason: 'name match',
      });
    }

    // Add setter results (de-duplicated)
    for (const row of setterResults) {
      if (!row.setterUsername || linkedUsernames.has(row.setterUsername)) {
        continue;
      }
      results.push({
        setter: {
          username: row.setterUsername,
          climbCount: Number(row.climbCount),
          boardTypes: row.boardTypes || [],
          isFollowedByMe: setterFollowedSet.has(row.setterUsername),
        },
        recentAscentCount: 0,
        matchReason: 'setter match',
      });
    }

    // Sort: users first (by ascent count), then setters (by climb count)
    results.sort((a, b) => {
      if (a.user && !b.user) return -1;
      if (!a.user && b.user) return 1;
      if (a.user && b.user) return b.recentAscentCount - a.recentAscentCount;
      if (a.setter && b.setter) return b.setter.climbCount - a.setter.climbCount;
      return 0;
    });

    const paginatedResults = results.slice(offset, offset + limit);

    return {
      results: paginatedResults,
      totalCount: results.length,
      hasMore: offset + paginatedResults.length < results.length,
    };
  },
};

export const setterFollowMutations = {
  /**
   * Follow a setter (idempotent)
   */
  followSetter: async (
    _: unknown,
    { input }: { input: { setterUsername: string } },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 30, 'followSetter');

    const validatedInput = validateInput(FollowSetterInputSchema, input, 'input');
    const myUserId = ctx.userId!;
    const setterUsername = validatedInput.setterUsername;

    // Verify setter exists in board_climbs
    const [exists] = await db
      .select({ count: count() })
      .from(dbSchema.boardClimbs)
      .where(eq(dbSchema.boardClimbs.setterUsername, setterUsername))
      .limit(1);

    if (Number(exists?.count ?? 0) === 0) {
      throw new Error('Setter not found');
    }

    // Insert setter follow
    const result = await db
      .insert(dbSchema.setterFollows)
      .values({
        followerId: myUserId,
        setterUsername,
      })
      .onConflictDoNothing()
      .returning();

    // Check if setter has a linked Boardsesh account
    if (result.length > 0) {
      const linkedUsers = await db
        .select({ userId: dbSchema.userBoardMappings.userId })
        .from(dbSchema.userBoardMappings)
        .where(eq(dbSchema.userBoardMappings.boardUsername, setterUsername))
        .limit(1);

      if (linkedUsers.length > 0 && linkedUsers[0].userId !== myUserId) {
        // Also create user_follows entry
        await db
          .insert(dbSchema.userFollows)
          .values({
            followerId: myUserId,
            followingId: linkedUsers[0].userId,
          })
          .onConflictDoNothing();
      }

      publishSocialEvent({
        type: 'follow.created',
        actorId: myUserId,
        entityType: 'user',
        entityId: setterUsername,
        timestamp: Date.now(),
        metadata: { followedSetterUsername: setterUsername },
      }).catch((err) => logger.error('[SetterFollows] Failed to publish social event:', err));
    }

    return true;
  },

  /**
   * Unfollow a setter
   */
  unfollowSetter: async (
    _: unknown,
    { input }: { input: { setterUsername: string } },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 30, 'unfollowSetter');

    const validatedInput = validateInput(FollowSetterInputSchema, input, 'input');
    const myUserId = ctx.userId!;
    const setterUsername = validatedInput.setterUsername;

    await db
      .delete(dbSchema.setterFollows)
      .where(
        and(eq(dbSchema.setterFollows.followerId, myUserId), eq(dbSchema.setterFollows.setterUsername, setterUsername)),
      );

    // Also remove user_follows if linked
    const linkedUsers = await db
      .select({ userId: dbSchema.userBoardMappings.userId })
      .from(dbSchema.userBoardMappings)
      .where(eq(dbSchema.userBoardMappings.boardUsername, setterUsername))
      .limit(1);

    if (linkedUsers.length > 0) {
      await db
        .delete(dbSchema.userFollows)
        .where(
          and(
            eq(dbSchema.userFollows.followerId, myUserId),
            eq(dbSchema.userFollows.followingId, linkedUsers[0].userId),
          ),
        );
    }

    return true;
  },
};
