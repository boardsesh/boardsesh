import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ServerRenderViewer } from '@/app/lib/auth/admitted-session.server';
import type { ServerProfileDataOptions } from '../server-profile-data';

const controls = vi.hoisted(() => ({
  viewer: vi.fn(),
  token: vi.fn(),
  session: vi.fn(),
  profile: vi.fn(),
  stats: vi.fn(),
  beta: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/app/lib/auth/admitted-session.server', () => ({
  getServerRenderViewer: controls.viewer,
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

import ProfilePage from '../page';
import ProfileStatisticsPage from '../statistics/page';
import ProfileSessionsPage from '../sessions/page';

const publicProfile = {
  id: 'profile-owner',
  name: 'Public climber name',
  image: null,
  email: undefined,
  profile: null,
  credentials: [],
  followerCount: 3,
  followingCount: 2,
  isFollowedByMe: false,
  isPrivate: false,
  canViewActivity: true,
};
const privateSentinels = ['PRIVATE_EMAIL', 'PRIVATE_MAPPING', 'PRIVATE_LOGBOOK', 'PRIVATE_BETA'];
const params = () => Promise.resolve({ user_id: 'profile-owner' });

beforeEach(() => {
  vi.clearAllMocks();
  controls.viewer.mockResolvedValue({ kind: 'legacy' });
  controls.token.mockResolvedValue('private-server-token');
  controls.session.mockResolvedValue({ user: { id: 'profile-owner' } });
  controls.profile.mockImplementation(
    async (_userId: string, _viewerUserId?: string, options?: ServerProfileDataOptions) =>
      options?.publicOnly
        ? publicProfile
        : {
            ...publicProfile,
            email: privateSentinels[0],
            credentials: [{ boardType: 'kilter', auroraUsername: privateSentinels[1] }],
          },
  );
  controls.stats.mockResolvedValue({
    initialProfileStats: null,
    initialPercentile: null,
    initialAllBoardsTicks: { kilter: [privateSentinels[2]] },
    initialLogbook: [privateSentinels[2]],
  });
  controls.beta.mockResolvedValue([{ betaLink: privateSentinels[3] }]);
});

describe('profile-family server prop inputs', () => {
  const viewers: ServerRenderViewer[] = [
    {
      kind: 'selected',
      owner: {
        userId: 'profile-owner',
        authSessionId: 'selected-session',
        generation: 4,
        cursor: { bindingId: 'b'.repeat(64), version: 8 },
      },
    },
    { kind: 'anonymous' },
    { kind: 'refused' },
  ];

  for (const viewer of viewers) {
    it(`${viewer.kind}: passes only independently public profile props and no private seeds`, async () => {
      controls.viewer.mockResolvedValue(viewer);
      const tree = await ProfilePage({ params: params() });
      const payloadInputs = JSON.stringify(tree);
      expect(controls.profile).toHaveBeenCalledWith('profile-owner', undefined, {
        authToken: undefined,
        publicOnly: true,
      });
      expect(payloadInputs).toContain('Public climber name');
      for (const sentinel of privateSentinels) expect(payloadInputs).not.toContain(sentinel);
      expect(payloadInputs).not.toContain('private-server-token');
      expect(controls.token).not.toHaveBeenCalled();
      expect(controls.session).not.toHaveBeenCalled();
      expect(controls.stats).not.toHaveBeenCalled();
      expect(controls.beta).not.toHaveBeenCalled();
    });

    it(`${viewer.kind}: statistics has no logbook seed and sessions has no authenticated server hint`, async () => {
      controls.viewer.mockResolvedValue(viewer);
      const statistics = await ProfileStatisticsPage({ params: params() });
      const sessions = await ProfileSessionsPage({ params: params() });
      expect(JSON.stringify(statistics)).not.toContain('PRIVATE_LOGBOOK');
      expect(JSON.stringify(statistics)).toContain('"initialIsOwnProfile":false');
      expect(JSON.stringify(sessions)).toContain('"isAuthenticatedSSR":false');
      expect(controls.stats).not.toHaveBeenCalled();
      expect(controls.token).not.toHaveBeenCalled();
      expect(controls.session).not.toHaveBeenCalled();
    });
  }

  it('retains existing owner-specific profile/statistics seeds and session hints for legacy rendering', async () => {
    const profile = await ProfilePage({ params: params() });
    const statistics = await ProfileStatisticsPage({ params: params() });
    const sessions = await ProfileSessionsPage({ params: params() });
    for (const sentinel of privateSentinels) expect(JSON.stringify(profile)).toContain(sentinel);
    expect(JSON.stringify(statistics)).toContain('PRIVATE_LOGBOOK');
    expect(JSON.stringify(statistics)).toContain('"initialIsOwnProfile":true');
    expect(JSON.stringify(sessions)).toContain('"isAuthenticatedSSR":true');
    expect(controls.profile).toHaveBeenCalledWith('profile-owner', 'profile-owner');
    expect(controls.stats).toHaveBeenCalledTimes(2);
    expect(controls.beta).toHaveBeenCalledTimes(1);
  });

  it('propagates central uncertainty before any profile-family data fetch or legacy token lookup', async () => {
    controls.viewer.mockRejectedValue(new Error('primary authority unavailable'));
    for (const page of [ProfilePage, ProfileStatisticsPage, ProfileSessionsPage])
      await expect(page({ params: params() })).rejects.toThrow('primary authority unavailable');
    expect(controls.profile).not.toHaveBeenCalled();
    expect(controls.stats).not.toHaveBeenCalled();
    expect(controls.beta).not.toHaveBeenCalled();
    expect(controls.token).not.toHaveBeenCalled();
  });
});
