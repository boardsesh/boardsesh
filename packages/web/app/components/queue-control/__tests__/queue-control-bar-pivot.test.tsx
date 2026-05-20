import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import {
  PLAY_DRAWER_EVENT,
  readPlayDrawerEventDetail,
  type PlayDrawerEventDetail,
} from '@/app/components/queue-control/play-drawer-event';
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
    isPersistentSessionActive: mockQueueContext.isPersistentSessionActive ?? false,
    driverParticipantId: mockQueueContext.driverParticipantId ?? null,
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
  isPersistentSessionActive: false,
  driverParticipantId: null,
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

// Build a party session state with N participants. The driver is the
// participant with id === driverId (when provided). users[*] order is the
// declared order in the array; the bar's driver-first partition should float
// the driver to position 0 if it isn't already.
//
// Each participant defaults to a unique `userId` derived from `id` so the
// bar's dedupe (`user.userId ?? user.id`) doesn't collapse the roster to a
// single avatar.
const makeSessionState = (users: { id: string; username: string; userId?: string }[]): Record<string, unknown> => ({
  activeSession: {
    sessionId: 'session-1',
    sessionName: 'Test Session',
    startedAt: new Date('2025-01-01').toISOString(),
  },
  localBoardDetails: null,
  localCurrentClimbQueueItem: null,
  session: { id: 'session-1', name: 'Test Session', startedAt: new Date('2025-01-01').toISOString() },
  users: users.map((u) => ({
    id: u.id,
    username: u.username,
    isLeader: false,
    userId: u.userId ?? `user-${u.id}`,
    connectionState: 'CONNECTED',
  })),
});

describe('QueueControlBar pivot', () => {
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

  // --- Wall-view dispatch (P0-2) -------------------------------------------

  it('tapping the climb-title region dispatches wallView=true on the play-drawer event', async () => {
    const seenDetails: PlayDrawerEventDetail[] = [];
    const handler = (event: Event) => {
      const detail = readPlayDrawerEventDetail(event);
      if (detail) seenDetails.push(detail);
    };
    window.addEventListener(PLAY_DRAWER_EVENT, handler);

    try {
      await act(async () => {
        render(<QueueControlBar {...defaultProps} />);
      });

      const title = document.getElementById('onboarding-queue-toggle');
      expect(title).toBeTruthy();

      await act(async () => {
        fireEvent.click(title!);
      });

      // At least one dispatch fired, and the most recent had wallView=true.
      expect(seenDetails.length).toBeGreaterThan(0);
      const last = seenDetails[seenDetails.length - 1];
      expect(last.wallView).toBe(true);
      // No climb payload on the bar's body-tap path — the drawer falls back
      // to the wall climb.
      expect(last.climb).toBeUndefined();
    } finally {
      window.removeEventListener(PLAY_DRAWER_EVENT, handler);
    }
  });

  it('keyboard Enter on the climb-title region dispatches wallView=true', async () => {
    const seenDetails: PlayDrawerEventDetail[] = [];
    const handler = (event: Event) => {
      const detail = readPlayDrawerEventDetail(event);
      if (detail) seenDetails.push(detail);
    };
    window.addEventListener(PLAY_DRAWER_EVENT, handler);

    try {
      await act(async () => {
        render(<QueueControlBar {...defaultProps} />);
      });

      const title = document.getElementById('onboarding-queue-toggle');
      expect(title).toBeTruthy();

      await act(async () => {
        fireEvent.keyDown(title!, { key: 'Enter' });
      });

      expect(seenDetails.length).toBeGreaterThan(0);
      expect(seenDetails[seenDetails.length - 1].wallView).toBe(true);
    } finally {
      window.removeEventListener(PLAY_DRAWER_EVENT, handler);
    }
  });

  // --- Accessibility on climb-title CTA (P1-C) -----------------------------

  it('climb-title region has role="button" and an accessible aria-label', async () => {
    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    const title = document.getElementById('onboarding-queue-toggle');
    expect(title).toBeTruthy();
    expect(title!.getAttribute('role')).toBe('button');
    expect(title!.getAttribute('tabindex')).toBe('0');
    expect(title!.getAttribute('aria-label')).toBe("Show what's on the wall");
  });

  // --- Driver-first ordering (P1-C) ----------------------------------------

  it('renders the driver first in the participant roster', async () => {
    mockQueueContext = {
      ...baseQueueContext,
      isPersistentSessionActive: true,
      driverParticipantId: 'p-bob',
    };
    // Alice is first in users[]; Bob is the driver and must float to slot 0.
    mockPersistentSessionState = makeSessionState([
      { id: 'p-alice', username: 'alice' },
      { id: 'p-bob', username: 'bob' },
      { id: 'p-carol', username: 'carol' },
    ]);

    const { container } = await act(async () => {
      return render(<QueueControlBar {...defaultProps} />);
    });

    // The expanded participant scroll renders each user as a labeled tile
    // (`participantItem`) with the username as text. The bar's driver-first
    // partition floats the driver to index 0, so the rendered DOM order of
    // username labels should be: bob, alice, carol — even though the source
    // users[] array declared them as alice, bob, carol.
    const items = container.querySelectorAll('[class*="participantItem"]');
    expect(items.length).toBe(3);
    const orderedUsernames = Array.from(items).map((el) => el.textContent?.trim());
    expect(orderedUsernames).toEqual(['bob', 'alice', 'carol']);
  });

  it('does not reorder participants when there is no driver', async () => {
    mockQueueContext = {
      ...baseQueueContext,
      isPersistentSessionActive: true,
      driverParticipantId: null,
    };
    mockPersistentSessionState = makeSessionState([
      { id: 'p-alice', username: 'alice' },
      { id: 'p-bob', username: 'bob' },
    ]);

    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    // No driver — no driving aria-label should be rendered.
    expect(screen.queryByLabelText(/is driving/)).toBeNull();
  });

  // --- Driver badge & aria-label (P1-C) ------------------------------------

  it('renders the driver avatar with an accessible "is driving" aria-label in the mini bar', async () => {
    mockQueueContext = {
      ...baseQueueContext,
      isPersistentSessionActive: true,
      driverParticipantId: 'p-bob',
    };
    mockPersistentSessionState = makeSessionState([
      { id: 'p-alice', username: 'alice' },
      { id: 'p-bob', username: 'bob' },
    ]);

    const { container } = await act(async () => {
      return render(<QueueControlBar {...defaultProps} />);
    });

    // Mini-bar AvatarGroup carries the driver's "is driving" aria-label on
    // its avatar — find it by scoping to the AvatarGroup so the expanded
    // roster's duplicate label doesn't muddy this assertion.
    const avatarGroup = container.querySelector('.MuiAvatarGroup-root');
    expect(avatarGroup).toBeTruthy();
    const drivingInMiniBar = avatarGroup!.querySelector('[aria-label="bob is driving"]');
    expect(drivingInMiniBar).toBeTruthy();
  });

  it('renders the driver avatar with the "is driving" aria-label in the expanded roster', async () => {
    mockQueueContext = {
      ...baseQueueContext,
      isPersistentSessionActive: true,
      driverParticipantId: 'p-bob',
    };
    mockPersistentSessionState = makeSessionState([
      { id: 'p-alice', username: 'alice' },
      { id: 'p-bob', username: 'bob' },
      { id: 'p-carol', username: 'carol' },
    ]);

    const { container } = await act(async () => {
      return render(<QueueControlBar {...defaultProps} />);
    });

    // The expanded participant roster lives in `participantBar` and is always
    // rendered (CSS toggles visibility on `participantBarExpanded`). Scope
    // the query to that subtree so the assertion is unambiguous regardless of
    // the mini-bar's matching avatar.
    const participantBar = container.querySelector('[class*="participantBar"]');
    expect(participantBar).toBeTruthy();
    const driverInRoster = participantBar!.querySelector('[aria-label="bob is driving"]');
    expect(driverInRoster).toBeTruthy();
  });

  it('does not surface a driver aria-label when no driver is set', async () => {
    mockQueueContext = {
      ...baseQueueContext,
      isPersistentSessionActive: true,
      driverParticipantId: null,
    };
    mockPersistentSessionState = makeSessionState([
      { id: 'p-alice', username: 'alice' },
      { id: 'p-bob', username: 'bob' },
    ]);

    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    expect(screen.queryByLabelText(/is driving/)).toBeNull();
  });
});
