import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { View, StyleSheet, RefreshControl, Image, Keyboard } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { Climb, BoardName } from '@boardsesh/shared-schema';
import {
  toClimbSearchInput,
  mergeBoardFilters,
  countActiveFiltersBeyondGrade,
  DEFAULT_CLIMB_FILTER_STATE,
  DEFAULT_CLIMB_BOARD_FILTER_STATE,
  type ClimbBoardFilterState,
} from '@boardsesh/climb-filters';
import { ClimbListRow } from '../../../src/components/ClimbListRow';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { Text } from '../../../src/components/Text';
import { Icon } from '../../../src/components/Icon';
import { ClimbFilterSheet, hasActiveFilters, type ClimbFilters } from '../../../src/components/ClimbFilterSheet';
import { GradePopover } from '../../../src/components/search/GradePopover';
import { ClimbSearchBar } from '../../../src/components/search/ClimbSearchBar';
import { ClimbTopChrome } from '../../../src/components/search/ClimbTopChrome';
import { SearchFab } from '../../../src/components/search/SearchFab';
import { BoardDetailSheet } from '../../../src/components/board-discovery/BoardDetailSheet';
import { useDrawerHost } from '../../../src/providers/drawer-host-provider';
import { useTheme } from '../../../src/providers/theme-provider';
import { useQueue } from '../../../src/providers/queue-provider';
import { ClimbSearchProvider, useClimbSearch, type GradeBound } from '../../../src/providers/climb-search-provider';
import { useBoardProvider } from '@boardsesh/board-react';
import { randomUUID } from 'expo-crypto';
import { type SearchHeaderHandle } from '../../../src/components/SearchHeader';
import { RecentFilterPills } from '../../../src/components/RecentFilterPills';
import { TAB_BAR_HEIGHT, TOOLBAR_RESERVE, TOOLBAR_GAP_ABOVE_TABBAR } from '../../../src/theme/layout';
import { useSearchClimbs, useSearchClimbsCount, useGrades } from '../../../src/lib/graphql/hooks';
import { SEARCH_CLIMBS, type SearchClimbsQueryResponse } from '../../../src/lib/graphql/operations';
import { getHttpClient } from '../../../src/lib/graphql/client';
import { usePlaylistActivation } from '../../../src/lib/playlists/use-playlist-activation';
import { toQueueClimb, toQueueClimbs } from '../../../src/lib/climb-types';
import { useActiveBoard, useSetActiveBoard } from '../../../src/lib/graphql/use-active-board';
import { useAuth } from '../../../src/providers/auth-provider';
import { accumulateClimbs } from '../../../src/lib/climb-pagination';
import { getBoardRenderData } from '../../../src/lib/board-details';
import {
  getRecentFilters,
  addRecentFilter,
  clearRecentFilters,
  type RecentFilter,
} from '../../../src/lib/recent-filter-store';
import { getLastSearch, saveLastSearch, boardConfigKey } from '../../../src/lib/last-search-store';
import { getFilterSummary } from '../../../src/lib/filter-summary';
import { useSearchLayout } from '../../../src/lib/search-layout-preference';
import { brandColors } from '../../../src/theme/colors';
import { iosSystemColors } from '../../../src/theme/ios-colors';

const PAGE_SIZE = 30;
const SEARCH_DEBOUNCE_MS = 300;
// Debounce persisting the per-board last search so rapid grade nudges don't
// thrash secure-store.
const SAVE_DEBOUNCE_MS = 600;

export default function ClimbList() {
  return (
    <ClimbSearchProvider>
      <ClimbListInner />
    </ClimbSearchProvider>
  );
}

function ClimbListInner() {
  const router = useRouter();
  const { t } = useTranslation('climbs');
  const { openClimbActions, openAddToPlaylist } = useDrawerHost();
  const { systemColors } = useTheme();
  const { addToQueue, state: queueState } = useQueue();
  const {
    filters,
    boardFilters,
    name,
    setFilters,
    setBoardFilters,
    patchFilters,
    patchBoardFilters,
    setGrade,
    setName,
    replaceSearch,
  } = useClimbSearch();
  const { layout, loaded: layoutLoaded } = useSearchLayout();
  // The active climb (driving the board / persistent queue bar). We highlight
  // its row so the search → tap → change-active loop is always visible.
  const activeClimbUuid = queueState.currentClimbQueueItem?.climb?.uuid;
  const hasActiveClimb = !!activeClimbUuid;
  const { getLogbook } = useBoardProvider();
  const searchHeaderRef = useRef<SearchHeaderHandle>(null);
  const insets = useSafeAreaInsets();

  // One floating toolbar (search · capsule · tick) replaces the stacked queue
  // mini-player + search fab. The capsule + tick live in the global toolbar; the
  // search fab floats into its reserved left gutter at the same `toolbarBottom`.
  // The toolbar is a single fixed-height row whether or not a climb is active, so
  // the reserve is constant on the bottom-bar layout (and on any layout while a
  // climb is active, since the global capsule + tick still float there).
  const toolbarBottom = insets.bottom + TAB_BAR_HEIGHT + TOOLBAR_GAP_ABOVE_TABBAR;
  const listPaddingBottom =
    insets.bottom + TAB_BAR_HEIGHT + (layout === 'bottom-bar' || hasActiveClimb ? TOOLBAR_RESERVE : 0);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [searchTextLength, setSearchTextLength] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [showGrade, setShowGrade] = useState(false);
  const [recentFilters, setRecentFilters] = useState<RecentFilter[]>([]);
  // Measured height of the floating glass search row (incl. the top safe-area
  // inset). The list pads its top by this so the first row rests below the bar
  // and the rest scroll under it; re-measures when the chips row appears.
  const [searchBarHeight, setSearchBarHeight] = useState(insets.top + 60);
  // Board-detail sheet, opened from the bottom-bar experiment's top board capsule.
  const [showBoardDetail, setShowBoardDetail] = useState(false);
  const setActiveBoard = useSetActiveBoard();

  const handleOpenFilters = useCallback(() => setShowFilters(true), []);
  const handleDismissFilters = useCallback(() => setShowFilters(false), []);
  const handleOpenGrade = useCallback(() => setShowGrade(true), []);
  const handleDismissGrade = useCallback(() => setShowGrade(false), []);

  const handleSearchChange = useCallback(
    (text: string) => {
      setSearchTextLength(text.length);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        setName(text);
      }, SEARCH_DEBOUNCE_MS);
    },
    [setName],
  );

  // Commit the typed text immediately, bypassing the debounce — used by the
  // bottom-bar "done typing" fab so the search runs the moment it's tapped.
  const handleSearchSubmit = useCallback(
    (text: string) => {
      setSearchTextLength(text.length);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      setName(text);
    },
    [setName],
  );

  const handleSearchFocus = useCallback(() => setIsSearchFocused(true), []);
  const handleSearchBlur = useCallback(() => setIsSearchFocused(false), []);

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
          searchHeaderRef.current?.setText(saved.searchText);
        } else {
          // Never-searched board → clean default band, no grade/filters/name
          // inherited from the board the climber came from.
          replaceSearch(DEFAULT_CLIMB_FILTER_STATE, '', DEFAULT_CLIMB_BOARD_FILTER_STATE);
          searchHeaderRef.current?.setText('');
        }
        restoredKeyRef.current = boardKey;
        setRestoredKey(boardKey);
      })
      .catch(() => {
        restoredKeyRef.current = boardKey;
        setRestoredKey(boardKey);
      });
    return () => {
      cancelled = true;
    };
    // Restore is keyed on the board only — re-running on filter changes would
    // clobber the user's edits. replaceSearch is stable; searchHeaderRef is a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardKey, isAuthenticated]);

  // Search is "ready" once this board's restore has landed — gate queries on it.
  const searchReady = hasBoardConfig && restoredKey === boardKey;

  // Persist the current search for this board once the restore for it landed.
  useEffect(() => {
    if (!boardConfig || restoredKeyRef.current !== boardKey) return;
    const handle = setTimeout(() => {
      void saveLastSearch(boardConfig, filters, name, boardFilters);
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [filters, name, boardFilters, boardConfig, boardKey]);

  // Pre-warm board images so they're cached before the user taps into a climb.
  useEffect(() => {
    if (!activeBoard) return;
    const parsedSetIds = activeBoard.setIds.split(',').map(Number);
    const renderData = getBoardRenderData({
      boardName: activeBoard.boardType as BoardName,
      layoutId: activeBoard.layoutId,
      sizeId: activeBoard.sizeId,
      setIds: parsedSetIds,
    });
    if (renderData?.imageUrls) {
      for (const url of renderData.imageUrls) {
        Image.prefetch(url);
      }
    }
  }, [activeBoard]);

  // Pagination + accumulation for infinite scroll.
  const [pageNumber, setPageNumber] = useState(1);
  const [accumulatedClimbs, setAccumulatedClimbs] = useState<Climb[]>([]);

  // Clear accumulated climbs and reset page when search, filters, or angle
  // change. Including `angle` is essential: the search refetches per-angle
  // grades (the angle is in the query key), and without resetting accumulation
  // a mid-scroll angle change would merge the new angle's page into the old
  // angle's pages, mixing grades.
  useEffect(() => {
    setAccumulatedClimbs([]);
    setPageNumber(1);
  }, [name, filters, boardFilters, angle]);

  const searchInput = useMemo(
    () =>
      mergeBoardFilters(
        toClimbSearchInput(
          filters,
          { boardName, layoutId, sizeId, setIds, angle },
          { page: pageNumber, pageSize: PAGE_SIZE },
          { name },
        ),
        boardFilters,
      ),
    [boardName, layoutId, sizeId, setIds, angle, name, pageNumber, filters, boardFilters],
  );

  const countInput = useMemo(
    () =>
      mergeBoardFilters(
        toClimbSearchInput(
          filters,
          { boardName, layoutId, sizeId, setIds, angle },
          { page: 1, pageSize: PAGE_SIZE },
          { name },
        ),
        boardFilters,
      ),
    [boardName, layoutId, sizeId, setIds, angle, name, filters, boardFilters],
  );
  const { data: totalCount } = useSearchClimbsCount(countInput, searchReady);

  const {
    data: searchResult,
    isLoading: isClimbsLoading,
    isRefetching,
    refetch,
  } = useSearchClimbs(searchInput, searchReady);
  const hasMore = searchResult?.hasMore ?? false;
  const isLoadingMoreRef = useRef(false);

  useEffect(() => {
    if (!searchResult?.climbs) return;
    isLoadingMoreRef.current = false;
    setAccumulatedClimbs((previous) => accumulateClimbs(previous, searchResult.climbs, pageNumber));
  }, [searchResult?.climbs, pageNumber]);

  // Feed visible UUIDs into the shared logbook for the ascent badge.
  useEffect(() => {
    if (accumulatedClimbs.length === 0) return;
    void getLogbook(accumulatedClimbs.map((climb) => climb.uuid));
  }, [accumulatedClimbs, getLogbook]);

  const handleRefresh = useCallback(() => {
    setAccumulatedClimbs([]);
    setPageNumber(1);
    refetch();
  }, [refetch]);

  const handleEndReached = useCallback(() => {
    if (hasMore && !isClimbsLoading && !isRefetching && !isLoadingMoreRef.current) {
      isLoadingMoreRef.current = true;
      setPageNumber((previous) => previous + 1);
    }
  }, [hasMore, isClimbsLoading, isRefetching]);

  // Page the same search query the list uses so the play-drawer swipe can walk
  // climbs beyond what's loaded. Activation pages are 0-based; search is 1-based.
  const fetchSearchPage = useCallback(
    async ({ page, pageSize }: { page: number; pageSize: number }) => {
      const input = mergeBoardFilters(
        toClimbSearchInput(
          filters,
          { boardName, layoutId, sizeId, setIds, angle },
          { page: page + 1, pageSize },
          { name },
        ),
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

  const allQueueClimbs = useMemo(() => toQueueClimbs(accumulatedClimbs), [accumulatedClimbs]);

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
      setSearchTextLength(pillSearchText.length);
      searchHeaderRef.current?.setText(pillSearchText);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      Keyboard.dismiss();
      searchHeaderRef.current?.blur();
      setIsSearchFocused(false);
    },
    [replaceSearch],
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
  // in the sticky-strip layout (in bottom-bar the search field sits behind a
  // scrim/keyboard, so the list header isn't reachable while typing).
  const showRecentPills =
    layout === 'sticky-strip' && isSearchFocused && searchTextLength === 0 && recentFilters.length > 0;
  // Show the spinner (not a premature "no climbs" empty state) while a board is
  // resolving or its per-board restore hasn't landed yet.
  const isInitialLoading =
    isBoardLoading || (hasBoardConfig && !searchReady) || (isClimbsLoading && accumulatedClimbs.length === 0);

  const gradeBound = useMemo<GradeBound>(
    () => ({ minGradeId: filters.minGrade, maxGradeId: filters.maxGrade }),
    [filters.minGrade, filters.maxGrade],
  );
  const activeFilterCount = useMemo(
    () => countActiveFiltersBeyondGrade(filters, boardFilters),
    [filters, boardFilters],
  );

  const renderClimbItem = useCallback(
    ({ item: climb }: { item: Climb }) => (
      <ClimbListRow
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
        selected={climb.uuid === activeClimbUuid}
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
      activeClimbUuid,
    ],
  );

  if (!hasBoardConfig && !isBoardLoading) {
    return (
      <View style={styles.emptyContainer}>
        <Icon name="boards" size={48} color={iosSystemColors.systemGray4} />
        <Text variant="headline" style={styles.emptyTitle}>
          {t('mobile.emptyState.noBoard.title')}
        </Text>
        <Text variant="subheadline" style={styles.emptySubtitle}>
          {t('mobile.emptyState.noBoard.subtitle')}
        </Text>
      </View>
    );
  }

  if (isInitialLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  const isEmpty = accumulatedClimbs.length === 0 && !isClimbsLoading;

  return (
    <View style={[styles.container, { backgroundColor: systemColors.background }]}>
      <FlashList
        data={accumulatedClimbs}
        renderItem={renderClimbItem}
        keyExtractor={keyExtractor}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingTop: searchBarHeight, paddingBottom: listPaddingBottom }}
        scrollIndicatorInsets={{ top: searchBarHeight }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={handleRefresh} tintColor={brandColors.primary} />
        }
        ListHeaderComponent={
          showRecentPills ? (
            <RecentFilterPills
              recentFilters={recentFilters}
              currentFilters={filters}
              currentSearchText={name}
              onApply={handleApplyRecentFilter}
              onClear={handleClearRecentFilters}
            />
          ) : null
        }
        ListFooterComponent={
          isClimbsLoading && accumulatedClimbs.length > 0 ? (
            <View style={styles.footer}>
              <ActivityIndicator size="small" />
            </View>
          ) : null
        }
        ListEmptyComponent={
          isEmpty ? (
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

      {layout === 'sticky-strip' ? (
        <ClimbSearchBar
          layout={layout}
          searchFieldRef={searchHeaderRef}
          searchInitialValue={name}
          searchPlaceholder={t('search.placeholders.climbs')}
          onSearchChange={handleSearchChange}
          onSearchFocus={handleSearchFocus}
          onSearchBlur={handleSearchBlur}
          bound={gradeBound}
          grades={grades}
          filters={filters}
          boardFilters={boardFilters}
          count={totalCount}
          activeFilterCount={activeFilterCount}
          onOpenGrade={handleOpenGrade}
          onOpenFilters={handleOpenFilters}
          onPatchFilters={patchFilters}
          onPatchBoardFilters={patchBoardFilters}
          canCreate={isAuthenticated && hasBoardConfig}
          onCreate={handleCreateClimb}
          onHeightChange={setSearchBarHeight}
        />
      ) : null}

      {layoutLoaded && layout === 'bottom-bar' ? (
        <>
          <ClimbTopChrome
            canCreate={isAuthenticated && hasBoardConfig}
            onCreate={handleCreateClimb}
            onOpenBoardDetail={() => setShowBoardDetail(true)}
            onHeightChange={setSearchBarHeight}
          />
          <SearchFab
            searchFieldRef={searchHeaderRef}
            searchInitialValue={name}
            searchPlaceholder={t('search.placeholders.climbs')}
            onSearchChange={handleSearchChange}
            onSearchSubmit={handleSearchSubmit}
            onSearchFocus={handleSearchFocus}
            onSearchBlur={handleSearchBlur}
            bound={gradeBound}
            grades={grades}
            filters={filters}
            boardFilters={boardFilters}
            count={totalCount}
            activeFilterCount={activeFilterCount}
            onOpenGrade={handleOpenGrade}
            onOpenFilters={handleOpenFilters}
            onPatchFilters={patchFilters}
            onPatchBoardFilters={patchBoardFilters}
            toolbarBottom={toolbarBottom}
          />
        </>
      ) : null}

      {showGrade ? (
        // sendDifficultyIds is omitted for now → the rail centers on the V5–V7
        // band default; logbook-personalized "my grade" centering is wired in a
        // later phase once the screen sources the climber's recent send grades.
        <GradePopover
          boardName={boardName}
          grade={gradeBound}
          onChange={handleGradeChange}
          onDismiss={handleDismissGrade}
        />
      ) : null}

      {showFilters ? (
        <ClimbFilterSheet
          onDismiss={handleDismissFilters}
          boardConfig={boardConfig}
          currentFilters={filters}
          currentBoardFilters={boardFilters}
          searchName={name}
          onEditGrade={(editedFilters, editedBoardFilters) => {
            // Commit the sheet's in-progress edits before jumping to the grade
            // popover, so toggling e.g. Benchmarks then tapping Grade doesn't
            // discard them. (No recent-filter side effect — that's Apply's job.)
            setFilters(editedFilters);
            setBoardFilters(editedBoardFilters);
            setShowFilters(false);
            setShowGrade(true);
          }}
          onApply={handleApplyFilters}
        />
      ) : null}

      <BoardDetailSheet
        board={activeBoard ?? null}
        visible={showBoardDetail}
        onClose={() => setShowBoardDetail(false)}
        onSetActive={(board) => {
          void setActiveBoard(board);
          setShowBoardDetail(false);
        }}
      />
    </View>
  );
}

function keyExtractor(item: Climb) {
  return item.uuid;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
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
  footer: {
    paddingVertical: 20,
    alignItems: 'center',
  },
});
