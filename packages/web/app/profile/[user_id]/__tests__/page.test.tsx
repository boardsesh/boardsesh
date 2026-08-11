import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const profilePageTestState = vi.hoisted(() => ({
  notFoundMock: vi.fn(),
  getServerAuthTokenMock: vi.fn(),
  getServerSessionMock: vi.fn(),
  getProfileDataMock: vi.fn(),
  fetchProfileStatsDataMock: vi.fn(),
  getProfileOgSummaryMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
}));

vi.mock('next/navigation', () => ({
  notFound: profilePageTestState.notFoundMock,
}));

vi.mock('@/app/lib/auth/server-auth', () => ({
  getServerAuthToken: profilePageTestState.getServerAuthTokenMock,
}));

vi.mock('next-auth/next', () => ({
  getServerSession: profilePageTestState.getServerSessionMock,
}));

vi.mock('@/app/lib/auth/auth-options', () => ({
  authOptions: {},
}));

vi.mock('../server-profile-data', () => ({
  getProfileData: profilePageTestState.getProfileDataMock,
}));

vi.mock('../server-profile-stats', () => ({
  fetchProfileStatsData: profilePageTestState.fetchProfileStatsDataMock,
}));

vi.mock('@/app/lib/seo/dynamic-og-data', () => ({
  getProfileOgSummary: profilePageTestState.getProfileOgSummaryMock,
}));

vi.mock('../profile-page-content', () => ({
  default: (props: { userId: string }) => ({ type: 'ProfilePageContent', props }),
}));

vi.mock('@/app/components/providers/i18n-provider', () => ({
  default: ({ children }: { children: unknown }) => children,
}));

const pageModule = await import('../page');

describe('profile page route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profilePageTestState.notFoundMock.mockImplementation(() => {
      throw new Error('NEXT_NOT_FOUND');
    });
    profilePageTestState.getServerAuthTokenMock.mockResolvedValue(null);
    profilePageTestState.getServerSessionMock.mockResolvedValue(null);
  });

  it('returns noindex metadata when the profile summary is missing', async () => {
    profilePageTestState.getProfileOgSummaryMock.mockResolvedValue(null);

    const metadata = await pageModule.generateMetadata({
      params: Promise.resolve({ user_id: 'missing-user' }),
    });

    expect(metadata.title).toBe('Profile Not Found | Boardsesh');
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it('calls notFound and skips stats fetch when the user does not exist', async () => {
    profilePageTestState.getProfileDataMock.mockResolvedValue(null);

    await expect(
      pageModule.default({
        params: Promise.resolve({ user_id: 'missing-user' }),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(profilePageTestState.getProfileDataMock).toHaveBeenCalledWith('missing-user', undefined);
    expect(profilePageTestState.fetchProfileStatsDataMock).not.toHaveBeenCalled();
  });

  it('fetches stats only after the profile exists', async () => {
    profilePageTestState.getProfileDataMock.mockResolvedValue({
      id: 'user-1',
      email: undefined,
      displayName: 'Alex',
      avatarUrl: null,
      instagramUrl: null,
      followerCount: 0,
      followingCount: 0,
      isFollowedByMe: false,
    });
    profilePageTestState.fetchProfileStatsDataMock.mockResolvedValue({
      initialProfileStats: null,
      initialAllBoardsTicks: {},
      initialLogbook: [],
    });

    await pageModule.default({
      params: Promise.resolve({ user_id: 'user-1' }),
    });

    expect(profilePageTestState.getProfileDataMock).toHaveBeenCalledWith('user-1', undefined);
    expect(profilePageTestState.fetchProfileStatsDataMock).toHaveBeenCalledWith('user-1');
  });
});
