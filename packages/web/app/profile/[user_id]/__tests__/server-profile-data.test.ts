import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const serverProfileState = vi.hoisted(() => ({
  executeAuthenticatedGraphQLMock: vi.fn(),
  getUserBoardMappingsMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/db/db', () => ({ getDb: vi.fn() }));
vi.mock('@/app/lib/db/schema', () => ({ users: {} }));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken: vi.fn(async () => 'token') }));
vi.mock('@/app/lib/auth/user-board-mappings', () => ({
  getUserBoardMappings: serverProfileState.getUserBoardMappingsMock,
}));
vi.mock('@/app/lib/graphql/server-graphql', () => ({
  executeAuthenticatedGraphQL: serverProfileState.executeAuthenticatedGraphQLMock,
}));

const { getProfileData } = await import('../server-profile-data');

function publicProfile(isSupporter: boolean | null) {
  return {
    publicProfile: {
      id: 'user-9',
      displayName: 'Ada',
      avatarUrl: null,
      instagramUrl: null,
      followerCount: 1,
      followingCount: 2,
      isFollowedByMe: false,
      isPrivate: false,
      canViewActivity: true,
      isSupporter,
    },
  };
}

describe('getProfileData supporter tag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverProfileState.getUserBoardMappingsMock.mockResolvedValue([]);
  });

  it('asks publicProfile for isSupporter', async () => {
    serverProfileState.executeAuthenticatedGraphQLMock.mockResolvedValue(publicProfile(true));
    await getProfileData('user-9', 'viewer-1');
    const [query] = serverProfileState.executeAuthenticatedGraphQLMock.mock.calls[0];
    expect(query).toMatch(/\bisSupporter\b/);
  });

  it.each([
    [true, true],
    [false, false],
    [null, false],
  ])('maps isSupporter %s to %s', async (isSupporter, expected) => {
    serverProfileState.executeAuthenticatedGraphQLMock.mockResolvedValue(publicProfile(isSupporter));
    const profile = await getProfileData('user-9', 'viewer-1');
    expect(profile?.isSupporter).toBe(expected);
  });
});
