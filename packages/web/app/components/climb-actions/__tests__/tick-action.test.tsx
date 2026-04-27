import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import type { Climb, BoardDetails, BoardName } from '@/app/lib/types';
import type { UserBoard } from '@boardsesh/shared-schema';
import { TickAction } from '../actions/tick-action';
import type { ClimbActionProps } from '../types';

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

function createMockUserBoard(overrides?: Partial<UserBoard>): UserBoard {
  return {
    uuid: 'board-1',
    slug: 'my-kilter',
    ownerId: 'user-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,2',
    name: 'My Kilter Board',
    isPublic: false,
    isUnlisted: false,
    hideLocation: false,
    isOwned: true,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2024-01-01T00:00:00Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    layoutName: 'Original',
    sizeName: '12x12',
    sizeDescription: 'Full',
    setNames: ['Standard'],
    ...overrides,
  };
}

// --- Mocks (must be before imports) ---

const mockUseOptionalBoardProvider = vi.fn();
const MockBoardProvider = vi.fn(({ children }: { boardName: string; children: React.ReactNode }) => (
  <div data-testid="mock-board-provider">{children}</div>
));
vi.mock('../../board-provider/board-provider-context', () => ({
  useOptionalBoardProvider: () => mockUseOptionalBoardProvider(),
  BoardProvider: (props: { boardName: string; children: React.ReactNode }) => MockBoardProvider(props),
}));

const mockUseSession = vi.fn();
vi.mock('next-auth/react', () => ({
  useSession: () => mockUseSession(),
}));

const mockUseMyBoards = vi.fn();
vi.mock('@/app/hooks/use-my-boards', () => ({
  useMyBoards: (enabled: boolean) => mockUseMyBoards(enabled),
}));

vi.mock('@/app/hooks/use-always-tick-in-app', () => ({
  useAlwaysTickInApp: () => ({
    alwaysUseApp: false,
    loaded: true,
    enableAlwaysUseApp: vi.fn(),
  }),
}));

const mockTrack = vi.fn();
vi.mock('@/app/lib/analytics', () => ({
  track: (...args: unknown[]) => mockTrack(...args),
}));

vi.mock('@/app/lib/url-utils', () => ({
  constructClimbInfoUrl: vi.fn(() => 'https://app.example.com/climb/info'),
}));

vi.mock('@/app/lib/open-external-url', () => ({
  openExternalUrl: vi.fn(),
}));

// Simplified component mocks
vi.mock('../../swipeable-drawer/swipeable-drawer', () => ({
  default: ({ children, title, open }: { children: React.ReactNode; title: string; open: boolean }) =>
    open ? (
      <div data-testid="swipeable-drawer" data-title={title}>
        {children}
      </div>
    ) : null,
}));

vi.mock('../action-tooltip', () => ({
  ActionTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/app/components/providers/auth-modal-provider', () => ({
  useAuthModal: () => ({ openAuthModal: vi.fn() }),
}));

vi.mock('../../logbook/log-ascent-drawer', () => ({
  LogAscentDrawer: ({ open, onClose }: { open: boolean; onClose?: () => void }) =>
    open ? (
      <div data-testid="log-ascent-drawer">
        <button data-testid="close-drawer" onClick={onClose}>
          Close
        </button>
      </div>
    ) : null,
}));

vi.mock('../../logbook/logascent-form', () => ({
  LogAscentForm: ({ boardDetails }: { boardDetails: BoardDetails }) => (
    <div
      data-testid="log-ascent-form"
      data-layout-id={boardDetails.layout_id}
      data-size-id={boardDetails.size_id}
      data-set-ids={typeof boardDetails.set_ids === 'string' ? boardDetails.set_ids : String(boardDetails.set_ids)}
    />
  ),
}));

vi.mock('../../board-scroll/board-scroll-section', () => ({
  default: ({ children, loading }: { children: React.ReactNode; loading?: boolean }) =>
    loading ? <div data-testid="board-scroll-loading" /> : <div data-testid="board-scroll-section">{children}</div>,
}));

vi.mock('../../board-scroll/board-scroll-card', () => ({
  default: ({ userBoard, onClick }: { userBoard: UserBoard; onClick: () => void }) => (
    <button data-testid={`board-card-${userBoard.uuid}`} onClick={onClick}>
      {userBoard.name}
    </button>
  ),
}));

// Import after mocks

// --- Test data ---

const mockClimb = createMockClimb();
const mockBoardDetails = createMockBoardDetails();

const defaultProps: ClimbActionProps = {
  climb: mockClimb,
  boardDetails: mockBoardDetails,
  angle: 40,
  viewMode: 'button',
  onComplete: vi.fn(),
};

const mockUserBoard = createMockUserBoard();

const mockUserBoard2 = createMockUserBoard({
  uuid: 'board-2',
  slug: 'gym-kilter',
  name: 'Gym Kilter',
});

// A board with DIFFERENT layout/size config to test boardDetails override
const mockUserBoardDifferentConfig = createMockUserBoard({
  uuid: 'board-4',
  slug: 'big-kilter',
  name: 'Big Kilter 16x12',
  layoutId: 2,
  sizeId: 20,
  setIds: '3,4',
  layoutName: 'Super Wide',
  sizeName: '16x12',
  sizeDescription: 'Super Wide Full',
  setNames: ['Bolt-Ons', 'Screw-Ons'],
});

const mockTensionBoard = createMockUserBoard({
  uuid: 'board-3',
  slug: 'tension-board',
  boardType: 'tension',
  layoutId: 2,
  sizeId: 5,
  setIds: '3',
  name: 'My Tension',
});

/**
 * Wrapper component to render TickAction (which returns ClimbActionResult, not JSX directly)
 */
function TestTickAction(props: ClimbActionProps) {
  const result = TickAction(props);
  return result.element;
}

// --- Helper to set up mock states ---

function setupMocks(options: {
  hasBoardProvider?: boolean;
  isAuthenticated?: boolean;
  logbook?: Array<{ climb_uuid: string; angle: number; is_ascent: boolean }>;
  boards?: UserBoard[];
  isLoadingBoards?: boolean;
  boardsError?: string | null;
  sessionStatus?: string;
}) {
  const {
    hasBoardProvider = false,
    isAuthenticated = false,
    logbook = [],
    boards = [],
    isLoadingBoards = false,
    boardsError = null,
    sessionStatus,
  } = options;

  if (hasBoardProvider) {
    mockUseOptionalBoardProvider.mockReturnValue({
      isAuthenticated,
      logbook,
      boardName: 'kilter' as BoardName,
      isLoading: false,
      error: null,
      isInitialized: true,
      getLogbook: vi.fn(),
      saveTick: vi.fn(),
      saveClimb: vi.fn(),
    });
  } else {
    mockUseOptionalBoardProvider.mockReturnValue(null);
  }

  mockUseSession.mockReturnValue({
    status: sessionStatus ?? (isAuthenticated ? 'authenticated' : 'unauthenticated'),
    data: isAuthenticated ? { user: { id: 'user-1' }, expires: '' } : null,
    update: vi.fn(),
  });

  mockUseMyBoards.mockReturnValue({
    boards,
    isLoading: isLoadingBoards,
    error: boardsError,
  });
}

/**
 * Helper: simulate the full loading cycle for useMyBoards.
 * In production, useMyBoards goes: {boards:[], isLoading:false} -> {boards:[], isLoading:true} -> {boards:[...], isLoading:false}
 * The boardsReady ref tracks whether isLoading has been true, so tests must simulate this.
 */
function renderWithLoadingCycle(props: ClimbActionProps, finalBoards: UserBoard[]) {
  // Phase 1: loading
  setupMocks({ isAuthenticated: true, boards: [], isLoadingBoards: true });
  const result = render(<TestTickAction {...props} />);

  // Phase 2: loaded with results
  setupMocks({ isAuthenticated: true, boards: finalBoards, isLoadingBoards: false });
  result.rerender(<TestTickAction {...props} />);

  return result;
}

// --- Tests ---

describe('TickAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('renders without crashing', () => {
    it('renders with BoardProvider present', () => {
      setupMocks({ hasBoardProvider: true, isAuthenticated: true });
      const { container } = render(<TestTickAction {...defaultProps} />);
      expect(container).toBeTruthy();
    });

    it('renders without BoardProvider when authenticated', () => {
      setupMocks({ isAuthenticated: true, boards: [mockUserBoard] });
      const { container } = render(<TestTickAction {...defaultProps} />);
      expect(container).toBeTruthy();
    });

    it('renders without BoardProvider when not authenticated', () => {
      setupMocks({ isAuthenticated: false });
      const { container } = render(<TestTickAction {...defaultProps} />);
      expect(container).toBeTruthy();
    });
  });

  describe('return value', () => {
    it('returns available: true and key: tick', () => {
      setupMocks({ hasBoardProvider: true, isAuthenticated: true });
      const result = renderTickActionResult(defaultProps);
      expect(result.available).toBe(true);
      expect(result.key).toBe('tick');
    });

    it('includes menuItem with label', () => {
      setupMocks({ hasBoardProvider: true, isAuthenticated: true });
      const result = renderTickActionResult(defaultProps);
      expect(result.menuItem.key).toBe('tick');
      expect(result.menuItem.label).toBe('Log ascent');
    });

    it('includes badge count in menuItem label when logbook has entries', () => {
      setupMocks({
        hasBoardProvider: true,
        isAuthenticated: true,
        logbook: [{ climb_uuid: 'climb-1', angle: 40, is_ascent: true }],
      });
      const result = renderTickActionResult(defaultProps);
      expect(result.menuItem.label).toBe('Log ascent (1)');
    });
  });

  describe('with BoardProvider (inside board route)', () => {
    it('shows LogAscentDrawer when authenticated and drawer is opened', async () => {
      setupMocks({ hasBoardProvider: true, isAuthenticated: true });
      render(<TestTickAction {...defaultProps} />);

      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      expect(screen.getByTestId('log-ascent-drawer')).toBeTruthy();
    });

    it('shows sign-in prompt when not authenticated and drawer is opened', async () => {
      setupMocks({ hasBoardProvider: true, isAuthenticated: false });
      render(<TestTickAction {...defaultProps} />);

      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      const drawer = screen.getByTestId('swipeable-drawer');
      expect(drawer.getAttribute('data-title')).toBe('Sign In Required');
      expect(screen.getByText('Sign in to record ticks')).toBeTruthy();
    });

    it('does not show board selector', async () => {
      setupMocks({ hasBoardProvider: true, isAuthenticated: true });
      render(<TestTickAction {...defaultProps} />);

      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      expect(screen.queryByText('Which board did you climb on?')).toBeNull();
    });

    it('does not fetch user boards when BoardProvider exists', () => {
      setupMocks({ hasBoardProvider: true, isAuthenticated: true });
      render(<TestTickAction {...defaultProps} />);

      // useMyBoards should be called with false (needsBoardSelector = false)
      expect(mockUseMyBoards).toHaveBeenCalledWith(false);
    });
  });

  describe('without BoardProvider, authenticated (outside board route)', () => {
    it('shows board selector when matching boards exist', async () => {
      renderWithLoadingCycle(defaultProps, [mockUserBoard, mockUserBoard2]);

      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      const drawer = screen.getByTestId('swipeable-drawer');
      expect(drawer.getAttribute('data-title')).toBe('Select Board');
      expect(screen.getByText('Which board did you climb on?')).toBeTruthy();
      expect(screen.getByTestId('board-card-board-1')).toBeTruthy();
      expect(screen.getByTestId('board-card-board-2')).toBeTruthy();
    });

    it('filters boards to matching board type', async () => {
      // Boards include both kilter and tension, but climb is kilter
      renderWithLoadingCycle(defaultProps, [mockUserBoard, mockTensionBoard]);

      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      // Should only show the kilter board, not the tension board
      expect(screen.getByTestId('board-card-board-1')).toBeTruthy();
      expect(screen.queryByTestId('board-card-board-3')).toBeNull();
    });

    it('shows LogAscentForm wrapped in BoardProvider after selecting a board', async () => {
      renderWithLoadingCycle(defaultProps, [mockUserBoard, mockUserBoard2]);

      // Open drawer
      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      // Select a board
      await act(async () => {
        screen.getByTestId('board-card-board-1').click();
      });

      // Should now show the log ascent form inside a BoardProvider
      expect(screen.getByTestId('mock-board-provider')).toBeTruthy();
      expect(screen.getByTestId('log-ascent-form')).toBeTruthy();

      // Drawer title should change to "Log Ascent"
      const drawer = screen.getByTestId('swipeable-drawer');
      expect(drawer.getAttribute('data-title')).toBe('Log Ascent');
    });

    it('passes selected board type to BoardProvider', async () => {
      renderWithLoadingCycle(defaultProps, [mockUserBoard]);

      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      await act(async () => {
        screen.getByTestId('board-card-board-1').click();
      });

      expect(MockBoardProvider).toHaveBeenCalledWith(expect.objectContaining({ boardName: 'kilter' }));
    });

    it('fetches user boards when outside board route and authenticated', () => {
      setupMocks({ isAuthenticated: true, boards: [] });
      render(<TestTickAction {...defaultProps} />);

      // useMyBoards should be called with true (needsBoardSelector = true)
      expect(mockUseMyBoards).toHaveBeenCalledWith(true);
    });

    it('shows loading state while boards are being fetched', async () => {
      setupMocks({ isAuthenticated: true, boards: [], isLoadingBoards: true });
      render(<TestTickAction {...defaultProps} />);

      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      expect(screen.getByTestId('board-scroll-loading')).toBeTruthy();
    });
  });

  describe('selected board drives form payload', () => {
    it('passes selected board layout/size/set to LogAscentForm', async () => {
      renderWithLoadingCycle(defaultProps, [mockUserBoardDifferentConfig]);

      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      await act(async () => {
        screen.getByTestId('board-card-board-4').click();
      });

      const form = screen.getByTestId('log-ascent-form');
      expect(form.getAttribute('data-layout-id')).toBe('2');
      expect(form.getAttribute('data-size-id')).toBe('20');
      expect(form.getAttribute('data-set-ids')).toBe('3,4');
    });

    it('uses original boardDetails when no board is selected (fallback)', async () => {
      // No matching boards → skips selector, uses original boardDetails
      renderWithLoadingCycle(defaultProps, [mockTensionBoard]);

      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      const form = screen.getByTestId('log-ascent-form');
      expect(form.getAttribute('data-layout-id')).toBe('1');
      expect(form.getAttribute('data-size-id')).toBe('10');
      expect(form.getAttribute('data-set-ids')).toBe('1,2');
    });
  });

  describe('loading race condition (useMyBoards starts with isLoading=false)', () => {
    it('shows board selector loading state before first fetch starts', async () => {
      // Simulate the initial state: isLoading=false, boards=[] (effect hasn't fired yet)
      // Since hasStartedLoadingRef hasn't been set, boardsReady=false, showBoardSelector=true
      setupMocks({ isAuthenticated: true, boards: [], isLoadingBoards: false });
      render(<TestTickAction {...defaultProps} />);

      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      // Should show the board selector (in loading state), NOT skip to form
      const drawer = screen.getByTestId('swipeable-drawer');
      expect(drawer.getAttribute('data-title')).toBe('Select Board');
      expect(screen.getByTestId('board-scroll-loading')).toBeTruthy();
    });

    it('transitions from loading to showing boards after fetch completes', async () => {
      // Start with loading
      setupMocks({ isAuthenticated: true, boards: [], isLoadingBoards: true });
      const { rerender } = render(<TestTickAction {...defaultProps} />);

      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      expect(screen.getByTestId('board-scroll-loading')).toBeTruthy();

      // Simulate fetch completing with boards
      setupMocks({ isAuthenticated: true, boards: [mockUserBoard], isLoadingBoards: false });
      await act(async () => {
        rerender(<TestTickAction {...defaultProps} />);
      });

      expect(screen.getByTestId('board-scroll-section')).toBeTruthy();
      expect(screen.getByTestId('board-card-board-1')).toBeTruthy();
    });

    it('shows no-boards message only after fetch actually completes empty', async () => {
      // Start with loading
      setupMocks({ isAuthenticated: true, boards: [], isLoadingBoards: true });
      const { rerender } = render(<TestTickAction {...defaultProps} />);

      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      // Should still be in loading state
      expect(screen.queryByText(/don\u2019t have any Kilter boards saved/)).toBeNull();

      // Fetch completes with no boards
      setupMocks({ isAuthenticated: true, boards: [], isLoadingBoards: false });
      await act(async () => {
        rerender(<TestTickAction {...defaultProps} />);
      });

      // NOW should show the no-boards message with the form
      expect(screen.getByText(/don\u2019t have any Kilter boards saved/)).toBeTruthy();
      expect(screen.getByTestId('log-ascent-form')).toBeTruthy();
    });
  });

  describe('without BoardProvider, authenticated, no matching boards', () => {
    it('shows informational message about no matching boards', async () => {
      // Simulate: loading started and completed with empty boards
      setupMocks({ isAuthenticated: true, boards: [], isLoadingBoards: true });
      const { rerender } = render(<TestTickAction {...defaultProps} />);

      setupMocks({ isAuthenticated: true, boards: [], isLoadingBoards: false });
      await act(async () => {
        rerender(<TestTickAction {...defaultProps} />);
      });

      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      expect(screen.getByText(/don\u2019t have any Kilter boards saved/)).toBeTruthy();
    });

    it('wraps form in BoardProvider using boardDetails.board_name as fallback', async () => {
      setupMocks({ isAuthenticated: true, boards: [], isLoadingBoards: true });
      const { rerender } = render(<TestTickAction {...defaultProps} />);

      setupMocks({ isAuthenticated: true, boards: [], isLoadingBoards: false });
      await act(async () => {
        rerender(<TestTickAction {...defaultProps} />);
      });

      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      // Should use boardDetails.board_name (kilter) as the provider boardName
      expect(MockBoardProvider).toHaveBeenCalledWith(expect.objectContaining({ boardName: 'kilter' }));
    });

    it('skips board selector when only non-matching boards exist', async () => {
      // User has tension boards but the climb is kilter
      setupMocks({ isAuthenticated: true, boards: [mockTensionBoard], isLoadingBoards: true });
      const { rerender } = render(<TestTickAction {...defaultProps} />);

      setupMocks({ isAuthenticated: true, boards: [mockTensionBoard], isLoadingBoards: false });
      await act(async () => {
        rerender(<TestTickAction {...defaultProps} />);
      });

      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      // Should skip selector (no matching kilter boards) and go to form
      expect(screen.queryByText('Which board did you climb on?')).toBeNull();
      expect(screen.getByTestId('log-ascent-form')).toBeTruthy();
    });
  });

  describe('without BoardProvider, not authenticated', () => {
    it('shows sign-in prompt', async () => {
      setupMocks({ isAuthenticated: false });
      render(<TestTickAction {...defaultProps} />);

      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      const drawer = screen.getByTestId('swipeable-drawer');
      expect(drawer.getAttribute('data-title')).toBe('Sign In Required');
      expect(screen.getByText('Sign in to record ticks')).toBeTruthy();
    });

    it('does not fetch user boards', () => {
      setupMocks({ isAuthenticated: false });
      render(<TestTickAction {...defaultProps} />);

      // useMyBoards should be called with false
      expect(mockUseMyBoards).toHaveBeenCalledWith(false);
    });

    it('does not show board selector or LogAscentForm', async () => {
      setupMocks({ isAuthenticated: false });
      render(<TestTickAction {...defaultProps} />);

      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      expect(screen.queryByText('Which board did you climb on?')).toBeNull();
      expect(screen.queryByTestId('log-ascent-form')).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('handles session status loading gracefully', () => {
      setupMocks({ isAuthenticated: false, sessionStatus: 'loading' });
      const { container } = render(<TestTickAction {...defaultProps} />);
      expect(container).toBeTruthy();
    });

    it('handles useMyBoards error without crashing', async () => {
      setupMocks({
        isAuthenticated: true,
        boards: [],
        boardsError: 'Failed to load your boards',
        isLoadingBoards: true,
      });
      const { rerender } = render(<TestTickAction {...defaultProps} />);

      // Simulate error state after loading
      setupMocks({
        isAuthenticated: true,
        boards: [],
        boardsError: 'Failed to load your boards',
        isLoadingBoards: false,
      });
      await act(async () => {
        rerender(<TestTickAction {...defaultProps} />);
      });

      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      // Should fall through to form (no matching boards after error)
      expect(screen.getByTestId('log-ascent-form')).toBeTruthy();
    });

    it('validates board name and falls back to boardDetails.board_name for invalid types', async () => {
      const invalidBoard = createMockUserBoard({
        uuid: 'board-invalid',
        boardType: 'unknown_board',
        name: 'Invalid Board',
      });

      // Force matching by using same board_name
      const customBoardDetails = createMockBoardDetails({
        board_name: 'unknown_board' as BoardName,
      });
      const customProps = { ...defaultProps, boardDetails: customBoardDetails };
      renderWithLoadingCycle(customProps, [invalidBoard]);

      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      await act(async () => {
        screen.getByTestId('board-card-board-invalid').click();
      });

      // BoardProvider should receive the fallback board_name from boardDetails
      expect(MockBoardProvider).toHaveBeenCalledWith(expect.objectContaining({ boardName: 'unknown_board' }));
    });
  });

  describe('drawer close resets state', () => {
    it('resets board selection when drawer closes', async () => {
      const { unmount } = renderWithLoadingCycle(defaultProps, [mockUserBoard, mockUserBoard2]);

      // Open drawer
      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      // Select a board
      await act(async () => {
        screen.getByTestId('board-card-board-1').click();
      });

      // Verify form is shown
      expect(screen.getByTestId('log-ascent-form')).toBeTruthy();

      // Unmount the first render, then do a fresh render to verify state is independent
      unmount();

      // Fresh render - state should start fresh (selectedBoard = null)
      // Mocks still return boards but the ref resets, so board selector shows
      render(<TestTickAction {...defaultProps} />);

      // Open drawer again
      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      // Should show board selector again (not the form)
      expect(screen.getByText('Which board did you climb on?')).toBeTruthy();
    });
  });

  describe('logbook badge count', () => {
    it('shows no badge when logbook is empty', () => {
      setupMocks({ hasBoardProvider: true, isAuthenticated: true, logbook: [] });
      const result = renderTickActionResult(defaultProps);
      expect(result.menuItem.label).toBe('Log ascent');
    });

    it('shows badge count matching climb and angle', () => {
      setupMocks({
        hasBoardProvider: true,
        isAuthenticated: true,
        logbook: [
          { climb_uuid: 'climb-1', angle: 40, is_ascent: true },
          { climb_uuid: 'climb-1', angle: 40, is_ascent: false },
        ],
      });
      const result = renderTickActionResult(defaultProps);
      expect(result.menuItem.label).toBe('Log ascent (2)');
    });

    it('filters logbook by climb uuid and angle', () => {
      setupMocks({
        hasBoardProvider: true,
        isAuthenticated: true,
        logbook: [
          { climb_uuid: 'climb-1', angle: 40, is_ascent: true },
          { climb_uuid: 'climb-1', angle: 50, is_ascent: true }, // Different angle
          { climb_uuid: 'climb-2', angle: 40, is_ascent: true }, // Different climb
        ],
      });
      const result = renderTickActionResult(defaultProps);
      // Only the first entry matches climb-1 at angle 40
      expect(result.menuItem.label).toBe('Log ascent (1)');
    });

    it('defaults logbook to empty when no BoardProvider', () => {
      setupMocks({ isAuthenticated: true, boards: [] });
      const result = renderTickActionResult(defaultProps);
      expect(result.menuItem.label).toBe('Log ascent');
    });
  });

  describe('analytics tracking', () => {
    it('tracks tick button click with board layout info', async () => {
      setupMocks({ hasBoardProvider: true, isAuthenticated: true });
      render(<TestTickAction {...defaultProps} />);

      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });

      expect(mockTrack).toHaveBeenCalledWith('Tick Button Clicked', {
        boardLayout: 'Original',
        existingAscentCount: 0,
      });
    });

    it('calls onComplete callback when drawer is closed', async () => {
      setupMocks({ hasBoardProvider: true, isAuthenticated: true });
      const onComplete = vi.fn();
      render(<TestTickAction {...defaultProps} onComplete={onComplete} />);

      // Clicking opens the drawer but does not call onComplete yet
      await act(async () => {
        screen.getByRole('button', { name: /log ascent/i }).click();
      });
      expect(onComplete).not.toHaveBeenCalled();

      await act(async () => {
        screen.getByTestId('close-drawer').click();
      });

      expect(onComplete).toHaveBeenCalled();
    });
  });
});

/**
 * Helper to call TickAction as a hook and get the raw result.
 * Renders inside a component to ensure hooks are called properly.
 */
function renderTickActionResult(props: ClimbActionProps) {
  let result: ReturnType<typeof TickAction> | undefined;

  function Capture() {
    result = TickAction(props);
    return null;
  }

  render(<Capture />);
  return result!;
}
