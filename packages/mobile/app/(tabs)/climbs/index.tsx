import { memo, useState, useCallback, useMemo, useRef, useEffect, type ComponentProps } from 'react';
import { View, StyleSheet, RefreshControl, Keyboard, InteractionManager, Pressable } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useFocusEffect, useRouter, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { Climb, BoardName } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import {
  toClimbSearchInput,
  mergeBoardFilters,
  countActiveFilters,
  hasActiveBoardFilters,
  flagsToProgress,
  progressToFlags,
  applyStatusChange,
  newSortSeed,
  DEFAULT_CLIMB_FILTER_STATE,
  DEFAULT_CLIMB_BOARD_FILTER_STATE,
  type ClimbBoardFilterState,
  type ProgressFilter,
  type SortOption,
  type GradeAccuracyValue,
} from '@boardsesh/climb-filters';
import { getTallWideScope } from '@boardsesh/board-constants';
import { getBoardCapabilities } from '@boardsesh/board-config';
import { ClimbListRow } from '../../../src/components/ClimbListRow';
import { ClimbListRowSkeleton } from '../../../src/components/ClimbListRowSkeleton';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { Text } from '../../../src/components/Text';
import { Icon } from '../../../src/components/Icon';
import { Button } from '../../../src/components/Button';
import { ClimbFilterSheet, hasActiveFilters, type ClimbFilters } from '../../../src/components/ClimbFilterSheet';
import { ClimbTopChrome } from '../../../src/components/search/ClimbTopChrome';
import { FilterChipRow } from '../../../src/components/search/FilterChipRow';
import type { DimensionChip } from '../../../src/components/search/FilterChipRow.types';
import { chipKindToTokenKeys } from '../../../src/lib/pinnable-chips';
import { usePinnedChips } from '../../../src/lib/pinned-chips-store';
import {
  getCollectionFilter,
  getClimbTypeFilter,
  type CollectionFilter,
  type ClimbTypeFilter,
} from '../../../src/lib/collection-filter';
import { FilterTokenRow } from '../../../src/components/search/FilterTokenRow';
import { GradeRangeRail } from '../../../src/components/grade';
import { applyPopularityBucket } from '../../../src/lib/filter-chip-menus';
import { useDrawerHost } from '../../../src/providers/drawer-host-provider';
import { useTheme, useAppColorScheme } from '../../../src/providers/theme-provider';
import { selectByVariant } from '../../../src/theme/variants';
import { useActiveClimbUuid, useQueueActions } from '../../../src/providers/queue-provider';
import { ClimbSearchProvider, useClimbSearch, type GradeBound } from '../../../src/providers/climb-search-provider';
import { setSetting, useSetting } from '../../../src/settings';
import { climbToQueueItem } from '../../../src/lib/climb-to-queue-item';
import { useBoardActions } from '@boardsesh/board-react';
import { randomUUID } from 'expo-crypto';
import { type SearchHeaderHandle } from '../../../src/components/SearchHeader';
import { RecentFilterPills } from '../../../src/components/RecentFilterPills';
import { useNativeAccessoryActive } from '../../../src/hooks/use-bottom-accessory';
import { useBottomChromeMetrics } from '../../../src/hooks/use-bottom-chrome-metrics';
import { useGrades } from '../../../src/lib/graphql/hooks';
import { useGradeFormat } from '../../../src/hooks/use-grade-format';
import { useLastUsedGrade } from '../../../src/hooks/use-last-used-grade';
import { useClimbListPlaylistMemberships } from '../../../src/hooks/use-climb-list-playlist-memberships';
import { useInfiniteSearchClimbs } from '../../../src/lib/graphql/hooks/use-infinite-search-climbs';
import { offlineAwareRequest } from '../../../src/lib/graphql/offline-request';
import { isOfflineSearchSupported } from '../../../src/db/queries/search-climbs-local';
import { useIsOffline } from '../../../src/hooks/use-is-offline';
import { useOfflineCatalogState } from '../../../src/offline/use-offline-catalog-state';
import { OfflineCatalogCta } from '../../../src/components/offline/OfflineCatalogCta';
import { SEARCH_CLIMBS, type SearchClimbsQueryResponse } from '../../../src/lib/graphql/operations';
import { usePlaylistActivation } from '../../../src/lib/playlists/use-playlist-activation';
import { toQueueClimb, toQueueClimbs } from '../../../src/lib/climb-types';
import {
  buildScreenshotWallSeed,
  publishScreenshotWallClimbs,
} from '../../../src/lib/board-presence/screenshot-wall-seed';
import { resolveScreenshotBoard } from '../../../src/lib/screenshot-board-selection';
import { useScreenshotBoards } from '../../../src/hooks/use-screenshot-boards';
import { parseSetIdsParam, prewarmCreateBoardHolds } from '../../../src/lib/create-board-holds';
import { useActiveBoard, useSetActiveBoard } from '../../../src/lib/graphql/use-active-board';
import { OnboardingTipBanner } from '../../../src/components/onboarding/OnboardingTipBanner';
import {
  clearBoardRevealTipPending,
  hasBoardRevealTipPending,
  hasSeenTip,
  markTipSeen,
} from '../../../src/lib/onboarding/onboarding-storage';
import { ONBOARDING_TIP_QUICKACTIONS_KEY } from '@boardsesh/key-value-storage';
import { useClimbQuickActionsButton } from '../../../src/lib/climb-quick-actions-button-preference';
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
import { timing } from '../../../src/theme/animations';

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

// Filters that have a dedicated facet chip in the persistent chip row. They are
// excluded from the removable token row so an active filter is never worded
// twice — the chip shows/changes it, the token row is the receipt for the
// long-tail (sheet-only) filters that have no chip.

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
  // Screenshot mode opens the first climb's board view via this deep-link param
  // (see the auto-open effect below). Absent on the plain `/climbs` list shot.
  // screenshotBoardIndex picks which followed board to render (default [0]); the
  // second board-view shot passes 1 to render myBoards[1].
  // screenshotOpenPreview / screenshotOpenWallPreview land the same first climb
  // in the drawer's two wall-state shots — browsing, and on the wall.
  const {
    screenshotOpenFirst,
    screenshotBoardIndex,
    screenshotOpenBoardSheet,
    screenshotOpenPreview,
    screenshotOpenWallPreview,
  } = useLocalSearchParams<{
    screenshotOpenFirst?: string;
    screenshotBoardIndex?: string;
    screenshotOpenBoardSheet?: string;
    screenshotOpenPreview?: string;
    screenshotOpenWallPreview?: string;
  }>();
  const { t } = useTranslation('climbs');
  const { t: tCommon } = useTranslation('common');
  const { openClimbActions, openAddToPlaylist, openBoardSheet, openPlayDrawer, usesDetailPane } = useDrawerHost();
  const [lightOnClimbTap] = useSetting('lightOnClimbTap');
  // One-time board-history reveal: armed when the user binds a board from the
  // onboarding hand-off and consumed on focus (see the useFocusEffect below).
  // Declared here so handleOpenBoardDetail can clear it — tapping the board
  // button dismisses the badge + banner once the cue has done its job.
  const [revealTipVisible, setRevealTipVisible] = useState(false);
  // The board capsule opens the wall's "now on the wall" sheet (the board
  // switcher lives inside it).
  const handleOpenBoardDetail = useCallback(() => {
    openBoardSheet();
    setRevealTipVisible(false);
  }, [openBoardSheet]);
  const { systemColors, variant, brandColors, features } = useTheme();
  const colorScheme = useAppColorScheme();
  // The ⋮ quick-actions button is a user setting that defaults on (More → Display
  // lets climbers turn it off).
  const { enabled: quickActionsButtonEnabled } = useClimbQuickActionsButton();
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
  // The user's pinned chips: which filter controls appear in the persistent chip
  // row (defaults reproduce today's set). Drives both the chip row and the token
  // "receipt" dedup below.
  const { pinned: pinnedChips } = usePinnedChips();
  const { lastUsedGrade, rememberGrade } = useLastUsedGrade();
  const { getLogbook } = useBoardActions();
  const searchHeaderRef = useRef<SearchHeaderHandle>(null);
  const nativeSearchRef = useRef<NativeSearchBarRef>(null);
  const visibleSearchTextRef = useRef('');
  const insets = useSafeAreaInsets();
  const bottomChrome = useBottomChromeMetrics();

  // iOS 26 uses the native tab-bar bottom accessory for current climb + tick, and
  // presents this screen's headerSearchBarOptions controller in the bottom tab
  // bar's search role — there is no header search bar. Fallback devices keep the
  // custom search field inside the top chrome.
  const useNativeSearch = useNativeAccessoryActive();

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
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  // Only the recent-filter pills read this, and they only ever show in native
  // (iOS-26) search. A boolean lets React's same-value bailout swallow
  // keystrokes 2..n; the setter is gated on `useNativeSearch` so Android — where
  // the pills can never show — never re-renders the whole list per keystroke.
  const [searchTextEmpty, setSearchTextEmpty] = useState(true);
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

  const applyVisibleSearchText = useCallback(
    (text: string) => {
      if (useNativeSearch) setSearchTextEmpty(text.length === 0);
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
    },
    [useNativeSearch],
  );

  const handleSearchChange = useCallback(
    (text: string) => {
      const nextName = normalizeSearchName(text);
      visibleSearchTextRef.current = text;
      if (useNativeSearch) setSearchTextEmpty(nextName.length === 0);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        setName(nextName);
      }, SEARCH_DEBOUNCE_MS);
    },
    [setName, useNativeSearch],
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
    setSearchTextEmpty(true);
    setName('');
    nativeSearchRef.current?.clearText();
  }, [setName]);

  // Composed for the filter sheet's in-line name field (#3606): mirror the raw
  // keystroke into the top bar/native search bar FIRST via applyVisibleSearchText
  // (silent — doesn't re-enter this same handler), THEN run handleSearchChange's
  // normal normalize+debounce+commit path, whose ref/state writes run second and
  // so win. Without the mirror call first, the top bar's own resync effect (see
  // the visibleSearchTextNeedsSync effect above) would see visibleSearchTextRef
  // already in lockstep with the sheet's typing and skip re-seeding the top bar's
  // actual TextInput/native field, leaving it visually stale.
  const handleSheetNameChange = useCallback(
    (text: string) => {
      // ORDER MATTERS — see the comment above: mirror the raw text first, THEN
      // let handleSearchChange's normalized write win by running second.
      // Swapping these two lines silently regresses the top-bar mirror.
      applyVisibleSearchText(text);
      handleSearchChange(text);
    },
    [applyVisibleSearchText, handleSearchChange],
  );

  // The ONE clearing path for name, shared by the filter sheet's Reset button and
  // its inline × (#3606) — mirrors handleNativeSearchCancel's clearing sequence
  // but deliberately does NOT touch setShowFilters: Reset must not close the sheet.
  const handleClearName = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    visibleSearchTextRef.current = '';
    setName('');
    applyVisibleSearchText('');
  }, [applyVisibleSearchText, setName]);

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
  const showRevealTip = revealTipVisible && !!activeBoard;

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
  const showQuickActionsTip = quickActionsTipArmed && !showRevealTip;
  useEffect(() => {
    if (showQuickActionsTip) void markTipSeen(ONBOARDING_TIP_QUICKACTIONS_KEY);
  }, [showQuickActionsTip]);

  // Screenshot mode: a second board-view shot renders a different wall via
  // ?screenshotBoardIndex=1 — slot 1 of SCREENSHOT_BOARDS, resolved by name so it
  // stays the same board as the account's follows change. The auto-activator sets
  // slot 0 on boot for every other shot. All of this dead-strips in normal builds
  // (the gate is inlined).
  const setActiveBoard = useSetActiveBoard();
  const screenshotBoards = useScreenshotBoards(isAuthenticated && !!screenshotBoardIndex);
  const screenshotTargetBoard = useMemo(() => {
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1' || !screenshotBoardIndex) return null;
    const index = Number.parseInt(screenshotBoardIndex, 10);
    if (!Number.isInteger(index) || index < 0) return null;
    return resolveScreenshotBoard(screenshotBoards, index);
  }, [screenshotBoardIndex, screenshotBoards]);

  const boardName = activeBoard?.boardType ?? '';
  const layoutId = activeBoard?.layoutId ?? 0;
  const sizeId = activeBoard?.sizeId ?? 0;
  const setIds = activeBoard?.setIds ?? '';
  const angle = activeBoard?.angle ?? 0;

  const hasBoardConfig = !!activeBoard;

  // Reactive connectivity, for the offline-only empty state below.
  const isOffline = useIsOffline();
  // 'missing' (offer the download) vs 'queued' (already asked for) vs null.
  const offlineCatalog = useOfflineCatalogState(activeBoard);

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
        if (cancelled) return;
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
    let task: ReturnType<typeof InteractionManager.runAfterInteractions> | null = null;
    const timeout = setTimeout(() => {
      task = InteractionManager.runAfterInteractions(() => {
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
    const task = InteractionManager.runAfterInteractions(() => {
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
    isError: isClimbsError,
    isFetchingNextPage,
    isRefetching,
    fetchNextPage,
    hasNextPage,
    refetch,
  } = useInfiniteSearchClimbs(searchInput, searchReady);
  const isLoadingMoreRef = useRef(false);

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
  }, [firstSearchPage, visibleClimbs, name, filters, boardFilters, boardName, layoutId, sizeId, setIds, angle]);

  // Feed the visible climb UUIDs into the shared logbook so the ascent badge
  // can render flash/send/attempt without baking per-user counts into the
  // (CDN-cacheable) search query. `getLogbook` is a noop when the user is
  // anonymous or the active board hasn't resolved yet.
  //
  // Deferred past the active fling via `runAfterInteractions`: the resulting
  // logbook merge re-renders every visible ascent-status glyph, so letting it
  // land after the scroll settles (instead of mid-fling) keeps those per-row
  // re-renders off the gesture's frames. The cleanup cancels a still-pending
  // callback when `visibleClimbs` changes again or the screen unmounts, so a
  // superseded snapshot never fires its `getLogbook`. (Network-level dedupe is
  // separate: `useLogbook`'s fetched-uuid set skips uuids already pulled.)
  useEffect(() => {
    if (visibleClimbs.length === 0) return;
    const handle = InteractionManager.runAfterInteractions(() => {
      void getLogbook(visibleClimbs.map((climb) => climb.uuid));
    });
    return () => handle.cancel();
  }, [visibleClimbs, getLogbook]);

  // Feed the playlist-membership store for the visible climbs so the optional
  // third-row playlist tags can render (gated inside the hook on the user
  // setting + auth). Memoize the uuid list so the fetch effect's dep is stable.
  const visibleClimbUuids = useMemo(() => visibleClimbs.map((climb) => climb.uuid), [visibleClimbs]);
  useClimbListPlaylistMemberships({ boardName, layoutId, climbUuids: visibleClimbUuids });

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
      // Same offline-aware source the list uses, so the play-drawer swipe keeps
      // paging climbs with no signal on a downloaded board.
      const response = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input });
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
      blurSearchInputs();
      if (!lightOnClimbTap) {
        // Board lighting off for taps: open view-only (the Browsing pill + the
        // commit row) instead of committing — same landing as the explicit
        // "Preview" climb action, so the tap doesn't light the board or touch
        // the queue until the climber puts it up.
        openPlayDrawer(climb, { previewQueueItem: climbToQueueItem(climb) });
        return;
      }
      void activateClimbListClimb.activate(toQueueClimb(climb));
    },
    [activateClimbListClimb, blurSearchInputs, lightOnClimbTap, openPlayDrawer],
  );

  // Screenshot mode: when a specific board index is requested, switch the active
  // board to it first; the open-first effect below waits until it's active.
  useEffect(() => {
    if (!screenshotTargetBoard || activeBoard?.uuid === screenshotTargetBoard.uuid) return;
    void setActiveBoard(screenshotTargetBoard);
  }, [screenshotTargetBoard, activeBoard, setActiveBoard]);

  // Screenshot mode: deterministically open the first climb's play drawer (the
  // board-view shot) instead of a Maestro coordinate tap, which can't match RN
  // rows on this iOS build and was capturing the climb list twice. Gated on the
  // deep-link param so the plain `/climbs` list shot is untouched; fires once the
  // board's results land. Keyed by the active board's uuid (not a one-shot bool)
  // so a SECOND board-view shot on a different board re-fires. Dead-strips in
  // normal builds.
  const screenshotOpenedForBoardRef = useRef<string | null>(null);
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1' || !screenshotOpenFirst) return;
    // When a specific board is requested, wait until it's the active board.
    if (screenshotTargetBoard && activeBoard?.uuid !== screenshotTargetBoard.uuid) return;
    if (!activeBoard || screenshotOpenedForBoardRef.current === activeBoard.uuid) return;
    const firstClimb = visibleClimbs[0];
    if (!searchReady || !firstClimb) return;
    screenshotOpenedForBoardRef.current = activeBoard.uuid;
    handleClimbPress(firstClimb);
  }, [screenshotOpenFirst, searchReady, visibleClimbs, handleClimbPress, screenshotTargetBoard, activeBoard]);

  // Screenshot mode, iPad master-detail only: the plain `/climbs` list shot must
  // also LIGHT the detail pane — with nothing selected it reads as a dead black
  // column in the App Store shot. Activating the first climb fills the pane
  // beside the list (and it stays lit for the later Home/Discover shots). Gated
  // on `usesDetailPane` because on iPhone the same activation opens the play
  // drawer OVER the list; every other capture that opens the first climb itself
  // (`screenshotOpenFirst`, and the two wall-state shots below) runs its own
  // activation, so this yields to all of them — otherwise it would COMMIT the
  // climb the wall-state shot then previews, collapsing the commit row out of
  // the frame. Dead-strips in normal builds.
  const screenshotPaneLitRef = useRef(false);
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1') return;
    if (screenshotOpenFirst || screenshotOpenPreview || screenshotOpenWallPreview) return;
    if (!usesDetailPane || screenshotPaneLitRef.current) return;
    if (!activeBoard || !searchReady) return;
    const firstClimb = visibleClimbs[0];
    if (!firstClimb) return;
    screenshotPaneLitRef.current = true;
    handleClimbPress(firstClimb);
  }, [
    screenshotOpenFirst,
    screenshotOpenPreview,
    screenshotOpenWallPreview,
    usesDetailPane,
    activeBoard,
    searchReady,
    visibleClimbs,
    handleClimbPress,
  ]);

  // Screenshot mode: deterministically open the board-presence "now on the wall"
  // sheet (the onboarding hero shot) once the active board resolves, instead of a
  // coordinate tap. Gated on the deep-link param so normal `/climbs` is untouched;
  // dead-strips in normal builds.
  const screenshotBoardSheetOpenedRef = useRef(false);
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1' || !screenshotOpenBoardSheet) return;
    if (!activeBoard || screenshotBoardSheetOpenedRef.current) return;
    screenshotBoardSheetOpenedRef.current = true;
    openBoardSheet();
  }, [screenshotOpenBoardSheet, activeBoard, openBoardSheet]);

  // Screenshot mode: seed the iPad "On the Wall" kiosk from this board's real
  // climbs (published to a module store the board-presence provider's seed client
  // serves). Reusing the same climbs the board-view shot lights guarantees the
  // seeded frames light the real holds for whatever board the capture user
  // follows — no board-specific hardcoded frames that would render dark. Runs on
  // the plain `/climbs` list (no deep-link param) so the seed is ready before the
  // flow reaches the wall tab; dead-strips in normal builds.
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1') return;
    if (!activeBoard || !searchReady || visibleClimbs.length === 0) return;
    publishScreenshotWallClimbs(buildScreenshotWallSeed(visibleClimbs, activeBoard.angle ?? null), null);
  }, [activeBoard, searchReady, visibleClimbs]);

  // Screenshot mode: open the first climb in one of the drawer's two wall-state
  // shots. `screenshotOpenPreview` is the browse latch — the Browsing pill, the
  // viewfinder brackets and the commit row — which is the same landing as the
  // "Preview" climb action. `screenshotOpenWallPreview` adds `previewIsWallClimb`
  // so the drawer says the displayed climb IS the lit one (the On-the-wall pill,
  // no commit to offer). Declared AFTER the wall-seed effect above so the kiosk
  // seed — which publishes this same first climb at index 0 — is already in the
  // module store when the drawer reads board presence for the driver's face.
  // Dead-strips in normal builds.
  const screenshotPreviewOpenedRef = useRef(false);
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1') return;
    if (!screenshotOpenPreview && !screenshotOpenWallPreview) return;
    if (screenshotTargetBoard && activeBoard?.uuid !== screenshotTargetBoard.uuid) return;
    if (!activeBoard || !searchReady || screenshotPreviewOpenedRef.current) return;
    const firstClimb = visibleClimbs[0];
    if (!firstClimb) return;
    screenshotPreviewOpenedRef.current = true;
    // The drawer only claims "Browsing" while a swipe genuinely stays view-only,
    // which for a preview with no suggestion source means lightOnSwipe off. The
    // capture device is a throwaway simulator, so writing the setting is the
    // honest way to reach the state — faking the chrome instead would ship a
    // store screenshot of a promise the app doesn't keep.
    if (screenshotOpenPreview) setSetting('lightOnSwipe', false);
    openPlayDrawer(firstClimb, {
      previewQueueItem: climbToQueueItem(firstClimb),
      previewIsWallClimb: Boolean(screenshotOpenWallPreview),
    });
  }, [
    screenshotOpenPreview,
    screenshotOpenWallPreview,
    screenshotTargetBoard,
    activeBoard,
    searchReady,
    visibleClimbs,
    openPlayDrawer,
  ]);

  const handleAddToQueue = useCallback(
    (climb: Climb) => {
      void addToQueue({ uuid: randomUUID(), climb });
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

  const handleGradeChange = useCallback(
    (next: GradeBound) => {
      setGrade(next);
    },
    [setGrade],
  );

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

  // Recent-filter pills live in the list header on search focus — only meaningful
  // with native search (the custom in-chrome field sits behind a scrim/keyboard,
  // so the list header isn't reachable while typing).
  const showRecentPills = useNativeSearch && isSearchFocused && searchTextEmpty && recentFilters.length > 0;
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
  // Collection — Benchmarks (board filter) + My drafts (status), mutually
  // exclusive. Sets one, clears the other; only a lingering 'drafts' status is
  // cleared (projects/Unrepeated lives in Popularity and can coexist).
  const handleChangeCollection = useCallback(
    (value: CollectionFilter) => {
      patchBoardFilters({ onlyBenchmarks: value === 'benchmarks' || undefined });
      if (value === 'drafts') patchFilters(applyStatusChange(filters, 'drafts'));
      else if (filters.status === 'drafts') patchFilters(applyStatusChange(filters, 'any'));
    },
    [patchBoardFilters, patchFilters, filters],
  );
  // --- Tier-2 (opt-in) chip handlers — mirror the filter sheet's own controls so
  // a chip and the sheet never diverge. ---
  // Sort: picking Random reseeds a fresh shuffle (matches the sheet); every other
  // key clears the seed. Direction (asc/desc) stays a sheet-only refinement.
  const handleChangeSort = useCallback(
    (value: SortOption) =>
      patchFilters(
        value === 'random' ? { sortBy: value, sortSeed: newSortSeed() } : { sortBy: value, sortSeed: undefined },
      ),
    [patchFilters],
  );
  const handleChangeAccuracy = useCallback(
    (value: GradeAccuracyValue | 'off') => patchFilters({ gradeAccuracy: value === 'off' ? undefined : value }),
    [patchFilters],
  );
  // Climb type — same three-way mapping as the sheet's handleClimbTypeChange.
  const handleChangeClimbType = useCallback(
    (value: ClimbTypeFilter) => {
      if (value === 'routes') patchFilters({ boulders: false, routes: true });
      else if (value === 'both') patchFilters({ boulders: true, routes: true });
      else patchFilters({ boulders: true, routes: false });
    },
    [patchFilters],
  );
  const handleToggleBeta = useCallback(
    () => patchFilters({ onlyWithBetaVideos: filters.onlyWithBetaVideos ? undefined : true }),
    [patchFilters, filters.onlyWithBetaVideos],
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
  // the server filter). Tap toggles the filter.
  const { hasShorter: showTallChip, hasNarrower: showWideChip } = getTallWideScope(
    boardName as BoardName,
    layoutId,
    sizeId,
  );
  const dimensionChips = useMemo<DimensionChip[]>(() => {
    const chips: DimensionChip[] = [];
    if (showTallChip) {
      chips.push({
        key: 'tall',
        active: !!filters.onlyTallClimbs,
        onToggle: () => patchFilters({ onlyTallClimbs: filters.onlyTallClimbs ? undefined : true }),
      });
    }
    if (showWideChip) {
      chips.push({
        key: 'wide',
        active: !!filters.onlyWideClimbs,
        onToggle: () => patchFilters({ onlyWideClimbs: filters.onlyWideClimbs ? undefined : true }),
      });
    }
    return chips;
  }, [showTallChip, showWideChip, filters.onlyTallClimbs, filters.onlyWideClimbs, patchFilters]);
  // Token row = the receipt for the long tail only; a filter backed by a *pinned*
  // chip shows and clears itself there, so it's excluded to avoid wording it
  // twice. Derived from the user's pinned set so unpinning a chip re-surfaces its
  // filter as a removable token (and re-pinning removes the token). Tall/Wide are
  // chip-backed only when Shape is pinned AND the homewall size shows their chip.
  const chipBackedTokenKeys = useMemo(
    () => new Set<string>(pinnedChips.flatMap((kind) => chipKindToTokenKeys(kind))),
    [pinnedChips],
  );
  const sheetOnlyFilterTokens = useMemo(
    () =>
      filterTokens.filter((token) => {
        if (token.key === 'tall') return !(chipBackedTokenKeys.has('tall') && showTallChip);
        if (token.key === 'wide') return !(chipBackedTokenKeys.has('wide') && showWideChip);
        // The Sort chip only switches the sort KEY, never the direction. So keep the
        // sort token (its clear() resets both) whenever the direction is non-default —
        // else an ascending sort set in the sheet would be unclearable from the row.
        if (token.key === 'sort') {
          return !(chipBackedTokenKeys.has('sort') && filters.sortOrder === DEFAULT_CLIMB_FILTER_STATE.sortOrder);
        }
        return !chipBackedTokenKeys.has(token.key);
      }),
    [filterTokens, chipBackedTokenKeys, showTallChip, showWideChip, filters.sortOrder],
  );
  const filterChrome = useMemo(() => {
    if (!showFilterChips) return null;
    return (
      <>
        <FilterChipRow
          pinnedChips={pinnedChips}
          activeFilterCount={activeFilterCount}
          onOpenFilters={handleOpenFilters}
          recentFilters={recentFilters}
          currentFilters={filters}
          currentSearchText={name}
          onApplyRecent={handleApplyRecentFilter}
          onClearRecent={handleClearRecentFilters}
          gradeLabel={gradeChip.label}
          gradeActive={gradeChip.active}
          onOpenGrade={handleOpenGrade}
          gradeRailOpen={showGrade}
          onCloseGrade={handleDismissGrade}
          dimensionChips={dimensionChips}
          minAscents={filters.minAscents}
          onChangePopularity={handleChangePopularity}
          minRating={filters.minRating}
          onChangeRating={handleChangeRating}
          progress={flagsToProgress(filters)}
          onChangeProgress={handleChangeProgress}
          canFilterProgress={isAuthenticated}
          collection={getCollectionFilter(filters, boardFilters)}
          onChangeCollection={handleChangeCollection}
          canFilterDrafts={isAuthenticated}
          sortBy={filters.sortBy}
          sortActive={sortActive}
          onChangeSort={handleChangeSort}
          accuracyValue={filters.gradeAccuracy ?? 'off'}
          onChangeAccuracy={handleChangeAccuracy}
          climbType={climbType}
          onChangeClimbType={handleChangeClimbType}
          betaActive={!!filters.onlyWithBetaVideos}
          onToggleBeta={handleToggleBeta}
        />
        <FilterTokenRow tokens={sheetOnlyFilterTokens} />
      </>
    );
  }, [
    showFilterChips,
    pinnedChips,
    activeFilterCount,
    handleOpenFilters,
    recentFilters,
    filters,
    name,
    handleApplyRecentFilter,
    handleClearRecentFilters,
    gradeChip,
    handleOpenGrade,
    showGrade,
    handleDismissGrade,
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
    sheetOnlyFilterTokens,
  ]);

  // Memoized so FlashList doesn't re-measure/re-render the header on every
  // ClimbListInner render — only when the title, pills, or filters change.
  const listHeader = useMemo(
    () => (
      <>
        {showRevealTip ? (
          <OnboardingTipBanner
            text={tCommon('mobile.onboarding.boardRevealTip')}
            icon="boards"
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
        {/* The filter summary now lives persistently in the floating chrome's
            centre (glass) / Appbar (Material), so the list itself opens straight
            into the recent-filter pills and climbs. */}
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
      showRevealTip,
      handleOpenBoardDetail,
      dismissRevealTip,
      showQuickActionsTip,
      dismissQuickActionsTip,
      tCommon,
      showRecentPills,
      recentFilters,
      filters,
      name,
      handleApplyRecentFilter,
      handleClearRecentFilters,
    ],
  );

  const listFooter = useMemo(
    () => (
      <View>
        {isFetchingNextPage ? <ClimbListSkeletonRows count={FOOTER_SKELETON_ROW_COUNT} /> : null}
        <Animated.View pointerEvents="none" style={listBottomSpacerStyle} />
      </View>
    ),
    [isFetchingNextPage, listBottomSpacerStyle],
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
        showPlaylistChips
        showMoreButton={quickActionsButtonEnabled}
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
      quickActionsButtonEnabled,
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
            // Plain board picker — this empty state is reachable any time the user
            // has no active board, not just first-run, so it must NOT tag the bind
            // as onboarding (which would fire the activation event + arm the
            // reveal banner outside the first-run hand-off).
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
  // A failed search counts as no connection, the same test the boards picker
  // makes (`isLocalOnly`, app/boards/index.tsx): on a captive portal or gym wifi
  // with a dead upstream `useIsOffline()` reads ONLINE, and offlineAwareRequest
  // rethrows once it finds nothing local to serve the search with — the exact
  // scenario these states exist for. Judging it by connectivity alone left that
  // user on the generic "no climbs" with no way out.
  const noUsableConnection = isOffline || isClimbsError;
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
    <View testID="climbs-screen" style={[styles.container, { backgroundColor: systemColors.background }]}>
      <Stack.Screen options={stackOptions} />
      <FlashList
        testID="climb-list"
        data={visibleClimbs}
        renderItem={renderClimbItem}
        keyExtractor={keyExtractor}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        // The header is transparent on every path now, so the chrome owns the top
        // inset and the list pads manually by the measured chrome height. Leaving
        // this 'automatic' would double-inset under the (invisible) native header.
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingTop: searchBarHeight }}
        scrollIndicatorInsets={{ top: searchBarHeight }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={handleRefresh} tintColor={brandColors.primary} />
        }
        ListHeaderComponent={listHeader}
        ListFooterComponent={listFooter}
        ListEmptyComponent={
          showInitialSkeletons ? (
            <ClimbListSkeletonRows count={INITIAL_SKELETON_ROW_COUNT} />
          ) : offlineFilterUnavailable ? (
            <View style={styles.emptyContainer}>
              <Icon name="offline.unavailable" size={48} color={iosSystemColors.systemGray4} />
              <Text variant="headline" style={styles.emptyTitle}>
                {t('mobile.emptyState.offlineFilter.title')}
              </Text>
              <Text variant="subheadline" style={styles.emptySubtitle}>
                {t('mobile.emptyState.offlineFilter.subtitle')}
              </Text>
              <Button
                title={t('mobile.emptyState.offlineFilter.cta')}
                variant="outlined"
                onPress={handleClearNonGradeFilters}
                style={styles.emptyCta}
              />
            </View>
          ) : offlineCatalogMissing ? (
            <View style={styles.emptyContainer}>
              <Icon name="offline.download" size={48} color={iosSystemColors.systemGray4} />
              <Text variant="headline" style={styles.emptyTitle}>
                {t('mobile.emptyState.offlineNoCatalog.title')}
              </Text>
              <Text variant="subheadline" style={styles.emptySubtitle}>
                {t('mobile.emptyState.offlineNoCatalog.subtitle')}
              </Text>
              <OfflineCatalogCta board={activeBoard} style={styles.emptyCta} />
            </View>
          ) : offlineCatalogQueued ? (
            <View style={styles.emptyContainer}>
              <Icon name="offline.download" size={48} color={iosSystemColors.systemGray4} />
              <Text variant="headline" style={styles.emptyTitle}>
                {t('mobile.emptyState.offlineCatalogQueued.title')}
              </Text>
              <Text variant="subheadline" style={styles.emptySubtitle}>
                {t('mobile.emptyState.offlineCatalogQueued.subtitle', { name: activeBoard?.name ?? '' })}
              </Text>
            </View>
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
        // With the chip row on, the active filters live in the token row and the
        // tab itself names the screen, so the centre title is dropped entirely —
        // the redundant "All climbs" label added nothing.
        title={showFilterChips ? undefined : searchTitle}
        canCreate={isAuthenticated && hasBoardConfig && getBoardCapabilities(boardName).climbCreation}
        onCreate={handleCreateClimb}
        onOpenBoardDetail={handleOpenBoardDetail}
        showBoardBadge={showRevealTip}
        onHeightChange={setSearchBarHeight}
        searchFieldRef={searchHeaderRef}
        searchInitialValue={name}
        searchPlaceholder={t('search.placeholders.climbs')}
        onSearchChange={handleSearchChange}
        onSearchFocus={handleSearchFocus}
        onSearchBlur={handleSearchBlur}
        onCloseGrade={handleDismissGrade}
        activeFilterCount={activeFilterCount}
        onOpenFilters={handleOpenFilters}
        filterSummary={filterSummaryProp}
        gradeBound={gradeBound}
        grades={grades}
        lastUsedGradeId={lastUsedGrade}
        gradeRailVisible={showGrade}
        gradeChip={gradeChip}
        onOpenGrade={handleOpenGrade}
        onGradeChange={handleGradeChange}
        filterChrome={filterChrome}
        showPersistentChips={filterInTopChrome}
      />

      {/* On Liquid Glass the Grade chip opens a top-anchored range rail +
          dismiss layer, just below the measured chrome. (Material renders its own
          grade rail inside ClimbTopChrome, so this glass-only overlay is gated on
          !filterInTopChrome.) */}
      {showFilterChips && !filterInTopChrome && showGrade ? (
        <>
          <Pressable
            style={styles.chipGradeDismiss}
            onPress={handleDismissGrade}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
          <View pointerEvents="box-none" style={[styles.chipGradeRailSlot, { top: searchBarHeight + spacing[2] }]}>
            <GradeRangeRail
              grades={grades}
              bound={gradeBound}
              lastUsedGradeId={lastUsedGrade}
              onChange={handleGradeChange}
              onRequestClose={handleDismissGrade}
              dismissible={false}
            />
          </View>
        </>
      ) : null}

      {showFilters ? (
        <ClimbFilterSheet
          onDismiss={handleDismissFilters}
          boardConfig={boardConfig}
          currentFilters={filters}
          currentBoardFilters={boardFilters}
          searchName={name}
          lastUsedGradeId={lastUsedGrade}
          onApply={handleApplyFilters}
          onNameChange={handleSheetNameChange}
          onClearName={handleClearName}
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
  // Top-anchored grade rail for the persistent chip row (the FAB's bottom rail
  // is suppressed when chips are on). The dismiss layer sits below the rail so a
  // tap outside closes it without stealing the rail's own touches.
  chipGradeDismiss: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 24,
  },
  chipGradeRailSlot: {
    position: 'absolute',
    left: spacing[4],
    right: spacing[4],
    zIndex: 25,
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
  revealBanner: {
    marginHorizontal: spacing[4],
    marginTop: spacing[2],
    marginBottom: spacing[2],
  },
});
