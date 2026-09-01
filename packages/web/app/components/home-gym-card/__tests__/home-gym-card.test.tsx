import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { GYM_KIOSK_FLAG } from '@/app/flags';
import HomeGymCard from '../home-gym-card';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// --- Controllable mock state ---
let mockGyms: Array<Record<string, unknown>> = [];
let mockIsLoading = false;
let mockError: string | null = null;
// Mirrors the real hook's `hasResolved` (React Query `isFetched`): false while
// the ws-auth token is still in flight, true once the fetch has settled
// (success or error). Defaults true so most tests don't need to think about it.
let mockHasResolved = true;
let mockStatus: 'authenticated' | 'unauthenticated' | 'loading' = 'authenticated';
let mockUserId: string | null = 'user-1';
let mockKioskFlag = true;

vi.mock('@/app/hooks/use-my-gyms', () => ({
  useMyGyms: () => ({
    gyms: mockGyms,
    isLoading: mockIsLoading,
    isFetchingMore: false,
    hasMore: false,
    loadMore: vi.fn(),
    error: mockError,
    hasResolved: mockHasResolved,
  }),
}));

vi.mock('@/app/components/providers/feature-flags-provider', () => ({
  // Only the gym-kiosk flag is toggled by the card; assert on the exact key so a
  // second useFeatureFlag call can't silently piggyback on the same mock value.
  useFeatureFlag: (flag: string) => (flag === GYM_KIOSK_FLAG ? mockKioskFlag : false),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    status: mockStatus,
    data: mockUserId ? { user: { id: mockUserId } } : null,
  }),
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function makeGym(overrides?: Record<string, unknown>) {
  return {
    uuid: 'gym-uuid-1',
    slug: 'boulder-project',
    ownerId: 'user-1',
    name: 'Boulder Project',
    address: '123 Crux St',
    isPublic: true,
    boardCount: 3,
    memberCount: 12,
    followerCount: 8,
    commentCount: 0,
    isFollowedByMe: false,
    isMember: true,
    myRole: 'admin',
    canEdit: true,
    canGrantAccess: true,
    canClaim: false,
    canClaimByDomain: false,
    createdAt: '2024-01-01',
    boardTypes: ['kilter'],
    ...overrides,
  };
}

describe('HomeGymCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGyms = [];
    mockIsLoading = false;
    mockError = null;
    mockHasResolved = true;
    mockStatus = 'authenticated';
    mockUserId = 'user-1';
    mockKioskFlag = true;
  });

  describe('variant selection', () => {
    it('renders nothing for signed-out visitors', () => {
      mockStatus = 'unauthenticated';
      mockGyms = [makeGym()];
      const { container } = render(<HomeGymCard />);
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing while the gyms request is still loading', () => {
      mockIsLoading = true;
      mockHasResolved = false;
      mockGyms = [];
      render(<HomeGymCard />);
      expect(screen.queryByTestId('home-gym-card-owner')).toBeNull();
      expect(screen.queryByTestId('home-gym-card-find')).toBeNull();
    });

    it('renders nothing while the ws-auth token is still in flight (pre-token, not yet resolved)', () => {
      // The bug this pins: the hook used to report isLoading=false AND gyms=[]
      // while idle pre-token, which the old gate misread as "loaded with zero
      // gyms" and flashed the non-owner nudge. hasResolved=false is the
      // definitive "we don't know yet" signal regardless of isLoading.
      mockIsLoading = false;
      mockHasResolved = false;
      mockGyms = [];
      render(<HomeGymCard />);
      expect(screen.queryByTestId('home-gym-card-owner')).toBeNull();
      expect(screen.queryByTestId('home-gym-card-find')).toBeNull();
    });

    it('renders nothing when the gyms request errored', () => {
      mockError = 'boom';
      mockGyms = [];
      render(<HomeGymCard />);
      expect(screen.queryByTestId('home-gym-card-owner')).toBeNull();
      expect(screen.queryByTestId('home-gym-card-find')).toBeNull();
    });

    it('shows the owner variant when the user has a gym', async () => {
      mockGyms = [makeGym()];
      render(<HomeGymCard />);
      const card = await screen.findByTestId('home-gym-card-owner');
      expect(card).toBeTruthy();
      expect(screen.getByText('Boulder Project')).toBeTruthy();
      expect(screen.queryByTestId('home-gym-card-find')).toBeNull();
    });

    it('renders nothing for a signed-in climber with no gym', () => {
      // The "Find your gym" nudge went with the search drawer it opened. The
      // homepage has no gym-discovery affordance until #4372 builds one —
      // recorded as an accepted loss, not an oversight.
      mockGyms = [];
      const { container } = render(<HomeGymCard />);
      expect(container.firstChild).toBeNull();
      expect(screen.queryByTestId('home-gym-card-find')).toBeNull();
    });
  });

  describe('owner actions and hrefs', () => {
    it('links Manage to the manage route and View page to the public gym page', async () => {
      mockGyms = [makeGym({ slug: 'boulder-project' })];
      render(<HomeGymCard />);
      await screen.findByTestId('home-gym-card-owner');

      expect(screen.getByTestId('home-gym-card-manage').getAttribute('href')).toBe('/gym/boulder-project/manage');
      expect(screen.getByTestId('home-gym-card-view').getAttribute('href')).toBe('/gym/boulder-project');
    });

    it('falls back to the uuid for the manage route on a slug-less gym and hides View page', async () => {
      mockGyms = [makeGym({ slug: null, uuid: 'gym-uuid-9' })];
      render(<HomeGymCard />);
      await screen.findByTestId('home-gym-card-owner');

      expect(screen.getByTestId('home-gym-card-manage').getAttribute('href')).toBe('/gym/gym-uuid-9/manage');
      expect(screen.queryByTestId('home-gym-card-view')).toBeNull();
    });

    it('gates Manage behind the gym-kiosk flag but keeps View page', async () => {
      mockKioskFlag = false;
      mockGyms = [makeGym({ slug: 'boulder-project' })];
      render(<HomeGymCard />);
      await screen.findByTestId('home-gym-card-owner');

      expect(screen.queryByTestId('home-gym-card-manage')).toBeNull();
      expect(screen.getByTestId('home-gym-card-view').getAttribute('href')).toBe('/gym/boulder-project');
    });

    it('gates Manage behind canEdit even when the flag is on', async () => {
      mockGyms = [makeGym({ slug: 'boulder-project', canEdit: false })];
      render(<HomeGymCard />);
      await screen.findByTestId('home-gym-card-owner');

      expect(screen.queryByTestId('home-gym-card-manage')).toBeNull();
      expect(screen.getByTestId('home-gym-card-view')).toBeTruthy();
    });

    it('renders nothing when a slug-less gym has no manage access (no actionable owner card)', () => {
      mockKioskFlag = false;
      mockGyms = [makeGym({ slug: null, canEdit: false })];
      render(<HomeGymCard />);
      expect(screen.queryByTestId('home-gym-card-owner')).toBeNull();
    });

    it('shows the first gym and no "and N more" control for a user with three', async () => {
      // The multi-gym drawer went with `my-gyms-drawer`. A user with several
      // gyms sees the first one; the rest are reachable from the app.
      mockGyms = [makeGym({ uuid: 'gym-a' }), makeGym({ uuid: 'gym-b' }), makeGym({ uuid: 'gym-c' })];
      render(<HomeGymCard />);
      await screen.findByTestId('home-gym-card-owner');

      expect(screen.queryByTestId('home-gym-card-more')).toBeNull();
      expect(screen.getAllByTestId('home-gym-card-owner')).toHaveLength(1);
    });

    it('renders nothing when a slug-less gym has no manage access, even with several gyms', () => {
      // `showMore` used to keep this card alive with nothing else actionable
      // on it. Without the drawer there is nothing to show.
      mockKioskFlag = false;
      mockGyms = [makeGym({ slug: null, canEdit: false }), makeGym({ uuid: 'gym-b' })];
      render(<HomeGymCard />);
      expect(screen.queryByTestId('home-gym-card-owner')).toBeNull();
    });
  });
});
