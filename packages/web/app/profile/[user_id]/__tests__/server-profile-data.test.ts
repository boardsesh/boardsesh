import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const controls = vi.hoisted(() => ({
  token: vi.fn(),
  query: vi.fn(),
  mappings: vi.fn(),
  database: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken: controls.token }));
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL: controls.query }));
vi.mock('@/app/lib/auth/user-board-mappings', () => ({ getUserBoardMappings: controls.mappings }));
vi.mock('@/app/lib/db/db', () => ({ getDb: controls.database }));

import { getProfileData } from '../server-profile-data';

const publicProfile = {
  id: 'profile-owner',
  displayName: 'Public climber name',
  avatarUrl: null,
  instagramUrl: 'https://instagram.com/public-climber',
  followerCount: 5,
  followingCount: 3,
  isFollowedByMe: false,
  isPrivate: false,
  canViewActivity: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  controls.token.mockResolvedValue('legacy-viewer-token');
  controls.query.mockResolvedValue({ publicProfile });
  controls.mappings.mockResolvedValue([{ boardType: 'kilter', boardUsername: 'PRIVATE_MAPPING' }]);
  controls.database.mockImplementation(() => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ email: 'PRIVATE_EMAIL' }] }) }),
    }),
  }));
});

describe('independent public profile read', () => {
  it('publicOnly ignores both a supplied owner identity and bearer and never reads email or mappings', async () => {
    const result = await getProfileData('profile-owner', 'profile-owner', {
      authToken: 'unrelated-private-viewer-token',
      publicOnly: true,
    });
    expect(controls.query).toHaveBeenCalledWith(expect.any(String), { userId: 'profile-owner' }, undefined);
    expect(controls.token).not.toHaveBeenCalled();
    expect(controls.database).not.toHaveBeenCalled();
    expect(controls.mappings).not.toHaveBeenCalled();
    expect(result).toMatchObject({ name: 'Public climber name', credentials: [], email: undefined });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_EMAIL|PRIVATE_MAPPING|private-viewer-token/);
  });

  it('a supplied undefined token means an anonymous request rather than implicit credential lookup', async () => {
    await getProfileData('profile-owner', undefined, { authToken: undefined });
    expect(controls.query).toHaveBeenCalledWith(expect.any(String), { userId: 'profile-owner' }, undefined);
    expect(controls.token).not.toHaveBeenCalled();
  });

  it('omitting token options preserves legacy credential lookup, mappings and same-user email', async () => {
    const result = await getProfileData('profile-owner', 'profile-owner');
    expect(controls.token).toHaveBeenCalledTimes(1);
    expect(controls.query).toHaveBeenCalledWith(expect.any(String), { userId: 'profile-owner' }, 'legacy-viewer-token');
    expect(result).toMatchObject({
      email: 'PRIVATE_EMAIL',
      credentials: [{ boardType: 'kilter', auroraUsername: 'PRIVATE_MAPPING' }],
    });
  });

  it('uses an explicit token without substituting the current cookie', async () => {
    await getProfileData('profile-owner', 'different-viewer', { authToken: 'explicit-viewer-token' });
    expect(controls.query).toHaveBeenCalledWith(
      expect.any(String),
      { userId: 'profile-owner' },
      'explicit-viewer-token',
    );
    expect(controls.token).not.toHaveBeenCalled();
    expect(controls.database).not.toHaveBeenCalled();
  });

  it('does not invent a profile or read local private fields when the anonymous backend returns none', async () => {
    controls.query.mockResolvedValue({ publicProfile: null });
    expect(await getProfileData('missing-profile', undefined, { publicOnly: true })).toBeNull();
    expect(controls.database).not.toHaveBeenCalled();
    expect(controls.mappings).not.toHaveBeenCalled();
  });
});
