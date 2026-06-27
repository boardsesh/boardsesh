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
  activateClimb: vi.fn(),
  dismissKeyboard: vi.fn(),
  getLastSearch: vi.fn(),
  saveLastSearch: vi.fn(),
  getRecentFilters: vi.fn(),
  getLogbook: vi.fn(),
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
  SHARED_EVENTS: { ClimbSearchPerformed: 'Climb Search Performed' },
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

vi.mock('../../../../src/components/search/ClimbFilterFab', () => ({ ClimbFilterFab: () => null }));
vi.mock('../../../../src/components/search/ClimbTopChrome', () => ({ ClimbTopChrome: () => null }));
vi.mock('../../../../src/components/RecentFilterPills', () => ({ RecentFilterPills: () => null }));
vi.mock('../../../../src/components/search/FilterTokenRow', () => ({ FilterTokenRow: () => null }));
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

vi.mock('../../../../src/lib/graphql/hooks/use-infinite-search-climbs', () => ({
  useInfiniteSearchClimbs: () => ({
    data: { pages: [{ climbs: [mocks.climb], hasMore: false }] },
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
vi.mock('../../../../src/lib/analytics', () => ({ track: vi.fn() }));
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
});

describe('ClimbList keyboard handling', () => {
  it('dismisses the climb-name keyboard before activating a pressed climb', async () => {
    const { findByText } = render(<ClimbList />);

    fireEvent.click(await findByText('Moonage'));

    expect(mocks.dismissKeyboard).toHaveBeenCalledTimes(1);
    expect(mocks.activateClimb).toHaveBeenCalledWith({ uuid: 'climb-1' });
    await waitFor(() => expect(mocks.getLogbook).toHaveBeenCalledWith(['climb-1']));
  });
});
