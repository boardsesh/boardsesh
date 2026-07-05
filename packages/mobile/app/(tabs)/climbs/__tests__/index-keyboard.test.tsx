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
  activateClimb: vi.fn(),
  dismissKeyboard: vi.fn(),
  getLastSearch: vi.fn(),
  saveLastSearch: vi.fn(),
  getRecentFilters: vi.fn(),
  getLogbook: vi.fn(),
  track: vi.fn(),
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
  useLocalSearchParams: () => ({}),
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
}));

vi.mock('../../../../src/theme/variants', () => ({
  selectByVariant: (_variant: string, options: { liquidGlass: boolean }) => options.liquidGlass,
}));

vi.mock('../../../../src/providers/queue-provider', () => ({
  useActiveClimbUuid: () => null,
  useQueueActions: () => ({ addToQueue: vi.fn() }),
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
vi.mock('../../../../src/lib/background-image-cache', () => ({ ensureBackgroundsCached: vi.fn() }));

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
  mocks.activateClimb.mockClear();
  mocks.dismissKeyboard.mockClear();
  mocks.getLogbook.mockClear();
  mocks.getLastSearch.mockReset();
  mocks.saveLastSearch.mockReset();
  mocks.getRecentFilters.mockReset();
  mocks.getLastSearch.mockResolvedValue(null);
  mocks.saveLastSearch.mockResolvedValue(undefined);
  mocks.getRecentFilters.mockResolvedValue([]);
  mocks.track.mockClear();
  mocks.searchClimbs = [mocks.climb, mocks.secondClimb];
  mocks.searchState = { filters: {}, boardFilters: {}, name: '' };
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

describe('ClimbList search result selection tracking', () => {
  it('tracks the rank of the first result when it is pressed', async () => {
    const { findByText } = render(<ClimbList />);

    fireEvent.click(await findByText('Moonage'));

    expect(mocks.track).toHaveBeenCalledWith(
      'Search Result Selected',
      expect.objectContaining({ rank: 0, loadedResultCount: 2, boardName: 'kilter', angle: 40 }),
    );
  });

  it('tracks the rank of a later result when it is pressed', async () => {
    const { findByText } = render(<ClimbList />);

    fireEvent.click(await findByText('Zenith'));

    expect(mocks.track).toHaveBeenCalledWith(
      'Search Result Selected',
      expect.objectContaining({ rank: 1, loadedResultCount: 2, boardName: 'kilter', angle: 40 }),
    );
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
