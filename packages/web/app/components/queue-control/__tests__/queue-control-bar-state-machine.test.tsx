import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import QueueControlBar from '../queue-control-bar';

// -- Mocks --

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
  getGradeDisplayFormat: async () => 'v',
  setGradeDisplayFormat: async () => {},
}));

let mockQueueContext: Record<string, unknown> = {};
vi.mock('@/app/components/graphql-queue', () => ({
  useQueueContext: () => mockQueueContext,
  useQueueData: () => mockQueueContext,
  useQueueActions: () => mockQueueContext,
  useCurrentClimb: () => ({
    currentClimb: mockQueueContext.currentClimb,
  }),
  useCurrentClimbUuid: () => (mockQueueContext.currentClimb as { uuid?: string } | undefined)?.uuid ?? null,
  useRemoteClimbChangeCount: () => (mockQueueContext.remoteClimbChangeCount as number | undefined) ?? 0,
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

// next/navigation: pathname is mutable across tests so we can simulate
// /list (expanded by default) vs /view (minimised by default).
let mockPathname = '/kilter/1/1/1/40/view/abc';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
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

vi.mock('@vercel/analytics', () => ({ track: vi.fn() }));

vi.mock('@/app/hooks/use-card-swipe-navigation', () => ({
  useCardSwipeNavigation: () => ({
    swipeHandlers: {},
    swipeOffset: 0,
    isAnimating: false,
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

// useScrollDirection: pretend nothing scrolls. Tests that need a scroll
// event override this via vi.mock factory call captures.
const scrollHandlers: { onUp?: () => void; onDown?: () => void } = {};
vi.mock('@/app/hooks/use-scroll-direction', () => ({
  useScrollDirection: (opts: { onUp?: () => void; onDown?: () => void }) => {
    scrollHandlers.onUp = opts.onUp;
    scrollHandlers.onDown = opts.onDown;
  },
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

// Spy-mock both drawers so we can observe their `open` prop transitions.
const playDrawerOpenStates: boolean[] = [];
vi.mock('@/app/components/play-view/play-view-drawer', () => ({
  default: (props: { activeDrawer?: string }) => {
    playDrawerOpenStates.push(props.activeDrawer === 'play');
    return null;
  },
}));

const queueDrawerOpenStates: boolean[] = [];
vi.mock('@/app/components/play-view/queue-drawer', () => ({
  default: (props: { open: boolean }) => {
    queueDrawerOpenStates.push(props.open);
    return props.open ? React.createElement('div', { 'data-testid': 'queue-drawer', 'data-open': 'true' }) : null;
  },
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
    isBluetoothSupported: true,
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

vi.mock('@/app/hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    formatGrade: (difficulty: string | null | undefined) => (difficulty ? `V${difficulty}` : null),
    getGradeColor: () => '#444444',
    loaded: true,
    gradeFormat: 'v-grade',
    setGradeFormat: vi.fn(),
  }),
}));

vi.mock('@/app/hooks/use-is-dark-mode', () => ({
  useIsDarkMode: () => false,
}));

// jsdom's matchMedia stub.
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

// -- Fixtures --

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

const getFabCluster = () => document.querySelector('[data-testid="queue-control-fab"]') as HTMLElement | null;
const isFabVisible = () => {
  const cluster = getFabCluster();
  return !!cluster && cluster.getAttribute('aria-hidden') === 'false';
};

// Queries restricted to the FAB cluster so we don't collide with the
// in-bar queue icon (which also uses aria-label="Open queue") that
// stays mounted in the DOM under the collapsed wrapper.
const getFabButton = (label: string): HTMLElement => {
  const cluster = getFabCluster();
  if (!cluster) throw new Error('FAB cluster not in DOM');
  const button = cluster.querySelector(`[aria-label="${label}"]`);
  if (!button) throw new Error(`No FAB with aria-label "${label}"`);
  return button as HTMLElement;
};

// React.memo wraps the bar — props have to differ for a rerender to
// take effect. Re-spread boardDetails so the reference changes and
// memo's shallow compare invalidates.
const propsWithFreshRef = (props: typeof defaultProps): typeof defaultProps => ({
  ...props,
  boardDetails: { ...(props.boardDetails as unknown as Record<string, unknown>) } as never,
});

describe('QueueControlBar layout state machine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueContext = { ...baseQueueContext };
    mockGetPreference.mockResolvedValue(null);
    mockSetPreference.mockResolvedValue(undefined);
    mockPathname = '/kilter/1/1/1/40/view/abc';
    playDrawerOpenStates.length = 0;
    queueDrawerOpenStates.length = 0;
    scrollHandlers.onUp = undefined;
    scrollHandlers.onDown = undefined;
  });

  it('starts minimised on a non-list page (FAB visible)', async () => {
    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    expect(isFabVisible()).toBe(true);
  });

  it('starts expanded on the climb list page (FAB hidden)', async () => {
    mockPathname = '/kilter/1/1/1/40/list';
    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    const cluster = getFabCluster();
    // Cluster is mounted but flagged hidden so the bar can claim the space.
    expect(cluster?.getAttribute('aria-hidden')).toBe('true');
  });

  it('expands the bar when the grade FAB is tapped', async () => {
    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    expect(isFabVisible()).toBe(true);

    await act(async () => {
      fireEvent.click(getFabButton('Expand queue control'));
    });

    expect(getFabCluster()?.getAttribute('aria-hidden')).toBe('true');
  });

  it('opens the queue drawer when the queue FAB is tapped', async () => {
    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    expect(queueDrawerOpenStates.at(-1)).toBe(false);

    await act(async () => {
      fireEvent.click(getFabButton('Open queue'));
    });

    // Drawer's `open` prop flipped true on the most recent render.
    expect(queueDrawerOpenStates.at(-1)).toBe(true);
    // And the bar is forced expanded while the drawer is open.
    expect(getFabCluster()?.getAttribute('aria-hidden')).toBe('true');
  });

  it('activates tick mode when the tick FAB is tapped', async () => {
    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    expect(screen.queryByTestId('quick-tick-bar')).toBeNull();

    await act(async () => {
      fireEvent.click(getFabButton('Save tick'));
    });

    expect(screen.getByTestId('quick-tick-bar')).toBeTruthy();
    // Bar is expanded for the tick UI.
    expect(getFabCluster()?.getAttribute('aria-hidden')).toBe('true');
  });

  it('opens the play view drawer when the climb thumbnail FAB is tapped', async () => {
    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    expect(playDrawerOpenStates.at(-1)).toBe(false);

    await act(async () => {
      fireEvent.click(getFabButton('Open climb details'));
    });

    expect(playDrawerOpenStates.at(-1)).toBe(true);
    expect(getFabCluster()?.getAttribute('aria-hidden')).toBe('true');
  });

  it('returns to minimised after a FAB-opened drawer is dismissed', async () => {
    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    // Open tick mode via the FAB → bar expanded, openReason='tickOpen'.
    await act(async () => {
      fireEvent.click(getFabButton('Save tick'));
    });
    expect(screen.getByTestId('quick-tick-bar')).toBeTruthy();
    expect(getFabCluster()?.getAttribute('aria-hidden')).toBe('true');

    // Dismiss via the tick overlay (production close path) →
    // activeDrawer flips to 'none' → close-handler effect sees
    // prevDrawer was 'tick' and openReason was 'tickOpen' → bar
    // returns to minimised so the FAB cluster comes back without
    // an extra tap.
    const overlay = document.querySelector('[data-testid="tick-backdrop-overlay"]') as HTMLElement | null;
    expect(overlay).toBeTruthy();
    await act(async () => {
      fireEvent.click(overlay!);
    });

    expect(getFabCluster()?.getAttribute('aria-hidden')).toBe('false');
  });

  it('peeks the snackbar when a remote climb change arrives while minimised', async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<QueueControlBar {...defaultProps} />);
      await act(async () => {});

      // No snackbar at first mount — lastPeekedCountRef is captured on
      // first run so the initial counter doesn't trigger a peek.
      expect(document.querySelector('[class*="peekSnackbar"]')).toBeNull();

      // Bump the remote-change counter (simulates a remote
      // DELTA_UPDATE_CURRENT_CLIMB applying through the reducer). The
      // bar is wrapped in React.memo, so rotate the prop reference to
      // force a re-render that picks up the new context value.
      const nextClimb = { ...mockClimb, uuid: 'climb-2', name: 'Different Climb' };
      mockQueueContext = {
        ...baseQueueContext,
        queue: [{ uuid: 'item-2', climb: nextClimb, addedBy: 'user-1', suggested: false }],
        currentClimbQueueItem: { uuid: 'item-2', climb: nextClimb, addedBy: 'user-1', suggested: false },
        currentClimb: nextClimb,
        remoteClimbChangeCount: 1,
      };
      await act(async () => {
        rerender(<QueueControlBar {...propsWithFreshRef(defaultProps)} />);
      });

      // Snackbar mounted with the new climb name.
      const snackbar = document.querySelector('[class*="peekSnackbar"]');
      expect(snackbar).toBeTruthy();
      expect(snackbar?.textContent).toMatch(/Different Climb/);

      // The peek is now sticky — no auto-dismiss timer. Advance way
      // past the old 3s window and confirm it's still up.
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      expect(document.querySelector('[class*="peekSnackbar"]')).toBeTruthy();

      // After the 300ms grace window, a user interaction dismisses it.
      await act(async () => {
        vi.advanceTimersByTime(350);
      });
      await act(async () => {
        document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      });
      // Snackbar exit animation is gated by an additional ~200ms unmount
      // delay in the FAB component — give it time to finish.
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(document.querySelector('[class*="peekSnackbar"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not peek for local-only climb changes (counter unchanged)', async () => {
    const { rerender } = render(<QueueControlBar {...defaultProps} />);
    await act(async () => {});

    // Swap the current climb without bumping remoteClimbChangeCount —
    // simulates a local user-initiated change. The peek must NOT fire.
    const nextClimb = { ...mockClimb, uuid: 'climb-local', name: 'Local Climb' };
    mockQueueContext = {
      ...baseQueueContext,
      queue: [{ uuid: 'item-local', climb: nextClimb, addedBy: 'user-1', suggested: false }],
      currentClimbQueueItem: { uuid: 'item-local', climb: nextClimb, addedBy: 'user-1', suggested: false },
      currentClimb: nextClimb,
      // remoteClimbChangeCount unchanged (still 0)
    };
    await act(async () => {
      rerender(<QueueControlBar {...propsWithFreshRef(defaultProps)} />);
    });

    expect(document.querySelector('[class*="peekSnackbar"]')).toBeNull();
  });

  it('queues a peek when a remote change arrives while expanded and fires it on collapse', async () => {
    // Party-mode scenario: user has the tick drawer open (bar expanded)
    // when another participant advances the queue. The peek must be
    // deferred until the drawer closes — otherwise the climb-change
    // cue is lost behind the drawer chrome.
    vi.useFakeTimers();
    try {
      const { rerender } = render(<QueueControlBar {...defaultProps} />);
      await act(async () => {});

      // Open tick drawer → bar forces expanded, openReason='tickOpen'.
      await act(async () => {
        fireEvent.click(getFabButton('Save tick'));
      });
      expect(screen.getByTestId('quick-tick-bar')).toBeTruthy();
      expect(getFabCluster()?.getAttribute('aria-hidden')).toBe('true');

      // Remote change arrives while drawer is open. Snackbar must NOT
      // appear yet — the trigger effect early-returns because
      // layoutState is 'expanded'.
      const nextClimb = { ...mockClimb, uuid: 'climb-99', name: 'Party Climb' };
      mockQueueContext = {
        ...baseQueueContext,
        queue: [{ uuid: 'item-99', climb: nextClimb, addedBy: 'user-1', suggested: false }],
        currentClimbQueueItem: { uuid: 'item-99', climb: nextClimb, addedBy: 'user-1', suggested: false },
        currentClimb: nextClimb,
        remoteClimbChangeCount: 1,
      };
      await act(async () => {
        rerender(<QueueControlBar {...propsWithFreshRef(defaultProps)} />);
      });
      expect(document.querySelector('[class*="peekSnackbar"]')).toBeNull();

      // Close the drawer via the tick overlay (production close path).
      // Bar collapses to minimised → trigger effect re-runs because
      // layoutState changed → fires the queued peek for the latest climb.
      const overlay = document.querySelector('[data-testid="tick-backdrop-overlay"]') as HTMLElement | null;
      expect(overlay).toBeTruthy();
      await act(async () => {
        fireEvent.click(overlay!);
      });

      const snackbar = document.querySelector('[class*="peekSnackbar"]');
      expect(snackbar).toBeTruthy();
      expect(snackbar?.textContent).toMatch(/Party Climb/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('collapses to minimised on scroll-down on the climb list page', async () => {
    mockPathname = '/kilter/1/1/1/40/list';
    await act(async () => {
      render(<QueueControlBar {...defaultProps} />);
    });

    // Starts expanded (FAB aria-hidden=true).
    expect(getFabCluster()?.getAttribute('aria-hidden')).toBe('true');

    await act(async () => {
      scrollHandlers.onDown?.();
    });

    // Scroll down → minimised → FAB visible.
    expect(getFabCluster()?.getAttribute('aria-hidden')).toBe('false');
  });
});
