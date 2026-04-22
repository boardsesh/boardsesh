import { eq, and, desc, inArray, isNull, sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import {
  difficultyNameWithFallbackExpr,
  consensusGradeTable,
  consensusGradeJoinCondition,
} from '../shared/sql-expressions';
import { FollowingAscentsFeedInputSchema, FollowingClimbAscentsInputSchema } from '../../../validation/schemas';

export const socialFeedQueries = {
  /**
   * Get activity feed of ascents from followed users
   * Requires authentication (personalized feed)
   */
  followingAscentsFeed: async (
    _: unknown,
    { input }: { input?: { limit?: number; offset?: number } },
    ctx: ConnectionContext,
  ) => {
    requireAuthenticated(ctx);
    const myUserId = ctx.userId!;

    const validatedInput = validateInput(FollowingAscentsFeedInputSchema, input || {}, 'input');
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;

    // Get the list of users I follow
    const followedUsers = await db
      .select({ followingId: dbSchema.userFollows.followingId })
      .from(dbSchema.userFollows)
      .where(eq(dbSchema.userFollows.followerId, myUserId));

    const followedUserIds = followedUsers.map((f) => f.followingId);

    if (followedUserIds.length === 0) {
      return {
        items: [],
        totalCount: 0,
        hasMore: false,
      };
    }

    // Fetch ticks with user, climb, and grade data
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
        difficultyName: difficultyNameWithFallbackExpr,
      })
      .from(dbSchema.boardseshTicks)
      .innerJoin(dbSchema.users, eq(dbSchema.boardseshTicks.userId, dbSchema.users.id))
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.boardseshTicks.userId, dbSchema.userProfiles.userId))
      .leftJoin(
        dbSchema.boardClimbs,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbs.uuid),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbs.boardType),
        ),
      )
      .leftJoin(
        dbSchema.boardDifficultyGrades,
        and(
          eq(dbSchema.boardseshTicks.difficulty, dbSchema.boardDifficultyGrades.difficulty),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardDifficultyGrades.boardType),
        ),
      )
      .leftJoin(
        dbSchema.boardClimbStats,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbStats.climbUuid),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbStats.boardType),
          eq(dbSchema.boardseshTicks.angle, dbSchema.boardClimbStats.angle),
        ),
      )
      .leftJoin(consensusGradeTable, consensusGradeJoinCondition)
      .where(inArray(dbSchema.boardseshTicks.userId, followedUserIds))
      .orderBy(desc(dbSchema.boardseshTicks.climbedAt))
      .limit(limit + 1)
      .offset(offset);

    const hasMore = results.length > limit;
    const resultRows = hasMore ? results.slice(0, limit) : results;

    const items = resultRows.map(
      ({
        tick,
        userName,
        userImage,
        userDisplayName,
        userAvatarUrl,
        climbName,
        setterUsername,
        layoutId,
        frames,
        difficultyName,
      }) => ({
        uuid: tick.uuid,
        userId: tick.userId,
        userDisplayName: userDisplayName || userName || undefined,
        userAvatarUrl: userAvatarUrl || userImage || undefined,
        climbUuid: tick.climbUuid,
        climbName: climbName || 'Unknown Climb',
        setterUsername,
        boardType: tick.boardType,
        layoutId,
        angle: tick.angle,
        isMirror: tick.isMirror ?? false,
        status: tick.status,
        attemptCount: tick.attemptCount,
        quality: tick.quality,
        difficulty: tick.difficulty,
        difficultyName,
        isBenchmark: tick.isBenchmark ?? false,
        comment: tick.comment || '',
        climbedAt: tick.climbedAt,
        frames,
      }),
    );

    return {
      items,
      totalCount: 0, // Intentionally 0 — full COUNT(*) was too expensive. No frontend uses this value.
      hasMore,
    };
  },

  /**
   * Get global activity feed of all recent ascents
   * No authentication required
   */
  globalAscentsFeed: async (_: unknown, { input }: { input?: { limit?: number; offset?: number } }) => {
    const validatedInput = validateInput(FollowingAscentsFeedInputSchema, input || {}, 'input');
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;

    // Fetch ticks with user, climb, and grade data
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
        difficultyName: difficultyNameWithFallbackExpr,
      })
      .from(dbSchema.boardseshTicks)
      .innerJoin(dbSchema.users, eq(dbSchema.boardseshTicks.userId, dbSchema.users.id))
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.boardseshTicks.userId, dbSchema.userProfiles.userId))
      .leftJoin(
        dbSchema.boardClimbs,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbs.uuid),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbs.boardType),
        ),
      )
      .leftJoin(
        dbSchema.boardDifficultyGrades,
        and(
          eq(dbSchema.boardseshTicks.difficulty, dbSchema.boardDifficultyGrades.difficulty),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardDifficultyGrades.boardType),
        ),
      )
      .leftJoin(
        dbSchema.boardClimbStats,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbStats.climbUuid),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbStats.boardType),
          eq(dbSchema.boardseshTicks.angle, dbSchema.boardClimbStats.angle),
        ),
      )
      .leftJoin(consensusGradeTable, consensusGradeJoinCondition)
      .orderBy(desc(dbSchema.boardseshTicks.climbedAt))
      .limit(limit + 1)
      .offset(offset);

    const hasMore = results.length > limit;
    const resultRows = hasMore ? results.slice(0, limit) : results;

    const items = resultRows.map(
      ({
        tick,
        userName,
        userImage,
        userDisplayName,
        userAvatarUrl,
        climbName,
        setterUsername,
        layoutId,
        frames,
        difficultyName,
      }) => ({
        uuid: tick.uuid,
        userId: tick.userId,
        userDisplayName: userDisplayName || userName || undefined,
        userAvatarUrl: userAvatarUrl || userImage || undefined,
        climbUuid: tick.climbUuid,
        climbName: climbName || 'Unknown Climb',
        setterUsername,
        boardType: tick.boardType,
        layoutId,
        angle: tick.angle,
        isMirror: tick.isMirror ?? false,
        status: tick.status,
        attemptCount: tick.attemptCount,
        quality: tick.quality,
        difficulty: tick.difficulty,
        difficultyName,
        isBenchmark: tick.isBenchmark ?? false,
        comment: tick.comment || '',
        climbedAt: tick.climbedAt,
        frames,
      }),
    );

    return {
      items,
      totalCount: 0, // Intentionally 0 — full COUNT(*) was too expensive. No frontend uses this value.
      hasMore,
    };
  },

  /**
   * Get ticks from followed users for a specific climb
   * Requires authentication
   */
  followingClimbAscents: async (
    _: unknown,
    { input }: { input: { boardType: string; climbUuid: string } },
    ctx: ConnectionContext,
  ) => {
    requireAuthenticated(ctx);
    const myUserId = ctx.userId!;

    const validatedInput = validateInput(FollowingClimbAscentsInputSchema, input, 'input');

    // Cap results to avoid runaway payloads on highly-trafficked climbs.
    // The UI is a collapsed list — 100 recent ticks is plenty.
    const MAX_ITEMS = 100;

    try {
      const results = await db
        .select({
          tick: dbSchema.boardseshTicks,
          userName: dbSchema.users.name,
          userImage: dbSchema.users.image,
          userDisplayName: dbSchema.userProfiles.displayName,
          userAvatarUrl: dbSchema.userProfiles.avatarUrl,
          upvotes: dbSchema.voteCounts.upvotes,
          downvotes: dbSchema.voteCounts.downvotes,
        })
        .from(dbSchema.boardseshTicks)
        .innerJoin(
          dbSchema.userFollows,
          and(
            eq(dbSchema.userFollows.followingId, dbSchema.boardseshTicks.userId),
            eq(dbSchema.userFollows.followerId, myUserId),
          ),
        )
        .innerJoin(dbSchema.users, eq(dbSchema.boardseshTicks.userId, dbSchema.users.id))
        .leftJoin(dbSchema.userProfiles, eq(dbSchema.boardseshTicks.userId, dbSchema.userProfiles.userId))
        .leftJoin(
          dbSchema.voteCounts,
          and(
            eq(dbSchema.voteCounts.entityType, 'tick'),
            eq(dbSchema.voteCounts.entityId, dbSchema.boardseshTicks.uuid),
          ),
        )
        .where(
          and(
            eq(dbSchema.boardseshTicks.boardType, validatedInput.boardType),
            eq(dbSchema.boardseshTicks.climbUuid, validatedInput.climbUuid),
          ),
        )
        .orderBy(desc(dbSchema.boardseshTicks.climbedAt))
        .limit(MAX_ITEMS);

      // Batch-fetch comment counts in a single GROUP BY query instead of a
      // correlated subquery per row. MAX_ITEMS is bounded but the pattern is
      // consistent with ticks/queries.ts and avoids N extra round-trips.
      const tickUuids = results.map((r) => r.tick.uuid);
      const commentRows =
        tickUuids.length > 0
          ? await db
              .select({
                entityId: dbSchema.comments.entityId,
                commentCount: sql<number>`COUNT(*)::int`.as('comment_count'),
              })
              .from(dbSchema.comments)
              .where(
                and(
                  eq(dbSchema.comments.entityType, 'tick'),
                  inArray(dbSchema.comments.entityId, tickUuids),
                  isNull(dbSchema.comments.deletedAt),
                ),
              )
              .groupBy(dbSchema.comments.entityId)
          : [];

      const commentMap = new Map(commentRows.map((c) => [c.entityId, Number(c.commentCount)]));

      const items = results.map(({ tick, userName, userImage, userDisplayName, userAvatarUrl, upvotes, downvotes }) => ({
        uuid: tick.uuid,
        userId: tick.userId,
        userDisplayName: userDisplayName || userName || undefined,
        userAvatarUrl: userAvatarUrl || userImage || undefined,
        climbUuid: tick.climbUuid,
        boardType: tick.boardType,
        angle: tick.angle,
        isMirror: tick.isMirror ?? false,
        status: tick.status,
        attemptCount: tick.attemptCount,
        quality: tick.quality,
        difficulty: tick.difficulty,
        isBenchmark: tick.isBenchmark ?? false,
        comment: tick.comment || '',
        climbedAt: tick.climbedAt,
        upvotes: Number(upvotes ?? 0),
        downvotes: Number(downvotes ?? 0),
        commentCount: commentMap.get(tick.uuid) ?? 0,
      }));

      return { items };
    } catch (err) {
      console.error('[followingClimbAscents] DB error:', err);
      throw err;
    }
  },
};
