import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { RootBottomBar } from '../persistent-session-wrapper';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// Capacitor utils are mocked so each test can dial the runtime platform
// without poking window.Capacitor.
let mockIsNativeApp = false;
let mockPlatform: 'ios' | 'android' | 'web' = 'web';
vi.mock('@/app/lib/ble/capacitor-utils', () => ({
  isNativeApp: () => mockIsNativeApp,
  getPlatform: () => mockPlatform,
}));

let mockPathname = '/';
let mockQueueBridgeBoardInfo = {
  boardDetails: null as Record<string, unknown> | null,
  angle: 0,
  hasActiveQueue: false,
};
let mockQueueContext = {
  queue: [] as unknown[],
  currentClimb: null,
};

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

vi.mock('../../party-manager/party-profile-context', () => ({
  PartyProfileProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../../persistent-session', () => ({
  PersistentSessionProvider: ({ children }: { children: React.ReactNode }) => children,
  usePersistentSession: () => ({
    sessionSummary: null,
    sessionSummaryBoardType: null,
    sessionSummaryHealthKitWorkoutId: null,
    dismissSessionSummary: vi.fn(),
  }),
  usePersistentSessionState: () => ({
    sessionSummary: null,
    sessionSummaryBoardType: null,
    sessionSummaryHealthKitWorkoutId: null,
  }),
  usePersistentSessionActions: () => ({
    dismissSessionSummary: vi.fn(),
  }),
}));

vi.mock('../../queue-control/queue-bridge-context', () => ({
  QueueBridgeProvider: ({ children }: { children: React.ReactNode }) => children,
  useQueueBridgeBoardInfo: () => mockQueueBridgeBoardInfo,
}));

vi.mock('../../graphql-queue', () => ({
  useQueueContext: () => mockQueueContext,
  useQueueData: () => mockQueueContext,
  useQueueActions: () => mockQueueContext,
  useCurrentClimb: () => ({ currentClimb: mockQueueContext.currentClimb }),
  useQueueList: () => ({ queue: mockQueueContext.queue, suggestedClimbs: [] }),
}));

vi.mock('../../queue-control/queue-control-bar', () => ({
  default: () => <div data-testid="queue-control-bar" />,
}));

vi.mock('../../bottom-tab-bar/bottom-tab-bar', () => ({
  default: () => <div data-testid="bottom-tab-bar" />,
}));

vi.mock('../../board-provider/board-provider-context', () => ({
  BoardProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../../connection-manager/connection-settings-context', () => ({
  ConnectionSettingsProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../../connection-manager/websocket-connection-provider', () => ({
  WebSocketConnectionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../../board-bluetooth-control/bluetooth-context', () => ({
  BluetoothProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../../climb-actions/favorites-batch-context', () => ({
  FavoritesProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../../climb-actions/playlists-batch-context', () => ({
  PlaylistsProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/app/hooks/use-climb-actions-data', () => ({
  useClimbActionsData: () => ({
    favoritesProviderProps: {},
    playlistsProviderProps: {},
  }),
}));

vi.mock('../../error-boundary', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../../global-header/global-header', () => ({
  default: () => <div data-testid="global-header" />,
}));

vi.mock('../../session-summary/session-summary-dialog', () => ({
  default: () => null,
}));

vi.mock('../../search-drawer/search-drawer-bridge-context', () => ({
  SearchDrawerBridgeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const mockBoardConfigs = {} as Parameters<typeof RootBottomBar>[0]['boardConfigs'];

describe('RootBottomBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/';
    mockQueueBridgeBoardInfo = {
      boardDetails: null,
      angle: 0,
      hasActiveQueue: false,
    };
    mockQueueContext = {
      queue: [],
      currentClimb: null,
    };
    mockIsNativeApp = false;
    mockPlatform = 'web';
  });

  it('renders the empty queue shell on board routes before queue bridge hydration completes', () => {
    mockPathname = '/b/test-board/40/list';

    render(<RootBottomBar boardConfigs={mockBoardConfigs} />);

    expect(screen.getByTestId('queue-control-bar-shell')).toBeTruthy();
    expect(screen.getByText('No climb selected')).toBeTruthy();
    expect(screen.queryByTestId('queue-control-bar')).toBeNull();
  });

  it('does not render the queue shell on non-board routes when there is no active queue', () => {
    mockPathname = '/playlists';

    render(<RootBottomBar boardConfigs={mockBoardConfigs} />);

    expect(screen.queryByTestId('queue-control-bar-shell')).toBeNull();
    expect(screen.getByTestId('bottom-tab-bar')).toBeTruthy();
  });

  it('renders the real queue control bar instead of the shell when an active queue is available', () => {
    mockPathname = '/b/test-board/40/list';
    mockQueueBridgeBoardInfo = {
      boardDetails: {
        board_name: 'kilter',
        layout_id: 1,
        size_id: 1,
        set_ids: [1],
      },
      angle: 40,
      hasActiveQueue: true,
    };

    render(<RootBottomBar boardConfigs={mockBoardConfigs} />);

    expect(screen.getByTestId('queue-control-bar')).toBeTruthy();
    expect(screen.queryByTestId('queue-control-bar-shell')).toBeNull();
  });

  it('renders the real queue control bar on profile routes when a session is active', () => {
    mockPathname = '/profile/test-user';
    mockQueueBridgeBoardInfo = {
      boardDetails: {
        board_name: 'kilter',
        layout_id: 1,
        size_id: 1,
        set_ids: [1],
      },
      angle: 40,
      hasActiveQueue: true,
    };

    render(<RootBottomBar boardConfigs={mockBoardConfigs} />);

    expect(screen.getByTestId('queue-control-bar')).toBeTruthy();
    expect(screen.queryByTestId('queue-control-bar-shell')).toBeNull();
    expect(screen.getByTestId('bottom-tab-bar')).toBeTruthy();
  });

  it('does not render the queue shell once board details are available but the queue is empty', () => {
    mockPathname = '/b/test-board/40/list';
    mockQueueBridgeBoardInfo = {
      boardDetails: {
        board_name: 'kilter',
        layout_id: 1,
        size_id: 1,
        set_ids: [1],
      },
      angle: 40,
      hasActiveQueue: false,
    };

    render(<RootBottomBar boardConfigs={mockBoardConfigs} />);

    expect(screen.queryByTestId('queue-control-bar')).toBeNull();
    expect(screen.queryByTestId('queue-control-bar-shell')).toBeNull();
    expect(screen.getByTestId('bottom-tab-bar')).toBeTruthy();
  });

  // Platform-specific safe-area class. iOS gets `iosNativeApp` so the pill
  // drops flush with the bottom of the screen and nests into the iPhone's
  // curved corners; Android keeps the `nativeApp` lift only because gesture-
  // nav clearance varies more.
  it('applies the iosNativeApp class only on iOS native', () => {
    mockIsNativeApp = true;
    mockPlatform = 'ios';

    render(<RootBottomBar boardConfigs={mockBoardConfigs} />);

    const wrapper = screen.getByTestId('bottom-bar-wrapper');
    expect(wrapper.className).toMatch(/nativeApp/);
    expect(wrapper.className).toMatch(/iosNativeApp/);
  });

  it('does not apply the iosNativeApp class on Android native', () => {
    mockIsNativeApp = true;
    mockPlatform = 'android';

    render(<RootBottomBar boardConfigs={mockBoardConfigs} />);

    const wrapper = screen.getByTestId('bottom-bar-wrapper');
    expect(wrapper.className).toMatch(/nativeApp/);
    expect(wrapper.className).not.toMatch(/iosNativeApp/);
  });

  it('does not apply native or iosNativeApp classes on web', () => {
    mockIsNativeApp = false;
    mockPlatform = 'web';

    render(<RootBottomBar boardConfigs={mockBoardConfigs} />);

    const wrapper = screen.getByTestId('bottom-bar-wrapper');
    expect(wrapper.className).not.toMatch(/nativeApp/);
    expect(wrapper.className).not.toMatch(/iosNativeApp/);
  });
});

describe('RootBottomBar --bottom-bar-height measurement', () => {
  let resizeCallbacks: ResizeObserverCallback[] = [];
  const originalResizeObserver = globalThis.ResizeObserver;

  const setWrapperTop = (top: number) => {
    const wrapper = screen.getByTestId('bottom-bar-wrapper');
    vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({
      top,
      bottom: 0,
      left: 0,
      right: 0,
      width: 0,
      height: 0,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect);
  };

  beforeEach(() => {
    resizeCallbacks = [];
    mockPathname = '/';
    mockQueueBridgeBoardInfo = {
      boardDetails: null,
      angle: 0,
      hasActiveQueue: false,
    };
    mockQueueContext = { queue: [], currentClimb: null };

    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    document.documentElement.style.removeProperty('--bottom-bar-height');

    class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        resizeCallbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
    document.documentElement.style.removeProperty('--bottom-bar-height');
    vi.restoreAllMocks();
  });

  it('publishes --bottom-bar-height on mount using viewportHeight - rect.top', () => {
    const { rerender } = render(<RootBottomBar boardConfigs={mockBoardConfigs} />);

    // First mount measures whatever jsdom reports for the wrapper rect.
    // To assert the formula, override and rerender to retrigger the layout effect.
    setWrapperTop(620);
    act(() => {
      // Trigger the ResizeObserver callback the effect registered on mount.
      resizeCallbacks.forEach((cb) => cb([] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
    });

    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height')).toBe('180px');

    // Sanity: rerender keeps the value stable.
    rerender(<RootBottomBar boardConfigs={mockBoardConfigs} />);
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height')).toBe('180px');
  });

  it('updates --bottom-bar-height when the wrapper resizes', () => {
    render(<RootBottomBar boardConfigs={mockBoardConfigs} />);

    setWrapperTop(700);
    act(() => {
      resizeCallbacks.forEach((cb) => cb([] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
    });
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height')).toBe('100px');

    setWrapperTop(550);
    act(() => {
      resizeCallbacks.forEach((cb) => cb([] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
    });
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height')).toBe('250px');
  });

  it('removes --bottom-bar-height and detaches resize listeners on unmount', () => {
    const removeWindowSpy = vi.spyOn(window, 'removeEventListener');
    const removeViewportSpy = window.visualViewport ? vi.spyOn(window.visualViewport, 'removeEventListener') : null;

    const { unmount } = render(<RootBottomBar boardConfigs={mockBoardConfigs} />);

    setWrapperTop(620);
    act(() => {
      resizeCallbacks.forEach((cb) => cb([] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
    });
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height')).toBe('180px');

    unmount();

    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height')).toBe('');
    expect(removeWindowSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    if (removeViewportSpy) {
      expect(removeViewportSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    }
  });
});
