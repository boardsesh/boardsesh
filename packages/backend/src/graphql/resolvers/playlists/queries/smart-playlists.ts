import { eq, and, desc, sql, max, type SQL } from 'drizzle-orm';
import { type ConnectionContext, type Climb } from '@boardsesh/shared-schema';
import { isRecommendationType, RECOMMENDATION_TYPES, type RecommendationType } from '@boardsesh/db/queries';
import { db } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { applyRateLimit, requireAuthenticated, validateInput } from '../../shared/helpers';
import { GetSmartPlaylistInputSchema } from '../../../../validation/schemas';
import { hydrateClimbsByRefs, type ClimbRef } from '../helpers/hydrate-climbs';
import { resolveRecommendationBoardTarget } from '../helpers/recommendation-board-target';
import { selectRecommendationClimbRefs, countRecommendationClimbRefs } from '../helpers/recommendation-refs';
import { UNIFIED_TABLES } from '../../../../db/queries/util/table-select';

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
function smartBaseConditions(userId: string, boardName: string | undefined): SQL[] {
  const conditions: SQL[] = [eq(dbSchema.boardseshTicks.userId, userId)];
  if (boardName) {
    conditions.push(eq(dbSchema.boardseshTicks.boardType, boardName));
  }
  return conditions;
}

/**
 * SQL fragment: "no flash/send tick exists for this (userId, board_type, climb_uuid)
 * triple." Matches by `(board_type, climb_uuid)` rather than `climb_uuid` alone so
 * a sent Kilter climb doesn't accidentally exclude a different Tension climb that
 * happens to share the same UUID. Always includes the board-type match — when
 * `boardName` is provided we additionally constrain the side that's being filtered
 * (the outer query) to that board, but the existence test itself is always
 * board-aware.
 *
 * Correlation is via explicit table-qualified identifiers (`sent.board_type` for
 * the inner aliased copy, `boardsesh_ticks.board_type` for the outer scope),
 * not via Drizzle column interpolation, so the predicate doesn't accidentally
 * resolve both sides to the inner alias if Drizzle ever rewrites the outer
 * `from(boardseshTicks)` to use an alias.
 */
function notSentExists(userId: string): SQL {
  return sql`NOT EXISTS (
    SELECT 1
    FROM boardsesh_ticks AS sent
    WHERE sent.user_id = ${userId}
      AND sent.board_type = boardsesh_ticks.board_type
      AND sent.climb_uuid = boardsesh_ticks.climb_uuid
      AND sent.status IN ('flash', 'send')
  )`;
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
): Promise<SmartClimbRef[]> {
  const conditions = smartBaseConditions(userId, boardName);
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
    const climbs = UNIFIED_TABLES.climbs;
    const favConditions: SQL[] = [eq(dbSchema.userFavorites.userId, userId)];
    if (boardName) {
      favConditions.push(eq(climbs.boardType, boardName));
    }
    const rows = await db
      .select({
        climbUuid: dbSchema.userFavorites.climbUuid,
        boardType: climbs.boardType,
      })
      .from(dbSchema.userFavorites)
      .innerJoin(climbs, eq(climbs.uuid, dbSchema.userFavorites.climbUuid))
      .where(and(...favConditions))
      .groupBy(dbSchema.userFavorites.climbUuid, climbs.boardType)
      .orderBy(desc(max(dbSchema.userFavorites.createdAt)))
      .limit(pageSize)
      .offset(offset);
    return rows.map((row) => ({ climbUuid: row.climbUuid, boardType: row.boardType }));
  }

  // PROJECTS — climbs the user has logged but never sent on this (board, climb).
  // The NOT EXISTS check matches on both board_type and climb_uuid, so a sent
  // Kilter climb doesn't accidentally exclude a Tension climb with the same
  // UUID. We don't add `status = 'attempt'` because a climb that survives the
  // NOT EXISTS has no flash/send rows for this board by definition.
  const rows = await db
    .select({
      climbUuid: dbSchema.boardseshTicks.climbUuid,
      boardType: dbSchema.boardseshTicks.boardType,
      total: sql<number>`SUM(${dbSchema.boardseshTicks.attemptCount})::int`,
    })
    .from(dbSchema.boardseshTicks)
    .where(and(...conditions, notSentExists(userId)))
    .groupBy(dbSchema.boardseshTicks.climbUuid, dbSchema.boardseshTicks.boardType)
    .orderBy(desc(sql`SUM(${dbSchema.boardseshTicks.attemptCount})`))
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
): Promise<number> {
  const conditions = smartBaseConditions(userId, boardName);

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
    const climbs = UNIFIED_TABLES.climbs;
    const favConditions: SQL[] = [eq(dbSchema.userFavorites.userId, userId)];
    if (boardName) {
      favConditions.push(eq(climbs.boardType, boardName));
    }
    const [row] = await db
      .select({
        count: sql<number>`COUNT(DISTINCT (${climbs.boardType}, ${dbSchema.userFavorites.climbUuid}))::int`,
      })
      .from(dbSchema.userFavorites)
      .innerJoin(climbs, eq(climbs.uuid, dbSchema.userFavorites.climbUuid))
      .where(and(...favConditions));
    return row?.count ?? 0;
  }

  const [row] = await db
    .select({
      count: sql<number>`COUNT(DISTINCT (${dbSchema.boardseshTicks.boardType}, ${dbSchema.boardseshTicks.climbUuid}))::int`,
    })
    .from(dbSchema.boardseshTicks)
    .where(and(...conditions, notSentExists(userId)));
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
    const target = await resolveRecommendationBoardTarget(input.userId, {
      boardUuid: input.boardUuid,
      sizeId: input.sizeId,
      angle: input.angle,
    });
    if (!target) {
      return { meta: emptyMeta, climbs: [], totalCount: 0, hasMore: false };
    }
    const recPage = Math.min(page, Math.floor(MAX_RECOMMENDATION_OFFSET / pageSize));
    const owner = await fetchUserMeta(input.userId);
    const [pageRefs, totalCount] = await Promise.all([
      selectRecommendationClimbRefs(input.type, target, input.userId, recPage, pageSize),
      countRecommendationClimbRefs(input.type, target, input.userId),
    ]);
    // Hydrate at the board's angle, not the most-ascended angle.
    const angleOverrides = new Map<string, number>(
      pageRefs.map((ref) => [`${ref.boardType}:${ref.climbUuid}`, target.angle]),
    );
    const climbs = await hydrateClimbsByRefs(pageRefs, { angleOverrides });
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
      hasMore: (recPage + 1) * pageSize < totalCount,
    };
  }

  // Logbook smart playlists — public/shareable.
  const owner = await fetchUserMeta(input.userId);
  if (!owner) {
    throw new Error('User not found');
  }

  const [pageRefs, totalCount] = await Promise.all([
    selectSmartClimbRefs(input.type, input.userId, input.boardName, page, pageSize),
    countSmartClimbRefs(input.type, input.userId, input.boardName),
  ]);
  const climbs = await hydrateClimbsByRefs(pageRefs);

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

  const result = await db.execute<{ type: SmartPlaylistType; count: number }>(sql`
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
      SELECT COUNT(DISTINCT (c.board_type, uf.climb_uuid))::int AS count
      FROM ${dbSchema.userFavorites} uf
      INNER JOIN ${dbSchema.boardClimbs} c ON c.uuid = uf.climb_uuid
      WHERE uf.user_id = ${userId}
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

  // Recommendation cards: scoped to the user's resolved board. Counted in
  // parallel; all zero (cards hidden) when no board can be determined.
  const target = await resolveRecommendationBoardTarget(userId);
  if (target) {
    const recCounts = await Promise.all(
      RECOMMENDATION_TYPES.map(async (type) => ({
        type,
        count: await countRecommendationClimbRefs(type, target, userId),
      })),
    );
    counts.push(...recCounts);
  }

  return counts;
};
