import { eq, and, gte, desc } from 'drizzle-orm';
import {
  type CheckMoonBoardClimbDuplicatesInput,
  type ClimbSearchInput,
  type ConnectionContext,
  SUPPORTED_BOARDS,
  USER_SPECIFIC_SEARCH_PARAMS,
} from '@boardsesh/shared-schema';
import {
  type ClimbSearchParams,
  type ParsedBoardRouteParameters,
  getClimbByUuid,
} from '../../../db/queries/climbs/index';
import { isValidBoardName } from '../../../db/queries/util/table-select';
import { applyRateLimit, validateInput } from '../shared/helpers';
import { resolveContextAttribution, trackServer } from '../../../analytics/server-analytics';
import { findMoonBoardDuplicateMatches } from './moonboard-duplicates';
import {
  BoardNameSchema,
  CheckMoonBoardClimbDuplicatesInputSchema,
  ClimbSearchInputSchema,
  ExternalUUIDSchema,
} from '../../../validation/schemas';
import type { ClimbSearchContext } from '../shared/types';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';

// Debug logging flag - only log in development
const DEBUG = process.env.NODE_ENV === 'development';

function countActiveSearchFilters(input: ClimbSearchInput): number {
  // Count anything beyond the implicit board route. Used as a quick "how filtered
  // is this search" signal in PostHog without serializing every filter value.
  let count = 0;
  if (input.minGrade != null) count++;
  if (input.maxGrade != null) count++;
  if (input.minAscents != null) count++;
  if (input.minRating != null) count++;
  if (input.gradeAccuracy != null) count++;
  if (input.name && input.name.length > 0) count++;
  if (input.setter && input.setter.length > 0) count++;
  if (input.holdsFilter) count++;
  if (input.onlyTallClimbs) count++;
  if (input.hideAttempted) count++;
  if (input.hideCompleted) count++;
  if (input.showOnlyAttempted) count++;
  if (input.showOnlyCompleted) count++;
  if (input.zoneBox) count++;
  if (input.projectsOnly) count++;
  if (input.onlyDrafts) count++;
  return count;
}

export const climbQueries = {
  checkMoonBoardClimbDuplicates: async (
    _: unknown,
    { input }: { input: CheckMoonBoardClimbDuplicatesInput },
    ctx: ConnectionContext,
  ) => {
    await applyRateLimit(ctx, 60, 'moonboard-duplicate-check');
    const validated = validateInput(CheckMoonBoardClimbDuplicatesInputSchema, input, 'input');
    return findMoonBoardDuplicateMatches(validated.layoutId, validated.angle, validated.climbs);
  },

  /**
   * Search for climbs with various filters
   * Returns a context object that field resolvers use to fetch data lazily
   */
  searchClimbs: async (
    _: unknown,
    { input }: { input: ClimbSearchInput },
    ctx: ConnectionContext,
  ): Promise<ClimbSearchContext> => {
    validateInput(ClimbSearchInputSchema, input, 'input');

    // Validate board name
    if (!isValidBoardName(input.boardName)) {
      throw new Error(`Invalid board name: ${input.boardName}. Must be one of: ${SUPPORTED_BOARDS.join(', ')}`);
    }

    // Parse setIds from comma-separated string
    const setIds = input.setIds
      .split(',')
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => !isNaN(id));

    // Build route parameters
    const params: ParsedBoardRouteParameters = {
      board_name: input.boardName,
      layout_id: input.layoutId,
      size_id: input.sizeId,
      set_ids: setIds,
      angle: input.angle,
    };

    // Build search parameters
    const searchParams: ClimbSearchParams = {
      page: input.page ?? 0,
      pageSize: input.pageSize ?? 20,
      gradeAccuracy: input.gradeAccuracy ? parseFloat(input.gradeAccuracy) : undefined,
      minGrade: input.minGrade,
      maxGrade: input.maxGrade,
      minAscents: input.minAscents,
      minRating: input.minRating,
      sortBy: input.sortBy ?? 'ascents',
      sortOrder: input.sortOrder ?? 'desc',
      name: input.name,
      settername: input.setter && input.setter.length > 0 ? input.setter : undefined,
      onlyTallClimbs: input.onlyTallClimbs,
      holdsFilter: input.holdsFilter,
      hideAttempted: input.hideAttempted,
      hideCompleted: input.hideCompleted,
      showOnlyAttempted: input.showOnlyAttempted,
      showOnlyCompleted: input.showOnlyCompleted,
      onlyDrafts: input.onlyDrafts,
      projectsOnly: input.projectsOnly,
      zoneBox: input.zoneBox,
    };

    if (DEBUG) {
      console.info(
        '[searchClimbs] onlyDrafts:',
        input.onlyDrafts,
        'userId:',
        ctx.isAuthenticated ? ctx.userId : 'not authenticated',
      );
    }

    const filterCount = countActiveSearchFilters(input);
    const attribution = resolveContextAttribution(ctx);
    trackServer('Search Climbs', {
      distinctId: attribution.distinctId,
      properties: {
        boardName: input.boardName,
        layoutId: input.layoutId,
        sizeId: input.sizeId,
        angle: input.angle,
        page: input.page ?? 0,
        pageSize: input.pageSize ?? 20,
        sortBy: input.sortBy ?? 'ascents',
        sortOrder: input.sortOrder ?? 'desc',
        hasNameQuery: !!input.name && input.name.length > 0,
        hasSetterFilter: !!input.setter && input.setter.length > 0,
        hasZoneFilter: !!input.zoneBox,
        onlyDrafts: !!input.onlyDrafts,
        projectsOnly: !!input.projectsOnly,
        filterCount,
        isAuthenticated: !!ctx.isAuthenticated,
      },
    });

    // Drafts require authentication — return empty results if not signed in
    if (input.onlyDrafts && !ctx.isAuthenticated) {
      return {
        params,
        searchParams,
        userId: undefined,
        _cachedClimbs: [],
        _cachedHasMore: false,
        _cachedTotalCount: 0,
      };
    }

    // MoonBoard data changes frequently via local creation/import flows, so keep
    // GraphQL search results uncached there. Other boards can still use Redis
    // when the query is anonymous and has no user-specific filters.
    const hasUserSpecificFilters = USER_SPECIFIC_SEARCH_PARAMS.some(
      (param) => !!searchParams[param as keyof typeof searchParams],
    );
    const isCacheableBoard = input.boardName !== 'moonboard';

    // Only resolve userId when user-specific filters are active — otherwise the query
    // results are identical to anonymous and can be served from Redis cache.
    const userId = ctx.isAuthenticated && hasUserSpecificFilters ? ctx.userId : undefined;

    // Return context for field resolvers - queries are executed lazily per field
    // Personal progress filters now use boardsesh_ticks table with NextAuth user ID
    return {
      params,
      searchParams,
      userId,
      _isCacheable: !hasUserSpecificFilters && isCacheableBoard,
    };
  },

  /**
   * Get a specific climb by UUID
   */
  climb: async (
    _: unknown,
    {
      boardName,
      layoutId,
      sizeId,
      setIds,
      angle,
      climbUuid,
    }: {
      boardName: string;
      layoutId: number;
      sizeId: number;
      setIds: string;
      angle: number;
      climbUuid: string;
    },
    ctx: ConnectionContext,
  ) => {
    // Validate board name
    validateInput(BoardNameSchema, boardName, 'boardName');

    if (!isValidBoardName(boardName)) {
      throw new Error(`Invalid board name: ${boardName}. Must be one of: ${SUPPORTED_BOARDS.join(', ')}`);
    }

    // Validate all parameters
    if (layoutId <= 0) throw new Error('Invalid layoutId: must be positive');
    if (sizeId <= 0) throw new Error('Invalid sizeId: must be positive');
    if (angle < 0 || angle > 90) throw new Error('Invalid angle: must be between 0 and 90');
    validateInput(ExternalUUIDSchema, climbUuid, 'climbUuid');

    if (DEBUG) console.info('[climb] Fetching:', { boardName, layoutId, sizeId, setIds, angle, climbUuid });

    const climb = await getClimbByUuid({
      board_name: boardName,
      layout_id: layoutId,
      size_id: sizeId,
      angle,
      climb_uuid: climbUuid,
    });

    const attribution = resolveContextAttribution(ctx);
    trackServer('Climb Viewed', {
      distinctId: attribution.distinctId,
      properties: {
        boardName,
        climbUuid,
        layoutId,
        sizeId,
        angle,
        isAuthenticated: !!ctx.isAuthenticated,
        found: !!climb,
      },
    });

    return climb;
  },

  /**
   * Get climb stats history for the last 12 months
   */
  climbStatsHistory: async (_: unknown, { boardName, climbUuid }: { boardName: string; climbUuid: string }) => {
    validateInput(BoardNameSchema, boardName, 'boardName');
    validateInput(ExternalUUIDSchema, climbUuid, 'climbUuid');

    if (!isValidBoardName(boardName)) {
      throw new Error(`Invalid board name: ${boardName}. Must be one of: ${SUPPORTED_BOARDS.join(', ')}`);
    }

    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

    const rows = await db
      .select({
        angle: dbSchema.boardClimbStatsHistory.angle,
        ascensionistCount: dbSchema.boardClimbStatsHistory.ascensionistCount,
        qualityAverage: dbSchema.boardClimbStatsHistory.qualityAverage,
        difficultyAverage: dbSchema.boardClimbStatsHistory.difficultyAverage,
        displayDifficulty: dbSchema.boardClimbStatsHistory.displayDifficulty,
        createdAt: dbSchema.boardClimbStatsHistory.createdAt,
      })
      .from(dbSchema.boardClimbStatsHistory)
      .where(
        and(
          eq(dbSchema.boardClimbStatsHistory.boardType, boardName),
          eq(dbSchema.boardClimbStatsHistory.climbUuid, climbUuid),
          gte(dbSchema.boardClimbStatsHistory.createdAt, twelveMonthsAgo.toISOString()),
        ),
      )
      .orderBy(desc(dbSchema.boardClimbStatsHistory.createdAt));

    return rows;
  },
};
