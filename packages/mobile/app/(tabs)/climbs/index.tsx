import { EmptyState } from '../../../src/components/EmptyState';
import { ClimbsEmptyState } from '../../../src/components/climbs/ClimbsEmptyState';
import { ClimbsView } from '../../../src/components/climbs/ClimbsView';
import { useNativeRootHeader } from '../../../src/hooks/use-native-root-header';
import { useHorizontalSafeArea } from '../../../src/hooks/use-horizontal-safe-area';
import { useListTopOffset } from '../../../src/hooks/use-list-top-offset';
import { useListChromeClearance } from '../../../src/hooks/use-list-chrome-clearance';
import { useResultSetKeyExtractor } from '../../../src/hooks/use-result-set-key-extractor';
import { ScrollEdgeListReset, useScrollEdgeBackdrop } from '../../../src/hooks/use-scroll-edge-backdrop';
import { useHideOnScroll } from '../../../src/hooks/use-hide-on-scroll';
import { usePullRefresh } from '../../../src/hooks/use-pull-refresh';
import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { View, StyleSheet, RefreshControl, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { type FlashListRef } from '@shopify/flash-list';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { Climb, BoardName } from '@boardsesh/shared-schema';
import { isNetworkError, isServerUnavailableError } from '@boardsesh/offline-sync/error-classification';
import { toClimbSearchInput, mergeBoardFilters } from '@boardsesh/climb-filters';
import { boardSupportsMirroring, getBoardCapabilities } from '@boardsesh/board-config';
import { ClimbProgressProvider, type ClimbProgressTarget } from '../../../src/providers/climb-progress-provider';
import { ActiveAwareClimbListRow } from '../../../src/components/ActiveAwareClimbListRow';
import { ClimbListRowSkeleton } from '../../../src/components/ClimbListRowSkeleton';
import {
  DEFAULT_CLIMB_ROW_SURFACE,
  climbRowLayout,
  climbRowSkeletonCount,
  type ClimbRowSurface,
} from '../../../src/components/climb-row-layout';
import {
  climbListColumnsForRoom,
  climbListHasRoomForTwoColumns,
  climbListThumbnailSize,
  estimateClimbListWidth,
  useClimbListThumbnailSize,
  type ClimbListColumns,
} from '../../../src/components/climb-list-thumbnail-metrics';
import { useClimbListLayout } from '../../../src/hooks/use-climb-list-layout';
import { useClimbRowDisplay, useClimbRowField } from '../../../src/lib/climb-row-display-preference';
import { PlayBoardPrewarmHost } from '../../../src/components/play-drawer/PlayBoardPrewarmHost';
import { ClimbListThumbnailPrewarmWindow } from '../../../src/components/ClimbListScrollAhead';
import { Button } from '../../../src/components/Button';
import { ClimbFilterSheet } from '../../../src/components/ClimbFilterSheet';
import { ClimbTopChrome } from '../../../src/components/search/ClimbTopChrome';
import { NativeRootHeader } from '../../../src/components/chrome/NativeRootHeader';
import { useDrawerHost } from '../../../src/providers/drawer-host-provider';
import { useTheme, useAppColorScheme } from '../../../src/providers/theme-provider';
import { ClimbSearchProvider } from '../../../src/providers/climb-search-provider';
import { ClimbListTickDisplayProvider } from '../../../src/providers/climb-list-tick-display-provider';
import { useBottomChromeMetrics } from '../../../src/hooks/use-bottom-chrome-metrics';
import { useDeviceLayout } from '../../../src/hooks/use-device-layout';
import { useClimbListPlaylistMemberships } from '../../../src/hooks/use-climb-list-playlist-memberships';
import { useClimbListFavorites } from '../../../src/hooks/use-climb-list-favorites';
import { useInfiniteSearchClimbs } from '../../../src/lib/graphql/hooks/use-infinite-search-climbs';
import { climbSearchScrollKey, useSearchGradeSourceActive } from '../../../src/lib/graphql/hooks/search-grade-source';
import { isOfflineSearchSupported } from '../../../src/db/queries/search-climbs-local';
import { useIsOffline } from '../../../src/hooks/use-is-offline';
import { useConnectivity } from '../../../src/lib/connectivity/use-connectivity';
import { offlineReasonFor, type OfflineQueryReason } from '../../../src/hooks/use-offline-query-state';
import { useOfflineCatalogState } from '../../../src/offline/use-offline-catalog-state';
import { OfflineCatalogCta } from '../../../src/components/offline/OfflineCatalogCta';
import { shouldShowUnsetWallEmptyState } from '../../../src/lib/spray/unset-wall-empty-state';
import { useSprayWallIsArchived } from '../../../src/lib/spray/use-spray-wall-archive';
import { SprayWallArchivedBanner } from '../../../src/components/spray-wall/SprayWallArchivedBanner';
import { NO_BOARD_PICKER_HREF } from '../../../src/lib/boards/first-board-mode';
import { FollowedAuthorsUnavailableError } from '../../../src/lib/followed-authors-error';
import { useActiveBoard } from '../../../src/lib/graphql/use-active-board';
import { OnboardingTipBanner } from '../../../src/components/onboarding/OnboardingTipBanner';
import { FirstConnectCard } from '../../../src/components/onboarding/FirstConnectCard';
import { usePersonalGradesActive } from '../../../src/hooks/use-personal-grades';
import { filtersForBoard } from '../../../src/lib/climb-filter-types';
import { spacing } from '../../../src/theme/tokens';
import { timing } from '../../../src/theme/animations';
import { useClimbsSearchSession } from '../../../src/hooks/climbs/use-climbs-search-session';
import { useClimbsFilterPresentation } from '../../../src/hooks/climbs/use-climbs-filter-presentation';
import { useClimbsListLifecycle } from '../../../src/hooks/climbs/use-climbs-list-lifecycle';
import { useClimbsOnboarding } from '../../../src/hooks/climbs/use-climbs-onboarding';
import { useClimbBoardPrewarming } from '../../../src/hooks/climbs/use-climb-board-prewarming';
import { useClimbSearchAnalytics } from '../../../src/hooks/climbs/use-climb-search-analytics';
import { useClimbSearchActivation } from '../../../src/hooks/climbs/use-climb-search-activation';

const PAGE_SIZE = 30;
// Any part of a row on screen counts: this feeds pagination and thumbnail
// prewarming, not an impression counter.
// `minimumViewTime: 0`: FlashList's default only reports a row once it has been
// on screen for 250ms, so mid-flick it reports nothing and both would stall.
const CLIMB_LIST_VIEWABILITY = { itemVisiblePercentThreshold: 1, minimumViewTime: 0 };
// How many placeholder rows cover the list, and the tail of it, at the default
// row height. `ClimbListSkeletonRows` draws more when the climber's rows are
// shorter than that.
const INITIAL_SKELETON_ROW_COUNT = 10;
const FOOTER_SKELETON_ROW_COUNT = 6;
// What this list lets its rows show, for sizing their placeholders: the one
// surface with playlist tags.
const CLIMB_LIST_ROW_SURFACE: ClimbRowSurface = {
  ...DEFAULT_CLIMB_ROW_SURFACE,
  showPlaylistChips: true,
  showProgress: true,
};

export default function ClimbList() {
  return (
    <ClimbSearchProvider>
      <ClimbListInner />
    </ClimbSearchProvider>
  );
}

function ClimbListInner() {
  const {
    data: activeBoard,
    isPending: isBoardPending,
    isSuccess: isBoardResolved,
    isError: isBoardRestoreError,
    isFetching: isBoardFetching,
    refetch: refetchActiveBoard,
  } = useActiveBoard();

  const { isPad, widthClass } = useDeviceLayout();
  const nativeRootHeader = useNativeRootHeader();
  const router = useRouter();
  const { t } = useTranslation('climbs');
  const { t: tCommon } = useTranslation('common');
  const { openBoardSheet } = useDrawerHost();
  const { brandColors, features } = useTheme();
  const colorScheme = useAppColorScheme();
  const boardName = activeBoard?.boardType ?? '';
  const layoutId = activeBoard?.layoutId ?? 0;
  const sizeId = activeBoard?.sizeId ?? 0;
  const setIds = activeBoard?.setIds ?? '';
  const angle = activeBoard?.angle ?? 0;
  const hasBoardConfig = !!activeBoard;
  const boardConfig = useMemo(
    () => (hasBoardConfig ? { boardName, layoutId, sizeId, setIds, angle } : null),
    [hasBoardConfig, boardName, layoutId, sizeId, setIds, angle],
  );
  const searchSession = useClimbsSearchSession(boardConfig);
  const {
    filters,
    boardFilters,
    name,
    isAuthenticated,
    filterScopeKey,
    searchReady,
    queryFilters,
    queryBoardFilters,
    grades,
    gradeFormat,
    lastUsedGrade,
    showFilters,
    handleDismissFilters,
    handleLiveFilterSelectionChange,
    handleSheetNameChange,
    handleSheetClearName,
    handleOpenFilters,
    handleOpenFiltersFromEmpty,
    recentFilters,
    handleApplyRecentFilter,
    handleClearNonGradeFilters,
    handleOpenGrade,
    handleCloseGrade,
    handleDismissGradePopover,
  } = searchSession;
  const {
    gradeBound,
    activeFilterCount,
    filtersBadgeCount,
    recoveryFilterTokens,
    lockedDimensions,
    filterSummaryProp,
    gradeChip,
    gradeRowVisible,
    gradeRecenterKey,
    handleGradeRailChange,
    filterChrome,
  } = useClimbsFilterPresentation(searchSession, boardConfig);
  const insets = useSafeAreaInsets();
  // iPhone Duo's side tab rail and status bar; 0 on a portrait iPhone.
  const horizontalSafeArea = useHorizontalSafeArea();
  const bottomChrome = useBottomChromeMetrics();

  // The list's own width decides its columns (see `climbListColumns`): two from
  // 900pt, where each column keeps an iPhone-wide row. Measured on the list's
  // frame, so the iPad sidebar and the iPhone Duo's player pane and rail are
  // already left out. Only whether it fits two is kept, so a measurement that
  // agrees with the first guess (every phone) re-renders nothing.
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [listLayoutPreference] = useClimbListLayout();
  const [listHasRoomForTwo, setListHasRoomForTwo] = useState(() =>
    climbListHasRoomForTwoColumns(
      estimateClimbListWidth({
        windowWidth,
        windowHeight,
        safeAreaLeft: horizontalSafeArea.left,
        safeAreaRight: horizontalSafeArea.right,
        measuredContentColumnLeft: bottomChrome.contentColumnLeft,
        isPad,
        regularWidth: widthClass === 'regular',
      }),
    ),
  );
  const listColumns = climbListColumnsForRoom({ hasRoomForTwo: listHasRoomForTwo, preference: listLayoutPreference });
  const listThumbnailSize = climbListThumbnailSize(listColumns);
  const listPaddingBottom = bottomChrome.scrollBottomPadding;
  const listBottomSpacerHeight = useSharedValue(listPaddingBottom);
  useEffect(() => {
    listBottomSpacerHeight.value = withTiming(listPaddingBottom, { duration: timing.normal });
  }, [listBottomSpacerHeight, listPaddingBottom]);
  const listBottomSpacerStyle = useAnimatedStyle(() => ({ height: listBottomSpacerHeight.value }));
  // Material clips the list below its controls; Liquid Glass overlays them.
  const filterInTopChrome = features.filtersInTopChrome;
  // A board that mirrors gives its rows a line per direction, which the
  // placeholder rows stand in for too.
  const rowsTrackDirections = boardSupportsMirroring(boardName, layoutId);
  // A climber who switched thumbnails off gets none warmed ahead of the scroll.
  const rowsShowThumbnail = useClimbRowField('thumbnail');
  // An archived spray wall keeps its climbs, but nothing new is set on it.
  const wallArchived = useSprayWallIsArchived(boardName, hasBoardConfig ? layoutId : null);

  // Reactive connectivity, for the offline-only empty state below.
  const isOffline = useIsOffline();
  // ...and which side is down, so the filter placard blames the right one.
  const { reason: connectivityReason } = useConnectivity();
  // 'missing' (offer the download) vs 'queued' (already asked for) vs null.
  const offlineCatalog = useOfflineCatalogState(activeBoard);

  useClimbBoardPrewarming({ boardConfig, searchReady, activeBoard, colorScheme });
  // Personal grades (#4828): only reaches the query when a grade bound or a
  // difficulty sort is active — `toClimbSearchInput` owns that scoping — so an
  // unfiltered browse is unaffected and stays Redis-cacheable.
  const personalGrades = usePersonalGradesActive();
  const searchInput = useMemo(
    () =>
      mergeBoardFilters(
        toClimbSearchInput(
          filtersForBoard(queryFilters, boardName),
          { boardName, layoutId, sizeId, setIds, angle },
          { page: 0, pageSize: PAGE_SIZE },
          { name, personalGrades },
        ),
        queryBoardFilters,
      ),
    [boardName, layoutId, sizeId, setIds, angle, name, queryFilters, queryBoardFilters, personalGrades],
  );
  const {
    data: searchPages,
    isLoading: isClimbsLoading,
    isError: isClimbsError,
    error: climbSearchError,
    isFetchingNextPage,
    isFetchNextPageError,
    isRefetching,
    fetchNextPage,
    hasNextPage,
    refetch,
    isPlaceholderData,
    // Keeps the previous search's rows up (tinted below) while a new search on
    // the same board loads, instead of swapping the list to skeleton rows.
  } = useInfiniteSearchClimbs(searchInput, searchReady, { keepPreviousResults: true });
  // Match the query's grade source when resetting scroll and row identities.
  const climbListRef = useRef<FlashListRef<Climb>>(null);
  const boardseshGradesActive = useSearchGradeSourceActive();
  const searchScrollKey = useMemo(
    () => climbSearchScrollKey(searchInput, boardseshGradesActive),
    [searchInput, boardseshGradesActive],
  );
  // Row keys per result set, so FlashList never anchors a new search's rows to
  // a climb the previous search also had. See the hook for the blank list this
  // caused.
  const climbKeyExtractor = useResultSetKeyExtractor(searchScrollKey, isPlaceholderData, climbRowId);
  const listTopOffset = useListTopOffset();
  // Legacy backdrop consumers attach to this store. Native capsules draw their
  // own glass; forwarding its optional callbacks never renders this screen.
  const scrollEdge = useScrollEdgeBackdrop();
  // The Android nav bar hides as the list scrolls down; chained in front of the
  // chrome-clearance handler, which forwards every event to it.
  const hideOnScroll = useHideOnScroll(scrollEdge.list?.listProps.onScroll);
  // The full measured controls include the expanded Grade rail. At the top,
  // disclosure moves results below it; farther down, keep the same rows in place.
  const {
    chromeHeight: searchBarHeight,
    onChromeHeightChange: handleChromeHeightChange,
    onScroll: handleListScroll,
    onCommitLayoutEffect: handleListCommitLayout,
    resetScrollToTop,
  } = useListChromeClearance({
    initialHeight: insets.top + 60,
    topOffset: listTopOffset,
    listRef: climbListRef,
    onScroll: hideOnScroll,
  });
  // Dedup across pages: the same climb can repeat when a page boundary shifts
  // between fetches.
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
  const { visibleRowsStore, handleEndReached, handleListLoad, handleViewableItemsChanged, resetPendingFetch } =
    useClimbsListLifecycle({
      searchKey: searchScrollKey,
      listColumns,
      listRef: climbListRef,
      topClearance: -listTopOffset + (filterInTopChrome ? 0 : searchBarHeight),
      resetScrollToTop,
      hasNextPage,
      isPlaceholderData,
      isLoading: isClimbsLoading,
      isFetchingNextPage,
      isRefetching,
      lastFetchFailed: isFetchNextPageError,
      loadedCount: visibleClimbs.length,
      fetchNextPage,
    });
  const { showRevealTip, showQuickActionsTip, connectCardBoardHasLights, dismissRevealTip, dismissQuickActionsTip } =
    useClimbsOnboarding(activeBoard, visibleClimbs.length);
  const handleOpenBoardDetail = useCallback(() => {
    openBoardSheet();
    dismissRevealTip();
  }, [openBoardSheet, dismissRevealTip]);
  useClimbSearchAnalytics({
    firstSearchPage: searchPages?.pages[0],
    isPlaceholderData,
    showFilters,
    climbCount: visibleClimbs.length,
    name,
    filters,
    boardFilters,
    boardName,
    layoutId,
    sizeId,
    setIds,
    angle,
    gradeFormat,
  });
  const { handleClimbPress, handlePlayNext, handleOpenClimbActions, handleOpenAddToPlaylist } =
    useClimbSearchActivation({
      filters,
      boardFilters,
      name,
      boardName,
      layoutId,
      sizeId,
      setIds,
      angle,
      boardseshGradesActive,
      visibleClimbs,
      isPlaceholderData,
    });
  // Feed the playlist-membership store for the visible climbs so the optional
  // third-row playlist tags can render (gated inside the hook on the user
  // setting + auth). Memoize the uuid list so the fetch effect's dep is stable.
  const visibleClimbUuids = useMemo(() => visibleClimbs.map((climb) => climb.uuid), [visibleClimbs]);
  const progressTargets = useMemo<ClimbProgressTarget[]>(
    () => (boardName ? visibleClimbUuids.map((climbUuid) => ({ boardName: boardName as BoardName, climbUuid })) : []),
    [boardName, visibleClimbUuids],
  );
  useClimbListPlaylistMemberships({ boardName, layoutId, climbUuids: visibleClimbUuids });

  // Same batched shape for the favourite hearts: fetch the visible UUIDs' state
  // once per board+angle and write it into `favoritesStore`, which each row's
  // heart subscribes to per-uuid.
  useClimbListFavorites({ boardName, angle, climbUuids: visibleClimbUuids });

  const handleRefresh = useCallback(() => {
    resetPendingFetch();
    return refetch();
  }, [refetch, resetPendingFetch]);
  const pullRefresh = usePullRefresh(handleRefresh, isRefetching);
  const handleListClipLayout = useCallback((event: LayoutChangeEvent) => {
    setListHasRoomForTwo(climbListHasRoomForTwoColumns(event.nativeEvent.layout.width));
  }, []);

  const handleCreateClimb = useCallback(() => {
    router.push({
      pathname: '/(tabs)/climbs/create',
      params: { boardName, layoutId: String(layoutId), sizeId: String(sizeId), setIds, angle: String(angle) },
    });
  }, [router, boardName, layoutId, sizeId, setIds, angle]);

  // Show the spinner (not a premature "no climbs" empty state) while a board is
  // resolving or its per-board restore hasn't landed yet.
  const isBoardResolving = isBoardPending || (hasBoardConfig && !searchReady);
  // A placeholder with no rows (the previous search came up empty) is still a
  // load in progress, so it shows skeletons rather than the old empty state.
  //
  // Board resolution counts too. Switching board renames the screen the instant
  // the choice commits, so anything left over from the board before it reads as
  // the new board's climbs — the one thing a one-tap switcher must never do.
  // An unresolved read keeps the skeleton even when a retry is paused. Only a
  // successful null result reaches the no-board state; failed restoration has
  // its own retry state below.
  const showInitialSkeletons = (isClimbsLoading || isPlaceholderData || isBoardResolving) && visibleClimbs.length === 0;
  // Memoized so FlashList doesn't re-measure/re-render the header on every
  // ClimbListInner render — only when the title, pills, or filters change.
  const connectCardBoardName = (activeBoard?.name ?? '').trim() || null;
  const listHeader = useMemo(
    () => (
      <>
        <FirstConnectCard
          boardName={connectCardBoardName}
          boardHasLights={connectCardBoardHasLights}
          style={styles.revealBanner}
        />
        <SprayWallArchivedBanner
          boardName={boardName}
          layoutId={hasBoardConfig ? layoutId : null}
          style={styles.revealBanner}
        />
        {showRevealTip ? (
          <OnboardingTipBanner
            text={tCommon('mobile.onboarding.boardRevealTip')}
            icon="history"
            dismissLabel={tCommon('actions.close')}
            onPress={handleOpenBoardDetail}
            onDismiss={dismissRevealTip}
            style={styles.revealBanner}
          />
        ) : null}
        {showQuickActionsTip ? (
          <OnboardingTipBanner
            text={tCommon('mobile.onboarding.quickActionsTip')}
            icon="more.actions"
            dismissLabel={tCommon('actions.close')}
            onDismiss={dismissQuickActionsTip}
            style={styles.revealBanner}
          />
        ) : null}
      </>
    ),
    [
      connectCardBoardName,
      connectCardBoardHasLights,
      showRevealTip,
      handleOpenBoardDetail,
      dismissRevealTip,
      showQuickActionsTip,
      dismissQuickActionsTip,
      tCommon,
      boardName,
      hasBoardConfig,
      layoutId,
    ],
  );

  const listFooter = useMemo(
    () => (
      <View>
        {isFetchingNextPage ? (
          <ClimbListSkeletonRows
            count={FOOTER_SKELETON_ROW_COUNT}
            columns={listColumns}
            supportsMirroring={rowsTrackDirections}
          />
        ) : null}
        <Animated.View pointerEvents="none" style={listBottomSpacerStyle} />
      </View>
    ),
    [isFetchingNextPage, listBottomSpacerStyle, rowsTrackDirections, listColumns],
  );

  // NativeRootHeader owns the native header; Material hides it for its own app bar.
  const stackOptions = useMemo(
    () =>
      nativeRootHeader ? {} : { headerShown: false, headerLargeTitle: false, title: tCommon('mobile.nav.climbs') },
    [nativeRootHeader, tCommon],
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
        onOpenActions={handleOpenClimbActions}
        onOpenPlaylist={handleOpenAddToPlaylist}
        onPlayNext={handlePlayNext}
        showPlaylistChips
        showProgress
        showFavorite
        // The row applies the climber's quick-actions setting itself, so a toggle
        // re-renders the rows and leaves this callback alone.
        showMoreButton
        // Grid cells fill the row height FlashList gives them.
        fillCell={listColumns > 1}
      />
    ),
    [
      listColumns,
      boardName,
      layoutId,
      sizeId,
      setIds,
      angle,
      handleClimbPress,
      handleOpenClimbActions,
      handleOpenAddToPlaylist,
      handlePlayNext,
    ],
  );

  // The list-clip wrapper's style (see the render below): full-bleed on Liquid
  // Glass, clipped below the measured chrome on Material. Its sides clear the
  // side safe area, so the grade column and ⋮ never sit under iPhone Duo's tab
  // rail; the rows keep their own 16pt gutter. Memoized so Android doesn't
  // allocate a new style array on every render of this screen.
  // Must stay above the no-board early return: a hook below it changes the
  // hook count when the board config resolves (BOARDSESH-K1 / BOARDSESH-K2).
  const { left: listClipLeft, right: listClipRight } = horizontalSafeArea;
  const listClipStyle = useMemo(
    () => [
      styles.listClip,
      { left: listClipLeft, right: listClipRight },
      filterInTopChrome ? { top: searchBarHeight } : null,
    ],
    [filterInTopChrome, searchBarHeight, listClipLeft, listClipRight],
  );

  if (!hasBoardConfig && isBoardRestoreError) {
    return (
      <>
        <Stack.Screen options={stackOptions} />
        {/* The empty state replaces action chrome; clear its native center slot. */}
        {nativeRootHeader ? <NativeRootHeader titleHidden onHeightChange={handleChromeHeightChange} /> : null}
        <EmptyState
          size="screen"
          style={{ paddingTop: 120 }}
          icon="boards"
          title={t('mobile.emptyState.boardRestoreFailed.title')}
          body={t('mobile.emptyState.boardRestoreFailed.description')}
          actions={
            <Button
              title={tCommon('actions.retry')}
              onPress={() => void refetchActiveBoard()}
              loading={isBoardFetching}
              disabled={isBoardFetching}
              variant="filled"
            />
          }
        />
      </>
    );
  }

  if (isBoardResolved && activeBoard === null) {
    return (
      <>
        <Stack.Screen options={stackOptions} />
        {nativeRootHeader ? <NativeRootHeader titleHidden onHeightChange={handleChromeHeightChange} /> : null}
        <EmptyState
          size="screen"
          style={{ paddingTop: 120 }}
          icon="boards"
          title={t('mobile.emptyState.noBoard.title')}
          body={t('mobile.emptyState.noBoard.subtitle')}
          // Board selection is a modal now. When BLE serial auto-detect lands it
          // calls useSetActiveBoard(); useActiveBoard() then flips this screen to
          // the climb list with no extra wiring here.
          actions={
            <Button
              title={t('mobile.emptyState.noBoard.cta')}
              // The picker's no-board entry (#5654): a climber with no boards at all
              // gets "Where do you climb?" there, with the gym search, the builder
              // and the Bluetooth scan; one whose active board was only cleared gets
              // their list. Deliberately NOT tagged as onboarding: this empty state
              // shows any time no board is bound, not just first-run, so a bind from
              // it must not fire the activation event or arm the reveal banner.
              onPress={() => router.push(NO_BOARD_PICKER_HREF)}
              variant="filled"
            />
          }
        />
      </>
    );
  }

  // Deliberately NOT an early return to a full-screen spinner. Board resolution
  // now happens on a one-tap hop between two boards at one gym, and blanking the
  // whole screen — including the chrome the climber just tapped — reads as the
  // app falling over rather than as a list reloading. The chrome and the search
  // header stay mounted and the rows become skeletons instead
  // (`showInitialSkeletons`).
  //
  // Placeholder data reports a settled (non-loading) query, so it is excluded
  // explicitly: an empty previous result must not flash "no climbs" for the new
  // filters while they load. Board resolution is excluded for the same reason —
  // with the search query gated off, nothing is loading and nothing has arrived,
  // which is indistinguishable from an empty result unless you ask.
  const isEmpty = visibleClimbs.length === 0 && !isClimbsLoading && !isPlaceholderData && !isBoardResolving;
  // Whether the climber may set a climb on the active board at all. Hoisted out
  // of the chrome below so the wall's empty state offers exactly the same door.
  const canCreateClimb =
    isAuthenticated && hasBoardConfig && getBoardCapabilities(boardName).climbCreation && !wallArchived;
  // A wall nobody has set on yet is a different fact from "no climbs found":
  // nothing is wrong with the search, the wall is simply new. The query/filter
  // gates inside are the honest part — see `shouldShowUnsetWallEmptyState`.
  const isUnsetWall = shouldShowUnsetWallEmptyState({
    boardType: boardName,
    isEmpty,
    query: name,
    activeFilterCount,
  });
  // A captive portal can fail a search while the device still reports online.
  // Storage, authorization and validation failures need their own Retry state;
  // claiming those will recover on reconnect strands an already-online climber.
  const searchConnectionFailure =
    isClimbsError &&
    climbSearchError?.name !== 'AbortError' &&
    (isNetworkError(climbSearchError) || isServerUnavailableError(climbSearchError));
  const noUsableConnection = isOffline || searchConnectionFailure;
  // Who the offline-filter placard blames. The store's verdict, except for the
  // lying connection — no verdict at all, yet the search itself failed — which
  // has bars and a request that cannot land, so it reads as our end being
  // unreachable, exactly as the boards picker's `pickerNoticeUnreachable` does.
  const offlineFilterReason: OfflineQueryReason =
    connectivityReason === null && searchConnectionFailure
      ? 'backend_unreachable'
      : offlineReasonFor(connectivityReason);
  // No connection, with a filter we can't answer on-device (drafts, beta, zones,
  // hold state) — the search returns an empty result, so tell the user why
  // instead of the generic "no climbs". Tall/wide are offline-expressible, so
  // they don't trip this.
  const offlineFilterUnavailable = isEmpty && noUsableConnection && !isOfflineSearchSupported(searchInput);
  // The other offline empty state, and the one that had no branch of its own: the
  // filter IS answerable on-device, there is just no catalog here to answer it
  // against. Deliberately checked AFTER offlineFilterUnavailable so that branch
  // keeps its clear-filters CTA untouched.
  const offlineNoCatalog =
    isEmpty && noUsableConnection && isOfflineSearchSupported(searchInput) && offlineCatalog !== null;
  // Two states, not one: once the download is armed the CTA hides itself, so
  // repeating "this board isn't on your phone" would drop the user back into
  // the dead end they just tapped their way out of.
  const offlineCatalogMissing = offlineNoCatalog && offlineCatalog === 'missing';
  const offlineCatalogQueued = offlineNoCatalog && offlineCatalog === 'queued';

  return (
    <>
      <Stack.Screen options={stackOptions} />
      <ClimbListTickDisplayProvider
        boardName={boardName ? (boardName as BoardName) : null}
        climbUuids={visibleClimbUuids}
      >
        <ClimbProgressProvider targets={progressTargets}>
          <ClimbsView
            listRef={climbListRef}
            clipStyle={listClipStyle}
            onClipLayout={handleListClipLayout}
            thumbnailSize={listThumbnailSize}
            placeholder={isPlaceholderData}
            listProps={{
              onLoad: handleListLoad,
              accessibilityState: { busy: isPlaceholderData },
              data: visibleClimbs,
              renderItem: renderClimbItem,
              numColumns: listColumns,
              keyExtractor: climbKeyExtractor,
              onEndReached: handleEndReached,
              onEndReachedThreshold: 0.5,
              onViewableItemsChanged: handleViewableItemsChanged,
              viewabilityConfig: CLIMB_LIST_VIEWABILITY,
              contentInsetAdjustmentBehavior: nativeRootHeader ? 'automatic' : 'never',
              scrollToOverflowEnabled: nativeRootHeader,
              ...scrollEdge.list?.listProps,
              onScroll: handleListScroll,
              onCommitLayoutEffect: handleListCommitLayout,
              contentContainerStyle: filterInTopChrome ? undefined : { paddingTop: searchBarHeight },
              scrollIndicatorInsets: filterInTopChrome ? undefined : { top: searchBarHeight },
              keyboardShouldPersistTaps: 'handled',
              keyboardDismissMode: 'interactive',
              refreshControl: (
                <RefreshControl
                  refreshing={pullRefresh.refreshing}
                  onRefresh={pullRefresh.onRefresh}
                  tintColor={brandColors.primary}
                  progressViewOffset={nativeRootHeader ? searchBarHeight : undefined}
                />
              ),
              ListHeaderComponent: listHeader,
              ListFooterComponent: listFooter,
              ListEmptyComponent: (
                <ClimbsEmptyState
                  status={
                    showInitialSkeletons
                      ? 'loading'
                      : climbSearchError instanceof FollowedAuthorsUnavailableError
                        ? 'authors-sync'
                        : isClimbsError && !noUsableConnection
                          ? 'error'
                          : offlineFilterUnavailable
                            ? 'offline-filter'
                            : offlineCatalogMissing
                              ? 'offline-missing'
                              : offlineCatalogQueued
                                ? 'offline-queued'
                                : isUnsetWall
                                  ? 'unset-wall'
                                  : isEmpty
                                    ? 'empty'
                                    : null
                  }
                  loadingContent={
                    <ClimbListSkeletonRows
                      count={INITIAL_SKELETON_ROW_COUNT}
                      columns={listColumns}
                      supportsMirroring={rowsTrackDirections}
                    />
                  }
                  offlineFilterReason={offlineFilterReason}
                  boardName={activeBoard?.name ?? boardName}
                  angle={angle}
                  query={name}
                  tokens={recoveryFilterTokens}
                  lockedDimensions={lockedDimensions}
                  canCreateClimb={canCreateClimb}
                  onRetry={climbSearchError instanceof FollowedAuthorsUnavailableError ? refetch : handleRefresh}
                  onClearFilters={handleClearNonGradeFilters}
                  onCreate={handleCreateClimb}
                  onOpenFilters={handleOpenFiltersFromEmpty}
                  downloadAction={<OfflineCatalogCta board={activeBoard} />}
                />
              ),
            }}
            listReset={<ScrollEdgeListReset key={`scroll-edge-${listColumns}-columns`} edge={scrollEdge.list} />}
            listEffects={
              <>
                <PlayBoardPrewarmHost />
                {hasBoardConfig && !isPlaceholderData && rowsShowThumbnail ? (
                  <ClimbListThumbnailPrewarmWindow
                    store={visibleRowsStore}
                    climbs={visibleClimbs}
                    boardName={boardName as BoardName}
                    layoutId={layoutId}
                    sizeId={sizeId}
                    setIds={setIds}
                    climbsPerRow={listColumns}
                  />
                ) : null}
              </>
            }
            chrome={
              <ClimbTopChrome
                // With the chip row on, the active filters live in the token row and the
                // tab itself names the screen, so the centre title is dropped entirely —
                // the redundant "All climbs" label added nothing.
                boardName={boardName}
                canCreate={canCreateClimb}
                onCreate={handleCreateClimb}
                onOpenBoardDetail={handleOpenBoardDetail}
                showBoardBadge={showRevealTip}
                anchorBoardButton
                onHeightChange={handleChromeHeightChange}
                onCloseGrade={handleCloseGrade}
                onDismissGradePopover={handleDismissGradePopover}
                activeFilterCount={filtersBadgeCount}
                onOpenFilters={handleOpenFilters}
                filterSummary={filterSummaryProp}
                gradeBound={gradeBound}
                grades={grades}
                lastUsedGradeId={lastUsedGrade}
                gradeRailVisible={gradeRowVisible}
                gradeRecenterKey={gradeRecenterKey}
                gradeChip={gradeChip}
                onOpenGrade={handleOpenGrade}
                onGradeChange={handleGradeRailChange}
                filterChrome={filterChrome}
                showPersistentChips={filterInTopChrome}
                scrollEdge={scrollEdge.backdrop}
              />
            }
            overlays={
              showFilters ? (
                <ClimbFilterSheet
                  key={filterScopeKey}
                  onDismiss={handleDismissFilters}
                  boardConfig={boardConfig}
                  currentFilters={filters}
                  currentBoardFilters={boardFilters}
                  searchName={name}
                  lastUsedGradeId={lastUsedGrade}
                  onSelectionChange={handleLiveFilterSelectionChange}
                  onNameChange={handleSheetNameChange}
                  onClearName={handleSheetClearName}
                  recentFilters={recentFilters}
                  onApplyRecent={handleApplyRecentFilter}
                  lockedDimensions={lockedDimensions}
                />
              ) : null
            }
          />
        </ClimbProgressProvider>
      </ClimbListTickDisplayProvider>
    </>
  );
}

function climbRowId(item: Climb) {
  return item.uuid;
}

/**
 * Placeholder rows for this list. `count` is how many rows of the default
 * height cover the space; the climber's rows can be much shorter than that (a
 * row with no thumbnail is as little as 44pt), so as many are drawn as it takes
 * to cover the same space.
 */
function ClimbListSkeletonRows({
  count,
  columns,
  supportsMirroring,
}: {
  count: number;
  columns: ClimbListColumns;
  supportsMirroring: boolean;
}) {
  const display = useClimbRowDisplay();
  const { fontScale } = useWindowDimensions();
  const { textStyles: typeScale } = useTheme();
  const thumbnailSize = useClimbListThumbnailSize();
  const rowHeight = climbRowLayout({
    display,
    surface: CLIMB_LIST_ROW_SURFACE,
    supportsMirroring,
    fontScale,
    typeScale,
    thumbnailSize,
  }).estimatedHeight;
  const renderSkeleton = (key: string) => (
    <ClimbListRowSkeleton
      key={key}
      showPlaylistChips={CLIMB_LIST_ROW_SURFACE.showPlaylistChips}
      showProgress
      supportsMirroring={supportsMirroring}
    />
  );

  return (
    <View>
      {Array.from({ length: climbRowSkeletonCount(count, rowHeight, thumbnailSize) }, (_row, rowIndex) =>
        columns === 1 ? (
          renderSkeleton(`climb-skeleton-${rowIndex}`)
        ) : (
          // Laid out like the list's grid: each placeholder takes an equal share
          // of the row, as FlashList gives each cell.
          <View key={`climb-skeleton-${rowIndex}`} style={styles.skeletonGridRow}>
            {Array.from({ length: columns }, (_cell, cellIndex) => (
              <View key={cellIndex} style={styles.skeletonGridCell}>
                {renderSkeleton('skeleton')}
              </View>
            ))}
          </View>
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Fills the screen behind the floating top chrome. On Material (Android) its
  // `top` is overridden to the measured chrome height so the FlashList's actual
  // frame — and so its native scrollbar — starts below the chrome instead of
  // being drawn underneath it (see the comment at the call site).
  listClip: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  skeletonGridRow: {
    flexDirection: 'row',
  },
  skeletonGridCell: {
    flex: 1,
    minWidth: 0,
  },
  revealBanner: {
    marginHorizontal: spacing[4],
    marginTop: spacing[2],
    marginBottom: spacing[2],
  },
});
