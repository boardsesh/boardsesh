import { type SQL, eq, gt, gte, sql, like, notLike, inArray, isNull, or, and } from 'drizzle-orm';
import { getMoonBoardGeometryByLayoutId } from '@boardsesh/board-config';
import { getTallWideScope } from '@boardsesh/board-constants/product-sizes';
import {
  boardClimbs,
  boardClimbStats,
  boardseshTicks,
  boardClimbHolds,
  boardPlacements,
  boardHoles,
  boardBetaLinks,
} from '../../schema/index';
import type { BoardRouteParams, ClimbSearchParams } from './types';
import { climbHoldPlacementMatchSql } from './placement-match';

// Escape LIKE/ILIKE metacharacters so user-supplied search text is matched
// literally. Postgres' default escape character is backslash, so `\%`, `\_`,
// and `\\` match the literal character. The value is bound as a parameter (not
// a SQL literal), so this is the only escaping layer needed.
function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// A Postgres `ARRAY[...]::int[]` literal from a size-id list, for the tall/wide
// `compatible_size_ids &&` overlap predicates.
function sizeIdArrayLiteral(sizeIds: readonly number[]): SQL {
  return sql`ARRAY[${sql.join(
    sizeIds.map((sizeId) => sql`${sizeId}`),
    sql`, `,
  )}]::int[]`;
}

function moonBoardZoneCoordinates(layoutId: number, placementHoleId: SQL): { x: SQL; y: SQL } {
  const geometry = getMoonBoardGeometryByLayoutId(layoutId);
  const { leftMargin, rightMargin, topMargin, bottomMargin } = geometry.calibration;
  const horizontalOrigin = leftMargin * geometry.numColumns;
  const horizontalScale = 1 - leftMargin - rightMargin;
  const verticalOrigin = geometry.rowTop * (1 - topMargin);
  const verticalScale = (geometry.rowTop / geometry.numRows) * (1 - topMargin - bottomMargin);
  const cellIndex = sql`(${placementHoleId} - 1)`;
  const row = sql`(FLOOR(${cellIndex} / ${geometry.numColumns}) + 1)`;

  return {
    x: sql`${horizontalOrigin} + (MOD(${cellIndex}, ${geometry.numColumns}) + 0.5) * ${horizontalScale}`,
    y: sql`${verticalOrigin} - (${geometry.rowTop} - ${row} + 0.5) * ${verticalScale}`,
  };
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
  // Use array containment so PostgreSQL can use board_climbs_compatible_size_ids_idx.
  // PostgreSQL's built-in GIN array_ops supports @> for integer[]; no intarray
  // extension or custom operator class is required for this index.
  // MoonBoard has a single fixed size, so skip.
  const sizeConditions: SQL[] =
    params.board_name === 'moonboard' ? [] : [sql`${boardClimbs.compatibleSizeIds} @> ARRAY[${params.size_id}]::int[]`];

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
    // qualityAverage is canonical 1-5 (migrations 0115/0116 backfilled Aurora's 1-3
    // scale to 1-5; MoonBoard is native 0-5), and minRating arrives as whole stars
    // 1-5, so compare directly. The old `/5` divisor assumed a 0-1 scale and made the
    // filter a near no-op — minRating=4 became threshold 0.8, which kept ~every rated
    // climb (verified on prod: 348014/348014 kilter rows passed).
    climbStatsConditions.push(sql`${boardClimbStats.qualityAverage} >= ${searchParams.minRating}`);
  }

  if (searchParams.gradeAccuracy) {
    climbStatsConditions.push(
      sql`ABS(ROUND(${boardClimbStats.displayDifficulty}::numeric, 0) - ${boardClimbStats.difficultyAverage}::numeric) <= ${searchParams.gradeAccuracy}`,
    );
  }

  // Benchmark/classic-only: imported board feeds mark these climbs with a
  // positive benchmark_difficulty. Zero and NULL both mean "not flagged".
  if (searchParams.onlyBenchmarks) {
    climbStatsConditions.push(sql`${boardClimbStats.benchmarkDifficulty} > 0`);
  }

  // Name search condition. Escape LIKE metacharacters so a search for "50%" or
  // "a_b" matches literally instead of treating %/_ as wildcards.
  const nameCondition: SQL[] = searchParams.name
    ? [sql`${boardClimbs.name} ILIKE ${`%${escapeLikePattern(searchParams.name)}%`}`]
    : [];

  // Setter name filter condition
  const setterNameCondition: SQL[] =
    searchParams.settername && searchParams.settername.length > 0
      ? [inArray(boardClimbs.setterUsername, searchParams.settername)]
      : [];

  // Hold filter conditions
  // Match the exact `p<holdId>r` token, not a bare `<holdId>r` substring. Frames
  // are concatenated `p<placementId>r<roleCode>` tokens (see board-constants
  // hold-states), so `%30r%` also matches `p130r…`/`p230r…` — wrongly including
  // (and via notLike wrongly excluding) climbs that don't use the hold. Anchoring
  // on the leading `p` fixes it on every board, since every token starts with `p`.
  // Measured on prod: `hold_1` via the old pattern falsely matched ~230k kilter climbs.
  // (A future migration may switch this to a board_climb_holds EXISTS probe, but that
  // table is not yet complete — ~8.9k kilter climbs lack holds rows — so the anchored
  // LIKE is the correct fix today.)
  const holdConditions: SQL[] = [
    ...anyHolds.map((holdId) => like(boardClimbs.frames, `%p${holdId}r%`)),
    ...notHolds.map((holdId) => notLike(boardClimbs.frames, `%p${holdId}r%`)),
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

  // Zone filter — restrict climbs by the user-defined box in board grid
  // coordinates. Aurora boards keep the denormalized `allHolds` path.
  // MoonBoard uses calibrated layout placements for both modes because its
  // climbs intentionally do not carry denormalized edge columns.
  // Direct db-layer callers bypass GraphQL validation, so re-check the box.
  const zoneBox = searchParams.zoneBox;
  const hasZoneBox = !!zoneBox;
  const validZoneBox =
    zoneBox && zoneBox.edgeRight > zoneBox.edgeLeft && zoneBox.edgeTop > zoneBox.edgeBottom ? zoneBox : null;
  const zoneMode = searchParams.zoneMode === 'anyHold' ? 'anyHold' : 'allHolds';
  const zoneConditions: SQL[] = [];
  if (hasZoneBox && !validZoneBox) {
    // A zone was requested but the box is degenerate (crafted/stale params). Fail
    // closed like the tall/wide filters below rather than returning every climb.
    zoneConditions.push(sql`false`);
  } else if (validZoneBox) {
    if (zoneMode === 'anyHold') {
      const zonePlacementMatch = climbHoldPlacementMatchSql({
        boardType: sql.raw('zone_ch.board_type'),
        climbHoldId: sql.raw('zone_ch.hold_id'),
        placementId: sql.raw('zone_bp.id'),
        placementHoleId: sql.raw('zone_bp.hole_id'),
      });
      const zonePlacementSetCondition =
        params.board_name === 'moonboard' || params.set_ids.length === 0
          ? sql``
          : sql`AND zone_bp.set_id IN (${sql.join(
              params.set_ids.map((setId) => sql`${setId}`),
              sql`, `,
            )})`;
      const zoneCoordinates =
        params.board_name === 'moonboard'
          ? moonBoardZoneCoordinates(params.layout_id, sql.raw('zone_bp.hole_id'))
          : { x: sql.raw('zone_bh.x'), y: sql.raw('zone_bh.y') };
      zoneConditions.push(sql`EXISTS (
        SELECT 1
        FROM ${boardClimbHolds} zone_ch
        JOIN ${boardPlacements} zone_bp
          ON zone_bp.board_type = zone_ch.board_type
          AND ${zonePlacementMatch}
          AND zone_bp.layout_id = ${params.layout_id}
        JOIN ${boardHoles} zone_bh
          ON zone_bh.board_type = zone_ch.board_type
          AND zone_bh.id = zone_bp.hole_id
        WHERE zone_ch.board_type = ${params.board_name}
          AND zone_ch.climb_uuid = ${boardClimbs.uuid}
          ${zonePlacementSetCondition}
          AND ${zoneCoordinates.x} >= ${validZoneBox.edgeLeft}
          AND ${zoneCoordinates.x} <= ${validZoneBox.edgeRight}
          AND ${zoneCoordinates.y} >= ${validZoneBox.edgeBottom}
          AND ${zoneCoordinates.y} <= ${validZoneBox.edgeTop}
      )`);
    } else if (params.board_name === 'moonboard') {
      const containedPlacementMatch = climbHoldPlacementMatchSql({
        boardType: sql.raw('contained_ch.board_type'),
        climbHoldId: sql.raw('contained_ch.hold_id'),
        placementId: sql.raw('contained_bp.id'),
        placementHoleId: sql.raw('contained_bp.hole_id'),
      });
      const containedCoordinates = moonBoardZoneCoordinates(params.layout_id, sql.raw('contained_bp.hole_id'));
      zoneConditions.push(
        sql`EXISTS (
          SELECT 1
          FROM ${boardClimbHolds} contained_ch
          WHERE contained_ch.board_type = ${params.board_name}
            AND contained_ch.climb_uuid = ${boardClimbs.uuid}
        )`,
        sql`NOT EXISTS (
          SELECT 1
          FROM ${boardClimbHolds} contained_ch
          WHERE contained_ch.board_type = ${params.board_name}
            AND contained_ch.climb_uuid = ${boardClimbs.uuid}
            AND NOT EXISTS (
              SELECT 1
              FROM ${boardPlacements} contained_bp
              JOIN ${boardHoles} contained_bh
                ON contained_bh.board_type = contained_bp.board_type
                AND contained_bh.id = contained_bp.hole_id
              WHERE contained_bp.board_type = contained_ch.board_type
                AND contained_bp.layout_id = ${params.layout_id}
                AND ${containedPlacementMatch}
                AND ${containedCoordinates.x} >= ${validZoneBox.edgeLeft}
                AND ${containedCoordinates.x} <= ${validZoneBox.edgeRight}
                AND ${containedCoordinates.y} >= ${validZoneBox.edgeBottom}
                AND ${containedCoordinates.y} <= ${validZoneBox.edgeTop}
            )
        )`,
      );
    } else {
      zoneConditions.push(
        sql`${boardClimbs.edgeLeft} >= ${validZoneBox.edgeLeft}`,
        sql`${boardClimbs.edgeRight} <= ${validZoneBox.edgeRight}`,
        sql`${boardClimbs.edgeBottom} >= ${validZoneBox.edgeBottom}`,
        sql`${boardClimbs.edgeTop} <= ${validZoneBox.edgeTop}`,
      );
    }
  }

  // Tall / Wide climbs filters. A climb is "tall"/"wide" when it can't be done
  // on any size of the active layout's product family that is shorter/narrower
  // than the active size — i.e. its denormalized compatible_size_ids overlaps
  // none of the shorter/narrower family sizes. getTallWideScope is the single
  // source of truth (shared with the mobile offline search and every UI chip);
  // it fails closed (empty sets) when the active size is the shortest/narrowest
  // in its axis or the (board, layout, size) is unknown/mismatched, so a
  // stale/crafted request stays restrictive (`false`) instead of returning
  // everything. Works on every board with a size grid — Kilter Homewall &
  // Original, Tension Board 2, Decoy, Grasshopper — and no-ops on single-size
  // boards (MoonBoard, Touchstone).
  const { narrowerSizeIds, shorterSizeIds, hasNarrower, hasShorter } = getTallWideScope(
    params.board_name,
    params.layout_id,
    params.size_id,
  );

  // The explicit `IS NOT NULL` guard mirrors the mobile offline path
  // (search-climbs-local.ts) and makes the intent obvious: a climb whose
  // compatible_size_ids is NULL isn't classifiable, so it's not tall/wide.
  // (`NOT (NULL && …)` is already NULL — falsy in WHERE — so this is a
  // readability/parity change, not a behavior change.)
  const tallClimbsConditions: SQL[] = [];
  if (searchParams.onlyTallClimbs) {
    tallClimbsConditions.push(
      hasShorter
        ? sql`${boardClimbs.compatibleSizeIds} IS NOT NULL AND NOT (${boardClimbs.compatibleSizeIds} && ${sizeIdArrayLiteral(shorterSizeIds)})`
        : sql`false`,
    );
  }

  const wideClimbsConditions: SQL[] = [];
  if (searchParams.onlyWideClimbs) {
    wideClimbsConditions.push(
      hasNarrower
        ? sql`${boardClimbs.compatibleSizeIds} IS NOT NULL AND NOT (${boardClimbs.compatibleSizeIds} && ${sizeIdArrayLiteral(narrowerSizeIds)})`
        : sql`false`,
    );
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
  // The <@ operator checks that every set a climb requires is in the user's selected sets.
  //
  // required_set_ids is denormalized: Aurora derives it from placements, MoonBoard from
  // the grid cell -> set map (see populateMoonBoardRequiredSetIds). It can be NULL for
  // freshly saved drafts (populated asynchronously) and for MoonBoard climbs not yet
  // backfilled, so allow NULL in those cases — better to show a climb than hide it.
  const allowNullRequiredSets = isOnlyDrafts || params.board_name === 'moonboard';
  const setIdsConditions: SQL[] =
    params.set_ids.length === 0
      ? []
      : [
          allowNullRequiredSets
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
    // True only when this is genuinely a user's drafts query (onlyDrafts AND a
    // userId to own them). Callers MUST derive their isDraftsQuery flag from this,
    // not from `!!searchParams.onlyDrafts`: onlyDrafts without a userId is not a
    // drafts query, and the two predicates disagreeing made searchClimbs skip the
    // size/stats filters and force creation sort while the filters still required
    // listed non-drafts. See searchClimbs / countClimbs.
    isOnlyDrafts: Boolean(isOnlyDrafts),
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
