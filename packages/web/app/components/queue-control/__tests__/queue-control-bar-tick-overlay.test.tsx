import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
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

const mockGetPreference = vi.fn().mockResolvedValue(null);
const mockSetPreference = vi.fn().mockResolvedValue(undefined);
vi.mock('@/app/lib/user-preferences-db', () => ({
  getPreference: (...args: unknown[]) => mockGetPreference(...args),
  setPreference: (...args: unknown[]) => mockSetPreference(...args),
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

vi.mock('@/app/components/queue-control/next-climb-button', () => ({
  default: () => React.createElement('button', { 'data-testid': 'next-climb' }),
}));

vi.mock('@/app/components/queue-control/previous-climb-button', () => ({
  default: () => React.createElement('button', { 'data-testid': 'prev-climb' }),
}));

vi.mock('@/app/components/logbook/tick-button', () => ({
  TickButton: (props: { onActivateTickBar?: () => void; tickBarActive?: boolean }) =>
    React.createElement('button', {
      'data-testid': 'tick-button',
      onClick: props.onActivateTickBar,
      'data-tick-active': props.tickBarActive,
    }),
}));

vi.mock('@/app/components/board-page/share-button', () => ({
  ShareBoardButton: () => null,
}));

vi.mock('@/app/components/play-view/play-view-drawer', () => ({
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

vi.mock('@/app/components/persistent-session/persistent-session-context', () => ({
  usePersistentSessionState: () => ({
    activeSession: null,
    localBoardDetails: null,
    localCurrentClimbQueueItem: null,
    session: null,
    users: [],
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

vi.mock('@/app/components/board-provider/board-provider-context', () => ({
  useBoardProvider: () => ({ logbook: [] }),
}));

vi.mock('@/app/components/logbook/quick-tick-bar', () => ({
  QuickTickBar: React.forwardRef((_props: unknown, _ref: unknown) =>
    React.createElement('div', { 'data-testid': 'quick-tick-bar' }),
  ),
}));

vi.mock('@/app/hooks/use-tick-save', () => ({
  hasPriorHistoryForClimb: () => false,
}));

vi.mock('@/app/components/session-creation/start-sesh-drawer', () => ({
  default: () => null,
}));

vi.mock('@/app/components/sesh-settings/sesh-settings-drawer-event', () => ({
  dispatchOpenSeshSettingsDrawer: vi.fn(),
}));

vi.mock('@/app/lib/session-utils', () => ({
  generateSessionName: () => 'Test Session',
}));

vi.mock('qrcode.react', () => ({
  QRCodeSVG: () => null,
}));

vi.mock('@/app/lib/share-utils', () => ({
  shareWithFallback: vi.fn(),
}));

// jsdom doesn't provide window.matchMedia — stub it before the component
// accesses it (the swipe-hint effect calls matchMedia on mount).
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
  users: [],
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
};

const getOverlay = () => document.querySelector('[data-testid="tick-backdrop-overlay"]');

// Helper: activate the tick bar and wait for async effects to settle
const activateTickBar = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('tick-button'));
  });
};

describe('QueueControlBar tick overlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueContext = { ...baseQueueContext };
    mockGetPreference.mockResolvedValue(null);
    mockSetPreference.mockResolvedValue(undefined);
  });

  it('does not render overlay when tick bar is inactive', async () => {
    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });
    expect(getOverlay()).toBeNull();
  });

  it('renders overlay when tick bar is activated', async () => {
    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    await activateTickBar();

    expect(getOverlay()).toBeTruthy();
  });

  it('dismisses tick bar when overlay is clicked', async () => {
    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    await activateTickBar();
    const overlay = getOverlay();
    expect(overlay).toBeTruthy();

    await act(async () => {
      fireEvent.click(overlay!);
    });

    // QuickTickBar should unmount when tick bar closes
    expect(screen.queryByTestId('quick-tick-bar')).toBeNull();
  });

  it('overlay has active class when open and loses it on close', async () => {
    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    await activateTickBar();

    const overlay = getOverlay();
    expect(overlay).toBeTruthy();
    expect(overlay!.getAttribute('class')).toMatch(/tickOverlayActive/);

    await act(async () => {
      fireEvent.click(overlay!);
    });

    const overlayAfter = getOverlay();
    if (overlayAfter) {
      expect(overlayAfter.getAttribute('class')).not.toMatch(/tickOverlayActive/);
    }
  });
});

describe('QueueControlBar tick bar expanded persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueContext = { ...baseQueueContext };
    mockGetPreference.mockResolvedValue(null);
    mockSetPreference.mockResolvedValue(undefined);
  });

  it('reads persisted expanded state when tick bar opens', async () => {
    mockGetPreference.mockResolvedValue(true);

    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    await activateTickBar();

    expect(mockGetPreference).toHaveBeenCalledWith('tickBarExpanded');
  });

  it('does not read preference when tick bar is not opening', async () => {
    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    expect(mockGetPreference).not.toHaveBeenCalledWith('tickBarExpanded');
  });

  it('persists expanded state when user clicks expand button', async () => {
    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    await activateTickBar();

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Expand tick bar'));
    });

    expect(mockSetPreference).toHaveBeenCalledWith('tickBarExpanded', true);
  });

  it('persists collapsed state when user clicks collapse button', async () => {
    mockGetPreference.mockResolvedValue(true);

    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    await activateTickBar();

    // Wait for expanded state to be restored from IndexedDB
    await waitFor(() => {
      expect(screen.getByLabelText('Collapse tick bar')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Collapse tick bar'));
    });

    expect(mockSetPreference).toHaveBeenCalledWith('tickBarExpanded', false);
  });

  it('does not persist state on automatic close reset', async () => {
    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    await activateTickBar();

    mockSetPreference.mockClear();

    // Dismiss tick bar via overlay click
    const overlay = getOverlay();
    await act(async () => {
      fireEvent.click(overlay!);
    });

    expect(mockSetPreference).not.toHaveBeenCalledWith('tickBarExpanded', false);
  });

  it('keeps the attempt button visible in collapsed tick mode', async () => {
    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    await activateTickBar();

    expect(screen.getByLabelText('Log attempt')).toBeTruthy();
  });

  it('keeps the attempt button visible when the tick bar is expanded', async () => {
    mockGetPreference.mockResolvedValue(true);

    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    await activateTickBar();

    // Wait for the persisted expanded state to apply.
    await waitFor(() => {
      expect(screen.getByLabelText('Collapse tick bar')).toBeTruthy();
    });

    expect(screen.getByLabelText('Log attempt')).toBeTruthy();
  });

  it('restores expanded state on re-open after close', async () => {
    mockGetPreference.mockResolvedValue(true);

    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    await activateTickBar();

    await waitFor(() => {
      expect(screen.getByLabelText('Collapse tick bar')).toBeTruthy();
    });

    // Close
    const overlay = getOverlay();
    await act(async () => {
      fireEvent.click(overlay!);
    });

    // Wait for collapse animation timer (200ms)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });

    mockGetPreference.mockClear();
    mockGetPreference.mockResolvedValue(true);

    // Re-open
    await activateTickBar();

    expect(mockGetPreference).toHaveBeenCalledWith('tickBarExpanded');
  });
});
