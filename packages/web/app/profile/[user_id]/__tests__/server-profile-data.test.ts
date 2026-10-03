import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const executeAuthenticatedGraphQL = vi.hoisted(() => vi.fn());

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL }));

import { GET_PUBLIC_PROFILE } from '@boardsesh/graphql/operations';
import { getProfileData } from '../server-profile-data';

describe('getProfileData', () => {
  beforeEach(() => {
    executeAuthenticatedGraphQL.mockReset();
  });

  it('returns null only when the backend confirms that the profile is missing', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ publicProfile: null });

    await expect(getProfileData('missing-user')).resolves.toBeNull();
    expect(executeAuthenticatedGraphQL).toHaveBeenCalledWith(GET_PUBLIC_PROFILE, { userId: 'missing-user' }, undefined);
  });

  it('propagates backend failures instead of converting them to a profile 404', async () => {
    const backendError = new Error('backend unavailable');
    executeAuthenticatedGraphQL.mockRejectedValue(backendError);

    await expect(getProfileData('user-1', 'viewer-token')).rejects.toBe(backendError);
  });

  it('maps a returned public profile without exposing private fields', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({
      publicProfile: {
        id: 'user-1',
        displayName: 'Climber',
        avatarUrl: null,
        instagramUrl: null,
        followerCount: 3,
        followingCount: 7,
        isFollowedByMe: true,
      },
    });

    await expect(getProfileData('user-1', 'viewer-token')).resolves.toEqual({
      id: 'user-1',
      email: undefined,
      displayName: 'Climber',
      avatarUrl: null,
      instagramUrl: null,
      followerCount: 3,
      followingCount: 7,
      isFollowedByMe: true,
    });
  });
});
