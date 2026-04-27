import { eq, and, desc, inArray } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { FollowingAscentsFeedInputSchema } from '../../../validation/schemas';
import { filterVisibleUserIds } from './helpers';

export const socialFeedQueries = {
  /**
   * Get activity feed of ascents from followed users
   * Requires authentication (personalized feed)
   */
  followingAscentsFeed: async (
    _: unknown,
    { input }: { input?: { limit?: number; offset?: number } },
    ctx: ConnectionContext
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

    // Filter out private users who don't follow back the viewer
    const visibleIds = await filterVisibleUserIds(followedUserIds, myUserId);
    const filteredFollowedUserIds = followedUserIds.filter(id => visibleIds.has(id));

    if (filteredFollowedUserIds.length === 0) {
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
      .where(inArray(dbSchema.boardseshTicks.userId, filteredFollowedUserIds))
      .orderBy(desc(dbSchema.boardseshTicks.climbedAt))
      .limit(limit + 1)
      .offset(offset);

    const hasMore = results.length > limit;
    const resultRows = hasMore ? results.slice(0, limit) : results;

    const items = resultRows.map(({ tick, userName, userImage, userDisplayName, userAvatarUrl, climbName, setterUsername, layoutId, frames, difficultyName }) => ({
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
    }));

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
  globalAscentsFeed: async (
    _: unknown,
    { input }: { input?: { limit?: number; offset?: number } },
    ctx: ConnectionContext,
  ) => {
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
      .orderBy(desc(dbSchema.boardseshTicks.climbedAt))
      .limit(limit + 1)
      .offset(offset);

    // Post-fetch privacy filtering
    const viewerId = ctx.isAuthenticated ? ctx.userId : undefined;
    const tickUserIds = [...new Set(results.map((r) => r.tick.userId))];
    const visibleAuthors = await filterVisibleUserIds(tickUserIds, viewerId);
    const filteredResults = results.filter((r) => visibleAuthors.has(r.tick.userId));

    const hasMore = filteredResults.length > limit;
    const resultRows = hasMore ? filteredResults.slice(0, limit) : filteredResults;

    const items = resultRows.map(({ tick, userName, userImage, userDisplayName, userAvatarUrl, climbName, setterUsername, layoutId, frames, difficultyName }) => ({
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
    }));

    return {
      items,
      totalCount: 0, // Intentionally 0 — full COUNT(*) was too expensive. No frontend uses this value.
      hasMore,
    };
  },
};
