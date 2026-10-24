// @vitest-environment jsdom
vi.mock('../../../../src/components/AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../../src/hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../../../src/components/PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement, useEffect, useImperativeHandle, type ReactNode, type Ref } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb, Grade } from '@boardsesh/shared-schema';
import type { ScreenshotSelectableBoard } from '../../../../src/lib/screenshot-board-selection';
import type { NativeStackNavigationOptions } from 'expo-router';
import type { ScrollEdgeBackdrop } from '../../../../src/hooks/use-scroll-edge-backdrop';
import type { ClimbFilterSheet } from '../../../../src/components/ClimbFilterSheet';
import { DEFAULT_FILTERS, type ClimbFilters } from '../../../../src/lib/climb-filter-types';
import type { LastSearch } from '../../../../src/lib/last-search-store';
import type { BoardSearchConfig, ClimbBoardFilterState } from '@boardsesh/climb-filters';
import { hasActiveClimbFilters } from '@boardsesh/climb-filters';
import type { FilterChipRowProps } from '../../../../src/components/search/FilterChipRow.types';
import type { RecentFilter } from '../../../../src/lib/recent-filter-store';

type FilterSheetProps = Parameters<typeof ClimbFilterSheet>[0];

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
    | { uuid?: string; boardType: string; layoutId: number; sizeId: number; setIds: string; angle: number }
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
  statefulSearch: false,
  searchListeners: new Set<() => void>(),
  setName: vi.fn(),
  replaceSearch: vi.fn(),
  filterSheetProps: undefined as FilterSheetProps | undefined,
  searchInput: undefined as { filters: unknown; boardFilters: unknown; name: string } | undefined,
  searchClimbsForInput: null as
    | ((input: { filters: unknown; boardFilters: unknown; name: string } | undefined) => Climb[])
    | null,
  carrySearchGeometry: false,
  screenshotBoards: [] as ScreenshotSelectableBoard[],
  grades: [] as Grade[],
  gradesLoaded: true,
  gradesPlaceholder: false,
  isAuthenticated: true,
  // Offline empty-state fixtures: connectivity, whether the search itself
  // failed, and what the active board's catalog looks like on this device.
  isOffline: false,
  searchFailed: false,
  searchError: null as Error | null,
  refetchClimbs: vi.fn(),
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
  addRecentFilter: vi.fn(),
  clearRecentFilters: vi.fn(),
  // The props the filter chip row was last drawn with.
  chipRowProps: undefined as FilterChipRowProps | undefined,
  tickBatch: vi.fn(),
  holdInteractions: false,
  track: vi.fn(),
  ensureBackgroundsCached: vi.fn(),
  imagePrefetch: vi.fn(),
  nativeRootHeader: true,
  nativeSearch: false,
  renderNativeChrome: false,
  // Render the chrome's filter rows (chips, grade rail, tokens) and hand the test
  // the Grade chip's open/close callbacks.
  renderFilterChrome: false,
  // Material renders its own grade rail inside the top chrome.
  filtersInTopChrome: false,
  deviceLayout: { isPad: false, isTablet: false, widthClass: 'compact' },
  openGrade: undefined as (() => void) | undefined,
  closeGrade: undefined as (() => void) | undefined,
  // What the chrome calls when the screen loses focus or search takes focus.
  dismissGradePopover: undefined as (() => void) | undefined,
  focusSearch: undefined as (() => void) | undefined,
  openFilters: undefined as (() => void) | undefined,
  openFiltersFromChips: undefined as (() => void) | undefined,
  // Whether the chrome was told to draw its own (Material) grade rail.
  chromeGradeRailVisible: undefined as boolean | undefined,
  // The chrome's height report: the controls block under the UIKit header, or the
  // whole floating / Material chrome.
  reportChromeHeight: undefined as ((height: number) => void) | undefined,
  // The scroll-edge store the top chrome was handed (its blur reads it), the
  // scroll listeners the list was handed (they write it), and how often the
  // chrome was rendered, which is how often the screen was.
  chromeScrollEdge: undefined as ScrollEdgeBackdrop | undefined,
  listScrollProps: {} as Partial<ScrollEdgeBackdrop['listProps']>,
  listCommitLayout: undefined as (() => void) | undefined,
  chromeRenders: 0,
  // The persisted "grade row shown" setting, as a store the screen re-renders
  // from: `set` is the write that keeps the choice across launches.
  gradeRow: {
    shown: false,
    listeners: new Set<() => void>(),
    set: vi.fn<(shown: boolean) => void>(),
  },
  // The change the grade rail reports, so a test can make one.
  changeGrade: undefined as
    | ((
        next: { minGradeId: number | undefined; maxGradeId: number | undefined },
        change: { gesture: string; withinRangeWindow?: boolean },
      ) => void)
    | undefined,
  setGrade: vi.fn(),
  // How many times the screen has come back into focus.
  refocusCount: 0,
  scrollToOffset: vi.fn(),
  stackOptions: [] as NativeStackNavigationOptions[],
  // The system text size, and whether the list is fetching another page: the
  // two things besides the climber's row switches that size the placeholders.
  fontScale: 1,
  isFetchingNextPage: false,
  // Whether the scroll-ahead thumbnail warm-up is mounted right now.
  thumbnailPrewarmMounted: false,
}));

type FlashListProps<Item> = {
  ref?: Ref<{ scrollToOffset: (params: { offset: number; animated?: boolean }) => void }>;
  scrollToOverflowEnabled?: boolean;
  onCommitLayoutEffect?: () => void;
  contentContainerStyle?: { paddingTop: number };
  data?: Item[];
  renderItem?: (info: { item: Item; index: number }) => ReactNode;
  ListHeaderComponent?: ReactNode;
  ListFooterComponent?: ReactNode;
  ListEmptyComponent?: ReactNode;
  refreshControl?: ReactNode;
} & Partial<ScrollEdgeBackdrop['listProps']>;

vi.mock('react-native', () => ({
  Pressable: ({ children, onPress, disabled }: { children?: ReactNode; onPress?: () => void; disabled?: boolean }) =>
    createElement('button', { onClick: disabled ? undefined : onPress }, children),
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', testID ? { 'data-testid': testID } : null, children),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    absoluteFill: {},
    hairlineWidth: 1,
  },
  RefreshControl: ({ refreshing, progressViewOffset }: { refreshing?: boolean; progressViewOffset?: number }) =>
    createElement('div', {
      'data-refresh-control': 'true',
      'data-refreshing': String(!!refreshing),
      'data-progress-view-offset': progressViewOffset,
    }),
  Keyboard: { dismiss: mocks.dismissKeyboard },
  // The screen reads Platform.OS at module load (the iOS-only Tall/Wide lock).
  Platform: { OS: 'ios' },
  // The placeholder rows are counted for the climber's text size.
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: mocks.fontScale }),
  // No `Image.prefetch` should ever fire for board art (#3191 — the native
  // Android image loader gets a 403 from the CDN/WAF for direct board-art
  // fetches). Exposed here so the pre-warm test can assert it stays unused.
  Image: { prefetch: mocks.imagePrefetch },
  // Run deferred work synchronously in tests; the prewarm + background-cache
  // effects schedule through InteractionManager.runAfterInteractions in the screen.
  InteractionManager: {
    runAfterInteractions: (callback: () => void) => {
      if (!mocks.holdInteractions) callback();
      return { cancel: () => undefined };
    },
  },
}));
vi.mock('../../../../src/hooks/use-device-layout', () => ({
  useDeviceLayout: () => mocks.deviceLayout,
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: <Item,>({
    ref,
    scrollToOverflowEnabled = false,
    data = [],
    renderItem,
    ListHeaderComponent,
    ListFooterComponent,
    ListEmptyComponent,
    refreshControl,
    onScroll,
    onScrollBeginDrag,
    onScrollEndDrag,
    onMomentumScrollBegin,
    onMomentumScrollEnd,
    onCommitLayoutEffect,
    contentContainerStyle,
  }: FlashListProps<Item>) => {
    mocks.listCommitLayout = onCommitLayoutEffect;
    mocks.listScrollProps = {
      onScroll,
      onScrollBeginDrag,
      onScrollEndDrag,
      onMomentumScrollBegin,
      onMomentumScrollEnd,
    };
    useImperativeHandle(ref, () => ({ scrollToOffset: mocks.scrollToOffset }), []);
    return createElement(
      'div',
      {
        'data-testid': 'flash-list',
        'data-scroll-to-overflow': String(scrollToOverflowEnabled),
        'data-padding-top': contentContainerStyle?.paddingTop,
      },
      refreshControl,
      ListHeaderComponent,
      data.length > 0
        ? data.map((item, index) => createElement('div', { key: index }, renderItem?.({ item, index })))
        : ListEmptyComponent,
      ListFooterComponent,
    );
  },
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
  Stack: {
    Screen: ({ options }: { options: NativeStackNavigationOptions }) => {
      mocks.stackOptions.push(options);
      return null;
    },
  },
  useRouter: () => ({ push: mocks.push }),
  useLocalSearchParams: () => mocks.searchParams,
  useFocusEffect: () => {},
}));
vi.mock('expo-router/react-navigation', async () => {
  const { createContext } = await import('react');
  return {
    useHeaderHeight: () => 100,
    useFrameSize: (selector: (frame: { width: number; height: number }) => number) =>
      selector({ width: 390, height: 844 }),
    HeaderHeightContext: createContext<number | undefined>(100),
  };
});
vi.mock('../../../../src/hooks/use-native-root-header', () => ({ useNativeRootHeader: () => mocks.nativeRootHeader }));
vi.mock('../../../../src/hooks/use-glass-capability', () => ({ useGlassCapability: () => true }));

// The onboarding reveal banner + its storage pull expo-haptics / expo-secure-store
// (expo-modules-core EventEmitter) into the graph — irrelevant to the keyboard
// test, so stub both.
vi.mock('../../../../src/components/onboarding/OnboardingTipBanner', () => ({
  OnboardingTipBanner: () => null,
}));
// The connect-step card has its own suite; it reaches the Bluetooth provider,
// which this suite has no reason to load.
// The archived-wall notice is its own component with its own tests; these cases
// are about the keyboard.
vi.mock('../../../../src/components/spray-wall/SprayWallArchivedBanner', () => ({
  SprayWallArchivedBanner: () => null,
}));
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
// Membership recovery uses QueryClient; this keyboard harness has no provider.
vi.mock('../../../../src/hooks/use-climb-list-playlist-memberships', () => ({
  useClimbListPlaylistMemberships: () => {},
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'queue-item-1' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('@boardsesh/analytics', () => ({
  SHARED_EVENTS: {
    ClimbSearchPerformed: 'Climb Search Performed',
    SearchResultSelected: 'Search Result Selected',
    GradeFilterChanged: 'Grade Filter Changed',
    GradeRowToggled: 'Grade Row Toggled',
  },
}));

vi.mock('@boardsesh/climb-filters', async (importOriginal) => {
  const original = await importOriginal<typeof import('@boardsesh/climb-filters')>();
  return {
    hasActiveClimbFilters: original.hasActiveClimbFilters,
    normalizeRetiredFilters: original.normalizeRetiredFilters,
    DEFAULT_CLIMB_FILTER_STATE: {},
    DEFAULT_CLIMB_BOARD_FILTER_STATE: {},
    // Carries the filters through, so a changed filter is a changed search.
    toClimbSearchInput: (filters: unknown, board: BoardSearchConfig, _page: unknown, options: { name: string }) => ({
      filters,
      ...(mocks.carrySearchGeometry ? board : {}),
      name: options.name,
    }),
    mergeBoardFilters: (input: { filters: unknown; name: string }, boardFilters: unknown) => ({
      ...input,
      boardFilters,
    }),
    countActiveFilters: () => 0,
    hasActiveBoardFilters: () => false,
    // Consumed by filter-chip-menus (imported via index.tsx for the chip row).
    SORT_OPTIONS: ['ascents', 'quality', 'difficulty', 'name', 'popular', 'creation'],
    // "Your progress" selector wiring for the persistent chip row.
    flagsToProgress: () => 'all',
    progressToFlags: () => ({}),
    // The shared climb-type and sort patches the chip row and sheet commit through.
    getClimbTypeFilter: original.getClimbTypeFilter,
    climbTypePatch: original.climbTypePatch,
    sortKeyPatch: original.sortKeyPatch,
    CLIMB_TYPE_VALUES: original.CLIMB_TYPE_VALUES,
  };
});

vi.mock('@boardsesh/board-react', () => ({
  // The screen's screenshot-mode whole-list stats prefetch reads the adapter.
  // It no-ops outside screenshot mode; these keep the module resolvable.
  useBoardAdapter: () => ({ isAuthenticated: false }),
  prefetchClimbStatsForClimbs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../src/providers/climb-list-tick-display-provider', () => ({
  ClimbListTickDisplayProvider: ({ climbUuids, children }: { climbUuids: readonly string[]; children: ReactNode }) => {
    mocks.tickBatch(climbUuids);
    return children;
  },
}));
// Rows and their tick leaves are stubbed in this keyboard/layout harness, which
// mounts no query/auth providers. The real loader has its own integration suite.
vi.mock('../../../../src/providers/climb-progress-provider', () => ({
  ClimbProgressProvider: ({ children }: { children: ReactNode }) => children,
}));

// Reads mocks.searchState (mutated per-test) instead of the real reducer, so a
// test can force a specific filter/name without driving the UI through it.
vi.mock('../../../../src/providers/climb-search-provider', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => {
    mocks.searchListeners.add(listener);
    return () => mocks.searchListeners.delete(listener);
  };
  return {
    ClimbSearchProvider: ({ children }: { children?: ReactNode }) => children,
    useClimbSearch: () => ({
      ...useSyncExternalStore(subscribe, () => mocks.searchState),
      setFilters: vi.fn(),
      setBoardFilters: vi.fn(),
      setGrade: mocks.setGrade,
      setName: mocks.setName,
      replaceSearch: mocks.replaceSearch,
      patchFilters: vi.fn(),
      patchBoardFilters: vi.fn(),
    }),
  };
});

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
  // What the screen tells a placeholder about the rows it stands in for is surfaced.
  ClimbListRowSkeleton: ({
    showPlaylistChips,
    supportsMirroring,
  }: {
    showPlaylistChips?: boolean;
    supportsMirroring?: boolean;
  }) =>
    createElement('div', {
      'data-skeleton-row': 'true',
      'data-tags': String(showPlaylistChips),
      'data-mirrors': String(supportsMirroring),
    }),
}));

// Both draw nothing: they warm board renders ahead of the scroll and at a tap.
// Mocked so this screen test does not pull the native render hook in. The
// thumbnail warm-up reports whether it is mounted, which is all a test can ask
// of a component that draws nothing.
vi.mock('../../../../src/components/ClimbListScrollAhead', () => ({
  ClimbListThumbnailPrewarmWindow: () => {
    useEffect(() => {
      mocks.thumbnailPrewarmMounted = true;
      return () => {
        mocks.thumbnailPrewarmMounted = false;
      };
    }, []);
    return null;
  },
  createVisibleRowsStore: () => ({ getFirst: () => 0, getLast: () => 0, set: () => {}, subscribe: () => () => {} }),
}));

vi.mock('../../../../src/components/play-drawer/PlayBoardPrewarmHost', () => ({
  PlayBoardPrewarmHost: () => null,
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
  ClimbFilterSheet: (props: FilterSheetProps) => {
    mocks.filterSheetProps = props;
    return createElement('div', { 'data-testid': 'filter-sheet' });
  },
  hasActiveFilters: (filters: ClimbFilters) => mocks.statefulSearch && hasActiveClimbFilters(filters),
}));

vi.mock('../../../../src/components/search/ClimbTopChrome', async () => {
  const { NativeRootHeader } = await import('../../../../src/components/chrome/NativeRootHeader');
  const { GradeRangeRail } = await import('../../../../src/components/grade');
  return {
    ClimbTopChrome: ({
      onHeightChange,
      filterChrome,
      onOpenGrade,
      onCloseGrade,
      onDismissGradePopover,
      onSearchFocus,
      onOpenFilters,
      gradeRailVisible,
      onGradeChange,
      gradeRecenterKey,
      scrollEdge,
    }: {
      scrollEdge?: ScrollEdgeBackdrop;
      onHeightChange: (height: number) => void;
      filterChrome?: ReactNode;
      onOpenGrade?: () => void;
      onCloseGrade?: () => void;
      onDismissGradePopover?: () => void;
      onSearchFocus?: () => void;
      onOpenFilters?: () => void;
      gradeRailVisible?: boolean;
      onGradeChange?: NonNullable<typeof mocks.changeGrade>;
      gradeRecenterKey?: number;
    }) => {
      mocks.openGrade = onOpenGrade;
      mocks.closeGrade = onCloseGrade;
      mocks.dismissGradePopover = onDismissGradePopover;
      mocks.focusSearch = onSearchFocus;
      mocks.openFilters = onOpenFilters;
      mocks.chromeGradeRailVisible = gradeRailVisible;
      mocks.reportChromeHeight = onHeightChange;
      mocks.chromeScrollEdge = scrollEdge;
      mocks.chromeRenders += 1;
      if (mocks.renderFilterChrome) {
        return createElement(
          'div',
          { 'data-testid': 'top-chrome' },
          filterChrome,
          !mocks.filtersInTopChrome && gradeRailVisible && onGradeChange
            ? createElement(GradeRangeRail, {
                grades: [],
                bound: { minGradeId: undefined, maxGradeId: undefined },
                onChange: onGradeChange,
                recenterKey: gradeRecenterKey,
              })
            : null,
        );
      }
      return mocks.renderNativeChrome
        ? createElement(NativeRootHeader, {
            centerContent: createElement('button', null, 'Current climb'),
            onHeightChange,
          })
        : null;
    },
  };
});
// Reports whether the Grade chip reads as open (its chevron), and renders the
// grade popover content, which regular-width iPad hands to the chip in place of
// the inline rail. A real popover draws that content only while presented.
vi.mock('../../../../src/components/search/FilterChipRow', () => ({
  FilterChipRow: (props: FilterChipRowProps) => {
    const { gradeRailOpen, gradePopoverContent, onOpenFilters } = props;
    mocks.chipRowProps = props;
    mocks.openFiltersFromChips = onOpenFilters;
    return createElement(
      'div',
      { 'data-testid': 'chip-row', 'data-grade-open': String(gradeRailOpen) },
      gradePopoverContent && gradeRailOpen
        ? createElement('div', { 'data-testid': 'grade-popover' }, gradePopoverContent)
        : null,
    );
  },
}));
vi.mock('../../../../src/components/RecentFilterPills', () => ({ RecentFilterPills: () => null }));
vi.mock('../../../../src/components/search/FilterTokenRow', () => ({ FilterTokenRow: () => null }));
vi.mock('../../../../src/lib/haptics', () => ({
  hapticSelection: () => {},
  hapticLight: () => {},
  hapticMedium: () => {},
  hapticHeavy: () => {},
  hapticSuccess: () => {},
}));
vi.mock('../../../../src/components/grade', () => ({
  GradeRangeRail: ({
    onChange,
    recenterKey,
  }: {
    onChange: NonNullable<typeof mocks.changeGrade>;
    recenterKey?: number;
  }) => {
    mocks.changeGrade = onChange;
    return createElement('div', { 'data-testid': 'grade-range-rail', 'data-recenter-key': String(recenterKey) });
  },
}));
// The rail's stops feed the filter tokens, which this suite mocks out.
vi.mock('../../../../src/lib/grade-stops', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../src/lib/grade-stops')>();
  return {
    buildGradeRailStops: (...args: Parameters<typeof original.buildGradeRailStops>) =>
      mocks.carrySearchGeometry ? original.buildGradeRailStops(...args) : [],
  };
});
vi.mock('../../../../src/hooks/use-refocus-count', () => ({ useRefocusCount: () => mocks.refocusCount }));

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
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: {
      background: '#fff',
      label: '#111',
      separator: '#ddd',
    },
    variant: 'liquidGlass',
    brandColors: { primary: '#6D28D9' },
    features: { filtersInTopChrome: mocks.filtersInTopChrome, summaryExcludesGradeFilter: false },
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

vi.mock('../../../../src/settings', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribeGradeRow = (listener: () => void) => {
    mocks.gradeRow.listeners.add(listener);
    return () => mocks.gradeRow.listeners.delete(listener);
  };
  return {
    useSetting: (key: string) => {
      // Read through a store, like the real hook, so a write re-renders the screen.
      const gradeRowShown = useSyncExternalStore(subscribeGradeRow, () => mocks.gradeRow.shown);
      if (key === 'gradeRowShown') return [gradeRowShown, mocks.gradeRow.set];
      return key === 'lightOnClimbTap' ? [mocks.lightOnClimbTap, vi.fn()] : [false, vi.fn()];
    },
    setSetting: mocks.setSetting,
  };
});

vi.mock('../../../../src/hooks/use-bottom-accessory', () => ({
  useNativeAccessoryActive: () => false,
  useLiquidGlassTabBar: () => mocks.nativeSearch,
}));
vi.mock('../../../../src/hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({
    scrollBottomPadding: 96,
    nativeAccessoryVisible: false,
    tabBarBottom: 0,
    floatingControlBottom: 0,
  }),
}));

vi.mock('../../../../src/lib/graphql/hooks', () => ({
  useGrades: () => ({ data: mocks.grades, isSuccess: mocks.gradesLoaded, isPlaceholderData: mocks.gradesPlaceholder }),
  useMyBoards: () => ({ data: undefined }),
}));
// Screenshot-only board roster. Real in a capture build; here it would be the
// screen's only live useQuery, and this test renders without a QueryClientProvider.
vi.mock('../../../../src/hooks/use-screenshot-boards', () => ({
  useScreenshotBoards: () => mocks.screenshotBoards,
}));
vi.mock('../../../../src/hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    gradeFormat: 'v-grade',
    formatGradeByDifficultyId: (difficultyId: number) => String(difficultyId),
  }),
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
  useInfiniteSearchClimbs: (input: typeof mocks.searchInput, enabled = true) => {
    mocks.searchInput = input;
    return {
      data: enabled
        ? { pages: [{ climbs: mocks.searchClimbsForInput?.(input) ?? mocks.searchClimbs, hasMore: false }] }
        : undefined,
      isLoading: enabled && mocks.isClimbsLoading,
      isError: mocks.searchFailed,
      error: mocks.searchError,
      isFetchingNextPage: mocks.isFetchingNextPage,
      isRefetching: mocks.isRefetching,
      isPlaceholderData: mocks.isPlaceholderData,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      refetch: mocks.refetchClimbs,
    };
  },
}));

vi.mock('../../../../src/lib/graphql/operations', () => ({ SEARCH_CLIMBS: 'SEARCH_CLIMBS' }));
vi.mock('../../../../src/lib/graphql/client', () => ({ getHttpClient: () => ({ request: vi.fn() }) }));
// Mock the interceptor module itself: its module-scope registry reads every
// registered document from `operations`, so loading the real module would make
// this test's partial operations mock load-bearing for future registrations.
vi.mock('../../../../src/lib/graphql/offline-request', () => ({ offlineAwareRequest: vi.fn() }));
// The player's list count reads the query cache, and these screens render
// without a QueryClientProvider. No test here reads the count.
vi.mock('../../../../src/lib/graphql/hooks/search-climbs-count-query', () => {
  const countNothing = async () => 0;
  return { useFetchCachedSearchClimbsCount: () => countNothing };
});
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
    addToQueue: { append: undefined, isAppending: false },
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

vi.mock('../../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: mocks.isAuthenticated }),
}));
vi.mock('../../../../src/lib/background-image-cache', () => ({
  ensureBackgroundsCached: mocks.ensureBackgroundsCached,
}));

vi.mock('../../../../src/lib/recent-filter-store', () => ({
  getRecentFilters: mocks.getRecentFilters,
  addRecentFilter: mocks.addRecentFilter,
  clearRecentFilters: mocks.clearRecentFilters,
}));

vi.mock('../../../../src/lib/last-search-store', () => ({
  getLastSearch: mocks.getLastSearch,
  saveLastSearch: mocks.saveLastSearch,
  boardConfigKey: (board: BoardSearchConfig) =>
    `${board.boardName}|${board.layoutId}|${board.sizeId}|${board.setIds}|${board.angle}`,
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
vi.mock('../../../../src/theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 2: 8 },
}));
vi.mock('../../../../src/theme/layout', () => ({ glassSize: { standard: 48 } }));
vi.mock('../../../../src/theme/animations', () => ({ timing: { normal: 180 } }));

import ClimbList from '../index';
import { setPinnedChips } from '../../../../src/lib/pinned-chips-store';
import { DEFAULT_PINNED_CHIPS } from '../../../../src/lib/pinnable-chips';
import { resetClimbRowDisplayForTests, setClimbRowField } from '../../../../src/lib/climb-row-display-preference';

beforeEach(() => {
  mocks.previewedClimbUuid.mockReturnValue(null);
  mocks.activeClimbUuid.mockReturnValue(null);
  mocks.activateClimb.mockClear();
  mocks.openPlayDrawer.mockClear();
  mocks.setSetting.mockClear();
  mocks.lightOnClimbTap = true;
  mocks.dismissKeyboard.mockClear();
  mocks.tickBatch.mockClear();
  mocks.holdInteractions = false;
  mocks.getLastSearch.mockReset();
  mocks.saveLastSearch.mockReset();
  mocks.getRecentFilters.mockReset();
  mocks.addRecentFilter.mockReset();
  mocks.clearRecentFilters.mockClear();
  mocks.chipRowProps = undefined;
  mocks.getLastSearch.mockResolvedValue(null);
  mocks.saveLastSearch.mockResolvedValue(undefined);
  mocks.getRecentFilters.mockResolvedValue([]);
  mocks.addRecentFilter.mockResolvedValue(undefined);
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
  mocks.statefulSearch = false;
  mocks.searchListeners.clear();
  mocks.filterSheetProps = undefined;
  mocks.searchInput = undefined;
  mocks.searchClimbsForInput = null;
  mocks.carrySearchGeometry = false;
  mocks.screenshotBoards = [];
  mocks.grades = [];
  mocks.gradesLoaded = true;
  mocks.gradesPlaceholder = false;
  mocks.isAuthenticated = true;
  mocks.setName.mockReset();
  mocks.setName.mockImplementation((name: string) => {
    if (!mocks.statefulSearch) return;
    mocks.searchState = { ...mocks.searchState, name };
    for (const listener of mocks.searchListeners) listener();
  });
  mocks.replaceSearch.mockReset();
  mocks.replaceSearch.mockImplementation(
    (filters: ClimbFilters, name: string, boardFilters: ClimbBoardFilterState = {}) => {
      if (!mocks.statefulSearch) return;
      mocks.searchState = { filters, boardFilters, name };
      for (const listener of mocks.searchListeners) listener();
    },
  );
  mocks.isOffline = false;
  mocks.searchFailed = false;
  mocks.searchError = null;
  mocks.refetchClimbs.mockReset();
  mocks.offlineCatalog = null;
  mocks.searchParams = {};
  mocks.isSharedSession = false;
  mocks.activationOptions = undefined;
  mocks.isPlaceholderData = false;
  mocks.isRefetching = false;
  mocks.nativeRootHeader = true;
  mocks.nativeSearch = false;
  mocks.renderNativeChrome = false;
  mocks.renderFilterChrome = false;
  mocks.filtersInTopChrome = false;
  mocks.deviceLayout = { isPad: false, isTablet: false, widthClass: 'compact' };
  mocks.openGrade = undefined;
  mocks.closeGrade = undefined;
  mocks.dismissGradePopover = undefined;
  mocks.focusSearch = undefined;
  mocks.openFilters = undefined;
  mocks.openFiltersFromChips = undefined;
  mocks.chromeGradeRailVisible = undefined;
  mocks.reportChromeHeight = undefined;
  mocks.chromeScrollEdge = undefined;
  mocks.listScrollProps = {};
  mocks.chromeRenders = 0;
  mocks.gradeRow.shown = false;
  mocks.gradeRow.listeners.clear();
  mocks.gradeRow.set.mockReset();
  mocks.gradeRow.set.mockImplementation((shown: boolean) => {
    mocks.gradeRow.shown = shown;
    for (const listener of mocks.gradeRow.listeners) listener();
  });
  mocks.changeGrade = undefined;
  mocks.setGrade.mockClear();
  mocks.refocusCount = 0;
  mocks.scrollToOffset.mockClear();
  mocks.stackOptions.length = 0;
  mocks.fontScale = 1;
  mocks.isFetchingNextPage = false;
  resetClimbRowDisplayForTests();
});

describe('ClimbList native header ownership', () => {
  it.each([true, false])(
    'keeps search setup from overriding the native title or pill (native search: %s)',
    (nativeSearch) => {
      mocks.nativeSearch = nativeSearch;
      mocks.renderNativeChrome = true;
      render(<ClimbList />);

      const screenOptions = mocks.stackOptions[0];
      expect(screenOptions).not.toHaveProperty('title');
      expect(screenOptions).not.toHaveProperty('headerLargeTitle');
      // Either setOptions registration order must preserve the real chrome's
      // pill policy instead of letting the search host restore a large title.
      for (const registrationOrder of [mocks.stackOptions, [...mocks.stackOptions].reverse()]) {
        const effectiveOptions = Object.assign({ title: 'Climbs', headerLargeTitle: true }, ...registrationOrder);
        expect(effectiveOptions).toMatchObject({ title: 'Climbs', headerLargeTitle: false });
        expect(typeof effectiveOptions.headerTitle).toBe('function');
      }
      if (nativeSearch) {
        expect(screenOptions.headerSearchBarOptions).toMatchObject({ placeholder: 'search.placeholders.climbs' });
      } else {
        expect(screenOptions.headerSearchBarOptions).toBeUndefined();
      }
    },
  );

  it.each([true, false])('preserves the legacy search host options (native search: %s)', (nativeSearch) => {
    mocks.nativeRootHeader = false;
    mocks.nativeSearch = nativeSearch;
    render(<ClimbList />);

    expect(mocks.stackOptions[0]).toMatchObject({
      headerShown: nativeSearch,
      headerLargeTitle: false,
      title: nativeSearch ? '' : 'mobile.nav.climbs',
    });
    if (nativeSearch) expect(mocks.stackOptions[0].headerBlurEffect).toBe('none');
  });

  it.each(['no-board', 'restore-error'] as const)('restores the route title when chrome leaves for %s', (fallback) => {
    mocks.nativeSearch = true;
    const { rerender } = render(<ClimbList />);
    const previousHeaderOptions: NativeStackNavigationOptions = {
      title: 'Climbs',
      headerLargeTitle: false,
      headerTitle: () => 'Current climb',
    };
    mocks.stackOptions.length = 0;
    mocks.activeBoard = fallback === 'no-board' ? null : undefined;
    mocks.boardStatus = fallback === 'no-board' ? 'success' : 'error';
    rerender(<ClimbList />);

    const restoredOptions = Object.assign({}, previousHeaderOptions, ...mocks.stackOptions);
    expect(restoredOptions).toMatchObject({ title: 'Climbs', headerShown: true, headerLargeTitle: true });
    expect(restoredOptions.headerTitle).toBeUndefined();
    expect(mocks.stackOptions.every((options) => !Object.hasOwn(options, 'title'))).toBe(true);
  });
});

// On iOS 26 the filter chips float over the list. The blur behind them shows only
// while rows are scrolled under them: at rest the page behind is just the page.
// The list writes that to a store the screen holds, and the blur inside the top
// chrome reads it. The blur also tells the store where the chips were drawn; the
// mocked header is 100 pt tall, so here the list rests at an offset of -100.
describe('ClimbList rows scrolling under the pinned filter chips', () => {
  const SCROLL_LISTENERS = [
    'onScroll',
    'onScrollBeginDrag',
    'onScrollEndDrag',
    'onMomentumScrollBegin',
    'onMomentumScrollEnd',
  ] as const;
  const scrollEvent = (offsetY: number) =>
    ({ nativeEvent: { contentOffset: { x: 0, y: offsetY } } }) as Parameters<
      ScrollEdgeBackdrop['listProps']['onScroll']
    >[0];
  const scrollListTo = (offsetY: number) => act(() => mocks.listScrollProps.onScroll?.(scrollEvent(offsetY)));

  /** Renders the screen with a blur mounted in its chrome, drawn under a 100 pt bar. */
  const renderUnderFloatingChips = async () => {
    const view = render(<ClimbList />);
    await view.findByText('Moonage');
    const store = mocks.chromeScrollEdge!;
    act(() => {
      store.attachBackdrop();
      store.setTopOffset(-100);
    });
    return { ...view, store };
  };

  afterEach(() => {
    mocks.scrollToOffset.mockReset();
  });

  it('hands the chrome one store for the life of the screen', async () => {
    const { rerender, findByText } = render(<ClimbList />);
    await findByText('Moonage');
    const store = mocks.chromeScrollEdge;
    expect(store).toBeDefined();

    rerender(<ClimbList />);
    expect(mocks.chromeScrollEdge).toBe(store);
  });

  // Material, Android, the old floating chrome, and the iOS paths that keep a
  // painted band (before iOS 26, Reduce Transparency, Increase Contrast): no
  // blur mounts. Only the stable native-offset tracker is needed for clearance.
  it.each([true, false])(
    'tracks native offsets without extra gesture listeners before a blur mounts (UIKit header: %s)',
    async (nativeRootHeader) => {
      mocks.nativeRootHeader = nativeRootHeader;
      const { findByText } = render(<ClimbList />);
      await findByText('Moonage');

      expect(mocks.listScrollProps.onScroll).toBeTypeOf('function');
      for (const listener of SCROLL_LISTENERS.filter((listener) => listener !== 'onScroll')) {
        expect(mocks.listScrollProps[listener]).toBeUndefined();
      }
    },
  );

  it("forwards scrolling and retains the store's gesture listeners once a blur mounts", async () => {
    const { store } = await renderUnderFloatingChips();

    expect(mocks.listScrollProps.onScroll).toBeTypeOf('function');
    for (const listener of SCROLL_LISTENERS.filter((listener) => listener !== 'onScroll')) {
      expect(mocks.listScrollProps[listener]).toBe(store.listProps[listener]);
    }
  });

  it('tells the blur once rows are under the chips, and again when the list is back at rest', async () => {
    const { store } = await renderUnderFloatingChips();
    expect(store.isScrolledUnder()).toBe(false);

    scrollListTo(-100);
    expect(store.isScrolledUnder()).toBe(false);

    scrollListTo(180);
    expect(store.isScrolledUnder()).toBe(true);

    scrollListTo(-100);
    expect(store.isScrolledUnder()).toBe(false);
  });

  it('stays at rest through the overscroll bounce and a pull-to-refresh', async () => {
    const { store } = await renderUnderFloatingChips();

    act(() => mocks.listScrollProps.onScrollBeginDrag?.(scrollEvent(-100)));
    for (const offsetY of [-140, -190, -160, -160, -118, -100]) {
      scrollListTo(offsetY);
      expect(store.isScrolledUnder()).toBe(false);
    }
  });

  // This screen is the list and every row in it. Neither a frame of scrolling
  // nor rows crossing under the chips may re-render it.
  it('does not re-render the screen for a scroll or for rows crossing under the chips', async () => {
    const { store } = await renderUnderFloatingChips();
    const rendersWired = mocks.chromeRenders;

    for (const offsetY of [-100, -40, 300, 900, -100, 600]) scrollListTo(offsetY);

    expect(store.isScrolledUnder()).toBe(true);
    expect(mocks.chromeRenders).toBe(rendersWired);
  });

  // A new search puts the list back at its top with no finger involved. The
  // real list reports that jump as a scroll event; the mocked one is made to.
  it('turns the blur off when a new search puts a scrolled list back at its top', async () => {
    mocks.scrollToOffset.mockImplementation(({ offset }: { offset: number }) =>
      mocks.listScrollProps.onScroll?.(scrollEvent(offset)),
    );
    const { store, rerender } = await renderUnderFloatingChips();
    scrollListTo(1400);
    expect(store.isScrolledUnder()).toBe(true);

    mocks.searchState = { filters: { minGrade: 14, maxGrade: 14 }, boardFilters: {}, name: '' };
    rerender(<ClimbList />);

    expect(mocks.scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: -100, animated: false });
    expect(store.isScrolledUnder()).toBe(false);
  });

  it.each([
    [true, false],
    [false, false],
    [false, true],
  ])(
    'preserves scrolled rows after chrome height commits (UIKit: %s, Material: %s)',
    async (nativeRootHeader, material) => {
      mocks.nativeRootHeader = nativeRootHeader;
      mocks.filtersInTopChrome = material;
      const { findByText } = render(<ClimbList />);
      await findByText('Moonage');
      act(() => mocks.reportChromeHeight?.(44));
      scrollListTo(500);
      act(() => mocks.reportChromeHeight?.(104));
      expect(mocks.scrollToOffset).not.toHaveBeenCalled();
      act(() => mocks.listCommitLayout?.());
      expect(mocks.scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 560, animated: false });
      scrollListTo(560);
      act(() => mocks.reportChromeHeight?.(44));
      act(() => mocks.listCommitLayout?.());
      expect(mocks.scrollToOffset).toHaveBeenLastCalledWith({ offset: 500, animated: false });
    },
  );

  it('reserves the expanded controls above a resting first result without scrolling it away', async () => {
    const { findByText, getByTestId } = render(<ClimbList />);
    await findByText('Moonage');
    act(() => mocks.reportChromeHeight?.(44));
    scrollListTo(-100);
    act(() => mocks.reportChromeHeight?.(104));
    act(() => mocks.listCommitLayout?.());
    expect(getByTestId('flash-list').getAttribute('data-padding-top')).toBe('104');
    expect(mocks.scrollToOffset).not.toHaveBeenCalled();
  });
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

// #5654: "Find my board" opens the picker's no-board entry, which shows "Where
// do you climb?" to a climber with no boards. Not the onboarding entry: this
// state shows for anyone with no board bound, so its bind is an ordinary pick.
describe('ClimbList with no board bound', () => {
  it('sends "Find my board" to the picker as the no-board entry', async () => {
    mocks.activeBoard = null;
    const { findByRole } = render(<ClimbList />);

    fireEvent.click(await findByRole('button', { name: 'mobile.emptyState.noBoard.cta' }));

    expect(mocks.push).toHaveBeenCalledWith({ pathname: '/boards', params: { source: 'no_board' } });
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

  // Under the UIKit header the filter chips are pinned over the top of the list,
  // where the spinner appears: it is drawn below them, by their measured height.
  it('draws the spinner below the controls pinned under the UIKit header', async () => {
    const { container, findByText } = render(<ClimbList />);
    await findByText('Moonage');

    act(() => mocks.reportChromeHeight?.(96));

    expect(container.querySelector('[data-refresh-control]')?.getAttribute('data-progress-view-offset')).toBe('96');
  });

  it('leaves the spinner where it was under the Material and floating chromes', async () => {
    mocks.nativeRootHeader = false;
    const { container, findByText } = render(<ClimbList />);
    await findByText('Moonage');

    act(() => mocks.reportChromeHeight?.(156));

    expect(container.querySelector('[data-refresh-control]')?.hasAttribute('data-progress-view-offset')).toBe(false);
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
    expect(mocks.openAddToPlaylist).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'climb-1' }),
      undefined,
      undefined,
    );
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
    mocks.searchError = new Error('Network request failed');
    mocks.offlineCatalog = 'missing';

    const { findByText } = render(<ClimbList />);

    expect(await findByText('mobile.emptyState.offlineNoCatalog.title')).toBeTruthy();
  });

  it.each([
    new Error('database is locked'),
    new Error('Privacy revalidation is required before reading downloaded content'),
    new Error('Invalid search input'),
    Object.assign(new Error('Request superseded'), { name: 'AbortError' }),
  ])('offers Retry for an online query error without promising a download: %s', async (error) => {
    mocks.isOffline = false;
    mocks.searchFailed = true;
    mocks.searchError = error;
    mocks.offlineCatalog = 'queued';

    const { findByText, queryByText } = render(<ClimbList />);

    expect(await findByText('mobile.offlineState.errorTitle')).toBeTruthy();
    expect(queryByText('mobile.emptyState.offlineCatalogQueued.title')).toBeNull();
    expect(queryByText('mobile.emptyState.offlineNoCatalog.title')).toBeNull();
    fireEvent.click(await findByText('mobile.offlineState.retry'));
    expect(mocks.refetchClimbs).toHaveBeenCalledOnce();
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
  it('feeds tick display for new rows even while the interaction queue is held', async () => {
    const { rerender } = render(<ClimbList />);
    await waitFor(() => expect(mocks.tickBatch).toHaveBeenCalledWith(['climb-1', 'climb-2']));
    mocks.tickBatch.mockClear();
    mocks.holdInteractions = true;
    mocks.searchClimbs = [...mocks.searchClimbs, { uuid: 'climb-3', name: 'Mercury' } as unknown as Climb];
    rerender(<ClimbList />);
    expect(mocks.tickBatch).toHaveBeenCalledWith(['climb-1', 'climb-2', 'climb-3']);
    expect(mocks.openPlayDrawer).not.toHaveBeenCalled();
  });
  it('dismisses the climb-name keyboard before activating a pressed climb', async () => {
    const { findByText } = render(<ClimbList />);

    fireEvent.click(await findByText('Moonage'));

    expect(mocks.dismissKeyboard).toHaveBeenCalledTimes(1);
    expect(mocks.activateClimb).toHaveBeenCalledWith({ uuid: 'climb-1' }, undefined);
    // Logbook is fetched for every visible row, not just the pressed one — the
    // default fixture now has two climbs (added for the rank-tracking tests).
    await waitFor(() => expect(mocks.tickBatch).toHaveBeenCalledWith(['climb-1', 'climb-2']));
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
    expect(mocks.activateClimb).toHaveBeenCalledWith({ uuid: 'climb-1' }, undefined);
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

  it('leaves a solo tap committing', async () => {
    mocks.isSharedSession = false;
    const { findByText } = render(<ClimbList />);

    fireEvent.click(await findByText('Moonage'));

    expect(mocks.activateClimb).toHaveBeenCalledWith({ uuid: 'climb-1' }, undefined);
    expect(mocks.activationOptions?.previewOnly).toBe(false);
  });
});

describe('ClimbList lightOnClimbTap setting', () => {
  // The activation hook reads the setting at the tap now, for every list (issue
  // #6665), so a preview carries the results as its track and swipes walk them
  // (#5157). The screen no longer opens a bare, trackless preview of its own.
  it('routes the tap through the activation hook when the setting is off', async () => {
    mocks.lightOnClimbTap = false;
    const { findByText } = render(<ClimbList />);

    fireEvent.click(await findByText('Moonage'));

    expect(mocks.activateClimb).toHaveBeenCalledWith({ uuid: 'climb-1' }, undefined);
    expect(mocks.openPlayDrawer).not.toHaveBeenCalled();
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

  const gradeScene = () => {
    mocks.carrySearchGeometry = true;
    const requested = {
      uuid: 'requested-owned',
      name: 'Boardsesh HQ',
      createdAt: '2026-01-01',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1',
      angle: 40,
    };
    mocks.screenshotBoards = [requested];
    mocks.activeBoard = requested;
    mocks.grades = [
      { difficultyId: 17, name: '6a/V3' },
      { difficultyId: 19, name: '6b/V4' },
    ];
    mocks.searchParams = {
      screenshotBoardIndex: '0',
      screenshotOpenFilters: '1',
      screenshotCppScene: 'search-grade',
      screenshotMinGrade: '17',
      screenshotMaxGrade: '19',
    };
    return requested;
  };

  const excludedSavedSearch: LastSearch = {
    filters: { ...DEFAULT_FILTERS, minGrade: 24, maxGrade: 26, sortBy: 'quality' },
    boardFilters: { onlyBenchmarks: true },
    searchText: 'old project',
    updatedAt: 1,
  };

  it.each(['loading', 'placeholder'] as const)(
    'clears a reused simulator only after restoration and waits for real default rows (%s)',
    async (pending) => {
      await withScreenshotMode(async () => {
        mocks.statefulSearch = true;
        gradeScene();
        const requestedClimb = { ...mocks.secondClimb, boardType: 'kilter', layoutId: 1, angle: 40 };
        const firstClimb = { ...mocks.climb, boardType: 'kilter', layoutId: 1, angle: 40 };
        mocks.searchClimbsForInput = (input) =>
          input?.name ||
          Object.keys(input?.filters as object).length ||
          Object.keys(input?.boardFilters as object).length
            ? [firstClimb]
            : [firstClimb, requestedClimb];
        mocks.searchParams = {
          screenshotBoardIndex: '0',
          screenshotCppScene: 'hero-1',
          screenshotClimbId: requestedClimb.uuid,
        };
        let finishRestore: (saved: LastSearch) => void = () => {};
        mocks.getLastSearch.mockReturnValueOnce(new Promise<LastSearch>((resolve) => (finishRestore = resolve)));
        const view = render(<ClimbList />);
        await act(async () => {});
        expect(mocks.replaceSearch).not.toHaveBeenCalled();
        expect(mocks.activateClimb).not.toHaveBeenCalled();
        mocks.isClimbsLoading = pending === 'loading';
        mocks.isPlaceholderData = pending === 'placeholder';
        await act(async () => finishRestore(excludedSavedSearch));
        expect(mocks.replaceSearch).toHaveBeenNthCalledWith(
          1,
          excludedSavedSearch.filters,
          excludedSavedSearch.searchText,
          excludedSavedSearch.boardFilters,
        );
        expect(mocks.searchState).toEqual({ filters: {}, boardFilters: {}, name: '' });
        expect(mocks.setName).toHaveBeenCalledWith('');
        expect(mocks.activateClimb).not.toHaveBeenCalled();
        const resetCalls = () =>
          mocks.replaceSearch.mock.calls.filter(([filters]) => Object.keys(filters).length === 0);
        expect(resetCalls()).toHaveLength(1);
        view.rerender(<ClimbList />);
        expect(resetCalls()).toHaveLength(1);
        mocks.isClimbsLoading = false;
        mocks.isPlaceholderData = false;
        view.rerender(<ClimbList />);
        await waitFor(() => expect(mocks.activateClimb).toHaveBeenCalledTimes(1));
        expect(mocks.activateClimb.mock.calls[0][0].uuid).toBe(requestedClimb.uuid);
        expect(mocks.searchInput).toMatchObject({ filters: {}, boardFilters: {}, name: '' });
      });
    },
  );

  it('resets and reopens the same explicit hero after leaving and changing normal search', async () => {
    await withScreenshotMode(async () => {
      mocks.statefulSearch = true;
      gradeScene();
      const climb = { ...mocks.climb, boardType: 'kilter', layoutId: 1, angle: 40 };
      const hero = { screenshotBoardIndex: '0', screenshotClimbId: climb.uuid, screenshotCppScene: 'hero-1' };
      mocks.searchParams = hero;
      mocks.searchClimbsForInput = (input) =>
        input?.name || Object.keys(input?.filters as object).length ? [] : [climb];
      const view = render(<ClimbList />);
      await waitFor(() => expect(mocks.activateClimb).toHaveBeenCalledTimes(1));
      mocks.searchParams = {};
      view.rerender(<ClimbList />);
      act(() => {
        mocks.replaceSearch(excludedSavedSearch.filters, excludedSavedSearch.searchText, {});
      });
      expect(mocks.searchState.name).toBe('old project');
      mocks.searchParams = hero;
      view.rerender(<ClimbList />);
      await waitFor(() => expect(mocks.activateClimb).toHaveBeenCalledTimes(2));
      expect(mocks.searchState).toEqual({ filters: {}, boardFilters: {}, name: '' });
      view.rerender(<ClimbList />);
      expect(mocks.activateClimb).toHaveBeenCalledTimes(2);
    });
  });

  it('clears restored grade-scene text before waiting for loaded results and never reapplies after Reset', async () => {
    await withScreenshotMode(async () => {
      mocks.statefulSearch = true;
      gradeScene();
      mocks.getLastSearch.mockResolvedValueOnce(excludedSavedSearch);
      mocks.isClimbsLoading = true;
      mocks.searchClimbsForInput = (input) =>
        input?.name ? [] : [{ ...mocks.climb, boardType: 'kilter', layoutId: 1, angle: 40 }];
      const view = render(<ClimbList />);
      await waitFor(() => expect(mocks.setName).toHaveBeenCalledWith(''));
      expect(mocks.searchState.name).toBe('');
      expect(mocks.filterSheetProps?.searchName).toBe('');
      const gradeCalls = () => mocks.replaceSearch.mock.calls.filter(([filters]) => filters.minGrade === 17);
      expect(gradeCalls()).toHaveLength(0);
      mocks.isClimbsLoading = false;
      mocks.isPlaceholderData = true;
      view.rerender(<ClimbList />);
      expect(gradeCalls()).toHaveLength(0);
      mocks.isPlaceholderData = false;
      view.rerender(<ClimbList />);
      await waitFor(() => expect(gradeCalls()).toHaveLength(1));
      await waitFor(() =>
        expect(mocks.searchInput).toMatchObject({ filters: { minGrade: 17, maxGrade: 19 }, name: '' }),
      );
      act(() => mocks.filterSheetProps?.onSelectionChange(DEFAULT_FILTERS, {}));
      view.rerender(<ClimbList />);
      expect(mocks.searchState.filters).toEqual({});
      expect(gradeCalls()).toHaveLength(1);
      expect(mocks.activateClimb).not.toHaveBeenCalled();
    });
  });

  it('preserves restored filters and search text for ordinary app navigation', async () => {
    mocks.statefulSearch = true;
    mocks.getLastSearch.mockResolvedValueOnce(excludedSavedSearch);
    render(<ClimbList />);
    await waitFor(() => expect(mocks.searchState.name).toBe(excludedSavedSearch.searchText));
    expect(mocks.searchState.filters).toEqual(excludedSavedSearch.filters);
    expect(mocks.searchState.boardFilters).toEqual(excludedSavedSearch.boardFilters);
    expect(mocks.replaceSearch).toHaveBeenCalledTimes(1);
    expect(mocks.setName).not.toHaveBeenCalled();
  });

  it('cancels a pending sheet name debounce when entering the grade capture', async () => {
    await withScreenshotMode(async () => {
      mocks.statefulSearch = true;
      gradeScene();
      mocks.searchParams = { ...mocks.searchParams, screenshotCppScene: 'search' };
      mocks.getLastSearch.mockResolvedValueOnce(excludedSavedSearch);
      mocks.isClimbsLoading = true;
      const view = render(<ClimbList />);
      await waitFor(() => expect(mocks.filterSheetProps?.searchName).toBe(excludedSavedSearch.searchText));
      await act(async () => {});
      vi.useFakeTimers();
      try {
        act(() => mocks.filterSheetProps?.onNameChange('late pending'));
        expect(mocks.searchState.name).toBe(excludedSavedSearch.searchText);
        mocks.searchParams = { ...mocks.searchParams, screenshotCppScene: 'search-grade' };
        view.rerender(<ClimbList />);
        act(() => {
          vi.advanceTimersByTime(300);
        });
        expect(mocks.searchState.name).toBe('');
        expect(mocks.setName).not.toHaveBeenCalledWith('late pending');
        const gradeCalls = () => mocks.replaceSearch.mock.calls.filter(([filters]) => filters.minGrade === 17);
        expect(gradeCalls()).toHaveLength(0);
        mocks.isClimbsLoading = false;
        view.rerender(<ClimbList />);
        act(() => {
          vi.advanceTimersByTime(250);
        });
        expect(gradeCalls()).toHaveLength(1);
        expect(mocks.searchInput).toMatchObject({ filters: { minGrade: 17, maxGrade: 19 }, name: '' });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('waits for the requested owned board before clearing its restored hero search', async () => {
    await withScreenshotMode(async () => {
      mocks.statefulSearch = true;
      const requested = gradeScene();
      mocks.activeBoard = { ...requested, uuid: 'previous-owned' };
      mocks.getLastSearch.mockResolvedValueOnce(excludedSavedSearch);
      const climb = { ...mocks.climb, boardType: 'kilter', layoutId: 1, angle: 40 };
      mocks.searchParams = {
        screenshotBoardIndex: '0',
        screenshotClimbId: climb.uuid,
        screenshotCppScene: 'hero-1',
      };
      mocks.searchClimbsForInput = (input) => (input?.name ? [] : [climb]);
      const view = render(<ClimbList />);
      await waitFor(() => expect(mocks.searchState.name).toBe(excludedSavedSearch.searchText));
      expect(mocks.setName).not.toHaveBeenCalled();
      expect(mocks.activateClimb).not.toHaveBeenCalled();
      mocks.activeBoard = requested;
      view.rerender(<ClimbList />);
      await waitFor(() => expect(mocks.activateClimb).toHaveBeenCalledTimes(1));
      expect(mocks.searchState).toEqual({ filters: {}, boardFilters: {}, name: '' });
    });
  });

  it('applies a genuine grade range once through the live filter action without a hero selection', async () => {
    await withScreenshotMode(async () => {
      gradeScene();
      const { rerender } = render(<ClimbList />);
      await waitFor(() => expect(mocks.replaceSearch).toHaveBeenCalledWith({ minGrade: 17, maxGrade: 19 }, '', {}));
      const gradeCalls = () => mocks.replaceSearch.mock.calls.filter(([filters]) => filters.minGrade === 17);
      expect(gradeCalls()).toHaveLength(1);
      expect(mocks.activateClimb).not.toHaveBeenCalled();
      rerender(<ClimbList />);
      expect(gradeCalls()).toHaveLength(1);
    });
  });

  it.each(['stale-board', 'pending-grades', 'placeholder-grades', 'invalid-grade'] as const)(
    'does not dispatch a screenshot grade action before genuine scope/grades are ready (%s)',
    async (reason) => {
      await withScreenshotMode(async () => {
        const requested = gradeScene();
        if (reason === 'stale-board') mocks.activeBoard = { ...requested, uuid: 'previous-owned' };
        if (reason === 'pending-grades') mocks.gradesLoaded = false;
        if (reason === 'placeholder-grades') mocks.gradesPlaceholder = true;
        if (reason === 'invalid-grade') mocks.searchParams.screenshotMinGrade = '999';
        const { rerender } = render(<ClimbList />);
        await act(async () => {});
        expect(mocks.replaceSearch.mock.calls.filter(([filters]) => filters.minGrade != null)).toHaveLength(0);
        mocks.activeBoard = requested;
        mocks.gradesLoaded = true;
        mocks.gradesPlaceholder = false;
        mocks.searchParams.screenshotMinGrade = '17';
        rerender(<ClimbList />);
        await waitFor(() => expect(mocks.replaceSearch).toHaveBeenCalledWith({ minGrade: 17, maxGrade: 19 }, '', {}));
      });
    },
  );

  it('opens an explicit second real row, then restores the first status selection on the same board', async () => {
    await withScreenshotMode(async () => {
      mocks.carrySearchGeometry = true;
      const first = { ...mocks.climb, boardType: 'kilter', layoutId: 1, angle: 40 };
      const second = { ...mocks.secondClimb, boardType: 'kilter', layoutId: 1, angle: 40 };
      mocks.searchClimbs = [first, second];
      mocks.searchParams = { screenshotClimbId: second.uuid, screenshotCppScene: 'hero-1' };
      const { rerender } = render(<ClimbList />);
      await waitFor(() => expect(mocks.activateClimb).toHaveBeenCalledTimes(1));
      expect(mocks.activateClimb.mock.calls[0][0].uuid).toBe(second.uuid);
      mocks.searchParams = { screenshotClimbId: first.uuid, screenshotCppScene: 'status' };
      rerender(<ClimbList />);
      await waitFor(() => expect(mocks.activateClimb).toHaveBeenCalledTimes(2));
      expect(mocks.activateClimb.mock.calls[1][0].uuid).toBe(first.uuid);
    });
  });

  it('never falls back when the explicit requested climb is missing or results are placeholders', async () => {
    await withScreenshotMode(async () => {
      mocks.carrySearchGeometry = true;
      mocks.searchClimbs = [{ ...mocks.climb, boardType: 'kilter', layoutId: 1, angle: 40 }];
      mocks.searchParams = { screenshotOpenFirst: '1', screenshotClimbId: 'missing' };
      const { rerender } = render(<ClimbList />);
      await act(async () => {});
      expect(mocks.activateClimb).not.toHaveBeenCalled();
      mocks.searchParams = { screenshotOpenFirst: '1', screenshotClimbId: mocks.climb.uuid };
      mocks.isPlaceholderData = true;
      rerender(<ClimbList />);
      await act(async () => {});
      expect(mocks.activateClimb).not.toHaveBeenCalled();
      mocks.isPlaceholderData = false;
      rerender(<ClimbList />);
      await waitFor(() => expect(mocks.activateClimb).toHaveBeenCalledTimes(1));
    });
  });

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
          zeroResultIncludeOtherAngles: false,
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

// A climber who hides the board picture gets rows a third as tall, and no
// thumbnail drawn. Two things on this screen have to follow: the renders warmed
// ahead of the scroll are thumbnail-only work, and a fixed count of placeholder
// rows would cover a third of the screen.
describe('ClimbList with the climber’s row switches', () => {
  const skeletonRows = (container: HTMLElement) => [...container.querySelectorAll('[data-skeleton-row]')];
  const loadingFirstPage = () => {
    mocks.searchClimbs = [];
    mocks.isClimbsLoading = true;
  };

  it('warms thumbnails ahead of the scroll while rows draw one', () => {
    render(<ClimbList />);

    expect(mocks.thumbnailPrewarmMounted).toBe(true);
  });

  it('mounts no thumbnail warm-up with thumbnails switched off', () => {
    setClimbRowField('thumbnail', false);

    render(<ClimbList />);

    expect(mocks.thumbnailPrewarmMounted).toBe(false);
  });

  it('drops the warm-up the moment thumbnails go off, and starts it again when they come back', () => {
    render(<ClimbList />);
    expect(mocks.thumbnailPrewarmMounted).toBe(true);

    act(() => setClimbRowField('thumbnail', false));
    expect(mocks.thumbnailPrewarmMounted).toBe(false);

    act(() => setClimbRowField('thumbnail', true));
    expect(mocks.thumbnailPrewarmMounted).toBe(true);
  });

  // The next page's placeholders are counted once the first page's rows are
  // up: until the board's last search has been read, the screen shows the
  // first-page placeholders as well.
  const loadingNextPage = async () => {
    mocks.searchClimbs = [mocks.climb];
    mocks.isFetchingNextPage = true;
    const { container, findByText } = render(<ClimbList />);
    await findByText('Moonage');
    return container;
  };

  it('draws ten placeholder rows for the first page of default rows, six for the next page', async () => {
    loadingFirstPage();
    const firstPage = render(<ClimbList />);
    expect(skeletonRows(firstPage.container)).toHaveLength(10);
    // Keep the next-page lookup from resolving against this screen while its
    // pending restore rerenders it with the changed query fixture.
    firstPage.unmount();

    mocks.isClimbsLoading = false;
    expect(skeletonRows(await loadingNextPage())).toHaveLength(6);
  });

  // 10 rows of 112pt is 1120pt of placeholder. The same height in shorter rows:
  it.each([
    { label: 'text-only rows (58pt)', off: ['thumbnail'], rows: 20 },
    { label: 'name-only rows (44pt)', off: ['thumbnail', 'sends', 'rating', 'setter'], rows: 26 },
  ] as const)('draws $rows placeholder rows to cover the same height in $label', ({ off, rows }) => {
    for (const fieldId of off) setClimbRowField(fieldId, false);
    loadingFirstPage();

    expect(skeletonRows(render(<ClimbList />).container)).toHaveLength(rows);
  });

  it('counts the next page’s placeholders the same way', async () => {
    setClimbRowField('thumbnail', false);

    // 6 rows of 112pt, in 58pt rows.
    expect(skeletonRows(await loadingNextPage())).toHaveLength(12);
  });

  it('counts for the climber’s text size: taller lines, fewer rows, never fewer than with a thumbnail', () => {
    setClimbRowField('thumbnail', false);
    loadingFirstPage();
    mocks.fontScale = 1.5;
    // Two name lines plus detail: (44 + 18) × 1.5 + 2 + 16 = 111pt rows.
    expect(skeletonRows(render(<ClimbList />).container)).toHaveLength(11);

    mocks.fontScale = 3;
    expect(skeletonRows(render(<ClimbList />).container)).toHaveLength(10);
  });

  it('follows a switch flipped while the placeholders are up', () => {
    loadingFirstPage();
    const { container } = render(<ClimbList />);
    expect(skeletonRows(container)).toHaveLength(10);

    act(() => setClimbRowField('thumbnail', false));

    expect(skeletonRows(container)).toHaveLength(20);
  });

  it('tells each placeholder what this list’s rows can show: tags, and a line per direction on a board that mirrors', () => {
    loadingFirstPage();
    const kilter = skeletonRows(render(<ClimbList />).container);
    expect(kilter[0].getAttribute('data-tags')).toBe('true');
    expect(kilter[0].getAttribute('data-mirrors')).toBe('false');

    mocks.activeBoard = { boardType: 'tension', layoutId: 10, sizeId: 6, setIds: '12', angle: 40 };
    setClimbRowField('thumbnail', false);
    const tension = skeletonRows(render(<ClimbList />).container);

    expect(tension[0].getAttribute('data-mirrors')).toBe('true');
    // 22 + 2 + 18 + 2 + 13 for the direction line, + 16: 73pt rows.
    expect(tension).toHaveLength(16);
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

// Recent is a pinnable chip. Unpinning it is a display choice: the saved
// searches and the search in force are untouched, new searches still save, and
// pinning it again shows the same history at once. Whether the row draws the
// chip from these props is locked in climb-capsules.test.ts.
describe('ClimbList with the Recent chip unpinned', () => {
  const savedSearch: RecentFilter = {
    id: 'crimp',
    label: 'Crimpy',
    filters: DEFAULT_FILTERS,
    searchText: 'crimp',
    timestamp: 1,
  };
  const chipRowProps = (): FilterChipRowProps => {
    if (!mocks.chipRowProps) throw new Error('the filter chip row was not drawn');
    return mocks.chipRowProps;
  };
  const recentPinned = () => chipRowProps().pinnedChips.includes('recent');
  const unpinRecent = () => setPinnedChips(DEFAULT_PINNED_CHIPS.filter((kind) => kind !== 'recent'));

  beforeEach(() => {
    mocks.renderFilterChrome = true;
    mocks.searchState = { filters: {}, boardFilters: {}, name: 'crimp' };
    mocks.getRecentFilters.mockResolvedValue([savedSearch]);
  });
  afterEach(async () => {
    await act(async () => {
      await setPinnedChips(DEFAULT_PINNED_CHIPS);
    });
  });

  it('hides the chip but keeps the saved searches and the search in force', async () => {
    render(<ClimbList />);
    await waitFor(() => expect(chipRowProps().recentFilters).toEqual([savedSearch]));
    expect(recentPinned()).toBe(true);
    const searchWritesBefore = mocks.replaceSearch.mock.calls.length + mocks.setName.mock.calls.length;
    const historyReadsBefore = mocks.getRecentFilters.mock.calls.length;

    await act(async () => {
      await unpinRecent();
    });
    expect(recentPinned()).toBe(false);
    expect(chipRowProps().recentFilters).toEqual([savedSearch]);
    expect(chipRowProps().currentSearchText).toBe('crimp');
    expect(mocks.replaceSearch.mock.calls.length + mocks.setName.mock.calls.length).toBe(searchWritesBefore);
    expect(mocks.clearRecentFilters).not.toHaveBeenCalled();

    // Pinned again: the same history, with no second read.
    await act(async () => {
      await setPinnedChips(DEFAULT_PINNED_CHIPS);
    });
    expect(recentPinned()).toBe(true);
    expect(mocks.getRecentFilters.mock.calls.length).toBe(historyReadsBefore);
  });

  // Filters lists the same history as chips; a chip goes through the very
  // handler the toolbar's Recent menu calls, whatever the pin says.
  it.each([true, false])(
    'hands Filters the saved searches and the menu’s apply handler (pinned: %s)',
    async (pinned) => {
      if (!pinned) {
        await act(async () => {
          await unpinRecent();
        });
      }
      render(<ClimbList />);
      await waitFor(() => expect(chipRowProps().recentFilters).toEqual([savedSearch]));
      act(() => mocks.openFiltersFromChips?.());
      await waitFor(() => expect(mocks.filterSheetProps).toBeDefined());

      expect(mocks.filterSheetProps?.recentFilters).toEqual([savedSearch]);
      expect(mocks.filterSheetProps?.onApplyRecent).toBe(chipRowProps().onApplyRecent);
      mocks.replaceSearch.mockClear();
      act(() => mocks.filterSheetProps?.onApplyRecent?.(savedSearch.filters, savedSearch.searchText));
      expect(mocks.replaceSearch).toHaveBeenCalledTimes(1);
      expect(mocks.replaceSearch.mock.calls[0]?.[1]).toBe('crimp');
    },
  );

  it('still saves a search finished while the chip is hidden', async () => {
    await act(async () => {
      await unpinRecent();
    });
    render(<ClimbList />);
    await waitFor(() => expect(chipRowProps().recentFilters).toEqual([savedSearch]));
    expect(recentPinned()).toBe(false);

    act(() => mocks.openFiltersFromChips?.());
    await waitFor(() => expect(mocks.filterSheetProps).toBeDefined());
    act(() => mocks.filterSheetProps?.onDismiss());
    await waitFor(() => expect(mocks.addRecentFilter).toHaveBeenCalledTimes(1));
    expect(mocks.addRecentFilter.mock.calls[0]?.[2]).toBe('crimp');
  });
});

// The native header is a UIKit bar outside the screen's view tree, so nothing the
// screen positions itself can sit above it. The grade rail has to be a row of the
// chrome, which the header lays out below itself and the list insets by.
describe('ClimbList grade row', () => {
  const gradeRowToggles = () => mocks.track.mock.calls.filter(([eventName]) => eventName === 'Grade Row Toggled');

  // The chips have the row to themselves: what a climb row shows is chosen in
  // Settings → Climb list (#6397).
  it('gives the chips the whole row, with nothing pinned beside them', () => {
    mocks.renderFilterChrome = true;
    const { getByTestId } = render(<ClimbList />);
    expect([...getByTestId('top-chrome').children]).toEqual([getByTestId('chip-row')]);
  });

  it('is hidden until the Grade chip is tapped, and the chip reads as closed', () => {
    mocks.renderFilterChrome = true;
    const { getByTestId, queryByTestId } = render(<ClimbList />);

    expect(queryByTestId('grade-range-rail')).toBeNull();
    expect(getByTestId('chip-row').getAttribute('data-grade-open')).toBe('false');
    expect(gradeRowToggles()).toEqual([]);
  });

  it('opens as a row of the top chrome from the Grade chip, and the choice is written to settings', () => {
    mocks.renderFilterChrome = true;
    const { getByTestId } = render(<ClimbList />);

    act(() => mocks.openGrade?.());
    expect(getByTestId('top-chrome').contains(getByTestId('grade-range-rail'))).toBe(true);
    expect(getByTestId('chip-row').getAttribute('data-grade-open')).toBe('true');
    expect(mocks.gradeRow.set).toHaveBeenCalledExactlyOnceWith(true);
    expect(gradeRowToggles()).toEqual([['Grade Row Toggled', { shown: true }]]);
  });

  it('is still open on the next launch, until the Grade chip hides it again', () => {
    mocks.renderFilterChrome = true;
    mocks.gradeRow.shown = true;
    const { getByTestId, queryByTestId } = render(<ClimbList />);
    expect(getByTestId('top-chrome').contains(getByTestId('grade-range-rail'))).toBe(true);
    expect(getByTestId('chip-row').getAttribute('data-grade-open')).toBe('true');
    expect(mocks.gradeRow.set).not.toHaveBeenCalled();

    act(() => mocks.closeGrade?.());
    expect(queryByTestId('grade-range-rail')).toBeNull();
    expect(getByTestId('chip-row').getAttribute('data-grade-open')).toBe('false');
    expect(mocks.gradeRow.set).toHaveBeenCalledExactlyOnceWith(false);
    expect(gradeRowToggles()).toEqual([['Grade Row Toggled', { shown: false }]]);
  });

  // The grade row stays open over the list: only the Grade chip hides it.
  it.each([
    ['the screen loses focus', () => mocks.dismissGradePopover?.()],
    ['search takes focus', () => mocks.focusSearch?.()],
    ['Filters opens', () => mocks.openFilters?.()],
  ])('stays open when %s', (_cause, trigger) => {
    mocks.renderFilterChrome = true;
    const { getByTestId } = render(<ClimbList />);
    act(() => mocks.openGrade?.());
    mocks.gradeRow.set.mockClear();
    mocks.track.mockClear();

    act(trigger);
    expect(getByTestId('top-chrome').contains(getByTestId('grade-range-rail'))).toBe(true);
    expect(mocks.gradeRow.set).not.toHaveBeenCalled();
    expect(gradeRowToggles()).toEqual([]);
  });

  it.each([
    ['the screen loses focus', () => mocks.dismissGradePopover?.()],
    ['search takes focus', () => mocks.focusSearch?.()],
    ['Filters opens', () => mocks.openFilters?.()],
  ])('stays hidden when %s', (_cause, trigger) => {
    mocks.renderFilterChrome = true;
    const { queryByTestId } = render(<ClimbList />);

    act(trigger);
    expect(queryByTestId('grade-range-rail')).toBeNull();
    expect(mocks.gradeRow.set).not.toHaveBeenCalled();
  });

  it('re-centres when the screen comes back into focus', () => {
    mocks.renderFilterChrome = true;
    mocks.gradeRow.shown = true;
    const { getByTestId, rerender } = render(<ClimbList />);
    expect(getByTestId('grade-range-rail').getAttribute('data-recenter-key')).toBe('0');

    mocks.refocusCount = 1;
    rerender(<ClimbList />);
    expect(getByTestId('grade-range-rail').getAttribute('data-recenter-key')).toBe('1');
  });

  // The Grade chip is the row's one way to hide it. Unpinned in Filters with
  // the row open, the chip is gone: a row that stayed would be there on every
  // launch with nothing to close it.
  describe('with the Grade chip unpinned', () => {
    const unpinGrade = () => setPinnedChips(DEFAULT_PINNED_CHIPS.filter((kind) => kind !== 'grade'));

    beforeEach(() => {
      mocks.renderFilterChrome = true;
      mocks.gradeRow.shown = true;
    });
    afterEach(async () => {
      await act(async () => {
        await setPinnedChips(DEFAULT_PINNED_CHIPS);
      });
    });

    it('goes when the chip is unpinned, and comes back as it was left when the chip is pinned again', async () => {
      const { getByTestId, queryByTestId } = render(<ClimbList />);
      expect(getByTestId('top-chrome').contains(getByTestId('grade-range-rail'))).toBe(true);

      await act(async () => {
        await unpinGrade();
      });
      expect(queryByTestId('grade-range-rail')).toBeNull();
      // The stored choice is not rewritten: it is what brings the row back.
      expect(mocks.gradeRow.set).not.toHaveBeenCalled();

      await act(async () => {
        await setPinnedChips(DEFAULT_PINNED_CHIPS);
      });
      expect(getByTestId('top-chrome').contains(getByTestId('grade-range-rail'))).toBe(true);
    });

    it('is not there on a launch with the chip already unpinned', async () => {
      await act(async () => {
        await unpinGrade();
      });
      const { queryByTestId } = render(<ClimbList />);

      expect(queryByTestId('grade-range-rail')).toBeNull();
    });

    it('takes the Material chrome rail with it too', async () => {
      mocks.filtersInTopChrome = true;
      render(<ClimbList />);
      expect(mocks.chromeGradeRailVisible).toBe(true);

      await act(async () => {
        await unpinGrade();
      });
      expect(mocks.chromeGradeRailVisible).toBe(false);
    });
  });

  describe('on Material, where the top chrome draws its own rail', () => {
    beforeEach(() => {
      mocks.renderFilterChrome = true;
      mocks.filtersInTopChrome = true;
    });

    it('adds no row of its own and keeps the chrome rail hidden until the Grade chip opens it', () => {
      const { queryByTestId } = render(<ClimbList />);
      expect(mocks.chromeGradeRailVisible).toBe(false);

      act(() => mocks.openGrade?.());
      expect(queryByTestId('grade-range-rail')).toBeNull();
      expect(mocks.chromeGradeRailVisible).toBe(true);
      expect(mocks.gradeRow.set).toHaveBeenCalledExactlyOnceWith(true);
    });

    it('keeps the open chrome rail through blur, search and Filters, and hides it from the Grade chip', () => {
      mocks.gradeRow.shown = true;
      render(<ClimbList />);

      act(() => {
        mocks.dismissGradePopover?.();
        mocks.focusSearch?.();
        mocks.openFilters?.();
      });
      expect(mocks.chromeGradeRailVisible).toBe(true);

      act(() => mocks.closeGrade?.());
      expect(mocks.chromeGradeRailVisible).toBe(false);
      expect(mocks.gradeRow.set).toHaveBeenCalledExactlyOnceWith(false);
    });
  });

  // Regular-width iPad keeps the transient popover on the Grade chip: closed
  // until tapped, and closed again by anything that takes the climber elsewhere.
  describe('on a regular-width iPad', () => {
    beforeEach(() => {
      mocks.renderFilterChrome = true;
      mocks.deviceLayout = { isPad: true, isTablet: true, widthClass: 'regular' };
    });

    it('shows no row and no open popover until the Grade chip is tapped, whatever the row setting', () => {
      mocks.gradeRow.shown = true;
      const { getByTestId, queryByTestId } = render(<ClimbList />);

      expect(queryByTestId('grade-range-rail')).toBeNull();
      expect(getByTestId('chip-row').getAttribute('data-grade-open')).toBe('false');
    });

    it('hands the rail to the chip popover instead of adding a row', () => {
      const { getAllByTestId, getByTestId } = render(<ClimbList />);

      act(() => mocks.openGrade?.());
      expect(getAllByTestId('grade-range-rail')).toHaveLength(1);
      expect(getByTestId('grade-popover').contains(getByTestId('grade-range-rail'))).toBe(true);
      expect(getByTestId('chip-row').getAttribute('data-grade-open')).toBe('true');
    });

    it.each([
      ['the chip is tapped again', () => mocks.closeGrade?.()],
      ['the screen loses focus', () => mocks.dismissGradePopover?.()],
      ['search takes focus', () => mocks.focusSearch?.()],
      ['Filters opens', () => mocks.openFilters?.()],
    ])('closes the popover when %s', async (_cause, trigger) => {
      const { findByText, getByTestId, queryByTestId } = render(<ClimbList />);
      // Filters becomes available after the current board's search restores.
      await findByText('Moonage');
      act(() => mocks.openGrade?.());

      act(trigger);
      expect(queryByTestId('grade-popover')).toBeNull();
      expect(getByTestId('chip-row').getAttribute('data-grade-open')).toBe('false');
    });

    it('never touches the row setting or reports a row toggle', () => {
      render(<ClimbList />);

      act(() => mocks.openGrade?.());
      act(() => mocks.closeGrade?.());
      // The popover reporting itself dismissed after the chip already closed it.
      act(() => mocks.closeGrade?.());
      expect(mocks.gradeRow.set).not.toHaveBeenCalled();
      expect(gradeRowToggles()).toEqual([]);
    });

    it('does not show the chrome rail beside the popover, even with the row setting on', () => {
      mocks.filtersInTopChrome = true;
      mocks.gradeRow.shown = true;
      render(<ClimbList />);

      expect(mocks.chromeGradeRailVisible).toBe(false);
    });
  });
});

describe('ClimbList grade filter analytics', () => {
  const gradeChanges = () =>
    mocks.track.mock.calls.filter(([eventName]) => eventName === 'Grade Filter Changed').map(([, payload]) => payload);

  beforeEach(() => {
    mocks.renderFilterChrome = true;
    mocks.gradeRow.shown = true;
  });

  it('reports a change from the grade row with both bounds, 0 for unset, and the gesture', () => {
    render(<ClimbList />);

    act(() => mocks.changeGrade?.({ minGradeId: 10, maxGradeId: 12 }, { gesture: 'tap' }));
    expect(gradeChanges()).toEqual([{ fromMin: 0, fromMax: 0, toMin: 10, toMax: 12, gesture: 'tap' }]);
    expect(mocks.setGrade).toHaveBeenCalledExactlyOnceWith({ minGradeId: 10, maxGradeId: 12 });
  });

  it('reports where the change started from', () => {
    mocks.searchState = { filters: { minGrade: 14, maxGrade: 16 }, boardFilters: {}, name: '' };
    render(<ClimbList />);

    act(() => mocks.changeGrade?.({ minGradeId: undefined, maxGradeId: undefined }, { gesture: 'clear' }));
    expect(gradeChanges()).toEqual([{ fromMin: 14, fromMax: 16, toMin: 0, toMax: 0, gesture: 'clear' }]);
  });

  it('leaves msSincePrevious off the first change and times every later one', () => {
    const now = vi.spyOn(Date, 'now');
    render(<ClimbList />);

    now.mockReturnValue(1_000_000);
    act(() => mocks.changeGrade?.({ minGradeId: 10, maxGradeId: 10 }, { gesture: 'tap' }));
    now.mockReturnValue(1_002_500);
    act(() => mocks.changeGrade?.({ minGradeId: 10, maxGradeId: 14 }, { gesture: 'hold' }));
    now.mockReturnValue(1_002_900);
    act(() => mocks.changeGrade?.({ minGradeId: 12, maxGradeId: 12 }, { gesture: 'tap' }));
    now.mockRestore();

    const [first, second, third] = gradeChanges();
    expect(first).not.toHaveProperty('msSincePrevious');
    expect(second).toMatchObject({ gesture: 'hold', msSincePrevious: 2500 });
    expect(third).toMatchObject({ gesture: 'tap', msSincePrevious: 400 });
  });

  // The window's misfire rate is read from these two: the flag says whether the
  // quick second tap made a range, the gap says how quick it was.
  it('carries withinRangeWindow on the tap the range window decided, true or false', () => {
    mocks.searchState = { filters: { minGrade: 15, maxGrade: 15 }, boardFilters: {}, name: '' };
    render(<ClimbList />);

    act(() => mocks.changeGrade?.({ minGradeId: 15, maxGradeId: 17 }, { gesture: 'tap', withinRangeWindow: true }));
    act(() => mocks.changeGrade?.({ minGradeId: 17, maxGradeId: 17 }, { gesture: 'tap', withinRangeWindow: false }));

    expect(gradeChanges()).toEqual([
      { fromMin: 15, fromMax: 15, toMin: 15, toMax: 17, gesture: 'tap', withinRangeWindow: true },
      expect.objectContaining({ toMin: 17, toMax: 17, gesture: 'tap', withinRangeWindow: false }),
    ]);
  });

  it('leaves withinRangeWindow off every other change', () => {
    render(<ClimbList />);

    act(() => mocks.changeGrade?.({ minGradeId: 10, maxGradeId: 10 }, { gesture: 'tap' }));
    act(() => mocks.changeGrade?.({ minGradeId: 10, maxGradeId: 14 }, { gesture: 'hold' }));
    act(() => mocks.changeGrade?.({ minGradeId: undefined, maxGradeId: undefined }, { gesture: 'clear' }));

    for (const payload of gradeChanges()) expect(payload).not.toHaveProperty('withinRangeWindow');
  });

  it('sends no free text and no identifier', () => {
    render(<ClimbList />);

    act(() => mocks.changeGrade?.({ minGradeId: 10, maxGradeId: 14 }, { gesture: 'hold' }));
    const [payload] = gradeChanges();
    expect(Object.keys(payload as object).sort()).toEqual(['fromMax', 'fromMin', 'gesture', 'toMax', 'toMin']);
  });

  it('reports a change made in the iPad popover too', () => {
    mocks.deviceLayout = { isPad: true, isTablet: true, widthClass: 'regular' };
    render(<ClimbList />);
    act(() => mocks.openGrade?.());

    act(() => mocks.changeGrade?.({ minGradeId: 10, maxGradeId: 12 }, { gesture: 'tap' }));
    expect(gradeChanges()).toHaveLength(1);
  });

  it('adds the grade format to Climb Search Performed', async () => {
    mocks.searchState = { filters: { minGrade: 10, maxGrade: 12 }, boardFilters: {}, name: 'crimp' };
    render(<ClimbList />);

    await waitFor(() =>
      expect(mocks.track).toHaveBeenCalledWith(
        'Climb Search Performed',
        expect.objectContaining({ minGrade: 10, maxGrade: 12, gradeFormat: 'v-grade' }),
      ),
    );
  });
});

// A new search puts the list back at its top. Under the UIKit header iOS insets
// the list by the bar's height, so its top is that far ABOVE offset 0; scrolling
// to 0 there parks the first result behind the header and the chips.
describe('ClimbList scroll reset on a new search', () => {
  const GRADED_SEARCH = { filters: { minGrade: 14, maxGrade: 14 }, boardFilters: {}, name: '' };

  it('returns to the inset top under the native header', () => {
    const { rerender, getByTestId } = render(<ClimbList />);
    expect(mocks.scrollToOffset).not.toHaveBeenCalled();
    // Without this React Native clamps the negative offset back to 0.
    expect(getByTestId('flash-list').getAttribute('data-scroll-to-overflow')).toBe('true');

    mocks.searchState = GRADED_SEARCH;
    rerender(<ClimbList />);
    expect(mocks.scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: -100, animated: false });
  });

  it('returns to offset 0 where the list is not inset natively', () => {
    mocks.nativeRootHeader = false;
    const { rerender, getByTestId } = render(<ClimbList />);
    expect(getByTestId('flash-list').getAttribute('data-scroll-to-overflow')).toBe('false');

    mocks.searchState = GRADED_SEARCH;
    rerender(<ClimbList />);
    expect(mocks.scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 0, animated: false });
  });
});

describe('ClimbList live filter session integration', () => {
  const selectedFilters: ClimbFilters = { sortBy: 'ascents', sortOrder: 'desc', status: 'any', minGrade: 14 };
  const selectedBoardFilters: ClimbBoardFilterState = { onlyBenchmarks: true };
  const latestSheet = () => {
    if (!mocks.filterSheetProps) throw new Error('Expected an open filter sheet');
    return mocks.filterSheetProps;
  };
  const openSheet = async () => {
    mocks.statefulSearch = true;
    const view = render(<ClimbList />);
    await view.findByText('Moonage');
    vi.useFakeTimers();
    act(() => mocks.openFilters?.());
    expect(view.getByTestId('filter-sheet')).toBeDefined();
    return view;
  };

  afterEach(() => vi.useRealTimers());

  it.each(['board arrival', 'board switch'] as const)(
    'blocks both Filters entry points until a deferred restore finishes after %s',
    async (arrival) => {
      mocks.statefulSearch = true;
      mocks.renderFilterChrome = true;
      const savedSearch: LastSearch = {
        filters: { ...selectedFilters, minGrade: 8 },
        boardFilters: {},
        searchText: 'saved climb',
        updatedAt: 1,
      };
      let resolveRestore: (saved: LastSearch) => void = () => {
        throw new Error('Expected the restore promise to be initialized');
      };
      const pendingRestore = new Promise<LastSearch>((resolve) => {
        resolveRestore = resolve;
      });
      if (arrival === 'board arrival') mocks.getLastSearch.mockReturnValueOnce(pendingRestore);
      const view = render(<ClimbList />);
      let previousBoardOpen: (() => void) | undefined;
      if (arrival === 'board switch') {
        await view.findByText('Moonage');
        previousBoardOpen = mocks.openFilters;
        mocks.getLastSearch.mockReturnValueOnce(pendingRestore);
        mocks.activeBoard = { boardType: 'tension', layoutId: 10, sizeId: 7, setIds: '4', angle: 35 };
        view.rerender(<ClimbList />);
      }
      mocks.replaceSearch.mockClear();
      expect(mocks.openFilters).toBeDefined();
      expect(mocks.openFiltersFromChips).toBeDefined();
      act(() => {
        mocks.openFilters?.();
        mocks.openFiltersFromChips?.();
        previousBoardOpen?.();
      });
      expect(view.queryByTestId('filter-sheet')).toBeNull();
      expect(mocks.filterSheetProps).toBeUndefined();
      expect(mocks.replaceSearch).not.toHaveBeenCalled();
      expect(mocks.addRecentFilter).not.toHaveBeenCalled();

      await act(async () => resolveRestore(savedSearch));
      expect(mocks.searchState).toEqual({
        filters: savedSearch.filters,
        boardFilters: savedSearch.boardFilters,
        name: savedSearch.searchText,
      });
      act(() => mocks.openFiltersFromChips?.());
      expect(view.getByTestId('filter-sheet')).toBeDefined();
      expect(latestSheet().currentFilters).toEqual(savedSearch.filters);
      const finalFilters = { ...selectedFilters, minGrade: 20 };
      await act(async () => {
        latestSheet().onSelectionChange(finalFilters, selectedBoardFilters);
        latestSheet().onDismiss();
      });
      expect(view.queryByTestId('filter-sheet')).toBeNull();
      expect(mocks.searchState).toEqual({
        filters: finalFilters,
        boardFilters: selectedBoardFilters,
        name: 'saved climb',
      });
      expect(mocks.searchInput).toEqual({
        filters: finalFilters,
        boardFilters: selectedBoardFilters,
        name: 'saved climb',
      });
      expect(mocks.addRecentFilter).toHaveBeenCalledExactlyOnceWith('', finalFilters, 'saved climb');
    },
  );

  it('flushes the raw name and latest pair on a quick close, recording one final recent', async () => {
    const view = await openSheet();
    const sheet = latestSheet();
    const finalFilters = { ...selectedFilters, minGrade: 20 };
    act(() => {
      sheet.onSelectionChange(selectedFilters, selectedBoardFilters);
      sheet.onNameChange('  crimp  ');
      sheet.onSelectionChange(finalFilters, selectedBoardFilters);
    });
    expect(mocks.searchState).toEqual({ filters: finalFilters, boardFilters: selectedBoardFilters, name: '' });
    expect(mocks.searchInput).toMatchObject({ filters: {}, boardFilters: {}, name: '' });
    expect(mocks.addRecentFilter).not.toHaveBeenCalled();

    await act(async () => {
      sheet.onDismiss();
      sheet.onDismiss();
    });
    expect(view.queryByTestId('filter-sheet')).toBeNull();
    expect(mocks.searchState).toEqual({ filters: finalFilters, boardFilters: selectedBoardFilters, name: 'crimp' });
    expect(mocks.searchInput).toEqual({ filters: finalFilters, boardFilters: selectedBoardFilters, name: 'crimp' });
    expect(mocks.addRecentFilter).toHaveBeenCalledExactlyOnceWith('', finalFilters, 'crimp');

    act(() => mocks.openFilters?.());
    expect(view.getByTestId('filter-sheet')).toBeDefined();
    act(() => {
      sheet.onDismiss();
      vi.advanceTimersByTime(300);
    });
    expect(view.getByTestId('filter-sheet')).toBeDefined();
    expect(mocks.addRecentFilter).toHaveBeenCalledTimes(1);
  });

  it('runs the name query at 300 ms without another filter delay or intermediate recent', async () => {
    await openSheet();
    const sheet = latestSheet();
    act(() => {
      sheet.onSelectionChange(selectedFilters, selectedBoardFilters);
      sheet.onNameChange('crimp');
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(mocks.searchInput).toEqual({ filters: selectedFilters, boardFilters: selectedBoardFilters, name: '' });
    expect(mocks.addRecentFilter).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(49);
    });
    expect(mocks.searchState.name).toBe('');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(mocks.searchInput).toEqual({ filters: selectedFilters, boardFilters: selectedBoardFilters, name: 'crimp' });
    expect(mocks.addRecentFilter).not.toHaveBeenCalled();
    await act(async () => latestSheet().onDismiss());
    expect(mocks.addRecentFilter).toHaveBeenCalledExactlyOnceWith('', selectedFilters, 'crimp');
  });

  it('records only the final grade-only preset after rapid edits and a close', async () => {
    await openSheet();
    const sheet = latestSheet();
    const finalFilters = { ...selectedFilters, minGrade: 20 };
    act(() => {
      sheet.onSelectionChange(selectedFilters, selectedBoardFilters);
      sheet.onSelectionChange(finalFilters, selectedBoardFilters);
    });
    expect(mocks.addRecentFilter).not.toHaveBeenCalled();
    await act(async () => {
      sheet.onDismiss();
      sheet.onDismiss();
    });
    expect(mocks.addRecentFilter).toHaveBeenCalledExactlyOnceWith('', finalFilters, '');
  });

  it('normalizes a signed-out restored draft before rendering, querying and recording the final preset', async () => {
    mocks.isAuthenticated = false;
    mocks.getLastSearch.mockResolvedValue({
      filters: { ...selectedFilters, status: 'drafts', hideCompleted: true, onlyRatedByMe: true },
      boardFilters: selectedBoardFilters,
      searchText: '',
      updatedAt: 1,
    });
    await openSheet();
    const expectedFilters = {
      ...selectedFilters,
      hideAttempted: undefined,
      hideCompleted: undefined,
      showOnlyAttempted: undefined,
      showOnlyCompleted: undefined,
      minUserRating: undefined,
      onlyRatedByMe: undefined,
      onlyFollowedAuthors: undefined,
    };
    expect(mocks.searchState.filters).toEqual(expectedFilters);
    expect(latestSheet().currentFilters).toEqual(expectedFilters);
    expect(mocks.searchInput).toEqual({ filters: expectedFilters, boardFilters: selectedBoardFilters, name: '' });
    await act(async () => latestSheet().onDismiss());
    expect(mocks.addRecentFilter).toHaveBeenCalledExactlyOnceWith('', expectedFilters, '');
    expect(mocks.searchState.filters).toEqual(expectedFilters);
  });

  it.each(['board', 'angle', 'signed out'] as const)(
    'rejects pending and stale field/selection/close callbacks after changing %s',
    async (scopeChange) => {
      const view = await openSheet();
      const oldSheet = latestSheet();
      act(() => oldSheet.onNameChange('unfinished old name'));
      mocks.getLastSearch.mockResolvedValue({ filters: {}, boardFilters: {}, searchText: 'new scope', updatedAt: 1 });
      if (scopeChange === 'signed out') mocks.isAuthenticated = false;
      else if (scopeChange === 'angle') mocks.activeBoard = { ...mocks.activeBoard!, angle: 45 };
      else mocks.activeBoard = { boardType: 'tension', layoutId: 10, sizeId: 7, setIds: '4', angle: 35 };
      await act(async () => view.rerender(<ClimbList />));
      expect(view.queryByTestId('filter-sheet')).toBeNull();
      expect(mocks.searchState.name).toBe('new scope');
      mocks.setName.mockClear();
      mocks.replaceSearch.mockClear();

      act(() => {
        oldSheet.onNameChange('late old name');
        oldSheet.onClearName();
        oldSheet.onSelectionChange(selectedFilters, selectedBoardFilters);
        oldSheet.onDismiss();
        vi.advanceTimersByTime(350);
      });
      expect(mocks.setName).not.toHaveBeenCalled();
      expect(mocks.replaceSearch).not.toHaveBeenCalled();
      expect(mocks.searchState).toEqual({ filters: {}, boardFilters: {}, name: 'new scope' });
      expect(mocks.addRecentFilter).not.toHaveBeenCalled();
    },
  );

  it('clears a pending name through Reset without closing or restoring it later', async () => {
    const view = await openSheet();
    const sheet = latestSheet();
    act(() => {
      sheet.onSelectionChange(selectedFilters, selectedBoardFilters);
      sheet.onNameChange('unfinished');
      sheet.onSelectionChange({ sortBy: 'ascents', sortOrder: 'desc', status: 'any' }, {});
      sheet.onClearName();
      vi.advanceTimersByTime(300);
    });
    expect(view.getByTestId('filter-sheet')).toBeDefined();
    expect(mocks.searchState).toEqual({
      filters: { sortBy: 'ascents', sortOrder: 'desc', status: 'any' },
      boardFilters: {},
      name: '',
    });
    await act(async () => latestSheet().onDismiss());
    expect(mocks.addRecentFilter).not.toHaveBeenCalled();
  });
});
