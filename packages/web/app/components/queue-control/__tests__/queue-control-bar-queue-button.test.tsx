import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { dispatchOpenSeshSettingsDrawer } from '@/app/components/sesh-settings/sesh-settings-drawer-event';
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

vi.mock('@/app/components/swipeable-drawer/swipeable-drawer', () => ({
  default: ({ open, children }: { open?: boolean; children?: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'queue-drawer', 'data-open': open ? 'true' : 'false' }, children),
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
  TickButton: (props: { onActivateTickBar?: () => void; tickBarActive?: boolean }) =>
    React.createElement('button', {
      'data-testid': 'tick-button',
      onClick: props.onActivateTickBar,
      'data-tick-active': props.tickBarActive,
    }),
}));

vi.mock('@/app/components/play-view/play-view-drawer', () => ({
  default: () => null,
}));

vi.mock('@/app/components/onboarding/onboarding-tour-events', () => ({
  TOUR_CLOSE_PLAY_VIEW_EVENT: 'onboarding:close-play-view',
}));

vi.mock('@/app/components/ui/confirm-popover', () => ({
  ConfirmPopover: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ status: 'unauthenticated', data: null }),
}));

let mockPersistentSessionState: Record<string, unknown> = {
  activeSession: null,
  localBoardDetails: null,
  localCurrentClimbQueueItem: null,
  session: null,
  users: [],
};
vi.mock('@/app/components/persistent-session/persistent-session-context', () => ({
  usePersistentSessionState: () => mockPersistentSessionState,
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

const makeQueueItem = (uuid: string) => ({
  uuid,
  climb: { ...mockClimb, uuid: `climb-${uuid}` },
  addedBy: 'user-1',
  suggested: false,
});

const baseQueueContext = {
  queue: [makeQueueItem('item-1')],
  currentClimbQueueItem: makeQueueItem('item-1'),
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

const activeSessionState = {
  activeSession: {
    sessionId: 'session-1',
    sessionName: 'Test Session',
    startedAt: new Date('2025-01-01').toISOString(),
  },
  localBoardDetails: null,
  localCurrentClimbQueueItem: null,
  session: { id: 'session-1', name: 'Test Session', startedAt: new Date('2025-01-01').toISOString() },
  users: [],
};

describe('QueueControlBar queue button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueContext = { ...baseQueueContext };
    mockPersistentSessionState = {
      activeSession: null,
      localBoardDetails: null,
      localCurrentClimbQueueItem: null,
      session: null,
      users: [],
    };
    mockGetPreference.mockResolvedValue(null);
    mockSetPreference.mockResolvedValue(undefined);
  });

  it('opens the queue drawer when clicked', async () => {
    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    expect(screen.getByTestId('queue-drawer').getAttribute('data-open')).toBe('false');

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Open up next'));
    });

    expect(screen.getByTestId('queue-drawer').getAttribute('data-open')).toBe('true');
  });

  it('stopPropagation prevents the parent session header from opening sesh settings', async () => {
    mockPersistentSessionState = activeSessionState;

    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Open up next'));
    });

    expect(dispatchOpenSeshSettingsDrawer).not.toHaveBeenCalled();
    // And the queue drawer did open, confirming the click landed on the button.
    expect(screen.getByTestId('queue-drawer').getAttribute('data-open')).toBe('true');
  });

  it('badge shows the queue count when items are queued', async () => {
    mockQueueContext = {
      ...baseQueueContext,
      queue: [makeQueueItem('item-1'), makeQueueItem('item-2'), makeQueueItem('item-3')],
    };

    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    const badge = screen.getByLabelText('Open up next').querySelector('.MuiBadge-badge');
    expect(badge).toBeTruthy();
    expect(badge!.textContent).toBe('3');
  });

  it('badge content is 0 (and rendered invisible) when queue is empty', async () => {
    mockQueueContext = { ...baseQueueContext, queue: [] };

    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    const badge = screen.getByLabelText('Open up next').querySelector('.MuiBadge-badge');
    expect(badge).toBeTruthy();
    // MUI renders `badgeContent={0}` literally; `invisible={true}` hides it via CSS
    // (no public class name in v6+), so we assert on the bound count, not visibility.
    expect(badge!.textContent).toBe('0');
  });

  it('mini bar collapses (loses sessionHeaderExpanded) when tick mode activates', async () => {
    const { container } = render(<QueueControlBar {...defaultProps} />);
    await act(async () => {});

    const wrapper = container.querySelector('[class*="sessionHeaderWrapper"]');
    expect(wrapper).toBeTruthy();
    expect(wrapper!.getAttribute('class')).toMatch(/sessionHeaderExpanded/);

    await act(async () => {
      fireEvent.click(screen.getByTestId('tick-button'));
    });

    expect(wrapper!.getAttribute('class')).not.toMatch(/sessionHeaderExpanded/);
  });
});
