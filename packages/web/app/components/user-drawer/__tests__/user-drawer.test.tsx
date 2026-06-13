import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import type { UserBoard, PopularBoardConfig } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import UserDrawer from '../user-drawer';

// -------------------------------------------------------------------------
// vi.fn() instances — must be declared before vi.mock() so their references
// are captured by the factory closures (Vitest hoists vi.mock calls).
// -------------------------------------------------------------------------
const mockPush = vi.fn();
const mockGuardBoardSwitch = vi.fn();
const mockConstructBoardSlugListUrl = vi.fn();
const mockConstructClimbListWithSlugs = vi.fn();
const mockTryConstructSlugListUrl = vi.fn();
let mockSessionData: {
  user: { id: string; name?: string | null; email?: string | null; image?: string | null };
} | null = null;

// Callbacks captured by the BoardDiscoveryScroll stub on each render
const captured = {
  onBoardClick: null as ((board: UserBoard) => void) | null,
  onConfigClick: null as ((config: PopularBoardConfig) => void) | null,
};

// -------------------------------------------------------------------------
// Module mocks
// -------------------------------------------------------------------------
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockSessionData }),
  signOut: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/test',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string | readonly string[]) => ({
    i18n: { language: 'en-US', changeLanguage: vi.fn() },
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
  }),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
    onClick,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
    onClick?: () => void;
  }) => React.createElement('a', { href, className, onClick, 'data-next-link': 'true' }, children),
}));

vi.mock('@/app/hooks/use-color-mode', () => ({
  useColorMode: () => ({ mode: 'light', toggleMode: vi.fn() }),
}));

vi.mock('@/app/components/providers/auth-modal-provider', () => ({
  useAuthModal: () => ({ openAuthModal: vi.fn() }),
}));

vi.mock('@/app/hooks/use-unread-notification-count', () => ({
  useUnreadNotificationCount: () => 0,
}));

vi.mock('@/app/components/board-lock/use-board-switch-guard', () => ({
  useBoardSwitchGuard: () => mockGuardBoardSwitch,
}));

vi.mock('@/app/lib/session-history-db', () => ({
  getRecentSessions: () => Promise.resolve([]),
  formatRelativeTime: () => 'just now',
  extractBoardName: (path: string) => path.split('/')[1] ?? '',
}));

vi.mock('@/app/lib/board-config-for-playlist', () => ({
  getDefaultAngleForBoard: () => 40,
}));

vi.mock('@/app/lib/url-utils', () => ({
  getPlaylistsBasePath: () => '/playlists',
  constructBoardSlugListUrl: (...args: unknown[]) => mockConstructBoardSlugListUrl(...args),
  constructClimbListWithSlugs: (...args: unknown[]) => mockConstructClimbListWithSlugs(...args),
  tryConstructSlugListUrl: (...args: unknown[]) => mockTryConstructSlugListUrl(...args),
}));

vi.mock('@/app/components/swipeable-drawer/swipeable-drawer', () => ({
  default: ({ children, open }: { children?: React.ReactNode; open: boolean; [key: string]: unknown }) =>
    open ? React.createElement('div', { 'data-testid': 'swipeable-drawer' }, children) : null,
}));

vi.mock('@/app/components/hold-classification', () => ({
  HoldClassificationWizard: () => null,
}));

vi.mock('@/app/components/board-scroll/board-discovery-scroll', () => ({
  default: (props: {
    onBoardClick: (board: UserBoard) => void;
    onConfigClick: (config: PopularBoardConfig) => void;
    onCustomClick: () => void;
  }) => {
    // Capture the handlers so tests can invoke them directly
    captured.onBoardClick = props.onBoardClick;
    captured.onConfigClick = props.onConfigClick;
    return React.createElement('div', { 'data-testid': 'board-discovery-scroll' });
  },
}));

vi.mock('@/app/components/board-selector-drawer/board-selector-drawer', () => ({
  default: () => null,
}));

vi.mock('@/app/components/my-boards-drawer/my-boards-drawer', () => ({
  default: () => null,
}));

// Import after all vi.mock() declarations

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * Renders UserDrawer, opens the main user menu drawer, then clicks
 * "Change Board" to reveal the board selector with BoardDiscoveryScroll.
 * After this call, captured.onBoardClick and captured.onConfigClick are set.
 */
async function openBoardSelector() {
  render(<UserDrawer />);
  // Wrap in async act so the getRecentSessions promise resolves without warnings
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /user menu/i }));
  });
  fireEvent.click(screen.getByText('Change board'));
  expect(screen.getByTestId('board-discovery-scroll')).toBeTruthy();
  // Verify the mock captured the callbacks — a null here would otherwise surface
  // as a confusing "TypeError: null is not a function" inside individual tests.
  expect(captured.onBoardClick, 'onBoardClick not captured by BoardDiscoveryScroll mock').not.toBeNull();
  expect(captured.onConfigClick, 'onConfigClick not captured by BoardDiscoveryScroll mock').not.toBeNull();
}

function makeUserBoard(overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    uuid: 'board-uuid-1',
    slug: 'kilter-standard-full',
    ownerId: 'user-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 2,
    setIds: '1,2,3',
    angle: 40,
    name: 'Test Board',
    isPublic: true,
    isUnlisted: false,
    hideLocation: false,
    isOwned: true,
    isAngleAdjustable: true,
    createdAt: '2024-01-01',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    ...overrides,
    id: overrides.id ?? 1,
  };
}

function makePopularConfig(overrides: Partial<PopularBoardConfig> = {}): PopularBoardConfig {
  return {
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 2,
    setIds: [1, 2, 3],
    layoutName: 'Original',
    sizeName: 'Full (48")',
    sizeDescription: null,
    setNames: ['Original Holds'],
    climbCount: 100,
    totalAscents: 500,
    boardCount: 10,
    displayName: 'Kilter Original Full',
    ...overrides,
  };
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------
describe('UserDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.onBoardClick = null;
    captured.onConfigClick = null;
    mockSessionData = null;
    mockConstructBoardSlugListUrl.mockImplementation((slug: string, angle: number) => `/b/${slug}/${angle}/list`);
    mockConstructClimbListWithSlugs.mockReturnValue('/slug-based-url');
    mockTryConstructSlugListUrl.mockReturnValue('/try-slug-url');
  });

  it('uses client navigation for the signed-in profile link', async () => {
    mockSessionData = {
      user: {
        id: 'user-123',
        name: 'Test User',
        email: 'test@example.com',
        image: null,
      },
    };

    render(<UserDrawer />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /user menu/i }));
    });

    const profileLinks = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href') === '/profile/user-123');
    expect(profileLinks.length).toBeGreaterThan(0);
    profileLinks.forEach((link) => {
      expect(link.getAttribute('data-next-link')).toBe('true');
    });
  });

  // -----------------------------------------------------------------------
  // handleChangeBoardClick
  // -----------------------------------------------------------------------
  describe('handleChangeBoardClick', () => {
    it('does nothing when the board has no slug', async () => {
      await openBoardSelector();

      act(() => {
        captured.onBoardClick!(makeUserBoard({ slug: '' }));
      });

      expect(mockPush).not.toHaveBeenCalled();
      expect(mockGuardBoardSwitch).not.toHaveBeenCalled();
    });

    it('navigates directly without calling the guard when boardType is unsupported', async () => {
      await openBoardSelector();

      act(() => {
        captured.onBoardClick!(makeUserBoard({ boardType: 'unsupported-board', slug: 'some-slug', angle: 40 }));
      });

      expect(mockGuardBoardSwitch).not.toHaveBeenCalled();
      expect(mockPush).toHaveBeenCalledOnce();
      expect(mockPush).toHaveBeenCalledWith('/b/some-slug/40/list');
    });

    it('calls guardBoardSwitch with a correctly shaped target for a supported board', async () => {
      await openBoardSelector();

      act(() => {
        captured.onBoardClick!(
          makeUserBoard({
            boardType: 'kilter',
            layoutId: 1,
            sizeId: 2,
            setIds: '10,20,30',
          }),
        );
      });

      expect(mockGuardBoardSwitch).toHaveBeenCalledOnce();
      const [target] = mockGuardBoardSwitch.mock.calls[0] as [
        { board_name: string; layout_id: number; size_id: number; set_ids: number[] },
        () => void,
      ];
      expect(target).toEqual({
        board_name: 'kilter',
        layout_id: 1,
        size_id: 2,
        set_ids: [10, 20, 30],
      });
      // Guard controls when navigate() fires — it should not have pushed yet
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('navigate callback pushes the slug URL and closes the board selector', async () => {
      await openBoardSelector();
      mockConstructBoardSlugListUrl.mockReturnValue('/b/kilter-standard-full/40/list');

      act(() => {
        captured.onBoardClick!(makeUserBoard({ boardType: 'kilter', slug: 'kilter-standard-full', angle: 40 }));
      });

      const [, navigate] = mockGuardBoardSwitch.mock.calls[0] as [unknown, () => void];
      act(() => navigate());

      expect(mockPush).toHaveBeenCalledWith('/b/kilter-standard-full/40/list');
      // showBoardSelector → false means SwipeableDrawer renders null → scroll gone
      expect(screen.queryByTestId('board-discovery-scroll')).toBeNull();
    });

    it('parses set_ids correctly from a comma-separated string', async () => {
      await openBoardSelector();

      act(() => {
        captured.onBoardClick!(makeUserBoard({ boardType: 'kilter', setIds: '5,10,15' }));
      });

      const [target] = mockGuardBoardSwitch.mock.calls[0] as [{ set_ids: number[] }, () => void];
      expect(target.set_ids).toEqual([5, 10, 15]);
    });

    it('produces an empty set_ids array when setIds is an empty string', async () => {
      await openBoardSelector();

      act(() => {
        captured.onBoardClick!(makeUserBoard({ boardType: 'kilter', setIds: '' }));
      });

      const [target] = mockGuardBoardSwitch.mock.calls[0] as [{ set_ids: number[] }, () => void];
      expect(target.set_ids).toEqual([]);
    });

    it('filters out non-numeric set_ids entries (NaN values are dropped)', async () => {
      await openBoardSelector();

      act(() => {
        captured.onBoardClick!(makeUserBoard({ boardType: 'kilter', setIds: 'a,b,c' }));
      });

      const [target] = mockGuardBoardSwitch.mock.calls[0] as [{ set_ids: number[] }, () => void];
      expect(target.set_ids).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // handleChangeConfigClick
  // -----------------------------------------------------------------------
  describe('handleChangeConfigClick', () => {
    it('navigates directly without calling the guard when boardType is unsupported', async () => {
      await openBoardSelector();
      // Default config has layoutName/sizeName/setNames set, so constructClimbListWithSlugs is used
      mockConstructClimbListWithSlugs.mockReturnValue('/unsupported/original/full/holds/40/list');

      act(() => {
        captured.onConfigClick!(makePopularConfig({ boardType: 'unsupported-board' }));
      });

      expect(mockGuardBoardSwitch).not.toHaveBeenCalled();
      expect(mockPush).toHaveBeenCalledOnce();
      expect(mockPush).toHaveBeenCalledWith('/unsupported/original/full/holds/40/list');
    });

    it('calls guardBoardSwitch with a correctly shaped target for a supported board', async () => {
      await openBoardSelector();

      act(() => {
        captured.onConfigClick!(makePopularConfig({ boardType: 'tension', layoutId: 3, sizeId: 4, setIds: [7, 8] }));
      });

      expect(mockGuardBoardSwitch).toHaveBeenCalledOnce();
      const [target] = mockGuardBoardSwitch.mock.calls[0] as [
        { board_name: string; layout_id: number; size_id: number; set_ids: number[] },
        () => void,
      ];
      expect(target).toEqual({
        board_name: 'tension',
        layout_id: 3,
        size_id: 4,
        set_ids: [7, 8],
      });
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('uses slug-based URL when layoutName, sizeName, and setNames are all present', async () => {
      await openBoardSelector();
      mockConstructClimbListWithSlugs.mockReturnValue('/kilter/original/full-48/original-holds/40/list');

      act(() => {
        captured.onConfigClick!(
          makePopularConfig({
            boardType: 'kilter',
            layoutName: 'Original',
            sizeName: 'Full (48")',
            setNames: ['Original Holds'],
          }),
        );
      });

      const [, navigate] = mockGuardBoardSwitch.mock.calls[0] as [unknown, () => void];
      act(() => navigate());

      expect(mockConstructClimbListWithSlugs).toHaveBeenCalledOnce();
      expect(mockTryConstructSlugListUrl).not.toHaveBeenCalled();
      expect(mockPush).toHaveBeenCalledWith('/kilter/original/full-48/original-holds/40/list');
    });

    it('falls back to tryConstructSlugListUrl when slug names are absent', async () => {
      await openBoardSelector();
      mockTryConstructSlugListUrl.mockReturnValue('/kilter/1/2/1,2,3/40/list');

      act(() => {
        captured.onConfigClick!(makePopularConfig({ layoutName: null, sizeName: null, setNames: [] }));
      });

      const [, navigate] = mockGuardBoardSwitch.mock.calls[0] as [unknown, () => void];
      act(() => navigate());

      expect(mockConstructClimbListWithSlugs).not.toHaveBeenCalled();
      expect(mockTryConstructSlugListUrl).toHaveBeenCalledOnce();
      expect(mockPush).toHaveBeenCalledWith('/kilter/1/2/1,2,3/40/list');
    });

    it('falls back to ID-based URL when tryConstructSlugListUrl returns null', async () => {
      await openBoardSelector();
      mockTryConstructSlugListUrl.mockReturnValue(null);

      act(() => {
        captured.onConfigClick!(
          makePopularConfig({
            boardType: 'kilter',
            layoutId: 1,
            sizeId: 2,
            setIds: [1, 2, 3],
            layoutName: null,
            sizeName: null,
            setNames: [],
          }),
        );
      });

      const [, navigate] = mockGuardBoardSwitch.mock.calls[0] as [unknown, () => void];
      act(() => navigate());

      // Fallback: /${boardType}/${layoutId}/${sizeId}/${setIds.join(',')}/${angle}/list
      expect(mockPush).toHaveBeenCalledWith('/kilter/1/2/1,2,3/40/list');
    });

    it('navigate callback closes the board selector', async () => {
      await openBoardSelector();

      act(() => {
        captured.onConfigClick!(makePopularConfig({ boardType: 'kilter' }));
      });

      const [, navigate] = mockGuardBoardSwitch.mock.calls[0] as [unknown, () => void];
      act(() => navigate());

      expect(screen.queryByTestId('board-discovery-scroll')).toBeNull();
    });
  });
});
