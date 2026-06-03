import { type SQL, eq, gt, gte, sql, like, notLike, inArray, isNull, or, and } from 'drizzle-orm';
import {
  getHolePlacements,
  getProductSize,
  isKilterHomewallTallSizeId,
  isKilterHomewallWideSizeId,
  type HoldTuple,
  type ProductSizeData,
} from '@boardsesh/board-constants/product-sizes';
import {
  boardClimbs,
  boardClimbStats,
  boardseshTicks,
  boardProductSizes,
  boardClimbHolds,
  boardPlacements,
  boardHoles,
  boardBetaLinks,
} from '../../schema/index';
import type { BoardRouteParams, ClimbSearchParams } from './types';

// Kilter Homewall constants for expansion-aware filtering
const KILTER_HOMEWALL_LAYOUT_ID = 8;
const KILTER_HOMEWALL_PRODUCT_ID = 7;
const KILTER_HOMEWALL_SMALL_SIZE_ID = 17;
const KILTER_HOMEWALL_WIDE_REFERENCE_SIZE_ID = 21;
const KILTER_HOMEWALL_WIDE_EXPANSION_SET_IDS = [26, 27, 28, 29] as const;

function isKilterHomewallWideSideExpansionHold(
  holdPlacement: HoldTuple,
  smallSize: ProductSizeData,
  wideSize: ProductSizeData,
): boolean {
  const [, , xCoordinate, yCoordinate] = holdPlacement;
  // Product-size edges are outer board bounds. A hold exactly on the 7x10 edge
  // is outside that size, while a hold exactly on the 10x10 outer edge is not
  // inside the 10x10 renderable area. Match getBoardDetails' strict bounds.
  const isInsideWideSize =
    xCoordinate > wideSize.edgeLeft &&
    xCoordinate < wideSize.edgeRight &&
    yCoordinate > wideSize.edgeBottom &&
    yCoordinate < wideSize.edgeTop;
  const isOutsideSmallWidth = xCoordinate <= smallSize.edgeLeft || xCoordinate >= smallSize.edgeRight;
  return isInsideWideSize && isOutsideSmallWidth;
}

function buildKilterHomewallWideHoldIdsBySet(): ReadonlyMap<number, readonly number[]> {
  const smallSize = getProductSize('kilter', KILTER_HOMEWALL_SMALL_SIZE_ID);
  const wideSize = getProductSize('kilter', KILTER_HOMEWALL_WIDE_REFERENCE_SIZE_ID);
  if (!smallSize || !wideSize) {
    throw new Error('Kilter Homewall size metadata is missing for the wide climb filter');
  }

  const wideHoldIdsBySet = new Map(
    KILTER_HOMEWALL_WIDE_EXPANSION_SET_IDS.map((setId) => [
      setId,
      getHolePlacements('kilter', KILTER_HOMEWALL_LAYOUT_ID, setId)
        .filter((holdPlacement) => isKilterHomewallWideSideExpansionHold(holdPlacement, smallSize, wideSize))
        .map(([holdId]) => holdId),
    ]),
  );
  const wideHoldCount = [...wideHoldIdsBySet.values()].reduce((total, holdIds) => total + holdIds.length, 0);
  if (wideHoldCount === 0) {
    throw new Error('Kilter Homewall wide climb filter did not find any side-expansion holds');
  }

  return wideHoldIdsBySet;
}

// Board constants are generated static data in the deployed bundle, so this
// production cache is intentionally never invalidated.
let kilterHomewallWideHoldIdsBySet: ReadonlyMap<number, readonly number[]> | null = null;

function getKilterHomewallWideHoldIdsBySet(): ReadonlyMap<number, readonly number[]> {
  kilterHomewallWideHoldIdsBySet ??= buildKilterHomewallWideHoldIdsBySet();
  return kilterHomewallWideHoldIdsBySet;
}

export function resetKilterHomewallWideHoldIdsForTests(): void {
  kilterHomewallWideHoldIdsBySet = null;
}

export function getKilterHomewallWideHoldIdsForSets(setIds: readonly number[]): number[] {
  const selectedSetIds = new Set(setIds);
  const wideHoldIdsBySet = getKilterHomewallWideHoldIdsBySet();
  return [...selectedSetIds]
    .flatMap((setId) => wideHoldIdsBySet.get(setId) ?? [])
    .sort((leftHoldId, rightHoldId) => leftHoldId - rightHoldId);
}

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

  // Boulders / routes filter. Both selected (or both falsy — treated as "no
  // preference") → omit the frames_count constraint entirely. Boulders only →
  // `frames_count = 1`. Routes only → `frames_count > 1`.
  //
  // frames_count is currently NULLABLE in the schema; NULL is legacy
  // pre-migration data and should be treated as single-frame (boulder). The
  // boulders-only branch therefore OR-includes NULL. Follow-up migration
  // (tracked separately) will backfill NULLs to 1 and add NOT NULL, after
  // which the isNull() branch can be dropped.
  const wantsBoulders = !!searchParams.boulders;
  const wantsRoutes = !!searchParams.routes;
  const climbTypeCondition: SQL | null =
    wantsBoulders && !wantsRoutes
      ? or(eq(boardClimbs.framesCount, 1), isNull(boardClimbs.framesCount))!
      : wantsRoutes && !wantsBoulders
        ? gt(boardClimbs.framesCount, 1)
        : null;

  // Base conditions for filtering climbs
  const baseConditions: SQL[] = [
    eq(boardClimbs.boardType, params.board_name),
    eq(boardClimbs.layoutId, params.layout_id),
    ...(isListedCondition ? [isListedCondition] : []),
    isDraftCondition,
    ...(climbTypeCondition ? [climbTypeCondition] : []),
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

  // Benchmark-only: climbs the board curators flagged as benchmarks carry a
  // non-null benchmark_difficulty. (onlyClassics is a legacy no-op — see #2499.)
  if (searchParams.onlyBenchmarks) {
    climbStatsConditions.push(sql`${boardClimbStats.benchmarkDifficulty} IS NOT NULL`);
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

  // Zone filter — restrict climbs by the user-defined box in board_holes grid
  // coordinates. `allHolds` keeps the existing denormalized bounding-box path.
  // `anyHold` needs to inspect individual climb holds because a climb can
  // extend outside the zone while still using an expansion hold inside it.
  // Direct db-layer callers bypass GraphQL validation, so re-check the box.
  const zoneBox = searchParams.zoneBox;
  const validZoneBox =
    zoneBox && zoneBox.edgeRight > zoneBox.edgeLeft && zoneBox.edgeTop > zoneBox.edgeBottom ? zoneBox : null;
  const zoneMode = searchParams.zoneMode === 'anyHold' ? 'anyHold' : 'allHolds';
  const zoneConditions: SQL[] = [];
  if (validZoneBox) {
    if (zoneMode === 'anyHold') {
      const zonePlacementSetCondition =
        params.board_name === 'moonboard' || params.set_ids.length === 0
          ? sql``
          : sql`AND zone_bp.set_id IN (${sql.join(
              params.set_ids.map((setId) => sql`${setId}`),
              sql`, `,
            )})`;
      zoneConditions.push(sql`EXISTS (
        SELECT 1
        FROM ${boardClimbHolds} zone_ch
        JOIN ${boardPlacements} zone_bp
          ON zone_bp.board_type = zone_ch.board_type
          AND zone_bp.id = zone_ch.hold_id
          AND zone_bp.layout_id = ${params.layout_id}
        JOIN ${boardHoles} zone_bh
          ON zone_bh.board_type = zone_ch.board_type
          AND zone_bh.id = zone_bp.hole_id
        WHERE zone_ch.board_type = ${params.board_name}
          AND zone_ch.climb_uuid = ${boardClimbs.uuid}
          ${zonePlacementSetCondition}
          AND zone_bh.x >= ${validZoneBox.edgeLeft}
          AND zone_bh.x <= ${validZoneBox.edgeRight}
          AND zone_bh.y >= ${validZoneBox.edgeBottom}
          AND zone_bh.y <= ${validZoneBox.edgeTop}
      )`);
    } else {
      zoneConditions.push(
        sql`${boardClimbs.edgeLeft} >= ${validZoneBox.edgeLeft}`,
        sql`${boardClimbs.edgeRight} <= ${validZoneBox.edgeRight}`,
        sql`${boardClimbs.edgeBottom} >= ${validZoneBox.edgeBottom}`,
        sql`${boardClimbs.edgeTop} <= ${validZoneBox.edgeTop}`,
      );
    }
  }

  // Tall climbs filter condition
  const tallClimbsConditions: SQL[] = [];

  if (searchParams.onlyTallClimbs) {
    const isTallClimbSupportedBoard =
      params.board_name === 'kilter' &&
      params.layout_id === KILTER_HOMEWALL_LAYOUT_ID &&
      isKilterHomewallTallSizeId(params.size_id);
    if (!isTallClimbSupportedBoard) {
      // A stale/crafted URL asked for a board-scoped filter the current board
      // cannot satisfy. Keep the request restrictive instead of silently
      // returning unfiltered climbs.
      tallClimbsConditions.push(sql`false`);
    } else {
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
  }

  const wideClimbsConditions: SQL[] = [];

  if (searchParams.onlyWideClimbs) {
    const isWideClimbSupportedBoard =
      params.board_name === 'kilter' &&
      params.layout_id === KILTER_HOMEWALL_LAYOUT_ID &&
      isKilterHomewallWideSizeId(params.size_id);
    if (!isWideClimbSupportedBoard) {
      // A stale/crafted URL asked for a board-scoped filter the current board
      // cannot satisfy. Keep the request restrictive instead of silently
      // returning unfiltered climbs.
      wideClimbsConditions.push(sql`false`);
    } else {
      const wideHoldIds = getKilterHomewallWideHoldIdsForSets(params.set_ids);
      if (wideHoldIds.length === 0) {
        wideClimbsConditions.push(sql`false`);
      } else {
        const wideHoldIdLiterals = sql.join(
          wideHoldIds.map((holdId) => sql`${holdId}`),
          sql`, `,
        );
        // This requires at least one hold in the 10x10 side expansion over 7x10.
        // On 10x12 boards, other holds may still use the lower 10x12-only rows.
        wideClimbsConditions.push(sql`EXISTS (
        SELECT 1
        FROM ${boardClimbHolds} wide_ch
        WHERE wide_ch.board_type = ${params.board_name}
          AND wide_ch.climb_uuid = ${boardClimbs.uuid}
          AND wide_ch.hold_id IN (${wideHoldIdLiterals})
      )`);
      }
    }
  }

  // Beta-videos filter: keep only climbs that have at least one beta link the
  // user could actually watch (is_listed true or NULL — exclude explicitly
  // hidden links). Applies on every board, unlike the size-gated tall/wide
  // filters above.
  const betaVideosConditions: SQL[] = [];

  if (searchParams.onlyWithBetaVideos) {
    betaVideosConditions.push(sql`EXISTS (
      SELECT 1
      FROM ${boardBetaLinks} bl
      WHERE bl.board_type = ${params.board_name}
        AND bl.climb_uuid = ${boardClimbs.uuid}
        AND bl.is_listed IS NOT FALSE
    )`);
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
      ...wideClimbsConditions,
      ...betaVideosConditions,
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
    wideClimbsConditions,
    betaVideosConditions,
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
