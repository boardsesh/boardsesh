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

    expect(metadata.title).toEqual({ absolute: 'Profile Not Found | Boardsesh' });
    // `follow: true` is the house default — the page 404s anyway, and there is
    // no reason to stop a crawler following the links it renders.
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe('/profile/missing-user');
  });

  it('closes the accidental-index path when the profile lookup throws', async () => {
    profilePageTestState.getProfileOgSummaryMock.mockRejectedValue(new Error('database down'));

    const metadata = await pageModule.generateMetadata({
      params: Promise.resolve({ user_id: 'user-1' }),
    });

    // Used to emit a canonical and no robots at all, so an errored profile was
    // indexable.
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it('keeps a real public profile indexable, with a search-first title', async () => {
    profilePageTestState.getProfileOgSummaryMock.mockResolvedValue({
      displayName: 'Marco',
      avatarUrl: null,
      fallbackImageUrl: null,
      topBoardType: 'kilter',
      version: 'v1',
    });

    const metadata = await pageModule.generateMetadata({
      params: Promise.resolve({ user_id: 'user-1' }),
    });

    // Public profiles are a search surface — indexable, deliberately.
    expect(metadata.robots).toBeUndefined();
    expect(metadata.title).toEqual({ absolute: "Marco's Kilter Sessions | Boardsesh" });
    expect(metadata.alternates?.canonical).toBe('/profile/user-1');
    expect(metadata.alternates?.languages).toEqual({
      'en-US': '/profile/user-1',
      es: '/es/profile/user-1',
      fr: '/fr/profile/user-1',
      de: '/de/profile/user-1',
      'x-default': '/profile/user-1',
    });
  });

  it('falls back to a board-free title when the climber has no ticks', async () => {
    profilePageTestState.getProfileOgSummaryMock.mockResolvedValue({
      displayName: 'Marco',
      avatarUrl: null,
      fallbackImageUrl: null,
      topBoardType: null,
      version: 'v1',
    });

    const metadata = await pageModule.generateMetadata({
      params: Promise.resolve({ user_id: 'user-1' }),
    });

    expect(metadata.title).toEqual({ absolute: "Marco's Climbing Sessions | Boardsesh" });
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
      name: 'Alex',
      image: null,
      profile: null,
      credentials: [],
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
