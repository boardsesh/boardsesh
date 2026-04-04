import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

let mockActiveSession: Record<string, unknown> | null = null;
let mockIsOnBoardRoute = false;

vi.mock('@/app/components/persistent-session/persistent-session-context', () => ({
  usePersistentSession: () => ({
    activeSession: mockActiveSession,
  }),
  useIsOnBoardRoute: () => mockIsOnBoardRoute,
}));

const mockOpenClimbSearchDrawer = vi.fn();
let mockBridgeState = {
  openClimbSearchDrawer: null as (() => void) | null,
  searchPillSummary: null as string | null,
  hasActiveFilters: false,
};

vi.mock('@/app/components/search-drawer/search-drawer-bridge-context', () => ({
  useSearchDrawerBridge: () => mockBridgeState,
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

vi.mock('@/app/components/user-drawer/user-drawer', () => ({
  default: () => <div data-testid="user-drawer" />,
}));

let mockPathname = '/';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

vi.mock('@/app/components/back-button', () => ({
  default: () => <button data-testid="back-button">Back</button>,
}));

import GlobalHeader from '../global-header';

const mockBoardConfigs = {} as Parameters<typeof GlobalHeader>[0]['boardConfigs'];

describe('GlobalHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveSession = null;
    mockIsOnBoardRoute = false;
    mockPathname = '/some-page';
    mockBridgeState = {
      openClimbSearchDrawer: null,
      searchPillSummary: null,
      hasActiveFilters: false,
    };
  });

  it('renders user drawer, search pill, and Sesh button', () => {
    render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

    expect(screen.getByTestId('user-drawer')).toBeTruthy();
    expect(screen.getByText('Search')).toBeTruthy();
    expect(screen.getByText('Sesh')).toBeTruthy();
  });

  it('opens UnifiedSearchDrawer when search pill is clicked', () => {
    render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

    expect(screen.queryByTestId('unified-search-drawer')).toBeNull();

    fireEvent.click(screen.getByText('Search'));
    expect(screen.getByTestId('unified-search-drawer')).toBeTruthy();
  });

  it('passes "boards" as defaultCategory when not on board route', () => {
    mockIsOnBoardRoute = false;
    render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

    fireEvent.click(screen.getByText('Search'));
    expect(screen.getByTestId('unified-search-drawer').getAttribute('data-category')).toBe('boards');
  });

  it('passes "climbs" as defaultCategory when on board route', () => {
    mockIsOnBoardRoute = true;
    render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

    fireEvent.click(screen.getByText('Search'));
    expect(screen.getByTestId('unified-search-drawer').getAttribute('data-category')).toBe('climbs');
  });

  it('opens StartSeshDrawer when clicking Sesh with no active session', () => {
    mockActiveSession = null;
    render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

    fireEvent.click(screen.getByText('Sesh'));
    expect(screen.getByTestId('start-sesh-drawer')).toBeTruthy();
    expect(screen.queryByTestId('sesh-settings-drawer')).toBeNull();
  });

  it('opens SeshSettingsDrawer when clicking Sesh with active session', () => {
    mockActiveSession = { sessionId: 'session-123', boardPath: '/b/test/40/list' };
    render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

    fireEvent.click(screen.getByText('Sesh'));
    expect(screen.getByTestId('sesh-settings-drawer')).toBeTruthy();
    expect(screen.queryByTestId('start-sesh-drawer')).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Bridge integration tests
  // -----------------------------------------------------------------------
  describe('with search drawer bridge active (on board list page)', () => {
    beforeEach(() => {
      mockBridgeState = {
        openClimbSearchDrawer: mockOpenClimbSearchDrawer,
        searchPillSummary: 'V5-V7 · Tall',
        hasActiveFilters: true,
      };
    });

    it('shows filter summary text instead of "Search" when bridge is active', () => {
      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      expect(screen.getByText('V5-V7 · Tall')).toBeTruthy();
      expect(screen.queryByText('Search')).toBeNull();
    });

    it('calls openClimbSearchDrawer instead of opening its own drawer', () => {
      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      fireEvent.click(screen.getByText('V5-V7 · Tall'));

      expect(mockOpenClimbSearchDrawer).toHaveBeenCalledTimes(1);
      // Should NOT open its own UnifiedSearchDrawer
      expect(screen.queryByTestId('unified-search-drawer')).toBeNull();
    });

    it('shows active indicator dot when filters are active', () => {
      const { container } = render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      const activeIndicator = container.querySelector('[class*="searchPillActiveIndicator"]');
      expect(activeIndicator).toBeTruthy();
    });

    it('does not show active indicator dot when filters are not active', () => {
      mockBridgeState = {
        openClimbSearchDrawer: mockOpenClimbSearchDrawer,
        searchPillSummary: 'Search climbs...',
        hasActiveFilters: false,
      };

      const { container } = render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      const activeIndicator = container.querySelector('[class*="searchPillActiveIndicator"]');
      expect(activeIndicator).toBeNull();
    });

    it('adds onboarding-search-button id when bridge is active', () => {
      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      const searchButton = screen.getByText('V5-V7 · Tall').closest('button');
      expect(searchButton?.id).toBe('onboarding-search-button');
    });

    it('does not add onboarding-search-button id when bridge is inactive', () => {
      mockBridgeState = {
        openClimbSearchDrawer: null,
        searchPillSummary: null,
        hasActiveFilters: false,
      };

      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      const searchButton = screen.getByText('Search').closest('button');
      expect(searchButton?.id).toBe('');
    });

    it('shows "Search" when bridge has null summary', () => {
      mockBridgeState = {
        openClimbSearchDrawer: mockOpenClimbSearchDrawer,
        searchPillSummary: null,
        hasActiveFilters: false,
      };

      render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

      expect(screen.getByText('Search')).toBeTruthy();
    });
  });

  it('shows "Search climbs..." on board list routes before the bridge registers', () => {
    mockPathname = '/b/test-board/40/list';

    render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

    expect(screen.getByText('Search climbs...')).toBeTruthy();
    expect(screen.queryByText('Search')).toBeNull();
  });

  it('keeps "Search" on non-list routes when the bridge is inactive', () => {
    mockPathname = '/b/test-board/40/view/some-climb';

    render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

    expect(screen.getByText('Search')).toBeTruthy();
    expect(screen.queryByText('Search climbs...')).toBeNull();
  });

  it('falls back to "Search climbs..." when the bridge is active on a list route but summary is null', () => {
    mockPathname = '/b/test-board/40/list';
    mockBridgeState = {
      openClimbSearchDrawer: mockOpenClimbSearchDrawer,
      searchPillSummary: null,
      hasActiveFilters: false,
    };

    render(<GlobalHeader boardConfigs={mockBoardConfigs} />);

    expect(screen.getByText('Search climbs...')).toBeTruthy();
    expect(screen.queryByText('Search')).toBeNull();
  });
});
