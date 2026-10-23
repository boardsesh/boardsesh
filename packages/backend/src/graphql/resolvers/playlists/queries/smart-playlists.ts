import { tickPrivacyCondition } from '../../shared/activity-privacy';
import { canViewUserActivity } from '../../../../services/privacy';
import { eq, and, desc, sql, max, type SQL } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { GraphQLError } from 'graphql';
import { type ConnectionContext, type Climb, type PlaylistClimbViewInput } from '@boardsesh/shared-schema';
import {
  climbDraftVisibilityCondition,
  climbReferenceReadableCondition,
  isRecommendationType,
  RECOMMENDATION_TYPES,
  sprayClimbVisibilityCondition,
  withSerialPlan,
  type RecommendationType,
} from '@boardsesh/db/queries';
import { db } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { sprayReferenceClimbExistsCondition, sprayReferenceVisibilityCondition } from '@boardsesh/db/queries';
import { applyRateLimit, requireAuthenticated, validateInput } from '../../shared/helpers';
import { GetSmartPlaylistInputSchema } from '../../../../validation/schemas';
import { UNIFIED_TABLES } from '../../../../db/queries/util/table-select';
import { hydrateClimbsByRefs, type ClimbRef } from '../helpers/hydrate-climbs';
import { resolveRecommendationBoardTarget } from '../helpers/recommendation-board-target';
import {
  selectRecommendationClimbRefs,
  countRecommendationClimbRefs,
  countRecommendationCardClimbs,
} from '../helpers/recommendation-refs';
import {
  activeBoardFromFields,
  allBoardsHydrateOptions,
  fetchPlaylistView,
  naturalRankOrder,
  type ActiveBoardFields,
  type PlaylistPage,
  type PlaylistViewSource,
} from '../helpers/playlist-view';

// Logbook-derived smart playlists (computed from the user's own ticks).
export type LogbookPlaylistType = 'FIVE_STARS' | 'MOST_REPEATED' | 'PROJECTS' | 'LIKED_CLIMBS';
// Catalog-derived recommendations (computed for the user's board) share the
// same query envelope but a different candidate source.
type SmartPlaylistType = LogbookPlaylistType | RecommendationType;

type SmartPlaylistInput = ActiveBoardFields & {
  type: SmartPlaylistType;
  userId: string;
  boardName?: string;
  /** The specific owned board to recommend for; ignored by logbook playlists. */
  boardUuid?: string;
  /** Browsing-context overrides for recommendation types (a board the user is
   * viewing); ignored by logbook playlists. */
  sizeId?: number;
  angle?: number;
  /**
   * Sort and filters (#6651), on the logbook types only: a recommendation is
   * already ranked for the climber and rejects one. Omitted means the list's own
   * order, unfiltered, and exactly the queries this resolver ran before views
   * existed. The active* fields are the board its active-board filters read.
   */
  view?: PlaylistClimbViewInput;
  page?: number;
  pageSize?: number;
};

type SmartPlaylistMeta = {
  type: SmartPlaylistType;
  userId: string;
  userName: string;
  userAvatar: string | null;
  climbCount: number;
};

type SmartPlaylistPage = {
  meta: SmartPlaylistMeta;
  climbs: Climb[];
  totalCount: number;
  /** Only under a filtering view: the list's count with no view filter applied. */
  unfilteredCount?: number | null;
  hasMore: boolean;
};

type SmartClimbRef = ClimbRef;

/**
 * Build the WHERE conditions shared by every smart-playlist query path:
 * `userId = ?` plus, when scoped, `boardType = ?`.
 */
function smartBaseConditions(
  userId: string,
  boardName: string | undefined,
  viewerUserId: string | null | undefined,
): SQL[] {
  const conditions: SQL[] = [
    eq(dbSchema.boardseshTicks.userId, userId),
    tickPrivacyCondition(viewerUserId, dbSchema.boardseshTicks),
  ];
  if (boardName) {
    conditions.push(eq(dbSchema.boardseshTicks.boardType, boardName));
  }
  // BEFORE the LIMIT/OFFSET these conditions feed, and on the count built from the
  // same list. Filtering only at the hydrate step let a private wall's ticks consume
  // page slots and inflate `totalCount` / `hasMore`, so another viewer got short or
  // empty pages of somebody else's logbook.
  conditions.push(
    sprayReferenceVisibilityCondition(
      { boardType: dbSchema.boardseshTicks.boardType, climbUuid: dbSchema.boardseshTicks.climbUuid },
      viewerUserId,
    ),
    sprayReferenceClimbExistsCondition(
      { boardType: dbSchema.boardseshTicks.boardType, climbUuid: dbSchema.boardseshTicks.climbUuid },
      { authorId: dbSchema.boardseshTicks.userId, viewerUserId },
    ),
  );
  return conditions;
}

/**
 * The LIKED_CLIMBS rows: `userId`'s hearts on climbs the viewer may read, on
 * `boardName` when scoped. Favourites are the other reference source, so they
 * carry the spray-wall rules `smartBaseConditions` gives the logbook, for the
 * same reason. Shared by the paged query, its count and the view's rows.
 */
function favoriteConditions(
  userId: string,
  boardName: string | undefined,
  viewerUserId: string | null | undefined,
): SQL[] {
  const conditions: SQL[] = [
    eq(dbSchema.userFavorites.userId, userId),
    climbReferenceReadableCondition(
      { boardType: dbSchema.userFavorites.boardName, climbUuid: dbSchema.userFavorites.climbUuid },
      viewerUserId,
    ),
    sprayReferenceVisibilityCondition(
      { boardType: dbSchema.userFavorites.boardName, climbUuid: dbSchema.userFavorites.climbUuid },
      viewerUserId,
    ),
    sprayReferenceClimbExistsCondition(
      { boardType: dbSchema.userFavorites.boardName, climbUuid: dbSchema.userFavorites.climbUuid },
      { authorId: dbSchema.userFavorites.userId, viewerUserId },
    ),
  ];
  if (boardName) {
    conditions.push(eq(dbSchema.userFavorites.boardName, boardName));
  }
  return conditions;
}

/**
 * The PROJECTS rule: the user has logged the climb and never sent it. One row
 * per (board_type, climb_uuid) with the attempt total that orders the list,
 * kept only when none of the group's ticks is a flash or send.
 *
 * Grouped on both columns rather than `climb_uuid` alone, so a sent Kilter climb
 * never stands in for a Tension climb that shares its uuid. The sends are read
 * through the same `conditions` as the attempts, so a send the viewer may not
 * see does not decide what they are shown.
 */
function projectClimbsSubquery(conditions: SQL[]) {
  return db
    .select({
      climbUuid: dbSchema.boardseshTicks.climbUuid,
      boardType: dbSchema.boardseshTicks.boardType,
      total: sql<number>`SUM(${dbSchema.boardseshTicks.attemptCount})::int`.as('total'),
    })
    .from(dbSchema.boardseshTicks)
    .where(and(...conditions))
    .groupBy(dbSchema.boardseshTicks.climbUuid, dbSchema.boardseshTicks.boardType)
    .having(sql`NOT bool_or(${dbSchema.boardseshTicks.status} IN ('flash', 'send'))`)
    .as('projects');
}

/**
 * Page of (climbUuid, boardType) pairs for the smart playlist, ordered by the
 * type's natural ranking (latest 5-star, most attempts, etc.). Pagination is
 * pushed into the database — we never materialize the full list in memory.
 */
async function selectSmartClimbRefs(
  type: LogbookPlaylistType,
  userId: string,
  boardName: string | undefined,
  page: number,
  pageSize: number,
  viewerUserId: string | null | undefined,
): Promise<SmartClimbRef[]> {
  const conditions = smartBaseConditions(userId, boardName, viewerUserId);
  const offset = page * pageSize;

  if (type === 'FIVE_STARS') {
    const rows = await db
      .select({
        climbUuid: dbSchema.boardseshTicks.climbUuid,
        boardType: dbSchema.boardseshTicks.boardType,
        latestClimbedAt: max(dbSchema.boardseshTicks.climbedAt),
      })
      .from(dbSchema.boardseshTicks)
      .where(and(...conditions, eq(dbSchema.boardseshTicks.quality, 5)))
      .groupBy(dbSchema.boardseshTicks.climbUuid, dbSchema.boardseshTicks.boardType)
      .orderBy(desc(max(dbSchema.boardseshTicks.climbedAt)))
      .limit(pageSize)
      .offset(offset);
    return rows.map((row) => ({ climbUuid: row.climbUuid, boardType: row.boardType }));
  }

  if (type === 'MOST_REPEATED') {
    const rows = await db
      .select({
        climbUuid: dbSchema.boardseshTicks.climbUuid,
        boardType: dbSchema.boardseshTicks.boardType,
        total: sql<number>`SUM(${dbSchema.boardseshTicks.attemptCount})::int`,
      })
      .from(dbSchema.boardseshTicks)
      .where(and(...conditions))
      .groupBy(dbSchema.boardseshTicks.climbUuid, dbSchema.boardseshTicks.boardType)
      .having(sql`SUM(${dbSchema.boardseshTicks.attemptCount}) > 1`)
      .orderBy(desc(sql`SUM(${dbSchema.boardseshTicks.attemptCount})`))
      .limit(pageSize)
      .offset(offset);
    return rows.map((row) => ({ climbUuid: row.climbUuid, boardType: row.boardType }));
  }

  if (type === 'LIKED_CLIMBS') {
    const favConditions = favoriteConditions(userId, boardName, viewerUserId);
    const rows = await db
      .select({
        climbUuid: dbSchema.userFavorites.climbUuid,
        boardType: dbSchema.userFavorites.boardName,
      })
      .from(dbSchema.userFavorites)
      .where(and(...favConditions))
      .groupBy(dbSchema.userFavorites.climbUuid, dbSchema.userFavorites.boardName)
      .orderBy(desc(max(dbSchema.userFavorites.createdAt)))
      .limit(pageSize)
      .offset(offset);
    return rows.map((row) => ({ climbUuid: row.climbUuid, boardType: row.boardType }));
  }

  // PROJECTS — climbs the user has logged but never sent, most attempts first.
  const projects = projectClimbsSubquery(conditions);
  const rows = await db
    .select({ climbUuid: projects.climbUuid, boardType: projects.boardType })
    .from(projects)
    .orderBy(desc(projects.total))
    .limit(pageSize)
    .offset(offset);
  return rows.map((row) => ({ climbUuid: row.climbUuid, boardType: row.boardType }));
}

/**
 * Total number of climbs the smart playlist would contain. Computed against
 * the same conditions as selectSmartClimbRefs so that paging is consistent.
 */
async function countSmartClimbRefs(
  type: LogbookPlaylistType,
  userId: string,
  boardName: string | undefined,
  viewerUserId: string | null | undefined,
): Promise<number> {
  const conditions = smartBaseConditions(userId, boardName, viewerUserId);

  if (type === 'FIVE_STARS') {
    const [row] = await db
      .select({
        count: sql<number>`COUNT(DISTINCT (${dbSchema.boardseshTicks.boardType}, ${dbSchema.boardseshTicks.climbUuid}))::int`,
      })
      .from(dbSchema.boardseshTicks)
      .where(and(...conditions, eq(dbSchema.boardseshTicks.quality, 5)));
    return row?.count ?? 0;
  }

  if (type === 'MOST_REPEATED') {
    const subquery = db
      .select({
        climbUuid: dbSchema.boardseshTicks.climbUuid,
        boardType: dbSchema.boardseshTicks.boardType,
      })
      .from(dbSchema.boardseshTicks)
      .where(and(...conditions))
      .groupBy(dbSchema.boardseshTicks.climbUuid, dbSchema.boardseshTicks.boardType)
      .having(sql`SUM(${dbSchema.boardseshTicks.attemptCount}) > 1`)
      .as('repeated');
    const [row] = await db.select({ count: sql<number>`COUNT(*)::int` }).from(subquery);
    return row?.count ?? 0;
  }

  if (type === 'LIKED_CLIMBS') {
    const favConditions = favoriteConditions(userId, boardName, viewerUserId);
    const [row] = await db
      .select({
        count: sql<number>`COUNT(DISTINCT (${dbSchema.userFavorites.boardName}, ${dbSchema.userFavorites.climbUuid}))::int`,
      })
      .from(dbSchema.userFavorites)
      .where(and(...favConditions));
    return row?.count ?? 0;
  }

  const projects = projectClimbsSubquery(conditions);
  const [row] = await db.select({ count: sql<number>`COUNT(*)::int` }).from(projects);
  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Views (#6651): a logbook list's rows as a `PlaylistViewSource`, so its sort
// and filters run through the same builder as a playlist's
// (`helpers/playlist-view.ts`). Membership is the list's, unchanged: each type
// selects exactly the rows its paged query above would, with its own order kept
// as `natural_rank`.
//
// The recommendations take no view. They are already ranked for the climber,
// and a view sorts and filters the whole candidate set: about 33k climbs for
// Fresh on a Kilter, 2.1–2.8 s per filtered page on the dev DB.
// ---------------------------------------------------------------------------

/** The alias the view queries read a smart list's rows under. */
const SMART_ROWS = 'smart_refs';

function smartRowsColumn(column: 'climb_uuid' | 'board_type' | 'natural_rank'): SQL {
  return sql`${sql.identifier(SMART_ROWS)}.${sql.identifier(column)}`;
}

/**
 * The list's own order as a 1-based rank over every row. The paged queries
 * above order on the key alone; ties there come back in whatever order Postgres
 * picks, so the rank breaks them on the row key, which a view must have for
 * OFFSET paging to neither repeat nor skip a row.
 */
function naturalRankSql(order: SQL) {
  return sql<number>`ROW_NUMBER() OVER (ORDER BY ${order})`.as('natural_rank');
}

/**
 * A logbook type's rows as `(climb_uuid, board_type, natural_rank)`: the same
 * WHERE, GROUP BY and HAVING as `selectSmartClimbRefs`, unpaged, ranked by the
 * order that query pages in.
 */
function logbookRowsSql(
  type: LogbookPlaylistType,
  userId: string,
  boardName: string | undefined,
  viewerUserId: string | null | undefined,
): SQL {
  const queryBuilder = new QueryBuilder();
  const ticks = dbSchema.boardseshTicks;
  const tickKey = sql`${ticks.boardType}, ${ticks.climbUuid}`;

  if (type === 'LIKED_CLIMBS') {
    const favorites = dbSchema.userFavorites;
    return queryBuilder
      .select({
        climbUuid: favorites.climbUuid,
        boardType: sql<string>`${favorites.boardName}`.as('board_type'),
        // Most recently liked first: the like is when the climb entered the list.
        naturalRank: naturalRankSql(
          sql`max(${favorites.createdAt}) DESC, ${favorites.boardName}, ${favorites.climbUuid}`,
        ),
      })
      .from(favorites)
      .where(and(...favoriteConditions(userId, boardName, viewerUserId)))
      .groupBy(favorites.climbUuid, favorites.boardName)
      .getSQL();
  }

  const conditions = smartBaseConditions(userId, boardName, viewerUserId);

  if (type === 'FIVE_STARS') {
    return queryBuilder
      .select({
        climbUuid: ticks.climbUuid,
        boardType: ticks.boardType,
        // Latest five-star climb first.
        naturalRank: naturalRankSql(sql`max(${ticks.climbedAt}) DESC, ${tickKey}`),
      })
      .from(ticks)
      .where(and(...conditions, eq(ticks.quality, 5)))
      .groupBy(ticks.climbUuid, ticks.boardType)
      .getSQL();
  }

  if (type === 'MOST_REPEATED') {
    return queryBuilder
      .select({
        climbUuid: ticks.climbUuid,
        boardType: ticks.boardType,
        // Most attempts first.
        naturalRank: naturalRankSql(sql`SUM(${ticks.attemptCount}) DESC, ${tickKey}`),
      })
      .from(ticks)
      .where(and(...conditions))
      .groupBy(ticks.climbUuid, ticks.boardType)
      .having(sql`SUM(${ticks.attemptCount}) > 1`)
      .getSQL();
  }

  // PROJECTS — most attempts first.
  const projects = projectClimbsSubquery(conditions);
  return queryBuilder
    .select({
      climbUuid: projects.climbUuid,
      boardType: projects.boardType,
      naturalRank: naturalRankSql(sql`${projects.total} DESC, ${projects.boardType}, ${projects.climbUuid}`),
    })
    .from(projects)
    .getSQL();
}

/**
 * A logbook list under a view. A row on the active board's type displays, and
 * sorts and filters, at the active angle, the angle the app reads its live
 * stats at; any other row at its most-ascended angle, as without a view. The
 * active-board filters read the request's active* board. The hydrator's own visibility rules
 * (the draft rule and the spray-wall rule) apply before paging, so a row it
 * would drop never takes a page slot or a place in the counts: under a view,
 * `totalCount` is the rows a client can page through. Exported for the EXPLAIN
 * harness (`playlist-climbs-view-explain.test.ts`).
 */
export function logbookViewSource(
  type: LogbookPlaylistType,
  input: Pick<SmartPlaylistInput, 'userId' | 'boardName'> & ActiveBoardFields,
  viewerUserId: string | null | undefined,
): PlaylistViewSource {
  const climbs = UNIFIED_TABLES.climbs;
  const rowsSql = logbookRowsSql(type, input.userId, input.boardName, viewerUserId);
  const activeBoard = activeBoardFromFields(input);
  const { activeAngle } = input;
  return {
    rows: sql`(${rowsSql}) AS ${sql.identifier(SMART_ROWS)}`,
    climbJoin: and(
      eq(climbs.boardType, smartRowsColumn('board_type')),
      eq(climbs.uuid, smartRowsColumn('climb_uuid')),
    )!,
    where: and(
      climbDraftVisibilityCondition({ userId: climbs.userId, isDraft: climbs.isDraft }, viewerUserId),
      sprayClimbVisibilityCondition({ boardType: climbs.boardType, layoutId: climbs.layoutId }, viewerUserId ?? null),
    ),
    refColumns: {
      climbUuid: sql<string>`${smartRowsColumn('climb_uuid')}`,
      playlistAngle: sql<number | null>`NULL::int`,
    },
    // What the app shows: a climb on the active board's type at the wall angle
    // (the row reads its live stats there), any other at its most-ascended
    // angle. The sort and the grade filters read the same angle, so the order
    // matches the grade on the row (`allBoardsScope`'s rule, with no stored angle).
    preferredAngle:
      activeBoard != null && activeAngle != null
        ? sql`CASE WHEN ${climbs.boardType} = ${activeBoard.boardName} THEN ${activeAngle}::int ELSE NULL::int END`
        : null,
    activeBoard,
    order: naturalRankOrder(smartRowsColumn('natural_rank')),
    hydrateOptions: (items) => allBoardsHydrateOptions(input, items),
  };
}

/**
 * The meta and page of a list under a view. The hero count is the list's,
 * before the view's filters, on page 0, the page clients read the meta from;
 * `unfilteredCount` is computed for page 0 only, so later pages of a filtering
 * view fall back to the filtered count.
 */
function viewResult(meta: Omit<SmartPlaylistMeta, 'climbCount'>, viewPage: PlaylistPage): SmartPlaylistPage {
  return {
    meta: { ...meta, climbCount: viewPage.unfilteredCount ?? viewPage.totalCount },
    climbs: viewPage.climbs,
    totalCount: viewPage.totalCount,
    unfilteredCount: viewPage.unfilteredCount ?? null,
    hasMore: viewPage.hasMore,
  };
}

/** Cap deep pagination for recommendation types — they run heavy catalog joins,
 * so we don't let an authenticated user page past this offset. */
const MAX_RECOMMENDATION_OFFSET = 500;

/** Display name + avatar for the playlist hero, or null if the user is gone. */
async function fetchUserMeta(userId: string): Promise<{ userName: string; userAvatar: string | null } | null> {
  const [user] = await db
    .select({
      name: dbSchema.users.name,
      image: dbSchema.users.image,
      displayName: dbSchema.userProfiles.displayName,
      avatarUrl: dbSchema.userProfiles.avatarUrl,
    })
    .from(dbSchema.users)
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, dbSchema.users.id))
    .where(eq(dbSchema.users.id, userId))
    .limit(1);
  if (!user) return null;
  return {
    userName: user.displayName || user.name || 'Climber',
    userAvatar: user.avatarUrl || user.image || null,
  };
}

/**
 * Smart playlist query. Logbook types (FIVE_STARS, …) obey account and tick
 * audiences. Recommendation types are owner-private (see below).
 * Uses the user's logbook (boardseshTicks) or, for
 * recommendations, the catalog scored for the user's board.
 *
 * Rate limited per-IP (anonymous) or per-user (authenticated). Each call
 * fans out to 3+ DB queries (user lookup + page refs + count + hydrate),
 * so this is high-cost relative to typical reads. The default 60/min
 * cap prevents trivial scraping while still allowing real share-link traffic.
 */
export const smartPlaylist = async (
  _: unknown,
  { input }: { input: SmartPlaylistInput },
  ctx: ConnectionContext,
): Promise<SmartPlaylistPage> => {
  await applyRateLimit(ctx, 60, 'smartPlaylist');
  const parsedInput = validateInput(GetSmartPlaylistInputSchema, input, 'input');
  const view = parsedInput.view;
  // Views are for the four logbook lists. A view on a recommendation is
  // rejected after the `smartPlaylist` charge above but before the view bucket
  // and any database work, as a client-input verdict the app can branch on.
  if (view && isRecommendationType(parsedInput.type)) {
    throw new GraphQLError('Sort and filters are only available on Liked, Five Stars, Projects and Most repeated', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  // A view sorts the whole list before it pages, so it is also charged to the
  // playlist views' bucket, shared with `playlistClimbs` so switching lists
  // doesn't double it, before any database work. Every request has already paid
  // the 60/min `smartPlaylist` limit, so a smart list's views are capped at 60/min.
  if (view) await applyRateLimit(ctx, 120, 'playlist-climbs-view');

  const viewerUserId = ctx.isAuthenticated ? ctx.userId : null;
  const page = input.page ?? 0;
  const pageSize = input.pageSize ?? 20;

  // Catalog-derived recommendations are owner-private: they expose the user's
  // board config and (via AT_LEVEL) grade. Short-circuit BEFORE any user lookup
  // so a non-owner/anonymous caller can't probe user existence and a
  // shared/guessed URL doesn't 500 — they get a uniform empty result.
  if (isRecommendationType(input.type)) {
    const emptyMeta = {
      type: input.type,
      userId: input.userId,
      userName: 'Climber',
      userAvatar: null as string | null,
      climbCount: 0,
    };
    if (!viewerUserId || viewerUserId !== input.userId) {
      return { meta: emptyMeta, climbs: [], totalCount: 0, hasMore: false };
    }
    const maxRecPage = Math.floor(MAX_RECOMMENDATION_OFFSET / pageSize);
    const recPage = Math.min(page, maxRecPage);
    // Pin the narrowed type in a const: TypeScript drops the isRecommendationType
    // narrowing of `input.type` inside the callback below.
    const recommendationType = input.type;

    // Board resolution, the ranked page and the total all hash-join
    // board_climbs against board_climb_stats. Run them on one connection with
    // per-gather parallelism off so a burst of these can't exhaust Postgres's
    // dynamic shared memory (#4235, Sentry BOARDSESH-AK). fetchUserMeta and the
    // hydrator stay outside — they're PK/IN-list lookups, and keeping them out
    // shortens how long this holds a pooled connection.
    const recommendation = await withSerialPlan(db, async (tx) => {
      const target = await resolveRecommendationBoardTarget(
        input.userId,
        { boardUuid: input.boardUuid, sizeId: input.sizeId, angle: input.angle },
        tx,
      );
      if (!target) return null;
      const [pageRefs, totalCount] = await Promise.all([
        selectRecommendationClimbRefs(recommendationType, target, input.userId, recPage, pageSize, tx),
        countRecommendationClimbRefs(recommendationType, target, input.userId, tx),
      ]);
      return { target, pageRefs, totalCount };
    });
    if (!recommendation) {
      return { meta: emptyMeta, climbs: [], totalCount: 0, hasMore: false };
    }
    const { target, pageRefs, totalCount } = recommendation;
    if (!(await canViewUserActivity(ctx.isAuthenticated ? ctx.userId : null, input.userId)))
      throw new Error('Playlist not found');
    const owner = await fetchUserMeta(input.userId);
    // Hydrate at the board's angle, not the most-ascended angle.
    const angleOverrides = new Map<string, number>(
      pageRefs.map((ref) => [`${ref.boardType}:${ref.climbUuid}`, target.angle]),
    );
    // The VIEWER, not `input.userId` — that is the logbook's owner, so passing it
    // made every smart playlist hydrate as if the owner were asking and handed a
    // private wall's climb name and frames to anyone who named them.
    const climbs = await hydrateClimbsByRefs(pageRefs, { angleOverrides, viewerUserId });
    return {
      meta: {
        type: input.type,
        userId: input.userId,
        userName: owner?.userName ?? 'Climber',
        userAvatar: owner?.userAvatar ?? null,
        climbCount: totalCount,
      },
      climbs,
      totalCount,
      // Paging stops at the offset clamp: past maxRecPage every request would
      // re-serve the same clamped page, so hasMore must go false there even
      // when totalCount says otherwise (infinite-scroll loop otherwise).
      hasMore: recPage < maxRecPage && (recPage + 1) * pageSize < totalCount,
    };
  }

  // Logbook smart playlists follow the owner's current activity audience.
  if (!(await canViewUserActivity(ctx.isAuthenticated ? ctx.userId : null, input.userId)))
    throw new Error('Playlist not found');
  const owner = await fetchUserMeta(input.userId);
  if (!owner) {
    throw new Error('User not found');
  }

  if (view) {
    const viewPage = await fetchPlaylistView(
      // `input.type`, not `parsedInput.type`: the recommendation early return
      // above narrows this variable to the logbook types.
      logbookViewSource(input.type, parsedInput, viewerUserId),
      view,
      page,
      pageSize,
      viewerUserId,
    );
    return viewResult(
      { type: input.type, userId: input.userId, userName: owner.userName, userAvatar: owner.userAvatar },
      viewPage,
    );
  }

  const [pageRefs, totalCount] = await Promise.all([
    selectSmartClimbRefs(input.type, input.userId, input.boardName, page, pageSize, viewerUserId),
    countSmartClimbRefs(input.type, input.userId, input.boardName, viewerUserId),
  ]);
  // The VIEWER. `input.userId` is whose logbook is being rendered, which is not the
  // same person and must never stand in for them — see the recommendation branch.
  const climbs = await hydrateClimbsByRefs(pageRefs, { viewerUserId });

  return {
    meta: {
      type: input.type,
      userId: input.userId,
      userName: owner.userName,
      userAvatar: owner.userAvatar,
      climbCount: totalCount,
    },
    climbs,
    totalCount,
    hasMore: (page + 1) * pageSize < totalCount,
  };
};

/**
 * Climb counts for the current user's smart playlists, used to render
 * the cards on the library page.
 *
 * Single roundtrip via CTEs — Postgres scans `boardsesh_ticks` once for the
 * shared `base` and `sent` CTEs, then derives all three counts. Drizzle's
 * query builder can't express co-defined CTEs reused across siblings, hence
 * `db.execute(sql\`...\`)` (the sanctioned escape hatch in CLAUDE.md).
 */
export const mySmartPlaylistCounts = async (
  _: unknown,
  __: unknown,
  ctx: ConnectionContext,
): Promise<Array<{ type: SmartPlaylistType; count: number }>> => {
  requireAuthenticated(ctx);
  const userId = ctx.userId!;

  // One transaction for the whole library-card fan-out: the counts CTE, board
  // resolution and all four recommendation counts. Serially on one connection
  // with per-gather parallelism off, instead of up to nine concurrent parallel
  // hash joins that exhaust Postgres's dynamic shared memory (#4235, Sentry
  // BOARDSESH-AK).
  return withSerialPlan(db, async (tx) => {
    const result = await tx.execute<{ type: SmartPlaylistType; count: number }>(sql`
      WITH base AS (
        SELECT climb_uuid, board_type, quality, attempt_count, status
        FROM ${dbSchema.boardseshTicks}
        WHERE user_id = ${userId}
      ),
      sent AS (
        SELECT DISTINCT climb_uuid, board_type
        FROM base
        WHERE status IN ('flash', 'send')
      ),
      five_stars AS (
        SELECT COUNT(DISTINCT (board_type, climb_uuid))::int AS count
        FROM base
        WHERE quality = 5
      ),
      most_repeated AS (
        SELECT COUNT(*)::int AS count
        FROM (
          SELECT climb_uuid, board_type
          FROM base
          GROUP BY climb_uuid, board_type
          HAVING SUM(attempt_count) > 1
        ) r
      ),
      projects AS (
        -- Match sent on (climb_uuid, board_type) so a Kilter send doesn't
        -- exclude a Tension climb sharing the same UUID; mirrors the
        -- per-page paged-query semantics in selectSmartClimbRefs.
        SELECT COUNT(DISTINCT (board_type, climb_uuid))::int AS count
        FROM base
        WHERE NOT EXISTS (
          SELECT 1 FROM sent
          WHERE sent.climb_uuid = base.climb_uuid
            AND sent.board_type = base.board_type
        )
      ),
      liked_climbs AS (
        SELECT COUNT(DISTINCT (board_name, climb_uuid))::int AS count
        FROM ${dbSchema.userFavorites}
        WHERE user_id = ${userId}
      )
      SELECT 'FIVE_STARS'::text AS type, count FROM five_stars
      UNION ALL
      SELECT 'MOST_REPEATED'::text, count FROM most_repeated
      UNION ALL
      SELECT 'PROJECTS'::text, count FROM projects
      UNION ALL
      SELECT 'LIKED_CLIMBS'::text, count FROM liked_climbs
    `);

    // db.execute returns either an iterable of rows directly or `{ rows }`
    // depending on the underlying postgres client; normalise here.
    const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows) as
      | Array<{ type: SmartPlaylistType; count: number }>
      | undefined;
    if (!rows) return [];

    const byType = new Map<SmartPlaylistType, number>();
    for (const row of rows) {
      byType.set(row.type, Number(row.count ?? 0));
    }

    const counts: Array<{ type: SmartPlaylistType; count: number }> = [
      { type: 'FIVE_STARS', count: byType.get('FIVE_STARS') ?? 0 },
      { type: 'MOST_REPEATED', count: byType.get('MOST_REPEATED') ?? 0 },
      { type: 'PROJECTS', count: byType.get('PROJECTS') ?? 0 },
      { type: 'LIKED_CLIMBS', count: byType.get('LIKED_CLIMBS') ?? 0 },
    ];

    // Recommendation cards: scoped to the user's resolved board, and left out
    // when no board can be determined. The transaction handle goes down so the
    // four counts share this connection and its guard rather than opening four
    // more. Each card count checks current authorization and excludes the
    // user's own sends, just like the playlist page.
    const target = await resolveRecommendationBoardTarget(userId, undefined, tx);
    if (target) {
      const recCounts = await Promise.all(
        RECOMMENDATION_TYPES.map(async (type) => ({
          type,
          count: await countRecommendationCardClimbs(type, target, userId, tx),
        })),
      );
      counts.push(...recCounts);
    }

    return counts;
  });
};
