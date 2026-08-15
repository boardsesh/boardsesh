// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import MarketingHeader from '../marketing-header';

/**
 * Successor to `global-header/__tests__/global-header.test.tsx`.
 *
 * The search-field and board-route cases are gone with the search drawer and
 * the persistent-session bridge; everything the profile / `/you` / `/settings`
 * surfaces still depend on is re-asserted here, plus two new obligations this
 * header picked up: the account affordance that replaces the deleted UserDrawer
 * (the only sign-in entry point outside `/auth`) and the chrome-less bail.
 */

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

let mockPathname = '/';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

vi.mock('@/app/components/back-button', () => ({
  default: (props: { fallbackUrl?: string }) => (
    <button data-testid="back-button" data-fallback={props.fallbackUrl}>
      Back
    </button>
  ),
}));

let mockSessionData: { user: { id: string; name: string } } | null = {
  user: { id: 'user-1', name: 'Test User' },
};
let mockSessionStatus = 'authenticated';
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockSessionData, status: mockSessionStatus }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const mockShareWithFallback = vi.fn();
vi.mock('@/app/lib/share-utils', () => ({
  shareWithFallback: (...args: unknown[]) => mockShareWithFallback(...args),
}));

vi.mock('@/app/hooks/use-unread-notification-count', () => ({
  useUnreadNotificationCount: () => 3,
}));

let mockStatsFilterBridgeState = {
  isActive: false,
  pageTitle: null as string | null,
  backUrl: null as string | null,
  openFilterDrawer: null as (() => void) | null,
  hasActiveFilters: false,
};
vi.mock('@/app/components/stats-filter-bridge/stats-filter-bridge-context', () => ({
  useStatsFilterBridge: () => mockStatsFilterBridgeState,
}));

let mockProfileHeaderShareState = {
  isActive: false,
  displayName: null as string | null,
};
vi.mock('@/app/components/profile-header-bridge/profile-header-bridge-context', () => ({
  useProfileHeaderShare: () => mockProfileHeaderShareState,
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

describe('MarketingHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/some-page';
    mockSessionData = { user: { id: 'user-1', name: 'Test User' } };
    mockSessionStatus = 'authenticated';
    mockStatsFilterBridgeState = {
      isActive: false,
      pageTitle: null,
      backUrl: null,
      openFilterDrawer: null,
      hasActiveFilters: false,
    };
    mockProfileHeaderShareState = { isActive: false, displayName: null };
  });

  it('renders the brand link and the app hand-off, and no search field', () => {
    render(<MarketingHeader />);

    expect(screen.getByLabelText('Boardsesh home').closest('a')?.getAttribute('href')).toBe('/');
    expect(screen.getByLabelText('Start climbing in the app')).toBeTruthy();
    expect(screen.queryByPlaceholderText('What do you want to climb?')).toBeNull();
  });

  // -----------------------------------------------------------------------
  // The account affordance that replaces the deleted UserDrawer
  // -----------------------------------------------------------------------
  describe('account affordance', () => {
    it('offers a sign-in link when signed out — the only entry point outside /auth', () => {
      mockSessionData = null;
      mockSessionStatus = 'unauthenticated';
      render(<MarketingHeader />);

      expect(screen.getByText('Sign in').closest('a')?.getAttribute('href')).toBe('/auth/login');
    });

    it('links to your own profile when signed in', () => {
      render(<MarketingHeader />);

      expect(screen.getByLabelText('Your profile').closest('a')?.getAttribute('href')).toBe('/profile/user-1');
    });
  });

  // -----------------------------------------------------------------------
  // Chrome-less surfaces
  // -----------------------------------------------------------------------
  describe('on chrome-less surfaces', () => {
    it('renders nothing on a kiosk route', () => {
      mockPathname = '/kiosk/some-gym/lobby';
      const { container } = render(<MarketingHeader />);
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing on an embed route', () => {
      mockPathname = '/embed/gym/some-uuid/leaderboard';
      const { container } = render(<MarketingHeader />);
      expect(container.firstChild).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // /you
  // -----------------------------------------------------------------------
  describe('on /you pages', () => {
    it('renders a centered "You" title on the root /you page', () => {
      mockPathname = '/you';
      render(<MarketingHeader />);

      expect(screen.getByText('You')).toBeTruthy();
    });

    it('renders the settings cog linking to /settings, before the title', () => {
      mockPathname = '/you';
      const { container } = render(<MarketingHeader />);

      const settingsLink = screen.getByLabelText('Settings');
      expect(settingsLink.closest('a')?.getAttribute('href')).toBe('/settings');
      const title = screen.getByText('You');
      expect(Boolean(settingsLink.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
      expect(container.querySelectorAll('[aria-label="Settings"]').length).toBe(1);
    });

    it('renders the share button when the user is authenticated', () => {
      mockPathname = '/you';
      render(<MarketingHeader />);

      expect(screen.getByLabelText('Share profile')).toBeTruthy();
    });

    it('renders no search bar', () => {
      mockPathname = '/you';
      render(<MarketingHeader />);

      expect(screen.queryByPlaceholderText('What do you want to climb?')).toBeNull();
    });

    it('renders the brand link where the user drawer used to sit', () => {
      mockPathname = '/you';
      render(<MarketingHeader />);

      expect(screen.getByLabelText('Boardsesh home')).toBeTruthy();
    });

    it('renders the settings cog on /you/sessions too', () => {
      mockPathname = '/you/sessions';
      render(<MarketingHeader />);

      expect(screen.getByLabelText('Settings').closest('a')?.getAttribute('href')).toBe('/settings');
    });

    it('drops the share button when the user is not authenticated but keeps the cog', () => {
      mockPathname = '/you';
      mockSessionData = null;
      mockSessionStatus = 'unauthenticated';
      render(<MarketingHeader />);

      expect(screen.queryByLabelText('Share profile')).toBeNull();
      expect(screen.getByLabelText('Settings')).toBeTruthy();
    });

    it('shares the profile URL when the share button is clicked', () => {
      mockPathname = '/you';
      render(<MarketingHeader />);

      fireEvent.click(screen.getByLabelText('Share profile'));

      expect(mockShareWithFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('/profile/user-1'),
          title: expect.stringContaining('Test User'),
          trackingEvent: 'Profile Shared',
        }),
      );
    });

    it('renders the stats filter action on the root /you page when the bridge is active', () => {
      mockPathname = '/you';
      mockStatsFilterBridgeState = {
        isActive: true,
        pageTitle: 'Progress',
        backUrl: null,
        openFilterDrawer: vi.fn(),
        hasActiveFilters: true,
      };

      const { container } = render(<MarketingHeader />);

      expect(screen.getByLabelText('Open stats filters')).toBeTruthy();
      expect(container.querySelector('[class*="filterActiveIndicator"]')).toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------
  // /profile — profile statistics depends on every branch below
  // -----------------------------------------------------------------------
  describe('on /profile pages', () => {
    it('renders a back button instead of the brand link on the root profile page', () => {
      mockPathname = '/profile/user-2';
      render(<MarketingHeader />);

      expect(screen.getByTestId('back-button').getAttribute('data-fallback')).toBe('/');
      expect(screen.queryByLabelText('Boardsesh home')).toBeNull();
    });

    it('renders a share button for the viewed profile when profile share state is active', () => {
      mockPathname = '/profile/user-2';
      mockProfileHeaderShareState = { isActive: true, displayName: 'Viewed User' };

      render(<MarketingHeader />);

      expect(screen.getByLabelText('Share profile')).toBeTruthy();
    });

    it('shares the viewed profile URL from the root profile header', () => {
      mockPathname = '/profile/user-2';
      mockProfileHeaderShareState = { isActive: true, displayName: 'Viewed User' };

      render(<MarketingHeader />);
      fireEvent.click(screen.getByLabelText('Share profile'));

      expect(mockShareWithFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('/profile/user-2'),
          title: expect.stringContaining('Viewed User'),
          trackingEvent: 'Profile Shared',
        }),
      );
    });

    it('renders the child page title', () => {
      mockPathname = '/profile/user-2/sessions';
      render(<MarketingHeader />);

      expect(screen.getByText('Sessions')).toBeTruthy();
      expect(screen.getByTestId('back-button').getAttribute('data-fallback')).toBe('/profile/user-2');
    });

    it('renders the statistics filter action when the bridge is active', () => {
      mockPathname = '/profile/user-2/statistics';
      mockStatsFilterBridgeState = {
        isActive: true,
        pageTitle: 'Statistics',
        backUrl: '/profile/user-2',
        openFilterDrawer: vi.fn(),
        hasActiveFilters: true,
      };

      const { container } = render(<MarketingHeader />);

      expect(screen.getByText('Statistics')).toBeTruthy();
      expect(screen.getByLabelText('Open stats filters')).toBeTruthy();
      expect(container.querySelector('[class*="filterActiveIndicator"]')).toBeTruthy();
    });
  });

  describe('on /settings pages', () => {
    it('renders the brand link but no settings cog, share button or search bar', () => {
      mockPathname = '/settings';
      render(<MarketingHeader />);

      expect(screen.getByLabelText('Boardsesh home')).toBeTruthy();
      expect(screen.queryByLabelText('Settings')).toBeNull();
      expect(screen.queryByLabelText('Share profile')).toBeNull();
      expect(screen.queryByPlaceholderText('What do you want to climb?')).toBeNull();
    });
  });

  describe('on the home page', () => {
    it('renders a transparent bar with the brand link and the app hand-off', () => {
      mockPathname = '/';
      render(<MarketingHeader />);

      expect(screen.getByLabelText('Boardsesh home')).toBeTruthy();
      expect(screen.getByLabelText('Start climbing in the app')).toBeTruthy();
      expect(screen.queryByLabelText('Settings')).toBeNull();
    });
  });

  describe('on /aurora-migration', () => {
    it('renders the title header with a back button', () => {
      mockPathname = '/aurora-migration';
      render(<MarketingHeader />);

      expect(screen.getByText('Aurora Migration')).toBeTruthy();
      expect(screen.getByTestId('back-button').getAttribute('data-fallback')).toBe('/');
    });
  });
});
