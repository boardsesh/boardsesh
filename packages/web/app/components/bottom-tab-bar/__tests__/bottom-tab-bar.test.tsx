import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import type { BoardDetails } from '@/app/lib/types';
import type { BoardConfigData } from '@/app/lib/server-board-configs';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import BottomTabBar from '../bottom-tab-bar';

const mockPush = vi.fn();
const mockShowMessage = vi.fn();

let mockPathname = '/kilter/original/12x12-square/screw_bolt/40/list';
let mockLanguage = 'en-US';
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

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string | readonly string[]) => ({
    i18n: { language: mockLanguage },
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
  }),
}));

vi.mock('@/app/lib/analytics', () => ({
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
  }) =>
    open ? (
      <div data-testid={`drawer-${title}`}>
        {children}
        {extra}
      </div>
    ) : null,
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
  }) =>
    open ? (
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
    ) : null,
}));

let mockSessionData: { user: { id: string } } | null = null;
let mockSessionStatus = 'unauthenticated';
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockSessionData, status: mockSessionStatus }),
}));

vi.mock('@/app/components/board-scroll/board-discovery-scroll', () => ({
  default: ({
    onBoardClick,
  }: {
    onBoardClick?: (board: {
      uuid: string;
      slug: string;
      angle: number;
      name: string;
      boardType: string;
      layoutId: number;
      sizeId: number;
      setIds: string;
      createdAt: string;
    }) => void;
  }) => (
    <div data-testid="board-discovery-scroll">
      <button
        type="button"
        onClick={() =>
          onBoardClick?.({
            uuid: 'b1',
            slug: 'kilter-original',
            angle: 40,
            name: 'Kilter',
            boardType: 'kilter',
            layoutId: 1,
            sizeId: 1,
            setIds: '1',
            createdAt: '2026-01-01T00:00:00.000Z',
          })
        }
      >
        Select Board
      </button>
    </div>
  ),
}));

const mockOpenAuthModal = vi.fn();
vi.mock('@/app/components/providers/auth-modal-provider', () => ({
  useAuthModal: () => ({ openAuthModal: mockOpenAuthModal }),
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
  usePersistentSessionState: () => ({
    activeSession: mockActiveSession,
    localBoardDetails: null,
    localCurrentClimbQueueItem: null,
  }),
  usePersistentSessionActions: () => ({}),
}));

vi.mock('@/app/lib/last-used-board-db', () => ({
  getLastUsedBoard: () => Promise.resolve(null),
}));

vi.mock('@/app/components/search-drawer/recent-searches-storage', () => ({
  getRecentSearches: () => Promise.resolve([]),
}));

vi.mock('@/app/components/board-lock/use-board-switch-guard', () => ({
  useBoardSwitchGuard: () => vi.fn((_: unknown, cb: () => void) => cb()),
}));

vi.mock('@/app/lib/board-config-for-playlist', () => ({
  getDefaultAngleForBoard: () => 40,
}));

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

describe('BottomTabBar session preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/';
    mockActiveSession = null;
    mockSessionData = null;
    mockSessionStatus = 'unauthenticated';
    mockLanguage = 'en-US';
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
      expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('session=test-session-123'));
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
      expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('/b/my-board/35/list'));
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
    mockSessionData = null;
    mockSessionStatus = 'unauthenticated';
    mockLanguage = 'en-US';
  });

  it('navigates directly to create climb URL when board details are available', () => {
    render(<BottomTabBar boardDetails={boardDetails} angle={40} boardConfigs={boardConfigs} />);

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('/create'));
  });

  it('opens board selector when no board context, then navigates to create after board selection', () => {
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(screen.getByTestId('drawer-Pick a board')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Select Board' }));

    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('/create'));
  });

  it('routes to /create (not /list) when board is selected via isCreateClimbFlow', () => {
    // createClimbUrl is null (no boardDetails/angle); boardConfigs is set so the board selector opens
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByTestId('drawer-Pick a board')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Select Board' }));

    // Should navigate to the create path, not the list path the mock returns
    const pushedUrl = mockPush.mock.calls[0][0] as string;
    expect(pushedUrl).toContain('/create');
    expect(pushedUrl).not.toContain('/list');
  });

  it('does nothing when createClimbUrl is null and boardConfigs is not provided', () => {
    // No boardDetails, no boardConfigs — Create tab should not navigate or open any drawer
    render(<BottomTabBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.queryByTestId('drawer-Pick a board')).toBeNull();
  });
});

describe('BottomTabBar You tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/';
    mockActiveSession = null;
    mockSessionData = { user: { id: 'user-1' } };
    mockSessionStatus = 'authenticated';
  });

  it('renders "You" tab label instead of "Notifications"', () => {
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    expect(screen.getByRole('button', { name: 'You' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Notifications' })).toBeNull();
  });

  it('renders PersonOutlined icon for You tab', () => {
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    const youTab = screen.getByRole('button', { name: 'You' });
    // PersonOutlined renders as an SVG with data-testid="PersonOutlinedIcon"
    const icon = youTab.querySelector('[data-testid="PersonOutlinedIcon"]');
    expect(icon).toBeTruthy();
  });

  it('You tab is selected when on /you path', () => {
    mockPathname = '/you';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    const youTab = screen.getByRole('button', { name: 'You' });
    expect(youTab.classList.contains('Mui-selected')).toBe(true);
  });

  it('You tab is selected when on /you/sessions path', () => {
    mockPathname = '/you/sessions';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    const youTab = screen.getByRole('button', { name: 'You' });
    expect(youTab.classList.contains('Mui-selected')).toBe(true);
  });

  it('You tab is NOT selected when on /profile/some-id path (other user)', () => {
    mockPathname = '/profile/some-id';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    const youTab = screen.getByRole('button', { name: 'You' });
    expect(youTab.classList.contains('Mui-selected')).toBe(false);
  });

  it('Feed tab is selected when on /feed path', () => {
    mockPathname = '/feed';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    const feedTab = screen.getByRole('button', { name: 'Feed' });
    expect(feedTab.classList.contains('Mui-selected')).toBe(true);

    const youTab = screen.getByRole('button', { name: 'You' });
    expect(youTab.classList.contains('Mui-selected')).toBe(false);
  });

  it('Home tab is selected when on / path', () => {
    mockPathname = '/';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    const homeTab = screen.getByRole('button', { name: 'Home' });
    expect(homeTab.classList.contains('Mui-selected')).toBe(true);

    const youTab = screen.getByRole('button', { name: 'You' });
    expect(youTab.classList.contains('Mui-selected')).toBe(false);
  });

  it('navigates to /you when You tab is clicked (authenticated)', () => {
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    fireEvent.click(screen.getByRole('button', { name: 'You' }));

    expect(mockPush).toHaveBeenCalledWith('/you');
  });

  it('opens auth modal when You tab is clicked and not authenticated', () => {
    mockSessionData = null;
    mockSessionStatus = 'unauthenticated';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    fireEvent.click(screen.getByRole('button', { name: 'You' }));

    expect(mockOpenAuthModal).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Sign in to see your progress',
      }),
    );
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe('BottomTabBar locale-aware pathname matching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveSession = null;
    mockSessionData = { user: { id: 'user-1' } };
    mockSessionStatus = 'authenticated';
    mockLanguage = 'es';
  });

  it('Feed tab is selected when on /es/feed', () => {
    mockPathname = '/es/feed';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    const feedTab = screen.getByRole('button', { name: 'Feed' });
    expect(feedTab.classList.contains('Mui-selected')).toBe(true);
  });

  it('You tab is selected when on /es/you', () => {
    mockPathname = '/es/you';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    const youTab = screen.getByRole('button', { name: 'You' });
    expect(youTab.classList.contains('Mui-selected')).toBe(true);
  });

  it('Home tab is selected when on /es', () => {
    mockPathname = '/es';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    const homeTab = screen.getByRole('button', { name: 'Home' });
    expect(homeTab.classList.contains('Mui-selected')).toBe(true);
  });

  it('Discover tab is selected when on /es/playlists', () => {
    mockPathname = '/es/playlists';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    const libraryTab = screen.getByRole('button', { name: 'Discover' });
    expect(libraryTab.classList.contains('Mui-selected')).toBe(true);
  });

  it('Discover tab is selected on smart-playlist /discover/<slug>/<user-id> route', () => {
    mockPathname = '/discover/five-stars/user-123';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    const libraryTab = screen.getByRole('button', { name: 'Discover' });
    expect(libraryTab.classList.contains('Mui-selected')).toBe(true);
    const climbsTab = screen.getByRole('button', { name: 'Climb' });
    expect(climbsTab.classList.contains('Mui-selected')).toBe(false);
  });
});
