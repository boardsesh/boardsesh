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

let mockLastUsedBoard: {
  url: string;
  boardName: string;
  layoutName: string;
  sizeName: string;
  setNames: string[];
  angle: number;
} | null = null;
vi.mock('@/app/lib/last-used-board-db', () => ({
  getLastUsedBoard: () => Promise.resolve(mockLastUsedBoard),
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

// BottomNavigationAction with component={LocaleLink} renders as `<a>` (role
// "link"); without it, the action stays a `<button>`. Tests don't care which
// — they just want the tab — so this helper looks both up.
function getTab(name: string) {
  return screen.queryByRole('link', { name }) ?? screen.getByRole('button', { name });
}

function queryTab(name: string) {
  return screen.queryByRole('link', { name }) ?? screen.queryByRole('button', { name });
}

function climbHref() {
  const climbTab = getTab('Climb');
  return climbTab.getAttribute('href') ?? '';
}

describe('BottomTabBar session preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/';
    mockActiveSession = null;
    mockSessionData = null;
    mockSessionStatus = 'unauthenticated';
    mockLanguage = 'en-US';
  });

  it('includes session param when navigating to climbs with active session on /b/ board', () => {
    mockActiveSession = {
      sessionId: 'test-session-123',
      boardPath: '/b/my-board/35/list',
      boardDetails,
      parsedParams: { angle: 35 },
    };

    render(<BottomTabBar boardConfigs={boardConfigs} />);

    expect(climbHref()).toContain('session=test-session-123');
  });

  it('uses /b/ slug URL from active session when on home page', () => {
    mockActiveSession = {
      sessionId: 'test-session-123',
      boardPath: '/b/my-board/35/list',
      boardDetails,
      parsedParams: { angle: 35 },
    };

    render(<BottomTabBar boardConfigs={boardConfigs} />);

    expect(climbHref()).toContain('/b/my-board/35/list');
  });

  it('does not include session param when no active session', () => {
    mockPathname = '/kilter/original/12x12-square/screw_bolt/40/list';

    render(<BottomTabBar boardDetails={boardDetails} angle={40} boardConfigs={boardConfigs} />);

    expect(climbHref()).not.toContain('session=');
  });
});

function createHref() {
  const createTab = getTab('Create');
  return createTab.getAttribute('href') ?? '';
}

/**
 * The Create tab leaves www: W-17 (#4433) deleted the board routes' `…/create`
 * sibling and the climb editor lives in the app. It is always a real
 * cross-origin <a>, never a drawer trigger — the board in scope rides along as
 * query params the app's create screen reads, and with no board it hands over
 * bare so the app opens on the reader's active board.
 */
describe('BottomTabBar create flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/kilter/original/12x12-square/screw_bolt/40/list';
    mockActiveSession = null;
    mockSessionData = null;
    mockSessionStatus = 'unauthenticated';
    mockLanguage = 'en-US';
    mockLastUsedBoard = null;
  });

  it('links to the app editor with the board in scope attached', () => {
    render(<BottomTabBar boardDetails={boardDetails} angle={40} boardConfigs={boardConfigs} />);

    const href = new URL(createHref());
    expect(href.origin + href.pathname).toBe('https://app.boardsesh.com/climbs/create');
    expect(href.searchParams.get('boardName')).toBe(boardDetails.board_name);
    expect(href.searchParams.get('angle')).toBe('40');
  });

  it('never links into the deleted www create route', () => {
    render(<BottomTabBar boardDetails={boardDetails} angle={40} boardConfigs={boardConfigs} />);

    // A www `…/create` href would 307 the reader straight back off the site,
    // dropping the board on the way.
    expect(createHref().startsWith('http')).toBe(true);
    expect(createHref()).not.toMatch(/^\/[a-z]/);
  });

  it('hands over bare when no board is in scope, still as a link', () => {
    render(<BottomTabBar />);

    // No drawer, no dead button: the app opens on the reader's active board.
    expect(createHref()).toBe('https://app.boardsesh.com/climbs/create');
    expect(screen.queryByTestId('drawer-Pick a board')).toBeNull();
  });

  it('does not consult the last-used board — the app already knows it', async () => {
    mockLastUsedBoard = {
      url: '/kilter/original/12x12-square/screw_bolt/40/list',
      boardName: 'kilter',
      layoutName: 'Original',
      sizeName: '12x12',
      setNames: ['Screw Bolt'],
      angle: 40,
    };

    render(<BottomTabBar boardConfigs={boardConfigs} />);

    const createLink = await waitFor(() => screen.getByRole('link', { name: 'Create' }));
    expect(createLink.getAttribute('href')).toBe('https://app.boardsesh.com/climbs/create');
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

    expect(getTab('You')).toBeTruthy();
    expect(queryTab('Notifications')).toBeNull();
  });

  it('renders PersonOutlined icon for You tab', () => {
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    const youTab = getTab('You');
    // PersonOutlined renders as an SVG with data-testid="PersonOutlinedIcon"
    const icon = youTab.querySelector('[data-testid="PersonOutlinedIcon"]');
    expect(icon).toBeTruthy();
  });

  it('You tab is selected when on /you path', () => {
    mockPathname = '/you';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    expect(getTab('You').classList.contains('Mui-selected')).toBe(true);
  });

  it('You tab is selected when on /you/sessions path', () => {
    mockPathname = '/you/sessions';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    expect(getTab('You').classList.contains('Mui-selected')).toBe(true);
  });

  it('You tab is NOT selected when on /profile/some-id path (other user)', () => {
    mockPathname = '/profile/some-id';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    expect(getTab('You').classList.contains('Mui-selected')).toBe(false);
  });

  it('Feed tab is selected when on /feed path', () => {
    mockPathname = '/feed';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    expect(getTab('Feed').classList.contains('Mui-selected')).toBe(true);
    expect(getTab('You').classList.contains('Mui-selected')).toBe(false);
  });

  it('Home tab is selected when on / path', () => {
    mockPathname = '/';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    expect(getTab('Home').classList.contains('Mui-selected')).toBe(true);
    expect(getTab('You').classList.contains('Mui-selected')).toBe(false);
  });

  it('renders a link to /you when authenticated (Next.js handles navigation)', () => {
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    expect(getTab('You').getAttribute('href')).toBe('/you');
  });

  it('opens auth modal and prevents navigation when You tab is clicked and not authenticated', () => {
    mockSessionData = null;
    mockSessionStatus = 'unauthenticated';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    fireEvent.click(getTab('You'));

    expect(mockOpenAuthModal).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Sign in to see your progress',
      }),
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('does NOT open the auth modal while session is still loading', () => {
    // Session-loading window: NextAuth hasn't resolved yet. An already
    // signed-in user tapping You here would see a spurious modal if we
    // short-circuited on !isAuthenticated. The /you layout handles the
    // real auth check server-side, so we let Link navigate.
    mockSessionData = null;
    mockSessionStatus = 'loading';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    fireEvent.click(getTab('You'));

    expect(mockOpenAuthModal).not.toHaveBeenCalled();
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

    expect(getTab('Feed').classList.contains('Mui-selected')).toBe(true);
  });

  it('You tab is selected when on /es/you', () => {
    mockPathname = '/es/you';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    expect(getTab('You').classList.contains('Mui-selected')).toBe(true);
  });

  it('Home tab is selected when on /es', () => {
    mockPathname = '/es';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    expect(getTab('Home').classList.contains('Mui-selected')).toBe(true);
  });

  it('Discover tab is selected when on /es/playlists', () => {
    mockPathname = '/es/playlists';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    expect(getTab('Discover').classList.contains('Mui-selected')).toBe(true);
  });

  it('Discover tab is selected on smart-playlist /discover/<slug>/<user-id> route', () => {
    mockPathname = '/discover/five-stars/user-123';
    render(<BottomTabBar boardConfigs={boardConfigs} />);

    expect(getTab('Discover').classList.contains('Mui-selected')).toBe(true);
    expect(getTab('Climb').classList.contains('Mui-selected')).toBe(false);
  });
});

/**
 * Kilter layout 1 carries two "12 x 12" squares — id 10 ("with kickboard") and
 * id 27 ("without kickboard") — that both name-slug to `12x12-square`. The tab
 * bar holds the numeric ids on `boardDetails`, so the Climb and Create tabs can
 * and must address the exact one rather than whichever owns the bare slug.
 */
describe('BottomTabBar shadowed size slugs', () => {
  const squareBoard = {
    ...boardDetails,
    layout_id: 1,
    set_ids: [1, 20],
    layout_name: 'Kilter Board Original',
    size_description: 'Square',
    set_names: ['Bolt Ons', 'Screw Ons'],
  };
  const squareWithoutKickboard = {
    ...squareBoard,
    size_id: 27,
    size_name: '12 x 12 without kickboard',
  } as BoardDetails;
  const squareWithKickboard = {
    ...squareBoard,
    size_id: 10,
    size_name: '12 x 12 with kickboard',
  } as BoardDetails;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/kilter/1/27/1,20/40/list';
    mockActiveSession = null;
    mockSessionData = null;
    mockSessionStatus = 'unauthenticated';
    mockLanguage = 'en-US';
    mockLastUsedBoard = null;
  });

  it('emits the qualified size slug on the Climb tab for the shadowed size', () => {
    render(<BottomTabBar boardDetails={squareWithoutKickboard} angle={40} boardConfigs={boardConfigs} />);

    expect(climbHref()).toBe('/kilter/original/12x12-square-without-kickboard/screw_bolt/40/list');
    // The Create tab can't be ambiguous at all — it sends the numeric size id.
    expect(new URL(createHref()).searchParams.get('sizeId')).toBe('27');
  });

  it('leaves the size that owns the bare slug on it', () => {
    render(<BottomTabBar boardDetails={squareWithKickboard} angle={40} boardConfigs={boardConfigs} />);

    expect(climbHref()).toBe('/kilter/original/12x12-square/screw_bolt/40/list');
    expect(new URL(createHref()).searchParams.get('sizeId')).toBe('10');
  });

  it('falls back to the name-based list URL for a board the static tables do not carry', () => {
    const dbOnlyBoard = {
      ...boardDetails,
      layout_id: 9999,
      size_id: 9999,
      set_ids: [9999],
      layout_name: 'Kilter Board Homewall',
      size_name: '8 x 12',
      size_description: 'Home',
      set_names: ['Mainline'],
    } as BoardDetails;

    render(<BottomTabBar boardDetails={dbOnlyBoard} angle={40} boardConfigs={boardConfigs} />);

    expect(climbHref()).toBe('/kilter/homewall/8x12-home/main/40/list');
    // No name lookup on the Create tab — the ids go over as they are.
    expect(new URL(createHref()).searchParams.get('layoutId')).toBe('9999');
  });
});
