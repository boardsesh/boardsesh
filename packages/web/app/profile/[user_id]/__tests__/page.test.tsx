import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { BOARD_RENDER_VERSION } from '@boardsesh/board-render/version';

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

vi.mock('@/app/lib/auth/admitted-session.server', () => ({
  getAdmittedServerSession: profilePageTestState.getServerSessionMock,
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

vi.mock('@/app/lib/backend-url', () => ({
  getPublicBackendHttpUrl: () => 'https://ws.boardsesh.com',
}));

vi.mock('../profile-page-content', () => ({
  default: (props: { userId: string }) => ({ type: 'ProfilePageContent', props }),
}));

vi.mock('@/app/components/providers/i18n-provider', () => ({
  default: ({ children }: { children: unknown }) => children,
}));

const pageModule = await import('../page');

const BASE_SUMMARY = {
  displayName: 'Marco' as string | null,
  topBoardType: null as string | null,
  hardestSend: null as { climbName: string; grade: string | null } | null,
  sentClimbCount: 0,
  sentBoardTypes: [] as string[],
  version: 'v1',
};

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
      ...BASE_SUMMARY,
      topBoardType: 'kilter',
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
      it: '/it/profile/user-1',
      'x-default': '/profile/user-1',
    });
  });

  it('falls back to a board-free title when the climber has no ticks', async () => {
    profilePageTestState.getProfileOgSummaryMock.mockResolvedValue(BASE_SUMMARY);

    const metadata = await pageModule.generateMetadata({
      params: Promise.resolve({ user_id: 'user-1' }),
    });

    expect(metadata.title).toEqual({ absolute: "Marco's Climbing Sessions | Boardsesh" });
  });

  it('names the hardest send in the share preview and keeps the search title', async () => {
    profilePageTestState.getProfileOgSummaryMock.mockResolvedValue({
      ...BASE_SUMMARY,
      displayName: 'Reuben Amini',
      topBoardType: 'kilter',
      hardestSend: { climbName: 'Swooped', grade: '7b/V8' },
      sentClimbCount: 212,
      sentBoardTypes: ['kilter', 'tension'],
    });

    const metadata = await pageModule.generateMetadata({ params: Promise.resolve({ user_id: 'user-1' }) });
    const [image] = (metadata.openGraph?.images ?? []) as Array<{ url: string }>;

    expect(metadata.title).toEqual({ absolute: "Reuben Amini's Kilter Sessions | Boardsesh" });
    expect(metadata.openGraph?.title).toBe('Reuben Amini sent 7b/V8');
    expect(metadata.openGraph?.description).toBe(
      'Swooped is the hardest of 212 climbs sent on Kilter and Tension. See the logbook.',
    );
    expect(image.url).toBe(`https://ws.boardsesh.com/og/profile?user_id=user-1&v=${BOARD_RENDER_VERSION}-v1`);
  });

  it('calls an unnamed climber by the page fallback, never Crusher', async () => {
    profilePageTestState.getProfileOgSummaryMock.mockResolvedValue({ ...BASE_SUMMARY, displayName: null });

    const metadata = await pageModule.generateMetadata({ params: Promise.resolve({ user_id: 'user-1' }) });

    expect(metadata.title).toEqual({ absolute: "Climber's Climbing Sessions | Boardsesh" });
    expect(metadata.openGraph?.title).toBe('Climber on Boardsesh');
    expect(metadata.openGraph?.description).toBe('No sends logged yet. See the profile.');
    expect(JSON.stringify(metadata)).not.toContain('Crusher');
  });

  it('counts sends it cannot name, when every one is on a hidden climb', async () => {
    profilePageTestState.getProfileOgSummaryMock.mockResolvedValue({
      ...BASE_SUMMARY,
      sentClimbCount: 3,
      sentBoardTypes: ['moonboard'],
    });

    const metadata = await pageModule.generateMetadata({ params: Promise.resolve({ user_id: 'user-1' }) });

    expect(metadata.openGraph?.title).toBe('Marco on Boardsesh');
    expect(metadata.openGraph?.description).toBe('3 climbs sent on MoonBoard. See the logbook.');
  });

  it('advertises no card for a private or missing profile', async () => {
    profilePageTestState.getProfileOgSummaryMock.mockResolvedValue(null);

    const metadata = await pageModule.generateMetadata({ params: Promise.resolve({ user_id: 'private-user' }) });

    expect(metadata.openGraph?.images).toBeUndefined();
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
