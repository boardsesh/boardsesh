import { eq, and, count } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';

interface ProfileDetails {
  displayName: string | null;
  avatarUrl: string | null;
  instagramUrl: string | null;
}

interface ProfileCredential {
  boardType: string;
  auroraUsername: string;
  auroraUserId: number;
}

interface PublicProfile {
  id: string;
  email?: string;
  name: string | null;
  image: string | null;
  profile: ProfileDetails | null;
  credentials: ProfileCredential[];
  isOwnProfile: boolean;
  followerCount: number;
  followingCount: number;
  isFollowedByMe: boolean;
}

export const publicProfileQuery = {
  publicProfile: async (
    _: unknown,
    { userId }: { userId: string },
    ctx: ConnectionContext,
  ): Promise<PublicProfile | null> => {
    const isOwnProfile = ctx.isAuthenticated && ctx.userId === userId;

    // Get user
    const users = await db
      .select()
      .from(dbSchema.users)
      .where(eq(dbSchema.users.id, userId))
      .limit(1);

    if (users.length === 0) {
      return null;
    }

    const user = users[0];

    // Get profile
    const profiles = await db
      .select()
      .from(dbSchema.userProfiles)
      .where(eq(dbSchema.userProfiles.userId, userId))
      .limit(1);

    const profile = profiles.length > 0 ? profiles[0] : null;

    // Get board mappings
    const mappings = await db
      .select()
      .from(dbSchema.userBoardMappings)
      .where(eq(dbSchema.userBoardMappings.userId, userId));

    const credentials: ProfileCredential[] = mappings.map(m => ({
      boardType: m.boardType,
      auroraUsername: m.boardUsername || '',
      auroraUserId: m.boardUserId,
    }));

    // Get follower/following counts
    const [followerCountResult] = await db
      .select({ count: count() })
      .from(dbSchema.userFollows)
      .where(eq(dbSchema.userFollows.followingId, userId));

    const [followingCountResult] = await db
      .select({ count: count() })
      .from(dbSchema.userFollows)
      .where(eq(dbSchema.userFollows.followerId, userId));

    const followerCount = Number(followerCountResult?.count || 0);
    const followingCount = Number(followingCountResult?.count || 0);

    // Check if current user follows this profile
    let isFollowedByMe = false;
    if (ctx.isAuthenticated && ctx.userId && ctx.userId !== userId) {
      const [followCheck] = await db
        .select({ count: count() })
        .from(dbSchema.userFollows)
        .where(
          and(
            eq(dbSchema.userFollows.followerId, ctx.userId),
            eq(dbSchema.userFollows.followingId, userId),
          ),
        );
      isFollowedByMe = Number(followCheck?.count || 0) > 0;
    }

    return {
      id: user.id,
      email: isOwnProfile ? user.email : undefined,
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
      isOwnProfile: !!isOwnProfile,
      followerCount,
      followingCount,
      isFollowedByMe,
    };
  },
};
