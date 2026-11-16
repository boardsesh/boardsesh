import { ClimbsEmptyState } from '../../../src/components/climbs/ClimbsEmptyState';
import { ClimbsView } from '../../../src/components/climbs/ClimbsView';
import { scheduleIdleTask } from '../../../src/lib/schedule-idle-task';
import { useNativeRootHeader } from '../../../src/hooks/use-native-root-header';
import { useHorizontalSafeArea } from '../../../src/hooks/use-horizontal-safe-area';
import { useListTopOffset } from '../../../src/hooks/use-list-top-offset';
import { useListChromeClearance } from '../../../src/hooks/use-list-chrome-clearance';
import { useResultSetKeyExtractor } from '../../../src/hooks/use-result-set-key-extractor';
import { ScrollEdgeListReset, useScrollEdgeBackdrop } from '../../../src/hooks/use-scroll-edge-backdrop';
import { useHideOnScroll } from '../../../src/hooks/use-hide-on-scroll';
import { useRefocusCount } from '../../../src/hooks/use-refocus-count';
import { usePullRefresh } from '../../../src/hooks/use-pull-refresh';
import { useTabReselect } from '../../../src/hooks/use-tab-reselect';
import { useLiveClimbFilters, type ClimbFilterSelection } from '../../../src/hooks/use-live-climb-filters';
import type { WindowAnchorPoint } from '../../../src/components/navigation/AnchoredPopover.types';
import { useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import {
  View,
  StyleSheet,
  RefreshControl,
  Keyboard,
  Platform,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';
import { type FlashListRef, type ViewToken } from '@shopify/flash-list';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useFocusEffect, useIsFocused, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { Climb, BoardName } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { isNetworkError, isServerUnavailableError } from '@boardsesh/offline-sync/error-classification';
import {
  toClimbSearchInput,
  mergeBoardFilters,
  countActiveFilters,
  hasActiveBoardFilters,
  normalizeRetiredFilters,
  flagsToProgress,
  progressToFlags,
  sortKeyPatch,
  climbTypePatch,
  DEFAULT_CLIMB_FILTER_STATE,
  DEFAULT_CLIMB_BOARD_FILTER_STATE,
  type ClimbBoardFilterState,
  type ProgressFilter,
  type SortOption,
  type GradeAccuracyValue,
} from '@boardsesh/climb-filters';
import { getTallWideScope } from '@boardsesh/board-constants';
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
import { shouldFetchNextPage, type NextPageTrigger } from '../../../src/lib/climb-list-pagination';
import { requestPlayBoardPrewarm } from '../../../src/lib/board-render/play-board-prewarm';
import { PlayBoardPrewarmHost } from '../../../src/components/play-drawer/PlayBoardPrewarmHost';
import { ClimbListThumbnailPrewarmWindow, createVisibleRowsStore } from '../../../src/components/ClimbListScrollAhead';
import { Text } from '../../../src/components/Text';
import { Icon } from '../../../src/components/Icon';
import { Button } from '../../../src/components/Button';
import { ClimbFilterSheet, hasActiveFilters, type ClimbFilters } from '../../../src/components/ClimbFilterSheet';
import { ClimbTopChrome } from '../../../src/components/search/ClimbTopChrome';
import { NativeRootHeader } from '../../../src/components/chrome/NativeRootHeader';
import { FilterChipRow } from '../../../src/components/search/FilterChipRow';
import type { DimensionChip } from '../../../src/components/search/FilterChipRow.types';
import { chipKindToTokenKeys } from '../../../src/lib/pinnable-chips';
import { usePinnedChips } from '../../../src/lib/pinned-chips-store';
import { SPRAY_BOARD_NAME } from '../../../src/lib/spray/spray-wall-registry';
import {
  collectionPatch,
  getCollectionFilter,
  getClimbTypeFilter,
  type CollectionFilter,
  type ClimbTypeFilter,
} from '../../../src/lib/collection-filter';
import { FilterTokenRow } from '../../../src/components/search/FilterTokenRow';
import { GradeRangeRail, type GradeRailChange } from '../../../src/components/grade';
import { buildGradeRailStops } from '../../../src/lib/grade-stops';
import { applyPopularityBucket } from '../../../src/lib/filter-chip-menus';
import { useDimensionLockUpkeep, useDimensionLocks } from '../../../src/lib/dimension-lock-store';
import {
  buildDimensionChip,
  isDimensionChipLocked,
  isDimensionLockEnforced,
  type DimensionLockState,
  type LockedDimensions,
} from '../../../src/lib/dimension-chips';
import { shouldShowQuickActionsTip } from '../../../src/lib/onboarding/quick-actions-tip';
import { hapticMedium } from '../../../src/lib/haptics';
import { useDrawerHost } from '../../../src/providers/drawer-host-provider';
import { useTheme, useAppColorScheme } from '../../../src/providers/theme-provider';
import { selectByVariant } from '../../../src/theme/variants';
import { useIsSharedSession, useQueueActions } from '../../../src/providers/queue-provider';
import { ClimbSearchProvider, useClimbSearch, type GradeBound } from '../../../src/providers/climb-search-provider';
import { useSetting } from '../../../src/settings';
import { ClimbListTickDisplayProvider } from '../../../src/providers/climb-list-tick-display-provider';
import { randomUUID } from 'expo-crypto';
import { useBottomChromeMetrics } from '../../../src/hooks/use-bottom-chrome-metrics';
import { useGrades } from '../../../src/lib/graphql/hooks';
import { useGradeFormat } from '../../../src/hooks/use-grade-format';
import { useDeviceLayout } from '../../../src/hooks/use-device-layout';
import { useLastUsedGrade } from '../../../src/hooks/use-last-used-grade';
import { useClimbListPlaylistMemberships } from '../../../src/hooks/use-climb-list-playlist-memberships';
import { useClimbListFavorites } from '../../../src/hooks/use-climb-list-favorites';
import { useInfiniteSearchClimbs } from '../../../src/lib/graphql/hooks/use-infinite-search-climbs';
import {
  climbSearchScrollKey,
  useSearchGradeSourceActive,
  withGradeSource,
} from '../../../src/lib/graphql/hooks/search-grade-source';
import { offlineAwareRequest } from '../../../src/lib/graphql/offline-request';
import { isOfflineSearchSupported } from '../../../src/db/queries/search-climbs-local';
import { useIsOffline } from '../../../src/hooks/use-is-offline';
import { useConnectivity } from '../../../src/lib/connectivity/use-connectivity';
import { offlineReasonFor, type OfflineQueryReason } from '../../../src/hooks/use-offline-query-state';
import { useOfflineCatalogState } from '../../../src/offline/use-offline-catalog-state';
import { OfflineCatalogCta } from '../../../src/components/offline/OfflineCatalogCta';
import { SEARCH_CLIMBS, type SearchClimbsQueryResponse } from '../../../src/lib/graphql/operations';
import { useFetchCachedSearchClimbsCount } from '../../../src/lib/graphql/hooks/search-climbs-count-query';
import { useStoredUserId } from '../../../src/hooks/use-current-user-id';
import { usePlaylistActivation } from '../../../src/lib/playlists/use-playlist-activation';
import { useFrozenSearchBasis } from '../../../src/lib/playlists/use-frozen-search-basis';
import { toQueueClimb, toQueueClimbs } from '../../../src/lib/climb-types';
import { parseSetIdsParam, prewarmCreateBoardHolds } from '../../../src/lib/create-board-holds';
import { shouldShowUnsetWallEmptyState } from '../../../src/lib/spray/unset-wall-empty-state';
import { useSprayWallIsArchived } from '../../../src/lib/spray/use-spray-wall-archive';
import { SprayWallArchivedBanner } from '../../../src/components/spray-wall/SprayWallArchivedBanner';
import { NO_BOARD_PICKER_HREF } from '../../../src/lib/boards/first-board-mode';
import { FollowedAuthorsUnavailableError } from '../../../src/lib/followed-authors-error';
import { useActiveBoard } from '../../../src/lib/graphql/use-active-board';
import { drivesWithoutBluetooth } from '../../../src/lib/boards/board-lighting';
import { OnboardingTipBanner } from '../../../src/components/onboarding/OnboardingTipBanner';
import { FirstConnectCard, useFirstConnectCardExpected } from '../../../src/components/onboarding/FirstConnectCard';
import {
  clearBoardRevealTipPending,
  hasBoardRevealTipPending,
  hasSeenTip,
  markTipSeen,
} from '../../../src/lib/onboarding/onboarding-storage';
import { ONBOARDING_TIP_QUICKACTIONS_KEY } from '@boardsesh/key-value-storage';
import { setListCardShowing } from '../../../src/lib/onboarding/list-card-presence';
import { useFirstConnectConfirmationShowing } from '../../../src/lib/onboarding/first-connect-confirmation-presence';
import { useAuth } from '../../../src/providers/auth-provider';
import { usePersonalGradesActive } from '../../../src/hooks/use-personal-grades';
import { ensureBackgroundsCached } from '../../../src/lib/background-image-cache';
import {
  getRecentFilters,
  addRecentFilter,
  clearRecentFilters,
  type RecentFilter,
} from '../../../src/lib/recent-filter-store';
import { getLastSearch, saveLastSearch, boardConfigKey } from '../../../src/lib/last-search-store';
import { getFilterSummary, buildClimbFilterSummary } from '../../../src/lib/filter-summary';
import { filtersForBoard, statusForAuth } from '../../../src/lib/climb-filter-types';
import { buildNameFilterToken, getActiveFilterTokens } from '../../../src/lib/filter-tokens';
import { normalizeSearchName } from '../../../src/lib/search-name';
import { track } from '../../../src/lib/analytics';
import { spacing } from '../../../src/theme/tokens';
import { timing } from '../../../src/theme/animations';

const PAGE_SIZE = 30;
// Any part of a row on screen counts: this feeds pagination and thumbnail
// prewarming, not an impression counter.
// `minimumViewTime: 0`: FlashList's default only reports a row once it has been
// on screen for 250ms, so mid-flick it reports nothing and both would stall.
const CLIMB_LIST_VIEWABILITY = { itemVisiblePercentThreshold: 1, minimumViewTime: 0 };
// Soft character budget for the glass filter-summary title: include whole filter
// parts up to roughly two wrapped lines before collapsing the rest into "+N more".
// It only decides *when* to summarise — the title's `numberOfLines={2}` +
// ellipsize is the hard visual cap, so larger accessibility text sizes degrade to
// truncation rather than overflowing the layout.
const SUMMARY_MAX_CHARS = 28;
const SEARCH_DEBOUNCE_MS = 300;
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
// Debounce persisting the per-board last search so rapid grade nudges don't
// thrash secure-store.
const SAVE_DEBOUNCE_MS = 600;
const PREWARM_BOARD_HOLDS_DELAY_MS = 1200;
// The Tall/Wide long-press Lock / Unlock exists only on the iOS chip row (a
// SwiftUI Menu with a primary action). Android and web chips just toggle, and a
// lock stored there never acts (see lib/dimension-chips.ts).
const DIMENSION_LOCK_SUPPORTED = Platform.OS === 'ios';

// Filters that have a dedicated facet chip in the persistent chip row. They are
// excluded from the removable token row so an active filter is never worded
// twice — the chip shows/changes it, the token row is the receipt for the
// long-tail (sheet-only) filters that have no chip.

// How the Filters sheet was opened (`Climb Filters Opened` / `Closed`).
type ClimbFiltersOpenSource = 'tab_reselect' | 'filters_chip' | 'empty_recovery';

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
  // A regular-width iPad places the grade picker in a transient popover on the
  // Grade chip; everywhere else it is a row of the chrome that stays once opened.
  // An open popover stays a popover until it is dismissed, even if the window
  // narrows under it.
  const isRegularWidthPad = isPad && widthClass === 'regular';
  const [gradePopoverOpen, setGradePopoverOpen] = useState(false);
  const gradeUsesPopover = gradePopoverOpen || isRegularWidthPad;
  const nativeRootHeader = useNativeRootHeader();
  const router = useRouter();
  const isFocused = useIsFocused();
  const { t } = useTranslation('climbs');
  const { t: tCommon } = useTranslation('common');
  const { t: tSession } = useTranslation('session');
  const { getClimbActions, openAddToPlaylist, openBoardSheet } = useDrawerHost();
  // The grade row is hidden until the Grade chip opens it. Then it stays, across
  // opening a climb, search, Filters and app launches, until the chip hides it.
  const [gradeRowShown, setGradeRowShown] = useSetting('gradeRowShown');
  // Whether anyone else is in this session. Read off a dedicated selector context
  // so this screen (which hosts a virtualized FlashList) doesn't re-render on the
  // ≤1/2s session-stats push — the boolean flips only across the solo ↔ crew
  // boundary.
  const isSharedSession = useIsSharedSession();
  // One-time board-history reveal: armed when the user binds a board from the
  // onboarding hand-off and consumed on focus (see the useFocusEffect below).
  // Declared here so handleOpenBoardDetail can clear it — tapping the board
  // button dismisses the badge + banner once the cue has done its job.
  const [revealTipVisible, setRevealTipVisible] = useState(false);
  // History opens the wall's "now on the wall" sheet; board switching lives in
  // the adjacent climb-list options menu.
  const handleOpenBoardDetail = useCallback(() => {
    openBoardSheet();
    setRevealTipVisible(false);
  }, [openBoardSheet]);
  const { systemColors, variant, brandColors, features } = useTheme();
  const colorScheme = useAppColorScheme();
  const { playNext } = useQueueActions();
  const { filters, boardFilters, name, setGrade, setName, replaceSearch, patchFilters, patchBoardFilters } =
    useClimbSearch();
  // The user's pinned chips: which filter controls appear in the persistent chip
  // row (defaults reproduce today's set). Drives both the chip row and the token
  // "receipt" dedup below.
  const { pinned: pinnedChips, loaded: pinnedChipsLoaded } = usePinnedChips();
  // The grade row, as a row of the chrome (Liquid Glass) or inside it
  // (Material). Never beside the popover, and only while the Grade chip is
  // pinned: the chip is the row's one way to hide it, so a row left open when
  // the chip is unpinned could never be closed. The stored choice is untouched,
  // so pinning the chip again brings the row back as it was left.
  const gradeRowVisible = gradeRowShown && !gradeUsesPopover && pinnedChips.includes('grade');
  const { lastUsedGrade, rememberGrade } = useLastUsedGrade();
  // The name as last typed in the Filters sheet, before the debounce commits it.
  const visibleSearchTextRef = useRef('');
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
  // A column change remounts the list (its `key`, below). This holds the climb
  // at the top of the old layout, so the new list opens on it, not at the top.
  const columnChangeTopIndexRef = useRef<number | null>(null);
  const savedColumnsRef = useRef(listColumns);

  const listPaddingBottom = bottomChrome.scrollBottomPadding;
  const listBottomSpacerHeight = useSharedValue(listPaddingBottom);
  useEffect(() => {
    listBottomSpacerHeight.value = withTiming(listPaddingBottom, { duration: timing.normal });
  }, [listBottomSpacerHeight, listPaddingBottom]);
  const listBottomSpacerStyle = useAnimatedStyle(() => ({ height: listBottomSpacerHeight.value }));
  // The persistent native filter-chip row is the filtering surface on every variant
  // now, so it's always shown — hence `showFilterChips` is a constant. `filterInTopChrome`
  // still distinguishes the two: on Material (Android) the chip row replaces the
  // top-chrome filter affordances (grade control + filter button + summary); on Liquid
  // Glass its own chrome path renders the chip row under the title. We gate Material on
  // the variant feature (not Platform.OS) and do NOT flip filtersInTopChrome, so
  // Material's FAB-vs-toolbar coupling stays put.
  const filterInTopChrome = features.filtersInTopChrome;
  const showFilterChips = true;

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { isAuthenticated } = useAuth();
  const filterScopeKey = activeBoard
    ? `${boardConfigKey({
        boardName: activeBoard.boardType,
        layoutId: activeBoard.layoutId,
        sizeId: activeBoard.sizeId,
        setIds: activeBoard.setIds,
        angle: activeBoard.angle,
      })}|${isAuthenticated}`
    : null;
  const filterScopeRef = useRef(filterScopeKey);
  filterScopeRef.current = filterScopeKey;
  const committedSearchNameRef = useRef(name);
  committedSearchNameRef.current = name;
  const finishFiltersRef = useRef<((selection: ClimbFilterSelection) => void) | null>(null);
  const normalizedFilters = useMemo(
    () => statusForAuth(normalizeRetiredFilters(filters), isAuthenticated),
    [filters, isAuthenticated],
  );
  const filterSelection = useMemo(
    () => ({ filters: normalizedFilters, boardFilters }),
    [normalizedFilters, boardFilters],
  );
  const handleFilterSelectionChange = useCallback(
    (nextFilters: ClimbFilters, nextBoardFilters: ClimbBoardFilterState) => {
      replaceSearch(
        statusForAuth(normalizeRetiredFilters(nextFilters), isAuthenticated),
        committedSearchNameRef.current,
        nextBoardFilters,
      );
    },
    [replaceSearch, isAuthenticated],
  );
  const finishFilterSession = useCallback((selection: ClimbFilterSelection) => {
    finishFiltersRef.current?.(selection);
  }, []);
  const {
    showFilters,
    openFilters,
    hideFilters,
    runWhileOpen,
    closeFilters: handleDismissFilters,
    onSelectionChange: handleLiveFilterSelectionChange,
    querySelection: { filters: queryFilters, boardFilters: queryBoardFilters },
  } = useLiveClimbFilters({
    scopeKey: filterScopeKey,
    selection: filterSelection,
    onSelectionChange: handleFilterSelectionChange,
    onDismiss: finishFilterSession,
  });
  const [recentFilters, setRecentFilters] = useState<RecentFilter[]>([]);
  // Opening Filters and leaving the screen close the iPad popover. Neither hides
  // the grade row: only the Grade chip does.
  const handleDismissGradePopover = useCallback(() => {
    setGradePopoverOpen(false);
  }, []);
  // The Grade chip. On a regular-width iPad it presents and dismisses the
  // popover. Everywhere else it shows and hides the grade row, and the setting
  // remembers which.
  const handleOpenGrade = useCallback(() => {
    if (isRegularWidthPad) {
      hideFilters();
      setGradePopoverOpen(true);
      return;
    }
    setGradeRowShown(true);
    track(SHARED_EVENTS.GradeRowToggled, { shown: true });
  }, [isRegularWidthPad, setGradeRowShown, hideFilters]);
  const handleCloseGrade = useCallback(() => {
    // Also when the popover reports itself dismissed after the chip already
    // closed it: in popover mode a close never reaches the row's setting.
    if (gradeUsesPopover) {
      setGradePopoverOpen(false);
      return;
    }
    setGradeRowShown(false);
    track(SHARED_EVENTS.GradeRowToggled, { shown: false });
  }, [gradeUsesPopover, setGradeRowShown]);

  const handleSearchChange = useCallback(
    (text: string) => {
      const nextName = normalizeSearchName(text);
      visibleSearchTextRef.current = text;
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      const originatingScope = filterScopeRef.current;
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        if (originatingScope !== filterScopeRef.current) return;
        committedSearchNameRef.current = nextName;
        setName(nextName);
      }, SEARCH_DEBOUNCE_MS);
    },
    [setName],
  );

  // The Filters sheet's name field: the list's only climb-name search.
  const handleSheetNameChange = useCallback(
    (text: string) => runWhileOpen(() => handleSearchChange(text)),
    [handleSearchChange, runWhileOpen],
  );

  // The ONE clearing path for name, shared by the filter sheet's Reset button, its
  // inline × (#3606) and the name token. It keeps Filters open: Reset must not
  // close the sheet.
  const handleClearName = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    visibleSearchTextRef.current = '';
    committedSearchNameRef.current = '';
    setName('');
  }, [setName]);

  const handleSheetClearName = useCallback(() => runWhileOpen(handleClearName), [runWhileOpen, handleClearName]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    };
  }, [filterScopeKey]);

  // Load recent filters on mount. Pass auth state so auth-gated fields get
  // stripped from pills written by a prior signed-in session.
  useEffect(() => {
    let cancelled = false;
    getRecentFilters({ isAuthenticated })
      .then((recent) => {
        if (!cancelled) setRecentFilters(recent);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  // One-time board-history reveal banner: armed when the user binds a board from
  // the onboarding hand-off (app/boards/index.tsx) and consumed on focus so it
  // shows on the Climbs landing, pointing at the board's "now on the wall" sheet.
  // The `revealTipVisible` state is declared earlier so handleOpenBoardDetail can
  // clear it on tap.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void hasBoardRevealTipPending().then((pending) => {
        if (cancelled || !pending) return;
        setRevealTipVisible(true);
        void clearBoardRevealTipPending();
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );
  const dismissRevealTip = useCallback(() => setRevealTipVisible(false), []);
  // The connect-step card (#5654, treatment only) goes first: one card at a
  // time, and both one-shot tips below wait until it is gone. Read from the
  // card's own store, so for everyone outside the treatment this is false.
  // The card offers a Bluetooth connect: not on a wall with no light kit, and not
  // on one lit by a wall device, where climbers take the wall instead.
  const connectCardBoardHasLights = activeBoard != null && !drivesWithoutBluetooth(activeBoard);
  const connectCardVisible = useFirstConnectCardExpected(connectCardBoardHasLights);
  // Connecting from that card hides it, and the "Connected to {{board}}" dialog
  // lands a moment later: the tips wait through that too, so neither shows
  // under the dialog (and the quick-actions tip is not used up there).
  const connectConfirmationShowing = useFirstConnectConfirmationShowing();
  const showRevealTip = revealTipVisible && !!activeBoard && !connectCardVisible && !connectConfirmationShowing;

  // One-shot tip teaching the quick-actions menu (long-press or the ⋯ button).
  // Armed on focus if unseen; held back until the board-reveal banner is gone so
  // the two never stack. Marked seen the moment it actually shows, so it fires once.
  const [quickActionsTipArmed, setQuickActionsTipArmed] = useState(false);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void hasSeenTip(ONBOARDING_TIP_QUICKACTIONS_KEY).then((seen) => {
        if (!cancelled && !seen) setQuickActionsTipArmed(true);
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );
  const dismissQuickActionsTip = useCallback(() => setQuickActionsTipArmed(false), []);

  const boardName = activeBoard?.boardType ?? '';
  const layoutId = activeBoard?.layoutId ?? 0;
  const sizeId = activeBoard?.sizeId ?? 0;
  const setIds = activeBoard?.setIds ?? '';
  const angle = activeBoard?.angle ?? 0;
  // A board that mirrors gives its rows a line per direction, which the
  // placeholder rows stand in for too.
  const rowsTrackDirections = boardSupportsMirroring(boardName, layoutId);
  // A climber who switched thumbnails off gets none warmed ahead of the scroll.
  const rowsShowThumbnail = useClimbRowField('thumbnail');

  const hasBoardConfig = !!activeBoard;
  // An archived spray wall keeps its climbs, but nothing new is set on it.
  const wallArchived = useSprayWallIsArchived(boardName, hasBoardConfig ? layoutId : null);

  // Reactive connectivity, for the offline-only empty state below.
  const isOffline = useIsOffline();
  // ...and which side is down, so the filter placard blames the right one.
  const { reason: connectivityReason } = useConnectivity();
  // 'missing' (offer the download) vs 'queued' (already asked for) vs null.
  const offlineCatalog = useOfflineCatalogState(activeBoard);

  const { data: gradesData } = useGrades(boardName);
  const gradesRef = useRef(gradesData);
  gradesRef.current = gradesData;
  const grades = useMemo(() => gradesData ?? [], [gradesData]);
  const { formatGradeByDifficultyId, gradeFormat } = useGradeFormat();
  const formatBoardGradeByDifficultyId = useCallback(
    (difficultyId: number | null | undefined) => formatGradeByDifficultyId(difficultyId, boardName),
    [formatGradeByDifficultyId, boardName],
  );
  // The grade row's chips. The filter token and the recent pill name a grade by
  // these, the way the chip does (one "V0" for 4a to 4c under V grades), so one
  // pick is never spelled two ways (#5960).
  const gradeStops = useMemo(
    () => buildGradeRailStops(grades, gradeFormat, boardName),
    [grades, gradeFormat, boardName],
  );

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
          replaceSearch(statusForAuth(saved.filters, isAuthenticated), saved.searchText, saved.boardFilters);
        } else {
          // Never-searched board → clean default band, no grade/filters/name
          // inherited from the board the climber came from.
          replaceSearch(DEFAULT_CLIMB_FILTER_STATE, '', DEFAULT_CLIMB_BOARD_FILTER_STATE);
        }
        restoredKeyRef.current = boardKey;
        setRestoredKey(boardKey);
      })
      .catch(() => {
        if (cancelled) return;
        replaceSearch(DEFAULT_CLIMB_FILTER_STATE, '', DEFAULT_CLIMB_BOARD_FILTER_STATE);
        restoredKeyRef.current = boardKey;
        setRestoredKey(boardKey);
      });
    return () => {
      cancelled = true;
    };
    // Restore is keyed on the board only — re-running on filter changes would
    // clobber the user's edits. replaceSearch is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardKey, isAuthenticated]);

  // Search is "ready" once this board's restore has landed — gate queries on it.
  const searchReady = hasBoardConfig && restoredKey === boardKey;
  const searchReadyRef = useRef(searchReady);
  searchReadyRef.current = searchReady;
  // Where the open Filters sheet came from, for `Climb Filters Closed`.
  const filtersOpenSourceRef = useRef<ClimbFiltersOpenSource>('filters_chip');
  const openFiltersFrom = useCallback(
    (source: ClimbFiltersOpenSource) => {
      // Live edits must start after this board's saved search has landed; otherwise
      // the pending restore could replace the climber's new selection. A ref also
      // gates native callbacks retained from the previous board's ready render.
      if (!searchReadyRef.current) return;
      setGradePopoverOpen(false);
      if (!openFilters()) return;
      filtersOpenSourceRef.current = source;
      track(SHARED_EVENTS.ClimbFiltersOpened, {
        source,
        // The normalized selection, as `Climb Filters Closed` reports it.
        activeFilterCount: countActiveFilters(normalizedFilters, boardFilters),
        hasName: committedSearchNameRef.current.length > 0,
      });
    },
    [openFilters, normalizedFilters, boardFilters],
  );
  const handleOpenFilters = useCallback(() => openFiltersFrom('filters_chip'), [openFiltersFrom]);
  const handleOpenFiltersFromEmpty = useCallback(() => openFiltersFrom('empty_recovery'), [openFiltersFrom]);
  // The list has no search field. A second tap on the Climbs tab, with the list
  // showing, is the search action and opens Filters, whose first row is the name.
  // No keyboard: the climber taps the name field when they mean to type.
  const handleTabReselect = useCallback(() => openFiltersFrom('tab_reselect'), [openFiltersFrom]);
  useTabReselect(handleTabReselect);

  useEffect(() => {
    if (!boardConfig || !searchReady) return;
    let task: ReturnType<typeof scheduleIdleTask> | null = null;
    const timeout = setTimeout(() => {
      task = scheduleIdleTask(() => {
        prewarmCreateBoardHolds({
          boardName: boardConfig.boardName as BoardName,
          layoutId: boardConfig.layoutId,
          sizeId: boardConfig.sizeId,
          setIds: parseSetIdsParam(boardConfig.setIds),
        });
      });
    }, PREWARM_BOARD_HOLDS_DELAY_MS);
    return () => {
      clearTimeout(timeout);
      task?.cancel();
    };
  }, [boardConfig, searchReady]);

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
    const task = scheduleIdleTask(() => {
      const parsedSetIds = activeBoard.setIds.split(',').map(Number);
      void ensureBackgroundsCached({
        boardName: activeBoard.boardType as BoardName,
        layoutId: activeBoard.layoutId,
        sizeId: activeBoard.sizeId,
        setIds: parsedSetIds,
        colorScheme,
      });
    });
    return () => {
      task.cancel();
    };
  }, [activeBoard, colorScheme]);

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
  const isLoadingMoreRef = useRef(false);
  // The rows on screen, kept out of this screen's state on purpose.
  const visibleRowsStore = useMemo(() => createVisibleRowsStore(), []);
  // An end-reached report that could not be acted on when it arrived; see
  // `shouldFetchNextPage` for why it has to be remembered.
  const endReachedPendingRef = useRef(false);
  // What the last next-page ask started from, and when one last failed: the two
  // facts that stop a re-ask from becoming a drain.
  const loadedCountAtLastFetchRef = useRef<number | null>(null);
  const lastNextPageFailureAtRef = useRef<number | null>(null);
  // Read by the row handlers: a stale row belongs to the previous search, so a
  // tap on it must not open, queue or seed a swipe track from the old results.
  // A ref keeps those handlers (and so renderClimbItem) stable across the flip.
  const isPlaceholderDataRef = useRef(isPlaceholderData);
  isPlaceholderDataRef.current = isPlaceholderData;

  // A new search starts at the top. The list used to reset there implicitly when
  // its data emptied; with the previous rows kept up it has to be told. Keyed on
  // the search itself (the query key's input, without `page`) rather than the
  // input object's identity, so a rebuilt but identical input never scrolls.
  // React Query's own hashKey sorts object keys, so property order can't fake a
  // change. Skips the first run so mounting never scrolls. Includes the grade
  // source `useInfiniteSearchClimbs` adds (issue #5643), so flipping Boardsesh
  // grades on a graded search resets the scroll along with the query key.
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
  const hasSeenSearchKeyRef = useRef(false);
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
  // What covers the list's top edge: the native header's inset, plus the filter
  // controls when they sit over the list instead of above its clip.
  const restoreTopClearanceRef = useRef(0);
  restoreTopClearanceRef.current = -listTopOffset + (filterInTopChrome ? 0 : searchBarHeight);
  useEffect(() => {
    if (!hasSeenSearchKeyRef.current) {
      hasSeenSearchKeyRef.current = true;
      return;
    }
    resetScrollToTop();
    // Back at the top: the row index from the previous search would otherwise
    // read as "near the end" of the new first page and fetch its second page.
    visibleRowsStore.set(0, 0);
    // A place saved for a column change belongs to the previous search too. An
    // empty list never loads, so it would otherwise wait for the next results.
    columnChangeTopIndexRef.current = null;
    // And an end-reached report from the previous search is not this one's.
    endReachedPendingRef.current = false;
    loadedCountAtLastFetchRef.current = null;
    lastNextPageFailureAtRef.current = null;
  }, [searchScrollKey, visibleRowsStore, resetScrollToTop]);

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

  // Waits for a climb row to exist: the tip teaches a gesture on one (#5960).
  const showQuickActionsTip = shouldShowQuickActionsTip({
    armed: quickActionsTipArmed,
    revealTipShowing: showRevealTip,
    connectCardVisible,
    connectConfirmationShowing,
    climbCount: visibleClimbs.length,
  });
  useEffect(() => {
    if (showQuickActionsTip) void markTipSeen(ONBOARDING_TIP_QUICKACTIONS_KEY);
  }, [showQuickActionsTip]);
  // The player's preview-first card waits while any of this list's cards is on
  // screen: on a tablet the player pane sits beside this list. A phone's player
  // covers the list, which loses focus, so nothing is published then.
  useEffect(() => {
    setListCardShowing('firstConnect', isFocused && connectCardVisible);
    setListCardShowing('boardReveal', isFocused && showRevealTip);
    setListCardShowing('quickActions', isFocused && showQuickActionsTip);
  }, [isFocused, connectCardVisible, showRevealTip, showQuickActionsTip]);
  useEffect(
    () => () => {
      setListCardShowing('firstConnect', false);
      setListCardShowing('boardReveal', false);
      setListCardShowing('quickActions', false);
    },
    [],
  );

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
    // Placeholder rows are the PREVIOUS search's results. Tracking them would log
    // the old result count under the new filters and burn the track key, so the
    // real result for these filters would never be logged.
    if (!firstSearchPage || isPlaceholderData || showFilters) return;
    // Skip the default state (no search text, no active filters): the initial
    // tab-mount load is not a user search/apply, and web suppresses it the same
    // way (only fires when at least one filter/term is active).
    if (name.length === 0 && !hasActiveFilters(filters) && !hasActiveBoardFilters(boardFilters)) return;
    const trackKey = JSON.stringify({ name, filters, boardFilters, boardName, layoutId, sizeId, setIds, angle });
    if (lastSearchTrackKeyRef.current === trackKey) return;
    lastSearchTrackKeyRef.current = trackKey;
    // Matches the `isEmpty` check driving the empty-state UI below (deduped
    // count, not the raw page-0 length) so the snapshot fires exactly when the
    // user actually sees zero rows.
    const isZeroResult = visibleClimbs.length === 0;
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
      // Individual filter dimensions (issue #3290): web sends these so the two
      // platforms are comparable — "what share set a grade range / changed the
      // sort?". `0` = unset to match web's sentinel (DEFAULT_SEARCH_PARAMS all
      // default to 0; difficulty ids start at 10, so 0 is never a real grade),
      // so a single PostHog query (`minGrade > 0`) works on both platforms.
      // `setterCount` is the size of the setter filter (0 = none, like web).
      minGrade: filters.minGrade ?? 0,
      maxGrade: filters.maxGrade ?? 0,
      // Which grades the climber reads. Under V grades the grade row groups
      // grades with one label, so a "V0" pick is minGrade 10, maxGrade 12 there
      // and reads as a range without this.
      gradeFormat,
      sortBy: filters.sortBy,
      sortOrder: filters.sortOrder,
      setterCount: filters.setter?.length ?? 0,
      minAscents: filters.minAscents ?? 0,
      minRating: filters.minRating ?? 0,
      // Zero-result filter snapshot: the fields above already cover
      // grade/sort/setter/ascents/rating unconditionally, so this only adds the
      // *remaining* filter dimensions, and only on a dead end — the signal for
      // "which filter caused this search to come up empty".
      ...(isZeroResult && {
        zeroResultStatus: filters.status ?? null,
        zeroResultGradeAccuracy: filters.gradeAccuracy ?? null,
        zeroResultOnlyTallClimbs: filters.onlyTallClimbs ?? false,
        zeroResultOnlyWideClimbs: filters.onlyWideClimbs ?? false,
        zeroResultOnlyWithBetaVideos: filters.onlyWithBetaVideos ?? false,
        zeroResultIncludeOtherAngles: filters.includeOtherAngles ?? false,
        zeroResultBoulders: filters.boulders ?? true,
        zeroResultRoutes: filters.routes ?? false,
        zeroResultHideAttempted: filters.hideAttempted ?? false,
        zeroResultHideCompleted: filters.hideCompleted ?? false,
        zeroResultShowOnlyAttempted: filters.showOnlyAttempted ?? false,
        zeroResultShowOnlyCompleted: filters.showOnlyCompleted ?? false,
        zeroResultOnlyBenchmarks: boardFilters.onlyBenchmarks ?? false,
        zeroResultHasHoldsFilter: !!(boardFilters.holdsFilter && Object.keys(boardFilters.holdsFilter).length > 0),
        zeroResultHasZoneFilter: boardFilters.zoneBox != null,
        zeroResultZoneMode: boardFilters.zoneMode ?? null,
        zeroResultHasSetterIdFilter: boardFilters.setterId != null,
      }),
    });
  }, [
    firstSearchPage,
    isPlaceholderData,
    showFilters,
    visibleClimbs,
    name,
    filters,
    boardFilters,
    boardName,
    layoutId,
    sizeId,
    setIds,
    angle,
    gradeFormat,
  ]);

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
    isLoadingMoreRef.current = false;
    return refetch();
  }, [refetch]);
  const pullRefresh = usePullRefresh(handleRefresh, isRefetching);

  // Pagination state read by `maybeFetchNextPage`, which is called from list
  // callbacks and must not change identity (a new one re-renders the FlashList).
  const paginationState = {
    hasNextPage,
    isPlaceholderData,
    isLoading: isClimbsLoading,
    isFetchingNextPage,
    isRefetching,
    lastFetchFailed: isFetchNextPageError,
    loadedCount: visibleClimbs.length,
    climbsPerRow: listColumns,
  };
  const paginationStateRef = useRef(paginationState);
  paginationStateRef.current = paginationState;

  /**
   * Fetch the next page if `shouldFetchNextPage` says so. One page per call,
   * never a drain: the `isLoadingMoreRef` latch holds until that page settles,
   * and an ask the climber did not cause only goes ahead when the last one made
   * progress.
   */
  const maybeFetchNextPage = useCallback(
    (trigger: NextPageTrigger) => {
      const pagination = paginationStateRef.current;
      const failedAt = lastNextPageFailureAtRef.current;
      const shouldFetch = shouldFetchNextPage({
        ...pagination,
        trigger,
        fetchInFlight: isLoadingMoreRef.current,
        msSinceLastFailure: failedAt === null ? null : Date.now() - failedAt,
        loadedCountAtLastFetch: loadedCountAtLastFetchRef.current,
        firstVisibleIndex: visibleRowsStore.getFirst(),
        lastVisibleIndex: visibleRowsStore.getLast(),
        endReachedPending: endReachedPendingRef.current,
        pageSize: PAGE_SIZE,
      });
      if (!shouldFetch) return;
      endReachedPendingRef.current = false;
      loadedCountAtLastFetchRef.current = pagination.loadedCount;
      isLoadingMoreRef.current = true;
      void fetchNextPage()
        .then((result) => {
          lastNextPageFailureAtRef.current = result.isFetchNextPageError ? Date.now() : null;
        })
        .finally(() => {
          isLoadingMoreRef.current = false;
        });
    },
    [fetchNextPage, visibleRowsStore],
  );

  const handleEndReached = useCallback(() => {
    // FlashList also reports the end of a list too short to scroll. Only keep
    // the report when there is a page it could ever be spent on, or it would
    // sit there and fetch the NEXT search's second page the moment its first
    // one landed.
    const pagination = paginationStateRef.current;
    if (pagination.hasNextPage && !pagination.isPlaceholderData) endReachedPendingRef.current = true;
    maybeFetchNextPage('scroll');
  }, [maybeFetchNextPage]);

  const handleListClipLayout = useCallback((event: LayoutChangeEvent) => {
    setListHasRoomForTwo(climbListHasRoomForTwoColumns(event.nativeEvent.layout.width));
  }, []);

  // Save the climb at the top whenever the column count changes, whether the
  // list's width or the Columns setting changed it. This runs in the commit that
  // mounts the new list, before it can report its own rows, so the store still
  // holds the old list's top climb. A restore the new list has not used yet wins:
  // two changes in a row (a rotation passing through a narrow width) would
  // otherwise save the in-between list's first row.
  useLayoutEffect(() => {
    if (savedColumnsRef.current === listColumns) return;
    savedColumnsRef.current = listColumns;
    if (columnChangeTopIndexRef.current !== null) return;
    const firstVisibleIndex = visibleRowsStore.getFirst();
    columnChangeTopIndexRef.current = firstVisibleIndex > 0 ? firstVisibleIndex : null;
  }, [listColumns, visibleRowsStore]);

  // The remounted list has laid out: put the climb that was at the top back there,
  // below the header and controls the list draws under (`useListTopOffset`), not
  // behind them. scrollToIndex adds `viewOffset` to the item's offset.
  const handleListLoad = useCallback(() => {
    const index = columnChangeTopIndexRef.current;
    columnChangeTopIndexRef.current = null;
    if (index === null || index >= paginationStateRef.current.loadedCount) return;
    void climbListRef.current?.scrollToIndex({
      index,
      animated: false,
      viewOffset: -restoreTopClearanceRef.current,
    });
  }, []);

  const handleViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<Climb>[] }) => {
      let firstVisibleIndex = Number.POSITIVE_INFINITY;
      let lastVisibleIndex = -1;
      for (const viewable of viewableItems) {
        if (viewable.index == null) continue;
        if (viewable.index < firstVisibleIndex) firstVisibleIndex = viewable.index;
        if (viewable.index > lastVisibleIndex) lastVisibleIndex = viewable.index;
      }
      if (lastVisibleIndex < 0) return;
      visibleRowsStore.set(firstVisibleIndex, lastVisibleIndex);
      maybeFetchNextPage('scroll');
    },
    [visibleRowsStore, maybeFetchNextPage],
  );

  // Ask again whenever the list becomes free: a page landed (there may be more
  // to fetch already — a flick outruns one page), or a refetch finished that was
  // in the way when the climber reached the end. This is the `settle` ask, the
  // one `shouldFetchNextPage` refuses after a failure or a page of duplicates.
  useEffect(() => {
    if (!hasNextPage) endReachedPendingRef.current = false;
    maybeFetchNextPage('settle');
  }, [
    maybeFetchNextPage,
    hasNextPage,
    isPlaceholderData,
    isClimbsLoading,
    isFetchingNextPage,
    isFetchNextPageError,
    isRefetching,
    visibleClimbs,
  ]);

  // The search the swipe track pages against, frozen at selection (issue #5402).
  // See `useFrozenSearchBasis` for why it must not follow the live filters.
  const searchBasis = useFrozenSearchBasis({ filters, boardFilters, name });

  // Page the same search query the list uses so the play-drawer swipe can walk
  // climbs beyond what's loaded. Activation pages and search pages are both 0-based.
  //
  // Reads the frozen basis rather than taking the filters as dependencies, so one
  // drain cannot straddle two orderings and the callback identity stays stable
  // across list refetches.
  const searchInputForPage = useCallback(
    (basis: ReturnType<typeof searchBasis.read>, page: number, pageSize: number) => {
      const { filters: basisFilters, boardFilters: basisBoardFilters, name: basisName } = basis;
      return withGradeSource(
        mergeBoardFilters(
          toClimbSearchInput(
            filtersForBoard(basisFilters, boardName),
            { boardName, layoutId, sizeId, setIds, angle },
            { page, pageSize },
            { name: basisName },
          ),
          basisBoardFilters,
        ),
        boardseshGradesActive,
      );
    },
    [boardName, layoutId, sizeId, setIds, angle, boardseshGradesActive],
  );
  const fetchSearchPageFor = useCallback(
    async (basis: ReturnType<typeof searchBasis.read>, page: number, pageSize: number) => {
      // Same offline-aware source the list uses, so the play-drawer swipe keeps
      // paging climbs with no signal on a downloaded board.
      const response = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, {
        input: searchInputForPage(basis, page, pageSize),
      });
      return {
        climbs: toQueueClimbs(response.searchClimbs.climbs),
        hasMore: response.searchClimbs.hasMore,
      };
    },
    [searchInputForPage],
  );
  const fetchSearchPage = useCallback(
    ({ page, pageSize }: { page: number; pageSize: number }) => fetchSearchPageFor(searchBasis.read(), page, pageSize),
    [fetchSearchPageFor, searchBasis],
  );
  // Every row tap re-captures the basis, crew and preview taps included, which
  // leave the committed track alone. A track's later pages keep the search it
  // was built from.
  const snapshotSearchPageFetcher = useCallback(() => {
    const basis = searchBasis.read();
    return ({ page, pageSize }: { page: number; pageSize: number }) => fetchSearchPageFor(basis, page, pageSize);
  }, [fetchSearchPageFor, searchBasis]);
  // The search pages carry no count (counting every page would cost the server
  // a count per page), so the player's "4 of 230" asks for one per tap, for the
  // same frozen search the pages walk, through the count cache.
  const fetchCachedCount = useFetchCachedSearchClimbsCount();
  const { userId: storedUserId } = useStoredUserId(true);
  const fetchSearchTotal = useCallback(() => {
    const { page: _page, pageSize: _pageSize, ...countInput } = searchInputForPage(searchBasis.read(), 0, 1);
    return fetchCachedCount(countInput, storedUserId);
  }, [fetchCachedCount, searchBasis, searchInputForPage, storedUserId]);

  const allQueueClimbs = useMemo(() => toQueueClimbs(visibleClimbs), [visibleClimbs]);

  const activateClimbListClimb = usePlaylistActivation({
    sourceId: 'climblist',
    allClimbs: allQueueClimbs,
    fetchPage: fetchSearchPage,
    snapshotFetchPage: snapshotSearchPageFetcher,
    fetchTotal: fetchSearchTotal,
    label: tSession('playView.track.searchResults'),
    // The rows are this same search's pages, from the top, on the active board.
    loadedRowsArePages: true,
    // In a crew, a row tap browses instead of taking everyone's wall: the drawer
    // opens on the tapped climb with these results seeded as its swipe track, so
    // the climber can walk the list and put up only the one they choose.
    previewOnly: isSharedSession,
    refreshErrorMessage: 'Failed to refresh climb-list suggestions:',
  });

  const handleClimbPress = useCallback(
    (climb: Climb, readyBoardArt?: import('../../../src/lib/board-render/ready-board-art').ReadyBoardArtSnapshot) => {
      if (isPlaceholderDataRef.current) return;
      // First, before the navigation work below: the play drawer needs ~110ms to
      // mount and measure, and this render fits inside that.
      requestPlayBoardPrewarm({ boardName: boardName as BoardName, layoutId, sizeId, setIds }, climb.frames);
      // This tap IS the selection, so it is the one moment the swipe track may be
      // re-derived. Every tap re-captures it, previews included: outside a
      // drive, the activation hook opens a preview seeded with these results,
      // so swipes walk them (#5157).
      searchBasis.capture();
      void activateClimbListClimb.activate(toQueueClimb(climb), readyBoardArt);
    },
    [activateClimbListClimb, searchBasis, boardName, layoutId, sizeId, setIds],
  );

  // Row actions ignore stale placeholder rows, same as handleClimbPress. The
  // right swipe is Play next: the top of Up next, so a climber with a long queue
  // still reaches what they swiped (#6772).
  const handlePlayNext = useCallback(
    (climb: Climb) => {
      if (isPlaceholderDataRef.current) return;
      void playNext({ item: { uuid: randomUUID(), climb } });
    },
    [playNext],
  );

  // The row builds its menu while it renders, so the stale-row guard runs when
  // a command is picked, not here: a dep on the placeholder flag would rebuild
  // every visible row's menu twice per search.
  const handleOpenClimbActions = useCallback(
    (climb: Climb) => {
      const target = getClimbActions(climb);
      if (!target) return target;
      return { ...target, resolveClimb: async () => (isPlaceholderDataRef.current ? null : climb) };
    },
    [getClimbActions],
  );

  const handleOpenAddToPlaylist = useCallback(
    (climb: Climb, anchorPoint?: WindowAnchorPoint) => {
      if (isPlaceholderDataRef.current) return;
      openAddToPlaylist(climb, undefined, anchorPoint);
    },
    [openAddToPlaylist],
  );

  // Preferences commit on every control change. Only ending a filter session
  // records a recent preset; a temporary sub-picker suspension does not.
  finishFiltersRef.current = (finalSelection) => {
    const finalScope = filterScopeRef.current;
    const finalName = debounceTimerRef.current
      ? normalizeSearchName(visibleSearchTextRef.current)
      : committedSearchNameRef.current;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = null;
    committedSearchNameRef.current = finalName;
    replaceSearch(finalSelection.filters, finalName, finalSelection.boardFilters);
    track(SHARED_EVENTS.ClimbFiltersClosed, {
      source: filtersOpenSourceRef.current,
      activeFilterCount: countActiveFilters(finalSelection.filters, finalSelection.boardFilters),
      hasName: finalName.length > 0,
    });

    // Recent pills store climb filters + name, not board-renderer filters.
    if (hasActiveFilters(finalSelection.filters) || finalName.length > 0) {
      const label = getFilterSummary(finalSelection.filters, finalName, gradesRef.current, t, gradeStops);
      addRecentFilter(label, finalSelection.filters, finalName)
        .then(() => getRecentFilters({ isAuthenticated }))
        .then((recent) => {
          if (filterScopeRef.current === finalScope) setRecentFilters(recent);
        })
        .catch(() => {});
    }
  };

  const handleApplyRecentFilter = useCallback(
    (pillFilters: ClimbFilters, pillSearchText: string) => {
      // Pills are shared across boards; keep only what this board can show.
      replaceSearch(filtersForBoard(statusForAuth(pillFilters, isAuthenticated), boardName), pillSearchText);
      visibleSearchTextRef.current = pillSearchText;
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
      committedSearchNameRef.current = pillSearchText;
      Keyboard.dismiss();
    },
    [replaceSearch, boardName, isAuthenticated],
  );

  const handleClearRecentFilters = useCallback(() => {
    clearRecentFilters()
      .then(() => setRecentFilters([]))
      .catch(() => {});
  }, []);

  // Material filter-summary chip clears the non-grade refinements (the dedicated
  // grade chip owns the grade), keeping the typed name query. The glass variant
  // has no chrome clear-all — it clears via the filter sheet's Reset.
  const handleClearNonGradeFilters = useCallback(() => {
    replaceSearch(
      {
        ...DEFAULT_CLIMB_FILTER_STATE,
        minGrade: filters.minGrade,
        maxGrade: filters.maxGrade,
      },
      name,
      DEFAULT_CLIMB_BOARD_FILTER_STATE,
    );
  }, [replaceSearch, name, filters.minGrade, filters.maxGrade]);

  // Remember the grade the climber filters by (from any path — the chip rail,
  // the filter sheet's Apply, tokens, recent pills, per-board restore) so the
  // rail can open centred on it later. Skips clears (undefined) so clearing
  // keeps the last real grade in memory rather than forgetting it.
  useEffect(() => {
    const focusGrade = filters.minGrade ?? filters.maxGrade;
    if (focusGrade != null) rememberGrade(focusGrade);
  }, [filters.minGrade, filters.maxGrade, rememberGrade]);

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

  const gradeBound = useMemo<GradeBound>(
    () => ({ minGradeId: filters.minGrade, maxGradeId: filters.maxGrade }),
    [filters.minGrade, filters.maxGrade],
  );
  const activeFilterCount = useMemo(() => countActiveFilters(filters, boardFilters), [filters, boardFilters]);
  // The Filters badge also counts a name search, which lives in the sheet like any
  // other filter (the Logbook pattern). Analytics and the empty states keep
  // `activeFilterCount`, which leaves the name out.
  const filtersBadgeCount = activeFilterCount + (name.trim().length > 0 ? 1 : 0);
  // The name search as the first token: the list shows it, and clears it, here.
  const nameToken = useMemo(() => buildNameFilterToken(name, t, handleClearName), [name, t, handleClearName]);
  // `Grade Filter Changed`: each change the climber makes on the grade row or
  // its iPad popover, with how they made it. The filter sheet's rail edits a
  // draft and is not reported here.
  const lastGradeChangeAtRef = useRef<number | null>(null);
  const handleGradeRailChange = useCallback(
    (next: GradeBound, change: GradeRailChange) => {
      const changedAt = Date.now();
      const previousChangeAt = lastGradeChangeAtRef.current;
      lastGradeChangeAtRef.current = changedAt;
      track(SHARED_EVENTS.GradeFilterChanged, {
        // 0 = unset, the sentinel Climb Search Performed uses.
        fromMin: gradeBound.minGradeId ?? 0,
        fromMax: gradeBound.maxGradeId ?? 0,
        toMin: next.minGradeId ?? 0,
        toMax: next.maxGradeId ?? 0,
        gesture: change.gesture,
        // Only on a tap with one other grade selected: did it land inside the
        // range window (a range) or after it (a switch)?
        ...(change.withinRangeWindow !== undefined && { withinRangeWindow: change.withinRangeWindow }),
        // Left out on the first change of the session.
        ...(previousChangeAt !== null && { msSincePrevious: changedAt - previousChangeAt }),
      });
      setGrade(next);
    },
    [gradeBound, setGrade],
  );
  // Once open, the grade row stays on screen, so it outlives a visit to a climb.
  // On the way back it centres on the current selection again, wherever the
  // climber left it scrolled.
  const gradeRecenterKey = useRefocusCount();
  // Removable active-filter tokens for the scope row beneath the search field.
  // Each token's `clear` patches just its field back to the default.
  const filterTokens = useMemo(
    () =>
      getActiveFilterTokens({
        filters,
        boardFilters,
        boardName,
        grades,
        t,
        formatGradeByDifficultyId: formatBoardGradeByDifficultyId,
        gradeStops,
        patchFilters,
        patchBoardFilters,
        setGrade,
      }),
    [
      filters,
      boardFilters,
      boardName,
      grades,
      t,
      formatBoardGradeByDifficultyId,
      gradeStops,
      patchFilters,
      patchBoardFilters,
      setGrade,
    ],
  );
  const nonGradeFilterTokens = useMemo(
    () => filterTokens.filter((filterToken) => filterToken.key !== 'grade'),
    [filterTokens],
  );
  const summaryFilterTokens = features.summaryExcludesGradeFilter ? nonGradeFilterTokens : filterTokens;
  // Condensed summary of the active filters (variant-aware: Material chip vs glass
  // title). See buildClimbFilterSummary.
  const filterSummary = useMemo(
    () =>
      buildClimbFilterSummary({
        labels: summaryFilterTokens.map((token) => token.label),
        isMaterial: selectByVariant(variant, { material: true, liquidGlass: false }),
        maxChars: SUMMARY_MAX_CHARS,
        more: (count) => t('mobile.search.more', { count }),
      }),
    [summaryFilterTokens, variant, t],
  );
  // The glass screen title: the active-filter summary, or "All climbs" when none.
  // Shown as the persistent centre title in the floating chrome.
  const searchTitle = filterSummary ?? t('mobile.search.allClimbs');
  // Stable object for the memoized ClimbTopChrome's filterSummary prop — inline
  // it would allocate every render and defeat the memo.
  const filterSummaryProp = useMemo(
    () =>
      filterInTopChrome && filterSummary ? { text: filterSummary, onClear: handleClearNonGradeFilters } : undefined,
    [filterInTopChrome, filterSummary, handleClearNonGradeFilters],
  );
  const gradeFilterToken = useMemo(
    () => filterTokens.find((filterToken) => filterToken.key === 'grade'),
    [filterTokens],
  );
  const gradeChip = useMemo(() => {
    if (gradeFilterToken) {
      return { label: gradeFilterToken.label, active: true, onClear: gradeFilterToken.clear };
    }
    return { label: t('mobile.filter.grade'), active: false };
  }, [gradeFilterToken, t]);

  // --- Persistent filter chips (Liquid Glass) ---
  // Each facet chip commits live through the search-provider patch actions. The
  // Popularity chip routes through applyPopularityBucket so it clears a
  // conflicting projects/drafts status, exactly like the filter sheet.
  // Bare patch, mirroring the sheet's StarRating (which also doesn't conflict-clear
  // status for minRating); keeps the chip, token, and sheet divergence-free.
  const handleChangeRating = useCallback(
    (value: number | undefined) => patchFilters({ minRating: value }),
    [patchFilters],
  );
  const handleChangePopularity = useCallback(
    (bucket: number | undefined) => patchFilters(applyPopularityBucket(filters, bucket)),
    [patchFilters, filters],
  );
  // "Your progress" writes a full four-flag patch (progressToFlags clears stale
  // flags), so switching between values never leaves a contradictory flag behind.
  const handleChangeProgress = useCallback(
    (value: ProgressFilter) => patchFilters(progressToFlags(value)),
    [patchFilters],
  );
  // Collection — Benchmarks (board filter), My drafts (status) and Liked
  // (onlyFavorited), mutually exclusive: picking one clears the other two.
  const handleChangeCollection = useCallback(
    (value: CollectionFilter) => {
      patchFilters(collectionPatch(value, filters).filters);
    },
    [patchFilters, filters],
  );
  // --- Tier-2 (opt-in) chip handlers — mirror the filter sheet's own controls so
  // a chip and the sheet never diverge. ---
  // Sort: picking Random reseeds a fresh shuffle (matches the sheet); every other
  // key clears the seed. Direction (asc/desc) stays a sheet-only refinement.
  const handleChangeSort = useCallback((value: SortOption) => patchFilters(sortKeyPatch(value)), [patchFilters]);
  const handleChangeAccuracy = useCallback(
    (value: GradeAccuracyValue | 'off') => patchFilters({ gradeAccuracy: value === 'off' ? undefined : value }),
    [patchFilters],
  );
  // Climb type — the same shared mapping as the sheet's handleClimbTypeChange.
  const handleChangeClimbType = useCallback(
    (value: ClimbTypeFilter) => patchFilters(climbTypePatch(value)),
    [patchFilters],
  );
  const handleToggleBeta = useCallback(
    () => patchFilters({ onlyWithBetaVideos: filters.onlyWithBetaVideos ? undefined : true }),
    [patchFilters, filters.onlyWithBetaVideos],
  );
  const handleToggleBenchmarks = useCallback(
    () => patchBoardFilters({ onlyBenchmarks: boardFilters.onlyBenchmarks ? undefined : true }),
    [patchBoardFilters, boardFilters.onlyBenchmarks],
  );
  // Climb-type single-select derived from the boulders/routes flags — one shared
  // helper with the sheet, so the chip and sheet never show a different pick.
  const climbType = getClimbTypeFilter(filters);
  // Sort is "active" whenever the key OR direction differs from the default — the
  // same condition the sort token uses, so the chip lights up in lockstep with it.
  const sortActive =
    filters.sortBy !== DEFAULT_CLIMB_FILTER_STATE.sortBy || filters.sortOrder !== DEFAULT_CLIMB_FILTER_STATE.sortOrder;
  // Tall/Wide chips appear on any board whose active size has a shorter/narrower
  // size in its product family — Kilter Homewall & Original, Tension Board 2,
  // Decoy, Grasshopper (getTallWideScope is the shared source of truth, matching
  // the server filter). Tap toggles the filter. On iOS a long-press locks it
  // (persisted) so it survives clears; the upkeep hooks below re-apply a locked
  // filter whenever it's cleared. Every rule lives in lib/dimension-chips.ts.
  const { locks: dimensionLocks, setLock: setDimensionLock } = useDimensionLocks();
  const { hasShorter: showTallChip, hasNarrower: showWideChip } = getTallWideScope(
    boardName as BoardName,
    layoutId,
    sizeId,
  );
  const tallLockState = useMemo<DimensionLockState>(
    () => ({
      lockSupported: DIMENSION_LOCK_SUPPORTED,
      locked: dimensionLocks.tall,
      inScope: showTallChip,
      pinned: pinnedChips.includes('tall'),
      pinsLoaded: pinnedChipsLoaded,
    }),
    [dimensionLocks.tall, showTallChip, pinnedChips, pinnedChipsLoaded],
  );
  const wideLockState = useMemo<DimensionLockState>(
    () => ({
      lockSupported: DIMENSION_LOCK_SUPPORTED,
      locked: dimensionLocks.wide,
      inScope: showWideChip,
      pinned: pinnedChips.includes('wide'),
      pinsLoaded: pinnedChipsLoaded,
    }),
    [dimensionLocks.wide, showWideChip, pinnedChips, pinnedChipsLoaded],
  );
  const dimensionChips = useMemo<DimensionChip[]>(() => {
    const chips: DimensionChip[] = [];
    if (showTallChip) {
      chips.push(
        buildDimensionChip({
          key: 'tall',
          locked: isDimensionChipLocked(tallLockState),
          filterActive: !!filters.onlyTallClimbs,
          setFilter: (on) => patchFilters({ onlyTallClimbs: on || undefined }),
          setLock: (locked) => {
            hapticMedium();
            setDimensionLock('tall', locked);
          },
        }),
      );
    }
    if (showWideChip) {
      chips.push(
        buildDimensionChip({
          key: 'wide',
          locked: isDimensionChipLocked(wideLockState),
          filterActive: !!filters.onlyWideClimbs,
          setFilter: (on) => patchFilters({ onlyWideClimbs: on || undefined }),
          setLock: (locked) => {
            hapticMedium();
            setDimensionLock('wide', locked);
          },
        }),
      );
    }
    return chips;
  }, [
    showTallChip,
    showWideChip,
    tallLockState,
    wideLockState,
    filters.onlyTallClimbs,
    filters.onlyWideClimbs,
    patchFilters,
    setDimensionLock,
  ]);
  // An enforced lock (iOS, in scope, pinned, pins loaded) puts its filter back
  // after any clear (sheet Reset, FAB clear, recent re-apply), but only once this
  // board's saved search has been restored (`searchReady`), since the restore
  // replaces the whole search. Unpinning a chip drops its lock.
  const pinTall = useCallback(() => patchFilters({ onlyTallClimbs: true }), [patchFilters]);
  const pinWide = useCallback(() => patchFilters({ onlyWideClimbs: true }), [patchFilters]);
  useDimensionLockUpkeep({
    key: 'tall',
    state: tallLockState,
    filterActive: !!filters.onlyTallClimbs,
    searchReady,
    pin: pinTall,
  });
  useDimensionLockUpkeep({
    key: 'wide',
    state: wideLockState,
    filterActive: !!filters.onlyWideClimbs,
    searchReady,
    pin: pinWide,
  });
  // The filter sheet holds an enforced lock's switch on (disabled) and keeps it
  // set through its Reset, so its "Show N" count matches what Apply will list.
  // Built from the two flags, so its identity only changes when a lock does (a
  // pin toggle rebuilds the lock states but rarely changes either flag).
  const tallLockEnforced = isDimensionLockEnforced(tallLockState);
  const wideLockEnforced = isDimensionLockEnforced(wideLockState);
  const lockedDimensions = useMemo<LockedDimensions>(
    () => ({ tall: tallLockEnforced, wide: wideLockEnforced }),
    [tallLockEnforced, wideLockEnforced],
  );
  // The normal status token also resets popularity. Empty-search recovery must
  // remove exactly the chosen restriction, keeping every other pick intact.
  const recoveryFilterTokens = useMemo(() => {
    const restrictionTokens = filterTokens.map((token) =>
      token.key === 'status' ? { ...token, clear: () => patchFilters({ status: 'any' }) } : token,
    );
    return nameToken ? [nameToken, ...restrictionTokens] : restrictionTokens;
  }, [filterTokens, patchFilters, nameToken]);
  // Token row = the receipt for the long tail only; a filter backed by a *pinned*
  // chip shows and clears itself there, so it's excluded to avoid wording it
  // twice. Derived from the user's pinned set so unpinning a chip re-surfaces its
  // filter as a removable token (and re-pinning removes the token). Tall/Wide are
  // chip-backed only when their own chip is pinned AND the board size shows it.
  const chipBackedTokenKeys = useMemo(
    () => new Set<string>(pinnedChips.flatMap((kind) => chipKindToTokenKeys(kind))),
    [pinnedChips],
  );
  const sheetOnlyFilterTokens = useMemo(() => {
    const longTailTokens = filterTokens.filter((token) => {
      if (token.key === 'tall') return !(chipBackedTokenKeys.has('tall') && showTallChip);
      if (token.key === 'wide') return !(chipBackedTokenKeys.has('wide') && showWideChip);
      // The Sort chip only switches the sort KEY, never the direction. So keep the
      // sort token (its clear() resets both) whenever the direction is non-default —
      // else an ascending sort set in the sheet would be unclearable from the row.
      if (token.key === 'sort') {
        return !(chipBackedTokenKeys.has('sort') && filters.sortOrder === DEFAULT_CLIMB_FILTER_STATE.sortOrder);
      }
      return !chipBackedTokenKeys.has(token.key);
    });
    return nameToken ? [nameToken, ...longTailTokens] : longTailTokens;
  }, [filterTokens, chipBackedTokenKeys, showTallChip, showWideChip, filters.sortOrder, nameToken]);
  const denseChipRow = selectByVariant(variant, { material: true, liquidGlass: false });
  const filterChrome = useMemo(() => {
    if (!showFilterChips) return null;
    return (
      <>
        <FilterChipRow
          pinnedChips={pinnedChips}
          activeFilterCount={filtersBadgeCount}
          onOpenFilters={handleOpenFilters}
          recentFilters={recentFilters}
          currentFilters={filters}
          currentSearchText={name}
          onApplyRecent={handleApplyRecentFilter}
          onClearRecent={handleClearRecentFilters}
          gradeLabel={gradeChip.label}
          gradeActive={gradeChip.active}
          onOpenGrade={handleOpenGrade}
          gradeRailOpen={gradeUsesPopover ? gradePopoverOpen : gradeRowShown}
          onCloseGrade={handleCloseGrade}
          gradePopoverContent={
            gradeUsesPopover ? (
              <GradeRangeRail
                grades={grades}
                bound={gradeBound}
                lastUsedGradeId={lastUsedGrade}
                boardName={boardName}
                onChange={handleGradeRailChange}
              />
            ) : undefined
          }
          dimensionChips={dimensionChips}
          minAscents={filters.minAscents}
          onChangePopularity={handleChangePopularity}
          minRating={filters.minRating}
          onChangeRating={handleChangeRating}
          progress={flagsToProgress(filters)}
          onChangeProgress={handleChangeProgress}
          canFilterProgress={isAuthenticated}
          collection={getCollectionFilter(filters)}
          onChangeCollection={handleChangeCollection}
          canFilterPersonalCollections={isAuthenticated}
          isSprayWall={boardName === SPRAY_BOARD_NAME}
          boardName={boardName}
          sortBy={filters.sortBy}
          sortActive={sortActive}
          onChangeSort={handleChangeSort}
          accuracyValue={filters.gradeAccuracy ?? 'off'}
          onChangeAccuracy={handleChangeAccuracy}
          climbType={climbType}
          onChangeClimbType={handleChangeClimbType}
          betaActive={!!filters.onlyWithBetaVideos}
          onToggleBeta={handleToggleBeta}
          benchmarksActive={!!boardFilters.onlyBenchmarks}
          onToggleBenchmarks={handleToggleBenchmarks}
          // The Material Climbs bar's 48dp chip row (ClimbTopChrome).
          dense={denseChipRow}
        />
        {/* Under the dense Material chip row nothing else pads the pills off the list. */}
        <FilterTokenRow tokens={sheetOnlyFilterTokens} bottomInset={denseChipRow} />
      </>
    );
  }, [
    showFilterChips,
    denseChipRow,
    gradeUsesPopover,
    grades,
    gradeBound,
    lastUsedGrade,
    boardName,
    handleGradeRailChange,
    gradePopoverOpen,
    gradeRowShown,
    pinnedChips,
    filtersBadgeCount,
    handleOpenFilters,
    recentFilters,
    filters,
    name,
    handleApplyRecentFilter,
    handleClearRecentFilters,
    gradeChip,
    handleOpenGrade,
    handleCloseGrade,
    dimensionChips,
    handleChangePopularity,
    handleChangeRating,
    handleChangeProgress,
    handleChangeCollection,
    boardFilters.onlyBenchmarks,
    isAuthenticated,
    sortActive,
    handleChangeSort,
    handleChangeAccuracy,
    climbType,
    handleChangeClimbType,
    handleToggleBeta,
    handleToggleBenchmarks,
    sheetOnlyFilterTokens,
  ]);

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
        <View style={styles.emptyContainer}>
          <Icon name="boards" size={48} color={systemColors.tertiaryLabel} />
          <Text variant="headline" style={styles.emptyTitle}>
            {t('mobile.emptyState.boardRestoreFailed.title')}
          </Text>
          <Text variant="subheadline" style={styles.emptySubtitle}>
            {t('mobile.emptyState.boardRestoreFailed.description')}
          </Text>
          <Button
            title={tCommon('actions.retry')}
            onPress={() => void refetchActiveBoard()}
            loading={isBoardFetching}
            disabled={isBoardFetching}
            variant="filled"
            style={styles.emptyCta}
          />
        </View>
      </>
    );
  }

  if (isBoardResolved && activeBoard === null) {
    return (
      <>
        <Stack.Screen options={stackOptions} />
        {nativeRootHeader ? <NativeRootHeader titleHidden onHeightChange={handleChromeHeightChange} /> : null}
        <View style={styles.emptyContainer}>
          <Icon name="boards" size={48} color={systemColors.tertiaryLabel} />
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
            // The picker's no-board entry (#5654): a climber with no boards at all
            // gets "Where do you climb?" there, with the gym search, the builder
            // and the Bluetooth scan; one whose active board was only cleared gets
            // their list. Deliberately NOT tagged as onboarding: this empty state
            // shows any time no board is bound, not just first-run, so a bind from
            // it must not fire the activation event or arm the reveal banner.
            onPress={() => router.push(NO_BOARD_PICKER_HREF)}
            variant="filled"
            style={styles.emptyCta}
          />
        </View>
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
                  downloadAction={<OfflineCatalogCta board={activeBoard} style={styles.emptyCta} />}
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
                title={showFilterChips ? undefined : searchTitle}
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
  container: {
    flex: 1,
  },
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
  // Background colour is themed at the call site; 0.4 of it dims the stale rows.
  placeholderTint: {
    opacity: 0.4,
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
  revealBanner: {
    marginHorizontal: spacing[4],
    marginTop: spacing[2],
    marginBottom: spacing[2],
  },
});
