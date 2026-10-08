import 'server-only';
import { getDb } from '@/app/lib/db/db';
import * as schema from '@/app/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getUserBoardMappings } from '@/app/lib/auth/user-board-mappings';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { executeAuthenticatedGraphQL } from '@/app/lib/graphql/server-graphql';
import type { UserProfile } from './utils/profile-constants';

type ProfileResponse = {
  publicProfile: {
    id: string;
    displayName: string | null;
    avatarUrl: string | null;
    instagramUrl: string | null;
    followerCount: number;
    followingCount: number;
    isFollowedByMe: boolean;
    isPrivate: boolean;
    canViewActivity: boolean;
  } | null;
};

export async function getProfileData(userId: string, viewerUserId?: string): Promise<UserProfile | null> {
  const authToken = await getServerAuthToken();
  const { publicProfile: profile } = await executeAuthenticatedGraphQL<ProfileResponse>(
    `
    query WebProfile($userId: ID!) {
      publicProfile(userId: $userId) {
        id displayName avatarUrl instagramUrl followerCount followingCount
        isFollowedByMe isPrivate canViewActivity
      }
    }`,
    { userId },
    authToken,
  );
  if (!profile) return null;
  const isOwnProfile = viewerUserId === userId;
  const [mappings, users] = await Promise.all([
    profile.canViewActivity ? getUserBoardMappings(userId) : Promise.resolve([]),
    isOwnProfile
      ? getDb().select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).limit(1)
      : Promise.resolve([]),
  ]);
  return {
    id: profile.id,
    email: isOwnProfile ? (users[0]?.email ?? '') : undefined,
    name: profile.displayName,
    image: profile.avatarUrl,
    profile: { displayName: profile.displayName, avatarUrl: profile.avatarUrl, instagramUrl: profile.instagramUrl },
    credentials: mappings.map((mapping) => ({
      boardType: mapping.boardType,
      auroraUsername: mapping.boardUsername || '',
    })),
    followerCount: profile.followerCount,
    followingCount: profile.followingCount,
    isFollowedByMe: profile.isFollowedByMe,
    isPrivate: profile.isPrivate,
    canViewActivity: profile.canViewActivity,
  };
}
