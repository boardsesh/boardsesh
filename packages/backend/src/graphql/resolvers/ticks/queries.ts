import { eq, and, desc, asc, inArray, sql, count, ilike, gte, lte } from 'drizzle-orm';
import type { ConnectionContext, BoardName } from '@boardsesh/shared-schema';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { canViewUser } from '../social/helpers';
import { GetTicksInputSchema, BoardNameSchema, AscentFeedInputSchema } from '../../../validation/schemas';

export const tickQueries = {
  /**
   * Get ticks for the authenticated user with optional filtering by climb UUIDs
   */
  ticks: async (
    _: unknown,
    { input }: { input: { boardType: string; climbUuids?: string[] } },
    ctx: ConnectionContext
  ): Promise<unknown[]> => {
    requireAuthenticated(ctx);
    validateInput(GetTicksInputSchema, input, 'input');

    const userId = ctx.userId!;

    // Build query conditions
    const conditions = [
      eq(dbSchema.boardseshTicks.userId, userId),
      eq(dbSchema.boardseshTicks.boardType, input.boardType),
    ];

    if (input.climbUuids && input.climbUuids.length > 0) {
      conditions.push(inArray(dbSchema.boardseshTicks.climbUuid, input.climbUuids));
    }

    // Fetch ticks with layoutId from unified board_climbs table
    const results = await db
      .select({
        tick: dbSchema.boardseshTicks,
        layoutId: dbSchema.boardClimbs.layoutId,
      })
      .from(dbSchema.boardseshTicks)
      .leftJoin(
        dbSchema.boardClimbs,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbs.uuid),
          eq(dbSchema.boardClimbs.boardType, input.boardType)
        )
      )
      .where(and(...conditions))
      .orderBy(desc(dbSchema.boardseshTicks.climbedAt));

    return results.map(({ tick, layoutId }) => ({
      uuid: tick.uuid,
      userId: tick.userId,
      boardType: tick.boardType,
      climbUuid: tick.climbUuid,
      angle: tick.angle,
      isMirror: tick.isMirror,
      status: tick.status,
      attemptCount: tick.attemptCount,
      quality: tick.quality,
      difficulty: tick.difficulty,
      isBenchmark: tick.isBenchmark,
      comment: tick.comment,
      climbedAt: tick.climbedAt,
      createdAt: tick.createdAt,
      updatedAt: tick.updatedAt,
      sessionId: tick.sessionId,
      auroraType: tick.auroraType,
      auroraId: tick.auroraId,
      auroraSyncedAt: tick.auroraSyncedAt,
      layoutId,
    }));
  },

  /**
   * Get ticks for a specific user (public query, no authentication required)
   */
  userTicks: async (
    _: unknown,
    { userId, boardType }: { userId: string; boardType: string },
    ctx: ConnectionContext
  ): Promise<unknown[]> => {
    const canView = await canViewUser(ctx.isAuthenticated ? ctx.userId : undefined, userId);
    if (!canView) return [];

    validateInput(BoardNameSchema, boardType, 'boardType');

    const conditions = [
      eq(dbSchema.boardseshTicks.userId, userId),
      eq(dbSchema.boardseshTicks.boardType, boardType),
    ];

    // Fetch ticks with layoutId from unified board_climbs table
    const results = await db
      .select({
        tick: dbSchema.boardseshTicks,
        layoutId: dbSchema.boardClimbs.layoutId,
      })
      .from(dbSchema.boardseshTicks)
      .leftJoin(
        dbSchema.boardClimbs,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbs.uuid),
          eq(dbSchema.boardClimbs.boardType, boardType)
        )
      )
      .where(and(...conditions))
      .orderBy(desc(dbSchema.boardseshTicks.climbedAt));

    return results.map(({ tick, layoutId }) => ({
      uuid: tick.uuid,
      userId: tick.userId,
      boardType: tick.boardType,
      climbUuid: tick.climbUuid,
      angle: tick.angle,
      isMirror: tick.isMirror,
      status: tick.status,
      attemptCount: tick.attemptCount,
      quality: tick.quality,
      difficulty: tick.difficulty,
      isBenchmark: tick.isBenchmark,
      comment: tick.comment,
      climbedAt: tick.climbedAt,
      createdAt: tick.createdAt,
      updatedAt: tick.updatedAt,
      sessionId: tick.sessionId,
      auroraType: tick.auroraType,
      auroraId: tick.auroraId,
      auroraSyncedAt: tick.auroraSyncedAt,
      layoutId,
    }));
  },

  /**
   * Get ascent activity feed for a specific user (public query)
   * Returns ticks with enriched climb data for display in a feed
   */
  userAscentsFeed: async (
    _: unknown,
    {
      userId,
      input,
    }: {
      userId: string;
      input?: {
        limit?: number;
        offset?: number;
        boardType?: string;
        layoutIds?: number[];
        status?: string;
        statusMode?: string;
        flashOnly?: boolean;
        climbName?: string;
        sortBy?: string;
        sortOrder?: string;
        secondarySortBy?: string;
        secondarySortOrder?: string;
        minDifficulty?: number;
        maxDifficulty?: number;
        minAngle?: number;
        maxAngle?: number;
        benchmarkOnly?: boolean;
        fromDate?: string;
        toDate?: string;
      };
    },
    ctx: ConnectionContext
  ): Promise<{
    items: unknown[];
    totalCount: number;
    hasMore: boolean;
  }> => {
    const canView = await canViewUser(ctx.isAuthenticated ? ctx.userId : undefined, userId);
    if (!canView) return { items: [], totalCount: 0, hasMore: false };

    // Validate and set defaults
    const validatedInput = validateInput(AscentFeedInputSchema, input || {}, 'input');
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;
    const boardType = validatedInput.boardType;
    const layoutIds = validatedInput.layoutIds;
    const climbName = validatedInput.climbName;
    const sortBy = validatedInput.sortBy ?? 'recent';
    const sortOrder = validatedInput.sortOrder ?? 'desc';
    const secondarySortBy = validatedInput.secondarySortBy;
    const secondarySortOrder = validatedInput.secondarySortOrder ?? 'desc';
    const minDifficulty = validatedInput.minDifficulty;
    const maxDifficulty = validatedInput.maxDifficulty;
    const minAngle = validatedInput.minAngle;
    const maxAngle = validatedInput.maxAngle;
    const benchmarkOnly = validatedInput.benchmarkOnly ?? false;
    const fromDate = validatedInput.fromDate;
    const toDate = validatedInput.toDate;
    const legacyStatus = validatedInput.status;
    const statusMode = validatedInput.statusMode ?? (legacyStatus === 'attempt' ? 'attempt' : legacyStatus ? 'send' : 'both');
    const flashOnly = validatedInput.flashOnly ?? (legacyStatus === 'flash');

    const consensusDifficultyExpr = sql<number | null>`ROUND(${dbSchema.boardClimbStats.displayDifficulty})`;
    const consensusDifficultyNameExpr = sql<string | null>`(
      SELECT bdg.boulder_name
      FROM board_difficulty_grades bdg
      WHERE bdg.board_type = ${dbSchema.boardseshTicks.boardType}
        AND bdg.difficulty = ROUND(${dbSchema.boardClimbStats.displayDifficulty})
      LIMIT 1
    )`;
    const resolvedBenchmarkExpr = sql<boolean>`CASE
      WHEN COALESCE(${dbSchema.boardClimbStats.benchmarkDifficulty}, 0) > 0 OR ${dbSchema.boardseshTicks.isBenchmark} = true THEN true
      ELSE false
    END`;

    // Build shared WHERE conditions
    const tickConditions = [
      eq(dbSchema.boardseshTicks.userId, userId),
      ...(boardType ? [eq(dbSchema.boardseshTicks.boardType, boardType)] : []),
      ...(minDifficulty !== undefined ? [gte(dbSchema.boardseshTicks.difficulty, minDifficulty)] : []),
      ...(maxDifficulty !== undefined ? [lte(dbSchema.boardseshTicks.difficulty, maxDifficulty)] : []),
      ...(minAngle !== undefined ? [gte(dbSchema.boardseshTicks.angle, minAngle)] : []),
      ...(maxAngle !== undefined ? [lte(dbSchema.boardseshTicks.angle, maxAngle)] : []),
      ...(fromDate ? [gte(dbSchema.boardseshTicks.climbedAt, fromDate)] : []),
      ...(toDate ? [lte(dbSchema.boardseshTicks.climbedAt, toDate + 'T23:59:59.999Z')] : []),
    ];

    if (statusMode === 'attempt') {
      tickConditions.push(eq(dbSchema.boardseshTicks.status, 'attempt'));
    } else if (statusMode === 'send') {
      tickConditions.push(
        flashOnly
          ? eq(dbSchema.boardseshTicks.status, 'flash')
          : inArray(dbSchema.boardseshTicks.status, ['flash', 'send'])
      );
    } else if (flashOnly) {
      tickConditions.push(eq(dbSchema.boardseshTicks.status, 'flash'));
    }

    if (benchmarkOnly) {
      tickConditions.push(sql`(${resolvedBenchmarkExpr}) = true`);
    }

    // Base query with JOINs (shared by count and data queries)
    const baseQuery = db
      .select({
        tick: dbSchema.boardseshTicks,
        climbName: dbSchema.boardClimbs.name,
        setterUsername: dbSchema.boardClimbs.setterUsername,
        layoutId: dbSchema.boardClimbs.layoutId,
        frames: dbSchema.boardClimbs.frames,
        difficultyName: dbSchema.boardDifficultyGrades.boulderName,
        consensusDifficulty: consensusDifficultyExpr,
        consensusDifficultyName: consensusDifficultyNameExpr,
        resolvedIsBenchmark: resolvedBenchmarkExpr,
      })
      .from(dbSchema.boardseshTicks)
      .leftJoin(
        dbSchema.boardClimbs,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbs.uuid),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbs.boardType)
        )
      )
      .leftJoin(
        dbSchema.boardClimbStats,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbStats.climbUuid),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbStats.boardType),
          eq(dbSchema.boardseshTicks.angle, dbSchema.boardClimbStats.angle)
        )
      )
      .leftJoin(
        dbSchema.boardDifficultyGrades,
        and(
          eq(dbSchema.boardseshTicks.difficulty, dbSchema.boardDifficultyGrades.difficulty),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardDifficultyGrades.boardType)
        )
      );

    // Escape LIKE wildcards so user input is treated as a literal substring,
    // not a SQL pattern (e.g. typing "100%" should match the literal string).
    const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

    // Full conditions including climb name filter (requires JOIN)
    const allConditions = [
      ...tickConditions,
      ...(layoutIds && layoutIds.length > 0 ? [inArray(dbSchema.boardClimbs.layoutId, layoutIds)] : []),
      ...(climbName ? [ilike(dbSchema.boardClimbs.name, `%${escapeLikePattern(climbName)}%`)] : []),
    ];

    // Get total count
    const countQuery = db
      .select({ count: count() })
      .from(dbSchema.boardseshTicks)
      .leftJoin(
        dbSchema.boardClimbs,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbs.uuid),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbs.boardType)
        )
      )
      .leftJoin(
        dbSchema.boardClimbStats,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbStats.climbUuid),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbStats.boardType),
          eq(dbSchema.boardseshTicks.angle, dbSchema.boardClimbStats.angle)
        )
      )
      .where(and(...allConditions));

    const countResult = await countQuery;
    const totalCount = Number(countResult[0]?.count || 0);

    const buildOrderClause = (field: string, direction: string) => {
      const dir = direction === 'asc' ? 'asc' : 'desc';
      switch (field) {
        case 'climbName':
          return sql`${dbSchema.boardClimbs.name} ${sql.raw(dir)} nulls last`;
        case 'loggedGrade':
        case 'easiest':
        case 'hardest':
          return sql`${dbSchema.boardseshTicks.difficulty} ${sql.raw(dir)} nulls last`;
        case 'consensusGrade':
          return sql`${consensusDifficultyExpr} ${sql.raw(dir)} nulls last`;
        case 'attemptCount':
        case 'mostAttempts':
          return sql`${dbSchema.boardseshTicks.attemptCount} ${sql.raw(dir)} nulls last`;
        case 'date':
        case 'recent':
        default:
          return sql`${dbSchema.boardseshTicks.climbedAt} ${sql.raw(dir)} nulls last`;
      }
    };

    const resolvedPrimarySort =
      sortBy === 'recent'
        ? { field: 'date', direction: sortOrder }
        : sortBy === 'hardest'
          ? { field: 'consensusGrade', direction: 'desc' }
          : sortBy === 'easiest'
            ? { field: 'loggedGrade', direction: 'asc' }
            : sortBy === 'mostAttempts'
              ? { field: 'attemptCount', direction: 'desc' }
              : { field: sortBy, direction: sortOrder };

    const resolvedSecondarySort =
      sortBy === 'hardest'
        ? { field: 'loggedGrade', direction: 'desc' }
        : secondarySortBy
          ? { field: secondarySortBy, direction: secondarySortOrder }
          : null;

    const orderClauses = [
      buildOrderClause(resolvedPrimarySort.field, resolvedPrimarySort.direction),
      ...(resolvedSecondarySort ? [buildOrderClause(resolvedSecondarySort.field, resolvedSecondarySort.direction)] : []),
      desc(dbSchema.boardseshTicks.climbedAt),
      desc(dbSchema.boardseshTicks.uuid),
    ];

    // Fetch paginated results
    const results = await baseQuery
      .where(and(...allConditions))
      .orderBy(...orderClauses)
      .limit(limit)
      .offset(offset);

    // Map results to response format
    const items = results.map(({ tick, climbName, setterUsername, layoutId, frames, difficultyName, consensusDifficulty, consensusDifficultyName, resolvedIsBenchmark }) => ({
      uuid: tick.uuid,
      climbUuid: tick.climbUuid,
      climbName: climbName || 'Unknown Climb',
      setterUsername,
      boardType: tick.boardType,
      layoutId,
      angle: tick.angle,
      isMirror: tick.isMirror,
      status: tick.status,
      attemptCount: tick.attemptCount,
      quality: tick.quality,
      difficulty: tick.difficulty,
      difficultyName,
      consensusDifficulty: consensusDifficulty !== null && consensusDifficulty !== undefined ? Number(consensusDifficulty) : null,
      consensusDifficultyName,
      isBenchmark: Boolean(resolvedIsBenchmark),
      comment: tick.comment || '',
      climbedAt: tick.climbedAt,
      frames,
    }));

    return {
      items,
      totalCount,
      hasMore: offset + items.length < totalCount,
    };
  },

  /**
   * Get ascent activity feed grouped by climb and day (public query)
   * Groups multiple attempts on the same climb on the same day into a single entry.
   *
   * Pagination is applied to (climbUuid, day) groups directly in SQL so the
   * resolver returns the correct totalCount and never silently truncates a
   * user's history.
   */
  userGroupedAscentsFeed: async (
    _: unknown,
    { userId, input }: { userId: string; input?: { limit?: number; offset?: number } },
    ctx: ConnectionContext
  ): Promise<{
    groups: unknown[];
    totalCount: number;
    hasMore: boolean;
  }> => {
    const canView = await canViewUser(ctx.isAuthenticated ? ctx.userId : undefined, userId);
    if (!canView) return { groups: [], totalCount: 0, hasMore: false };

    // Validate and set defaults
    const validatedInput = validateInput(AscentFeedInputSchema, input || {}, 'input');
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;

    // boardsesh_ticks.climbed_at is `timestamp without time zone` storing the
    // climber's wall-clock time at the moment of the tick (the rest of the
    // codebase reads it back via `dayjs(...).utc(true)` to preserve that wall
    // clock — see ascents-feed.tsx). Group by the literal stored date so a
    // session ending at 11pm local doesn't bleed into the next day.
    const dayExpr = sql<string>`to_char(${dbSchema.boardseshTicks.climbedAt}, 'YYYY-MM-DD')`;

    // 1) Page of (climbUuid, day) keys, ordered by latest activity in that group.
    //    Bounds the SQL fetch to exactly the groups we'll return.
    const pageGroups = await db
      .select({
        climbUuid: dbSchema.boardseshTicks.climbUuid,
        day: dayExpr.as('day'),
        latestClimbedAt: sql<string>`max(${dbSchema.boardseshTicks.climbedAt})`.as('latest_climbed_at'),
      })
      .from(dbSchema.boardseshTicks)
      .where(eq(dbSchema.boardseshTicks.userId, userId))
      .groupBy(dbSchema.boardseshTicks.climbUuid, dayExpr)
      .orderBy(sql`max(${dbSchema.boardseshTicks.climbedAt}) desc`)
      .limit(limit)
      .offset(offset);

    // 2) True total group count — runs in parallel with the data fetch below.
    const totalCountPromise = db
      .select({ count: count() })
      .from(
        db
          .select({
            climbUuid: dbSchema.boardseshTicks.climbUuid,
            day: dayExpr.as('day'),
          })
          .from(dbSchema.boardseshTicks)
          .where(eq(dbSchema.boardseshTicks.userId, userId))
          .groupBy(dbSchema.boardseshTicks.climbUuid, dayExpr)
          .as('group_keys'),
      );

    if (pageGroups.length === 0) {
      const totalCountResult = await totalCountPromise;
      const totalCount = Number(totalCountResult[0]?.count ?? 0);
      return { groups: [], totalCount, hasMore: false };
    }

    // 3) Fetch every tick belonging to this page of groups in a single query.
    //    We narrow by climbUuid + a date window first, then refilter by the
    //    exact (climbUuid, day) tuples in JS — Drizzle has no clean tuple-IN
    //    helper, and pages are small (≤ limit groups) so the over-fetch is
    //    bounded.
    const climbUuidsInPage = Array.from(new Set(pageGroups.map((g) => g.climbUuid)));
    const daysInPage = pageGroups.map((g) => g.day).sort();
    const minDay = daysInPage[0];
    const maxDay = daysInPage[daysInPage.length - 1];
    const pageKeySet = new Set(pageGroups.map((g) => `${g.climbUuid}-${g.day}`));

    const tickRows = await db
      .select({
        tick: dbSchema.boardseshTicks,
        climbName: dbSchema.boardClimbs.name,
        setterUsername: dbSchema.boardClimbs.setterUsername,
        layoutId: dbSchema.boardClimbs.layoutId,
        frames: dbSchema.boardClimbs.frames,
        difficultyName: dbSchema.boardDifficultyGrades.boulderName,
        day: dayExpr.as('day'),
      })
      .from(dbSchema.boardseshTicks)
      .leftJoin(
        dbSchema.boardClimbs,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbs.uuid),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbs.boardType)
        )
      )
      .leftJoin(
        dbSchema.boardDifficultyGrades,
        and(
          eq(dbSchema.boardseshTicks.difficulty, dbSchema.boardDifficultyGrades.difficulty),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardDifficultyGrades.boardType)
        )
      )
      .where(
        and(
          eq(dbSchema.boardseshTicks.userId, userId),
          inArray(dbSchema.boardseshTicks.climbUuid, climbUuidsInPage),
          gte(dayExpr, minDay),
          lte(dayExpr, maxDay),
        )
      )
      .orderBy(desc(dbSchema.boardseshTicks.climbedAt));

    type AscentItem = {
      uuid: string;
      climbUuid: string;
      climbName: string;
      setterUsername: string | null;
      boardType: string;
      layoutId: number | null;
      angle: number;
      isMirror: boolean;
      status: string;
      attemptCount: number;
      quality: number | null;
      difficulty: number | null;
      difficultyName: string | null;
      isBenchmark: boolean;
      comment: string;
      climbedAt: string;
      frames: string | null;
    };

    type GroupedAscent = {
      key: string;
      climbUuid: string;
      climbName: string;
      setterUsername: string | null;
      boardType: string;
      layoutId: number | null;
      angle: number;
      isMirror: boolean;
      frames: string | null;
      difficultyName: string | null;
      isBenchmark: boolean;
      date: string;
      items: AscentItem[];
      flashCount: number;
      sendCount: number;
      attemptCount: number;
      bestQuality: number | null;
      latestComment: string | null;
    };

    const groupMap = new Map<string, GroupedAscent>();

    for (const { tick, climbName, setterUsername, layoutId, frames, difficultyName, day } of tickRows) {
      const key = `${tick.climbUuid}-${day}`;
      // Skip ticks that fell inside the date window but belong to a different group.
      if (!pageKeySet.has(key)) continue;

      const item: AscentItem = {
        uuid: tick.uuid,
        climbUuid: tick.climbUuid,
        climbName: climbName || 'Unknown Climb',
        setterUsername,
        boardType: tick.boardType,
        layoutId,
        angle: tick.angle,
        isMirror: tick.isMirror ?? false,
        status: tick.status,
        attemptCount: tick.attemptCount,
        quality: tick.quality,
        difficulty: tick.difficulty,
        difficultyName,
        isBenchmark: tick.isBenchmark ?? false,
        comment: tick.comment || '',
        climbedAt: tick.climbedAt,
        frames,
      };

      let group = groupMap.get(key);
      if (!group) {
        group = {
          key,
          climbUuid: tick.climbUuid,
          climbName: climbName || 'Unknown Climb',
          setterUsername,
          boardType: tick.boardType,
          layoutId,
          angle: tick.angle,
          isMirror: tick.isMirror ?? false,
          frames,
          difficultyName,
          isBenchmark: tick.isBenchmark ?? false,
          date: day,
          items: [],
          flashCount: 0,
          sendCount: 0,
          attemptCount: 0,
          bestQuality: null,
          latestComment: null,
        };
        groupMap.set(key, group);
      }

      group.items.push(item);

      if (tick.status === 'flash') {
        group.flashCount++;
      } else if (tick.status === 'send') {
        group.sendCount++;
      } else {
        group.attemptCount++;
      }

      if (tick.quality !== null) {
        if (group.bestQuality === null || tick.quality > group.bestQuality) {
          group.bestQuality = tick.quality;
        }
      }

      if (tick.comment && !group.latestComment) {
        group.latestComment = tick.comment;
      }
    }

    // Preserve the SQL-decided page ordering (by latest activity).
    const groups = pageGroups
      .map((pg) => groupMap.get(`${pg.climbUuid}-${pg.day}`))
      .filter((g): g is GroupedAscent => g !== undefined);

    const totalCountResult = await totalCountPromise;
    const totalCount = Number(totalCountResult[0]?.count ?? 0);

    return {
      groups,
      totalCount,
      hasMore: offset + groups.length < totalCount,
    };
  },

  /**
   * Get profile statistics with distinct climb counts per grade
   * Groups by board type and layout, counting unique climbs per difficulty grade
   */
  userProfileStats: async (
    _: unknown,
    { userId }: { userId: string },
    ctx: ConnectionContext
  ): Promise<{
    totalDistinctClimbs: number;
    layoutStats: Array<{
      layoutKey: string;
      boardType: string;
      layoutId: number | null;
      distinctClimbCount: number;
      gradeCounts: Array<{ grade: string; count: number }>;
    }>;
  }> => {
    const canView = await canViewUser(ctx.isAuthenticated ? ctx.userId : undefined, userId);
    if (!canView) return { totalDistinctClimbs: 0, layoutStats: [] };

    // Validate userId
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      return { totalDistinctClimbs: 0, layoutStats: [] };
    }

    const boardTypes = SUPPORTED_BOARDS;
    const layoutStatsMap: Record<string, {
      boardType: string;
      layoutId: number | null;
      gradeCounts: Array<{ grade: string; count: number }>;
    }> = {};
    const allClimbUuids = new Set<string>();

    // Helper function to fetch stats for a single board type
    const fetchBoardStats = async (boardType: BoardName) => {
      // Run both queries in parallel for this board type
      const [gradeResults, distinctClimbs] = await Promise.all([
        // Get distinct climb counts grouped by layoutId and difficulty using SQL aggregation
        db
          .select({
            layoutId: dbSchema.boardClimbs.layoutId,
            difficulty: dbSchema.boardseshTicks.difficulty,
            distinctCount: sql<number>`count(distinct ${dbSchema.boardseshTicks.climbUuid})`.as('distinct_count'),
          })
          .from(dbSchema.boardseshTicks)
          .leftJoin(
            dbSchema.boardClimbs,
            and(
              eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbs.uuid),
              eq(dbSchema.boardClimbs.boardType, boardType)
            )
          )
          .where(
            and(
              eq(dbSchema.boardseshTicks.userId, userId),
              eq(dbSchema.boardseshTicks.boardType, boardType),
              sql`${dbSchema.boardseshTicks.status} != 'attempt'`
            )
          )
          .groupBy(dbSchema.boardClimbs.layoutId, dbSchema.boardseshTicks.difficulty),

        // Get all distinct climbUuids for total count
        db
          .selectDistinct({ climbUuid: dbSchema.boardseshTicks.climbUuid })
          .from(dbSchema.boardseshTicks)
          .where(
            and(
              eq(dbSchema.boardseshTicks.userId, userId),
              eq(dbSchema.boardseshTicks.boardType, boardType),
              sql`${dbSchema.boardseshTicks.status} != 'attempt'`
            )
          ),
      ]);

      return { gradeResults, distinctClimbs, boardType };
    };

    // Fetch stats for all board types in parallel
    const boardResults = await Promise.all(boardTypes.map(fetchBoardStats));

    // Process results from all boards
    for (const { gradeResults, distinctClimbs, boardType } of boardResults) {
      // Add to total distinct climbs set
      for (const row of distinctClimbs) {
        allClimbUuids.add(row.climbUuid);
      }

      // Process grade results into layout stats
      for (const row of gradeResults) {
        const layoutKey = `${boardType}-${row.layoutId ?? 'unknown'}`;

        if (!layoutStatsMap[layoutKey]) {
          layoutStatsMap[layoutKey] = {
            boardType,
            layoutId: row.layoutId,
            gradeCounts: [],
          };
        }

        if (row.difficulty !== null) {
          layoutStatsMap[layoutKey].gradeCounts.push({
            grade: String(row.difficulty),
            count: Number(row.distinctCount),
          });
        }
      }
    }

    // Convert to response format with sorted grade counts
    const layoutStats = Object.entries(layoutStatsMap).map(([layoutKey, stats]) => {
      // Calculate total distinct climbs for this layout by summing grade counts
      const distinctClimbCount = stats.gradeCounts.reduce((sum, gc) => sum + gc.count, 0);

      return {
        layoutKey,
        boardType: stats.boardType,
        layoutId: stats.layoutId,
        distinctClimbCount,
        gradeCounts: stats.gradeCounts.sort((a, b) => parseInt(a.grade) - parseInt(b.grade)),
      };
    });

    return {
      totalDistinctClimbs: allClimbUuids.size,
      layoutStats,
    };
  },
};
