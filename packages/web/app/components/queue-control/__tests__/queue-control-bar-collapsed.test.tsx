import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import QueueControlBar from '../queue-control-bar';

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

const mockGetPreference = vi.fn();
const mockSetPreference = vi.fn().mockResolvedValue(undefined);
vi.mock('@/app/lib/user-preferences-db', () => ({
  getPreference: (...args: unknown[]) => mockGetPreference(...args),
  setPreference: (...args: unknown[]) => mockSetPreference(...args),
}));

let mockPathname = '/kilter/1/1/1/40/list';
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

vi.mock('@/app/components/queue-control/next-climb-button', () => ({
  default: () => React.createElement('button', { 'data-testid': 'next-climb' }),
}));

vi.mock('@/app/components/queue-control/previous-climb-button', () => ({
  default: () => React.createElement('button', { 'data-testid': 'prev-climb' }),
}));

vi.mock('@/app/components/logbook/tick-button', () => ({
  TickButton: (props: { onActivateTickBar?: () => void; tickBarActive?: boolean }) =>
    React.createElement(
      'button',
      {
        'data-testid': 'tick-button',
        onClick: props.onActivateTickBar,
        'data-tick-active': props.tickBarActive,
      },
      'tick',
    ),
}));

vi.mock('@/app/components/board-page/share-button', () => ({
  ShareBoardButton: () => null,
}));

vi.mock('@/app/components/play-view/play-view-drawer', () => ({
  default: ({
    activeDrawer,
    setActiveDrawer,
  }: {
    activeDrawer: string;
    setActiveDrawer: (drawer: 'none' | 'play' | 'queue' | 'tick') => void;
  }) =>
    activeDrawer === 'play'
      ? React.createElement(
          'div',
          { 'data-testid': 'play-drawer' },
          React.createElement(
            'button',
            {
              'data-testid': 'close-play-drawer',
              onClick: () => setActiveDrawer('none'),
            },
            'close',
          ),
        )
      : null,
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

type QuickTickBarMockHandle = {
  save: (element?: HTMLElement | null) => void;
  saveAttempt: (element?: HTMLElement | null) => void;
};

vi.mock('@/app/components/logbook/quick-tick-bar', () => ({
  QuickTickBar: React.forwardRef<QuickTickBarMockHandle, { onSave?: () => void }>((props, ref) => {
    React.useImperativeHandle(ref, () => ({
      save: vi.fn(),
      saveAttempt: vi.fn(),
    }));
    return React.createElement(
      'div',
      { 'data-testid': 'quick-tick-bar' },
      React.createElement(
        'button',
        {
          'data-testid': 'save-tick',
          onClick: props.onSave,
        },
        'save',
      ),
    );
  }),
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

const mockClimb = {
  uuid: 'climb-1',
  setter_username: 'setter1',
  name: 'Test Climb',
  description: '',
  frames: '',
  angle: 40,
  ascensionist_count: 5,
  difficulty: 'V7',
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
    clientId: 'client-1',
    isLeader: true,
    isBackendMode: false,
    hasConnected: true,
    connectionError: null,
  }),
}));

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

const swipeVertically = (element: Element, startY: number, endY: number) => {
  fireEvent.touchStart(element, { touches: [{ clientX: 10, clientY: startY }] });
  fireEvent.touchMove(element, { touches: [{ clientX: 10, clientY: endY }] });
  fireEvent.touchEnd(element, { changedTouches: [{ clientX: 10, clientY: endY }] });
};

const renderQueueControlBar = async () => {
  await act(async () => {
    render(<QueueControlBar {...defaultProps} />);
  });
};

describe('QueueControlBar collapsed mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/kilter/1/1/1/40/list';
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

  it('loads the shared collapsed preference on normal routes', async () => {
    mockGetPreference.mockImplementation((key: string) =>
      Promise.resolve(key === 'queueControlBar:collapsed' ? true : null),
    );

    await renderQueueControlBar();

    await waitFor(() => expect(screen.getByTestId('queue-control-bar-collapsed')).toBeTruthy());
    expect(mockGetPreference).toHaveBeenCalledWith('queueControlBar:collapsed');
  });

  it('defaults create-climb routes to collapsed and persists the create preference when expanded', async () => {
    mockPathname = '/kilter/1/1/1/40/create';

    await renderQueueControlBar();

    const miniBar = await screen.findByTestId('queue-control-bar-collapsed');
    await act(async () => {
      swipeVertically(miniBar, 120, 20);
    });

    await waitFor(() => expect(screen.queryByTestId('queue-control-bar-collapsed')).toBeNull());
    expect(mockGetPreference).toHaveBeenCalledWith('queueControlBar:createCollapsed');
    expect(mockSetPreference).toHaveBeenCalledWith('queueControlBar:createCollapsed', false);
  });

  it('persists collapsed state when the expanded handle is dragged down', async () => {
    await renderQueueControlBar();

    const handle = screen.getByTestId('queue-collapse-handle');
    expect(handle.closest('[data-tour-anchor="session-mini-bar"]')).toBeTruthy();

    await act(async () => {
      swipeVertically(handle, 20, 120);
    });

    await waitFor(() => expect(screen.getByTestId('queue-control-bar-collapsed')).toBeTruthy());
    expect(mockSetPreference).toHaveBeenCalledWith('queueControlBar:collapsed', true);
  });

  it('persists expanded state when the collapsed mini bar is dragged up', async () => {
    mockGetPreference.mockImplementation((key: string) =>
      Promise.resolve(key === 'queueControlBar:collapsed' ? true : null),
    );

    await renderQueueControlBar();

    const miniBar = await screen.findByTestId('queue-control-bar-collapsed');
    await act(async () => {
      swipeVertically(miniBar, 120, 20);
    });

    await waitFor(() => expect(screen.queryByTestId('queue-control-bar-collapsed')).toBeNull());
    expect(mockSetPreference).toHaveBeenCalledWith('queueControlBar:collapsed', false);
  });

  it('temporarily expands for climb details and returns to collapsed after close', async () => {
    mockGetPreference.mockImplementation((key: string) =>
      Promise.resolve(key === 'queueControlBar:collapsed' ? true : null),
    );

    await renderQueueControlBar();

    await act(async () => {
      fireEvent.click(await screen.findByLabelText('Open climb details'));
    });

    expect(screen.queryByTestId('queue-control-bar-collapsed')).toBeNull();
    expect(screen.getByTestId('play-drawer')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId('close-play-drawer'));
    });

    await waitFor(() => expect(screen.getByTestId('queue-control-bar-collapsed')).toBeTruthy());
    expect(mockSetPreference).not.toHaveBeenCalledWith('queueControlBar:collapsed', false);
  });

  it('temporarily expands for collapsed tick mode and returns to collapsed after save', async () => {
    mockGetPreference.mockImplementation((key: string) =>
      Promise.resolve(key === 'queueControlBar:collapsed' ? true : null),
    );

    await renderQueueControlBar();
    await screen.findByTestId('queue-control-bar-collapsed');
    mockSetPreference.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByTestId('tick-button'));
    });

    expect(screen.queryByTestId('queue-control-bar-collapsed')).toBeNull();
    expect(screen.getByTestId('quick-tick-bar')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId('save-tick'));
    });

    await waitFor(() => expect(screen.getByTestId('queue-control-bar-collapsed')).toBeTruthy());
    expect(mockSetPreference).not.toHaveBeenCalledWith('queueControlBar:collapsed', false);
    expect(mockSetPreference).not.toHaveBeenCalledWith('queueControlBar:collapsed', true);
  });

  it('temporarily expands for collapsed participant avatars and returns after closing them', async () => {
    mockPersistentSessionState = {
      activeSession: {
        sessionId: 'session-1',
        sessionName: 'Test Session',
        startedAt: new Date('2025-01-01').toISOString(),
      },
      localBoardDetails: null,
      localCurrentClimbQueueItem: null,
      session: { id: 'session-1', name: 'Test Session', startedAt: new Date('2025-01-01').toISOString() },
      users: [
        { id: 'client-1', userId: 'user-1', username: 'Marco' },
        { id: 'client-2', userId: 'user-2', username: 'Alex' },
      ],
    };
    mockGetPreference.mockImplementation((key: string) =>
      Promise.resolve(key === 'queueControlBar:collapsed' ? true : null),
    );

    await renderQueueControlBar();
    await screen.findByTestId('queue-control-bar-collapsed');
    mockSetPreference.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Show participants'));
    });

    expect(screen.queryByTestId('queue-control-bar-collapsed')).toBeNull();
    expect(screen.getByLabelText('Hide participants')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Hide participants'));
    });

    await waitFor(() => expect(screen.getByTestId('queue-control-bar-collapsed')).toBeTruthy());
    expect(mockSetPreference).not.toHaveBeenCalledWith('queueControlBar:collapsed', false);
    expect(mockSetPreference).not.toHaveBeenCalledWith('queueControlBar:collapsed', true);
  });
});
