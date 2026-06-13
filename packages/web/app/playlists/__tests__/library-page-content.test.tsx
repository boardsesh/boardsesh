import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render as rtlRender, screen, fireEvent, waitFor, type RenderOptions } from '@testing-library/react';
import React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { PlaylistsAdapterTestProvider } from '@/app/test-utils/playlists-adapter-wrapper';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import LibraryPageContent from '../library-page-content';
import type { UserBoard, PopularBoardConfig } from '@boardsesh/shared-schema';
import type { BoardConfigData } from '@/app/lib/server-board-configs';
import type { StoredBoardConfig } from '@/app/lib/saved-boards-db';

function render(ui: React.ReactElement, options?: RenderOptions) {
  const queryClient = createTestQueryClient();
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <PlaylistsAdapterTestProvider>{children}</PlaylistsAdapterTestProvider>
      </QueryClientProvider>
    ),
    ...options,
  });
}

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const mockSession: { data: { user?: { id: string } } | null; status: 'authenticated' | 'unauthenticated' } = {
  data: { user: { id: 'user-1' } },
  status: 'authenticated',
};
vi.mock('next-auth/react', () => ({
  useSession: () => mockSession,
}));

const mockShowMessage = vi.fn();
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

vi.mock('@/app/components/providers/auth-modal-provider', () => ({
  useAuthModal: () => ({ openAuthModal: vi.fn() }),
}));

const mockRouterPush = vi.fn();
vi.mock('@/app/lib/i18n/use-locale-router', () => ({
  useLocaleRouter: () => ({ push: mockRouterPush }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'test-token', isAuthenticated: true, isLoading: false }),
}));

vi.mock('@/app/hooks/use-my-boards', () => ({
  useMyBoards: (_enabled: boolean, _limit?: number, initial?: UserBoard[] | null) => ({
    boards: initial ?? [],
    isLoading: false,
  }),
}));

vi.mock('@/app/components/queue-control/queue-bridge-context', () => ({
  useQueueBridgeBoardInfo: () => ({ boardDetails: null, hasActiveQueue: false }),
}));

const mockExecuteGraphQL = vi.fn();
const mockGraphQLRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  executeGraphQL: (...args: unknown[]) => mockExecuteGraphQL(...args),
  // useUserPlaylists / usePinnedPlaylists call .request on this client; the
  // tests only care about FAB orchestration, so an empty resolved value is
  // sufficient and shared across both hooks.
  createGraphQLHttpClient: () => ({ request: (...args: unknown[]) => mockGraphQLRequest(...args) }),
}));

// CSS module proxy
vi.mock('@/app/components/library/library.module.css', () => ({
  default: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

// Stub heavy presentational children — keep them inert.
vi.mock('@/app/components/library/playlist-card-grid', () => ({ default: () => null }));
vi.mock('@/app/components/library/playlist-scroll-section', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/app/components/library/playlist-card', () => ({ default: () => null }));

// BoardFilterStrip — exposes a way to drive selectedBoard from the test.
vi.mock('@/app/components/board-scroll/board-filter-strip', () => ({
  default: (props: { onBoardSelect: (board: UserBoard | null) => void; boards: UserBoard[] }) => (
    <div data-testid="filter-strip">
      <button data-testid="filter-clear" onClick={() => props.onBoardSelect(null)}>
        clear
      </button>
      {props.boards.map((board) => (
        <button key={board.uuid} data-testid={`filter-pick-${board.uuid}`} onClick={() => props.onBoardSelect(board)}>
          pick {board.name}
        </button>
      ))}
    </div>
  ),
}));

// BoardDiscoveryScroll — exposes board / config / custom click hooks for the picker drawer.
vi.mock('@/app/components/board-scroll/board-discovery-scroll', () => ({
  default: (props: {
    onBoardClick: (board: UserBoard) => void;
    onConfigClick: (config: PopularBoardConfig) => void;
    onCustomClick: () => void;
    myBoards?: UserBoard[];
  }) => (
    <div data-testid="board-discovery">
      <button data-testid="discovery-pick-board" onClick={() => props.onBoardClick(makeBoard('discovery-board'))}>
        pick board
      </button>
      <button data-testid="discovery-pick-config" onClick={() => props.onConfigClick(makeConfig())}>
        pick config
      </button>
      <button data-testid="discovery-pick-custom" onClick={props.onCustomClick}>
        pick custom
      </button>
    </div>
  ),
}));

// BoardSelectorDrawer — exposes onBoardSelected for the custom path.
// Fires onTransitionEnd(false) synchronously when closed so the orchestrator's
// pending-drawer chain fulfils within the test, mirroring real animation.
vi.mock('@/app/components/board-selector-drawer/board-selector-drawer', () => ({
  default: (props: {
    open: boolean;
    onBoardSelected?: (url: string, config?: StoredBoardConfig) => void;
    onTransitionEnd?: (open: boolean) => void;
  }) => {
    React.useEffect(() => {
      if (!props.open) props.onTransitionEnd?.(false);
    }, [props.open]);
    if (!props.open) return null;
    return (
      <div data-testid="custom-board-drawer">
        <button
          data-testid="custom-pick-with-config"
          onClick={() => props.onBoardSelected?.('/some/url', makeStoredConfig())}
        >
          pick with config
        </button>
        <button data-testid="custom-pick-no-config" onClick={() => props.onBoardSelected?.('/some/url')}>
          pick without config
        </button>
      </div>
    );
  },
}));

// SwipeableDrawer — passthrough that respects `open` and fires onTransitionEnd
// on close so the deferred-open pattern can resolve in tests.
vi.mock('@/app/components/swipeable-drawer/swipeable-drawer', () => ({
  default: (props: {
    open?: boolean;
    children?: React.ReactNode;
    extra?: React.ReactNode;
    title?: React.ReactNode;
    onTransitionEnd?: (open: boolean) => void;
  }) => {
    React.useEffect(() => {
      if (!props.open) props.onTransitionEnd?.(false);
    }, [props.open]);
    if (!props.open) return null;
    return (
      <div data-testid="swipeable-drawer">
        <div>{props.title}</div>
        {props.children}
        {props.extra}
      </div>
    );
  },
}));

// CreatePlaylistDrawer — capture mounted props and expose a button to fire onCreated.
const mockCreatePlaylistDrawer = vi.fn();
vi.mock('@/app/components/library/create-playlist-drawer', () => ({
  default: (props: {
    open: boolean;
    boardName: string;
    layoutId: number;
    source: string;
    onCreated?: (playlist: { uuid: string }) => void;
  }) => {
    mockCreatePlaylistDrawer(props);
    if (!props.open) return null;
    return (
      <div data-testid="create-drawer">
        <span data-testid="create-source">{props.source}</span>
        <span data-testid="create-board">{props.boardName}</span>
        <span data-testid="create-layout">{String(props.layoutId)}</span>
        <button
          data-testid="create-fire-success"
          onClick={() => props.onCreated?.({ uuid: 'new-playlist-uuid' } as never)}
        >
          fire onCreated
        </button>
      </div>
    );
  },
}));

function makeBoard(uuid: string, overrides?: Partial<UserBoard>): UserBoard {
  return {
    id: 1,
    uuid,
    slug: `slug-${uuid}`,
    ownerId: 'owner',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 7,
    setIds: '1,20',
    name: `Board ${uuid}`,
    isPublic: true,
    isUnlisted: false,
    hideLocation: false,
    isOwned: true,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2026-01-01T00:00:00Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    ...overrides,
  } as UserBoard;
}

function makeConfig(): PopularBoardConfig {
  return {
    boardType: 'tension',
    layoutId: 10,
    sizeId: 7,
    setIds: [1, 2],
    setNames: ['main'],
    climbCount: 0,
    totalAscents: 0,
    boardCount: 0,
    displayName: 'Tension',
  } as PopularBoardConfig;
}

function makeStoredConfig(): StoredBoardConfig {
  return {
    name: 'Custom',
    board: 'kilter',
    layoutId: 42,
    sizeId: 7,
    setIds: [1],
    angle: 40,
    createdAt: '2026-01-01T00:00:00Z',
  } as StoredBoardConfig;
}

const fakeBoardConfigs = { configsByBoard: {} } as unknown as BoardConfigData;

function clickFab() {
  fireEvent.click(screen.getByLabelText(tFromCatalog('playlists', 'library.createFab.ariaLabel')));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteGraphQL.mockResolvedValue({
    allUserPlaylists: { playlists: [], totalCount: 0, hasMore: false },
    discoverPlaylists: { playlists: [] },
    myPinnedPlaylists: [],
  });
  // Hooks use createGraphQLHttpClient(...).request; reuse the same shape so
  // useUserPlaylists / usePinnedPlaylists initialise to empty without errors.
  mockGraphQLRequest.mockResolvedValue({
    allUserPlaylists: { playlists: [], totalCount: 0, hasMore: false },
    myPinnedPlaylists: [],
  });
  mockSession.data = { user: { id: 'user-1' } };
  mockSession.status = 'authenticated';
});

describe('LibraryPageContent FAB orchestration', () => {
  it('opens the create drawer directly when a board filter is selected', async () => {
    const board = makeBoard('uuid-a', { boardType: 'kilter', layoutId: 1 });
    render(
      <LibraryPageContent
        initialMyBoards={[board]}
        initialPlaylists={{ playlists: [], totalCount: 0, hasMore: false }}
        initialDiscoverPlaylists={{ popular: [], recent: [], popularHasMore: false, recentHasMore: false }}
        boardConfigs={fakeBoardConfigs}
        boardSlug={board.slug}
      />,
    );

    clickFab();

    await waitFor(() => expect(screen.getByTestId('create-drawer')).toBeDefined());
    expect(screen.getByTestId('create-source').textContent).toBe('discover-fab');
    expect(screen.getByTestId('create-board').textContent).toBe('kilter');
    expect(screen.getByTestId('create-layout').textContent).toBe('1');
    // No board picker should have opened.
    expect(screen.queryByTestId('board-discovery')).toBeNull();
  });

  it('routes through the board picker when no filter board is selected', async () => {
    render(
      <LibraryPageContent
        initialMyBoards={[]}
        initialPlaylists={{ playlists: [], totalCount: 0, hasMore: false }}
        initialDiscoverPlaylists={{ popular: [], recent: [], popularHasMore: false, recentHasMore: false }}
        boardConfigs={fakeBoardConfigs}
      />,
    );

    clickFab();

    await waitFor(() => expect(screen.getByTestId('board-discovery')).toBeDefined());
    fireEvent.click(screen.getByTestId('discovery-pick-board'));

    await waitFor(() => expect(screen.getByTestId('create-drawer')).toBeDefined());
    expect(screen.getByTestId('create-board').textContent).toBe('kilter');
    expect(screen.getByTestId('create-layout').textContent).toBe('1');
  });

  it('opens the custom-board drawer from the picker, then the create drawer', async () => {
    render(
      <LibraryPageContent
        initialMyBoards={[]}
        initialPlaylists={{ playlists: [], totalCount: 0, hasMore: false }}
        initialDiscoverPlaylists={{ popular: [], recent: [], popularHasMore: false, recentHasMore: false }}
        boardConfigs={fakeBoardConfigs}
      />,
    );

    clickFab();
    await waitFor(() => expect(screen.getByTestId('board-discovery')).toBeDefined());
    fireEvent.click(screen.getByTestId('discovery-pick-custom'));

    await waitFor(() => expect(screen.getByTestId('custom-board-drawer')).toBeDefined());
    fireEvent.click(screen.getByTestId('custom-pick-with-config'));

    await waitFor(() => expect(screen.getByTestId('create-drawer')).toBeDefined());
    expect(screen.getByTestId('create-board').textContent).toBe('kilter');
    expect(screen.getByTestId('create-layout').textContent).toBe('42');
  });

  it('shows an error when the custom-board drawer returns no usable config', async () => {
    render(
      <LibraryPageContent
        initialMyBoards={[]}
        initialPlaylists={{ playlists: [], totalCount: 0, hasMore: false }}
        initialDiscoverPlaylists={{ popular: [], recent: [], popularHasMore: false, recentHasMore: false }}
        boardConfigs={fakeBoardConfigs}
      />,
    );

    clickFab();
    await waitFor(() => screen.getByTestId('board-discovery'));
    fireEvent.click(screen.getByTestId('discovery-pick-custom'));
    await waitFor(() => screen.getByTestId('custom-board-drawer'));
    fireEvent.click(screen.getByTestId('custom-pick-no-config'));

    await waitFor(() => {
      expect(mockShowMessage).toHaveBeenCalledWith(
        tFromCatalog('playlists', 'bottomTabBar.selectBoardForPlaylist'),
        'error',
      );
    });
    // Should NOT have opened the create drawer.
    expect(screen.queryByTestId('create-drawer')).toBeNull();
  });

  it('shows an error when the custom path is taken without boardConfigs', async () => {
    render(
      <LibraryPageContent
        initialMyBoards={[]}
        initialPlaylists={{ playlists: [], totalCount: 0, hasMore: false }}
        initialDiscoverPlaylists={{ popular: [], recent: [], popularHasMore: false, recentHasMore: false }}
      />,
    );

    clickFab();
    await waitFor(() => screen.getByTestId('board-discovery'));
    fireEvent.click(screen.getByTestId('discovery-pick-custom'));

    await waitFor(() => {
      expect(mockShowMessage).toHaveBeenCalledWith(tFromCatalog('playlists', 'library.customUnavailable'), 'error');
    });
    expect(screen.queryByTestId('custom-board-drawer')).toBeNull();
    expect(screen.queryByTestId('create-drawer')).toBeNull();
  });

  it('forwards createSource into the drawer for non-default routes', async () => {
    const board = makeBoard('uuid-x');
    render(
      <LibraryPageContent
        initialMyBoards={[board]}
        initialPlaylists={{ playlists: [], totalCount: 0, hasMore: false }}
        initialDiscoverPlaylists={{ popular: [], recent: [], popularHasMore: false, recentHasMore: false }}
        boardConfigs={fakeBoardConfigs}
        boardSlug={board.slug}
        createSource="board-slug-playlists-fab"
      />,
    );

    clickFab();
    await waitFor(() => expect(screen.getByTestId('create-drawer')).toBeDefined());
    expect(screen.getByTestId('create-source').textContent).toBe('board-slug-playlists-fab');
  });

  it('navigates to the new playlist when onCreated fires', async () => {
    const board = makeBoard('uuid-nav');
    render(
      <LibraryPageContent
        initialMyBoards={[board]}
        initialPlaylists={{ playlists: [], totalCount: 0, hasMore: false }}
        initialDiscoverPlaylists={{ popular: [], recent: [], popularHasMore: false, recentHasMore: false }}
        boardConfigs={fakeBoardConfigs}
        boardSlug={board.slug}
      />,
    );

    clickFab();
    await waitFor(() => screen.getByTestId('create-drawer'));
    fireEvent.click(screen.getByTestId('create-fire-success'));

    expect(mockRouterPush).toHaveBeenCalledWith('/playlists/new-playlist-uuid');
  });

  it('falls back to a fresh slug lookup if selectedBoard has not synced yet', async () => {
    // Simulate the first-paint race: filter strip's internal state hasn't
    // resolved selectedBoard yet (initialMyBoards lacks the slug match), but
    // myBoards has just loaded with the matching board.
    const board = makeBoard('synced-board', { slug: 'kilter-route', boardType: 'kilter', layoutId: 99 });
    render(
      <LibraryPageContent
        initialMyBoards={[board]}
        initialPlaylists={{ playlists: [], totalCount: 0, hasMore: false }}
        initialDiscoverPlaylists={{ popular: [], recent: [], popularHasMore: false, recentHasMore: false }}
        boardConfigs={fakeBoardConfigs}
        boardSlug="kilter-route"
      />,
    );

    clickFab();
    await waitFor(() => expect(screen.getByTestId('create-drawer')).toBeDefined());
    // The picker should never have opened — we resolved board context directly.
    expect(screen.queryByTestId('board-discovery')).toBeNull();
    expect(screen.getByTestId('create-layout').textContent).toBe('99');
  });

  it('opens the create drawer only after the board picker finishes closing', async () => {
    render(
      <LibraryPageContent
        initialMyBoards={[]}
        initialPlaylists={{ playlists: [], totalCount: 0, hasMore: false }}
        initialDiscoverPlaylists={{ popular: [], recent: [], popularHasMore: false, recentHasMore: false }}
        boardConfigs={fakeBoardConfigs}
      />,
    );

    clickFab();
    await waitFor(() => expect(screen.getByTestId('board-discovery')).toBeDefined());
    fireEvent.click(screen.getByTestId('discovery-pick-board'));

    // After the click the picker has been told to close; the create drawer
    // should appear once the picker's onTransitionEnd fires (fired by the
    // mock SwipeableDrawer's useEffect on open=false).
    await waitFor(() => expect(screen.getByTestId('create-drawer')).toBeDefined());
    expect(screen.queryByTestId('board-discovery')).toBeNull();
  });

  it('does not render the FAB for unauthenticated users', () => {
    mockSession.data = null;
    mockSession.status = 'unauthenticated';
    render(
      <LibraryPageContent
        initialMyBoards={null}
        initialPlaylists={null}
        initialDiscoverPlaylists={{ popular: [], recent: [], popularHasMore: false, recentHasMore: false }}
        boardConfigs={fakeBoardConfigs}
      />,
    );
    expect(screen.queryByLabelText(tFromCatalog('playlists', 'library.createFab.ariaLabel'))).toBeNull();
  });
});
