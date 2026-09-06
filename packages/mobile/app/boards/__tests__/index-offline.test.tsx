// @vitest-environment jsdom
//
// Regression cover for #3897: with no signal the board picker used to render its
// "No boards yet — create one" empty state. `myBoards` is a plain network query and
// the client runs `networkMode: 'offlineFirst'`, so offline the retryer PAUSES
// (status pending, fetchStatus paused, isError false) — the screen therefore saw an
// empty list, not an error, and told the user they had no boards while offering a
// CTA that also needs the network.
//
// The mocked hook shapes below are the real offline shapes: `useMyBoards` returns
// `{ data: undefined, isLoading: false, isError: false }`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

type Children = { children?: ReactNode };
type ButtonProps = { title: string; onPress?: () => void };
type CarouselItem = { key: string; title: string };

const routerMock = vi.hoisted(() => ({ push: vi.fn(), dismissTo: vi.fn() }));
const toastMock = vi.hoisted(() => ({ showToast: vi.fn() }));
const setActiveBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const adoptFoundBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const rememberDownloadedBoardsMock = vi.hoisted(() => vi.fn());

const state = vi.hoisted(() => ({
  isOffline: false,
  // Which side is actually down. The notice reads differently for each, so the
  // reason travels alongside `isOffline` instead of being inferred from it.
  connectivityReason: null as 'device_offline' | 'offline_mode' | 'backend_unreachable' | null,
  offlineCards: [] as unknown[],
  downloadedScopeKeys: [] as string[],
  enabledScopeKeys: [] as string[],
  // What the active board's catalog looks like on this device: the offline
  // empty state reads differently for "never asked for" vs "already queued".
  offlineCatalog: null as 'missing' | 'queued' | null,
  activeBoard: undefined as unknown,
  myBoards: {
    data: undefined as { boards: unknown[] } | undefined,
    isLoading: false,
    isError: false,
    isRefetching: false,
  },
  popular: { configs: [] as unknown[] },
}));

const board = (overrides: Partial<UserBoard> & { uuid: string; name: string }): UserBoard =>
  ({
    boardType: 'kilter',
    layoutId: 8,
    sizeId: 17,
    setIds: '20,21',
    angle: 40,
    sizeName: '12 x 12',
    isOwned: true,
    isFollowedByMe: true,
    ownerId: 'me',
    ...overrides,
  }) as unknown as UserBoard;

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: Children) => createElement('div', null, children),
  ScrollView: ({ children }: Children) => createElement('div', null, children),
  Pressable: ({ children, onPress }: Children & { onPress?: () => void }) =>
    createElement('button', { onClick: onPress, type: 'button' }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('expo-router', () => ({
  useRouter: () => routerMock,
  useLocalSearchParams: () => ({}),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) => {
      const map: Record<string, string> = {
        'mobile.emptyTitle': 'No boards yet',
        'mobile.emptySubtitle': 'Search for a board to get started',
        'mobile.errorTitle': 'Something went wrong',
        'mobile.errorRetry': 'Try again',
        'mobile.offline.pickerNotice': "No signal — here are the boards you've downloaded.",
        'mobile.offline.pickerNoticeUnreachable':
          "Can't reach your boards right now — here are the ones you've downloaded.",
        'mobile.offline.pickerNoticeOfflineMode': "Offline mode is on. Here are the boards you've downloaded.",
        'mobile.offline.pickerEmptyTitle': 'Nothing downloaded yet',
        'mobile.offline.pickerEmptyBody': 'Boards you make available offline show up here.',
        'mobile.offline.pickerQueuedNotice': "{{name}} is queued — it downloads the moment you're back online.",
        'mobile.discovery.yourBoardsTitle': 'Your boards',
        'mobile.discovery.popularTitle': 'Popular',
        'mobile.discovery.create': 'Create a board',
        // Short form, tile only — "Create board" truncates in an 84 dp tile.
        'mobile.discovery.createTile': 'Create',
        'mobile.discovery.findNearby': 'Find nearby',
        'mobile.discovery.bluetooth': 'Bluetooth',
        'mobile.discovery.findGym': 'Find a gym',
        'mobile.boardSwitchError': 'Could not switch board',
        'mobile.manage.edit': 'Edit',
        'mobile.manage.done': 'Done',
        'myBoards.title': 'Manage boards',
      };
      const template = map[key] ?? key;
      return options?.name === undefined ? template : template.replace('{{name}}', options.name);
    },
  }),
}));

vi.mock('expo-sqlite', () => ({ useSQLiteContext: () => ({}) }));

// The screen's only useQuery is ['downloadedScopeKeys'].
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: state.downloadedScopeKeys }),
}));

vi.mock('@boardsesh/offline-sync', () => ({
  getDownloadedScopeKeys: vi.fn(async () => state.downloadedScopeKeys),
  offlineBoardKeyForBoard: (input: { boardType: string; layoutId: number; sizeId: number }) =>
    `${input.boardType}:${input.layoutId}:${input.sizeId}`,
}));

vi.mock('../../../src/lib/graphql/hooks', () => ({
  useMyBoards: () => ({ ...state.myBoards, refetch: vi.fn() }),
  usePopularBoardConfigs: () => ({ data: state.popular }),
  useNearbyBoards: () => ({ data: undefined, isLoading: false }),
  useProfile: () => ({ data: { id: 'me' } }),
  useDeleteBoard: () => ({ mutateAsync: vi.fn(), isPending: false, variables: undefined }),
  useUnfollowBoard: () => ({ mutateAsync: vi.fn(), isPending: false, variables: undefined }),
}));

vi.mock('../../../src/lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: state.activeBoard }),
  useSetActiveBoard: () => setActiveBoardMock,
  useClearActiveBoard: () => vi.fn(),
}));

vi.mock('../../../src/hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: 'me', isLoading: false }),
}));

vi.mock('../../../src/lib/board-discovery/use-adopt-found-board', () => ({
  useAdoptFoundBoard: () => adoptFoundBoardMock,
}));

vi.mock('../../../src/lib/use-device-location', () => ({
  useDeviceLocation: () => ({ status: 'idle', coords: undefined, request: vi.fn() }),
}));

vi.mock('../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: true, refreshAuthState: vi.fn() }),
}));
vi.mock('../../../src/providers/toast-provider', () => ({ useToast: () => toastMock }));
vi.mock('../../../src/providers/dialog-provider', () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { primary: '#6D28D9' },
    systemColors: { tertiaryLabel: '#999' },
  }),
}));
vi.mock('../../../src/lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../src/lib/onboarding/onboarding-storage', () => ({
  setBoardRevealTipPending: vi.fn().mockResolvedValue(undefined),
}));
const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../src/hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../src/lib/connectivity/use-connectivity', () => ({
  useConnectivity: () => ({ effectiveOffline: state.isOffline, reason: state.connectivityReason }),
}));
vi.mock('../../../src/settings', () => ({
  useOfflineBoards: () => state.offlineCards,
  useSetting: () => [state.enabledScopeKeys, vi.fn()],
  forgetOfflineBoard: vi.fn(),
  offlineBoardKeyForBoard: (board: { boardType: string; layoutId: number; sizeId: number }) =>
    `${board.boardType}:${board.layoutId}:${board.sizeId}`,
}));
// Has its own render suite (src/components/offline/__tests__); the screen only
// needs to know it renders in the empty state.
vi.mock('../../../src/components/offline/OfflineCatalogCta', () => ({
  OfflineCatalogCta: ({ board }: { board: unknown }) =>
    board ? createElement('div', { 'data-testid': 'offline-catalog-cta' }) : null,
}));
const confirmAndDownloadMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../../src/offline/use-confirm-board-download', () => ({
  useConfirmBoardDownload: () => ({ confirmAndDownload: confirmAndDownloadMock, armWithoutConfirm: vi.fn() }),
}));
vi.mock('../../../src/providers/feature-flags-provider', () => ({ useOfflineDownloadsEnabled: () => true }));
vi.mock('../../../src/offline/use-downloaded-scope-keys', () => ({
  useDownloadedScopeKeys: () => ({ data: state.downloadedScopeKeys }),
}));
// The real hook reads MMKV through settings, which this suite mocks down to
// useOfflineBoards; drive the derived state directly instead.
vi.mock('../../../src/offline/use-offline-catalog-state', () => ({
  useOfflineCatalogState: () => state.offlineCatalog,
}));
vi.mock('../../../src/offline/use-remember-downloaded-boards', () => ({
  useRememberDownloadedBoards: (boards: unknown) => rememberDownloadedBoardsMock(boards),
}));

vi.mock('../../../src/theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 8: 32 },
}));
vi.mock('../../../src/theme/ios-colors', () => ({
  iosSystemColors: { systemGray: '#8e8e93', systemRed: '#f00' },
}));

vi.mock('../../../src/components/Text', () => ({
  Text: ({ children }: Children) => createElement('span', null, children),
}));
vi.mock('../../../src/components/Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));
vi.mock('../../../src/components/Button', () => ({
  Button: ({ title, onPress }: ButtonProps) => createElement('button', { onClick: onPress, type: 'button' }, title),
}));
vi.mock('../../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'spinner' }),
}));
vi.mock('../../../src/components/board-discovery/BoardCarousel', () => ({
  BoardCarousel: ({
    items,
    onSelect,
    onDownload,
    actionFor,
    onAction,
  }: {
    items: CarouselItem[];
    onSelect: (item: CarouselItem) => void;
    onDownload?: (item: CarouselItem) => void;
    actionFor?: (item: CarouselItem) => string | null;
    onAction?: (item: CarouselItem) => void;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'carousel', 'data-has-actions': onAction === undefined ? 'no' : 'yes' },
      items.map((item) =>
        createElement('span', { key: item.key }, [
          createElement('button', { key: 'select', type: 'button', onClick: () => onSelect(item) }, item.title),
          actionFor && onAction
            ? createElement(
                'button',
                { key: 'action', type: 'button', onClick: () => onAction(item) },
                `${actionFor(item) ?? 'none'} ${item.title}`,
              )
            : null,
          // Only the Your Boards carousel is handed one; the download glyph is
          // what fires the board-card accept event.
          onDownload
            ? createElement(
                'button',
                { key: 'download', type: 'button', onClick: () => onDownload(item) },
                `download ${item.title}`,
              )
            : null,
        ]),
      ),
    ),
}));
vi.mock('../../../src/components/board-discovery/BoardModeCard', () => ({
  BoardModeCard: ({ label }: { label: string }) => createElement('div', { 'data-mode-card': label }, label),
}));
vi.mock('../../../src/components/board-discovery/BluetoothQuickstartSheet', () => ({
  BluetoothQuickstartSheet: () => createElement('div', { 'data-testid': 'ble-sheet' }),
}));

const { default: BoardSelection } = await import('../index');

const downloadedBoard = board({ uuid: 'board-a', name: 'Marco garage' });

beforeEach(() => {
  vi.clearAllMocks();
  setActiveBoardMock.mockResolvedValue(undefined);
  state.isOffline = false;
  state.connectivityReason = null;
  state.offlineCards = [];
  state.downloadedScopeKeys = [];
  state.offlineCatalog = null;
  state.activeBoard = undefined;
  state.myBoards = { data: undefined, isLoading: false, isError: false, isRefetching: false };
  state.popular = { configs: [] };
});

describe('board picker with no usable network list', () => {
  it('lists the downloaded board and switches to it on tap', async () => {
    state.isOffline = true;
    state.connectivityReason = 'device_offline';
    state.offlineCards = [downloadedBoard];
    state.downloadedScopeKeys = ['kilter:8:17'];

    render(createElement(BoardSelection));

    // On today's code this row does not exist: the screen renders "No boards yet".
    const row = screen.getByRole('button', { name: 'Marco garage' });
    expect(screen.queryByText('No boards yet')).toBeNull();
    expect(screen.getByText("No signal — here are the boards you've downloaded.")).toBeTruthy();

    fireEvent.click(row);
    await waitFor(() => expect(setActiveBoardMock).toHaveBeenCalledTimes(1));
    expect(setActiveBoardMock.mock.calls[0]?.[0]).toMatchObject({ uuid: 'board-a' });
    expect(toastMock.showToast).not.toHaveBeenCalled();
  });

  it('does not fire the follow/adopt mutation while offline', async () => {
    state.isOffline = true;
    state.connectivityReason = 'device_offline';
    state.offlineCards = [downloadedBoard];
    state.downloadedScopeKeys = ['kilter:8:17'];

    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'Marco garage' }));

    await waitFor(() => expect(setActiveBoardMock).toHaveBeenCalledTimes(1));
    // Adoption is a follow mutation plus a download confirm — offline all it can do is
    // raise a "Could not follow X" error toast on a board the user already has.
    expect(adoptFoundBoardMock).not.toHaveBeenCalled();
  });

  it('shows the offline empty state, not "create a board", when nothing is downloaded', () => {
    state.isOffline = true;
    state.connectivityReason = 'device_offline';

    render(createElement(BoardSelection));

    expect(screen.getByText('Nothing downloaded yet')).toBeTruthy();
    expect(screen.queryByText('No boards yet')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create a board' })).toBeNull();
    expect(screen.queryByText('Try again')).toBeNull();
  });

  // Tapping the CTA arms the scope, which takes the CTA away. Falling silent
  // there leaves the user looking at the same un-downloaded board with nothing
  // to tap and no sign anything happened, so the queued line takes its place.
  it('acknowledges the queued download once the board has been armed', () => {
    state.isOffline = true;
    state.connectivityReason = 'device_offline';
    state.activeBoard = downloadedBoard;
    state.offlineCards = [downloadedBoard];
    state.offlineCatalog = 'queued';

    render(createElement(BoardSelection));

    expect(screen.getByText("Marco garage is queued — it downloads the moment you're back online.")).toBeTruthy();
    expect(screen.queryByTestId('offline-catalog-cta')).toBeNull();
  });

  // `offlineBoardRows` always offers the active board, so the empty state only
  // renders when there is no board to suggest — the CTA anchored inside it
  // could never appear. It belongs beside the carousel the un-downloaded board
  // is actually showing in.
  it('offers the download beside the carousel, not only in the empty state', () => {
    state.isOffline = true;
    state.connectivityReason = 'device_offline';
    state.activeBoard = downloadedBoard;
    state.offlineCards = [downloadedBoard];
    state.offlineCatalog = 'missing';

    render(createElement(BoardSelection));

    expect(screen.getByTestId('carousel')).toBeTruthy();
    expect(screen.getByTestId('offline-catalog-cta')).toBeTruthy();
  });

  it('falls back to downloaded boards when the connection lies (online, every request fails)', async () => {
    // Captive portal / gym wifi with a dead upstream: onlineManager reports online, so
    // retries never pause and the query really errors.
    state.isOffline = false;
    state.myBoards = { data: undefined, isLoading: false, isError: true, isRefetching: false };
    state.offlineCards = [downloadedBoard];
    state.downloadedScopeKeys = ['kilter:8:17'];

    render(createElement(BoardSelection));

    const row = screen.getByRole('button', { name: 'Marco garage' });
    expect(screen.queryByText('Something went wrong')).toBeNull();
    // The device has bars here, so "No signal" would be a lie.
    expect(screen.getByText("Can't reach your boards right now — here are the ones you've downloaded.")).toBeTruthy();
    expect(screen.queryByText("No signal — here are the boards you've downloaded.")).toBeNull();

    fireEvent.click(row);
    await waitFor(() => expect(setActiveBoardMock).toHaveBeenCalledTimes(1));
    // The adopt guard must follow the rows, not `isOffline`: here `isOffline` is false
    // but every request still fails, so a follow mutation can only produce the
    // "Could not follow X" toast (plus a Sentry report) on a downloaded board.
    expect(adoptFoundBoardMock).not.toHaveBeenCalled();
  });

  // #4862: the notice blamed the phone for everything. A climber standing in
  // full LTE while Boardsesh is down was told they had no signal, and went off
  // rebooting their router.
  it('blames our server, not the signal, when the backend is the thing that is down', () => {
    state.isOffline = true;
    state.connectivityReason = 'backend_unreachable';
    state.offlineCards = [downloadedBoard];
    state.downloadedScopeKeys = ['kilter:8:17'];

    render(createElement(BoardSelection));

    expect(screen.getByText("Can't reach your boards right now — here are the ones you've downloaded.")).toBeTruthy();
    expect(screen.queryByText("No signal — here are the boards you've downloaded.")).toBeNull();
    // Retry is for the lying connection only: this query is paused, and React
    // Query resumes it on the reconnect edge by itself.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('names Offline mode when the climber turned it on themselves', () => {
    state.isOffline = true;
    state.connectivityReason = 'offline_mode';
    state.offlineCards = [downloadedBoard];
    state.downloadedScopeKeys = ['kilter:8:17'];

    render(createElement(BoardSelection));

    expect(screen.getByText("Offline mode is on. Here are the boards you've downloaded.")).toBeTruthy();
    expect(screen.queryByText("No signal — here are the boards you've downloaded.")).toBeNull();
  });

  // Every board action on this screen is a server mutation, so the offline branch
  // offers none of them — and no Edit control either, since there is nothing
  // behind it that could succeed.
  it('offers no per-card action and no Edit control on the offline branch', () => {
    state.isOffline = true;
    state.connectivityReason = 'device_offline';
    state.offlineCards = [downloadedBoard];
    state.downloadedScopeKeys = ['kilter:8:17'];

    render(createElement(BoardSelection));

    expect(screen.getByTestId('carousel').getAttribute('data-has-actions')).toBe('no');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    // The drill-in survives: it is navigation, not a mutation, and it is the only
    // route left to the download console now the drawer's second board row is gone.
    expect(screen.getByRole('button', { name: 'Manage boards' })).toBeTruthy();
  });

  it('keeps a retry escape hatch when the connection lies and nothing is downloaded', () => {
    state.isOffline = false;
    state.myBoards = { data: undefined, isLoading: false, isError: true, isRefetching: false };

    render(createElement(BoardSelection));

    expect(screen.getByText('Nothing downloaded yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('still adopts on tap when the network list is usable', async () => {
    // The other direction of the same guard: online, selecting a board must still
    // follow it and offer its download.
    state.myBoards = {
      data: { boards: [board({ uuid: 'net-1', name: 'Network board' })] },
      isLoading: false,
      isError: false,
      isRefetching: false,
    };

    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'Network board' }));

    await waitFor(() => expect(adoptFoundBoardMock).toHaveBeenCalledTimes(1));
  });

  // The board-card glyph is the widest-reach discovery surface in #4318, and it
  // is the one that joins to the download funnel through this event alone (it
  // has no impression event by design).
  it('reports a board-card download once the size dialog is confirmed', async () => {
    state.myBoards = {
      data: { boards: [board({ uuid: 'net-1', name: 'Network board' })] },
      isLoading: false,
      isError: false,
      isRefetching: false,
    };

    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'download Network board' }));

    await waitFor(() => expect(confirmAndDownloadMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith(
        'Offline Nudge Accepted',
        expect.objectContaining({ surface: 'board_card', scopeKey: 'kilter:8:17', armedOnly: false }),
      ),
    );
  });

  it('reports nothing when the board-card size dialog is cancelled', async () => {
    confirmAndDownloadMock.mockResolvedValueOnce(false);
    state.myBoards = {
      data: { boards: [board({ uuid: 'net-1', name: 'Network board' })] },
      isLoading: false,
      isError: false,
      isRefetching: false,
    };

    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'download Network board' }));

    await waitFor(() => expect(confirmAndDownloadMock).toHaveBeenCalledTimes(1));
    expect(trackMock).not.toHaveBeenCalledWith('Offline Nudge Accepted', expect.anything());
  });

  it('leaves the online screen untouched', () => {
    state.myBoards = {
      data: { boards: [board({ uuid: 'net-1', name: 'Network board' })] },
      isLoading: false,
      isError: false,
      isRefetching: false,
    };
    state.popular = {
      configs: [
        {
          boardType: 'kilter',
          layoutId: 8,
          sizeId: 17,
          setIds: [20, 21],
          setNames: ['Bolt ons'],
          climbCount: 1,
          totalAscents: 1,
          boardCount: 1,
          displayName: 'Kilter Original',
          sizeName: '12 x 12',
        },
      ],
    };
    // Downloaded snapshots exist, but online they must not change anything.
    state.offlineCards = [downloadedBoard];
    state.downloadedScopeKeys = ['kilter:8:17'];

    render(createElement(BoardSelection));

    expect(screen.getByRole('button', { name: 'Network board' })).toBeTruthy();
    expect(screen.getByText('Popular')).toBeTruthy();
    expect(screen.queryByText("No signal — here are the boards you've downloaded.")).toBeNull();
    // All four discovery mode cards, including the two that need a connection.
    for (const label of ['Find nearby', 'Bluetooth', 'Find a gym', 'Create']) {
      expect(document.querySelector(`[data-mode-card="${label}"]`)).toBeTruthy();
    }
  });
});
