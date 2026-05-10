import { type SQL, eq, gte, sql, like, notLike, inArray, or, and } from 'drizzle-orm';
import {
  boardClimbs,
  boardClimbStats,
  boardseshTicks,
  boardProductSizes,
  boardClimbHolds,
  userClimbQualities,
} from '../../schema/index';
import type { BoardRouteParams, ClimbSearchParams } from './types';

// Kilter Homewall constants for tall-climb filtering
const KILTER_HOMEWALL_LAYOUT_ID = 8;
const KILTER_HOMEWALL_PRODUCT_ID = 7;

/**
 * Creates a shared filtering object for climb search and heatmap queries.
 * Uses unified tables (board_climbs, board_climb_stats, etc.) with board_type filtering.
 *
 * @param params Board route parameters (board_name, layout_id, etc.)
 * @param searchParams Search/filter parameters
 * @param userId Optional user ID for personal progress filters
 */
export const createClimbFilters = (params: BoardRouteParams, searchParams: ClimbSearchParams, userId?: string) => {
  // holdsFilter shape: Record<holdId, Partial<Record<HoldFilterType, 'include' | 'exclude'>>>.
  // ANY means "hold present in any state" (the wildcard); STARTING / HAND /
  // FOOT / FINISH require / forbid the hold appearing with that specific
  // state in board_climb_holds.
  const anyHolds: number[] = [];
  const notHolds: number[] = [];
  const holdStateFilters: Array<{ holdId: number; state: string; mode: 'include' | 'exclude' }> = [];

  for (const [keyRaw, entry] of Object.entries(searchParams.holdsFilter || {})) {
    const holdId = Number(keyRaw.replace('hold_', ''));
    if (!Number.isInteger(holdId) || holdId <= 0 || !entry || typeof entry !== 'object') continue;
    for (const [type, mode] of Object.entries(entry as Record<string, unknown>)) {
      if (mode !== 'include' && mode !== 'exclude') continue;
      if (type === 'ANY') {
        if (mode === 'include') anyHolds.push(holdId);
        else notHolds.push(holdId);
      } else if (type === 'STARTING' || type === 'HAND' || type === 'FOOT' || type === 'FINISH') {
        holdStateFilters.push({ holdId, state: type, mode });
      }
    }
  }

  // When onlyDrafts is enabled, show ONLY the user's own draft climbs.
  // Draft climbs can be owned via userId (locally created or JSON-imported)
  // or via setterId (Aurora-synced).
  const isOnlyDrafts = searchParams.onlyDrafts && userId;

  const userOwnershipCondition = userId
    ? or(
        eq(boardClimbs.userId, userId),
        sql`${boardClimbs.setterId} = (
          SELECT ubm.board_user_id FROM user_board_mappings ubm
          WHERE ubm.user_id = ${userId}
          AND ubm.board_type = ${params.board_name}
          LIMIT 1
        )`,
      )!
    : sql`false`;

  const isDraftCondition: SQL = isOnlyDrafts
    ? and(eq(boardClimbs.isDraft, true), userOwnershipCondition)!
    : eq(boardClimbs.isDraft, false);

  // When showing only drafts, skip the isListed filter (drafts are never listed)
  const isListedCondition: SQL | null = isOnlyDrafts ? null : eq(boardClimbs.isListed, true);

  // Base conditions for filtering climbs
  const baseConditions: SQL[] = [
    eq(boardClimbs.boardType, params.board_name),
    eq(boardClimbs.layoutId, params.layout_id),
    ...(isListedCondition ? [isListedCondition] : []),
    isDraftCondition,
    eq(boardClimbs.framesCount, 1),
  ];

  // Size filter: check if this climb fits on the selected board size.
  // Uses denormalized compatible_size_ids array (pre-computed from edge comparison).
  // MoonBoard has a single fixed size, so skip.
  const sizeConditions: SQL[] =
    params.board_name === 'moonboard' ? [] : [sql`${params.size_id} = ANY(${boardClimbs.compatibleSizeIds})`];

  // Projects-only: match climbs with 0 ascents OR no stats row at all.
  // Must live outside climbStatsConditions so it doesn't trigger the stats-driven
  // INNER JOIN path (which would exclude no-stats climbs).
  const projectsOnlyConditions: SQL[] = searchParams.projectsOnly
    ? [sql`COALESCE(${boardClimbStats.ascensionistCount}, 0) = 0`]
    : [];

  // Conditions for climb stats
  const climbStatsConditions: SQL[] = [];

  // Skip minAscents when projectsOnly is active (they're mutually exclusive in the UI,
  // but guard here too so a stale query param can't produce a contradictory filter).
  if (searchParams.minAscents && !searchParams.projectsOnly) {
    climbStatsConditions.push(gte(boardClimbStats.ascensionistCount, searchParams.minAscents));
  }

  if (searchParams.minGrade && searchParams.maxGrade) {
    climbStatsConditions.push(
      sql`ROUND(${boardClimbStats.displayDifficulty}::numeric, 0) BETWEEN ${searchParams.minGrade} AND ${searchParams.maxGrade}`,
    );
  } else if (searchParams.minGrade) {
    climbStatsConditions.push(sql`ROUND(${boardClimbStats.displayDifficulty}::numeric, 0) >= ${searchParams.minGrade}`);
  } else if (searchParams.maxGrade) {
    climbStatsConditions.push(sql`ROUND(${boardClimbStats.displayDifficulty}::numeric, 0) <= ${searchParams.maxGrade}`);
  }

  if (searchParams.minRating) {
    // qualityAverage is stored from 0-1; minRating arrives as whole stars from 1-5.
    climbStatsConditions.push(sql`${boardClimbStats.qualityAverage} >= ${searchParams.minRating / 5}`);
  }

  if (searchParams.gradeAccuracy) {
    climbStatsConditions.push(
      sql`ABS(ROUND(${boardClimbStats.displayDifficulty}::numeric, 0) - ${boardClimbStats.difficultyAverage}::numeric) <= ${searchParams.gradeAccuracy}`,
    );
  }

  // Name search condition
  const nameCondition: SQL[] = searchParams.name ? [sql`${boardClimbs.name} ILIKE ${`%${searchParams.name}%`}`] : [];

  // Setter name filter condition
  const setterNameCondition: SQL[] =
    searchParams.settername && searchParams.settername.length > 0
      ? [inArray(boardClimbs.setterUsername, searchParams.settername)]
      : [];

  // Hold filter conditions
  const holdConditions: SQL[] = [
    ...anyHolds.map((holdId) => like(boardClimbs.frames, `%${holdId}r%`)),
    ...notHolds.map((holdId) => notLike(boardClimbs.frames, `%${holdId}r%`)),
  ];

  // State-specific hold conditions — use board_climb_holds. Multiple types
  // on the same hold are OR-combined within their mode: HAND:include +
  // FOOT:include means "hold is HAND OR FOOT" (a hold has only one state in
  // any given climb, so AND would always be empty). Same for excludes.
  const includesByHold = new Map<number, string[]>();
  const excludesByHold = new Map<number, string[]>();
  for (const { holdId, state, mode } of holdStateFilters) {
    const target = mode === 'include' ? includesByHold : excludesByHold;
    const states = target.get(holdId) ?? [];
    states.push(state);
    target.set(holdId, states);
  }
  const holdStateConditions: SQL[] = [];
  for (const [holdId, states] of includesByHold) {
    const stateLiterals = sql.join(
      states.map((s) => sql`${s}`),
      sql`, `,
    );
    holdStateConditions.push(sql`EXISTS (
      SELECT 1 FROM ${boardClimbHolds} ch
      WHERE ch.board_type = ${params.board_name}
      AND ch.climb_uuid = ${boardClimbs.uuid}
      AND ch.hold_id = ${holdId}
      AND ch.hold_state IN (${stateLiterals})
    )`);
  }
  for (const [holdId, states] of excludesByHold) {
    const stateLiterals = sql.join(
      states.map((s) => sql`${s}`),
      sql`, `,
    );
    holdStateConditions.push(sql`NOT EXISTS (
      SELECT 1 FROM ${boardClimbHolds} ch
      WHERE ch.board_type = ${params.board_name}
      AND ch.climb_uuid = ${boardClimbs.uuid}
      AND ch.hold_id = ${holdId}
      AND ch.hold_state IN (${stateLiterals})
    )`);
  }

  // Zone filter — keep only climbs whose entire bounding box sits inside
  // the user-defined zone (in board_holes/board_climbs grid coordinates).
  // The denormalized edge columns on board_climbs make this a simple range
  // check; no extra join needed. We defensively re-check the box is valid
  // even though the GraphQL Zod schema rejects degenerate boxes — direct
  // db-layer callers (REST proxies, scripts) bypass that guard.
  const zoneConditions: SQL[] =
    searchParams.zoneBox &&
    searchParams.zoneBox.edgeRight > searchParams.zoneBox.edgeLeft &&
    searchParams.zoneBox.edgeTop > searchParams.zoneBox.edgeBottom
      ? [
          sql`${boardClimbs.edgeLeft} >= ${searchParams.zoneBox.edgeLeft}`,
          sql`${boardClimbs.edgeRight} <= ${searchParams.zoneBox.edgeRight}`,
          sql`${boardClimbs.edgeBottom} >= ${searchParams.zoneBox.edgeBottom}`,
          sql`${boardClimbs.edgeTop} <= ${searchParams.zoneBox.edgeTop}`,
        ]
      : [];

  // Tall climbs filter condition
  const tallClimbsConditions: SQL[] = [];

  if (searchParams.onlyTallClimbs && params.board_name === 'kilter' && params.layout_id === KILTER_HOMEWALL_LAYOUT_ID) {
    tallClimbsConditions.push(
      sql`${boardClimbs.edgeBottom} < (
        SELECT MAX(ps.edge_bottom)
        FROM ${boardProductSizes} ps
        WHERE ps.board_type = ${params.board_name}
        AND ps.product_id = ${KILTER_HOMEWALL_PRODUCT_ID}
        AND ps.id != ${params.size_id}
      )`,
    );
  }

  // Set membership filter: exclude climbs that use holds from sets the user doesn't own.
  // Uses denormalized required_set_ids array (pre-computed from climb_holds -> placements).
  // The <@ operator checks that all required sets are in the user's selected sets.
  // MoonBoard has no set data, so skip.
  //
  // For draft queries, allow NULL required_set_ids — denormalized columns are populated
  // asynchronously and may be NULL for freshly saved drafts, so we must not exclude them.
  const setIdsConditions: SQL[] =
    params.board_name === 'moonboard' || params.set_ids.length === 0
      ? []
      : [
          isOnlyDrafts
            ? sql`(${boardClimbs.requiredSetIds} IS NULL OR ${boardClimbs.requiredSetIds} <@ ARRAY[${sql.join(
                params.set_ids.map((id) => sql`${id}`),
                sql`, `,
              )}]::int[])`
            : sql`${boardClimbs.requiredSetIds} <@ ARRAY[${sql.join(
                params.set_ids.map((id) => sql`${id}`),
                sql`, `,
              )}]::int[]`,
        ];

  // Personal progress filter conditions
  const personalProgressConditions: SQL[] = [];
  if (userId) {
    if (searchParams.hideAttempted) {
      // Hide climbs where the user has at least one attempt tick
      personalProgressConditions.push(
        sql`NOT EXISTS (
          SELECT 1 FROM ${boardseshTicks}
          WHERE ${boardseshTicks.climbUuid} = ${boardClimbs.uuid}
          AND ${boardseshTicks.userId} = ${userId}
          AND ${boardseshTicks.boardType} = ${params.board_name}
          AND ${boardseshTicks.angle} = ${params.angle}
          AND ${boardseshTicks.status} = 'attempt'
        )`,
      );
    }

    if (searchParams.hideCompleted) {
      personalProgressConditions.push(
        sql`NOT EXISTS (
          SELECT 1 FROM ${boardseshTicks}
          WHERE ${boardseshTicks.climbUuid} = ${boardClimbs.uuid}
          AND ${boardseshTicks.userId} = ${userId}
          AND ${boardseshTicks.boardType} = ${params.board_name}
          AND ${boardseshTicks.angle} = ${params.angle}
          AND ${boardseshTicks.status} IN ('flash', 'send')
        )`,
      );
    }

    if (searchParams.showOnlyAttempted) {
      // Show only climbs where the user has an attempt tick
      personalProgressConditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${boardseshTicks}
          WHERE ${boardseshTicks.climbUuid} = ${boardClimbs.uuid}
          AND ${boardseshTicks.userId} = ${userId}
          AND ${boardseshTicks.boardType} = ${params.board_name}
          AND ${boardseshTicks.angle} = ${params.angle}
          AND ${boardseshTicks.status} = 'attempt'
        )`,
      );
    }

    if (searchParams.showOnlyCompleted) {
      personalProgressConditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${boardseshTicks}
          WHERE ${boardseshTicks.climbUuid} = ${boardClimbs.uuid}
          AND ${boardseshTicks.userId} = ${userId}
          AND ${boardseshTicks.boardType} = ${params.board_name}
          AND ${boardseshTicks.angle} = ${params.angle}
          AND ${boardseshTicks.status} IN ('flash', 'send')
        )`,
      );
    }

    // User-quality filter — angle-independent.
    //   minUserQuality > 0, hideWithoutUserQuality off:
    //     show climbs the user hasn't rated AND climbs they rated >= threshold;
    //     hide climbs they rated below the threshold.
    //   hideWithoutUserQuality on:
    //     require an EXISTS row, optionally clamped by the threshold.
    const minUserQuality = searchParams.minUserQuality ?? 0;
    const hideWithoutUserQuality = searchParams.hideWithoutUserQuality ?? false;
    if (minUserQuality > 0 || hideWithoutUserQuality) {
      if (hideWithoutUserQuality) {
        const minClause = minUserQuality > 0 ? sql`AND ${userClimbQualities.quality} >= ${minUserQuality}` : sql``;
        personalProgressConditions.push(
          sql`EXISTS (
            SELECT 1 FROM ${userClimbQualities}
            WHERE ${userClimbQualities.userId} = ${userId}
            AND ${userClimbQualities.boardType} = ${params.board_name}
            AND ${userClimbQualities.climbUuid} = ${boardClimbs.uuid}
            ${minClause}
          )`,
        );
      } else {
        // minUserQuality > 0 only: keep unrated climbs, drop too-low ones.
        personalProgressConditions.push(
          sql`NOT EXISTS (
            SELECT 1 FROM ${userClimbQualities}
            WHERE ${userClimbQualities.userId} = ${userId}
            AND ${userClimbQualities.boardType} = ${params.board_name}
            AND ${userClimbQualities.climbUuid} = ${boardClimbs.uuid}
            AND ${userClimbQualities.quality} < ${minUserQuality}
          )`,
        );
      }
    }
  }

  // User-specific logbook data selectors using boardsesh_ticks
  const getUserLogbookSelects = () => {
    return {
      userAscents: sql<number>`(
        SELECT COUNT(*)
        FROM ${boardseshTicks}
        WHERE ${boardseshTicks.climbUuid} = ${boardClimbs.uuid}
        AND ${boardseshTicks.userId} = ${userId || ''}
        AND ${boardseshTicks.boardType} = ${params.board_name}
        AND ${boardseshTicks.angle} = ${params.angle}
        AND ${boardseshTicks.status} IN ('flash', 'send')
      )`,
      userAttempts: sql<number>`(
        SELECT COUNT(*)
        FROM ${boardseshTicks}
        WHERE ${boardseshTicks.climbUuid} = ${boardClimbs.uuid}
        AND ${boardseshTicks.userId} = ${userId || ''}
        AND ${boardseshTicks.boardType} = ${params.board_name}
        AND ${boardseshTicks.angle} = ${params.angle}
        AND ${boardseshTicks.status} = 'attempt'
      )`,
    };
  };

  // Hold-specific user data selectors for heatmap using boardsesh_ticks
  const getHoldUserLogbookSelects = (climbHoldsTable: typeof boardClimbHolds) => {
    return {
      userAscents: sql<number>`(
        SELECT COUNT(*)
        FROM ${boardseshTicks}
        WHERE ${boardseshTicks.climbUuid} = ${climbHoldsTable.climbUuid}
        AND ${boardseshTicks.userId} = ${userId || ''}
        AND ${boardseshTicks.boardType} = ${params.board_name}
        AND ${boardseshTicks.angle} = ${params.angle}
        AND ${boardseshTicks.status} IN ('flash', 'send')
      )`,
      userAttempts: sql<number>`(
        SELECT COUNT(*)
        FROM ${boardseshTicks}
        WHERE ${boardseshTicks.climbUuid} = ${climbHoldsTable.climbUuid}
        AND ${boardseshTicks.userId} = ${userId || ''}
        AND ${boardseshTicks.boardType} = ${params.board_name}
        AND ${boardseshTicks.angle} = ${params.angle}
        AND ${boardseshTicks.status} = 'attempt'
      )`,
    };
  };

  return {
    getClimbWhereConditions: () => [
      ...baseConditions,
      ...nameCondition,
      ...setterNameCondition,
      ...holdConditions,
      ...holdStateConditions,
      ...tallClimbsConditions,
      ...zoneConditions,
      ...setIdsConditions,
      ...personalProgressConditions,
      ...projectsOnlyConditions,
    ],
    getSizeConditions: () => sizeConditions,
    getClimbStatsConditions: () => climbStatsConditions,
    getClimbStatsJoinConditions: () => [
      eq(boardClimbStats.climbUuid, boardClimbs.uuid),
      eq(boardClimbStats.boardType, params.board_name),
      eq(boardClimbStats.angle, params.angle),
    ],
    getHoldHeatmapClimbStatsConditions: () => [
      eq(boardClimbStats.climbUuid, boardClimbHolds.climbUuid),
      eq(boardClimbStats.boardType, params.board_name),
      eq(boardClimbStats.angle, params.angle),
    ],
    getClimbHoldsJoinConditions: () => [
      eq(boardClimbHolds.climbUuid, boardClimbs.uuid),
      eq(boardClimbHolds.boardType, params.board_name),
    ],
    getUserLogbookSelects,
    getHoldUserLogbookSelects,
    // Raw parts
    baseConditions,
    climbStatsConditions,
    nameCondition,
    setterNameCondition,
    holdConditions,
    holdStateConditions,
    tallClimbsConditions,
    zoneConditions,
    setIdsConditions,
    sizeConditions,
    personalProgressConditions,
    projectsOnlyConditions,
    anyHolds,
    notHolds,
    holdStateFilters,
  };
};
