import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import QueueControlBar from '../queue-control-bar';

// -- All mocks before imports --

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string | readonly string[]) => ({
    i18n: { language: 'en-US' },
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
  }),
}));

const mockShowMessage = vi.fn();
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

let mockQueueContext: Record<string, unknown> = {};
vi.mock('@/app/components/graphql-queue', () => ({
  useQueueContext: () => mockQueueContext,
  useQueueData: () => mockQueueContext,
  useQueueActions: () => mockQueueContext,
  useCurrentClimb: () => ({
    currentClimb: mockQueueContext.currentClimb,
  }),
  useQueueList: () => ({
    queue: mockQueueContext.queue,
    suggestedClimbs: [],
  }),
  useSessionData: () => ({
    viewOnlyMode: mockQueueContext.viewOnlyMode ?? false,
    isSessionActive: !!mockQueueContext.sessionId,
    sessionId: mockQueueContext.sessionId ?? null,
    sessionSummary: null,
    sessionSummaryBoardType: null,
    sessionSummaryHealthKitWorkoutId: null,
    sessionGoal: null,
    connectionState: mockQueueContext.connectionState ?? 'idle',
    canMutate: mockQueueContext.canMutate ?? true,
    isDisconnected: mockQueueContext.isDisconnected ?? false,
    users: mockQueueContext.users ?? [],
    clientId: null,
    isLeader: true,
    isBackendMode: false,
    hasConnected: true,
    connectionError: null,
  }),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/kilter/1/1/1/40',
  useParams: () => ({
    board_name: 'kilter',
    layout_id: '1',
    size_id: '1',
    set_ids: '1',
    angle: '40',
  }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) =>
    React.createElement('a', props, children),
}));

vi.mock('@/app/lib/analytics', () => ({ track: vi.fn() }));

vi.mock('@/app/components/board-history/use-board-vs-local-divergence', () => ({
  useBoardVsLocalDivergence: () => ({ boardCurrent: null, localPick: null, divergent: false }),
}));

vi.mock('@/app/components/board-history/currently-on-board-header', () => ({
  default: () => null,
}));

vi.mock('@/app/hooks/use-card-swipe-navigation', () => ({
  useCardSwipeNavigation: () => ({
    swipeHandlers: {},
    swipeOffset: 0,
    isAnimating: false,
    navigateToNext: vi.fn(),
    navigateToPrev: vi.fn(),
    peekIsNext: true,
    exitOffset: 0,
    enterDirection: null,
    clearEnterAnimation: vi.fn(),
  }),
  EXIT_DURATION: 300,
  SNAP_BACK_DURATION: 200,
  ENTER_ANIMATION_DURATION: 300,
}));

vi.mock('@/app/hooks/use-color-mode', () => ({
  useColorMode: () => ({ mode: 'light' }),
}));

vi.mock('@/app/lib/grade-colors', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getGradeTintColor: () => null,
  };
});

vi.mock('@/app/components/climb-card/climb-thumbnail', () => ({
  default: () => React.createElement('div', { 'data-testid': 'climb-thumbnail' }),
}));

vi.mock('@/app/components/climb-card/climb-title', () => ({
  default: () => React.createElement('div', { 'data-testid': 'climb-title' }),
}));

vi.mock('@/app/components/queue-control/queue-list', () => ({
  default: React.forwardRef(() => React.createElement('div', { 'data-testid': 'queue-list' })),
}));

// queue-control-bar now uses the single `queue-nav-button` for both prev and
// next (next-climb-button.tsx / previous-climb-button.tsx were removed during
// the queue pivot). Mock the new module with a no-op so unit tests don't have
// to satisfy its hooks.
vi.mock('@/app/components/queue-control/queue-nav-button', () => ({
  default: ({ direction }: { direction: 'next' | 'previous' }) =>
    React.createElement('button', { 'data-testid': `${direction}-climb` }),
}));

vi.mock('@/app/components/logbook/tick-button', () => ({
  TickButton: () => React.createElement('button', { 'data-testid': 'tick-button' }),
}));

vi.mock('@/app/components/play-view/play-view-drawer', () => ({
  default: () => null,
}));

vi.mock('@/app/components/session-creation/start-sesh-drawer', () => ({
  default: () => null,
}));

vi.mock('@/app/components/onboarding/onboarding-tour-events', () => ({
  TOUR_CLOSE_PLAY_VIEW_EVENT: 'onboarding:close-play-view',
}));

vi.mock('@/app/components/ui/confirm-popover', () => ({
  ConfirmPopover: () => null,
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ status: 'unauthenticated', data: null }),
}));

vi.mock('@/app/components/persistent-session', () => ({
  usePersistentSession: () => ({
    activeSession: null,
    localBoardDetails: null,
    localCurrentClimbQueueItem: null,
  }),
  usePersistentSessionState: () => ({
    activeSession: null,
    session: null,
    users: [],
    localBoardDetails: null,
    localCurrentClimbQueueItem: null,
  }),
  usePersistentSessionActions: () => ({}),
}));

vi.mock('@/app/components/persistent-session/persistent-session-context', () => ({
  usePersistentSession: () => ({
    activeSession: null,
    localBoardDetails: null,
    localCurrentClimbQueueItem: null,
  }),
  usePersistentSessionState: () => ({
    activeSession: null,
    session: null,
    users: [],
    localBoardDetails: null,
    localCurrentClimbQueueItem: null,
  }),
  usePersistentSessionActions: () => ({}),
}));

vi.mock('@/app/components/board-provider/board-provider-context', () => ({
  useBoardProvider: () => ({
    logbook: [],
    saveTick: vi.fn(),
    isAuthenticated: false,
    isLoading: false,
    error: null,
    isInitialized: true,
    getLogbook: vi.fn(),
    saveClimb: vi.fn(),
  }),
}));

vi.mock('@/app/components/board-bluetooth-control/bluetooth-context', () => ({
  useBluetoothContext: () => ({
    isConnected: false,
    isConnecting: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    sendLedUpdate: vi.fn(),
  }),
}));

// Import after mocks

const mockClimb = {
  uuid: 'climb-1',
  setter_username: 'setter1',
  name: 'Test Climb',
  description: '',
  frames: '',
  angle: 40,
  ascensionist_count: 5,
  difficulty: '7',
  quality_average: '3.5',
  stars: 3,
  difficulty_error: '',
  mirrored: false,
  benchmark_difficulty: null,
  userAscents: 0,
  userAttempts: 0,
};

const baseQueueContext = {
  queue: [{ uuid: 'item-1', climb: mockClimb, addedBy: 'user-1', suggested: false }],
  currentClimbQueueItem: { uuid: 'item-1', climb: mockClimb, addedBy: 'user-1', suggested: false },
  currentClimb: mockClimb,
  climbSearchResults: [],
  suggestedClimbs: [],
  isFetchingClimbs: false,
  isFetchingNextPage: false,
  hasDoneFirstFetch: true,
  viewOnlyMode: false,
  parsedParams: { board_name: 'kilter', layout_id: '1', size_id: '1', set_ids: ['1'], angle: '40' },
  connectionState: 'connected',
  sessionId: 'session-1',
  canMutate: true,
  isDisconnected: false,
  users: [
    { id: 'me', username: 'me', isLeader: true },
    { id: 'other', username: 'other', isLeader: false },
  ],
  endSession: vi.fn(),
  disconnect: vi.fn(),
  addToQueue: vi.fn(),
  removeFromQueue: vi.fn(),
  setCurrentClimb: vi.fn(),
  setCurrentClimbQueueItem: vi.fn(),
  setClimbSearchParams: vi.fn(),
  setCountSearchParams: vi.fn(),
  mirrorClimb: vi.fn(),
  fetchMoreClimbs: vi.fn(),
  getNextClimbQueueItem: vi.fn().mockReturnValue(null),
  getPreviousClimbQueueItem: vi.fn().mockReturnValue(null),
  setQueue: vi.fn(),
};

const defaultProps = {
  angle: '40' as unknown as number,
  boardDetails: {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 1,
    set_ids: '1',
    images_to_holds: {},
    layout_name: 'Original',
    size_name: '12x12',
    size_description: 'Standard',
    set_names: ['Base'],
    edge_left: 0,
    edge_right: 0,
    edge_bottom: 0,
    edge_top: 0,
  } as never,
  activeDrawer: 'none' as const,
  setActiveDrawer: vi.fn(),
};

describe('QueueControlBar offline UI', () => {
  beforeEach(() => {
    mockQueueContext = { ...baseQueueContext };
    // Mock matchMedia for JSDOM
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it('renders normal controls when online with active session', () => {
    render(<QueueControlBar {...defaultProps} />);

    expect(screen.queryByText(/Reconnecting/)).toBeNull();
    expect(screen.queryByText(/Offline/i)).toBeNull();
  });

  it('shows reconnecting view when online but WebSocket reconnecting', () => {
    mockQueueContext = {
      ...baseQueueContext,
      connectionState: 'reconnecting',
      isDisconnected: false,
    };

    render(<QueueControlBar {...defaultProps} />);

    expect(screen.getByText(/Reconnecting/)).toBeTruthy();
  });

  it('shows offline indicator with multi-user message when offline in party mode', () => {
    mockQueueContext = {
      ...baseQueueContext,
      connectionState: 'reconnecting',
      isDisconnected: true,
      users: [
        { id: 'me', username: 'me', isLeader: true },
        { id: 'other', username: 'other', isLeader: false },
      ],
    };

    render(<QueueControlBar {...defaultProps} />);

    // Should NOT show the reconnecting spinner view
    expect(screen.queryByText(/Reconnecting/)).toBeNull();
    // Should show offline indicator with multi-user sync message
    expect(screen.getByText(/Offline/i)).toBeTruthy();
    expect(screen.getByText(/Queued climbs will still sync/i)).toBeTruthy();
  });

  it('shows offline indicator with solo message when solo in party mode', () => {
    mockQueueContext = {
      ...baseQueueContext,
      connectionState: 'reconnecting',
      isDisconnected: true,
      users: [{ id: 'me', username: 'me', isLeader: true }],
    };

    render(<QueueControlBar {...defaultProps} />);

    expect(screen.getByText(/Offline/i)).toBeTruthy();
    expect(screen.getByText(/Changes will sync when you reconnect/i)).toBeTruthy();
    expect(screen.queryByText(/Queued climbs/i)).toBeNull();
  });

  it('shows normal controls when offline in solo mode (no session)', () => {
    mockQueueContext = {
      ...baseQueueContext,
      connectionState: 'idle',
      sessionId: null,
      isDisconnected: false,
    };

    render(<QueueControlBar {...defaultProps} />);

    expect(screen.queryByText(/Reconnecting/)).toBeNull();
  });

  it('dismisses offline banner when clicked', () => {
    mockQueueContext = {
      ...baseQueueContext,
      connectionState: 'reconnecting',
      isDisconnected: true,
      users: [{ id: 'me', username: 'me', isLeader: true }],
    };

    render(<QueueControlBar {...defaultProps} />);

    const banner = screen.getByText(/Offline/i).closest('[role="button"]')!;
    expect(banner).toBeTruthy();

    fireEvent.click(banner);

    expect(screen.queryByText(/Offline/i)).toBeNull();
  });

  it('reappears after reconnect then disconnect again', () => {
    mockQueueContext = {
      ...baseQueueContext,
      connectionState: 'reconnecting',
      isDisconnected: true,
      users: [{ id: 'me', username: 'me', isLeader: true }],
    };

    const { rerender } = render(<QueueControlBar {...defaultProps} />);

    // Dismiss the banner
    const banner = screen.getByText(/Offline/i).closest('[role="button"]')!;
    fireEvent.click(banner);
    expect(screen.queryByText(/Offline/i)).toBeNull();

    // Simulate reconnection — pass a new boardDetails object so React.memo re-renders
    // and the useEffect that resets dismissedDisconnect can fire.
    // (defaultProps.boardDetails is cast `as never` for the prop type; we need a
    // plain object reference to spread, so we re-cast to unknown first.)
    const bd = defaultProps.boardDetails as unknown as Record<string, unknown>;
    mockQueueContext = { ...baseQueueContext, isDisconnected: false, connectionState: 'connected' };
    act(() => {
      rerender(<QueueControlBar {...defaultProps} boardDetails={{ ...bd } as never} />);
    });

    // Simulate disconnection again
    mockQueueContext = {
      ...baseQueueContext,
      isDisconnected: true,
      connectionState: 'reconnecting',
    };
    act(() => {
      rerender(<QueueControlBar {...defaultProps} boardDetails={{ ...bd } as never} />);
    });

    expect(screen.getByText(/Offline/i)).toBeTruthy();
  });
});
