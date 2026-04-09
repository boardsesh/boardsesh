import { eq, and, inArray, count } from 'drizzle-orm';

import { createRequestDb } from '../../../db/client';

const db = createRequestDb();

import type { RequestDbInstance } from '../../../db/client';import * as dbSchema from '@boardsesh/db/schema';

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
