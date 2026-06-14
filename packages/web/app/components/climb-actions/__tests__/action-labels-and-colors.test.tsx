import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { Climb, BoardDetails, BoardName } from '@/app/lib/types';
import type { ClimbActionProps, ClimbActionResult } from '../types';
import { ForkAction } from '../actions/fork-action';
import { TickAction } from '../actions/tick-action';
import { FavoriteAction } from '../actions/favorite-action';
import { QueueAction } from '../actions/queue-action';
import { MirrorAction } from '../actions/mirror-action';
import { AddBetaVideoAction } from '../actions/add-beta-video-action';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// --- Mock factories ---

function createMockClimb(overrides?: Partial<Climb>): Climb {
  return {
    uuid: 'climb-1',
    name: 'Test Climb',
    difficulty: 'V5',
    frames: 'p1r42',
    quality_average: '3.5',
    angle: 40,
    ascensionist_count: 10,
    display_difficulty: 5,
    difficulty_average: 12.5,
    setter_username: 'setter',
    ...overrides,
  } as Climb;
}

function createMockBoardDetails(overrides?: Partial<BoardDetails>): BoardDetails {
  return {
    board_name: 'kilter' as BoardName,
    layout_id: 1,
    size_id: 10,
    set_ids: [1, 2],
    layout_name: 'Original',
    size_name: '12x12',
    size_description: 'Full',
    set_names: ['Standard'],
    supportsMirroring: true,
    images_to_holds: {},
    holdsData: {},
    edge_left: 0,
    edge_right: 0,
    edge_bottom: 0,
    edge_top: 0,
    boardHeight: 100,
    boardWidth: 100,
    ...overrides,
  } as BoardDetails;
}

// --- Mocks ---

const mockUseSession = vi.fn();
vi.mock('next-auth/react', () => ({
  useSession: () => mockUseSession(),
}));

vi.mock('@/app/lib/analytics', () => ({
  track: vi.fn(),
}));

vi.mock('@/app/lib/url-utils', () => ({
  constructCreateClimbUrl: vi.fn(() => '/create-climb-url'),
  constructClimbInfoUrl: vi.fn(() => 'https://app.example.com/climb/info'),
}));

vi.mock('@/app/lib/open-external-url', () => ({
  openExternalUrl: vi.fn(),
}));

const mockUseOptionalBoardProvider = vi.fn();
vi.mock('../../board-provider/board-provider-context', () => ({
  useOptionalBoardProvider: () => mockUseOptionalBoardProvider(),
  BoardProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/app/hooks/use-my-boards', () => ({
  useMyBoards: () => ({ boards: [], isLoading: false }),
}));

vi.mock('@/app/hooks/use-always-tick-in-app', () => ({
  useAlwaysTickInApp: () => ({ alwaysUseApp: false, loaded: true, enableAlwaysUseApp: vi.fn() }),
}));

const mockUseFavorite = vi.fn();
vi.mock('../use-favorite', () => ({
  useFavorite: () => mockUseFavorite(),
}));

vi.mock('@/app/components/providers/auth-modal-provider', () => ({
  useAuthModal: () => ({ openAuthModal: vi.fn() }),
}));

const mockUseOptionalQueueActions = vi.fn();
const mockUseOptionalCurrentClimb = vi.fn();
vi.mock('../../graphql-queue', () => ({
  useOptionalQueueActions: () => mockUseOptionalQueueActions(),
  useOptionalCurrentClimb: () => mockUseOptionalCurrentClimb(),
}));

vi.mock('../../swipeable-drawer/swipeable-drawer', () => ({
  default: ({ children, open }: { children: React.ReactNode; open: boolean }) => (open ? <div>{children}</div> : null),
}));

vi.mock('../action-tooltip', () => ({
  ActionTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../../logbook/log-ascent-drawer', () => ({
  LogAscentDrawer: () => null,
}));

vi.mock('../../logbook/logascent-form', () => ({
  LogAscentForm: () => null,
}));

vi.mock('../../board-scroll/board-scroll-section', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../board-scroll/board-scroll-card', () => ({
  default: () => null,
}));

vi.mock('@/app/components/beta-videos/add-beta-video-dialog', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="add-beta-video-dialog" /> : null),
}));

// Import after mocks

// --- Test data ---

const mockClimb = createMockClimb();
const mockBoardDetails = createMockBoardDetails();

const defaultProps: ClimbActionProps = {
  climb: mockClimb,
  boardDetails: mockBoardDetails,
  angle: 40,
  viewMode: 'list',
  onComplete: vi.fn(),
};

// --- Helpers ---

/**
 * Render an action function inside a component (required because actions use hooks)
 * and capture the raw ClimbActionResult.
 */
function captureActionResult(
  actionFn: (props: ClimbActionProps) => ClimbActionResult,
  props: ClimbActionProps,
): ClimbActionResult {
  let result: ClimbActionResult | undefined;

  function Capture() {
    result = actionFn(props);
    return null;
  }

  render(<Capture />);
  return result!;
}

/**
 * Render an action function and return its element for DOM assertions.
 */
function renderAction(actionFn: (props: ClimbActionProps) => ClimbActionResult, props: ClimbActionProps) {
  function TestAction() {
    const result = actionFn(props);
    return result.element;
  }

  return render(<TestAction />);
}

// --- Setup ---

beforeEach(() => {
  vi.clearAllMocks();

  // Defaults: unauthenticated session, no board provider
  mockUseSession.mockReturnValue({
    status: 'unauthenticated',
    data: null,
    update: vi.fn(),
  });
  mockUseOptionalBoardProvider.mockReturnValue(null);
  mockUseFavorite.mockReturnValue({
    isFavorited: false,
    isLoading: false,
    toggleFavorite: vi.fn(),
    isAuthenticated: false,
  });
  mockUseOptionalQueueActions.mockReturnValue({
    addToQueue: vi.fn(),
    mirrorClimb: vi.fn(),
  });
  mockUseOptionalCurrentClimb.mockReturnValue({
    currentClimb: null,
  });
});

// =============================================================================
// Label Tests
// =============================================================================

describe('Action label text', () => {
  describe('ForkAction', () => {
    it('returns label "Remix this climb" for a non-draft climb', () => {
      mockUseSession.mockReturnValue({
        status: 'authenticated',
        data: { user: { id: 'user-1' }, expires: '' },
        update: vi.fn(),
      });

      const result = captureActionResult(ForkAction, {
        ...defaultProps,
        viewMode: 'dropdown',
      });

      // The menuItem label is a Link element wrapping the text for fork action
      // when a URL is available, so we render the element to check the text
      const { container } = render(result.menuItem.label);
      expect(container.textContent).toBe('Remix this climb');
    });

    it('returns label "Edit" when the climb is a draft owned by the current user', () => {
      const draftClimb = createMockClimb({
        is_draft: true,
        userId: 'user-1',
      });

      mockUseSession.mockReturnValue({
        status: 'authenticated',
        data: { user: { id: 'user-1' }, expires: '' },
        update: vi.fn(),
      });

      const result = captureActionResult(ForkAction, {
        ...defaultProps,
        climb: draftClimb,
        viewMode: 'dropdown',
      });

      const { container } = render(result.menuItem.label);
      expect(container.textContent).toBe('Edit');
    });

    it('renders "Remix this climb" text in list mode element', () => {
      mockUseSession.mockReturnValue({
        status: 'authenticated',
        data: { user: { id: 'user-1' }, expires: '' },
        update: vi.fn(),
      });

      renderAction(ForkAction, {
        ...defaultProps,
        viewMode: 'list',
      });

      expect(screen.getByText('Remix this climb')).toBeTruthy();
    });
  });

  describe('TickAction', () => {
    it('returns label "Log ascent" in the menuItem', () => {
      mockUseOptionalBoardProvider.mockReturnValue({
        isAuthenticated: true,
        logbook: [],
        boardName: 'kilter',
        isLoading: false,
        error: null,
        isInitialized: true,
        getLogbook: vi.fn(),
        saveTick: vi.fn(),
        saveClimb: vi.fn(),
      });
      mockUseSession.mockReturnValue({
        status: 'authenticated',
        data: { user: { id: 'user-1' }, expires: '' },
        update: vi.fn(),
      });

      const result = captureActionResult(TickAction, defaultProps);

      expect(result.menuItem.label).toBe('Log ascent');
    });

    it('renders "Log ascent" text in list mode element', () => {
      mockUseOptionalBoardProvider.mockReturnValue({
        isAuthenticated: true,
        logbook: [],
        boardName: 'kilter',
        isLoading: false,
        error: null,
        isInitialized: true,
        getLogbook: vi.fn(),
        saveTick: vi.fn(),
        saveClimb: vi.fn(),
      });
      mockUseSession.mockReturnValue({
        status: 'authenticated',
        data: { user: { id: 'user-1' }, expires: '' },
        update: vi.fn(),
      });

      renderAction(TickAction, {
        ...defaultProps,
        viewMode: 'list',
      });

      expect(screen.getByText('Log ascent')).toBeTruthy();
    });

    it('includes badge count in menuItem label when logbook has entries', () => {
      mockUseOptionalBoardProvider.mockReturnValue({
        isAuthenticated: true,
        logbook: [{ climb_uuid: 'climb-1', angle: 40, is_ascent: true }],
        boardName: 'kilter',
        isLoading: false,
        error: null,
        isInitialized: true,
        getLogbook: vi.fn(),
        saveTick: vi.fn(),
        saveClimb: vi.fn(),
      });
      mockUseSession.mockReturnValue({
        status: 'authenticated',
        data: { user: { id: 'user-1' }, expires: '' },
        update: vi.fn(),
      });

      const result = captureActionResult(TickAction, defaultProps);

      expect(result.menuItem.label).toBe('Log ascent (1)');
    });
  });

  describe('AddBetaVideoAction', () => {
    it('returns the add beta video label for authenticated users', () => {
      mockUseSession.mockReturnValue({
        status: 'authenticated',
        data: { user: { id: 'user-1' }, expires: '' },
        update: vi.fn(),
      });

      const result = captureActionResult(AddBetaVideoAction, {
        ...defaultProps,
        viewMode: 'dropdown',
      });

      expect(result.available).toBe(true);
      expect(result.menuItem.label).toBe(tFromCatalog('climbs', 'actions.addBetaVideo.label'));
    });

    it('is unavailable when the user is signed out', () => {
      const result = captureActionResult(AddBetaVideoAction, {
        ...defaultProps,
        viewMode: 'dropdown',
      });

      expect(result.available).toBe(false);
    });
  });
});

// =============================================================================
// List Mode Neutral Color Tests
// =============================================================================

describe('List mode uses neutral colors (no per-action colored icons)', () => {
  describe('FavoriteAction', () => {
    it('uses ActionListElement with uncolored icon (not red)', () => {
      // Even when favorited, the list mode icon should be neutral
      mockUseFavorite.mockReturnValue({
        isFavorited: true,
        isLoading: false,
        toggleFavorite: vi.fn(),
        isAuthenticated: true,
      });

      renderAction(FavoriteAction, {
        ...defaultProps,
        viewMode: 'list',
      });

      const button = screen.getByRole('button');
      // The button uses text.primary color (neutral), not red
      expect(button).toBeTruthy();

      // Verify the button has the standard list styling by checking it renders as full-width text variant
      // The button text should be visible (Favorited since isFavorited=true)
      expect(screen.getByText('Favorited')).toBeTruthy();

      // The list element icon should NOT have the red error color applied.
      // In favorite-action.tsx the listIcon is created as:
      //   const listIcon = <HeartIcon sx={{ fontSize: iconSize }} />;
      // (no color property) while the icon-mode icon uses:
      //   { color: themeTokens.colors.error, fontSize: iconSize }
      // We verify the rendered SVG icon does not have an inline red color style.
      const svg = button.querySelector('svg');
      expect(svg).toBeTruthy();
      const svgStyle = svg!.getAttribute('style') || '';
      expect(svgStyle).not.toContain('color');
    });

    it('renders neutral icon even when not favorited', () => {
      mockUseFavorite.mockReturnValue({
        isFavorited: false,
        isLoading: false,
        toggleFavorite: vi.fn(),
        isAuthenticated: true,
      });

      renderAction(FavoriteAction, {
        ...defaultProps,
        viewMode: 'list',
      });

      const button = screen.getByRole('button');
      expect(screen.getByText('Favorite')).toBeTruthy();

      const svg = button.querySelector('svg');
      expect(svg).toBeTruthy();
      const svgStyle = svg!.getAttribute('style') || '';
      expect(svgStyle).not.toContain('color');
    });
  });

  describe('QueueAction', () => {
    it('uses ActionListElement with uncolored icon (not green)', () => {
      renderAction(QueueAction, {
        ...defaultProps,
        viewMode: 'list',
      });

      const button = screen.getByRole('button');
      expect(screen.getByText('Add to Queue')).toBeTruthy();

      // The list icon is created as:
      //   const listIcon = <Icon sx={{ fontSize: iconSize }} />;
      // (no color) while the icon-mode icon uses { color: themeTokens.colors.success }
      // when recentlyAdded is true. Either way, list mode should have no color.
      const svg = button.querySelector('svg');
      expect(svg).toBeTruthy();
      const svgStyle = svg!.getAttribute('style') || '';
      expect(svgStyle).not.toContain('color');
    });
  });

  describe('MirrorAction', () => {
    it('uses ActionListElement with uncolored icon (not purple) when mirrored', () => {
      mockUseOptionalCurrentClimb.mockReturnValue({
        currentClimb: { mirrored: true },
      });

      renderAction(MirrorAction, {
        ...defaultProps,
        viewMode: 'list',
        boardDetails: createMockBoardDetails({ supportsMirroring: true }),
      });

      const button = screen.getByRole('button');
      expect(screen.getByText('Mirrored')).toBeTruthy();

      // The list icon is created as:
      //   const listIcon = <SwapHorizOutlined sx={{ fontSize: iconSize }} />;
      // (no color) while the icon-mode icon uses { color: themeTokens.colors.purple }
      // when isMirrored is true.
      const svg = button.querySelector('svg');
      expect(svg).toBeTruthy();
      const svgStyle = svg!.getAttribute('style') || '';
      expect(svgStyle).not.toContain('color');
    });

    it('uses ActionListElement with uncolored icon when not mirrored', () => {
      mockUseOptionalCurrentClimb.mockReturnValue({
        currentClimb: { mirrored: false },
      });

      renderAction(MirrorAction, {
        ...defaultProps,
        viewMode: 'list',
        boardDetails: createMockBoardDetails({ supportsMirroring: true }),
      });

      const button = screen.getByRole('button');
      expect(screen.getByText('Mirror')).toBeTruthy();

      const svg = button.querySelector('svg');
      expect(svg).toBeTruthy();
      const svgStyle = svg!.getAttribute('style') || '';
      expect(svgStyle).not.toContain('color');
    });
  });

  describe('TickAction', () => {
    it('uses text.primary color in list mode (standard neutral styling)', () => {
      mockUseOptionalBoardProvider.mockReturnValue({
        isAuthenticated: true,
        logbook: [],
        boardName: 'kilter',
        isLoading: false,
        error: null,
        isInitialized: true,
        getLogbook: vi.fn(),
        saveTick: vi.fn(),
        saveClimb: vi.fn(),
      });
      mockUseSession.mockReturnValue({
        status: 'authenticated',
        data: { user: { id: 'user-1' }, expires: '' },
        update: vi.fn(),
      });

      renderAction(TickAction, {
        ...defaultProps,
        viewMode: 'list',
      });

      const button = screen.getByRole('button');
      expect(screen.getByText('Log ascent')).toBeTruthy();

      // TickAction list mode uses inline sx with color: 'text.primary' and
      // '& .MuiButton-startIcon': { color: 'text.secondary' }
      // Verify the icon SVG has no colored inline style
      const svg = button.querySelector('svg');
      expect(svg).toBeTruthy();
      const svgStyle = svg!.getAttribute('style') || '';
      expect(svgStyle).not.toContain('color');
    });
  });
});
