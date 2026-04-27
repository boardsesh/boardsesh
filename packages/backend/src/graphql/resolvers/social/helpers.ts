import { eq, and, inArray, count, isNull, or } from 'drizzle-orm';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';

/**
 * Check if a viewer can see a target user's content.
 * Access rule: viewer V can see user P iff P is not private, V === P, or P follows V.
 */
export async function canViewUser(
  viewerId: string | undefined,
  targetUserId: string,
): Promise<boolean> {
  if (viewerId === targetUserId) return true;

  const [profile] = await db
    .select({ isPrivate: dbSchema.userProfiles.isPrivate })
    .from(dbSchema.userProfiles)
    .where(eq(dbSchema.userProfiles.userId, targetUserId))
    .limit(1);

  if (!profile || !profile.isPrivate) return true;

  if (!viewerId) return false;

  const [follow] = await db
    .select({ followerId: dbSchema.userFollows.followerId })
    .from(dbSchema.userFollows)
    .where(
      and(
        eq(dbSchema.userFollows.followerId, targetUserId),
        eq(dbSchema.userFollows.followingId, viewerId),
      ),
    )
    .limit(1);

  return !!follow;
}

/**
 * Batch filter: returns the subset of userIds the viewer is allowed to see.
 * Uses 2 queries max: one for isPrivate flags, one for follow checks.
 */
export async function filterVisibleUserIds(
  userIds: string[],
  viewerId: string | undefined,
): Promise<Set<string>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Set();

  const profileRows = await db
    .select({
      userId: dbSchema.userProfiles.userId,
      isPrivate: dbSchema.userProfiles.isPrivate,
    })
    .from(dbSchema.userProfiles)
    .where(inArray(dbSchema.userProfiles.userId, unique));

  const privateSet = new Set(
    profileRows.filter((r) => r.isPrivate).map((r) => r.userId),
  );

  const visible = new Set(unique.filter((id) => !privateSet.has(id)));

  if (viewerId) {
    visible.add(viewerId);
  }

  const privateIds = [...privateSet].filter((id) => id !== viewerId);
  if (privateIds.length > 0 && viewerId) {
    const followRows = await db
      .select({ followerId: dbSchema.userFollows.followerId })
      .from(dbSchema.userFollows)
      .where(
        and(
          inArray(dbSchema.userFollows.followerId, privateIds),
          eq(dbSchema.userFollows.followingId, viewerId),
        ),
      );
    for (const row of followRows) {
      visible.add(row.followerId);
    }
  }

  return visible;
}

export interface UserProfileEnrichment {
  followerCount: number;
  followingCount: number;
  isFollowedByMe: boolean;
}

/**
 * Batch-fetch follower counts, following counts, and isFollowedByMe
 * for a list of user IDs. Replaces N+1 per-user queries with 3 batched queries.
 */
export async function batchEnrichUserProfiles(
  userIds: string[],
  authenticatedUserId: string | undefined,
): Promise<Map<string, UserProfileEnrichment>> {
  if (userIds.length === 0) return new Map();

  // Batch: follower counts (how many people follow each user)
  const followerCounts = await db
    .select({
      userId: dbSchema.userFollows.followingId,
      count: count(),
    })
    .from(dbSchema.userFollows)
    .where(inArray(dbSchema.userFollows.followingId, userIds))
    .groupBy(dbSchema.userFollows.followingId);

  // Batch: following counts (how many people each user follows)
  const followingCounts = await db
    .select({
      userId: dbSchema.userFollows.followerId,
      count: count(),
    })
    .from(dbSchema.userFollows)
    .where(inArray(dbSchema.userFollows.followerId, userIds))
    .groupBy(dbSchema.userFollows.followerId);

  // Batch: isFollowedByMe
  let followedByMeSet = new Set<string>();
  if (authenticatedUserId) {
    const followedByMe = await db
      .select({ followingId: dbSchema.userFollows.followingId })
      .from(dbSchema.userFollows)
      .where(
        and(
          eq(dbSchema.userFollows.followerId, authenticatedUserId),
          inArray(dbSchema.userFollows.followingId, userIds),
        ),
      );
    followedByMeSet = new Set(followedByMe.map((f) => f.followingId));
  }

  const followerMap = new Map(followerCounts.map((r) => [r.userId, Number(r.count)]));
  const followingMap = new Map(followingCounts.map((r) => [r.userId, Number(r.count)]));

  const result = new Map<string, UserProfileEnrichment>();
  for (const id of userIds) {
    result.set(id, {
      followerCount: followerMap.get(id) ?? 0,
      followingCount: followingMap.get(id) ?? 0,
      isFollowedByMe: followedByMeSet.has(id),
    });
  }
  return result;
}
