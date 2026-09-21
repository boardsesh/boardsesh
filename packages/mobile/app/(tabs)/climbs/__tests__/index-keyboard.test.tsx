// @vitest-environment jsdom
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';

const mocks = vi.hoisted(() => ({
  // The climb the drawer host reports as previewed, i.e. shown without being
  // committed. Read at render so a test can drive the row highlight.
  previewedClimbUuid: vi.fn<() => string | null>(() => null),
  activeClimbUuid: vi.fn<() => string | null>(() => null),
  climb: {
    uuid: 'climb-1',
    name: 'Moonage',
  } as unknown as Climb,
  secondClimb: {
    uuid: 'climb-2',
    name: 'Zenith',
  } as unknown as Climb,
  // Mutable per-test fixtures for useInfiniteSearchClimbs / useClimbSearch — read
  // at call time (render), so a test can set these before rendering to exercise
  // a different search/filter state without a separate mock scaffold file.
  searchClimbs: [] as unknown as Climb[],
  // The board this screen is bound to, and whether its stored choice is still
  // being read. Mutable so a test can render the two states the settled default
  // hides: no board bound at all, and a board switch mid-flight.
  activeBoard: null as
    | { boardType: string; layoutId: number; sizeId: number; setIds: string; angle: number }
    | null
    | undefined,
  boardStatus: 'success' as 'pending' | 'error' | 'success',
  boardFetchStatus: 'idle' as 'fetching' | 'paused' | 'idle',
  refetchActiveBoard: vi.fn(),
  setActiveBoard: vi.fn(),
  push: vi.fn(),
  // Whether the climb search is fetching its first page — the other half of the
  // initial-skeleton gate.
  isClimbsLoading: false,
  searchState: {
    filters: {} as Record<string, unknown>,
    boardFilters: {} as Record<string, unknown>,
    name: '',
  },
  // Offline empty-state fixtures: connectivity, whether the search itself
  // failed, and what the active board's catalog looks like on this device.
  isOffline: false,
  searchFailed: false,
  // The previous search's rows standing in while a new one loads, and whether
  // the list query reports a background refetch.
  isPlaceholderData: false,
  isRefetching: false,
  offlineCatalog: null as 'missing' | 'queued' | null,
  activateClimb: vi.fn(),
  activationOptions: undefined as { previewOnly?: boolean } | undefined,
  openPlayDrawer: vi.fn(),
  // Row actions, hoisted so tests can assert a stale row never reaches them.
  addToQueue: vi.fn(),
  openClimbActions: vi.fn(),
  openAddToPlaylist: vi.fn(),
  // Mutable per-test: whether another climber is in the session.
  isSharedSession: false,
  setSetting: vi.fn(),
  // Deep-link params, mutable so the screenshot-mode auto-opens can be driven
  // without a second mock scaffold.
  searchParams: {} as Record<string, string>,
  // Mutable per-test setting: false exercises the preview-open branch instead
  // of the committing activateClimb path.
  lightOnClimbTap: true,
  dismissKeyboard: vi.fn(),
  getLastSearch: vi.fn(),
  saveLastSearch: vi.fn(),
  getRecentFilters: vi.fn(),
  getLogbook: vi.fn(),
  track: vi.fn(),
  ensureBackgroundsCached: vi.fn(),
  imagePrefetch: vi.fn(),
}));

type FlashListProps<Item> = {
  data?: Item[];
  renderItem?: (info: { item: Item; index: number }) => ReactNode;
  ListHeaderComponent?: ReactNode;
  ListFooterComponent?: ReactNode;
  ListEmptyComponent?: ReactNode;
  refreshControl?: ReactNode;
};

vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', testID ? { 'data-testid': testID } : null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
  RefreshControl: ({ refreshing }: { refreshing?: boolean }) =>
    createElement('div', { 'data-refresh-control': 'true', 'data-refreshing': String(!!refreshing) }),
  Keyboard: { dismiss: mocks.dismissKeyboard },
  // The screen reads Platform.OS at module load (the iOS-only Tall/Wide lock).
  Platform: { OS: 'ios' },
  // No `Image.prefetch` should ever fire for board art (#3191 — the native
  // Android image loader gets a 403 from the CDN/WAF for direct board-art
  // fetches). Exposed here so the pre-warm test can assert it stays unused.
  Image: { prefetch: mocks.imagePrefetch },
  // Run deferred work synchronously in tests; the prewarm + background-cache
  // effects schedule through InteractionManager.runAfterInteractions in the screen.
  InteractionManager: {
    runAfterInteractions: (callback: () => void) => {
      callback();
      return { cancel: () => undefined };
    },
  },
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: <Item,>({
    data = [],
    renderItem,
    ListHeaderComponent,
    ListFooterComponent,
    ListEmptyComponent,
    refreshControl,
  }: FlashListProps<Item>) =>
    createElement(
      'div',
      { 'data-testid': 'flash-list' },
      refreshControl,
      ListHeaderComponent,
      data.length > 0
        ? data.map((item, index) => createElement('div', { key: index }, renderItem?.({ item, index })))
        : ListEmptyComponent,
      ListFooterComponent,
    ),
}));

vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  },
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: () => ({}),
  withTiming: (value: number) => value,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ push: mocks.push }),
  useLocalSearchParams: () => mocks.searchParams,
  useFocusEffect: () => {},
}));

// The onboarding reveal banner + its storage pull expo-haptics / expo-secure-store
// (expo-modules-core EventEmitter) into the graph — irrelevant to the keyboard
// test, so stub both.
vi.mock('../../../../src/components/onboarding/OnboardingTipBanner', () => ({
  OnboardingTipBanner: () => null,
}));
// The connect-step card has its own suite; it reaches the Bluetooth provider,
// which this suite has no reason to load.
vi.mock('../../../../src/components/onboarding/FirstConnectCard', () => ({
  FirstConnectCard: () => null,
  useFirstConnectCardExpected: () => false,
}));
vi.mock('../../../../src/lib/onboarding/onboarding-storage', () => ({
  hasBoardRevealTipPending: vi.fn(async () => false),
  clearBoardRevealTipPending: vi.fn(async () => {}),
}));

// The favourite-hearts fetcher reads the signed-in user's id, which reaches
// `expo-secure-store` (a native module) through `local-user-id`. Stub the hook
// so this screen test doesn't pull the native graph in for an id it never uses.
vi.mock('../../../../src/hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: undefined, isLoading: false }),
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'queue-item-1' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('@boardsesh/analytics', () => ({
  SHARED_EVENTS: { ClimbSearchPerformed: 'Climb Search Performed', SearchResultSelected: 'Search Result Selected' },
}));

vi.mock('@boardsesh/climb-filters', () => ({
  DEFAULT_CLIMB_FILTER_STATE: {},
  DEFAULT_CLIMB_BOARD_FILTER_STATE: {},
  toClimbSearchInput: () => ({}),
  mergeBoardFilters: (input: unknown) => input,
  countActiveFilters: () => 0,
  hasActiveBoardFilters: () => false,
  // Consumed by filter-chip-menus (imported via index.tsx for the chip row).
  SORT_OPTIONS: ['ascents', 'quality', 'difficulty', 'name', 'popular', 'creation'],
  // "Your progress" selector wiring for the persistent chip row.
  flagsToProgress: () => 'all',
  progressToFlags: () => ({}),
}));

vi.mock('@boardsesh/board-react', () => ({
  useBoardActions: () => ({ getLogbook: mocks.getLogbook }),
  // The screen's screenshot-mode whole-list stats prefetch reads the adapter.
  // It no-ops outside screenshot mode; these keep the module resolvable.
  useBoardAdapter: () => ({ isAuthenticated: false }),
  prefetchClimbStatsForClimbs: vi.fn().mockResolvedValue(undefined),
}));

// Reads mocks.searchState (mutated per-test) instead of the real reducer, so a
// test can force a specific filter/name without driving the UI through it.
vi.mock('../../../../src/providers/climb-search-provider', () => ({
  ClimbSearchProvider: ({ children }: { children?: ReactNode }) => children,
  useClimbSearch: () => ({
    ...mocks.searchState,
    setFilters: vi.fn(),
    setBoardFilters: vi.fn(),
    setGrade: vi.fn(),
    setName: vi.fn(),
    replaceSearch: vi.fn(),
    patchFilters: vi.fn(),
    patchBoardFilters: vi.fn(),
  }),
}));

vi.mock('../../../../src/components/ClimbListRow', () => ({
  // `selected` is surfaced, not swallowed: the row highlight is the only feedback
  // a climber gets that a tap landed, and a mock that dropped it would let the
  // highlight break with every case in this file still green.
  // The queue / actions / playlist buttons stand in for the row's swipe and
  // long-press affordances, so the stale-row guards on each can be exercised.
  ClimbListRow: ({
    climb: rowClimb,
    onPress,
    onAddToQueue,
    onOpenActions,
    onOpenPlaylist,
    selected,
  }: {
    climb: Climb;
    onPress?: (pressedClimb: Climb) => void;
    onAddToQueue?: (queuedClimb: Climb) => void;
    onOpenActions?: (actionsClimb: Climb) => void;
    onOpenPlaylist?: (playlistClimb: Climb) => void;
    selected?: boolean;
  }) => [
    createElement(
      'button',
      { key: 'row', onClick: () => onPress?.(rowClimb), 'data-selected': selected ? 'true' : 'false' },
      rowClimb.name,
    ),
    createElement('button', { key: 'queue', onClick: () => onAddToQueue?.(rowClimb) }, `queue:${rowClimb.name}`),
    createElement('button', { key: 'actions', onClick: () => onOpenActions?.(rowClimb) }, `actions:${rowClimb.name}`),
    createElement(
      'button',
      { key: 'playlist', onClick: () => onOpenPlaylist?.(rowClimb) },
      `playlist:${rowClimb.name}`,
    ),
  ],
}));

vi.mock('../../../../src/components/ClimbListRowSkeleton', () => ({
  ClimbListRowSkeleton: () => createElement('div', { 'data-skeleton-row': 'true' }),
}));

vi.mock('../../../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-activity-indicator': 'true' }),
}));

vi.mock('../../../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../../../src/components/Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));

vi.mock('../../../../src/components/Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));

vi.mock('../../../../src/components/ClimbFilterSheet', () => ({
  ClimbFilterSheet: () => null,
  hasActiveFilters: () => false,
}));

vi.mock('../../../../src/components/search/ClimbTopChrome', () => ({ ClimbTopChrome: () => null }));
vi.mock('../../../../src/components/RecentFilterPills', () => ({ RecentFilterPills: () => null }));
vi.mock('../../../../src/components/search/FilterTokenRow', () => ({ FilterTokenRow: () => null }));
vi.mock('../../../../src/lib/haptics', () => ({
  hapticSelection: () => {},
  hapticLight: () => {},
  hapticMedium: () => {},
  hapticHeavy: () => {},
  hapticSuccess: () => {},
}));
vi.mock('../../../../src/components/grade', () => ({ GradeRangeRail: () => null }));

vi.mock('../../../../src/providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({
    openClimbActions: mocks.openClimbActions,
    openAddToPlaylist: mocks.openAddToPlaylist,
    openBoardSheet: vi.fn(),
    openPlayDrawer: mocks.openPlayDrawer,
  }),
  usePreviewedClimbUuid: () => mocks.previewedClimbUuid(),
}));

vi.mock('../../../../src/providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      background: '#fff',
      label: '#111',
      separator: '#ddd',
    },
    variant: 'liquidGlass',
    brandColors: { primary: '#6D28D9' },
    features: { filtersInTopChrome: false, summaryExcludesGradeFilter: false },
  }),
  useAppColorScheme: () => 'light',
}));

vi.mock('../../../../src/theme/variants', () => ({
  selectByVariant: (_variant: string, options: { liquidGlass: boolean }) => options.liquidGlass,
}));

vi.mock('../../../../src/providers/queue-provider', () => ({
  useActiveClimbUuid: () => mocks.activeClimbUuid(),
  useIsSharedSession: () => mocks.isSharedSession,
  useQueueActions: () => ({ addToQueue: mocks.addToQueue }),
}));

vi.mock('../../../../src/settings', () => ({
  useSetting: (key: string) => (key === 'lightOnClimbTap' ? [mocks.lightOnClimbTap, vi.fn()] : [false, vi.fn()]),
  setSetting: mocks.setSetting,
}));

vi.mock('../../../../src/hooks/use-bottom-accessory', () => ({ useNativeAccessoryActive: () => false }));
vi.mock('../../../../src/hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({
    scrollBottomPadding: 96,
    nativeAccessoryVisible: false,
    tabBarBottom: 0,
    floatingControlBottom: 0,
  }),
}));

vi.mock('../../../../src/lib/graphql/hooks', () => ({
  useGrades: () => ({ data: [] }),
  useMyBoards: () => ({ data: undefined }),
}));
// Screenshot-only board roster. Real in a capture build; here it would be the
// screen's only live useQuery, and this test renders without a QueryClientProvider.
vi.mock('../../../../src/hooks/use-screenshot-boards', () => ({
  useScreenshotBoards: () => [],
}));
vi.mock('../../../../src/hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGradeByDifficultyId: (difficultyId: number) => String(difficultyId) }),
}));

// Stub the SecureStore-backed last-used-grade hook so the screen test doesn't
// pull in expo-secure-store / expo-modules-core (matches the last-search mock).
vi.mock('../../../../src/hooks/use-last-used-grade', () => ({
  useLastUsedGrade: () => ({ lastUsedGrade: undefined, rememberGrade: vi.fn() }),
}));

vi.mock('../../../../src/lib/graphql/hooks/use-infinite-search-climbs', () => ({
  // Honours `enabled` the way React Query does: a disabled query — the per-board
  // restore still in flight — has no data and is not loading either, so the
  // previous board's rows cannot leak into the render through this mock.
  useInfiniteSearchClimbs: (_input: unknown, enabled = true) => ({
    data: enabled ? { pages: [{ climbs: mocks.searchClimbs, hasMore: false }] } : undefined,
    isLoading: enabled && mocks.isClimbsLoading,
    isError: mocks.searchFailed,
    isFetchingNextPage: false,
    isRefetching: mocks.isRefetching,
    isPlaceholderData: mocks.isPlaceholderData,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('../../../../src/lib/graphql/operations', () => ({ SEARCH_CLIMBS: 'SEARCH_CLIMBS' }));
vi.mock('../../../../src/lib/graphql/client', () => ({ getHttpClient: () => ({ request: vi.fn() }) }));
// Mock the interceptor module itself: its module-scope registry reads every
// registered document from `operations`, so loading the real module would make
// this test's partial operations mock load-bearing for future registrations.
vi.mock('../../../../src/lib/graphql/offline-request', () => ({ offlineAwareRequest: vi.fn() }));
// Has its own render suite (src/components/offline/__tests__).
vi.mock('../../../../src/components/offline/OfflineCatalogCta', () => ({ OfflineCatalogCta: () => null }));
vi.mock('../../../../src/offline/use-downloaded-scope-keys', () => ({ useDownloadedScopeKeys: () => ({ data: [] }) }));
// Mocked rather than driven through settings: the real hook reads MMKV, which
// this suite deliberately keeps out of the screen's module graph.
vi.mock('../../../../src/offline/use-offline-catalog-state', () => ({
  useOfflineCatalogState: () => mocks.offlineCatalog,
}));
vi.mock('../../../../src/hooks/use-is-offline', () => ({ useIsOffline: () => mocks.isOffline }));

vi.mock('../../../../src/lib/playlists/use-playlist-activation', () => ({
  // Options captured, not swallowed: `previewOnly` is how the screen tells the
  // activation hook that a row tap must browse rather than take the crew's wall,
  // and dropping it at this call site is invisible to the hook's own tests.
  usePlaylistActivation: (options: { previewOnly?: boolean }) => ({
    activate: (...args: unknown[]) => {
      mocks.activationOptions = options;
      return mocks.activateClimb(...args);
    },
    queueReplaceSheet: {
      visible: false,
      futureQueueCount: 0,
      isReplacing: false,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    },
  }),
}));

vi.mock('../../../../src/lib/climb-types', () => ({
  toQueueClimb: (pressedClimb: Climb) => ({ uuid: pressedClimb.uuid }),
  toQueueClimbs: (climbs: Climb[]) => climbs,
}));

vi.mock('../../../../src/lib/create-board-holds', () => ({
  parseSetIdsParam: () => [1],
  prewarmCreateBoardHolds: vi.fn(),
}));

vi.mock('../../../../src/lib/graphql/use-active-board', () => ({
  // Reads the fixture by reference (never rebuilds the object) so the board-keyed
  // effects in the screen see a stable identity across re-renders.
  useActiveBoard: () => ({
    data: mocks.activeBoard,
    isPending: mocks.boardStatus === 'pending',
    isSuccess: mocks.boardStatus === 'success',
    isError: mocks.boardStatus === 'error',
    isFetching: mocks.boardFetchStatus === 'fetching',
    isLoading: mocks.boardStatus === 'pending' && mocks.boardFetchStatus === 'fetching',
    refetch: mocks.refetchActiveBoard,
  }),
  useSetActiveBoard: () => mocks.setActiveBoard,
}));

vi.mock('../../../../src/providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../../src/lib/background-image-cache', () => ({
  ensureBackgroundsCached: mocks.ensureBackgroundsCached,
}));

vi.mock('../../../../src/lib/recent-filter-store', () => ({
  getRecentFilters: mocks.getRecentFilters,
  addRecentFilter: vi.fn(),
  clearRecentFilters: vi.fn(),
}));

vi.mock('../../../../src/lib/last-search-store', () => ({
  getLastSearch: mocks.getLastSearch,
  saveLastSearch: mocks.saveLastSearch,
  boardConfigKey: () => 'kilter:1:10:1:40',
}));

vi.mock('../../../../src/lib/filter-summary', () => ({
  getFilterSummary: () => '',
  buildClimbFilterSummary: () => null,
}));

vi.mock('../../../../src/lib/filter-tokens', () => ({ getActiveFilterTokens: () => [] }));
vi.mock('../../../../src/lib/search-name', () => ({
  normalizeSearchName: (text: string) => text.trim(),
  visibleSearchTextNeedsSync: () => false,
}));
vi.mock('../../../../src/lib/analytics', () => ({ track: mocks.track }));
vi.mock('../../../../src/theme/ios-colors', () => ({
  iosSystemColors: { systemGray4: '#C7C7CC' },
}));
vi.mock('../../../../src/theme/tokens', () => ({ spacing: { 2: 8 } }));
vi.mock('../../../../src/theme/layout', () => ({ glassSize: { standard: 48 } }));
vi.mock('../../../../src/theme/animations', () => ({ timing: { normal: 180 } }));

import ClimbList from '../index';

beforeEach(() => {
  mocks.previewedClimbUuid.mockReturnValue(null);
  mocks.activeClimbUuid.mockReturnValue(null);
  mocks.activateClimb.mockClear();
  mocks.openPlayDrawer.mockClear();
  mocks.setSetting.mockClear();
  mocks.lightOnClimbTap = true;
  mocks.dismissKeyboard.mockClear();
  mocks.getLogbook.mockClear();
  mocks.getLastSearch.mockReset();
  mocks.saveLastSearch.mockReset();
  mocks.getRecentFilters.mockReset();
  mocks.getLastSearch.mockResolvedValue(null);
  mocks.saveLastSearch.mockResolvedValue(undefined);
  mocks.getRecentFilters.mockResolvedValue([]);
  mocks.track.mockClear();
  mocks.ensureBackgroundsCached.mockClear();
  mocks.imagePrefetch.mockClear();
  mocks.searchClimbs = [mocks.climb, mocks.secondClimb];
  mocks.activeBoard = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1', angle: 40 };
  mocks.boardStatus = 'success';
  mocks.boardFetchStatus = 'idle';
  mocks.refetchActiveBoard.mockReset();
  mocks.refetchActiveBoard.mockResolvedValue(undefined);
  mocks.setActiveBoard.mockReset();
  mocks.push.mockClear();
  mocks.isClimbsLoading = false;
  mocks.searchState = { filters: {}, boardFilters: {}, name: '' };
  mocks.isOffline = false;
  mocks.searchFailed = false;
  mocks.offlineCatalog = null;
  mocks.searchParams = {};
  mocks.isSharedSession = false;
  mocks.activationOptions = undefined;
  mocks.isPlaceholderData = false;
  mocks.isRefetching = false;
});

// While a new search loads, the previous search's rows stay up as placeholder
// data (#5414). They are stale: no pull-to-refresh spinner for that fetch, and a
// tap must not open or seed a swipe track from the old results.
// Mirrors PLACEHOLDER_TINT_DELAY_MS in ../index.tsx. Kept local rather than
// exported: an extra export from a route file costs it its Fast Refresh boundary.
const PLACEHOLDER_TINT_DELAY_MS = 500;

// The no-board empty state is an early return. Every hook must run above it, or
// the hook count changes when a board binds or unbinds on the mounted screen
// (BOARDSESH-K1 / BOARDSESH-K2).
describe('ClimbList binding a board on the mounted screen', () => {
  it('swaps the no-board empty state for the list and back without a hook-order crash', async () => {
    mocks.activeBoard = null;
    const { findByText, rerender } = render(<ClimbList />);
    await findByText('mobile.emptyState.noBoard.title');

    mocks.activeBoard = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1', angle: 40 };
    rerender(<ClimbList />);
    await findByText('Moonage');

    mocks.activeBoard = null;
    rerender(<ClimbList />);
    await findByText('mobile.emptyState.noBoard.title');
  });
});

describe('ClimbList saved-board restoration', () => {
  it.each(['fetching', 'paused'] as const)('shows skeletons while the board read is %s', (fetchStatus) => {
    mocks.activeBoard = undefined;
    mocks.boardStatus = 'pending';
    mocks.boardFetchStatus = fetchStatus;

    const { container, queryByText } = render(<ClimbList />);

    expect(container.querySelectorAll('[data-skeleton-row]').length).toBeGreaterThan(0);
    expect(queryByText('mobile.emptyState.noBoard.title')).toBeNull();
    expect(queryByText('mobile.emptyState.boardRestoreFailed.title')).toBeNull();
    expect(queryByText('Moonage')).toBeNull();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('retries a failed read and restores the list without selecting the board again', async () => {
    mocks.activeBoard = undefined;
    mocks.boardStatus = 'error';
    const { getByRole, getByText, queryByText, findByText, rerender } = render(<ClimbList />);

    expect(getByText('mobile.emptyState.boardRestoreFailed.title')).toBeTruthy();
    expect(queryByText('mobile.emptyState.noBoard.title')).toBeNull();
    fireEvent.click(getByRole('button', { name: 'actions.retry' }));
    expect(mocks.refetchActiveBoard).toHaveBeenCalledOnce();
    expect(mocks.push).not.toHaveBeenCalled();

    mocks.boardStatus = 'pending';
    mocks.boardFetchStatus = 'fetching';
    rerender(<ClimbList />);
    expect(queryByText('mobile.emptyState.noBoard.title')).toBeNull();

    mocks.activeBoard = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1', angle: 40 };
    mocks.boardStatus = 'success';
    mocks.boardFetchStatus = 'idle';
    rerender(<ClimbList />);

    await findByText('Moonage');
    expect(queryByText('mobile.emptyState.boardRestoreFailed.title')).toBeNull();
    expect(mocks.setActiveBoard).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('keeps browsing the cached board if a later read fails', async () => {
    mocks.boardStatus = 'error';

    const { findByText, queryByText } = render(<ClimbList />);

    await findByText('Moonage');
    expect(queryByText('mobile.emptyState.boardRestoreFailed.title')).toBeNull();
    expect(queryByText('mobile.emptyState.noBoard.title')).toBeNull();
  });
});

describe('ClimbList previous results standing in for a loading search', () => {
  it('shows no pull-to-refresh spinner for the placeholder fetch', async () => {
    mocks.isPlaceholderData = true;
    mocks.isRefetching = true;
    const { container, findByText } = render(<ClimbList />);

    await findByText('Moonage');

    expect(container.querySelector('[data-refresh-control]')?.getAttribute('data-refreshing')).toBe('false');
  });

  // The tint waits PLACEHOLDER_TINT_DELAY_MS so a search that lands inside it
  // swaps rows with no dim. The first render runs on real timers (findByText
  // polls); fake timers start after it, so only the tint's timer is under test
  // control.
  it('never tints a search that lands inside the delay', async () => {
    const { container, findByText, rerender } = render(<ClimbList />);
    await findByText('Moonage');
    const findTint = () => container.querySelector('[data-testid="climb-list-placeholder-tint"]');

    vi.useFakeTimers();
    try {
      mocks.isPlaceholderData = true;
      rerender(<ClimbList />);
      expect(findTint()).toBeNull();

      act(() => {
        vi.advanceTimersByTime(PLACEHOLDER_TINT_DELAY_MS - 1);
      });
      mocks.isPlaceholderData = false;
      rerender(<ClimbList />);
      act(() => {
        vi.advanceTimersByTime(PLACEHOLDER_TINT_DELAY_MS);
      });

      expect(findTint()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('tints the stale rows once a slow search has stood in for the delay, and clears when it lands', async () => {
    const { container, findByText, rerender } = render(<ClimbList />);
    await findByText('Moonage');
    const findTint = () => container.querySelector('[data-testid="climb-list-placeholder-tint"]');

    vi.useFakeTimers();
    try {
      mocks.isPlaceholderData = true;
      rerender(<ClimbList />);
      expect(findTint()).toBeNull();

      act(() => {
        vi.advanceTimersByTime(PLACEHOLDER_TINT_DELAY_MS - 1);
      });
      expect(findTint()).toBeNull();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(findTint()).not.toBeNull();

      mocks.isPlaceholderData = false;
      rerender(<ClimbList />);
      expect(findTint()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still shows the spinner for a real pull-to-refresh', async () => {
    mocks.isRefetching = true;
    const { container, findByText } = render(<ClimbList />);

    await findByText('Moonage');

    expect(container.querySelector('[data-refresh-control]')?.getAttribute('data-refreshing')).toBe('true');
  });

  it('ignores a tap on a stale row', async () => {
    mocks.isPlaceholderData = true;
    const { findByText } = render(<ClimbList />);

    fireEvent.click(await findByText('Moonage'));

    expect(mocks.activateClimb).not.toHaveBeenCalled();
    expect(mocks.openPlayDrawer).not.toHaveBeenCalled();
  });

  it('ignores queue, actions and playlist on a stale row', async () => {
    mocks.isPlaceholderData = true;
    mocks.addToQueue.mockClear();
    mocks.openClimbActions.mockClear();
    mocks.openAddToPlaylist.mockClear();
    const { findByText, getByText } = render(<ClimbList />);

    fireEvent.click(await findByText('queue:Moonage'));
    fireEvent.click(getByText('actions:Moonage'));
    fireEvent.click(getByText('playlist:Moonage'));

    expect(mocks.addToQueue).not.toHaveBeenCalled();
    expect(mocks.openClimbActions).not.toHaveBeenCalled();
    expect(mocks.openAddToPlaylist).not.toHaveBeenCalled();
  });

  it('runs queue, actions and playlist on a fresh row', async () => {
    mocks.addToQueue.mockClear();
    mocks.openClimbActions.mockClear();
    mocks.openAddToPlaylist.mockClear();
    const { findByText, getByText } = render(<ClimbList />);

    fireEvent.click(await findByText('queue:Moonage'));
    fireEvent.click(getByText('actions:Moonage'));
    fireEvent.click(getByText('playlist:Moonage'));

    expect(mocks.addToQueue).toHaveBeenCalledWith(
      expect.objectContaining({ climb: expect.objectContaining({ uuid: 'climb-1' }) }),
    );
    expect(mocks.openClimbActions).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'climb-1' }));
    expect(mocks.openAddToPlaylist).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'climb-1' }));
  });
});

// The dead end this branch exists to remove, and the one it nearly reintroduced:
// arming the download flips the scope out of 'off', which takes the CTA away —
// so a branch keyed on "is it downloaded?" would keep telling the user their
// board isn't on their phone, with nothing left to tap.
describe('ClimbList offline catalog empty states', () => {
  beforeEach(() => {
    mocks.searchClimbs = [];
    mocks.isOffline = true;
  });

  it('offers the download when nothing has been asked for', async () => {
    mocks.offlineCatalog = 'missing';

    const { findByText, queryByText } = render(<ClimbList />);

    expect(await findByText('mobile.emptyState.offlineNoCatalog.title')).toBeTruthy();
    expect(queryByText('mobile.emptyState.offlineCatalogQueued.title')).toBeNull();
  });

  it('says the download is queued once the board has been armed', async () => {
    mocks.offlineCatalog = 'queued';

    const { findByText, queryByText } = render(<ClimbList />);

    expect(await findByText('mobile.emptyState.offlineCatalogQueued.title')).toBeTruthy();
    expect(queryByText('mobile.emptyState.offlineNoCatalog.title')).toBeNull();
  });

  it('leaves the generic empty state alone once the catalog is here', async () => {
    mocks.offlineCatalog = null;

    const { findByText, queryByText } = render(<ClimbList />);

    expect(await findByText('mobile.emptyState.noClimbs.title')).toBeTruthy();
    expect(queryByText('mobile.emptyState.offlineNoCatalog.title')).toBeNull();
    expect(queryByText('mobile.emptyState.offlineCatalogQueued.title')).toBeNull();
  });

  // The lying connection: captive portal or dead-upstream gym wifi, where
  // NetInfo says online and the search fails for real. The boards picker has
  // always counted that as no connection (isLocalOnly); this screen used to fall
  // through to the generic "no climbs", which reads as a broken search.
  it('offers the download when the connection lies and the search fails', async () => {
    mocks.isOffline = false;
    mocks.searchFailed = true;
    mocks.offlineCatalog = 'missing';

    const { findByText } = render(<ClimbList />);

    expect(await findByText('mobile.emptyState.offlineNoCatalog.title')).toBeTruthy();
  });

  // A search that failed but returned rows from a previous page is not an empty
  // state at all, and a working search that finds nothing is still "no climbs".
  it('keeps the generic empty state when the search simply found nothing', async () => {
    mocks.isOffline = false;
    mocks.searchFailed = false;
    mocks.offlineCatalog = 'missing';

    const { findByText, queryByText } = render(<ClimbList />);

    expect(await findByText('mobile.emptyState.noClimbs.title')).toBeTruthy();
    expect(queryByText('mobile.emptyState.offlineNoCatalog.title')).toBeNull();
  });
});

// A board switch renames the screen the instant the choice commits, and the new
// gym board switcher makes that a one-tap action. Whatever is left over from the
// board before it then reads as the new board's climbs, so the resolving window
// has to show placeholders, never rows.
describe('ClimbList board switch', () => {
  it('shows no climb rows while a per-board restore is still in flight', async () => {
    // A restore that never lands: the screen does not yet know which climbs
    // belong to this board, so it must not keep showing the ones it had.
    mocks.getLastSearch.mockReturnValue(new Promise(() => {}));

    const { queryByText } = render(<ClimbList />);

    await waitFor(() => expect(mocks.getLastSearch).toHaveBeenCalled());
    expect(queryByText('Moonage')).toBeNull();
    expect(queryByText('Zenith')).toBeNull();
    // ...and not the premature "no climbs" placard either: a board mid-restore
    // has not searched yet, so it has found nothing to report.
    expect(queryByText('mobile.emptyState.noClimbs.title')).toBeNull();
  });

  // The screen used to early-return a full-screen spinner here, which took the
  // chrome and the search header down with it. On a one-tap hop between two
  // boards in one room that reads as the app falling over, so the list stays
  // mounted and the rows become skeletons.
  it('keeps the list mounted and shows skeleton rows while the board resolves', async () => {
    mocks.getLastSearch.mockReturnValue(new Promise(() => {}));

    const { container } = render(<ClimbList />);

    await waitFor(() => expect(mocks.getLastSearch).toHaveBeenCalled());
    // Skeleton rows come from the list's own empty component, so their presence
    // is also the proof that the list itself is still mounted rather than
    // replaced wholesale by a spinner.
    expect(container.querySelectorAll('[data-skeleton-row]').length).toBeGreaterThan(0);
  });

  // The risk the resolving window introduces at the other end: with no board
  // bound there is nothing to resolve, and a climber parked on skeletons forever
  // would never reach the button that binds one.
  it('lands on the no-board empty state instead of skeletons when no board is bound', async () => {
    mocks.activeBoard = null;
    mocks.searchClimbs = [];

    const { findByText, container } = render(<ClimbList />);

    expect(await findByText('mobile.emptyState.noBoard.title')).toBeTruthy();
    expect(container.querySelectorAll('[data-skeleton-row]')).toHaveLength(0);
  });
});

describe('ClimbList keyboard handling', () => {
  it('dismisses the climb-name keyboard before activating a pressed climb', async () => {
    const { findByText } = render(<ClimbList />);

    fireEvent.click(await findByText('Moonage'));

    expect(mocks.dismissKeyboard).toHaveBeenCalledTimes(1);
    expect(mocks.activateClimb).toHaveBeenCalledWith({ uuid: 'climb-1' });
    // Logbook is fetched for every visible row, not just the pressed one — the
    // default fixture now has two climbs (added for the rank-tracking tests).
    await waitFor(() => expect(mocks.getLogbook).toHaveBeenCalledWith(['climb-1', 'climb-2']));
  });
});

// Joining a crew changes what a row tap means: it browses instead of taking
// everyone's wall. The screen decides that, and the drawer never sees the tap, so
// nothing downstream can catch a regression here.
describe('ClimbList shared-session row taps', () => {
  it('routes a tap through the activation hook in browse mode', async () => {
    mocks.isSharedSession = true;
    const { findByText } = render(<ClimbList />);

    fireEvent.click(await findByText('Moonage'));

    // Through the hook — not the bare preview open — because only the hook can
    // seed these results as the drawer's swipe track.
    expect(mocks.activateClimb).toHaveBeenCalledWith({ uuid: 'climb-1' });
    expect(mocks.openPlayDrawer).not.toHaveBeenCalled();
    // The flag that makes that activation view-only. Without it the hook commits.
    expect(mocks.activationOptions?.previewOnly).toBe(true);
  });

  it('browses in a crew even when the climber has tap-lighting ON', async () => {
    mocks.isSharedSession = true;
    mocks.lightOnClimbTap = true;
    const { findByText } = render(<ClimbList />);

    fireEvent.click(await findByText('Moonage'));

    expect(mocks.activationOptions?.previewOnly).toBe(true);
  });

  // The setting is about the climber's own board; the crew rule is about
  // everyone else's. With lighting off AND a crew, the tap must still take the
  // seeded path rather than the bare preview open, or swiping on from it would
  // walk the queue instead of the results.
  it('prefers the seeded browse over the bare preview when both reasons apply', async () => {
    mocks.isSharedSession = true;
    mocks.lightOnClimbTap = false;
    const { findByText } = render(<ClimbList />);

    fireEvent.click(await findByText('Moonage'));

    expect(mocks.openPlayDrawer).not.toHaveBeenCalled();
    expect(mocks.activateClimb).toHaveBeenCalledWith({ uuid: 'climb-1' });
    expect(mocks.activationOptions?.previewOnly).toBe(true);
  });

  it('leaves a solo tap committing', async () => {
    mocks.isSharedSession = false;
    const { findByText } = render(<ClimbList />);

    fireEvent.click(await findByText('Moonage'));

    expect(mocks.activateClimb).toHaveBeenCalledWith({ uuid: 'climb-1' });
    expect(mocks.activationOptions?.previewOnly).toBe(false);
  });
});

describe('ClimbList lightOnClimbTap setting', () => {
  it('opens the pressed climb as a view-only preview instead of activating it when the setting is off', async () => {
    mocks.lightOnClimbTap = false;
    const { findByText } = render(<ClimbList />);

    fireEvent.click(await findByText('Moonage'));

    expect(mocks.openPlayDrawer).toHaveBeenCalledTimes(1);
    const [openedClimb, options] = mocks.openPlayDrawer.mock.calls[0];
    expect(openedClimb).toBe(mocks.climb);
    expect(options?.previewQueueItem?.climb?.uuid).toBe('climb-1');
    // Doesn't touch the queue or the board — no commit, no BLE re-arm.
    expect(mocks.activateClimb).not.toHaveBeenCalled();
  });
});

// The App Store capture drives the app by deep link rather than coordinate taps
// (Maestro can't reliably match RN rows on this iOS build). These two params are
// the only way into the drawer's wall-state shots, so a silent regression here
// ships a store screenshot of the wrong state.
describe('ClimbList screenshot-mode wall-state deep links', () => {
  const withScreenshotMode = async (run: () => Promise<void>) => {
    const original = process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    try {
      await run();
    } finally {
      if (original === undefined) delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
      else process.env.EXPO_PUBLIC_SCREENSHOT_MODE = original;
    }
  };

  it('opens the first climb as a browse preview for the browsing shot', async () => {
    await withScreenshotMode(async () => {
      mocks.searchParams = { screenshotOpenPreview: '1' };
      render(<ClimbList />);

      await waitFor(() => expect(mocks.openPlayDrawer).toHaveBeenCalledTimes(1));
      const [openedClimb, options] = mocks.openPlayDrawer.mock.calls[0];
      expect(openedClimb).toBe(mocks.climb);
      expect(options?.previewQueueItem?.climb?.uuid).toBe('climb-1');
      // Browsing, not on the wall — otherwise the shot shows the wrong pill.
      expect(options?.previewIsWallClimb).toBe(false);
      // A preview commits nothing, so the capture can't drift into the queue.
      expect(mocks.activateClimb).not.toHaveBeenCalled();
      // The drawer only claims "Browsing" while a swipe genuinely stays
      // view-only, so the capture puts the device in that state rather than
      // photographing a promise the app wouldn't keep.
      expect(mocks.setSetting).toHaveBeenCalledWith('lightOnSwipe', false);
      // And the one-shot card that same setting triggers is spent up front: a
      // store shot is the steady state, not a climber's first five seconds.
      expect(mocks.setSetting).toHaveBeenCalledWith('browseNoticeSeen', true);
    });
  });

  it('marks the preview as the lit climb for the on-the-wall shot', async () => {
    await withScreenshotMode(async () => {
      mocks.searchParams = { screenshotOpenWallPreview: '1' };
      render(<ClimbList />);

      await waitFor(() => expect(mocks.openPlayDrawer).toHaveBeenCalledTimes(1));
      const [, options] = mocks.openPlayDrawer.mock.calls[0];
      expect(options?.previewIsWallClimb).toBe(true);
      expect(mocks.activateClimb).not.toHaveBeenCalled();
      // The on-the-wall pill comes from displayed-equals-lit, not from the
      // latch, so this shot leaves the climber's own setting alone.
      expect(mocks.setSetting).not.toHaveBeenCalled();
    });
  });

  it('leaves the plain climb list alone', async () => {
    await withScreenshotMode(async () => {
      const { findByText } = render(<ClimbList />);
      await findByText('Moonage');

      expect(mocks.openPlayDrawer).not.toHaveBeenCalled();
    });
  });
});

describe('ClimbList search result selection', () => {
  // Pressing a row activates the climb but emits NO per-press analytics event.
  // `Search Result Selected` fired here on every tap (53.8k events / 30 days)
  // and no insight ever read it; `Climb Search Performed` still covers search.
  it('activates a pressed result without firing a per-result event', async () => {
    const { findByText } = render(<ClimbList />);

    fireEvent.click(await findByText('Zenith'));

    expect(mocks.activateClimb).toHaveBeenCalled();
    expect(mocks.track).not.toHaveBeenCalledWith('Search Result Selected', expect.anything());
  });
});

const ACTIVE_TALL_FILTER_STATE = {
  filters: { status: 'any', boulders: true, routes: false, onlyTallClimbs: true },
  boardFilters: {},
  name: 'no such climb',
};

describe('ClimbList zero-result filter snapshot', () => {
  it('attaches the zero-result filter snapshot when the search comes up empty', async () => {
    mocks.searchClimbs = [];
    mocks.searchState = ACTIVE_TALL_FILTER_STATE;

    render(<ClimbList />);

    await waitFor(() =>
      expect(mocks.track).toHaveBeenCalledWith(
        'Climb Search Performed',
        expect.objectContaining({
          resultCount: 0,
          zeroResultOnlyTallClimbs: true,
          zeroResultStatus: 'any',
          zeroResultBoulders: true,
          zeroResultRoutes: false,
        }),
      ),
    );
  });

  it('omits the zero-result snapshot fields when results are found', async () => {
    mocks.searchClimbs = [mocks.climb];
    mocks.searchState = ACTIVE_TALL_FILTER_STATE;

    render(<ClimbList />);

    await waitFor(() => expect(mocks.track).toHaveBeenCalledWith('Climb Search Performed', expect.anything()));

    const [, properties] = mocks.track.mock.calls.find(([eventName]) => eventName === 'Climb Search Performed') ?? [];
    expect(properties).toMatchObject({ resultCount: 1 });
    expect(properties).not.toHaveProperty('zeroResultOnlyTallClimbs');
    expect(properties).not.toHaveProperty('zeroResultStatus');
  });
});

// Regression guard for #3191: the native Android image loader was getting a
// hard 403 from the CDN/WAF fetching board-art PNGs directly (fixed by
// #2633, which replaced an `Image.prefetch(url)` pre-warm with the bundled
// `ensureBackgroundsCached` asset lookup — see the effect's comment in
// ../index.tsx). This locks that behaviour in so a future edit to the
// pre-warm effect can't silently reintroduce a network board-art fetch.
describe('ClimbList board-art pre-warm (#3191 regression guard)', () => {
  it('pre-warms the bundled board background for the active board and never calls Image.prefetch', async () => {
    render(<ClimbList />);

    await waitFor(() =>
      expect(mocks.ensureBackgroundsCached).toHaveBeenCalledWith({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: [1],
        colorScheme: 'light',
      }),
    );

    expect(mocks.imagePrefetch).not.toHaveBeenCalled();
  });
});

// The row highlight is the only feedback a climber gets that a tap landed. It
// used to read the queue's current climb alone, which by construction only moves
// when the queue does — so once a tap could open a view-only preview instead of
// committing, tapping down a filtered list highlighted nothing at all and read as
// a dead list.
describe('ClimbList row highlight', () => {
  it('follows the queue\u2019s current climb when nothing is being previewed', async () => {
    mocks.activeClimbUuid.mockReturnValue(mocks.climb.uuid);
    const { findByText } = render(<ClimbList />);

    expect((await findByText('Moonage')).getAttribute('data-selected')).toBe('true');
    expect((await findByText('Zenith')).getAttribute('data-selected')).toBe('false');
  });

  it('follows the previewed climb when a tap opened one instead of committing', async () => {
    // The crew case: the queue never moved, so `activeClimbUuid` still names the
    // climb that was up before the tap. The highlight has to follow the tap.
    mocks.activeClimbUuid.mockReturnValue(mocks.climb.uuid);
    mocks.previewedClimbUuid.mockReturnValue(mocks.secondClimb.uuid);
    const { findByText } = render(<ClimbList />);

    expect((await findByText('Zenith')).getAttribute('data-selected')).toBe('true');
    // Exactly one row is selected — the previewed uuid clears itself on the next
    // committing open, so the two can never both claim a row.
    expect((await findByText('Moonage')).getAttribute('data-selected')).toBe('false');
  });
});
