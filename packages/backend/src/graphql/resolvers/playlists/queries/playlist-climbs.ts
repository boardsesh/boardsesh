import { eq, and, asc, desc, getTableName, sql, type SQL } from 'drizzle-orm';
import { QueryBuilder, type PgSelect } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import {
  type ConnectionContext,
  type Climb,
  type BoardName,
  type PlaylistClimbViewInput,
  SUPPORTED_BOARDS,
} from '@boardsesh/shared-schema';
import { parseSetIds } from '@boardsesh/board-config';
import { PLAYLIST_SORT_DEFAULT_ORDER, type PlaylistSortOption } from '@boardsesh/climb-filters';
import { db } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import {
  climbDraftVisibilityCondition,
  climbSortColumns,
  createPlaylistClimbFilters,
  directedSortSql,
  mapSearchInputToParams,
  personalGradeColumnSql,
  playlistBoardScopeConditions,
  randomSortKeySql,
  sprayClimbVisibilityCondition,
  withSerialPlan,
  type PlaylistActiveBoard,
  type PlaylistFilterParams,
  type SerialPlanDb,
} from '@boardsesh/db/queries';
import { applyRateLimit, validateInput } from '../../shared/helpers';
import { GetPlaylistClimbsInputSchema, type PlaylistClimbViewInputSchema } from '../../../../validation/schemas';
import { UNIFIED_TABLES, isValidBoardName } from '../../../../db/queries/util/table-select';
import { verifyPlaylistAccess } from '../helpers/enrichment';
import {
  angleWithStatsSql,
  displayStatsAngleSql,
  hydrateClimbsByRefs,
  type HydrateClimbsOptions,
} from '../helpers/hydrate-climbs';

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
  // All-boards mode only: the rest of the active board, for the view's
  // active-board filters (progress, liked, tall, holds, board fit…).
  activeLayoutId?: number;
  activeSizeId?: number;
  activeSetIds?: string;
  // Sort and filters. Omitted means the playlist's own order, unfiltered, and
  // exactly the queries this resolver ran before views existed.
  view?: PlaylistClimbViewInput;
  page?: number;
  pageSize?: number;
};

type PlaylistClimbsPage = {
  climbs: Climb[];
  totalCount: number;
  /** Only with a filtering view: the count with no view filter applied. */
  unfilteredCount?: number | null;
  hasMore: boolean;
};

export type ParsedPlaylistClimbView = z.infer<typeof PlaylistClimbViewInputSchema>;

/** A page row as the playlist reads it, before hydration. */
type PlaylistRefRow = { climbUuid: string; boardType: string; playlistAngle: number | null };

/** The board-scoping fields of the input, the only part the scope builders read. */
type PlaylistBoardInput = Pick<
  PlaylistClimbsInput,
  | 'boardName'
  | 'layoutId'
  | 'sizeId'
  | 'setIds'
  | 'angle'
  | 'activeBoardName'
  | 'activeAngle'
  | 'activeLayoutId'
  | 'activeSizeId'
  | 'activeSetIds'
>;

function paginateResults<T>(results: T[], pageSize: number) {
  const hasMore = results.length > pageSize;
  return { items: hasMore ? results.slice(0, pageSize) : results, hasMore };
}

/**
 * Build the climb join conditions for specific-board mode (board type, layout,
 * size, and hold-set scoping). Shared by the ref-rows query and the totalCount
 * query so the count always reflects the same rows the page can return (#4000).
 */
function buildSpecificBoardClimbJoinConditions(
  tables: typeof UNIFIED_TABLES,
  boardName: BoardName,
  input: PlaylistBoardInput,
  viewerUserId: string | null | undefined,
) {
  const climbJoinConditions = [
    eq(tables.climbs.uuid, dbSchema.playlistClimbs.climbUuid),
    // The draft rule: a playlist anyone can open must not substitute its own
    // visibility for a draft's, which is its owner's alone. A published climb
    // shows whoever set it, unlisted included.
    climbDraftVisibilityCondition({ userId: tables.climbs.userId, isDraft: tables.climbs.isDraft }, viewerUserId),
    eq(tables.climbs.boardType, boardName),
    // A PUBLIC playlist would otherwise substitute its own visibility for the wall's:
    // add a private spray wall's climb to one and anybody who can open the playlist
    // reads its name and frames.
    sprayClimbVisibilityCondition(
      { boardType: tables.climbs.boardType, layoutId: tables.climbs.layoutId },
      viewerUserId,
    ),
  ];

  // Layout, size and hold-set scope — `playlistBoardScopeConditions` explains
  // the MoonBoard size guard (#3891) and why a NULL `required_set_ids` passes
  // here. Shared with the view's "fits the active board" gate, so the two
  // cannot disagree about what fits.
  climbJoinConditions.push(
    ...playlistBoardScopeConditions({
      boardName,
      layoutId: input.layoutId,
      sizeId: input.sizeId,
      setIds: input.setIds == null ? [] : parseSetIds(input.setIds),
    }),
  );

  return climbJoinConditions;
}

function requireBoardName(boardName: string | undefined): BoardName {
  if (boardName == null || !isValidBoardName(boardName)) {
    throw new Error(`Invalid board name: ${String(boardName)}. Must be one of: ${SUPPORTED_BOARDS.join(', ')}`);
  }
  return boardName;
}

/**
 * Specific-board hydration: the caller's angle is the wall the user is standing
 * at, so it applies to every row and is reported back verbatim. Without one,
 * fall back per row to the climb's added-at angle, mirroring the all-boards path.
 */
function specificBoardHydrateOptions(
  input: PlaylistBoardInput,
  boardName: BoardName,
  items: ReadonlyArray<Pick<PlaylistRefRow, 'climbUuid' | 'playlistAngle'>>,
): HydrateClimbsOptions {
  if (input.angle != null) return { wallAngle: input.angle };
  const angleOverrides = new Map<string, number | null>();
  for (const row of items) {
    angleOverrides.set(`${boardName}:${row.climbUuid}`, row.playlistAngle ?? null);
  }
  return { angleOverrides };
}

/**
 * All-boards visibility, applied BEFORE offset/limit and on the COUNT too. The
 * hydrate step drops an inaccessible spray climb, so filtering only there left
 * pages short (a 20-row page arriving with 17) and the count inflated by rows the
 * caller can never reach. The specific-board path applies the same rules in its
 * join for the same reason.
 */
function allBoardsWhereConditions(playlistId: bigint, viewerUserId: string | null | undefined): SQL[] {
  return [
    eq(dbSchema.playlistClimbs.playlistId, playlistId),
    climbDraftVisibilityCondition(
      { userId: dbSchema.boardClimbs.userId, isDraft: dbSchema.boardClimbs.isDraft },
      viewerUserId,
    ),
    sprayClimbVisibilityCondition(
      { boardType: UNIFIED_TABLES.climbs.boardType, layoutId: UNIFIED_TABLES.climbs.layoutId },
      viewerUserId,
    ),
  ];
}

/**
 * All-boards hydration: climbs on the active board render their grade at the
 * user's selected angle; every other climb keeps its added-at angle
 * (most-ascents when null). The hydrator drops back to most-ascents if a climb
 * has no stats at the override angle, so the selected angle never blanks a grade.
 */
function allBoardsHydrateOptions(
  input: PlaylistBoardInput,
  items: ReadonlyArray<PlaylistRefRow>,
): HydrateClimbsOptions {
  const { activeBoardName, activeAngle } = input;
  const angleOverrides = new Map<string, number | null>();
  for (const row of items) {
    const useActiveAngle = activeBoardName != null && activeAngle != null && row.boardType === activeBoardName;
    angleOverrides.set(`${row.boardType}:${row.climbUuid}`, useActiveAngle ? activeAngle : (row.playlistAngle ?? null));
  }
  return { angleOverrides };
}

/**
 * Specific-board mode: fetch climbs filtered by board type, layout, and size edges.
 *
 * Same two-step shape as the all-boards path: read the page of refs from
 * playlistClimbs (with the board/layout/size filters on the join), then hand
 * them to the shared hydrator, which joins stats/grades at the requested angle
 * and falls back to the most-ascended angle when the climb has no stats there
 * — so the selected angle never blanks a grade. The returned `angle` still
 * reports the requested wall angle: these climbs go straight into the queue on
 * playlist activation, and the tick badge, the board-presence report and the
 * logged ascent all read `climb.angle` as the wall in front of the user.
 *
 * `totalCount` is computed with the exact same join conditions as the ref-rows
 * query (#4000) — before this fix it counted every `playlist_climbs` row for
 * the playlist regardless of board/layout/size/set scope, so it could report a
 * higher count than `climbs` could ever page through.
 */
async function fetchSpecificBoardClimbs(
  playlistId: bigint,
  input: PlaylistClimbsInput,
  page: number,
  pageSize: number,
  viewerUserId: string | null | undefined,
): Promise<PlaylistClimbsPage> {
  const boardName = requireBoardName(input.boardName);

  const tables = UNIFIED_TABLES;
  const climbJoinConditions = buildSpecificBoardClimbJoinConditions(tables, boardName, input, viewerUserId);

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dbSchema.playlistClimbs)
    .innerJoin(tables.climbs, and(...climbJoinConditions))
    .where(eq(dbSchema.playlistClimbs.playlistId, playlistId));

  const totalCount = countResult?.count ?? 0;

  const refRows = await db
    .select({
      climbUuid: dbSchema.playlistClimbs.climbUuid,
      playlistAngle: dbSchema.playlistClimbs.angle,
    })
    .from(dbSchema.playlistClimbs)
    .innerJoin(tables.climbs, and(...climbJoinConditions))
    .where(eq(dbSchema.playlistClimbs.playlistId, playlistId))
    .orderBy(asc(dbSchema.playlistClimbs.position), asc(dbSchema.playlistClimbs.addedAt))
    .limit(pageSize + 1)
    .offset(page * pageSize);

  const { items, hasMore } = paginateResults(refRows, pageSize);

  const climbs = await hydrateClimbsByRefs(
    items.map((row) => ({ climbUuid: row.climbUuid, boardType: boardName })),
    { ...specificBoardHydrateOptions(input, boardName, items), viewerUserId },
  );

  return { climbs, totalCount, hasMore };
}

/**
 * All-boards mode: fetch climbs across all board types.
 *
 * Two-step: first read the page of refs (uuid + boardType + per-row angle
 * override) from playlistClimbs in position order, then hand them to the
 * shared hydrator which owns the climbs/climbStats join. Lets schema changes
 * to climbStats live in exactly one file (`helpers/hydrate-climbs.ts`).
 *
 * `totalCount` is computed with the same inner join to `climbs` the ref-rows
 * query uses (#4000), rather than a bare `playlist_climbs` row count. A stale
 * playlist row whose `climb_uuid` no longer resolves is excluded from both
 * results, so the count cannot exceed what paging through `climbs` can return.
 * That exclusion is also why `reorderPlaylistClimb` translates the client's
 * `newIndex` out of this (shorter) rendered list before splicing (#4012).
 *
 * The join keys on `uuid` alone, without a `board_type` predicate — unlike the
 * specific-board path, which has a board to filter to. That is safe because
 * `board_climbs.uuid` is the table's PRIMARY KEY, so a uuid names at most one
 * climb across every board: the join cannot fan one playlist row into several
 * page rows (which would break `pageSize + 1` paging), and it already rides the
 * PK index. `playlist_climbs` therefore doesn't need to persist `board_type`
 * (#4012). `playlist-climbs-uuid-join-invariant.test.ts` pins that key shape so
 * a move to a composite `(board_type, uuid)` PK fails there rather than here.
 */
async function fetchAllBoardsClimbs(
  playlistId: bigint,
  input: PlaylistClimbsInput,
  page: number,
  pageSize: number,
  viewerUserId: string | null | undefined,
): Promise<PlaylistClimbsPage> {
  const tables = UNIFIED_TABLES;

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dbSchema.playlistClimbs)
    .innerJoin(tables.climbs, eq(tables.climbs.uuid, dbSchema.playlistClimbs.climbUuid))
    .where(and(...allBoardsWhereConditions(playlistId, viewerUserId)));

  const totalCount = countResult?.count ?? 0;

  const refRows = await db
    .select({
      climbUuid: dbSchema.playlistClimbs.climbUuid,
      boardType: tables.climbs.boardType,
      playlistAngle: dbSchema.playlistClimbs.angle,
    })
    .from(dbSchema.playlistClimbs)
    .innerJoin(tables.climbs, eq(tables.climbs.uuid, dbSchema.playlistClimbs.climbUuid))
    .where(and(...allBoardsWhereConditions(playlistId, viewerUserId)))
    .orderBy(asc(dbSchema.playlistClimbs.position), asc(dbSchema.playlistClimbs.addedAt))
    .limit(pageSize + 1)
    .offset(page * pageSize);

  const { items, hasMore } = paginateResults(refRows, pageSize);

  const climbs = await hydrateClimbsByRefs(
    items.map((row) => ({ climbUuid: row.climbUuid, boardType: row.boardType })),
    { ...allBoardsHydrateOptions(input, items), viewerUserId },
  );

  return { climbs, totalCount, hasMore };
}

// ---------------------------------------------------------------------------
// Views (#6651): sort and filter a playlist's climbs on the server, over the
// whole playlist, so the list, the play drawer's track and Add to queue all see
// one order.
// ---------------------------------------------------------------------------

/**
 * One request's board scope, shared by every query the view path runs: how
 * `board_climbs` joins the playlist, which rows the caller may see (the same
 * join and visibility the playlist-order path uses, so a view only narrows),
 * the angle each row displays, and the board the active-board filters read.
 */
export type PlaylistScope = {
  climbJoin: SQL;
  where: SQL;
  /** The angle a row would like to display, before the stats guard of `displayStatsAngleSql`. */
  preferredAngle: SQL;
  activeBoard: PlaylistActiveBoard | null;
  hydrateOptions: (items: ReadonlyArray<PlaylistRefRow>) => HydrateClimbsOptions;
};

export function specificBoardScope(
  playlistId: bigint,
  input: PlaylistBoardInput,
  viewerUserId: string | null | undefined,
): PlaylistScope {
  const boardName = requireBoardName(input.boardName);
  return {
    climbJoin: and(...buildSpecificBoardClimbJoinConditions(UNIFIED_TABLES, boardName, input, viewerUserId))!,
    where: eq(dbSchema.playlistClimbs.playlistId, playlistId),
    // The hydrator's rule, as SQL: the wall angle for every row, or each row's
    // added-at angle when the caller sent none.
    preferredAngle: input.angle != null ? sql`${input.angle}::int` : sql`${dbSchema.playlistClimbs.angle}`,
    activeBoard: {
      boardName,
      layoutId: input.layoutId ?? null,
      sizeId: input.sizeId ?? null,
      setIds: input.setIds == null ? [] : parseSetIds(input.setIds),
      angle: input.angle ?? null,
    },
    hydrateOptions: (items) => specificBoardHydrateOptions(input, boardName, items),
  };
}

export function allBoardsScope(
  playlistId: bigint,
  input: PlaylistBoardInput,
  viewerUserId: string | null | undefined,
): PlaylistScope {
  const { activeBoardName, activeAngle } = input;
  const activeBoardType = activeBoardName != null && isValidBoardName(activeBoardName) ? activeBoardName : null;
  return {
    climbJoin: eq(UNIFIED_TABLES.climbs.uuid, dbSchema.playlistClimbs.climbUuid),
    where: and(...allBoardsWhereConditions(playlistId, viewerUserId))!,
    // `allBoardsHydrateOptions` as SQL: the active angle on the active board's
    // type, the added-at angle everywhere else.
    preferredAngle:
      activeBoardType != null && activeAngle != null
        ? sql`CASE WHEN ${UNIFIED_TABLES.climbs.boardType} = ${activeBoardType} THEN ${activeAngle}::int ELSE ${dbSchema.playlistClimbs.angle} END`
        : sql`${dbSchema.playlistClimbs.angle}`,
    activeBoard:
      activeBoardType == null
        ? null
        : {
            boardName: activeBoardType,
            layoutId: input.activeLayoutId ?? null,
            sizeId: input.activeSizeId ?? null,
            setIds: input.activeSetIds == null ? [] : parseSetIds(input.activeSetIds),
            angle: activeAngle ?? null,
          },
    hydrateOptions: (items) => allBoardsHydrateOptions(input, items),
  };
}

/**
 * The view's filter fields as search params, through the climb search's own
 * mapper so a filter reads the same in a playlist as on the Climbs list.
 *
 * Personal grades and the grade source only matter to a grade band or the
 * difficulty sort (the client's `toSharedClimbFilterInputFields` sends them on
 * the same rule), so they are dropped otherwise and no personal-grade join is
 * built for nothing.
 */
function toPlaylistFilterParams(view: ParsedPlaylistClimbView, sortBy: PlaylistSortOption): PlaylistFilterParams {
  const sortsByDifficulty = sortBy === 'difficulty';
  const gradeBoundSet = !!view.minGrade || !!view.maxGrade;
  const searchParams = mapSearchInputToParams({
    ...view,
    // The playlist's own sort is read from the view; the mapper only needs to
    // know whether the difficulty sort keeps the grade source.
    sortBy: sortsByDifficulty ? 'difficulty' : null,
    useMyGrades: view.useMyGrades && (gradeBoundSet || sortsByDifficulty) ? true : undefined,
  });
  return { ...searchParams, onlyActiveBoard: view.onlyActiveBoard || undefined };
}

/**
 * ORDER BY for a view. Every order ends on `playlist_climbs.id`, which is unique,
 * so OFFSET paging can neither repeat nor skip a row; the ranked sorts break
 * ties in playlist order first, so equal grades keep the owner's order.
 */
function viewOrderBy(
  sortBy: PlaylistSortOption,
  sortOrder: string,
  filterParams: PlaylistFilterParams,
  personalGrades: boolean,
): SQL[] {
  const playlistRows = dbSchema.playlistClimbs;
  const playlistOrder = [asc(playlistRows.position), asc(playlistRows.addedAt), asc(playlistRows.id)];
  switch (sortBy) {
    case 'position':
      return sortOrder === 'desc'
        ? [desc(playlistRows.position), desc(playlistRows.addedAt), desc(playlistRows.id)]
        : playlistOrder;
    case 'added':
      return sortOrder === 'asc'
        ? [asc(playlistRows.addedAt), asc(playlistRows.id)]
        : [desc(playlistRows.addedAt), desc(playlistRows.id)];
    case 'random':
      return [sql`${randomSortKeySql(filterParams.sortSeed)} ASC`, asc(playlistRows.id)];
    case 'difficulty':
    case 'quality':
    case 'ascents':
    case 'name': {
      const sortColumns = climbSortColumns({
        crossAngle: false,
        gradeSource: filterParams.gradeSource,
        personalGrades,
      });
      return [directedSortSql(sortColumns[sortBy], sortOrder), ...playlistOrder];
    }
  }
}

/**
 * The three queries a view page runs, built on `executor` and not yet awaited.
 * Exported so the EXPLAIN harness (`playlist-climbs-view-explain.test.ts`) can
 * plan exactly what runs here against a full-data database.
 *
 * One stats row per playlist row, at the angle the row DISPLAYS
 * (`displayStatsAngleSql` over the scope's preferred angle — the rule the
 * hydrator applies), so the grade filter and the difficulty sort read exactly
 * the grade the row shows. The Boardsesh grade is read at that angle, or at the
 * preferred angle when the climb has no stats row there (the Climbs list's
 * `gradeJoinAngleSql` fallback), so a climb graded only by the model still has a
 * grade to filter and sort on. Both are LATERAL lookups named after their tables,
 * so the climb search's own predicates and sort keys (`effectiveStatsColumn`
 * without cross-angle, `gradeValueSql`) apply unchanged.
 *
 * `countQuery` runs the same WHERE over the same rows, so it is also the live
 * match count. `unfilteredCountQuery` is the playlist-order count, built only
 * when the view filters (a sort alone leaves the count as it was).
 */
export function buildPlaylistViewQueries(
  executor: SerialPlanDb,
  scope: PlaylistScope,
  view: ParsedPlaylistClimbView,
  page: number,
  pageSize: number,
  viewerUserId: string | null | undefined,
) {
  const tables = UNIFIED_TABLES;
  const grades = dbSchema.boardClimbGrades;
  const sortBy: PlaylistSortOption = view.sortBy ?? 'position';
  const sortOrder = view.sortOrder ?? PLAYLIST_SORT_DEFAULT_ORDER[sortBy];
  const filterParams = toPlaylistFilterParams(view, sortBy);
  const filters = createPlaylistClimbFilters(scope.activeBoard, filterParams, viewerUserId ?? undefined);
  const personalGradeJoin = filters.personalGradeJoin;

  const sortReadsGrades = sortBy === 'difficulty' && filterParams.gradeSource === 'boardsesh';
  const sortReadsStats = sortBy === 'difficulty' || sortBy === 'quality' || sortBy === 'ascents';
  // The list joins whatever its WHERE or ORDER BY reads, and the grade row
  // whenever it has the stats row, so the hydrator is handed the grade angle the
  // filters would use. The count joins only what its WHERE reads. Every join is
  // a LEFT JOIN to at most one row, so leaving one out of the count cannot
  // change it. The grade lookup reads the stats row's angle, so it always comes
  // with the stats lookup.
  const listStats = filters.needsStats || filters.needsGrades || sortReadsStats || sortReadsGrades;
  const listJoins = { stats: listStats, grades: listStats, personalGrade: personalGradeJoin !== null };
  const countJoins = {
    stats: filters.needsStats || filters.needsGrades,
    grades: filters.needsGrades,
    // Among the filters only the grade band reads the personal grade.
    personalGrade: personalGradeJoin !== null && filters.needsGrades,
  };

  // The display row as a LATERAL lookup, one primary-key probe per playlist row.
  // A plain LEFT JOIN on the same condition let the planner hash the whole stats
  // table instead (measured: a full scan of board_climb_stats for a 600-climb
  // playlist), and that table holds every climb at every angle. Named
  // `board_climb_stats` so every `"board_climb_stats"."<column>"` reference
  // outside resolves to this one row; inside, the same name is the table.
  const displayStatsRow = new QueryBuilder()
    .select()
    .from(tables.climbStats)
    .where(
      and(
        eq(tables.climbStats.boardType, tables.climbs.boardType),
        eq(tables.climbStats.climbUuid, tables.climbs.uuid),
        eq(tables.climbStats.angle, displayStatsAngleSql(angleWithStatsSql(scope.preferredAngle))),
      ),
    )
    .limit(1)
    .as(getTableName(tables.climbStats));
  // The grade angle: the stats row's, else the preferred angle. Reads the
  // lateral stats row above, so the grade lookup must come after it.
  const gradeAngle = sql<number | null>`COALESCE(${tables.climbStats.angle}, ${scope.preferredAngle})`;
  // Same LATERAL shape for the grades table (1.3 GB in production): a primary-key
  // probe per row, never a hash over the table.
  const displayGradeRow = new QueryBuilder()
    .select()
    .from(grades)
    .where(
      and(
        eq(grades.boardType, tables.climbs.boardType),
        eq(grades.climbUuid, tables.climbs.uuid),
        eq(grades.angle, gradeAngle),
      ),
    )
    .limit(1)
    .as(getTableName(grades));

  // Every column the queries select comes from `playlist_climbs` or the inner
  // `board_climbs` join, or is a typed `sql` expression, so these LEFT JOINs
  // leave the row type as it was; the cast back only restores that.
  function withViewJoins<Query extends PgSelect>(query: Query, joins: typeof listJoins): Query {
    let joined: PgSelect = query;
    if (joins.stats) joined = joined.leftJoinLateral(displayStatsRow, sql`true`);
    if (joins.grades) joined = joined.leftJoinLateral(displayGradeRow, sql`true`);
    if (joins.personalGrade && personalGradeJoin) {
      joined = joined.leftJoin(personalGradeJoin.subquery, personalGradeJoin.on);
    }
    return joined as Query;
  }

  const filteredWhere = and(scope.where, ...filters.allRows, ...filters.activeBoardOnly)!;

  const countQuery = withViewJoins(
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(dbSchema.playlistClimbs)
      .innerJoin(tables.climbs, scope.climbJoin)
      .$dynamic(),
    countJoins,
  ).where(filteredWhere);

  const unfilteredCountQuery = filters.hasFilters
    ? executor
        .select({ count: sql<number>`count(*)::int` })
        .from(dbSchema.playlistClimbs)
        .innerJoin(tables.climbs, scope.climbJoin)
        .where(scope.where)
    : null;

  const nullInt = sql<number | null>`NULL::int`;
  const refQuery = withViewJoins(
    executor
      .select({
        climbUuid: dbSchema.playlistClimbs.climbUuid,
        boardType: tables.climbs.boardType,
        playlistAngle: dbSchema.playlistClimbs.angle,
        statsAngle: listJoins.stats ? sql<number | null>`${tables.climbStats.angle}` : nullInt,
        gradeAngle: listJoins.grades ? gradeAngle : nullInt,
        myDifficulty: personalGradeJoin ? sql<number | null>`${personalGradeColumnSql()}` : nullInt,
      })
      .from(dbSchema.playlistClimbs)
      .innerJoin(tables.climbs, scope.climbJoin)
      .$dynamic(),
    listJoins,
  )
    .where(filteredWhere)
    .orderBy(...viewOrderBy(sortBy, sortOrder, filterParams, personalGradeJoin !== null))
    .limit(pageSize + 1)
    .offset(page * pageSize);

  return { countQuery, unfilteredCountQuery, refQuery, listJoins, personalGrades: personalGradeJoin !== null };
}

/**
 * A playlist page under a view: `buildPlaylistViewQueries`, run under the
 * serial-plan guard, then hydrated with the angles the page was sorted and
 * filtered by.
 */
async function fetchViewClimbs(
  scope: PlaylistScope,
  view: ParsedPlaylistClimbView,
  page: number,
  pageSize: number,
  viewerUserId: string | null | undefined,
): Promise<PlaylistClimbsPage> {
  // One transaction, so one pooled connection for the three queries, with
  // per-gather parallelism off: the view joins board_climb_stats and
  // board_climb_grades per playlist row, the shape whose parallel plans
  // exhausted /dev/shm in production (pgCode 53100, #4235). See `withSerialPlan`.
  const { countRows, unfilteredRows, refRows, listJoins, personalGrades } = await withSerialPlan(db, async (tx) => {
    const queries = buildPlaylistViewQueries(tx, scope, view, page, pageSize, viewerUserId);
    return {
      countRows: await queries.countQuery,
      unfilteredRows: queries.unfilteredCountQuery ? await queries.unfilteredCountQuery : null,
      refRows: await queries.refQuery,
      listJoins: queries.listJoins,
      personalGrades: queries.personalGrades,
    };
  });

  const { items, hasMore } = paginateResults(refRows, pageSize);
  const refKey = (row: PlaylistRefRow) => `${row.boardType}:${row.climbUuid}`;

  const hydrateOptions: HydrateClimbsOptions = { ...scope.hydrateOptions(items), viewerUserId };
  if (listJoins.stats) {
    hydrateOptions.resolvedAngles = new Map(
      items.map((row) => [refKey(row), { statsAngle: row.statsAngle ?? null, gradeAngle: row.gradeAngle ?? null }]),
    );
  }
  if (personalGrades) {
    hydrateOptions.myDifficulties = new Map(items.map((row) => [refKey(row), row.myDifficulty ?? null]));
  }
  const climbs = await hydrateClimbsByRefs(
    items.map((row) => ({ climbUuid: row.climbUuid, boardType: row.boardType })),
    hydrateOptions,
  );

  return {
    climbs,
    totalCount: countRows[0]?.count ?? 0,
    unfilteredCount: unfilteredRows ? (unfilteredRows[0]?.count ?? 0) : null,
    hasMore,
  };
}

/**
 * Get climbs in a playlist with full climb data.
 * Supports specific-board mode (boardName provided) or all-boards mode (boardName omitted).
 *
 * `totalCount` is delegated to whichever branch runs, since each computes it
 * with the same join conditions its own `climbs` query applies (#4000) — a
 * playlist-wide count here would ignore the board/layout/size scoping the
 * specific-board branch imposes and could report more than `climbs` could
 * ever page through.
 *
 * Without a `view` this runs exactly the queries it ran before views existed.
 */
export const playlistClimbs = async (
  _: unknown,
  { input }: { input: PlaylistClimbsInput },
  ctx: ConnectionContext,
): Promise<PlaylistClimbsPage> => {
  const parsedInput = validateInput(GetPlaylistClimbsInputSchema, input, 'input');

  const page = input.page ?? 0;
  const pageSize = input.pageSize ?? 20;

  // A view sorts the whole playlist before it pages, and the play drawer pages
  // it as the climber swipes: the same cadence and budget as searchClimbs, and
  // charged before any database work, as there.
  if (parsedInput.view) await applyRateLimit(ctx, 120, 'playlist-climbs-view');

  // Verify access (throws if denied)
  const playlistId = await verifyPlaylistAccess(input.playlistId, ctx.userId ?? null);

  if (!parsedInput.view) {
    return input.boardName
      ? fetchSpecificBoardClimbs(playlistId, input, page, pageSize, ctx.userId)
      : fetchAllBoardsClimbs(playlistId, input, page, pageSize, ctx.userId);
  }

  const scope = parsedInput.boardName
    ? specificBoardScope(playlistId, parsedInput, ctx.userId)
    : allBoardsScope(playlistId, parsedInput, ctx.userId);
  return fetchViewClimbs(scope, parsedInput.view, page, pageSize, ctx.userId);
};
