// @vitest-environment jsdom
import { fireEvent, render, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';

const mocks = vi.hoisted(() => ({
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
  searchState: {
    filters: {} as Record<string, unknown>,
    boardFilters: {} as Record<string, unknown>,
    name: '',
  },
  // Offline empty-state fixtures: connectivity, whether the search itself
  // failed, and what the active board's catalog looks like on this device.
  isOffline: false,
  searchFailed: false,
  offlineCatalog: null as 'missing' | 'queued' | null,
  activateClimb: vi.fn(),
  openPlayDrawer: vi.fn(),
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
};

vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', testID ? { 'data-testid': testID } : null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
  RefreshControl: () => createElement('div', { 'data-refresh-control': 'true' }),
  Keyboard: { dismiss: mocks.dismissKeyboard },
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
  }: FlashListProps<Item>) =>
    createElement(
      'div',
      { 'data-testid': 'flash-list' },
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
  useRouter: () => ({ push: vi.fn() }),
  useLocalSearchParams: () => mocks.searchParams,
  useFocusEffect: () => {},
}));

// The onboarding reveal banner + its storage pull expo-haptics / expo-secure-store
// (expo-modules-core EventEmitter) into the graph — irrelevant to the keyboard
// test, so stub both.
vi.mock('../../../../src/components/onboarding/OnboardingTipBanner', () => ({
  OnboardingTipBanner: () => null,
}));
vi.mock('../../../../src/lib/onboarding/onboarding-storage', () => ({
  hasBoardRevealTipPending: vi.fn(async () => false),
  clearBoardRevealTipPending: vi.fn(async () => {}),
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
  ClimbListRow: ({ climb: rowClimb, onPress }: { climb: Climb; onPress?: (pressedClimb: Climb) => void }) =>
    createElement('button', { onClick: () => onPress?.(rowClimb) }, rowClimb.name),
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
    openClimbActions: vi.fn(),
    openAddToPlaylist: vi.fn(),
    openBoardSheet: vi.fn(),
    openPlayDrawer: mocks.openPlayDrawer,
  }),
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
  useActiveClimbUuid: () => null,
  useQueueActions: () => ({ addToQueue: vi.fn() }),
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
vi.mock('../../../../src/hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGradeByDifficultyId: (difficultyId: number) => String(difficultyId) }),
}));

// Stub the SecureStore-backed last-used-grade hook so the screen test doesn't
// pull in expo-secure-store / expo-modules-core (matches the last-search mock).
vi.mock('../../../../src/hooks/use-last-used-grade', () => ({
  useLastUsedGrade: () => ({ lastUsedGrade: undefined, rememberGrade: vi.fn() }),
}));

vi.mock('../../../../src/lib/graphql/hooks/use-infinite-search-climbs', () => ({
  useInfiniteSearchClimbs: () => ({
    data: { pages: [{ climbs: mocks.searchClimbs, hasMore: false }] },
    isLoading: false,
    isError: mocks.searchFailed,
    isFetchingNextPage: false,
    isRefetching: false,
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
  usePlaylistActivation: () => ({
    activate: mocks.activateClimb,
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
  useActiveBoard: () => ({
    data: { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1', angle: 40 },
    isLoading: false,
  }),
  useSetActiveBoard: () => async () => {},
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
vi.mock('@boardsesh/board-presence-react', () => ({ useBoardPresenceLayers: () => null }));
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
  mocks.searchState = { filters: {}, boardFilters: {}, name: '' };
  mocks.isOffline = false;
  mocks.searchFailed = false;
  mocks.offlineCatalog = null;
  mocks.searchParams = {};
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
