import { getServerSession } from "next-auth/next";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/app/lib/db/db";
import * as schema from "@/app/lib/db/schema";
import { eq, and, count } from "drizzle-orm";
import { authOptions } from "@/app/lib/auth/auth-options";
import { getUserBoardMappings } from "@/app/lib/auth/user-board-mappings";

type RouteParams = {
  params: Promise<{ userId: string }>;
};

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { userId } = await params;
    const session = await getServerSession(authOptions);
    const isOwnProfile = session?.user?.id === userId;

    const db = getDb();

    // Get user profile
    const profiles = await db
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId))
      .limit(1);

    // Get base user data
    const users = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (users.length === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const user = users[0];
    const profile = profiles.length > 0 ? profiles[0] : null;

    // Privacy check: private users are only visible to those they follow
    if (!isOwnProfile && profile?.isPrivate) {
      const viewerId = session?.user?.id;
      if (!viewerId) {
        return NextResponse.json({ error: "private" }, { status: 403 });
      }
      const [followCheck] = await db
        .select({ count: count() })
        .from(schema.userFollows)
        .where(
          and(
            eq(schema.userFollows.followerId, userId),
            eq(schema.userFollows.followingId, viewerId)
          )
        );
      if (Number(followCheck?.count || 0) === 0) {
        return NextResponse.json({ error: "private" }, { status: 403 });
      }
    }

    // Get board mappings for this user
    const mappings = await getUserBoardMappings(userId);

    // Transform mappings to credential format
    const credentials = mappings.map((m) => ({
      boardType: m.boardType,
      auroraUsername: m.boardUsername || '',
      auroraUserId: m.boardUserId,
    }));

    // Get follower/following counts
    const [followerCountResult] = await db
      .select({ count: count() })
      .from(schema.userFollows)
      .where(eq(schema.userFollows.followingId, userId));

    const [followingCountResult] = await db
      .select({ count: count() })
      .from(schema.userFollows)
      .where(eq(schema.userFollows.followerId, userId));

    const followerCount = Number(followerCountResult?.count || 0);
    const followingCount = Number(followingCountResult?.count || 0);

    // Check if current user follows this profile
    let isFollowedByMe = false;
    if (session?.user?.id && session.user.id !== userId) {
      const [followCheck] = await db
        .select({ count: count() })
        .from(schema.userFollows)
        .where(
          and(
            eq(schema.userFollows.followerId, session.user.id),
            eq(schema.userFollows.followingId, userId)
          )
        );
      isFollowedByMe = Number(followCheck?.count || 0) > 0;
    }

    return NextResponse.json({
      id: user.id,
      // Only include email if viewing own profile
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
      isOwnProfile,
      followerCount,
      followingCount,
      isFollowedByMe,
    });
  } catch (error) {
    console.error("Failed to get profile:", error);
    return NextResponse.json({ error: "Failed to get profile" }, { status: 500 });
  }
}
