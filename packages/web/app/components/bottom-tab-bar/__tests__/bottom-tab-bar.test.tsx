import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import type { BoardDetails } from '@/app/lib/types';
import type { BoardConfigData } from '@/app/lib/server-board-configs';

const mockPush = vi.fn();
const mockShowMessage = vi.fn();
const mockCreatePlaylist = vi.fn();

let mockPathname = '/kilter/original/12x12-square/screw_bolt/40/list';
let mockActiveSession: {
  sessionId: string;
  boardPath: string;
  boardDetails: BoardDetails;
  parsedParams: { angle: number };
} | null = null;

const mockBoardConfig = {
  board: 'kilter',
  layoutId: 1,
  sizeId: 1,
  setIds: [1],
  angle: 40,
  name: 'Kilter 40',
  createdAt: '2026-03-02T00:00:00.000Z',
};

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@vercel/analytics', () => ({
  track: vi.fn(),
}));

vi.mock('@/app/hooks/use-color-mode', () => ({
  useColorMode: () => ({ mode: 'light' }),
}));

vi.mock('@/app/hooks/use-unread-notification-count', () => ({
  useUnreadNotificationCount: () => 0,
}));

vi.mock('../../swipeable-drawer/swipeable-drawer', () => ({
  default: ({
    open,
    title,
    children,
    extra,
  }: {
    open: boolean;
    title: string;
    children: React.ReactNode;
    extra?: React.ReactNode;
  }) => (open ? <div data-testid={`drawer-${title}`}>{children}{extra}</div> : null),
}));

vi.mock('../../board-selector-drawer/board-selector-drawer', () => ({
  default: ({
    open,
    onClose,
    onBoardSelected,
  }: {
    open: boolean;
    onClose: () => void;
    onBoardSelected?: (url: string, config?: unknown) => void;
  }) => (open
    ? (
        <div data-testid="board-selector-drawer">
          <button
            type="button"
            onClick={() => {
              onBoardSelected?.('/kilter/original/12x12-square/screw_bolt/40/list', mockBoardConfig);
              onClose();
            }}
          >
            Select Board
          </button>
        </div>
      )
    : null),
}));

vi.mock('../../auth/auth-modal', () => ({
  default: () => null,
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

vi.mock('../../persistent-session', () => ({
  usePersistentSession: () => ({
    activeSession: mockActiveSession,
    localBoardDetails: null,
    localCurrentClimbQueueItem: null,
  }),
}));

vi.mock('@/app/hooks/use-climb-actions-data', () => ({
  useClimbActionsData: () => ({
    playlistsProviderProps: {
      createPlaylist: mockCreatePlaylist,
      isAuthenticated: true,
    },
  }),
}));

let mockPlatform: 'ios' | 'android' | 'web' = 'web';

vi.mock('@/app/lib/ble/capacitor-utils', () => ({
  getPlatform: () => mockPlatform,
}));

vi.mock('@/app/lib/last-used-board-db', () => ({
  getLastUsedBoard: () => Promise.resolve(null),
}));

vi.mock('@/app/components/search-drawer/recent-searches-storage', () => ({
  getRecentSearches: () => Promise.resolve([]),
}));

import BottomTabBar from '../bottom-tab-bar';

const boardDetails = {
  images_to_holds: {},
  holdsData: [],
  edge_left: 0,
  edge_right: 0,
  edge_bottom: 0,
  edge_top: 0,
  boardHeight: 0,
  boardWidth: 0,
  board_name: 'kilter',
  layout_id: 8,
  size_id: 1,
  set_ids: [1],
  layout_name: 'Original',
  size_name: '12x12',
  size_description: 'Square',
  set_names: ['Screw Bolt'],
} as BoardDetails;

const boardConfigs = {} as BoardConfigData;

describe('BottomTabBar iOS feed tab visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/';
    mockActiveSession = null;
    mockPlatform = 'web';
  });

  it('shows Feed tab on non-iOS platforms', () => {
    mockPlatform = 'web';
    render(<BottomTabBar boardConfigs={boardConfigs} />);
    expect(screen.getByRole('button', { name: 'Feed' })).toBeTruthy();
  });

  it('hides Feed tab on iOS native app', () => {
    mockPlatform = 'ios';
    render(<BottomTabBar boardConfigs={boardConfigs} />);
    expect(screen.queryByRole('button', { name: 'Feed' })).toBeNull();
  });

  it('shows Feed tab on Android native app', () => {
    mockPlatform = 'android';
    render(<BottomTabBar boardConfigs={boardConfigs} />);
    expect(screen.getByRole('button', { name: 'Feed' })).toBeTruthy();
  });
});

describe('BottomTabBar session preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/';
    mockActiveSession = null;
    mockPlatform = 'web';
  });

  it('includes session param when navigating to climbs with active session on /b/ board', async () => {
    mockActiveSession = {
      sessionId: 'test-session-123',
      boardPath: '/b/my-board/35/list',
      boardDetails,
      parsedParams: { angle: 35 },
    };

    render(<BottomTabBar boardConfigs={boardConfigs} />);
    fireEvent.click(screen.getByRole('button', { name: 'Climb' }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(
        expect.stringContaining('session=test-session-123'),
      );
    });
  });

  it('uses /b/ slug URL from active session when on home page', async () => {
    mockActiveSession = {
      sessionId: 'test-session-123',
      boardPath: '/b/my-board/35/list',
      boardDetails,
      parsedParams: { angle: 35 },
    };

    render(<BottomTabBar boardConfigs={boardConfigs} />);
    fireEvent.click(screen.getByRole('button', { name: 'Climb' }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(
        expect.stringContaining('/b/my-board/35/list'),
      );
    });
  });

  it('does not include session param when no active session', async () => {
    mockPathname = '/kilter/original/12x12-square/screw_bolt/40/list';

    render(<BottomTabBar boardDetails={boardDetails} angle={40} boardConfigs={boardConfigs} />);
    fireEvent.click(screen.getByRole('button', { name: 'Climb' }));

    await waitFor(() => {
      if (mockPush.mock.calls.length > 0) {
        expect(mockPush.mock.calls[0][0]).not.toContain('session=');
      }
    });
  });
});

describe('BottomTabBar create flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/kilter/original/12x12-square/screw_bolt/40/list';
    mockActiveSession = null;
    mockPlatform = 'web';
  });

  it('opens create drawer without immediate navigation', () => {
    render(<BottomTabBar boardDetails={boardDetails} angle={40} boardConfigs={boardConfigs} />);

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByTestId('drawer-Create')).toBeTruthy();
    expect(screen.getByTestId('create-climb-option')).toBeTruthy();
    expect(screen.getByTestId('create-playlist-option')).toBeTruthy();
  });

  it('opens board selector for playlist without board context, then opens playlist drawer after board selection', () => {
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    fireEvent.click(screen.getByTestId('create-playlist-option'));

    expect(screen.getByTestId('board-selector-drawer')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Select Board' }));

    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByTestId('drawer-Create Playlist')).toBeTruthy();
  });
});
