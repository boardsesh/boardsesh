import { eq, and, gte, desc } from 'drizzle-orm';
import {
  type CheckMoonBoardClimbDuplicatesInput,
  type ClimbSearchInput,
  type ConnectionContext,
  type HoldHeatmapPoint,
  type SetterStat,
  type SetterStatsInput,
  type SimilarClimb,
  type SimilarClimbsInput,
  SUPPORTED_BOARDS,
  USER_SPECIFIC_SEARCH_PARAMS,
} from '@boardsesh/shared-schema';
import type { BoardName } from '@boardsesh/board-constants';
import { getSetterStats } from '@boardsesh/db/queries';
import { logger } from '../../../utils/logger';
import {
  type ClimbSearchParams,
  type ParsedBoardRouteParameters,
  getClimbByUuid,
  getHoldHeatmapData,
  mapSearchInputToParams,
} from '../../../db/queries/climbs/index';
import { isValidBoardName } from '../../../db/queries/util/table-select';
import { applyRateLimit, validateInput } from '../shared/helpers';
import { findMoonBoardDuplicateMatches } from './moonboard-duplicates';
import { findSimilarClimbs, parseFramesToHoldEntries, type NormalizedHold } from './climb-similarity';
import {
  BoardNameSchema,
  CheckMoonBoardClimbDuplicatesInputSchema,
  ClimbSearchInputSchema,
  ExternalUUIDSchema,
  SetterStatsInputSchema,
  SimilarClimbsInputSchema,
} from '../../../validation/schemas';
import type { ClimbSearchContext } from '../shared/types';
import { db, dbRead } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';

// Debug logging flag - only log in development
const DEBUG = process.env.NODE_ENV === 'development';

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
   * Find climbs on the same board+layout that share at least `threshold`
   * (default 0.5) position-only Jaccard similarity with the target's holds.
   * Used by the playview drawer's similar-climbs panel (0.5) and by the
   * create-climb form to preview the exact duplicate when a publish is
   * blocked (1.0).
   */
  similarClimbs: async (
    _: unknown,
    { input }: { input: SimilarClimbsInput },
    ctx: ConnectionContext,
  ): Promise<SimilarClimb[]> => {
    // 30/min/IP. The similar-climbs CTE scans board_climb_holds for the
    // whole layout before the HAVING prune. React Query caches identical
    // queries for 5 min but the play-drawer surface keys on climbUuid so
    // rapid climb-switching generates fresh requests; 30/min stays well
    // above any realistic interactive cadence while keeping a CGNAT'd
    // shared IP from running the query at 1/s sustained.
    await applyRateLimit(ctx, 30, 'similar-climbs');
    const validated = validateInput(SimilarClimbsInputSchema, input, 'input');

    if (!isValidBoardName(validated.boardType)) {
      throw new Error(`Invalid board name: ${validated.boardType}. Must be one of: ${SUPPORTED_BOARDS.join(', ')}`);
    }
    const boardType = validated.boardType as BoardName;

    let holds: NormalizedHold[];
    let excludeUuid = validated.excludeClimbUuid ?? undefined;

    if (validated.climbUuid) {
      const targetHoldRows = await db
        .select({
          holdId: dbSchema.boardClimbHolds.holdId,
          holdState: dbSchema.boardClimbHolds.holdState,
        })
        .from(dbSchema.boardClimbHolds)
        .where(
          and(
            eq(dbSchema.boardClimbHolds.boardType, boardType),
            eq(dbSchema.boardClimbHolds.climbUuid, validated.climbUuid),
          ),
        );
      holds = targetHoldRows.map((row) => ({ holdId: row.holdId, holdState: row.holdState }));

      // Legacy fallback: pre-existing climbs (especially MoonBoard imports)
      // carry their hold pattern in board_climbs.frames but have no rows in
      // board_climb_holds yet (backfill follow-up #1). Without this fallback
      // a MoonBoard duplicate-publish that points the UI at the existing
      // climb via `climbUuid` would surface an empty "no identical climbs"
      // state for the exact match it just rejected.
      if (holds.length === 0) {
        const [climbRow] = await db
          .select({ frames: dbSchema.boardClimbs.frames })
          .from(dbSchema.boardClimbs)
          .where(and(eq(dbSchema.boardClimbs.boardType, boardType), eq(dbSchema.boardClimbs.uuid, validated.climbUuid)))
          .limit(1);
        if (climbRow?.frames) {
          holds = parseFramesToHoldEntries(boardType, climbRow.frames).map(({ holdId, holdState }) => ({
            holdId,
            holdState,
          }));
        }
      }

      // Always exclude the target climb itself from its own similar list.
      excludeUuid = validated.climbUuid;
    } else {
      holds = parseFramesToHoldEntries(boardType, validated.frames ?? '').map(({ holdId, holdState }) => ({
        holdId,
        holdState,
      }));
    }

    if (holds.length === 0) return [];

    return findSimilarClimbs({
      boardType,
      layoutId: validated.layoutId,
      holds,
      threshold: validated.threshold ?? 0.5,
      limit: validated.limit ?? 25,
      excludeUuid,
      statsAngle: validated.angle ?? undefined,
    });
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
    // 120/min/identity. This is the app's hottest query and infinite scroll fires one
    // request per page, so the limit sits well above any interactive cadence while
    // capping abuse (deep-OFFSET pages, holdsFilter floods) on an anonymous endpoint.
    await applyRateLimit(ctx, 120, 'search-climbs');
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

    // Build search parameters via the shared mapper — same falsy-collapse
    // rules as the web SSR path. Don't inline the field-by-field copy here.
    const searchParams: ClimbSearchParams = mapSearchInputToParams(input);

    if (DEBUG) {
      logger.info(
        '[searchClimbs] onlyDrafts:',
        input.onlyDrafts,
        'userId:',
        ctx.isAuthenticated ? ctx.userId : 'not authenticated',
      );
    }

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
   * Aggregate hold usage for the interactive search board heatmap.
   * Uses the same ClimbSearchInput mapper as searchClimbs so the overlay matches
   * the currently staged filters in the mobile search sheet.
   */
  holdHeatmap: async (
    _: unknown,
    { input }: { input: ClimbSearchInput },
    ctx: ConnectionContext,
  ): Promise<HoldHeatmapPoint[]> => {
    await applyRateLimit(ctx, 30, 'hold-heatmap');
    const validated = validateInput(ClimbSearchInputSchema, input, 'input');

    if (!isValidBoardName(validated.boardName)) {
      throw new Error(`Invalid board name: ${validated.boardName}. Must be one of: ${SUPPORTED_BOARDS.join(', ')}`);
    }

    // MoonBoard search can use typed hold filters, but the heatmap aggregation is
    // based on unified board_climb_holds rows that MoonBoard imports don't yet guarantee.
    if (validated.boardName === 'moonboard') return [];

    const setIds = validated.setIds
      .split(',')
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => !isNaN(id));

    const params: ParsedBoardRouteParameters = {
      board_name: validated.boardName,
      layout_id: validated.layoutId,
      size_id: validated.sizeId,
      set_ids: setIds,
      angle: validated.angle,
    };

    const searchParams: ClimbSearchParams = mapSearchInputToParams(validated);
    return getHoldHeatmapData(params, searchParams, ctx.isAuthenticated ? ctx.userId : undefined);
  },

  /**
   * Get setter usernames with climb counts for autocomplete in the search drawer.
   * MoonBoard has no setter data — returns an empty list to match the REST behaviour.
   */
  setterStats: async (
    _: unknown,
    { input }: { input: SetterStatsInput },
    ctx: ConnectionContext,
  ): Promise<SetterStat[]> => {
    await applyRateLimit(ctx, 60, 'setter-stats');
    const validated = validateInput(SetterStatsInputSchema, input, 'input');

    if (!isValidBoardName(validated.boardName)) {
      throw new Error(`Invalid board name: ${validated.boardName}. Must be one of: ${SUPPORTED_BOARDS.join(', ')}`);
    }

    // MoonBoard doesn't have database tables for setter stats — return empty results
    // to match the legacy REST endpoint.
    if (validated.boardName === 'moonboard') {
      return [];
    }

    // Parse setIds from comma-separated string (same pattern as searchClimbs)
    const setIds = validated.setIds
      .split(',')
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => !isNaN(id));

    const params: ParsedBoardRouteParameters = {
      board_name: validated.boardName,
      layout_id: validated.layoutId,
      size_id: validated.sizeId,
      set_ids: setIds,
      angle: validated.angle,
    };

    const rows = await getSetterStats(dbRead, params, validated.search);

    return rows.map((row) => ({
      setterUsername: row.setter_username,
      climbCount: row.climb_count,
    }));
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

    if (DEBUG) logger.info('[climb] Fetching:', { boardName, layoutId, sizeId, setIds, angle, climbUuid });

    const climb = await getClimbByUuid({
      board_name: boardName,
      layout_id: layoutId,
      size_id: sizeId,
      angle,
      climb_uuid: climbUuid,
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
