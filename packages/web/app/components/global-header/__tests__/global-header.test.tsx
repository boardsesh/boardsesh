import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import GlobalHeader from '../global-header';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

let mockActiveSession: Record<string, unknown> | null = null;
let mockIsOnBoardRoute = false;

vi.mock('@/app/components/persistent-session/persistent-session-context', () => ({
  usePersistentSession: () => ({
    activeSession: mockActiveSession,
  }),
  usePersistentSessionState: () => ({
    activeSession: mockActiveSession,
  }),
  usePersistentSessionActions: () => ({}),
  useIsOnBoardRoute: () => mockIsOnBoardRoute,
}));

vi.mock('@/app/components/search-drawer/unified-search-drawer', () => ({
  default: ({ open, defaultCategory }: { open: boolean; onClose: () => void; defaultCategory: string }) =>
    open ? <div data-testid="unified-search-drawer" data-category={defaultCategory} /> : null,
}));

vi.mock('@/app/components/session-creation/start-sesh-drawer', () => ({
  default: ({ open }: { open: boolean; onClose: () => void }) =>
    open ? <div data-testid="start-sesh-drawer" /> : null,
}));

vi.mock('@/app/components/sesh-settings/sesh-settings-drawer', () => ({
  default: ({ open }: { open: boolean; onClose: () => void }) =>
    open ? <div data-testid="sesh-settings-drawer" /> : null,
}));

vi.mock('@/app/components/sesh-settings/sesh-settings-drawer-event', () => ({
  SESH_SETTINGS_DRAWER_EVENT: 'boardsesh:open-sesh-settings-drawer',
}));

vi.mock('@/app/components/user-drawer/user-drawer', () => ({
  default: () => <div data-testid="user-drawer" />,
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

const mockBoardConfigs = {} as Parameters<typeof GlobalHeader>[0]['boardConfigs'];

describe('GlobalHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveSession = null;
    mockIsOnBoardRoute = false;
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
    mockProfileHeaderShareState = {
      isActive: false,
      displayName: null,
    };
  });

  it('renders user drawer and search input', () => {
    render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

    expect(screen.getByTestId('user-drawer')).toBeTruthy();
    // Search input renders as a TextField with placeholder
    expect(screen.getByPlaceholderText('What do you want to climb?')).toBeTruthy();
  });

  it('does not render a Sesh button', () => {
    render(<GlobalHeader boardConfigs={mockBoardConfigs} />);
    expect(screen.queryByText('Sesh')).toBeNull();
  });

  it('opens UnifiedSearchDrawer when search input is focused (non-list page)', () => {
    render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

    expect(screen.queryByTestId('unified-search-drawer')).toBeNull();

    fireEvent.focus(screen.getByPlaceholderText('What do you want to climb?'));
    expect(screen.getByTestId('unified-search-drawer')).toBeTruthy();
  });

  it('passes "boards" as defaultCategory when not on board route', () => {
    mockIsOnBoardRoute = false;
    render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

    fireEvent.focus(screen.getByPlaceholderText('What do you want to climb?'));
    expect(screen.getByTestId('unified-search-drawer').getAttribute('data-category')).toBe('boards');
  });

  it('passes "climbs" as defaultCategory when on board route', () => {
    mockIsOnBoardRoute = true;
    render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

    fireEvent.focus(screen.getByPlaceholderText('What do you want to climb?'));
    expect(screen.getByTestId('unified-search-drawer').getAttribute('data-category')).toBe('climbs');
  });

  // -----------------------------------------------------------------------
  // Board list pages (post-W-17: no in-place filter, no bridge)
  // -----------------------------------------------------------------------
  describe('on board list routes', () => {
    beforeEach(() => {
      mockPathname = '/b/test-board/40/list';
    });

    it('shows the same generic search trigger every other page shows', () => {
      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      const input = screen.getByPlaceholderText('What do you want to climb?') as HTMLInputElement;
      expect(input.readOnly).toBe(true);
      expect(input.value).toBe('');
    });

    it('renders no filter button — the board-route drawer it drove is gone', () => {
      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      expect(screen.queryByLabelText('Open filters')).toBeNull();
      expect(screen.queryByLabelText('Clear search')).toBeNull();
    });

    it('opens the unified search drawer on focus, like any other page', () => {
      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      fireEvent.focus(screen.getByPlaceholderText('What do you want to climb?'));
      expect(screen.getByTestId('unified-search-drawer')).toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------
  // /you and /settings header tests
  // -----------------------------------------------------------------------
  describe('on /you pages', () => {
    it('renders a centered "You" title on the root /you page', () => {
      mockPathname = '/you';
      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      expect(screen.getByText('You')).toBeTruthy();
    });

    it('renders settings cog icon linking to /settings', () => {
      mockPathname = '/you';
      const { container } = render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      const settingsLink = screen.getByLabelText('Settings');
      expect(settingsLink).toBeTruthy();
      expect(settingsLink.closest('a')?.getAttribute('href')).toBe('/settings');
      const title = screen.getByText('You');
      expect(Boolean(settingsLink.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
      expect(container.querySelectorAll('[aria-label="Settings"]').length).toBe(1);
    });

    it('renders share button when user is authenticated', () => {
      mockPathname = '/you';
      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      expect(screen.getByLabelText('Share profile')).toBeTruthy();
    });

    it('does NOT render search bar', () => {
      mockPathname = '/you';
      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      expect(screen.queryByPlaceholderText('What do you want to climb?')).toBeNull();
      expect(screen.queryByPlaceholderText('Search climbs...')).toBeNull();
    });

    it('renders user drawer', () => {
      mockPathname = '/you';
      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      expect(screen.getByTestId('user-drawer')).toBeTruthy();
    });

    it('renders settings cog on /you/sessions path (starts with /you)', () => {
      mockPathname = '/you/sessions';
      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      const settingsLink = screen.getByLabelText('Settings');
      expect(settingsLink).toBeTruthy();
      expect(settingsLink.closest('a')?.getAttribute('href')).toBe('/settings');
    });

    it('does not render share button when user is not authenticated', () => {
      mockPathname = '/you';
      mockSessionData = null;
      mockSessionStatus = 'unauthenticated';
      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      expect(screen.queryByLabelText('Share profile')).toBeNull();
      // Settings cog should still render
      expect(screen.getByLabelText('Settings')).toBeTruthy();
    });

    it('calls shareWithFallback with profile URL when share button is clicked', () => {
      mockPathname = '/you';
      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

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

      const { container } = render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      expect(screen.getByLabelText('Open stats filters')).toBeTruthy();
      expect(container.querySelector('[class*="filterActiveIndicator"]')).toBeTruthy();
    });
  });

  describe('on /profile pages', () => {
    it('renders a back button instead of the user drawer on the root profile page', () => {
      mockPathname = '/profile/user-2';
      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      expect(screen.getByTestId('back-button')).toBeTruthy();
      expect(screen.getByTestId('back-button').getAttribute('data-fallback')).toBe('/');
      expect(screen.queryByTestId('user-drawer')).toBeNull();
    });

    it('renders a share button for the viewed profile when profile share state is active', () => {
      mockPathname = '/profile/user-2';
      mockProfileHeaderShareState = {
        isActive: true,
        displayName: 'Viewed User',
      };

      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      expect(screen.getByLabelText('Share profile')).toBeTruthy();
    });

    it('shares the viewed profile URL from the root profile header', () => {
      mockPathname = '/profile/user-2';
      mockProfileHeaderShareState = {
        isActive: true,
        displayName: 'Viewed User',
      };

      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);
      fireEvent.click(screen.getByLabelText('Share profile'));

      expect(mockShareWithFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('/profile/user-2'),
          title: expect.stringContaining('Viewed User'),
          trackingEvent: 'Profile Shared',
        }),
      );
    });

    it('renders the child page title in the global header', () => {
      mockPathname = '/profile/user-2/sessions';
      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      expect(screen.getByText('Sessions')).toBeTruthy();
      expect(screen.getByTestId('back-button').getAttribute('data-fallback')).toBe('/profile/user-2');
    });

    it('renders the statistics filter action in the profile header when the bridge is active', () => {
      mockPathname = '/profile/user-2/statistics';
      mockStatsFilterBridgeState = {
        isActive: true,
        pageTitle: 'Statistics',
        backUrl: '/profile/user-2',
        openFilterDrawer: vi.fn(),
        hasActiveFilters: true,
      };

      const { container } = render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      expect(screen.getByText('Statistics')).toBeTruthy();
      expect(screen.getByLabelText('Open stats filters')).toBeTruthy();
      expect(container.querySelector('[class*="filterActiveIndicator"]')).toBeTruthy();
    });
  });

  describe('on /settings page', () => {
    it('renders the user drawer but no settings cog, share button, or search bar', () => {
      mockPathname = '/settings';
      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      expect(screen.getByTestId('user-drawer')).toBeTruthy();
      expect(screen.queryByLabelText('Settings')).toBeNull();
      expect(screen.queryByLabelText('Share profile')).toBeNull();
      expect(screen.queryByPlaceholderText('What do you want to climb?')).toBeNull();
    });
  });

  describe('on home page (/)', () => {
    it('renders transparent header with user drawer only', () => {
      mockPathname = '/';
      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      expect(screen.getByTestId('user-drawer')).toBeTruthy();
      expect(screen.queryByPlaceholderText('What do you want to climb?')).toBeNull();
      expect(screen.queryByLabelText('Settings')).toBeNull();
    });
  });

  describe('on /feed page', () => {
    it('renders search bar (default header)', () => {
      mockPathname = '/feed';
      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      expect(screen.getByPlaceholderText('What do you want to climb?')).toBeTruthy();
    });
  });
});
