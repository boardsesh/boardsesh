import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const controls = vi.hoisted(() => ({
  token: vi.fn(),
  session: vi.fn(),
  profile: vi.fn(),
  stats: vi.fn(),
  beta: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/app/lib/auth/admitted-session.server', () => ({
  getAdmittedServerSession: controls.session,
}));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken: controls.token }));
vi.mock('../server-profile-data', () => ({ getProfileData: controls.profile }));
vi.mock('../server-profile-stats', () => ({ fetchProfileStatsData: controls.stats }));
vi.mock('@/app/lib/server-user-beta-links', () => ({ getUserBetaLinks: controls.beta }));
vi.mock('@/app/lib/seo/dynamic-og-data', () => ({ getProfileOgSummary: vi.fn() }));
vi.mock('../profile-page-content', () => ({ default: () => null }));
vi.mock('../statistics/analytics-content', () => ({ default: () => null }));
vi.mock('../sessions/sessions-content', () => ({ default: () => null }));
vi.mock('../profile-json-ld', () => ({ default: () => null }));
vi.mock('@/app/components/providers/i18n-provider', () => ({ default: () => null }));

import ProfilePage from '@/app/(site)/profile/[user_id]/page';
import ProfileStatisticsPage from '@/app/(site)/profile/[user_id]/statistics/page';
import ProfileSessionsPage from '@/app/(site)/profile/[user_id]/sessions/page';

const ownerProfile = {
  id: 'profile-owner',
  name: 'Climber name',
  image: null,
  profile: null,
  followerCount: 3,
  followingCount: 2,
  isFollowedByMe: false,
  isPrivate: false,
  canViewActivity: true,
};
const ownerSeedMarkers = ['OWNER_EMAIL', 'OWNER_MAPPING', 'OWNER_LOGBOOK', 'OWNER_BETA'];
const params = () => Promise.resolve({ user_id: 'profile-owner' });

beforeEach(() => {
  vi.clearAllMocks();
  controls.token.mockResolvedValue('private-server-token');
  controls.session.mockResolvedValue({ user: { id: 'profile-owner' } });
  controls.profile.mockResolvedValue({
    ...ownerProfile,
    email: ownerSeedMarkers[0],
    credentials: [{ boardType: 'kilter', auroraUsername: ownerSeedMarkers[1] }],
  });
  controls.stats.mockResolvedValue({
    initialProfileStats: null,
    initialPercentile: null,
    initialAllBoardsTicks: { kilter: [ownerSeedMarkers[2]] },
    initialLogbook: [ownerSeedMarkers[2]],
  });
  controls.beta.mockResolvedValue([{ betaLink: ownerSeedMarkers[3] }]);
});

describe('profile-family server props', () => {
  it('passes owner-specific profile and statistics seeds and session hints to the signed-in owner', async () => {
    const profile = await ProfilePage({ params: params() });
    const statistics = await ProfileStatisticsPage({ params: params() });
    const sessions = await ProfileSessionsPage({ params: params() });
    for (const marker of ownerSeedMarkers) expect(JSON.stringify(profile)).toContain(marker);
    expect(JSON.stringify(statistics)).toContain('OWNER_LOGBOOK');
    expect(JSON.stringify(statistics)).toContain('"initialIsOwnProfile":true');
    expect(JSON.stringify(sessions)).toContain('"isAuthenticatedSSR":true');
    expect(controls.profile).toHaveBeenCalledWith('profile-owner', 'profile-owner');
    expect(controls.stats).toHaveBeenCalledTimes(2);
    expect(controls.beta).toHaveBeenCalledTimes(1);
  });

  it('propagates credential uncertainty before any profile-family data fetch', async () => {
    controls.token.mockRejectedValue(new Error('primary authority unavailable'));
    controls.session.mockRejectedValue(new Error('primary authority unavailable'));
    for (const page of [ProfilePage, ProfileStatisticsPage, ProfileSessionsPage])
      await expect(page({ params: params() })).rejects.toThrow('primary authority unavailable');
    expect(controls.profile).not.toHaveBeenCalled();
    expect(controls.stats).not.toHaveBeenCalled();
    expect(controls.beta).not.toHaveBeenCalled();
  });
});
