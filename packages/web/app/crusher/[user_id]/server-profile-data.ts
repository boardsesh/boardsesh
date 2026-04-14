import 'server-only';
import { getDb } from '@/app/lib/db/db';
import * as schema from '@/app/lib/db/schema';
import { eq, and, count } from 'drizzle-orm';
import { getUserBoardMappings } from '@/app/lib/auth/user-board-mappings';
import type { UserProfile } from './utils/profile-constants';

export async function getProfileData(
  userId: string,
  viewerUserId?: string,
): Promise<UserProfile | null> {
  const db = getDb();

  const [users, profiles, mappings] = await Promise.all([
    db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1),
    db.select().from(schema.userProfiles).where(eq(schema.userProfiles.userId, userId)).limit(1),
    getUserBoardMappings(userId),
  ]);

  if (users.length === 0) return null;

  const user = users[0];
  const profile = profiles[0] ?? null;
  const isOwnProfile = viewerUserId === userId;

  const credentials = mappings.map((m) => ({
    boardType: m.boardType,
    auroraUsername: m.boardUsername || '',
    auroraUserId: m.boardUserId,
  }));

  const [followerCountResult, followingCountResult, followCheck] = await Promise.all([
    db.select({ count: count() }).from(schema.userFollows).where(eq(schema.userFollows.followingId, userId)),
    db.select({ count: count() }).from(schema.userFollows).where(eq(schema.userFollows.followerId, userId)),
    viewerUserId && viewerUserId !== userId
      ? db
          .select({ count: count() })
          .from(schema.userFollows)
          .where(and(eq(schema.userFollows.followerId, viewerUserId), eq(schema.userFollows.followingId, userId)))
      : Promise.resolve([{ count: 0 }]),
  ]);

  return {
    id: user.id,
    email: isOwnProfile ? (user.email ?? undefined) : undefined,
    name: user.name,
    image: user.image,
    profile: profile
      ? {
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl,
          instagramUrl: profile.instagramUrl,
        }
      : null,
    credentials,
    followerCount: Number(followerCountResult[0]?.count || 0),
    followingCount: Number(followingCountResult[0]?.count || 0),
    isFollowedByMe: Number(followCheck[0]?.count || 0) > 0,
  };
}
