import { eq, and, inArray, sql } from 'drizzle-orm';

import type { RequestDbInstance } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';

/**
 * Batch-fetch followerCount and isFollowedByMe for a list of playlist UUIDs.
 * Returns a Map keyed by playlist UUID.
 */
export async function getPlaylistFollowStats(
  db: RequestDbInstance,
  playlistUuids: string[],
  currentUserId: string | null,
): Promise<Map<string, { followerCount: number; isFollowedByMe: boolean }>> {
  const result = new Map<string, { followerCount: number; isFollowedByMe: boolean }>();

  if (playlistUuids.length === 0) return result;

  // Follower counts
  const followerCounts = await db
    .select({
      playlistUuid: dbSchema.playlistFollows.playlistUuid,
      count: sql<number>`count(*)::int`,
    })
    .from(dbSchema.playlistFollows)
    .where(inArray(dbSchema.playlistFollows.playlistUuid, playlistUuids))
    .groupBy(dbSchema.playlistFollows.playlistUuid);

  const countMap = new Map(followerCounts.map(r => [r.playlistUuid, r.count]));

  // Is-followed-by-me check (only if authenticated)
  const followedSet = new Set<string>();
  if (currentUserId) {
    const followed = await db
      .select({ playlistUuid: dbSchema.playlistFollows.playlistUuid })
      .from(dbSchema.playlistFollows)
      .where(
        and(
          eq(dbSchema.playlistFollows.followerId, currentUserId),
          inArray(dbSchema.playlistFollows.playlistUuid, playlistUuids),
        )
      );
    for (const r of followed) {
      followedSet.add(r.playlistUuid);
    }
  }

  for (const uuid of playlistUuids) {
    result.set(uuid, {
      followerCount: countMap.get(uuid) ?? 0,
      isFollowedByMe: followedSet.has(uuid),
    });
  }

  return result;
}
