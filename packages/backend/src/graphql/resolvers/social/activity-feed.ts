import { eq, and, desc, sql, or, isNull } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput, isNoMatchClimb } from '../shared/helpers';
import { ActivityFeedInputSchema } from '../../../validation/schemas';
import { encodeCursor, decodeCursor } from '../../../utils/feed-cursor';

function mapFeedItemToGraphQL(row: typeof dbSchema.feedItems.$inferSelect, commentCount = 0) {
  const meta = row.metadata || {};
  return {
    id: String(row.id),
    type: row.type,
    entityType: row.entityType,
    entityId: row.entityId,
    boardUuid: row.boardUuid,
    actorId: row.actorId,
    actorDisplayName: (meta.actorDisplayName as string) ?? null,
    actorAvatarUrl: (meta.actorAvatarUrl as string) ?? null,
    climbName: (meta.climbName as string) ?? null,
    climbUuid: (meta.climbUuid as string) ?? null,
    boardType: (meta.boardType as string) ?? null,
    layoutId: (meta.layoutId as number) ?? null,
    gradeName: (meta.gradeName as string) ?? null,
    status: (meta.status as string) ?? null,
    angle: (meta.angle as number) ?? null,
    frames: (meta.frames as string) ?? null,
    setterUsername: (meta.setterUsername as string) ?? null,
    commentBody: (meta.commentBody as string) ?? null,
    isMirror: (meta.isMirror as boolean) ?? null,
    isBenchmark: (meta.isBenchmark as boolean) ?? null,
    isNoMatch: (meta.isNoMatch as boolean) ?? null,
    difficulty: (meta.difficulty as number) ?? null,
    difficultyName: (meta.difficultyName as string) ?? null,
    quality: (meta.quality as number) ?? null,
    attemptCount: (meta.attemptCount as number) ?? null,
    comment: (meta.comment as string) ?? null,
    commentCount,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}

async function getCommentCountMap(rows: (typeof dbSchema.feedItems.$inferSelect)[]): Promise<Map<string, number>> {
  const countableRows = rows.filter((row) => row.entityType === 'tick' || row.entityType === 'climb');
  if (countableRows.length === 0) return new Map();

  const commentRows = await db
    .select({
      entityType: dbSchema.comments.entityType,
      entityId: dbSchema.comments.entityId,
      commentCount: sql<number>`COUNT(*)::int`,
    })
    .from(dbSchema.comments)
    .where(
      and(
        isNull(dbSchema.comments.deletedAt),
        or(
          ...countableRows.map((row) =>
            and(eq(dbSchema.comments.entityType, row.entityType), eq(dbSchema.comments.entityId, row.entityId)),
          ),
        ),
      ),
    )
    .groupBy(dbSchema.comments.entityType, dbSchema.comments.entityId);

  return new Map(commentRows.map((row) => [`${row.entityType}:${row.entityId}`, Number(row.commentCount)]));
}

type TickJoinRow = {
  tick: typeof dbSchema.boardseshTicks.$inferSelect;
  userName: string | null;
  userImage: string | null;
  userDisplayName: string | null;
  userAvatarUrl: string | null;
  climbName: string | null;
  climbDescription: string | null;
  setterUsername: string | null;
  layoutId: number | null;
  frames: string | null;
  difficultyName: string | null;
};

function mapTickRowToFeedItem({
  tick,
  userName,
  userImage,
  userDisplayName,
  userAvatarUrl,
  climbName,
  climbDescription,
  setterUsername,
  layoutId,
  frames,
  difficultyName,
}: TickJoinRow) {
  return {
    id: tick.id.toString(),
    type: 'ascent' as const,
    entityType: 'tick' as const,
    entityId: tick.uuid,
    boardUuid: null,
    actorId: tick.userId,
    actorDisplayName: userDisplayName || userName || null,
    actorAvatarUrl: userAvatarUrl || userImage || null,
    climbName: climbName || 'Unknown Climb',
    climbUuid: tick.climbUuid,
    boardType: tick.boardType,
    layoutId,
    gradeName: difficultyName,
    status: tick.status,
    angle: tick.angle,
    frames,
    setterUsername,
    commentBody: null,
    isMirror: tick.isMirror ?? false,
    isBenchmark: tick.isBenchmark ?? false,
    isNoMatch: isNoMatchClimb(climbDescription),
    difficulty: tick.difficulty,
    difficultyName,
    quality: tick.quality,
    attemptCount: tick.attemptCount,
    comment: tick.comment || null,
    createdAt: tick.climbedAt,
  };
}

export const activityFeedQueries = {
  /**
   * Materialized activity feed for authenticated user (fan-out-on-write).
   * Reads from feed_items table with cursor-based pagination.
   */
  activityFeed: async (_: unknown, { input }: { input?: Record<string, unknown> }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    const myUserId = ctx.userId!;

    const validatedInput = validateInput(ActivityFeedInputSchema, input || {}, 'input');
    const limit = validatedInput.limit ?? 20;

    // Build base conditions
    const conditions = [eq(dbSchema.feedItems.recipientId, myUserId)];

    if (validatedInput.boardUuid) {
      conditions.push(eq(dbSchema.feedItems.boardUuid, validatedInput.boardUuid));
    }

    // Keyset pagination for chronological sort (stable — order doesn't change)
    // Use raw SQL with the cursor string passed directly to PostgreSQL to avoid
    // timezone issues from JavaScript's new Date() interpreting PG timestamps
    // without timezone indicators as local time instead of UTC.
    if (validatedInput.cursor) {
      const cursor = decodeCursor(validatedInput.cursor);
      if (cursor) {
        conditions.push(
          sql`(${dbSchema.feedItems.createdAt} < ${cursor.createdAt}::timestamp
            OR (${dbSchema.feedItems.createdAt} = ${cursor.createdAt}::timestamp
                AND ${dbSchema.feedItems.id} < ${cursor.id}))`,
        );
      }
    }

    const whereClause = and(...conditions);
    const rows = await db
      .select()
      .from(dbSchema.feedItems)
      .where(whereClause)
      .orderBy(desc(dbSchema.feedItems.createdAt), desc(dbSchema.feedItems.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const resultRows = hasMore ? rows.slice(0, limit) : rows;
    const commentCountMap = await getCommentCountMap(resultRows);
    const items = resultRows.map((row) =>
      mapFeedItemToGraphQL(row, commentCountMap.get(`${row.entityType}:${row.entityId}`) ?? 0),
    );

    let nextCursor: string | null = null;
    if (hasMore && resultRows.length > 0) {
      const lastRow = resultRows[resultRows.length - 1];
      nextCursor = encodeCursor(lastRow.createdAt, lastRow.id);
    }

    return { items, cursor: nextCursor, hasMore };
  },

  /**
   * Trending feed — public, no auth required.
   * Fan-out-on-read from boardsesh_ticks with JOINs (same pattern as globalAscentsFeed).
   * Returns cursor-based pagination using the ActivityFeedItem shape.
   */
  trendingFeed: async (_: unknown, { input }: { input?: Record<string, unknown> }) => {
    const validatedInput = validateInput(ActivityFeedInputSchema, input || {}, 'input');
    const limit = validatedInput.limit ?? 20;

    // Build conditions - only successful ascents for trending
    const conditions = [sql`${dbSchema.boardseshTicks.status} IN ('flash', 'send')`];

    // Board filter: require an active board and scope to ticks recorded for it.
    let layoutIdFilter: number | null = null;
    if (validatedInput.boardUuid) {
      const board = await db
        .select({
          id: dbSchema.userBoards.id,
          boardType: dbSchema.userBoards.boardType,
          layoutId: dbSchema.userBoards.layoutId,
        })
        .from(dbSchema.userBoards)
        .where(and(eq(dbSchema.userBoards.uuid, validatedInput.boardUuid), isNull(dbSchema.userBoards.deletedAt)))
        .limit(1)
        .then((rows) => rows[0]);

      if (!board) {
        return { items: [], cursor: null, hasMore: false };
      }

      conditions.push(eq(dbSchema.boardseshTicks.boardId, board.id));
      conditions.push(eq(dbSchema.boardseshTicks.boardType, board.boardType));
      layoutIdFilter = board.layoutId;
    }

    if (layoutIdFilter !== null) {
      conditions.push(eq(dbSchema.boardClimbs.layoutId, layoutIdFilter));
    }

    // Keyset pagination for chronological sort
    if (validatedInput.cursor) {
      const cursor = decodeCursor(validatedInput.cursor);
      if (cursor) {
        conditions.push(
          sql`(${dbSchema.boardseshTicks.climbedAt} < ${cursor.createdAt}::timestamp
            OR (${dbSchema.boardseshTicks.climbedAt} = ${cursor.createdAt}::timestamp
                AND ${dbSchema.boardseshTicks.id} < ${cursor.id}))`,
        );
      }
    }

    const whereClause = and(...conditions);
    const results = await db
      .select({
        tick: dbSchema.boardseshTicks,
        userName: dbSchema.users.name,
        userImage: dbSchema.users.image,
        userDisplayName: dbSchema.userProfiles.displayName,
        userAvatarUrl: dbSchema.userProfiles.avatarUrl,
        climbName: dbSchema.boardClimbs.name,
        climbDescription: dbSchema.boardClimbs.description,
        setterUsername: dbSchema.boardClimbs.setterUsername,
        layoutId: dbSchema.boardClimbs.layoutId,
        frames: dbSchema.boardClimbs.frames,
        difficultyName: dbSchema.boardDifficultyGrades.boulderName,
      })
      .from(dbSchema.boardseshTicks)
      .innerJoin(dbSchema.users, eq(dbSchema.boardseshTicks.userId, dbSchema.users.id))
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.boardseshTicks.userId, dbSchema.userProfiles.userId))
      // Resolve dedup-merged climbs to their canonical UUID before joining
      // board_climbs. A tick may point at an alias UUID that was deduplicated
      // away (no board_climbs row); the alias table maps it to the canonical.
      // Ticks already on a canonical have no alias row, so COALESCE falls back to
      // the tick's own climb_uuid. The PK (board_type, alias_uuid) keeps the join
      // to ≤1 row, so it never fans out. Otherwise these ticks render "Unknown
      // Climb" in the trending feed.
      .leftJoin(
        dbSchema.boardClimbAliases,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbAliases.aliasUuid),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbAliases.boardType),
        ),
      )
      .innerJoin(
        dbSchema.boardClimbs,
        and(
          sql`COALESCE(${dbSchema.boardClimbAliases.canonicalUuid}, ${dbSchema.boardseshTicks.climbUuid}) = ${dbSchema.boardClimbs.uuid}`,
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbs.boardType),
          sql`${dbSchema.boardClimbs.isDraft} IS NOT TRUE`,
          sql`${dbSchema.boardClimbs.isListed} IS NOT FALSE`,
        ),
      )
      .leftJoin(
        dbSchema.boardDifficultyGrades,
        and(
          eq(dbSchema.boardseshTicks.difficulty, dbSchema.boardDifficultyGrades.difficulty),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardDifficultyGrades.boardType),
        ),
      )
      .where(whereClause)
      .orderBy(desc(dbSchema.boardseshTicks.climbedAt), desc(dbSchema.boardseshTicks.id))
      .limit(limit + 1);

    const hasMore = results.length > limit;
    const resultRows = hasMore ? results.slice(0, limit) : results;
    const items = resultRows.map(mapTickRowToFeedItem);

    let nextCursor: string | null = null;
    if (hasMore && resultRows.length > 0) {
      const lastResult = resultRows[resultRows.length - 1];
      nextCursor = encodeCursor(lastResult.tick.climbedAt, Number(lastResult.tick.id));
    }

    return { items, cursor: nextCursor, hasMore };
  },
};
