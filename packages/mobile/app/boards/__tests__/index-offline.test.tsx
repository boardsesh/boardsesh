// @vitest-environment jsdom
vi.mock('../../../src/components/AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../src/hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../../src/components/PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
vi.mock('../../../src/providers/queue-provider', () => ({
  useQueueActions: () => ({ clearSession: vi.fn(async () => {}) }),
}));
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
// What adoption would answer for a networked pick. The offline test sets it to
// true so `followed: false` can only come from the on-device rows.
const willFollowMock = vi.hoisted(() => vi.fn((): boolean => false));

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
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
}));

vi.mock('../../../src/lib/spray/use-spray-import-progress', () => ({
  useSprayImportProgress: (boards: unknown[]) => ({ boards, stale: false, unfinishedWallUuids: new Set<string>() }),
}));

const navigationMock = vi.hoisted(() => ({ setOptions: vi.fn() }));
vi.mock('expo-router', () => ({
  useRouter: () => routerMock,
  useLocalSearchParams: () => ({}),
  useIsFocused: () => true,
  useNavigation: () => navigationMock,
}));

// The In range slot's scan, and the sections built on it, as stand-ins: their
// own suites cover them (use-picker-board-scan, picker-top-view, InRangeSection).
const scanCtrl = vi.hoisted(() => ({ focused: null as boolean | null }));
vi.mock('../../../src/components/board-discovery/use-picker-board-scan', () => ({
  usePickerBoardScan: (options: { focused: boolean }) => {
    scanCtrl.focused = options.focused;
    return {
      phase: 'hidden',
      rows: [],
      lookup: 'none',
      listenedLongEnough: () => true,
      start: vi.fn(),
      stop: vi.fn(),
      openSettings: vi.fn(),
      retryLookup: vi.fn(),
    };
  },
}));
vi.mock('../../../src/components/board-discovery/use-in-range-location-hint', () => ({
  useInRangeLocationHint: () => null,
}));
vi.mock('../../../src/components/board-discovery/InRangeSection', () => ({
  InRangeSection: () => createElement('div', { 'data-testid': 'in-range' }),
}));
vi.mock('../../../src/components/board-discovery/AddBoardMenu', () => ({ AddBoardMenu: () => null }));
vi.mock('../../../src/components/board-discovery/NearbyReservedSlot', () => ({
  NearbyReservedSlot: ({ searching, children }: { searching: boolean; children?: ReactNode }) =>
    searching ? createElement('div', { 'data-testid': 'near-you-placeholder' }) : children,
}));
vi.mock('../../../src/components/location/LocationAskCard', () => ({
  LocationAskCard: ({ permission }: { permission: string }) =>
    createElement('div', { 'data-testid': 'location-banner', 'data-permission': permission }),
}));
vi.mock('../../../src/components/board-discovery/DiscoveryBoardArt', () => ({ DiscoveryBoardArt: () => null }));
vi.mock('../../../src/lib/boards/pending-board-recognition', () => ({
  setPendingBoardRecognition: vi.fn(),
  clearPendingBoardRecognition: vi.fn(),
  consumePendingBoardRecognition: vi.fn(async () => {}),
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
        'mobile.discovery.nearbyTitle': 'Near you',
        'mobile.discovery.nearbyMap': 'Map',
        'mobile.addBoard.setUp': 'Set up a board',
        'mobile.addBoard.sprayWall': 'Add a Spraywall',
        'mobile.boardSwitchError': 'Could not switch board',
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
  useBoard: () => ({ data: undefined }),
  useMyBoards: () => ({ ...state.myBoards, refetch: vi.fn() }),
  useNearbyBoards: () => ({ data: undefined, isLoading: false }),
  useGymBoards: () => ({ data: undefined }),
  useProfile: () => ({ data: { id: 'me' } }),
  useDeleteBoard: () => ({ mutateAsync: vi.fn(), isPending: false, variables: undefined }),
  useUnfollowBoard: () => ({ mutateAsync: vi.fn(), isPending: false, variables: undefined }),
  useLinkBoardToGym: () => ({ mutateAsync: vi.fn() }),
  useDetachBoardFromGym: () => ({ mutateAsync: vi.fn() }),
  usePinBoard: () => ({ mutate: vi.fn() }),
}));

vi.mock('../../../src/lib/graphql/use-active-board', () => ({
  getActiveBoardWriteGeneration: () => 0,
  useActiveBoard: () => ({ data: state.activeBoard }),
  useSetActiveBoard: () => setActiveBoardMock,
  useClearActiveBoardIfCurrentGeneration: () => vi.fn(),
  useSetActiveBoardIfCurrentGeneration: () => vi.fn(),
}));

vi.mock('../../../src/hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: 'me', isLoading: false }),
}));

vi.mock('../../../src/lib/board-discovery/use-adopt-found-board', () => ({
  useAdoptFoundBoard: () => adoptFoundBoardMock,
  useWillFollowFoundBoard: () => willFollowMock,
}));

vi.mock('../../../src/lib/use-device-location', () => ({
  useDeviceLocation: () => ({
    status: 'idle',
    permission: 'granted',
    permissionChecked: true,
    coords: undefined,
    request: vi.fn(),
    requestIfAllowed: vi.fn(async () => {}),
    refresh: vi.fn(async () => false),
  }),
}));

// Keep the activation/link decision real while replacing credential and preference I/O.
vi.mock('../../../src/hooks/use-is-offline', () => ({
  useIsOffline: () => state.isOffline,
}));
vi.mock('../../../src/lib/integrations/use-board-account-credentials', () => ({
  useBoardAccountCredentials: () => ({ data: [] }),
}));
vi.mock('../../../src/lib/onboarding/link-step-answered', () => ({
  hasAnsweredLinkStep: vi.fn(async () => false),
}));
vi.mock('../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: true, refreshAuthState: vi.fn() }),
}));
vi.mock('../../../src/providers/toast-provider', () => ({ useToast: () => toastMock }));
vi.mock('../../../src/providers/dialog-provider', () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock('../../../src/providers/theme-provider', () => ({
  useOptionalTheme: () => null,
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
vi.mock('../../../src/providers/feature-flags-provider', () => ({
  useDirectoryReportsEnabled: () => false,
  useFeatureFlagsResolved: () => true,
  useFeatureFlag: () => false,
  useOfflineDownloadsEnabled: () => true,
  usePickerAutoScanEnabled: () => true,
  useAddBoardWizardEnabled: () => false,
}));
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
  opacity: { disabled: 0.5 },
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
vi.mock('../../../src/components/report-problem/use-report-problem', () => ({
  useReportProblemHost: () => ({ openReport: vi.fn(), sheet: null }),
}));
vi.mock('../../../src/components/report-problem/ReportReviewSheet', () => ({ ReportReviewSheet: () => null }));
vi.mock('../../../src/components/board-discovery/BoardDetailSheet', () => ({ BoardDetailSheet: () => null }));

// The Velvet shelf pieces, as plain markup: a section, its title, and its action
// as a button named for what it opens.
vi.mock('../../../src/components/ShelfHeader', async () => {
  const { createElement: h } = await import('react');
  type ShelfProps = {
    title: string;
    action?: { label: string; accessibilityLabel?: string; onPress: () => void };
    children?: ReactNode;
  };
  return {
    SHELF_SECTION_GAP: 28,
    ShelfSection: ({ title, action, children }: ShelfProps) =>
      h(
        'section',
        null,
        h('span', null, title),
        action
          ? h('button', { type: 'button', onClick: action.onPress }, action.accessibilityLabel ?? action.label)
          : null,
        children,
      ),
  };
});
vi.mock('../../../src/components/EmptyState', async () => {
  const { createElement: h } = await import('react');
  return {
    EmptyState: ({ title, body, actions }: { title: string; body?: string; actions?: ReactNode }) =>
      h('div', null, h('span', null, title), body ? h('span', null, body) : null, actions),
  };
});
vi.mock('../../../src/components/TextAction', async () => {
  const { createElement: h } = await import('react');
  return {
    TextAction: ({ label, onPress }: { label: string; onPress: () => void }) =>
      h('button', { type: 'button', onClick: onPress }, label),
    textActionOverhang: () => ({ top: 4, bottom: 20 }),
  };
});
// Your boards and the offline list are rows now; the suite drives them as it
// drives the carousels, through the same stand-in.
vi.mock('../../../src/components/board-discovery/BoardRowList', async () => {
  const { BoardCarousel } = await import('../../../src/components/board-discovery/BoardCarousel');
  return { BoardRowList: BoardCarousel };
});
vi.mock('../../../src/components/board-discovery/BoardCarousel', () => ({
  BoardCarousel: ({
    items,
    onSelect,
    menuCapabilities,
    onMenuAction,
  }: {
    items: CarouselItem[];
    onSelect: (item: CarouselItem) => void;
    menuCapabilities?: { canDownload: boolean };
    onMenuAction?: (item: CarouselItem, action: 'download', via: 'menu_button') => void;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'carousel', 'data-has-actions': onMenuAction === undefined ? 'no' : 'yes' },
      items.map((item) =>
        createElement('span', { key: item.key }, [
          createElement('button', { key: 'select', type: 'button', onClick: () => onSelect(item) }, item.title),
          // Only the Your Boards carousel offers it; the menu's Download for
          // offline is what fires the board-card accept event.
          menuCapabilities?.canDownload && onMenuAction
            ? createElement(
                'button',
                { key: 'download', type: 'button', onClick: () => onMenuAction(item, 'download', 'menu_button') },
                `download ${item.title}`,
              )
            : null,
        ]),
      ),
    ),
}));
// First-board mode (#5654) has its own suite, index-first-board.test.tsx.
vi.mock('../../../src/components/board-discovery/FirstBoardChoice', () => ({ FirstBoardChoice: () => null }));

const { default: BoardSelection } = await import('../index');

const downloadedBoard = board({ uuid: 'board-a', name: 'Marco garage' });

beforeEach(() => {
  vi.clearAllMocks();
  setActiveBoardMock.mockResolvedValue(undefined);
  willFollowMock.mockReturnValue(false);
  state.isOffline = false;
  state.connectivityReason = null;
  state.offlineCards = [];
  state.downloadedScopeKeys = [];
  state.offlineCatalog = null;
  state.activeBoard = undefined;
  state.myBoards = { data: undefined, isLoading: false, isError: false, isRefetching: false };
  scanCtrl.focused = null;
});

/** The header's trailing item as the screen last set it, or null. */
function headerPlusSet(): boolean {
  const options = navigationMock.setOptions.mock.calls.at(-1)?.[0] as { headerRight?: unknown } | undefined;
  return typeof options?.headerRight === 'function';
}

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
    // Networked, this pick would follow; the on-device rows are what say no.
    willFollowMock.mockReturnValue(true);

    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'Marco garage' }));

    await waitFor(() => expect(setActiveBoardMock).toHaveBeenCalledTimes(1));
    // Adoption is a follow mutation plus a download confirm — offline all it can do is
    // raise a "Could not follow X" error toast on a board the user already has.
    expect(adoptFoundBoardMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith(
        'Board Picker Selection Completed',
        expect.objectContaining({ pickSource: 'offline', followed: false }),
      ),
    );
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
  // draws plain cards with no menu, since there is nothing behind one that
  // could succeed.
  it('offers no card menu on the offline branch', () => {
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
    // The pick event names the section the card was tapped in.
    expect(trackMock).toHaveBeenCalledWith(
      'Board Picker Selection Completed',
      expect.objectContaining({ pickSource: 'your_boards' }),
    );
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
    // Downloaded snapshots exist, but online they must not change anything.
    state.offlineCards = [downloadedBoard];
    state.downloadedScopeKeys = ['kilter:8:17'];

    render(createElement(BoardSelection));

    expect(screen.getByRole('button', { name: 'Network board' })).toBeTruthy();
    expect(screen.queryByText("No signal — here are the boards you've downloaded.")).toBeNull();
    // Everything that needs a connection: the In range slot, Near you and the +.
    expect(screen.getByTestId('in-range')).toBeTruthy();
    expect(screen.getByText('Near you')).toBeTruthy();
    expect(headerPlusSet()).toBe(true);
    expect(scanCtrl.focused).toBe(true);
  });

  // Offline there is no In range slot to fill and nothing behind the + that
  // could work, so the scan stays off and the top bar stays bare.
  it('neither scans nor offers the + on the offline branch', () => {
    state.isOffline = true;
    state.connectivityReason = 'device_offline';
    state.offlineCards = [downloadedBoard];
    state.downloadedScopeKeys = ['kilter:8:17'];

    render(createElement(BoardSelection));

    expect(screen.queryByTestId('in-range')).toBeNull();
    expect(scanCtrl.focused).toBe(false);
    expect(headerPlusSet()).toBe(false);
  });
});
