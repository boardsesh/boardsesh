import { eq, and, desc, sql, inArray, max, type SQL } from 'drizzle-orm';
import { type ConnectionContext, type Climb } from '@boardsesh/shared-schema';
import {
  holdsEpochOrFirstSql,
  isRecommendationType,
  latestTickOnCurrentHoldsSql,
  RECOMMENDATION_TYPES,
  tickRevisionOrFirstSql,
  withSerialPlan,
  type RecommendationType,
} from '@boardsesh/db/queries';
import { db } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { sprayReferenceVisibilityCondition } from '@boardsesh/db/queries';
import { applyRateLimit, requireAuthenticated, validateInput } from '../../shared/helpers';
import { GetSmartPlaylistInputSchema } from '../../../../validation/schemas';
import { hydrateClimbsByRefs, type ClimbRef } from '../helpers/hydrate-climbs';
import { resolveRecommendationBoardTarget } from '../helpers/recommendation-board-target';
import {
  selectRecommendationClimbRefs,
  countRecommendationClimbRefs,
  countRecommendationCardClimbs,
} from '../helpers/recommendation-refs';

// Logbook-derived smart playlists (computed from the user's own ticks).
type LogbookPlaylistType = 'FIVE_STARS' | 'MOST_REPEATED' | 'PROJECTS' | 'LIKED_CLIMBS';
// Catalog-derived recommendations (computed for the user's board) share the
// same query envelope but a different candidate source.
type SmartPlaylistType = LogbookPlaylistType | RecommendationType;

type SmartPlaylistInput = {
  type: SmartPlaylistType;
  userId: string;
  boardName?: string;
  /** The specific owned board to recommend for; ignored by logbook playlists. */
  boardUuid?: string;
  /** Browsing-context overrides for recommendation types (a board the user is
   * viewing); ignored by logbook playlists. */
  sizeId?: number;
  angle?: number;
  page?: number;
  pageSize?: number;
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
  const conditions: SQL[] = [eq(dbSchema.boardseshTicks.userId, userId)];
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
  );
  return conditions;
}

/**
 * The climbs a user has logged, one row per (board_type, climb_uuid), with what
 * the PROJECTS rule needs from their ticks: the newest climb revision they
 * logged at all, and the newest they sent (NULL when they never sent it).
 *
 * Grouped on both columns rather than `climb_uuid` alone, so a sent Kilter climb
 * never stands in for a Tension climb that shares its uuid.
 *
 * Aggregated BEFORE the climb's holds epoch is read, so the queries below look
 * `board_climbs` up once per climb. Reading it per tick cost 24,464 buffers
 * against 428 for a 6,009-tick logbook, on every library page load.
 */
function loggedClimbsSubquery(conditions: SQL[]) {
  const tickRevision = tickRevisionOrFirstSql(dbSchema.boardseshTicks.climbRevision);
  return db
    .select({
      climbUuid: dbSchema.boardseshTicks.climbUuid,
      boardType: dbSchema.boardseshTicks.boardType,
      total: sql<number>`SUM(${dbSchema.boardseshTicks.attemptCount})::int`.as('total'),
      latestRevision: sql<number>`MAX(${tickRevision})`.as('latest_revision'),
      latestSentRevision: sql<
        number | null
      >`MAX(${tickRevision}) FILTER (WHERE ${dbSchema.boardseshTicks.status} IN ('flash', 'send'))`.as(
        'latest_sent_revision',
      ),
    })
    .from(dbSchema.boardseshTicks)
    .where(and(...conditions))
    .groupBy(dbSchema.boardseshTicks.climbUuid, dbSchema.boardseshTicks.boardType)
    .as('logged');
}

type LoggedClimbs = ReturnType<typeof loggedClimbsSubquery>;

/**
 * Each logged climb's own `board_climbs` row, on its primary key. A LEFT join:
 * a tick can name a climb that has no row, and that climb stays in the count as
 * it always has, at epoch 1.
 */
function loggedClimbJoin(logged: LoggedClimbs) {
  return and(eq(dbSchema.boardClimbs.boardType, logged.boardType), eq(dbSchema.boardClimbs.uuid, logged.climbUuid));
}

/**
 * A project is a climb the user has logged on its current holds and not sent on
 * them (#6023, holds-epoch.ts). Both halves read the epoch: without the first,
 * moving a hold would turn every climb the user had already sent into a project
 * they never tried.
 */
function isProjectCondition(logged: LoggedClimbs): SQL {
  const holdsEpoch = holdsEpochOrFirstSql(dbSchema.boardClimbs.holdsRevisionNumber);
  return sql`${latestTickOnCurrentHoldsSql(logged.latestRevision, holdsEpoch)}
    AND NOT ${latestTickOnCurrentHoldsSql(logged.latestSentRevision, holdsEpoch)}`;
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
    const favConditions: SQL[] = [
      eq(dbSchema.userFavorites.userId, userId),
      // Favourites are the other reference source — same rule, same reason.
      sprayReferenceVisibilityCondition(
        { boardType: dbSchema.userFavorites.boardName, climbUuid: dbSchema.userFavorites.climbUuid },
        viewerUserId,
      ),
    ];
    if (boardName) {
      favConditions.push(eq(dbSchema.userFavorites.boardName, boardName));
    }
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

  // PROJECTS — climbs the user has tried on their current holds and not sent on
  // them, most attempts first. The attempt total counts every tick on the
  // climb, older versions included: it only orders the list.
  const logged = loggedClimbsSubquery(conditions);
  const rows = await db
    .select({ climbUuid: logged.climbUuid, boardType: logged.boardType })
    .from(logged)
    .leftJoin(dbSchema.boardClimbs, loggedClimbJoin(logged))
    .where(isProjectCondition(logged))
    .orderBy(desc(logged.total))
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
    const favConditions: SQL[] = [
      eq(dbSchema.userFavorites.userId, userId),
      // Favourites are the other reference source — same rule, same reason.
      sprayReferenceVisibilityCondition(
        { boardType: dbSchema.userFavorites.boardName, climbUuid: dbSchema.userFavorites.climbUuid },
        viewerUserId,
      ),
    ];
    if (boardName) {
      favConditions.push(eq(dbSchema.userFavorites.boardName, boardName));
    }
    const [row] = await db
      .select({
        count: sql<number>`COUNT(DISTINCT (${dbSchema.userFavorites.boardName}, ${dbSchema.userFavorites.climbUuid}))::int`,
      })
      .from(dbSchema.userFavorites)
      .where(and(...favConditions));
    return row?.count ?? 0;
  }

  const logged = loggedClimbsSubquery(conditions);
  const [row] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(logged)
    .leftJoin(dbSchema.boardClimbs, loggedClimbJoin(logged))
    .where(isProjectCondition(logged));
  return row?.count ?? 0;
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
 * Smart playlist query. Logbook types (FIVE_STARS, …) are public/shareable —
 * anyone with the URL can view a user's computed playlist. Recommendation types
 * are owner-private (see below). Uses the user's logbook (boardseshTicks) or, for
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
): Promise<{
  meta: {
    type: SmartPlaylistType;
    userId: string;
    userName: string;
    userAvatar: string | null;
    climbCount: number;
  };
  climbs: Climb[];
  totalCount: number;
  hasMore: boolean;
}> => {
  await applyRateLimit(ctx, 60, 'smartPlaylist');
  validateInput(GetSmartPlaylistInputSchema, input, 'input');

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
    if (!ctx.userId || ctx.userId !== input.userId) {
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
    const owner = await fetchUserMeta(input.userId);
    // Hydrate at the board's angle, not the most-ascended angle.
    const angleOverrides = new Map<string, number>(
      pageRefs.map((ref) => [`${ref.boardType}:${ref.climbUuid}`, target.angle]),
    );
    // The VIEWER, not `input.userId` — that is the logbook's owner, so passing it
    // made every smart playlist hydrate as if the owner were asking and handed a
    // private wall's climb name and frames to anyone who named them.
    const climbs = await hydrateClimbsByRefs(pageRefs, { angleOverrides, viewerUserId: ctx.userId });
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

  // Logbook smart playlists — public/shareable.
  const owner = await fetchUserMeta(input.userId);
  if (!owner) {
    throw new Error('User not found');
  }

  const [pageRefs, totalCount] = await Promise.all([
    selectSmartClimbRefs(input.type, input.userId, input.boardName, page, pageSize, ctx.userId),
    countSmartClimbRefs(input.type, input.userId, input.boardName, ctx.userId),
  ]);
  // The VIEWER. `input.userId` is whose logbook is being rendered, which is not the
  // same person and must never stand in for them — see the recommendation branch.
  const climbs = await hydrateClimbsByRefs(pageRefs, { viewerUserId: ctx.userId });

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
 * shared `base` CTE, then derives all three counts. Drizzle's
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
        SELECT climb_uuid, board_type, quality, attempt_count, status, climb_revision
        FROM ${dbSchema.boardseshTicks}
        WHERE user_id = ${userId}
      ),
      -- One row per logged climb, as loggedClimbsSubquery builds for the
      -- PROJECTS page: the newest revision logged, and the newest sent.
      logged AS (
        SELECT climb_uuid, board_type,
               MAX(${tickRevisionOrFirstSql(sql`climb_revision`)}) AS latest_revision,
               MAX(${tickRevisionOrFirstSql(sql`climb_revision`)})
                 FILTER (WHERE status IN ('flash', 'send')) AS latest_sent_revision
        FROM base
        GROUP BY climb_uuid, board_type
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
        -- The same rule as the PROJECTS page (isProjectCondition): tried on the
        -- current holds, not sent on them. board_climbs is read once per logged
        -- climb, on its primary key, and only by this card.
        SELECT COUNT(*)::int AS count
        FROM logged
        LEFT JOIN ${dbSchema.boardClimbs} AS logged_climb
          ON logged_climb.board_type = logged.board_type AND logged_climb.uuid = logged.climb_uuid
        WHERE ${latestTickOnCurrentHoldsSql(sql`logged.latest_revision`, holdsEpochOrFirstSql(sql`logged_climb.holds_revision_number`))}
          AND NOT ${latestTickOnCurrentHoldsSql(sql`logged.latest_sent_revision`, holdsEpochOrFirstSql(sql`logged_climb.holds_revision_number`))}
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
    // more. Each card count is a cached catalog count minus the user's own
    // sends (countRecommendationCardClimbs); the playlist page stays exact.
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
