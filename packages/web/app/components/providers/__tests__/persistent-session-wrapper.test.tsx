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
  useBoardProvider: () => ({ getLogbook: vi.fn() }),
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
  });

  it('renders no queue shell on a board route — nothing publishes board details there any more', () => {
    // The shell existed to cover the gap before the board route's queue bridge
    // hydrated. W-17 (#4433) removed that bridge, so on a board route the gap
    // is permanent and the placeholder would never resolve into a real bar.
    mockPathname = '/b/test-board/40/list';

    render(<RootBottomBar boardConfigs={mockBoardConfigs} />);

    expect(screen.queryByTestId('queue-control-bar-shell')).toBeNull();
    expect(screen.queryByTestId('queue-control-bar')).toBeNull();
    expect(screen.getByTestId('bottom-tab-bar')).toBeTruthy();
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
});

describe('RootBottomBar --bottom-bar-height measurement', () => {
  let resizeCallbacks: ResizeObserverCallback[] = [];
  let mockedTop = 0;
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

  const setWrapperTop = (top: number) => {
    mockedTop = top;
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
    mockedTop = 800; // Default: wrapper at viewport bottom → px = 0
    mockPathname = '/';
    mockQueueBridgeBoardInfo = {
      boardDetails: null,
      angle: 0,
      hasActiveQueue: false,
    };
    mockQueueContext = { queue: [], currentClimb: null };

    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    document.documentElement.style.removeProperty('--bottom-bar-height-measured');

    // Stub getBoundingClientRect at the prototype level so the initial
    // measurement on mount is deterministic (jsdom otherwise returns all
    // zeros, which would compute px = 800 and lock out grow-only updates).
    HTMLElement.prototype.getBoundingClientRect = function () {
      return {
        top: mockedTop,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: mockedTop,
        toJSON: () => ({}),
      } as DOMRect;
    };

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
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    document.documentElement.style.removeProperty('--bottom-bar-height-measured');
    vi.restoreAllMocks();
  });

  it('grows --bottom-bar-height-measured when the measured occlusion exceeds the last published value', () => {
    // Seed a baseline measured value so the layout effect starts from a known
    // floor. The CSS default lives separately in --bottom-bar-height-default;
    // JS now only tracks its own published measurement.
    document.documentElement.style.setProperty('--bottom-bar-height-measured', '145px');

    const { rerender } = render(<RootBottomBar boardConfigs={mockBoardConfigs} />);

    // viewportHeight - rect.top = 800 - 600 = 200px, which exceeds 145px.
    setWrapperTop(600);
    act(() => {
      resizeCallbacks.forEach((cb) => cb([] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
    });
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height-measured')).toBe('200px');

    // Sanity: rerender keeps the value stable.
    rerender(<RootBottomBar boardConfigs={mockBoardConfigs} />);
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height-measured')).toBe('200px');
  });

  it('publishes the first measurement on mount when --bottom-bar-height-measured is unset', () => {
    // No pre-seed: the inline-style override starts empty, so parseFloat reads
    // 0. The grow-only guard (px > measured + 2) must still fire on the
    // initial mount measurement so the first published value reflects the
    // real occlusion — otherwise the page would render against the CSS
    // default forever, missing any case where the rendered bar exceeds it.
    mockedTop = 620; // 800 - 620 = 180px initial occlusion

    render(<RootBottomBar boardConfigs={mockBoardConfigs} />);

    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height-measured')).toBe('180px');
  });

  it('never shrinks --bottom-bar-height-measured after hydration', () => {
    // Seed an already-large measured value. The grow-only guard in JS must
    // ignore smaller occlusion readings — CSS max() with --default handles
    // the floor independently, but the measured channel itself should also
    // be monotonic to avoid bouncing under jitter.
    document.documentElement.style.setProperty('--bottom-bar-height-measured', '200px');

    render(<RootBottomBar boardConfigs={mockBoardConfigs} />);

    // 800 - 700 = 100px, smaller than the current 200px — ignored.
    setWrapperTop(700);
    act(() => {
      resizeCallbacks.forEach((cb) => cb([] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
    });
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height-measured')).toBe('200px');

    // 800 - 650 = 150px, still smaller — ignored.
    setWrapperTop(650);
    act(() => {
      resizeCallbacks.forEach((cb) => cb([] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
    });
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height-measured')).toBe('200px');

    // 800 - 550 = 250px, exceeds 200px — grow.
    setWrapperTop(550);
    act(() => {
      resizeCallbacks.forEach((cb) => cb([] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
    });
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height-measured')).toBe('250px');
  });

  it('ignores growth within the 2px jitter tolerance', () => {
    document.documentElement.style.setProperty('--bottom-bar-height-measured', '200px');

    render(<RootBottomBar boardConfigs={mockBoardConfigs} />);

    // 800 - 599 = 201px — only 1px more than current, within tolerance.
    setWrapperTop(599);
    act(() => {
      resizeCallbacks.forEach((cb) => cb([] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
    });
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height-measured')).toBe('200px');

    // 800 - 598 = 202px — exactly at the tolerance ceiling (currentPx + 2);
    // ignored because the guard requires strictly greater than currentPx + 2.
    setWrapperTop(598);
    act(() => {
      resizeCallbacks.forEach((cb) => cb([] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
    });
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height-measured')).toBe('200px');

    // 800 - 597 = 203px — exceeds tolerance, grow.
    setWrapperTop(597);
    act(() => {
      resizeCallbacks.forEach((cb) => cb([] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
    });
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height-measured')).toBe('203px');
  });

  it('removes --bottom-bar-height-measured and detaches resize listeners on unmount', () => {
    const removeWindowSpy = vi.spyOn(window, 'removeEventListener');
    const removeViewportSpy = window.visualViewport ? vi.spyOn(window.visualViewport, 'removeEventListener') : null;

    document.documentElement.style.setProperty('--bottom-bar-height-measured', '145px');

    const { unmount } = render(<RootBottomBar boardConfigs={mockBoardConfigs} />);

    setWrapperTop(600);
    act(() => {
      resizeCallbacks.forEach((cb) => cb([] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
    });
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height-measured')).toBe('200px');

    unmount();

    expect(document.documentElement.style.getPropertyValue('--bottom-bar-height-measured')).toBe('');
    expect(removeWindowSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    if (removeViewportSpy) {
      expect(removeViewportSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    }
  });
});
