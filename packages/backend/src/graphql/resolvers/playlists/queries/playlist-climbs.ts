import { eq, and, asc, desc, sql, type SQL } from 'drizzle-orm';
import {
  type ConnectionContext,
  type BoardName,
  type PlaylistClimbViewInput,
  SUPPORTED_BOARDS,
} from '@boardsesh/shared-schema';
import { parseSetIds } from '@boardsesh/board-config';
import { db } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import {
  climbDraftVisibilityCondition,
  playlistBoardScopeConditions,
  sprayClimbVisibilityCondition,
} from '@boardsesh/db/queries';
import { applyRateLimit, validateInput } from '../../shared/helpers';
import { GetPlaylistClimbsInputSchema } from '../../../../validation/schemas';
import { UNIFIED_TABLES, isValidBoardName } from '../../../../db/queries/util/table-select';
import { verifyPlaylistAccess } from '../helpers/enrichment';
import { hydrateClimbsByRefs, type HydrateClimbsOptions } from '../helpers/hydrate-climbs';
import {
  activeBoardFromFields,
  allBoardsHydrateOptions,
  fetchPlaylistView,
  paginateResults,
  type PlaylistPage,
  type PlaylistRefRow,
  type PlaylistViewOrder,
  type PlaylistViewSource,
} from '../helpers/playlist-view';

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
): Promise<PlaylistPage> {
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
): Promise<PlaylistPage> {
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
// Views (#6651): the playlist's rows as a `PlaylistViewSource`, for the shared
// view builder in `helpers/playlist-view.ts`.
// ---------------------------------------------------------------------------

/**
 * A playlist's own orders: `position` (then added-at) as the owner arranged it,
 * `added` the time each climb was added. Both end on `playlist_climbs.id`,
 * which is unique.
 */
const PLAYLIST_ORDER: PlaylistViewOrder = {
  own: (direction) => {
    const directed = direction === 'desc' ? desc : asc;
    const playlistRows = dbSchema.playlistClimbs;
    return [directed(playlistRows.position), directed(playlistRows.addedAt), directed(playlistRows.id)];
  },
  added: (direction) => {
    const directed = direction === 'asc' ? asc : desc;
    return [directed(dbSchema.playlistClimbs.addedAt), directed(dbSchema.playlistClimbs.id)];
  },
  unique: [asc(dbSchema.playlistClimbs.id)],
};

/** The playlist-row half of every playlist source: its rows, their columns and orders. */
const PLAYLIST_ROWS = {
  rows: dbSchema.playlistClimbs,
  refColumns: {
    climbUuid: sql<string>`${dbSchema.playlistClimbs.climbUuid}`,
    playlistAngle: sql<number | null>`${dbSchema.playlistClimbs.angle}`,
  },
  order: PLAYLIST_ORDER,
} satisfies Partial<PlaylistViewSource>;

/**
 * One request's board scope as a view source: the same join and visibility the
 * playlist-order path uses (so a view only narrows), the angle each row
 * displays, and the board the active-board filters read.
 */
export function specificBoardScope(
  playlistId: bigint,
  input: PlaylistBoardInput,
  viewerUserId: string | null | undefined,
): PlaylistViewSource {
  const boardName = requireBoardName(input.boardName);
  return {
    ...PLAYLIST_ROWS,
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
): PlaylistViewSource {
  const { activeAngle } = input;
  const activeBoard = activeBoardFromFields(input);
  return {
    ...PLAYLIST_ROWS,
    climbJoin: eq(UNIFIED_TABLES.climbs.uuid, dbSchema.playlistClimbs.climbUuid),
    where: and(...allBoardsWhereConditions(playlistId, viewerUserId))!,
    // `allBoardsHydrateOptions` as SQL: the active angle on the active board's
    // type, the added-at angle everywhere else.
    preferredAngle:
      activeBoard != null && activeAngle != null
        ? sql`CASE WHEN ${UNIFIED_TABLES.climbs.boardType} = ${activeBoard.boardName} THEN ${activeAngle}::int ELSE ${dbSchema.playlistClimbs.angle} END`
        : sql`${dbSchema.playlistClimbs.angle}`,
    activeBoard,
    hydrateOptions: (items) => allBoardsHydrateOptions(input, items),
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
): Promise<PlaylistPage> => {
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
    // The raw input on purpose: this is the pre-view path, byte for byte, and
    // its fetchers read only fields the schema passes through unchanged.
    return input.boardName
      ? fetchSpecificBoardClimbs(playlistId, input, page, pageSize, ctx.userId)
      : fetchAllBoardsClimbs(playlistId, input, page, pageSize, ctx.userId);
  }

  const scope = parsedInput.boardName
    ? specificBoardScope(playlistId, parsedInput, ctx.userId)
    : allBoardsScope(playlistId, parsedInput, ctx.userId);
  return fetchPlaylistView(scope, parsedInput.view, page, pageSize, ctx.userId);
};
