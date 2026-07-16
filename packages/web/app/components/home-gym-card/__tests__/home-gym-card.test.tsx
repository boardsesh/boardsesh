import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
let mockStatus: 'authenticated' | 'unauthenticated' | 'loading' = 'authenticated';
let mockUserId: string | null = 'user-1';
let mockKioskFlag = true;
let mockDismissed = false;
const mockSetPreference = vi.fn<(key: string, value: unknown) => Promise<void>>(() => Promise.resolve());
const mockTrack = vi.fn();

vi.mock('@/app/hooks/use-my-gyms', () => ({
  useMyGyms: () => ({
    gyms: mockGyms,
    isLoading: mockIsLoading,
    isFetchingMore: false,
    hasMore: false,
    loadMore: vi.fn(),
    error: mockError,
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

vi.mock('@/app/lib/user-preferences-db', () => ({
  getPreference: () => Promise.resolve(mockDismissed),
  setPreference: (key: string, value: unknown) => mockSetPreference(key, value),
}));

vi.mock('@/app/lib/analytics', () => ({
  track: (...args: unknown[]) => mockTrack(...args),
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// next/dynamic runs the loader (the mocked drawer module below) asynchronously;
// findBy* waits for it to resolve and render.
vi.mock('@/app/components/my-gyms-drawer/my-gyms-drawer', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="my-gyms-drawer" /> : null),
}));

vi.mock('@/app/components/search-drawer/unified-search-drawer', () => ({
  default: ({ open, defaultCategory }: { open: boolean; defaultCategory?: string }) =>
    open ? <div data-testid="gym-search" data-category={defaultCategory} /> : null,
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
    mockStatus = 'authenticated';
    mockUserId = 'user-1';
    mockKioskFlag = true;
    mockDismissed = false;
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

    it('shows the non-owner "find your gym" variant when the user has no gyms', async () => {
      mockGyms = [];
      render(<HomeGymCard />);
      const card = await screen.findByTestId('home-gym-card-find');
      expect(card).toBeTruthy();
      expect(screen.getByText(/Climb at a gym with boards/i)).toBeTruthy();
      expect(screen.getByTestId('home-gym-card-find-cta')).toBeTruthy();
    });

    it('hides the non-owner variant once it has been dismissed', async () => {
      mockGyms = [];
      mockDismissed = true;
      render(<HomeGymCard />);
      // Give the async getPreference effect a chance to resolve.
      await waitFor(() => {
        expect(screen.queryByTestId('home-gym-card-find')).toBeNull();
      });
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

    it('shows an "and N more" affordance for multiple gyms and opens the My Gyms drawer', async () => {
      mockGyms = [makeGym({ uuid: 'gym-a' }), makeGym({ uuid: 'gym-b' }), makeGym({ uuid: 'gym-c' })];
      render(<HomeGymCard />);
      await screen.findByTestId('home-gym-card-owner');

      const more = screen.getByTestId('home-gym-card-more');
      expect(more.textContent).toMatch(/and 2 more/i);

      fireEvent.click(more);
      expect(await screen.findByTestId('my-gyms-drawer')).toBeTruthy();
      expect(mockTrack).toHaveBeenCalledWith('Homepage Gym Card Click', { action: 'open-my-gyms' });
    });

    it('does not show "and N more" for a single gym', async () => {
      mockGyms = [makeGym()];
      render(<HomeGymCard />);
      await screen.findByTestId('home-gym-card-owner');
      expect(screen.queryByTestId('home-gym-card-more')).toBeNull();
    });
  });

  describe('non-owner interactions', () => {
    it('opens the search drawer pre-set to the gyms category', async () => {
      mockGyms = [];
      render(<HomeGymCard />);
      const cta = await screen.findByTestId('home-gym-card-find-cta');

      fireEvent.click(cta);
      const search = await screen.findByTestId('gym-search');
      expect(search.getAttribute('data-category')).toBe('gyms');
      expect(mockTrack).toHaveBeenCalledWith('Homepage Gym Card Click', { action: 'find-gym' });
    });

    it('persists the dismissal and hides the card when dismissed', async () => {
      mockGyms = [];
      render(<HomeGymCard />);
      const dismiss = await screen.findByTestId('home-gym-card-dismiss');

      fireEvent.click(dismiss);
      expect(mockSetPreference).toHaveBeenCalledWith('homeGymCard:dismissed', true);
      await waitFor(() => {
        expect(screen.queryByTestId('home-gym-card-find')).toBeNull();
      });
      expect(mockTrack).toHaveBeenCalledWith('Homepage Gym Card Click', { action: 'dismiss' });
    });
  });
});
