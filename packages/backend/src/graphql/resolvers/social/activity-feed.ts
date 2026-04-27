import { eq, and, desc, sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { ActivityFeedInputSchema } from '../../../validation/schemas';
import { encodeCursor, decodeCursor } from '../../../utils/feed-cursor';
import { filterVisibleUserIds } from './helpers';

function mapFeedItemToGraphQL(row: typeof dbSchema.feedItems.$inferSelect) {
  const meta = (row.metadata || {}) as Record<string, unknown>;
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
    difficulty: (meta.difficulty as number) ?? null,
    difficultyName: (meta.difficultyName as string) ?? null,
    quality: (meta.quality as number) ?? null,
    attemptCount: (meta.attemptCount as number) ?? null,
    comment: (meta.comment as string) ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}

type TickJoinRow = {
  tick: typeof dbSchema.boardseshTicks.$inferSelect;
  userName: string | null;
  userImage: string | null;
  userDisplayName: string | null;
  userAvatarUrl: string | null;
  climbName: string | null;
  setterUsername: string | null;
  layoutId: number | null;
  frames: string | null;
  difficultyName: string | null;
};

function mapTickRowToFeedItem({ tick, userName, userImage, userDisplayName, userAvatarUrl, climbName, setterUsername, layoutId, frames, difficultyName }: TickJoinRow) {
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
  activityFeed: async (
    _: unknown,
    { input }: { input?: Record<string, unknown> },
    ctx: ConnectionContext
  ) => {
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
                AND ${dbSchema.feedItems.id} < ${cursor.id}))`
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

    // Privacy filtering: hide items from private users who don't follow the viewer
    const actorIds = [...new Set(resultRows.filter(r => r.actorId).map(r => r.actorId!))];
    const visibleActors = await filterVisibleUserIds(actorIds, myUserId);
    const filteredRows = resultRows.filter(r => !r.actorId || visibleActors.has(r.actorId));
    const items = filteredRows.map(mapFeedItemToGraphQL);

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
  trendingFeed: async (
    _: unknown,
    { input }: { input?: Record<string, unknown> },
    ctx: ConnectionContext,
  ) => {
    const validatedInput = validateInput(ActivityFeedInputSchema, input || {}, 'input');
    const limit = validatedInput.limit ?? 20;

    // Build conditions - only successful ascents for trending
    const conditions = [
      sql`${dbSchema.boardseshTicks.status} IN ('flash', 'send')`,
    ];

    // Board filter: look up board config and filter by boardType + layoutId
    let layoutIdFilter: number | null = null;
    if (validatedInput.boardUuid) {
      const board = await db
        .select({ boardType: dbSchema.userBoards.boardType, layoutId: dbSchema.userBoards.layoutId })
        .from(dbSchema.userBoards)
        .where(eq(dbSchema.userBoards.uuid, validatedInput.boardUuid))
        .limit(1)
        .then(rows => rows[0]);

      if (board) {
        conditions.push(eq(dbSchema.boardseshTicks.boardType, board.boardType));
        layoutIdFilter = board.layoutId;
      }
    }

    // Keyset pagination for chronological sort
    if (validatedInput.cursor) {
      const cursor = decodeCursor(validatedInput.cursor);
      if (cursor) {
        conditions.push(
          sql`(${dbSchema.boardseshTicks.climbedAt} < ${cursor.createdAt}::timestamp
            OR (${dbSchema.boardseshTicks.climbedAt} = ${cursor.createdAt}::timestamp
                AND ${dbSchema.boardseshTicks.id} < ${cursor.id}))`
        );
      }
    }

    // Apply layoutId filter from board config lookup
    if (layoutIdFilter !== null) {
      conditions.push(eq(dbSchema.boardClimbs.layoutId, layoutIdFilter));
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
        setterUsername: dbSchema.boardClimbs.setterUsername,
        layoutId: dbSchema.boardClimbs.layoutId,
        frames: dbSchema.boardClimbs.frames,
        difficultyName: dbSchema.boardDifficultyGrades.boulderName,
      })
      .from(dbSchema.boardseshTicks)
      .innerJoin(dbSchema.users, eq(dbSchema.boardseshTicks.userId, dbSchema.users.id))
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.boardseshTicks.userId, dbSchema.userProfiles.userId))
      .leftJoin(
        dbSchema.boardClimbs,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbs.uuid),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbs.boardType)
        )
      )
      .leftJoin(
        dbSchema.boardDifficultyGrades,
        and(
          eq(dbSchema.boardseshTicks.difficulty, dbSchema.boardDifficultyGrades.difficulty),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardDifficultyGrades.boardType)
        )
      )
      .where(whereClause)
      .orderBy(desc(dbSchema.boardseshTicks.climbedAt), desc(dbSchema.boardseshTicks.id))
      .limit(limit + 1);

    const hasMore = results.length > limit;
    const resultRows = hasMore ? results.slice(0, limit) : results;

    // Privacy filtering: hide ticks from private users who don't follow the viewer
    const viewerId = ctx.isAuthenticated ? ctx.userId : undefined;
    const trendingUserIds = [...new Set(resultRows.map((r) => r.tick.userId))];
    const visibleTrendingAuthors = await filterVisibleUserIds(trendingUserIds, viewerId);
    const filteredResultRows = resultRows.filter((r) => visibleTrendingAuthors.has(r.tick.userId));
    const items = filteredResultRows.map(mapTickRowToFeedItem);

    let nextCursor: string | null = null;
    if (hasMore && filteredResultRows.length > 0) {
      const lastResult = filteredResultRows[filteredResultRows.length - 1];
      nextCursor = encodeCursor(lastResult.tick.climbedAt, Number(lastResult.tick.id));
    }

    return { items, cursor: nextCursor, hasMore };
  },
};
