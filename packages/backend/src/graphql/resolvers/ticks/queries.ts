import { eq, and, desc, inArray, sql, count } from 'drizzle-orm';
import type { ConnectionContext, BoardName } from '@boardsesh/shared-schema';
import { SUPPORTED_BOARDS, difficultyToGrade, BOULDER_GRADE_MAP } from '@boardsesh/shared-schema';
import type { GradeFormat } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { GetTicksInputSchema, BoardNameSchema, AscentFeedInputSchema } from '../../../validation/schemas';

// Build a grade sort order from the canonical grade map.
// Font grades use difficultyId directly; V-grades use the first occurrence.
const GRADE_SORT_ORDER = new Map<string, number>();
for (const entry of BOULDER_GRADE_MAP) {
  GRADE_SORT_ORDER.set(entry.fontGrade, entry.difficultyId);
  if (!GRADE_SORT_ORDER.has(entry.vGrade)) {
    GRADE_SORT_ORDER.set(entry.vGrade, entry.difficultyId);
  }
}

/**
 * Merge duplicate grade keys (e.g., two entries for "V5" from 6c and 6c+)
 * and sort by grade difficulty.
 */
function aggregateAndSortGradeCounts(
  counts: Array<{ grade: string; count: number }>,
): Array<{ grade: string; count: number }> {
  const merged = new Map<string, number>();
  for (const gc of counts) {
    merged.set(gc.grade, (merged.get(gc.grade) ?? 0) + gc.count);
  }
  return Array.from(merged.entries())
    .map(([grade, count]) => ({ grade, count }))
    .sort((a, b) => (GRADE_SORT_ORDER.get(a.grade) ?? 0) - (GRADE_SORT_ORDER.get(b.grade) ?? 0));
}

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
    { userId, boardType }: { userId: string; boardType: string }
  ): Promise<unknown[]> => {
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
    { userId, input }: { userId: string; input?: { limit?: number; offset?: number } }
  ): Promise<{
    items: unknown[];
    totalCount: number;
    hasMore: boolean;
  }> => {
    // Validate and set defaults
    const validatedInput = validateInput(AscentFeedInputSchema, input || {}, 'input');
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;

    // Get total count of ticks for this user
    const countResult = await db
      .select({ count: count() })
      .from(dbSchema.boardseshTicks)
      .where(eq(dbSchema.boardseshTicks.userId, userId));

    const totalCount = Number(countResult[0]?.count || 0);

    // Fetch ticks with climb and grade data using JOINs (eliminates N+1 queries)
    const results = await db
      .select({
        tick: dbSchema.boardseshTicks,
        climbName: dbSchema.boardClimbs.name,
        setterUsername: dbSchema.boardClimbs.setterUsername,
        layoutId: dbSchema.boardClimbs.layoutId,
        frames: dbSchema.boardClimbs.frames,
        difficultyName: dbSchema.boardDifficultyGrades.boulderName,
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
      .where(eq(dbSchema.boardseshTicks.userId, userId))
      .orderBy(desc(dbSchema.boardseshTicks.climbedAt))
      .limit(limit)
      .offset(offset);

    // Map results to response format
    const items = results.map(({ tick, climbName, setterUsername, layoutId, frames, difficultyName }) => ({
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
      isBenchmark: tick.isBenchmark,
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
   * Groups multiple attempts on the same climb on the same day into a single entry
   */
  userGroupedAscentsFeed: async (
    _: unknown,
    { userId, input }: { userId: string; input?: { limit?: number; offset?: number } }
  ): Promise<{
    groups: unknown[];
    totalCount: number;
    hasMore: boolean;
  }> => {
    // Validate and set defaults
    const validatedInput = validateInput(AscentFeedInputSchema, input || {}, 'input');
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;

    // Fetch recent ticks with climb and grade data
    // We limit to 500 most recent ticks to prevent memory issues for very active users
    // This provides enough data for typical pagination while keeping memory usage bounded
    const MAX_FETCH_LIMIT = 500;
    const results = await db
      .select({
        tick: dbSchema.boardseshTicks,
        climbName: dbSchema.boardClimbs.name,
        setterUsername: dbSchema.boardClimbs.setterUsername,
        layoutId: dbSchema.boardClimbs.layoutId,
        frames: dbSchema.boardClimbs.frames,
        difficultyName: dbSchema.boardDifficultyGrades.boulderName,
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
      .where(eq(dbSchema.boardseshTicks.userId, userId))
      .orderBy(desc(dbSchema.boardseshTicks.climbedAt))
      .limit(MAX_FETCH_LIMIT);

    // Group items by climbUuid and day
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
      latestClimbedAt: string;
    };

    const groupMap = new Map<string, GroupedAscent>();

    for (const { tick, climbName, setterUsername, layoutId, frames, difficultyName } of results) {
      // Extract date from climbedAt (YYYY-MM-DD)
      const date = tick.climbedAt.split('T')[0];
      const key = `${tick.climbUuid}-${date}`;

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

      if (!groupMap.has(key)) {
        groupMap.set(key, {
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
          date,
          items: [],
          flashCount: 0,
          sendCount: 0,
          attemptCount: 0,
          bestQuality: null,
          latestComment: null,
          latestClimbedAt: tick.climbedAt,
        });
      }

      const group = groupMap.get(key)!;
      group.items.push(item);

      // Update counts
      if (tick.status === 'flash') {
        group.flashCount++;
      } else if (tick.status === 'send') {
        group.sendCount++;
      } else {
        group.attemptCount++;
      }

      // Track best quality rating
      if (tick.quality !== null) {
        if (group.bestQuality === null || tick.quality > group.bestQuality) {
          group.bestQuality = tick.quality;
        }
      }

      // Track latest comment (prefer non-empty)
      if (tick.comment && !group.latestComment) {
        group.latestComment = tick.comment;
      }

      // Track latest climbedAt for sorting
      if (tick.climbedAt > group.latestClimbedAt) {
        group.latestClimbedAt = tick.climbedAt;
      }
    }

    // Convert to array and sort by latest activity
    const allGroups = Array.from(groupMap.values()).sort(
      (a, b) => new Date(b.latestClimbedAt).getTime() - new Date(a.latestClimbedAt).getTime()
    );

    const totalCount = allGroups.length;

    // Apply pagination to groups
    const paginatedGroups = allGroups.slice(offset, offset + limit);

    // Remove latestClimbedAt from final output (internal use only)
    const groups = paginatedGroups.map(({ latestClimbedAt, ...rest }) => rest);

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
    { userId, gradeFormat }: { userId: string; gradeFormat?: GradeFormat }
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
          const format = gradeFormat ?? 'V_GRADE';
          const grade = difficultyToGrade(Number(row.difficulty), format) ?? String(row.difficulty);
          layoutStatsMap[layoutKey].gradeCounts.push({
            grade,
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
        gradeCounts: aggregateAndSortGradeCounts(stats.gradeCounts),
      };
    });

    return {
      totalDistinctClimbs: allClimbUuids.size,
      layoutStats,
    };
  },
};
