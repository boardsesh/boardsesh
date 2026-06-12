import { memo, useState, useCallback, useMemo, useRef, useEffect, type ComponentProps } from 'react';
import {
  View,
  StyleSheet,
  RefreshControl,
  Keyboard,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { Climb, BoardName } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import {
  toClimbSearchInput,
  mergeBoardFilters,
  countActiveFilters,
  hasActiveBoardFilters,
  DEFAULT_CLIMB_FILTER_STATE,
  DEFAULT_CLIMB_BOARD_FILTER_STATE,
  type ClimbBoardFilterState,
} from '@boardsesh/climb-filters';
import { ClimbListRow } from '../../../src/components/ClimbListRow';
import { ClimbListRowSkeleton } from '../../../src/components/ClimbListRowSkeleton';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { Text } from '../../../src/components/Text';
import { Icon } from '../../../src/components/Icon';
import { Button } from '../../../src/components/Button';
import { ClimbFilterSheet, hasActiveFilters, type ClimbFilters } from '../../../src/components/ClimbFilterSheet';
import { ClimbFilterFab } from '../../../src/components/search/ClimbFilterFab';
import { ClimbTopChrome } from '../../../src/components/search/ClimbTopChrome';
import { useDrawerHost } from '../../../src/providers/drawer-host-provider';
import { useFeatureFlag } from '../../../src/providers/feature-flags-provider';
import { useTheme } from '../../../src/providers/theme-provider';
import { useActiveClimbUuid, useQueueActions } from '../../../src/providers/queue-provider';
import { ClimbSearchProvider, useClimbSearch, type GradeBound } from '../../../src/providers/climb-search-provider';
import { useBoardProvider } from '@boardsesh/board-react';
import { randomUUID } from 'expo-crypto';
import { type SearchHeaderHandle } from '../../../src/components/SearchHeader';
import { RecentFilterPills } from '../../../src/components/RecentFilterPills';
import { useNativeAccessoryActive } from '../../../src/hooks/use-bottom-accessory';
import { useBottomChromeMetrics } from '../../../src/hooks/use-bottom-chrome-metrics';
import { useGrades, useSearchClimbsCount } from '../../../src/lib/graphql/hooks';
import { useGradeFormat } from '../../../src/hooks/use-grade-format';
import { useInfiniteSearchClimbs } from '../../../src/lib/graphql/hooks/use-infinite-search-climbs';
import { SEARCH_CLIMBS, type SearchClimbsQueryResponse } from '../../../src/lib/graphql/operations';
import { getHttpClient } from '../../../src/lib/graphql/client';
import { usePlaylistActivation } from '../../../src/lib/playlists/use-playlist-activation';
import { toQueueClimb, toQueueClimbs } from '../../../src/lib/climb-types';
import { parseSetIdsParam, prewarmCreateBoardHolds } from '../../../src/lib/create-board-holds';
import { useActiveBoard } from '../../../src/lib/graphql/use-active-board';
import { useAuth } from '../../../src/providers/auth-provider';
import { ensureBackgroundsCached } from '../../../src/lib/background-image-cache';
import {
  getRecentFilters,
  addRecentFilter,
  clearRecentFilters,
  type RecentFilter,
} from '../../../src/lib/recent-filter-store';
import { getLastSearch, saveLastSearch, boardConfigKey } from '../../../src/lib/last-search-store';
import { getFilterSummary, buildClimbFilterSummary } from '../../../src/lib/filter-summary';
import { getActiveFilterTokens } from '../../../src/lib/filter-tokens';
import { normalizeSearchName, visibleSearchTextNeedsSync } from '../../../src/lib/search-name';
import { track } from '../../../src/lib/analytics';
import { iosSystemColors } from '../../../src/theme/ios-colors';
import { spacing } from '../../../src/theme/tokens';
import { glassSize } from '../../../src/theme/layout';

const PAGE_SIZE = 30;
// Soft character budget for the glass filter-summary title: include whole filter
// parts up to roughly two wrapped lines before collapsing the rest into "+N more".
// It only decides *when* to summarise — the title's `numberOfLines={2}` +
// ellipsize is the hard visual cap, so larger accessibility text sizes degrade to
// truncation rather than overflowing the layout.
const SUMMARY_MAX_CHARS = 28;
const SEARCH_DEBOUNCE_MS = 300;
const INITIAL_SKELETON_ROW_COUNT = 10;
const FOOTER_SKELETON_ROW_COUNT = 6;
// Debounce persisting the per-board last search so rapid grade nudges don't
// thrash secure-store.
const SAVE_DEBOUNCE_MS = 600;
const PREWARM_BOARD_HOLDS_DELAY_MS = 1200;

type NativeSearchBarRef = {
  focus: () => void;
  blur: () => void;
  setText: (text: string) => void;
  clearText: () => void;
  toggleCancelButton: (show: boolean) => void;
  cancelSearch: () => void;
};

type NativeSearchChange = string | { nativeEvent?: { text?: string } };

function readNativeSearchText(change: NativeSearchChange): string {
  return typeof change === 'string' ? change : (change.nativeEvent?.text ?? '');
}

function queryLengthBucket(query: string): 'none' | 'short' | 'medium' | 'long' {
  const queryLength = query.trim().length;
  if (queryLength === 0) return 'none';
  if (queryLength <= 8) return 'short';
  if (queryLength <= 24) return 'medium';
  return 'long';
}

export default function ClimbList() {
  return (
    <ClimbSearchProvider>
      <ClimbListInner />
    </ClimbSearchProvider>
  );
}

// Reads the active-climb selector itself, so navigating climbs re-renders only
// these cheap row wrappers (and the two ClimbListRows whose `selected` flips) —
// never ClimbListInner or the FlashList. ClimbListRow stays presentational (a
// plain `selected` prop), so PlaylistDetailView's rows are unaffected.
const ActiveAwareClimbListRow = memo(function ActiveAwareClimbListRow(
  props: Omit<ComponentProps<typeof ClimbListRow>, 'selected'>,
) {
  const activeClimbUuid = useActiveClimbUuid();
  return <ClimbListRow {...props} selected={props.climb.uuid === activeClimbUuid} />;
});

function ClimbListInner() {
  const router = useRouter();
  const { t } = useTranslation('climbs');
  const { openClimbActions, openAddToPlaylist, openBoardSheet } = useDrawerHost();
  const boardPresenceEnabled = useFeatureFlag('board-presence') === true;
  // With board-presence on, the board capsule opens the wall's "now on the wall"
  // sheet (the switcher moves inside it). Off → today's behaviour: open the
  // board switcher directly.
  const handleOpenBoardDetail = useCallback(() => {
    if (boardPresenceEnabled) {
      openBoardSheet();
    } else {
      router.push('/boards');
    }
  }, [boardPresenceEnabled, openBoardSheet, router]);
  const { systemColors, variant, brandColors } = useTheme();
  const { addToQueue } = useQueueActions();
  const {
    filters,
    boardFilters,
    name,
    setFilters,
    setBoardFilters,
    setGrade,
    setName,
    replaceSearch,
    patchFilters,
    patchBoardFilters,
  } = useClimbSearch();
  const { getLogbook } = useBoardProvider();
  const searchHeaderRef = useRef<SearchHeaderHandle>(null);
  const nativeSearchRef = useRef<NativeSearchBarRef>(null);
  const visibleSearchTextRef = useRef('');
  const insets = useSafeAreaInsets();
  const bottomChrome = useBottomChromeMetrics();

  // Scroll offset drives the glass large in-body filter title collapsing into the
  // top chrome; tapping the collapsed title capsule scrolls the list back to top.
  const listRef = useRef<FlashListRef<Climb>>(null);
  const scrollY = useSharedValue(0);
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollY.value = event.nativeEvent.contentOffset.y;
    },
    [scrollY],
  );
  const handleScrollToTop = useCallback(() => {
    listRef.current?.scrollToTop({ animated: true });
  }, []);

  // iOS 26 uses the native tab-bar bottom accessory for current climb + tick, and
  // presents this screen's headerSearchBarOptions controller in the bottom tab
  // bar's search role — there is no header search bar. Fallback devices keep the
  // custom search field inside the top chrome.
  const useNativeSearch = useNativeAccessoryActive();

  const listPaddingBottom = bottomChrome.scrollBottomPadding;
  const filterFabNativeAccessoryDrop = bottomChrome.nativeAccessoryVisible ? glassSize.standard * 2 : 0;
  const filterFabMinimumBottom = bottomChrome.nativeAccessoryVisible
    ? insets.bottom + spacing[2]
    : bottomChrome.tabBarBottom + spacing[2];
  const filterFabBottom = Math.max(
    filterFabMinimumBottom,
    bottomChrome.floatingControlBottom + spacing[2] - filterFabNativeAccessoryDrop,
  );

  // On the Material variant the filter lives in the top-right toolbar (next to
  // the light/bluetooth button) inside ClimbTopChrome, so the bottom filter FAB
  // is not rendered here.
  const filterInTopChrome = variant === 'material';

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [searchTextLength, setSearchTextLength] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [showGrade, setShowGrade] = useState(false);
  const [recentFilters, setRecentFilters] = useState<RecentFilter[]>([]);
  // Measured height of the floating glass chrome (incl. the top safe-area inset).
  // The list pads its top by this so the first row rests below the chrome and the
  // rest scroll under it.
  const [searchBarHeight, setSearchBarHeight] = useState(() => insets.top + 60);

  const blurSearchInputs = useCallback(() => {
    Keyboard.dismiss();
    searchHeaderRef.current?.blur();
    nativeSearchRef.current?.blur();
    setIsSearchFocused(false);
  }, []);

  const handleOpenFilters = useCallback(() => {
    blurSearchInputs();
    setShowGrade(false);
    setShowFilters(true);
  }, [blurSearchInputs]);
  const handleDismissFilters = useCallback(() => {
    setShowFilters(false);
  }, []);
  const handleOpenGrade = useCallback(() => {
    blurSearchInputs();
    setShowFilters(false);
    setShowGrade(true);
  }, [blurSearchInputs]);
  const handleDismissGrade = useCallback(() => setShowGrade(false), []);

  const applyVisibleSearchText = useCallback((text: string) => {
    setSearchTextLength(text.length);
    const customSearch = searchHeaderRef.current;
    const nativeSearch = nativeSearchRef.current;
    // Seed the displayed text only — never re-enter onChangeText, which would
    // re-arm the input debounce and redundantly re-commit the term. Callers
    // commit `name` through the search provider (replaceSearch / setName); this
    // just mirrors it into the field. (The native bar's setText likewise does
    // not fire its change handler.)
    customSearch?.setText(text, { silent: true });
    nativeSearch?.setText(text);
    return customSearch != null || nativeSearch != null;
  }, []);

  const handleSearchChange = useCallback(
    (text: string) => {
      const nextName = normalizeSearchName(text);
      visibleSearchTextRef.current = text;
      setSearchTextLength(nextName.length);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        setName(nextName);
      }, SEARCH_DEBOUNCE_MS);
    },
    [setName],
  );

  const handleNativeSearchChange = useCallback(
    (change: NativeSearchChange) => {
      handleSearchChange(readNativeSearchText(change));
    },
    [handleSearchChange],
  );

  const handleNativeSearchCancel = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    setShowFilters(false);
    visibleSearchTextRef.current = '';
    setSearchTextLength(0);
    setName('');
    nativeSearchRef.current?.clearText();
  }, [setName]);

  const handleSearchFocus = useCallback(() => {
    setShowGrade(false);
    setIsSearchFocused(true);
  }, []);
  const handleSearchBlur = useCallback(() => {
    setIsSearchFocused(false);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  const { isAuthenticated } = useAuth();

  // Load recent filters on mount. Pass auth state so auth-gated fields get
  // stripped from pills written by a prior signed-in session.
  useEffect(() => {
    getRecentFilters({ isAuthenticated })
      .then(setRecentFilters)
      .catch(() => {});
  }, [isAuthenticated]);

  const { data: activeBoard, isLoading: isBoardLoading } = useActiveBoard();

  const boardName = activeBoard?.boardType ?? '';
  const layoutId = activeBoard?.layoutId ?? 0;
  const sizeId = activeBoard?.sizeId ?? 0;
  const setIds = activeBoard?.setIds ?? '';
  const angle = activeBoard?.angle ?? 0;

  const hasBoardConfig = !!activeBoard;

  const { data: gradesData } = useGrades(boardName);
  const gradesRef = useRef(gradesData);
  gradesRef.current = gradesData;
  const grades = useMemo(() => gradesData ?? [], [gradesData]);
  const { formatGradeByDifficultyId } = useGradeFormat();

  const boardConfig = useMemo(
    () => (hasBoardConfig ? { boardName, layoutId, sizeId, setIds, angle } : null),
    [hasBoardConfig, boardName, layoutId, sizeId, setIds, angle],
  );
  const boardKey = boardConfig ? boardConfigKey(boardConfig) : null;

  // Per-board memory: restore this board's last search on arrival; a board
  // never searched before gets the clean default. `restoredKey` is state (not
  // just a ref) so the search queries can gate on it — that prevents a stale
  // fetch of the new board filtered by the *previous* board's grade/name while
  // the async restore is in flight, and the resulting wrong-results flash.
  const restoredKeyRef = useRef<string | null>(null);
  const [restoredKey, setRestoredKey] = useState<string | null>(null);
  useEffect(() => {
    if (!boardConfig || !boardKey) return;
    let cancelled = false;
    restoredKeyRef.current = null;
    setRestoredKey(null);
    getLastSearch(boardConfig, { isAuthenticated })
      .then((saved) => {
        if (cancelled) return;
        if (saved) {
          replaceSearch(saved.filters, saved.searchText, saved.boardFilters);
          visibleSearchTextRef.current = '';
          applyVisibleSearchText(saved.searchText);
        } else {
          // Never-searched board → clean default band, no grade/filters/name
          // inherited from the board the climber came from.
          replaceSearch(DEFAULT_CLIMB_FILTER_STATE, '', DEFAULT_CLIMB_BOARD_FILTER_STATE);
          visibleSearchTextRef.current = '';
          applyVisibleSearchText('');
        }
        restoredKeyRef.current = boardKey;
        setRestoredKey(boardKey);
      })
      .catch(() => {
        replaceSearch(DEFAULT_CLIMB_FILTER_STATE, '', DEFAULT_CLIMB_BOARD_FILTER_STATE);
        visibleSearchTextRef.current = '';
        applyVisibleSearchText('');
        restoredKeyRef.current = boardKey;
        setRestoredKey(boardKey);
      });
    return () => {
      cancelled = true;
    };
    // Restore is keyed on the board only — re-running on filter changes would
    // clobber the user's edits. replaceSearch is stable; searchHeaderRef is a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardKey, isAuthenticated, applyVisibleSearchText]);

  // Search is "ready" once this board's restore has landed — gate queries on it.
  const searchReady = hasBoardConfig && restoredKey === boardKey;

  useEffect(() => {
    if (!boardConfig || !searchReady) return;
    const timeout = setTimeout(() => {
      prewarmCreateBoardHolds({
        boardName: boardConfig.boardName as BoardName,
        layoutId: boardConfig.layoutId,
        sizeId: boardConfig.sizeId,
        setIds: parseSetIdsParam(boardConfig.setIds),
      });
    }, PREWARM_BOARD_HOLDS_DELAY_MS);
    return () => clearTimeout(timeout);
  }, [boardConfig, searchReady]);

  useEffect(() => {
    // Compare NORMALIZED so an in-progress trim-only difference (e.g. the user
    // typed "crimp " before the next word) isn't treated as a desync and the
    // field's trailing/leading whitespace isn't yanked out mid-typing. Genuine
    // external changes (board restore, recent pill, cancel) still sync.
    if (!searchReady || !visibleSearchTextNeedsSync(visibleSearchTextRef.current, name)) return;
    let cancelled = false;
    let syncAttempts = 0;

    const syncVisibleSearchText = () => {
      if (cancelled || !visibleSearchTextNeedsSync(visibleSearchTextRef.current, name)) return;
      const applied = applyVisibleSearchText(name);
      if (applied) {
        visibleSearchTextRef.current = name;
        return;
      }
      syncAttempts += 1;
      if (syncAttempts < 6) setTimeout(syncVisibleSearchText, 50);
    };

    syncVisibleSearchText();
    return () => {
      cancelled = true;
    };
  }, [applyVisibleSearchText, name, searchReady]);

  // Persist the current search for this board once the restore for it landed.
  useEffect(() => {
    if (!boardConfig || restoredKeyRef.current !== boardKey) return;
    const handle = setTimeout(() => {
      void saveLastSearch(boardConfig, filters, name, boardFilters);
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [filters, name, boardFilters, boardConfig, boardKey]);

  // Pre-warm bundled board backgrounds so the first tap into a climb paints
  // instantly. Backgrounds are bundled file:// assets — never fetch board art
  // over HTTP (the production CDN/WAF 403s the app's request).
  useEffect(() => {
    if (!activeBoard) return;
    const parsedSetIds = activeBoard.setIds.split(',').map(Number);
    void ensureBackgroundsCached({
      boardName: activeBoard.boardType as BoardName,
      layoutId: activeBoard.layoutId,
      sizeId: activeBoard.sizeId,
      setIds: parsedSetIds,
    });
  }, [activeBoard]);

  const searchInput = useMemo(
    () =>
      mergeBoardFilters(
        toClimbSearchInput(
          filters,
          { boardName, layoutId, sizeId, setIds, angle },
          { page: 0, pageSize: PAGE_SIZE },
          { name },
        ),
        boardFilters,
      ),
    [boardName, layoutId, sizeId, setIds, angle, name, filters, boardFilters],
  );

  const {
    data: searchPages,
    isLoading: isClimbsLoading,
    isFetchingNextPage,
    isRefetching,
    fetchNextPage,
    hasNextPage,
    refetch,
  } = useInfiniteSearchClimbs(searchInput, searchReady);
  const { data: totalCount } = useSearchClimbsCount(searchInput, searchReady);
  const isLoadingMoreRef = useRef(false);

  const visibleClimbs = useMemo(() => {
    const seenUuids = new Set<string>();
    const climbs: Climb[] = [];
    for (const page of searchPages?.pages ?? []) {
      for (const climb of page.climbs) {
        if (seenUuids.has(climb.uuid)) continue;
        seenUuids.add(climb.uuid);
        climbs.push(climb);
      }
    }
    return climbs;
  }, [searchPages?.pages]);

  const firstSearchPage = searchPages?.pages[0];

  useEffect(() => {
    if (!isFetchingNextPage) {
      isLoadingMoreRef.current = false;
    }
  }, [isFetchingNextPage]);

  // Fire "Climb Search Performed" once per resolved search/filter result set.
  // Keyed on the search text + filter signature so it fires when a new result
  // set lands — not on every keystroke (debounced upstream) or paginated page.
  const lastSearchTrackKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!firstSearchPage) return;
    // Skip the default state (no search text, no active filters): the initial
    // tab-mount load is not a user search/apply, and web suppresses it the same
    // way (only fires when at least one filter/term is active).
    if (name.length === 0 && !hasActiveFilters(filters) && !hasActiveBoardFilters(boardFilters)) return;
    const trackKey = JSON.stringify({ name, filters, boardFilters, boardName, layoutId, sizeId, setIds, angle });
    if (lastSearchTrackKeyRef.current === trackKey) return;
    lastSearchTrackKeyRef.current = trackKey;
    track(SHARED_EVENTS.ClimbSearchPerformed, {
      hasQuery: name.length > 0,
      queryLengthBucket: queryLengthBucket(name),
      // The search payload carries `climbs` + `hasMore` only — no total count
      // (that lives in the separate count query). Report the size of the
      // resolved page-0 result set, which is what's available at this point.
      resultCount: firstSearchPage.climbs.length,
      boardName,
      layoutId,
      sizeId,
      setIds,
      angle,
      // Grade-inclusive, matching the filter button's badge — a set grade is an
      // active filter, so the analytics count and the UI never disagree (and a
      // grade-only search reports 1, not 0).
      activeFilterCount: countActiveFilters(filters, boardFilters),
    });
  }, [firstSearchPage, name, filters, boardFilters, boardName, layoutId, sizeId, setIds, angle]);

  // Feed the visible climb UUIDs into the shared logbook so the ascent badge
  // can render flash/send/attempt without baking per-user counts into the
  // (CDN-cacheable) search query. `getLogbook` is a noop when the user is
  // anonymous or the active board hasn't resolved yet.
  useEffect(() => {
    if (visibleClimbs.length === 0) return;
    void getLogbook(visibleClimbs.map((climb) => climb.uuid));
  }, [visibleClimbs, getLogbook]);

  const handleRefresh = useCallback(() => {
    isLoadingMoreRef.current = false;
    void refetch();
  }, [refetch]);

  const handleEndReached = useCallback(() => {
    if (hasNextPage && !isClimbsLoading && !isFetchingNextPage && !isRefetching && !isLoadingMoreRef.current) {
      isLoadingMoreRef.current = true;
      void fetchNextPage().finally(() => {
        isLoadingMoreRef.current = false;
      });
    }
  }, [fetchNextPage, hasNextPage, isClimbsLoading, isFetchingNextPage, isRefetching]);

  // Page the same search query the list uses so the play-drawer swipe can walk
  // climbs beyond what's loaded. Activation pages and search pages are both 0-based.
  const fetchSearchPage = useCallback(
    async ({ page, pageSize }: { page: number; pageSize: number }) => {
      const input = mergeBoardFilters(
        toClimbSearchInput(filters, { boardName, layoutId, sizeId, setIds, angle }, { page, pageSize }, { name }),
        boardFilters,
      );
      const response = await getHttpClient().request<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input });
      return {
        climbs: toQueueClimbs(response.searchClimbs.climbs),
        hasMore: response.searchClimbs.hasMore,
      };
    },
    [filters, boardName, layoutId, sizeId, setIds, angle, name, boardFilters],
  );

  const allQueueClimbs = useMemo(() => toQueueClimbs(visibleClimbs), [visibleClimbs]);

  const activateClimbListClimb = usePlaylistActivation({
    sourceId: 'climblist',
    allClimbs: allQueueClimbs,
    fetchPage: fetchSearchPage,
    refreshErrorMessage: 'Failed to refresh climb-list suggestions:',
  });

  const handleClimbPress = useCallback(
    (climb: Climb) => {
      void activateClimbListClimb(toQueueClimb(climb));
    },
    [activateClimbListClimb],
  );

  const handleAddToQueue = useCallback(
    (climb: Climb) => {
      addToQueue({ uuid: randomUUID(), climb });
    },
    [addToQueue],
  );

  const handleApplyFilters = useCallback(
    (newFilters: ClimbFilters, newBoardFilters: ClimbBoardFilterState) => {
      setFilters(newFilters);
      setBoardFilters(newBoardFilters);
      setShowFilters(false);

      // Recent pills capture climb filters + name only (not board-renderer
      // filters), so we still gate on those for the pill.
      const currentSearch = name;
      if (hasActiveFilters(newFilters) || currentSearch.length > 0) {
        const label = getFilterSummary(newFilters, currentSearch, gradesRef.current, t);
        addRecentFilter(label, newFilters, currentSearch)
          .then(() => getRecentFilters({ isAuthenticated }))
          .then(setRecentFilters)
          .catch(() => {});
      }
    },
    [t, isAuthenticated, name, setFilters, setBoardFilters],
  );

  const handleApplyRecentFilter = useCallback(
    (pillFilters: ClimbFilters, pillSearchText: string) => {
      replaceSearch(pillFilters, pillSearchText);
      visibleSearchTextRef.current = '';
      applyVisibleSearchText(pillSearchText);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      Keyboard.dismiss();
      searchHeaderRef.current?.blur();
      setIsSearchFocused(false);
    },
    [applyVisibleSearchText, replaceSearch],
  );

  const handleClearRecentFilters = useCallback(() => {
    clearRecentFilters()
      .then(() => setRecentFilters([]))
      .catch(() => {});
  }, []);

  const handleGradeChange = useCallback(
    (next: GradeBound) => {
      setGrade(next);
    },
    [setGrade],
  );

  const handleCreateClimb = useCallback(() => {
    router.push({
      pathname: '/(tabs)/climbs/create',
      params: { boardName, layoutId: String(layoutId), sizeId: String(sizeId), setIds, angle: String(angle) },
    });
  }, [router, boardName, layoutId, sizeId, setIds, angle]);

  // Recent-filter pills live in the list header on search focus — only meaningful
  // with native search (the custom in-chrome field sits behind a scrim/keyboard,
  // so the list header isn't reachable while typing).
  const showRecentPills = useNativeSearch && isSearchFocused && searchTextLength === 0 && recentFilters.length > 0;
  // Show the spinner (not a premature "no climbs" empty state) while a board is
  // resolving or its per-board restore hasn't landed yet.
  const isBoardResolving = isBoardLoading || (hasBoardConfig && !searchReady);
  const showInitialSkeletons = isClimbsLoading && visibleClimbs.length === 0;

  const gradeBound = useMemo<GradeBound>(
    () => ({ minGradeId: filters.minGrade, maxGradeId: filters.maxGrade }),
    [filters.minGrade, filters.maxGrade],
  );
  const activeFilterCount = useMemo(() => countActiveFilters(filters, boardFilters), [filters, boardFilters]);
  // Removable active-filter tokens for the scope row beneath the search field.
  // Each token's `clear` patches just its field back to the default.
  const filterTokens = useMemo(
    () =>
      getActiveFilterTokens({
        filters,
        boardFilters,
        grades,
        t,
        formatGradeByDifficultyId,
        patchFilters,
        patchBoardFilters,
        setGrade,
      }),
    [filters, boardFilters, grades, t, formatGradeByDifficultyId, patchFilters, patchBoardFilters, setGrade],
  );
  const nonGradeFilterTokens = useMemo(
    () => filterTokens.filter((filterToken) => filterToken.key !== 'grade'),
    [filterTokens],
  );
  const summaryFilterTokens = variant === 'material' ? nonGradeFilterTokens : filterTokens;
  // Condensed summary of the active filters (variant-aware: Material chip vs glass
  // title). See buildClimbFilterSummary.
  const filterSummary = useMemo(
    () =>
      buildClimbFilterSummary({
        labels: summaryFilterTokens.map((token) => token.label),
        isMaterial: variant === 'material',
        maxChars: SUMMARY_MAX_CHARS,
        more: (count) => t('mobile.search.more', { count }),
      }),
    [summaryFilterTokens, variant, t],
  );
  // The glass screen title: the active-filter summary, or "All climbs" when none.
  // Shown both as the large in-body title and the collapsed header capsule.
  const searchTitle = filterSummary ?? t('mobile.search.allClimbs');
  const gradeFilterToken = useMemo(
    () => filterTokens.find((filterToken) => filterToken.key === 'grade'),
    [filterTokens],
  );
  const gradeChip = useMemo(() => {
    if (gradeFilterToken) {
      return { label: gradeFilterToken.label, active: true, onClear: gradeFilterToken.clear };
    }
    return { label: t('mobile.filter.gradeRange'), active: false };
  }, [gradeFilterToken, t]);

  // Memoized so FlashList doesn't re-measure/re-render the header on every
  // ClimbListInner render — only when the title, pills, or filters change.
  const listHeader = useMemo(
    () => (
      <>
        {/* Glass variant: the screen's identity in-body under the floating
            chrome — the active filter ("V4–V6 · Quality") or "All climbs" —
            collapsing into the centered header capsule as it scrolls up. The
            Material variant shows the title in its Appbar instead. */}
        {variant === 'material' ? null : (
          <Text variant="largeTitle" numberOfLines={2} ellipsizeMode="tail" style={styles.screenTitle}>
            {searchTitle}
          </Text>
        )}
        {showRecentPills ? (
          <RecentFilterPills
            recentFilters={recentFilters}
            currentFilters={filters}
            currentSearchText={name}
            onApply={handleApplyRecentFilter}
            onClear={handleClearRecentFilters}
          />
        ) : null}
      </>
    ),
    [
      variant,
      searchTitle,
      showRecentPills,
      recentFilters,
      filters,
      name,
      handleApplyRecentFilter,
      handleClearRecentFilters,
    ],
  );

  const stackOptions = useMemo(
    () =>
      useNativeSearch
        ? {
            // iOS 26 presents this screen's search controller in the bottom tab
            // bar (the NativeTabs role="search" liquid-glass pattern) — there is
            // no header search bar. The header only has to stay mounted to host
            // the controller, so we make it fully invisible: transparent, no
            // blur (the parent layout's systemMaterial was the grey bar), no
            // shadow, no title. The floating glass chrome then owns the top.
            headerShown: true,
            headerTransparent: true,
            headerBlurEffect: 'none' as const,
            headerShadowVisible: false,
            headerStyle: { backgroundColor: 'transparent' },
            title: '',
            headerSearchBarOptions: {
              ref: nativeSearchRef,
              placement: 'automatic' as const,
              placeholder: t('search.placeholders.climbs'),
              autoCapitalize: 'none' as const,
              hideWhenScrolling: false,
              obscureBackground: false,
              onChangeText: handleNativeSearchChange,
              onFocus: handleSearchFocus,
              onBlur: handleSearchBlur,
              onCancelButtonPress: handleNativeSearchCancel,
            },
          }
        : { headerShown: false },
    [useNativeSearch, t, handleNativeSearchChange, handleSearchFocus, handleSearchBlur, handleNativeSearchCancel],
  );

  const renderClimbItem = useCallback(
    ({ item: climb }: { item: Climb }) => (
      <ActiveAwareClimbListRow
        climb={climb}
        boardName={boardName as BoardName}
        layoutId={layoutId}
        sizeId={sizeId}
        setIds={setIds}
        angle={angle}
        onPress={handleClimbPress}
        onOpenActions={openClimbActions}
        onOpenPlaylist={openAddToPlaylist}
        onAddToQueue={handleAddToQueue}
      />
    ),
    [
      boardName,
      layoutId,
      sizeId,
      setIds,
      angle,
      handleClimbPress,
      openClimbActions,
      openAddToPlaylist,
      handleAddToQueue,
    ],
  );

  if (!hasBoardConfig && !isBoardLoading) {
    return (
      <>
        <Stack.Screen options={stackOptions} />
        <View style={styles.emptyContainer}>
          <Icon name="boards" size={48} color={iosSystemColors.systemGray4} />
          <Text variant="headline" style={styles.emptyTitle}>
            {t('mobile.emptyState.noBoard.title')}
          </Text>
          <Text variant="subheadline" style={styles.emptySubtitle}>
            {t('mobile.emptyState.noBoard.subtitle')}
          </Text>
          {/* Board selection is a modal now. When BLE serial auto-detect lands it
              calls useSetActiveBoard(); useActiveBoard() then flips this screen to
              the climb list with no extra wiring here. */}
          <Button
            title={t('mobile.emptyState.noBoard.cta')}
            onPress={() => router.push('/boards')}
            variant="filled"
            size="large"
            style={styles.emptyCta}
          />
        </View>
      </>
    );
  }

  if (isBoardResolving) {
    return (
      <>
        <Stack.Screen options={stackOptions} />
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" />
        </View>
      </>
    );
  }

  const isEmpty = visibleClimbs.length === 0 && !isClimbsLoading;

  return (
    <View style={[styles.container, { backgroundColor: systemColors.background }]}>
      <Stack.Screen options={stackOptions} />
      <FlashList
        ref={listRef}
        data={visibleClimbs}
        renderItem={renderClimbItem}
        keyExtractor={keyExtractor}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        // The header is transparent on every path now, so the chrome owns the top
        // inset and the list pads manually by the measured chrome height. Leaving
        // this 'automatic' would double-inset under the (invisible) native header.
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingTop: searchBarHeight, paddingBottom: listPaddingBottom }}
        scrollIndicatorInsets={{ top: searchBarHeight }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={handleRefresh} tintColor={brandColors.primary} />
        }
        ListHeaderComponent={listHeader}
        ListFooterComponent={isFetchingNextPage ? <ClimbListSkeletonRows count={FOOTER_SKELETON_ROW_COUNT} /> : null}
        ListEmptyComponent={
          showInitialSkeletons ? (
            <ClimbListSkeletonRows count={INITIAL_SKELETON_ROW_COUNT} />
          ) : isEmpty ? (
            <View style={styles.emptyContainer}>
              <Icon name="search" size={48} color={iosSystemColors.systemGray4} />
              <Text variant="headline" style={styles.emptyTitle}>
                {name.length > 0 ? t('mobile.emptyState.noMatches.title') : t('mobile.emptyState.noClimbs.title')}
              </Text>
              <Text variant="subheadline" style={styles.emptySubtitle}>
                {name.length > 0
                  ? t('mobile.emptyState.noMatches.description', { query: name })
                  : t('mobile.emptyState.noClimbs.subtitle')}
              </Text>
            </View>
          ) : null
        }
      />

      <ClimbTopChrome
        searchMode={useNativeSearch ? 'native' : 'custom'}
        title={searchTitle}
        canCreate={isAuthenticated && hasBoardConfig}
        onCreate={handleCreateClimb}
        onOpenBoardDetail={handleOpenBoardDetail}
        onHeightChange={setSearchBarHeight}
        scrollY={scrollY}
        onPressTitle={handleScrollToTop}
        searchFieldRef={searchHeaderRef}
        searchInitialValue={name}
        searchPlaceholder={t('search.placeholders.climbs')}
        onSearchChange={handleSearchChange}
        onSearchFocus={handleSearchFocus}
        onSearchBlur={handleSearchBlur}
        onCloseGrade={handleDismissGrade}
        activeFilterCount={activeFilterCount}
        onOpenFilters={handleOpenFilters}
        totalCount={totalCount}
        filterTokens={variant === 'material' ? nonGradeFilterTokens : filterTokens}
        gradeBound={gradeBound}
        grades={grades}
        gradeRailVisible={showGrade}
        gradeChip={gradeChip}
        onOpenGrade={handleOpenGrade}
        onGradeChange={handleGradeChange}
      />

      {filterInTopChrome ? null : (
        <ClimbFilterFab
          activeFilterCount={activeFilterCount}
          bottom={filterFabBottom}
          totalCount={totalCount}
          filterTokens={filterTokens}
          bound={gradeBound}
          grades={grades}
          gradeRailVisible={showGrade}
          onOpenFilters={handleOpenFilters}
          onOpenGrade={handleOpenGrade}
          onCloseGrade={handleDismissGrade}
          onGradeChange={handleGradeChange}
        />
      )}

      {showFilters ? (
        <ClimbFilterSheet
          onDismiss={handleDismissFilters}
          boardConfig={boardConfig}
          currentFilters={filters}
          currentBoardFilters={boardFilters}
          searchName={name}
          onApply={handleApplyFilters}
        />
      ) : null}
    </View>
  );
}

function keyExtractor(item: Climb) {
  return item.uuid;
}

function ClimbListSkeletonRows({ count }: { count: number }) {
  return (
    <View>
      {Array.from({ length: count }, (_item, index) => (
        <ClimbListRowSkeleton key={`climb-skeleton-${index}`} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  screenTitle: {
    paddingHorizontal: spacing[4],
    paddingTop: 0,
    paddingBottom: spacing[2],
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 120,
    paddingHorizontal: 32,
    gap: 8,
  },
  emptyTitle: {
    marginTop: 12,
    opacity: 0.6,
  },
  emptySubtitle: {
    opacity: 0.4,
    textAlign: 'center',
  },
  emptyCta: {
    marginTop: spacing[4],
  },
});
