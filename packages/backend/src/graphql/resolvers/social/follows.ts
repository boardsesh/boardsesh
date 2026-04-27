import { eq, and, count } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { FollowInputSchema, FollowListInputSchema } from '../../../validation/schemas';
import { batchEnrichUserProfiles, filterVisibleUserIds } from './helpers';
import { publishSocialEvent } from '../../../events/index';

export const socialFollowQueries = {
  /**
   * Get followers of a user
   */
  followers: async (
    _: unknown,
    { input }: { input: { userId: string; limit?: number; offset?: number } },
    ctx: ConnectionContext
  ) => {
    const validatedInput = validateInput(FollowListInputSchema, input, 'input');
    const userId = validatedInput.userId;
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;

    // Get total count
    const countResult = await db
      .select({ count: count() })
      .from(dbSchema.userFollows)
      .where(eq(dbSchema.userFollows.followingId, userId));

    const totalCount = Number(countResult[0]?.count || 0);

    // Get followers with user info
    const results = await db
      .select({
        followerId: dbSchema.userFollows.followerId,
        userName: dbSchema.users.name,
        userImage: dbSchema.users.image,
        displayName: dbSchema.userProfiles.displayName,
        avatarUrl: dbSchema.userProfiles.avatarUrl,
      })
      .from(dbSchema.userFollows)
      .innerJoin(dbSchema.users, eq(dbSchema.userFollows.followerId, dbSchema.users.id))
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.userFollows.followerId, dbSchema.userProfiles.userId))
      .where(eq(dbSchema.userFollows.followingId, userId))
      .orderBy(dbSchema.userFollows.createdAt)
      .limit(limit)
      .offset(offset);

    // Batch-fetch follower/following counts and isFollowedByMe (3 queries instead of 3N)
    const userIds = results.map((r) => r.followerId);
    const enrichments = await batchEnrichUserProfiles(
      userIds,
      ctx.isAuthenticated ? ctx.userId : undefined,
    );

    const users = results.map((row) => {
      const enrichment = enrichments.get(row.followerId);
      return {
        id: row.followerId,
        displayName: row.displayName || row.userName || undefined,
        avatarUrl: row.avatarUrl || row.userImage || undefined,
        followerCount: enrichment?.followerCount ?? 0,
        followingCount: enrichment?.followingCount ?? 0,
        isFollowedByMe: enrichment?.isFollowedByMe ?? false,
      };
    });

    // Filter out private users the viewer cannot see
    const authenticatedUserId = ctx.isAuthenticated ? ctx.userId : undefined;
    const visibleIds = await filterVisibleUserIds(
      users.map(u => u.id),
      authenticatedUserId,
    );
    const filteredUsers = users.filter(u => visibleIds.has(u.id));

    return {
      users: filteredUsers,
      totalCount,
      hasMore: offset + filteredUsers.length < totalCount,
    };
  },

  /**
   * Get users that a user is following
   */
  following: async (
    _: unknown,
    { input }: { input: { userId: string; limit?: number; offset?: number } },
    ctx: ConnectionContext
  ) => {
    const validatedInput = validateInput(FollowListInputSchema, input, 'input');
    const userId = validatedInput.userId;
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;

    // Get total count
    const countResult = await db
      .select({ count: count() })
      .from(dbSchema.userFollows)
      .where(eq(dbSchema.userFollows.followerId, userId));

    const totalCount = Number(countResult[0]?.count || 0);

    // Get following with user info
    const results = await db
      .select({
        followingId: dbSchema.userFollows.followingId,
        userName: dbSchema.users.name,
        userImage: dbSchema.users.image,
        displayName: dbSchema.userProfiles.displayName,
        avatarUrl: dbSchema.userProfiles.avatarUrl,
      })
      .from(dbSchema.userFollows)
      .innerJoin(dbSchema.users, eq(dbSchema.userFollows.followingId, dbSchema.users.id))
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.userFollows.followingId, dbSchema.userProfiles.userId))
      .where(eq(dbSchema.userFollows.followerId, userId))
      .orderBy(dbSchema.userFollows.createdAt)
      .limit(limit)
      .offset(offset);

    // Batch-fetch follower/following counts and isFollowedByMe (3 queries instead of 3N)
    const userIds = results.map((r) => r.followingId);
    const enrichments = await batchEnrichUserProfiles(
      userIds,
      ctx.isAuthenticated ? ctx.userId : undefined,
    );

    const users = results.map((row) => {
      const enrichment = enrichments.get(row.followingId);
      return {
        id: row.followingId,
        displayName: row.displayName || row.userName || undefined,
        avatarUrl: row.avatarUrl || row.userImage || undefined,
        followerCount: enrichment?.followerCount ?? 0,
        followingCount: enrichment?.followingCount ?? 0,
        isFollowedByMe: enrichment?.isFollowedByMe ?? false,
      };
    });

    // Filter out private users the viewer cannot see
    const authenticatedUserId = ctx.isAuthenticated ? ctx.userId : undefined;
    const visibleIds = await filterVisibleUserIds(
      users.map(u => u.id),
      authenticatedUserId,
    );
    const filteredUsers = users.filter(u => visibleIds.has(u.id));

    return {
      users: filteredUsers,
      totalCount,
      hasMore: offset + filteredUsers.length < totalCount,
    };
  },

  /**
   * Check if the current user follows a specific user
   */
  isFollowing: async (
    _: unknown,
    { userId: targetUserId }: { userId: string },
    ctx: ConnectionContext
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    const myUserId = ctx.userId!;

    const [result] = await db
      .select({ count: count() })
      .from(dbSchema.userFollows)
      .where(
        and(
          eq(dbSchema.userFollows.followerId, myUserId),
          eq(dbSchema.userFollows.followingId, targetUserId)
        )
      );

    return Number(result?.count || 0) > 0;
  },

  /**
   * Get a public user profile by ID
   */
  publicProfile: async (
    _: unknown,
    { userId }: { userId: string },
    ctx: ConnectionContext
  ) => {
    // Get user and profile
    const users = await db
      .select({
        id: dbSchema.users.id,
        name: dbSchema.users.name,
        image: dbSchema.users.image,
        displayName: dbSchema.userProfiles.displayName,
        avatarUrl: dbSchema.userProfiles.avatarUrl,
      })
      .from(dbSchema.users)
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
      .where(eq(dbSchema.users.id, userId))
      .limit(1);

    if (users.length === 0) {
      return null;
    }

    const user = users[0];

    // Batch-fetch counts (single user, but uses same efficient pattern)
    const enrichments = await batchEnrichUserProfiles(
      [userId],
      ctx.isAuthenticated ? ctx.userId : undefined,
    );
    const enrichment = enrichments.get(userId);

    return {
      id: user.id,
      displayName: user.displayName || user.name || undefined,
      avatarUrl: user.avatarUrl || user.image || undefined,
      followerCount: enrichment?.followerCount ?? 0,
      followingCount: enrichment?.followingCount ?? 0,
      isFollowedByMe: enrichment?.isFollowedByMe ?? false,
    };
  },
};

export const socialFollowMutations = {
  /**
   * Follow a user (idempotent)
   */
  followUser: async (
    _: unknown,
    { input }: { input: { userId: string } },
    ctx: ConnectionContext
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 30, 'follow');

    const validatedInput = validateInput(FollowInputSchema, input, 'input');
    const myUserId = ctx.userId!;
    const targetUserId = validatedInput.userId;

    if (myUserId === targetUserId) {
      throw new Error('Cannot follow yourself');
    }

    // Verify target user exists
    const [targetUser] = await db
      .select({ id: dbSchema.users.id })
      .from(dbSchema.users)
      .where(eq(dbSchema.users.id, targetUserId))
      .limit(1);

    if (!targetUser) {
      throw new Error('User not found');
    }

    // Insert follow (ON CONFLICT DO NOTHING for idempotency)
    const result = await db
      .insert(dbSchema.userFollows)
      .values({
        followerId: myUserId,
        followingId: targetUserId,
      })
      .onConflictDoNothing()
      .returning();

    // Only publish event if a new follow was created (not idempotent duplicate)
    if (result.length > 0) {
      publishSocialEvent({
        type: 'follow.created',
        actorId: myUserId,
        entityType: 'user',
        entityId: targetUserId,
        timestamp: Date.now(),
        metadata: { followedUserId: targetUserId },
      }).catch((err) => console.error('[Follows] Failed to publish social event:', err));
    }

    return true;
  },

  /**
   * Unfollow a user
   */
  unfollowUser: async (
    _: unknown,
    { input }: { input: { userId: string } },
    ctx: ConnectionContext
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 30, 'follow');

    const validatedInput = validateInput(FollowInputSchema, input, 'input');
    const myUserId = ctx.userId!;
    const targetUserId = validatedInput.userId;

    await db
      .delete(dbSchema.userFollows)
      .where(
        and(
          eq(dbSchema.userFollows.followerId, myUserId),
          eq(dbSchema.userFollows.followingId, targetUserId)
        )
      );

    return true;
  },
};
