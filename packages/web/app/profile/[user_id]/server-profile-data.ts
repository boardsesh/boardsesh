import 'server-only';
import { GET_PUBLIC_PROFILE } from '@boardsesh/graphql/operations';
import type { PublicUserProfile } from '@boardsesh/shared-schema';
import { executeAuthenticatedGraphQL } from '@/app/lib/graphql/server-graphql';
import type { UserProfile } from './utils/profile-constants';

type GetPublicProfileResponse = {
  publicProfile: PublicUserProfile | null;
};

/**
 * Server-side read for /profile/[user_id]. Goes through the backend's
 * `publicProfile` resolver rather than querying Postgres from Next.js, so the
 * frontend no longer needs its own DATABASE_URL (issue #1884).
 *
 * `isFollowedByMe` is derived from the viewer's own auth token — the resolver
 * reads it off the request context — so there is no viewerUserId argument to
 * pass. `email` is the caller's job: it comes from the NextAuth session when
 * someone views their own profile, never from this public query.
 *
 * A backend blip returns null the same way a missing user does. The caller
 * turns that into a 404, which is the pre-existing behaviour for an
 * unreachable profile and keeps a transient outage from 500ing an indexable
 * page.
 */
export async function getProfileData(userId: string, authToken?: string): Promise<UserProfile | null> {
  try {
    const response = await executeAuthenticatedGraphQL<GetPublicProfileResponse>(
      GET_PUBLIC_PROFILE,
      { userId },
      authToken,
    );

    const publicProfile = response.publicProfile;
    if (!publicProfile) return null;

    return {
      id: publicProfile.id,
      email: undefined,
      displayName: publicProfile.displayName ?? null,
      avatarUrl: publicProfile.avatarUrl ?? null,
      instagramUrl: publicProfile.instagramUrl ?? null,
      followerCount: publicProfile.followerCount ?? 0,
      followingCount: publicProfile.followingCount ?? 0,
      isFollowedByMe: publicProfile.isFollowedByMe ?? false,
    };
  } catch (error) {
    console.error('getProfileData failed:', error);
    return null;
  }
}
