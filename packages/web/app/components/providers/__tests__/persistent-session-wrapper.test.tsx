import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RootBottomBar } from '../persistent-session-wrapper';

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
  PartyProfileProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../persistent-session', () => ({
  PersistentSessionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  usePersistentSession: () => ({
    sessionSummary: null,
    dismissSessionSummary: vi.fn(),
  }),
}));

vi.mock('../../queue-control/queue-bridge-context', () => ({
  QueueBridgeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useQueueBridgeBoardInfo: () => mockQueueBridgeBoardInfo,
}));

vi.mock('../../graphql-queue', () => ({
  useQueueContext: () => mockQueueContext,
}));

vi.mock('../../queue-control/queue-control-bar', () => ({
  default: () => <div data-testid="queue-control-bar" />,
}));

vi.mock('../../bottom-tab-bar/bottom-tab-bar', () => ({
  default: () => <div data-testid="bottom-tab-bar" />,
}));

vi.mock('../../board-provider/board-provider-context', () => ({
  BoardProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../connection-manager/connection-settings-context', () => ({
  ConnectionSettingsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../connection-manager/websocket-connection-provider', () => ({
  WebSocketConnectionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../board-bluetooth-control/bluetooth-context', () => ({
  BluetoothProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../climb-actions/favorites-batch-context', () => ({
  FavoritesProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../climb-actions/playlists-batch-context', () => ({
  PlaylistsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/app/hooks/use-climb-actions-data', () => ({
  useClimbActionsData: () => ({
    favoritesProviderProps: {},
    playlistsProviderProps: {},
  }),
}));

vi.mock('../../error-boundary', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../global-header/global-header', () => ({
  default: () => <div data-testid="global-header" />,
}));

vi.mock('../../session-summary/session-summary-dialog', () => ({
  default: () => null,
}));

vi.mock('../../search-drawer/search-drawer-bridge-context', () => ({
  SearchDrawerBridgeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
