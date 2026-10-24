import { useCallback, useMemo, useRef, useState, useEffect, type ComponentRef, type SetStateAction } from 'react';
import { Platform, View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { BottomSheetModal, BottomSheetScrollView } from '@expo/ui/community/bottom-sheet';
import { useWindowBottomInset } from '../hooks/use-window-bottom-inset';
import { useSheetSubRoute } from '../hooks/use-sheet-sub-route';
import { useSheetKeyboardInset } from './sheet-keyboard-inset';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import {
  hasActiveClimbFilters,
  hasActiveBoardFilters,
  applyStatusChange,
  normalizeRetiredFilters,
  formatMinAscentsFilterCount,
  DEFAULT_CLIMB_BOARD_FILTER_STATE,
  countFilteredHolds,
  type SortOption,
  type SortOrder,
  type StatusFilter,
  type GradeAccuracyValue,
  type ClimbBoardFilterState,
  SORT_OPTIONS,
  GRADE_ACCURACY_VALUES,
  PROGRESS_FILTER_VALUES,
  flagsToProgress,
  progressToFlags,
  newSortSeed,
  sortKeyPatch,
  climbTypePatch,
  getClimbTypeFilter,
  type BoardSearchConfig,
  type ProgressFilter,
  type ClimbTypeFilter,
} from '@boardsesh/climb-filters';
import { Button } from './Button';
import { SheetTopBar } from './SheetTopBar';
import { SegmentedControl } from './SegmentedControl';
import { StarRating } from './StarRating';
import { SwitchRow } from './SwitchRow';
import { FilterSheetSection } from './filter-sheet/FilterSheetSection';
import { FilterLabelRow } from './filter-sheet/FilterLabelRow';
import { FilterChip, FilterChipGroup } from './filter-sheet/FilterChip';
import { FilterNameField } from './filter-sheet/FilterNameField';
import { FilterTappableRow } from './filter-sheet/FilterTappableRow';
import { RecentSearchRail } from './filter-sheet/RecentSearchRail';
import { filterSheetStyles } from './filter-sheet/filter-sheet-styles';
import { usePinnedChips } from '../lib/pinned-chips-store';
import type { RecentFilter } from '../lib/recent-filter-store';
import { applyRecentFilterById, findCurrentRecentFilter, type ApplyRecentFilter } from '../lib/recent-filter-selection';
import { PINNABLE_CHIP_KINDS, isValidChipKind, type FilterChipKind } from '../lib/pinnable-chips';
import { SPRAY_BOARD_NAME } from '../lib/spray/spray-wall-registry';
import { collectionPatch, getCollectionFilter, type CollectionFilter } from '../lib/collection-filter';
import type { SegmentOption } from './SegmentedControl.types';
import { useTheme } from '../providers/theme-provider';
import { useManagedSheet } from '../providers/sheet-presentation-provider';
import { androidSafeSnapPoints } from './sheet-snap-points';
import { useSheetColumnStyle } from './use-sheet-column-style';
import { useSheetDetentProbe } from './sheet-detent-probe';
import { useIosSheetBackgroundStyle } from './use-ios-sheet-background-style';
import { useGrades, useSearchClimbsCount } from '../lib/graphql/hooks';
import type { BoardName, HoldsFilter } from '@boardsesh/shared-schema';
import { getTallWideScope } from '@boardsesh/board-constants';
import { getBoardCapabilities } from '@boardsesh/board-config';
import { buildFilterLabels, formatSettersLabel, progressFilterLabel } from '../lib/filter-labels';
import { parseSetIdsParam, prewarmCreateBoardHolds } from '../lib/create-board-holds';
import { subscribeToHoldsFilterSelection } from '../lib/hold-filter-handoff';
import { subscribeToZoneFilterSelection, type ZoneFilterSelection } from '../lib/zone-filter-handoff';
import { subscribeToSetterFilterSelection, type SetterFilterHandoffOptions } from '../lib/setter-filter-handoff';
import { createFilterPickerHandoffId } from '../lib/filter-picker-handoff-id';
import { playlistSetterSourceParams } from '../lib/playlists/playlist-setter-source';
import type { PlaylistSetterSource } from '@boardsesh/playlists-react';
import { buildCountPreviewInput } from '../lib/climb-count-preview-input';
import { visibleSearchTextNeedsSync } from '../lib/search-name';
import { useAuth } from '../providers/auth-provider';
import { hapticSelection } from '../lib/haptics';
import { spacing } from '../theme/tokens';
import { GradeRangeRail } from './grade';
import type { ClimbFilters } from '../lib/climb-filter-types';
import { DEFAULT_FILTERS, statusForAuth } from '../lib/climb-filter-types';
import { NO_LOCKED_DIMENSIONS, withLockedDimensions, type LockedDimensions } from '../lib/dimension-chips';

export type { ClimbFilters };
export { DEFAULT_FILTERS };

/**
 * Which optional rows the sheet shows. Each defaults to on; the Climbs list uses
 * them all. A playlist hides Recent, the Collection's My drafts option and Other
 * angles. With no active board it also hides the rows whose filters need one:
 * Your progress (with My rating), the Collection's Liked option, Following, Hold
 * types, Board region and Beta videos. A smart list also hides the row its own
 * rows already pass (My rating on Five Stars). A hidden option still shows while
 * it is the active value, so it can be undone.
 */
export type ClimbFilterSheetSections = {
  recent?: boolean;
  drafts?: boolean;
  setters?: boolean;
  holds?: boolean;
  zone?: boolean;
  otherAngles?: boolean;
  progress?: boolean;
  /** My rating and "Only climbs I've rated", inside Your progress. */
  myRating?: boolean;
  liked?: boolean;
  following?: boolean;
  beta?: boolean;
};

/**
 * Where the Setters, Hold types and Board region rows push their routes, and
 * what those routes may offer. The routes push onto the stack the list lives in,
 * so Back from a picker returns to the list's sheet, never to another tab.
 *
 * - `climbs`: the Climbs stack. The Setters row lists the catalogue's setters on
 *   the board (`climbs/setters`), so it needs a board.
 * - `discover`: the Discover stack, for a list with setters of its own (a
 *   playlist, a smart list). The Setters row lists that list's setters
 *   (`discover/playlist-setters`) and works with no board: a setter filter reads
 *   every row.
 *
 * `heatmap: false` leaves the flame off Hold types: the heatmap counts the
 * board's catalogue, which is not what a playlist holds.
 */
export type ClimbFilterSheetPickers =
  | { stack: 'climbs'; heatmap: boolean }
  // `setterList` is the list whose setters the Discover setters picker shows;
  // null for a Discover page with no such list (a setter's own page, which
  // hides the Setters row).
  | { stack: 'discover'; heatmap: boolean; setterList: PlaylistSetterSource | null };

const CLIMBS_LIST_PICKERS: ClimbFilterSheetPickers = { stack: 'climbs', heatmap: true };

/** Each stack's picker routes. */
const PICKER_PATHS = {
  climbs: {
    setters: '/(tabs)/climbs/setters',
    holds: '/(tabs)/climbs/holds',
    zone: '/(tabs)/climbs/zone',
  },
  discover: {
    setters: '/(tabs)/discover/playlist-setters',
    holds: '/(tabs)/discover/holds',
    zone: '/(tabs)/discover/zone',
  },
} as const satisfies Record<ClimbFilterSheetPickers['stack'], Record<'setters' | 'holds' | 'zone', string>>;

/**
 * The pins of a list other than Climbs, which keeps its own pin store. Pass the
 * store's functions, not the store. A kind outside `pinnable` shows no pin.
 */
export type ClimbFilterSheetPins = {
  isPinned: (kind: FilterChipKind) => boolean;
  togglePin: (kind: FilterChipKind) => void;
  pinnable: readonly FilterChipKind[];
};

/**
 * A Sort section with the list's own keys and directions (a playlist's
 * "Playlist order", "Easiest first"), in place of the Climbs `SORT_OPTIONS` with
 * Descending / Ascending. The caller owns the sort; the sheet only shows it.
 */
export type FilterSortControl = {
  options: readonly { key: string; label: string }[];
  selected: string;
  /** The sort differs from the list's default: Reset has something to reset. */
  active: boolean;
  /** The two directions, the key's opening one first. Null hides the control (one-direction keys). */
  orderOptions: SegmentOption<SortOrder>[] | null;
  order: SortOrder;
  /** Shows "Shuffle again" (Random). */
  showReshuffle: boolean;
  onSelect: (key: string) => void;
  onOrderChange: (order: SortOrder) => void;
  onReshuffle: () => void;
};

/** "Fits my board": a playlist-only switch. Leave it out without an active board. */
export type ClimbFilterSheetBoardFit = {
  value: boolean;
  onChange: (value: boolean) => void;
};

const ALL_SECTIONS: Required<ClimbFilterSheetSections> = {
  recent: true,
  drafts: true,
  setters: true,
  holds: true,
  zone: true,
  otherAngles: true,
  progress: true,
  myRating: true,
  liked: true,
  following: true,
  beta: true,
};
const NO_RECENT_FILTERS: readonly RecentFilter[] = [];

export type ClimbFilterSheetProps = {
  onDismiss: () => void;
  boardConfig: BoardSearchConfig | null;
  currentFilters: ClimbFilters;
  currentBoardFilters: ClimbBoardFilterState;
  /** Current committed name term; seeds the name field and matching count. */
  searchName?: string;
  /** Last-used grade id; centres the grade rail on a familiar grade when unset. */
  lastUsedGradeId?: number;
  /** Commits a selection immediately without closing the sheet. */
  onSelectionChange: (filters: ClimbFilters, boardFilters: ClimbBoardFilterState) => void;
  /** Fired per keystroke as the in-sheet name field changes (mirrors into the
   *  parent's live search, same as the top-bar search field). Required: the sheet
   *  only owns the field's display state, so an unwired caller would render a name field that
   *  looks like it filters and doesn't. */
  onNameChange: (text: string) => void;
  /** Fired by Reset and the field's inline × — the ONE clearing path for name,
   *  shared so there is exactly one code path to reason about (#3606). Required
   *  for the same reason as `onNameChange`: without it, clearing would blank the
   *  field while the committed search term quietly survived. */
  onClearName: () => void;
  /** The saved searches, newest first, shown as chips under Recent. */
  recentFilters?: readonly RecentFilter[];
  /**
   * Puts a saved search in force: the same handler the toolbar's Recent menu
   * calls. The sheet stays open and follows the new search through its props.
   */
  onApplyRecent?: ApplyRecentFilter;
  /**
   * Tall/Wide dimensions whose chip-row lock is in force (iOS only; see
   * lib/dimension-chips.ts). Their switch shows on and is disabled, and the
   * selection keeps them set (including through Reset), so the matching count
   * agrees with the list.
   */
  lockedDimensions?: LockedDimensions;
  /** A list's own pins (see ClimbFilterSheetPins). Without it the Climbs pins apply. */
  pins?: ClimbFilterSheetPins;
  /** Optional rows to hide. Every row shows by default. */
  sections?: ClimbFilterSheetSections;
  /**
   * The list's own live match count, for a list the Climbs catalogue count
   * cannot answer (a playlist). When present the catalogue count query is off
   * and the subtitle reads this; a null count shows no subtitle.
   */
  liveCount?: { count: number | null };
  /** The list's starting filters: Reset's target and the baseline for "anything to reset". */
  defaultFilters?: ClimbFilters;
  /** Reset for a list that owns more than the filters (its sort, "Fits my board", the name). Replaces publishing the defaults. */
  onReset?: () => void;
  /** The list's own Sort section (see FilterSortControl). Without it the Climbs sorts show. */
  sortControl?: FilterSortControl;
  /** "Fits my board" (see ClimbFilterSheetBoardFit). */
  boardFit?: ClimbFilterSheetBoardFit;
  /** The board whose grades the rail lists, when it differs from `boardConfig` (none, on a playlist with no active board). */
  gradeBoardName?: string;
  /** The name field's placeholder. Defaults to the Climbs search placeholder. */
  namePlaceholder?: string;
  /** Where the picker rows push (see ClimbFilterSheetPickers). Defaults to the Climbs list's. */
  pickers?: ClimbFilterSheetPickers;
};

// The status enum is still driven from the sheet — "My drafts" (Your progress
// section) writes 'drafts', and "Unrepeated" (Popularity) writes 'projects' —
// but there's no longer a Status radio, so no UI option list is needed here.
// "established" stays retired: it's the "min ascents ≥ 2" lever, folded into the
// Popularity buckets; the enum value survives only for recent-filter replay.

// `statusForAuth` (in ../lib/climb-filter-types) coerces a persisted signed-out
// `drafts` status to `any` before rendering or publishing selections, so the
// sheet never shows signed-out draft controls or commits an invalid selection.

// Popularity buckets consolidate the old min-ascents chips + the "established"
// status into one control. undefined = Any; 2 = Established (≥2 ascents). The
// leading "Unrepeated" bucket (status='projects') is rendered separately.
const POPULARITY_BUCKETS: ReadonlyArray<number | undefined> = [undefined, 2, 10, 100, 1000];

// The sheet's single native detent. The iOS JS-side height bound derived from it
// lives in the shared useSheetColumnStyle hook (see the sheetColumnStyle below).
const SHEET_DETENT_FRACTION = 0.9;

// A presentation belongs to one board and angle. Late native closes and
// sub-picker results must not affect a search that replaced that scope.
function boardKeyOf(config: BoardSearchConfig | null): string | null {
  return config ? `${config.boardName}|${config.layoutId}|${config.sizeId}|${config.setIds}|${config.angle}` : null;
}

export function hasActiveFilters(filters: ClimbFilters): boolean {
  return hasActiveClimbFilters(filters);
}

export function ClimbFilterSheet({
  onDismiss,
  boardConfig,
  currentFilters,
  currentBoardFilters,
  searchName,
  lastUsedGradeId,
  onSelectionChange,
  onNameChange,
  onClearName,
  recentFilters = NO_RECENT_FILTERS,
  onApplyRecent,
  lockedDimensions = NO_LOCKED_DIMENSIONS,
  pins,
  sections,
  liveCount,
  defaultFilters = DEFAULT_FILTERS,
  onReset,
  sortControl,
  boardFit,
  gradeBoardName,
  namePlaceholder,
  pickers = CLIMBS_LIST_PICKERS,
}: ClimbFilterSheetProps) {
  const { t } = useTranslation('climbs');
  const theme = useTheme();
  const { systemColors } = theme;
  const iosBackgroundStyle = useIosSheetBackgroundStyle();
  const { isAuthenticated } = useAuth();
  // The WINDOW inset, not this mount point's: this sheet lives in the climbs
  // tab, whose per-tab provider folds the iOS 26 tab bar + accessory into
  // insets.bottom — chrome the sheet covers. Padding with that floated the old
  // Apply footer ~105pt up into the sheet (#3776's "dead gap"). It now pads the
  // end of the scroll body, so the last row scrolls clear of the home indicator.
  const windowInsetBottom = useWindowBottomInset();
  const sheetRef = useRef<BottomSheetModal>(null);
  const presentationBoardKeyRef = useRef(boardKeyOf(boardConfig));
  const boardKeyRef = useRef(boardKeyOf(boardConfig));
  boardKeyRef.current = boardKeyOf(boardConfig);
  // Native callbacks can arrive after unmount, or after a close already finished.
  const isMountedRef = useRef(true);
  const closingRef = useRef(false);
  const dismissedRef = useRef(false);
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const boardName = boardConfig?.boardName ?? '';
  const gradesBoardName = gradeBoardName ?? boardName;
  const { data: grades } = useGrades(gradesBoardName);
  const shownSections = useMemo(() => ({ ...ALL_SECTIONS, ...sections }), [sections]);
  // The three picker rows open routes and hand their picks back through the
  // handoff stores, addressed to this sheet: one id for the sheet's life, sent
  // with every push, so a picker opened from another sheet (a setter page's,
  // pushed over this suspended one) never writes into this one. A list that
  // hides all three rows skips that wiring.
  const showsPickerRows = shownSections.setters || shownSections.holds || shownSections.zone;
  const [handoffId] = useState(createFilterPickerHandoffId);
  const pickerPaths = PICKER_PATHS[pickers.stack];
  const heatmapOffered = pickers.heatmap;
  const setterList = pickers.stack === 'discover' ? pickers.setterList : null;
  // A list's own setters need no board; the catalogue's do.
  const settersRowNeedsBoard = setterList === null;
  const onResetRef = useRef(onReset);
  onResetRef.current = onReset;
  // A spray wall has no benchmarks and no routes: every climb on it is a
  // one-frame problem set by a climber (#5960). The two controls stay only while
  // they carry a non-default answer, so a filter picked on another board can
  // still be undone from here.
  const isSprayWall = boardName === SPRAY_BOARD_NAME;

  // The parent owns the committed selection. Refs also capture a just-published
  // change, so two handlers in one event never build on an older render.
  const selectedFilters = useMemo(
    () =>
      withLockedDimensions(statusForAuth(normalizeRetiredFilters(currentFilters), isAuthenticated), lockedDimensions),
    [currentFilters, isAuthenticated, lockedDimensions],
  );
  const selectedBoardFilters = currentBoardFilters;
  const selectedFiltersRef = useRef(selectedFilters);
  selectedFiltersRef.current = selectedFilters;
  const selectedBoardFiltersRef = useRef(selectedBoardFilters);
  selectedBoardFiltersRef.current = selectedBoardFilters;
  const normalizationRef = useRef({ isAuthenticated, lockedDimensions });
  normalizationRef.current = { isAuthenticated, lockedDimensions };

  // Only the name field keeps a display draft, matching the parent search bar's
  // debounce and preserving a trailing space while the climber types.
  const [nameDraft, setNameDraft] = useState(searchName ?? '');
  const nameDraftRef = useRef(nameDraft);
  nameDraftRef.current = nameDraft;
  // Resync the field from an external `searchName` change (board switch, recent
  // pill, cancel) — but ignore a trim-only difference, exactly like the parent's
  // own top-bar sync effect (packages/mobile/app/(tabs)/climbs/index.tsx), so a
  // mid-typing space isn't yanked out from under the cursor.
  useEffect(() => {
    if (!visibleSearchTextNeedsSync(nameDraftRef.current, searchName ?? '')) return;
    setNameDraft(searchName ?? '');
  }, [searchName]);
  const router = useRouter();

  const isCurrentPresentation = useCallback(
    () => isMountedRef.current && !dismissedRef.current && presentationBoardKeyRef.current === boardKeyRef.current,
    [],
  );
  // The sub-pickers (setters / holds / zone) are pushed routes, not stacked
  // sheets (native sheets can't stack above this one). While a sub-route is open
  // the sheet suspends (its native host dismisses without unmounting) and
  // re-presents under a fresh key, scroll restored, when the route pops. The
  // fresh key matters on iOS: re-presenting an already-mounted SwiftUI host loses
  // the detent height bound and the body stops scrolling (#3330).
  const subRoute = useSheetSubRoute<ComponentRef<typeof BottomSheetScrollView>>({
    canResume: isCurrentPresentation,
  });
  const { suspended, presentEpoch, isAwaitingReturn, suspend: beginSubPickerSuspend, cancelResume } = subRoute;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const detentSnapPoints = useMemo(() => [`${SHEET_DETENT_FRACTION * 100}%`], []);
  const snapPoints = useMemo(() => androidSafeSnapPoints(detentSnapPoints), [detentSnapPoints]);
  // On iOS the SwiftUI sheet host can propose an unbounded height, so a flex:1
  // column sizes to its CONTENT: the scroll body never overflows, so it never
  // scrolls, and the rows past the detent are unreachable (#3330). The shared
  // hook pins the column to this single detent's height; Android bounds the
  // column natively, so it keeps flex:1. This sheet stays on the raw native
  // sheet rather than ModalSheet because the sub-picker round trip restores
  // the scroll offset through its own scroll ref.
  const sheetColumnStyle = useSheetColumnStyle(detentSnapPoints);
  // The sheet mounts only while open, and has one detent: nothing to raise.
  const {
    keyboardOverlap,
    columnRef,
    onColumnLayout: measureColumnForKeyboard,
    onHostLayout,
  } = useSheetKeyboardInset({ enabled: true });
  // Dev-only observers for #3922 — they feed a log line, never layout. This is
  // the sheet #3776 was reported against, so it is the one to capture on an SE 3.
  const { probeProps, sentinelProps, onColumnLayout } = useSheetDetentProbe(sheetColumnStyle, 'ClimbFilterSheet');
  const handleColumnLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onColumnLayout?.(event);
      measureColumnForKeyboard();
    },
    [onColumnLayout, measureColumnForKeyboard],
  );
  // The scroll body ends against the bottom edge now that the footer is gone,
  // so it clears the window inset itself.
  const scrollContentStyle = useMemo(() => ({ paddingBottom: windowInsetBottom + spacing[4] }), [windowInsetBottom]);
  // Tall/Wide apply on any board whose active size has a shorter/narrower sibling
  // in its family (getTallWideScope — the shared source of truth the chip row and
  // server filter use), not just Kilter. Each toggle renders only where it applies,
  // so the sheet control stays reachable even when its chip is unpinned.
  const { hasShorter: showTallControl, hasNarrower: showWideControl } = boardConfig
    ? getTallWideScope(boardConfig.boardName as BoardName, boardConfig.layoutId, boardConfig.sizeId)
    : { hasShorter: false, hasNarrower: false };
  // Other angles — only where a climb belongs to the angle it was set at (Woods).
  // There the list keeps to the browsed angle unless the climber asks for the
  // rest; elsewhere a climb is not tied to one angle, so there is nothing to widen.
  const showOtherAnglesControl = shownSections.otherAngles && getBoardCapabilities(boardName).angleBoundClimbs;

  // Matching count for the committed selections.
  // Debounced so rapid chip/toggle taps — and now keystrokes in the name field —
  // don't each fire a count request. `name` rides along so an in-sheet name edit
  // is reflected in the preview the same way a chip/toggle edit is.
  const [debouncedEdits, setDebouncedEdits] = useState({
    filters: selectedFilters,
    boardFilters: selectedBoardFilters,
    name: nameDraft,
  });
  // Set by the sub-picker handoffs (setters / holds / zone). A handed-back result
  // is one discrete change, not a burst of taps, so the count input takes it at
  // once and the count is already loading (or cached) when the sheet re-presents.
  const flushPreviewRef = useRef(false);
  useEffect(() => {
    const nextEdits = { filters: selectedFilters, boardFilters: selectedBoardFilters, name: nameDraft };
    if (flushPreviewRef.current) {
      flushPreviewRef.current = false;
      setDebouncedEdits(nextEdits);
      return;
    }
    const handle = setTimeout(() => setDebouncedEdits(nextEdits), 250);
    return () => clearTimeout(handle);
  }, [selectedFilters, selectedBoardFilters, nameDraft]);
  // Built with the same helper the setters route uses for its own count, so both
  // screens share one React Query key for the same picks.
  const previewInput = useMemo(() => {
    if (!boardConfig) return null;
    return buildCountPreviewInput(
      debouncedEdits.filters,
      debouncedEdits.boardFilters,
      boardConfig,
      debouncedEdits.name,
    );
  }, [boardConfig, debouncedEdits]);
  // A list with its own live count turns the catalogue count off: it would
  // count the Climbs catalogue, not the list.
  const { data: catalogueCount } = useSearchClimbsCount(
    previewInput ?? { boardName: '', layoutId: 0, sizeId: 0, setIds: '', angle: 0 },
    liveCount === undefined && !!previewInput,
  );
  const previewCount = liveCount === undefined ? catalogueCount : liveCount.count;

  const sortLabels = useMemo<Record<SortOption, string>>(
    () => ({
      ascents: t('mobile.filter.sort.ascents'),
      quality: t('mobile.filter.sort.quality'),
      difficulty: t('mobile.filter.sort.difficulty'),
      name: t('mobile.filter.sort.name'),
      popular: t('mobile.filter.sort.popular'),
      creation: t('mobile.filter.sort.creation'),
      random: t('mobile.filter.sort.random'),
    }),
    [t],
  );

  const progressLabels = useMemo<Record<ProgressFilter, string>>(
    () =>
      PROGRESS_FILTER_VALUES.reduce(
        (labels, value) => {
          labels[value] = progressFilterLabel(value, t);
          return labels;
        },
        {} as Record<ProgressFilter, string>,
      ),
    [t],
  );

  const accuracyLabels = useMemo<Record<GradeAccuracyValue, string>>(
    () => ({
      '0': t('mobile.filter.accuracy.off'),
      '0.2': t('mobile.filter.accuracy.loose'),
      '0.1': t('mobile.filter.accuracy.moderate'),
      '0.05': t('mobile.filter.accuracy.tight'),
    }),
    [t],
  );

  const sortOrderOptions = useMemo(
    () => [
      { key: 'desc', label: t('mobile.filter.sortOrder.desc') },
      { key: 'asc', label: t('mobile.filter.sortOrder.asc') },
    ],
    [t],
  );

  const accuracyOptions = useMemo<Array<{ key: GradeAccuracyValue | 'off'; label: string }>>(
    () =>
      GRADE_ACCURACY_VALUES.map((value) => ({
        key: value === '0' ? 'off' : value,
        label: accuracyLabels[value],
      })),
    [accuracyLabels],
  );
  const filterLabels = useMemo(() => buildFilterLabels(t), [t]);
  const formatSetterSelection = useCallback(
    (setters: readonly string[]) => formatSettersLabel(setters, filterLabels, t),
    [filterLabels, t],
  );

  const popularityLabel = useCallback(
    (bucket: number | undefined): string => {
      if (bucket === undefined) return t('mobile.filter.anyAscents');
      if (bucket === 2) return t('mobile.filter.established2plus');
      return `${formatMinAscentsFilterCount(bucket)}+`;
    },
    [t],
  );

  const publishSelection = useCallback(
    (filters: ClimbFilters, boardFilters: ClimbBoardFilterState) => {
      if (!isCurrentPresentation() || closingRef.current) return;
      const { isAuthenticated: authenticated, lockedDimensions: locked } = normalizationRef.current;
      const nextFilters = withLockedDimensions(statusForAuth(normalizeRetiredFilters(filters), authenticated), locked);
      selectedFiltersRef.current = nextFilters;
      selectedBoardFiltersRef.current = boardFilters;
      onSelectionChangeRef.current(nextFilters, boardFilters);
    },
    [isCurrentPresentation],
  );

  const updateFilters = useCallback(
    (nextFilters: SetStateAction<ClimbFilters>) => {
      const filters = typeof nextFilters === 'function' ? nextFilters(selectedFiltersRef.current) : nextFilters;
      publishSelection(filters, selectedBoardFiltersRef.current);
    },
    [publishSelection],
  );

  const updateBoardFilters = useCallback(
    (nextBoardFilters: SetStateAction<ClimbBoardFilterState>) => {
      const boardFilters =
        typeof nextBoardFilters === 'function' ? nextBoardFilters(selectedBoardFiltersRef.current) : nextBoardFilters;
      publishSelection(selectedFiltersRef.current, boardFilters);
    },
    [publishSelection],
  );

  const setFiltersPatch = useCallback(
    (patch: Partial<ClimbFilters>) => {
      updateFilters((previous) => ({ ...previous, ...patch }));
    },
    [updateFilters],
  );

  // Per-keystroke: update the field's own display state immediately, and mirror
  // the raw text out to the parent (which commits it live via its own debounce —
  // name is independent of the filter selection, see `nameDraft` above).
  const handleNameTextChange = useCallback(
    (text: string) => {
      if (!isCurrentPresentation() || closingRef.current) return;
      nameDraftRef.current = text;
      setNameDraft(text);
      onNameChange(text);
    },
    [isCurrentPresentation, onNameChange],
  );

  // The ONE clearing path for name, shared by the inline × and Reset (#3606) —
  // clears the field's own display state and asks the parent to clear the
  // committed name + the top-bar/native-search-bar mirror.
  const handleClearNameField = useCallback(() => {
    if (!isCurrentPresentation() || closingRef.current) return;
    nameDraftRef.current = '';
    setNameDraft('');
    onClearName();
  }, [isCurrentPresentation, onClearName]);

  const handleSortByChange = useCallback(
    (sortBy: SortOption) =>
      // Tapping (or re-tapping) Random mints a fresh seed for a new shuffle;
      // any other sort clears the seed so it never lingers in the search input.
      setFiltersPatch(sortKeyPatch(sortBy)),
    [setFiltersPatch],
  );
  // Explicit reshuffle affordance (mirrors web's "Shuffle again" button) so a new
  // shuffle is discoverable without knowing that re-tapping the Random chip works.
  const handleReshuffle = useCallback(() => setFiltersPatch({ sortSeed: newSortSeed() }), [setFiltersPatch]);
  const handleSortOrderChange = useCallback(
    (sortOrder: string) => setFiltersPatch({ sortOrder: sortOrder as SortOrder }),
    [setFiltersPatch],
  );
  const handleStatusChange = useCallback(
    (status: StatusFilter) => {
      updateFilters((previous) => ({ ...previous, ...applyStatusChange(previous, status) }));
    },
    [updateFilters],
  );
  // Collection — a single-select over Benchmarks (board filter), My drafts
  // (status) and Liked (onlyFavorited), which are mutually exclusive. Selecting
  // one clears the other two (see collectionPatch).
  const handleCollectionChange = useCallback(
    (collection: CollectionFilter) => {
      const filters = selectedFiltersRef.current;
      const patch = collectionPatch(collection, filters);
      publishSelection({ ...filters, ...patch.filters }, { ...selectedBoardFiltersRef.current, ...patch.boardFilters });
    },
    [publishSelection],
  );
  const collectionFilter = getCollectionFilter(selectedFilters, selectedBoardFilters);
  const offerBenchmarks = !isSprayWall || collectionFilter === 'benchmarks';
  // A list that hides My drafts (a playlist) still offers it while it is the
  // active value, so a status carried in can be undone.
  const offerDrafts = shownSections.drafts || collectionFilter === 'drafts';
  const offerLiked = shownSections.liked || collectionFilter === 'liked';
  const showMyRating =
    shownSections.myRating || selectedFilters.minUserRating != null || !!selectedFilters.onlyRatedByMe;
  const collectionOptions = useMemo(
    () => [
      { key: 'any' as const, label: t('mobile.filter.collection.any') },
      ...(offerBenchmarks ? [{ key: 'benchmarks' as const, label: t('mobile.filter.benchmark') }] : []),
      // My drafts and Liked are auth-only: both are the climber's own climbs.
      ...(isAuthenticated && offerDrafts ? [{ key: 'drafts' as const, label: t('mobile.filter.drafts') }] : []),
      ...(isAuthenticated && offerLiked ? [{ key: 'liked' as const, label: t('mobile.filter.collection.liked') }] : []),
    ],
    [t, isAuthenticated, offerBenchmarks, offerDrafts, offerLiked],
  );
  const handlePopularity = useCallback(
    (bucket: number | undefined) => {
      // minAscents is mutually exclusive with projects/drafts at the DB layer
      // (createClimbFilters skips minAscents under projectsOnly; drafts drop all
      // stats conditions). "Unrepeated" (status='projects') now lives in the same
      // chip group, so any Any/numeric tap must clear projects too — else the two
      // would both apply, and the group wouldn't read as single-select. Clearing
      // 'projects' with an inline `status: 'any'` patch reproduces the old Status
      // radio's projects→any transition (applyStatusChange('any') = same fields).
      // Drafts is a separate switch now, so it's only cleared by a numeric bucket
      // (which drafts would render inert), never by tapping "Any".
      updateFilters((previous) => {
        const clearsProjects = previous.status === 'projects';
        const clearsDrafts = bucket != null && previous.status === 'drafts';
        return { ...previous, minAscents: bucket, ...(clearsProjects || clearsDrafts ? { status: 'any' } : {}) };
      });
    },
    [updateFilters],
  );
  const handleAccuracyChange = useCallback(
    (value: GradeAccuracyValue | 'off') => setFiltersPatch({ gradeAccuracy: value === 'off' ? undefined : value }),
    [setFiltersPatch],
  );
  const handleGradeChange = useCallback(
    (grade: { minGradeId: number | undefined; maxGradeId: number | undefined }) => {
      updateFilters((previous) => ({ ...previous, minGrade: grade.minGradeId, maxGrade: grade.maxGradeId }));
    },
    [updateFilters],
  );
  // Climb-type toggle (main's #2496 control). A 3-way control means there's no
  // UI path to "neither", so the never-both-off invariant is structural (see
  // toClimbSearchInput). "Both" = show everything; boulders-only is the default.
  // Same derivation as the chip row (getClimbTypeFilter) so they never disagree.
  const climbTypeKey = getClimbTypeFilter(selectedFilters, defaultFilters);
  // On a spray wall every climb is a boulder, so the control shows only while it
  // carries a real route filter to undo. Boulders, and a list's own resting
  // value (both, on a playlist), are the same neutral state there.
  const climbTypeIsNeutralOnSpray =
    climbTypeKey === 'boulders' || climbTypeKey === getClimbTypeFilter(defaultFilters, defaultFilters);
  const showClimbTypeControl = !isSprayWall || !climbTypeIsNeutralOnSpray;
  const handleClimbTypeChange = useCallback(
    (key: ClimbTypeFilter) => setFiltersPatch(climbTypePatch(key)),
    [setFiltersPatch],
  );
  const climbTypeOptions = useMemo<SegmentOption<ClimbTypeFilter>[]>(
    () => [
      { key: 'boulders', label: t('mobile.filter.climbType.boulders') },
      { key: 'routes', label: t('mobile.filter.climbType.routes') },
      { key: 'both', label: t('mobile.filter.climbType.all') },
    ],
    [t],
  );

  // All selections are committed already. Closing only waits for the native
  // animation before releasing the parent, and can never discard a last edit.
  const handleClose = useCallback(() => {
    if (!isCurrentPresentation() || closingRef.current || isAwaitingReturn()) return;
    closingRef.current = true;
    sheetRef.current?.dismiss();
  }, [isCurrentPresentation, isAwaitingReturn]);

  const handleSheetDismiss = useCallback(() => {
    if (!isCurrentPresentation() || isAwaitingReturn() || suspended) return;
    dismissedRef.current = true;
    closingRef.current = true;
    onDismissRef.current();
  }, [isCurrentPresentation, isAwaitingReturn, suspended]);

  // The parent mounts this sheet only while it should be open, so present/dismiss
  // route through the coordinator (serialized, no overlapping native
  // transitions). `open: !suspended` lets a sub-picker route dismiss the native
  // sheet without unmounting (a coordinator self-dismiss never fires `onClose`),
  // then re-present on return. `onClose` (handleSheetDismiss) clears the parent's
  // open state on a genuine user pan-down / backdrop.
  const managed = useManagedSheet({
    open: !suspended,
    sheetRef,
    onClose: handleSheetDismiss,
  });

  const handleReset = useCallback(() => {
    if (!isCurrentPresentation() || closingRef.current) return;
    hapticSelection();
    const resetList = onResetRef.current;
    if (resetList) {
      // The list resets everything it owns (filters, sort, name) in one go; the
      // field only drops its own draft.
      nameDraftRef.current = '';
      setNameDraft('');
      resetList();
      return;
    }
    // Publish both groups together so no query observes a half-reset selection.
    publishSelection(defaultFilters, DEFAULT_CLIMB_BOARD_FILTER_STATE);
    handleClearNameField();
  }, [isCurrentPresentation, publishSelection, handleClearNameField, defaultFilters]);

  // The Holds row is always visible now (no Refine accordion to expand), so
  // prewarm the create-board hold geometry as soon as the sheet is visible with
  // a board config — the sheet only mounts while it's open, so mount == visible.
  // Prewarming is an idempotent cache warm, so a re-run on boardConfig churn is
  // harmless. (Replaces the old expand-triggered PREWARM_..._AFTER_REFINE path.)
  useEffect(() => {
    if (!boardConfig || !showsPickerRows) return;
    prewarmCreateBoardHolds({
      boardName: boardConfig.boardName as BoardName,
      layoutId: boardConfig.layoutId,
      sizeId: boardConfig.sizeId,
      setIds: parseSetIdsParam(boardConfig.setIds),
    });
  }, [boardConfig, showsPickerRows]);

  // Each sub-picker opener starts with beginSubPickerSuspend: it snapshots the
  // scroll offset for the post-remount restore, then dismisses the native sheet
  // without unmounting (see useSheetSubRoute).
  const openSetters = useCallback(() => {
    if (!isCurrentPresentation() || isAwaitingReturn() || closingRef.current) return;
    const selectedSetters = JSON.stringify(selectedFiltersRef.current.setter ?? []);
    if (setterList) {
      beginSubPickerSuspend();
      router.push({
        pathname: pickerPaths.setters,
        params: { ...playlistSetterSourceParams(setterList), setters: selectedSetters, handoffId },
      });
      return;
    }
    // Discover's setters picker lists one list's setters; with no list there
    // is nothing for it to show, and the catalogue picker lives in Climbs.
    if (pickers.stack === 'discover') return;
    if (!boardConfig) return;
    beginSubPickerSuspend();
    router.push({
      pathname: pickerPaths.setters,
      params: {
        boardName: boardConfig.boardName,
        layoutId: String(boardConfig.layoutId),
        sizeId: String(boardConfig.sizeId),
        setIds: boardConfig.setIds,
        angle: String(boardConfig.angle),
        setters: selectedSetters,
        handoffId,
        // The current count input, so the route's "Show N climbs" button counts
        // the same search, with its own picks swapped in.
        // Read from the latest-selection refs so this callback stays stable across
        // name keystrokes and filter edits.
        countInput: JSON.stringify(
          buildCountPreviewInput(
            selectedFiltersRef.current,
            selectedBoardFiltersRef.current,
            boardConfig,
            nameDraftRef.current,
          ),
        ),
      },
    });
  }, [
    beginSubPickerSuspend,
    boardConfig,
    isAwaitingReturn,
    isCurrentPresentation,
    router,
    setterList,
    pickers.stack,
    pickerPaths,
    handoffId,
  ]);

  const openHoldFilter = useCallback(() => {
    if (!boardConfig || !isCurrentPresentation() || isAwaitingReturn() || closingRef.current) return;
    beginSubPickerSuspend();
    router.push({
      pathname: pickerPaths.holds,
      params: {
        boardName: boardConfig.boardName,
        layoutId: String(boardConfig.layoutId),
        sizeId: String(boardConfig.sizeId),
        setIds: boardConfig.setIds,
        angle: String(boardConfig.angle),
        holdsFilter: JSON.stringify(selectedBoardFiltersRef.current.holdsFilter ?? {}),
        handoffId,
        // The selection the heatmap counts over (it drops the hold picks itself).
        // Read from the latest-selection refs, like the setters route's count input.
        // A list the heatmap cannot describe sends none, and turns the flame off.
        ...(heatmapOffered
          ? {
              heatmapSearch: JSON.stringify({
                filters: selectedFiltersRef.current,
                boardFilters: selectedBoardFiltersRef.current,
                searchText: nameDraftRef.current,
              }),
            }
          : { heatmap: 'off' }),
      },
    });
  }, [
    beginSubPickerSuspend,
    boardConfig,
    isAwaitingReturn,
    isCurrentPresentation,
    router,
    pickerPaths,
    handoffId,
    heatmapOffered,
  ]);

  const openZoneFilter = useCallback(() => {
    if (!boardConfig || !isCurrentPresentation() || isAwaitingReturn() || closingRef.current) return;
    beginSubPickerSuspend();
    router.push({
      pathname: pickerPaths.zone,
      params: {
        boardName: boardConfig.boardName,
        layoutId: String(boardConfig.layoutId),
        sizeId: String(boardConfig.sizeId),
        setIds: boardConfig.setIds,
        angle: String(boardConfig.angle),
        zoneBox: JSON.stringify(selectedBoardFiltersRef.current.zoneBox ?? null),
        zoneMode: selectedBoardFiltersRef.current.zoneMode ?? 'allHolds',
        holdsFilter: JSON.stringify(selectedBoardFiltersRef.current.holdsFilter ?? {}),
        handoffId,
      },
    });
  }, [beginSubPickerSuspend, boardConfig, isAwaitingReturn, isCurrentPresentation, router, pickerPaths, handoffId]);

  // useSheetSubRoute re-presents the sheet when a sub-picker route pops (back
  // chevron OR swipe-back both re-focus this screen). The setters route's "Show N
  // climbs" button never gets there: its apply handoff commits the picks and
  // closes, so the parent unmounts this suspended sheet.

  const handleSelectedSettersChange = useCallback(
    (selectedSetters: string[], options: SetterFilterHandoffOptions) => {
      if (!isCurrentPresentation() || closingRef.current) return;
      flushPreviewRef.current = true;
      const setter = selectedSetters.length > 0 ? selectedSetters : undefined;
      updateFilters((previous) => ({ ...previous, setter }));
      if (options.apply) {
        // The route's existing "Show N climbs" affordance means return to the
        // list. Selection is already committed; the suspended sheet needs no
        // second commit or native close, and must not re-present on focus.
        cancelResume();
        dismissedRef.current = true;
        closingRef.current = true;
        onDismissRef.current();
      }
    },
    [cancelResume, isCurrentPresentation, updateFilters],
  );

  const handleHoldsFilterChange = useCallback(
    (holdsFilter: HoldsFilter) => {
      if (!isCurrentPresentation() || closingRef.current) return;
      flushPreviewRef.current = true;
      updateBoardFilters((previous) => ({
        ...previous,
        holdsFilter: Object.keys(holdsFilter).length > 0 ? holdsFilter : undefined,
      }));
    },
    [isCurrentPresentation, updateBoardFilters],
  );

  const handleZoneFilterChange = useCallback(
    (selection: ZoneFilterSelection) => {
      if (!isCurrentPresentation() || closingRef.current) return;
      flushPreviewRef.current = true;
      updateBoardFilters((previous) => {
        const nextBoardFilters: ClimbBoardFilterState = {
          ...previous,
          zoneBox: selection.zoneBox,
          zoneMode: selection.zoneBox ? selection.zoneMode : undefined,
        };
        if (selection.holdsFilter !== undefined) {
          nextBoardFilters.holdsFilter =
            Object.keys(selection.holdsFilter).length > 0 ? selection.holdsFilter : undefined;
        }
        return nextBoardFilters;
      });
    },
    [isCurrentPresentation, updateBoardFilters],
  );

  // The setter / hold / zone sub-pickers are pushed routes; each hands its result
  // back through these handoffs when it pops (focus-cleanup), committing the
  // picks immediately. The setters route can also ask to return to the list.
  // Kept subscribed while the sheet is suspended so results still arrive with
  // the route on top. Only results addressed to this sheet's id arrive.
  useEffect(() => {
    if (!showsPickerRows) return;
    const unsubscribeSetters = subscribeToSetterFilterSelection(handoffId, handleSelectedSettersChange);
    const unsubscribeHolds = subscribeToHoldsFilterSelection(handoffId, handleHoldsFilterChange);
    const unsubscribeZone = subscribeToZoneFilterSelection(handoffId, handleZoneFilterChange);
    return () => {
      unsubscribeSetters();
      unsubscribeHolds();
      unsubscribeZone();
    };
  }, [showsPickerRows, handoffId, handleSelectedSettersChange, handleHoldsFilterChange, handleZoneFilterChange]);

  const holdFilterCount = countFilteredHolds(selectedBoardFilters.holdsFilter);
  const zoneActive = selectedBoardFilters.zoneBox != null;

  // Value-based chip handlers, stable across renders, so the memoised chips only
  // re-render when their own selected state flips.
  const handleProgressChange = useCallback(
    (progress: ProgressFilter) => setFiltersPatch(progressToFlags(progress)),
    [setFiltersPatch],
  );
  const handleClearMyRating = useCallback(() => setFiltersPatch({ minUserRating: undefined }), [setFiltersPatch]);
  const handleClearMinRating = useCallback(() => setFiltersPatch({ minRating: undefined }), [setFiltersPatch]);

  // Each pin toggles its control's chip in the list's chip row: the climbs row
  // unless the list passes its own pins. One stable callback per kind, so a pin
  // tap re-renders only the label rows. A kind the list cannot pin gets none.
  const { isPinned: isClimbPinned, togglePin: toggleClimbPin } = usePinnedChips();
  const pinToggles = useMemo(() => {
    const toggles = new Map<FilterChipKind, () => void>();
    if (pins) for (const kind of pins.pinnable) toggles.set(kind, () => pins.togglePin(kind));
    else for (const kind of PINNABLE_CHIP_KINDS) toggles.set(kind, () => toggleClimbPin(kind));
    return toggles;
  }, [pins, toggleClimbPin]);
  const pinProps = (kind: FilterChipKind) => {
    const onTogglePin = pinToggles.get(kind);
    if (!onTogglePin) return {};
    const pinned = pins ? pins.isPinned(kind) : isValidChipKind(kind) && isClimbPinned(kind);
    return { pinned, onTogglePin };
  };

  // The saved searches under Recent, applied the way the toolbar's Recent menu
  // applies them. Stable while the history and handler are, so a chip only
  // re-renders when its own current state flips.
  const handleSelectRecent = useCallback(
    (id: string) => {
      if (onApplyRecent) applyRecentFilterById(recentFilters, id, onApplyRecent);
    },
    [recentFilters, onApplyRecent],
  );
  const currentRecentId = findCurrentRecentFilter(recentFilters, currentFilters, searchName ?? '')?.id;

  const trackColor = systemColors.fill;
  const accuracyValue: GradeAccuracyValue | 'off' = selectedFilters.gradeAccuracy ?? 'off';
  const followingSwitch = (
    <SwitchRow
      label={t('authors.followingClimbs')}
      value={!!selectedFilters.onlyFollowedAuthors}
      onValueChange={(enabled) => setFiltersPatch({ onlyFollowedAuthors: enabled || undefined })}
    />
  );
  // Reset greys out until there's actually something to reset.
  // The name counts as something to reset (#3606): it lives outside
  // ClimbFilters, so neither hasActive* helper can see it, and a lone climb-name
  // search — the issue's own repro — would otherwise leave Reset disabled with
  // the one thing the user wants gone still on screen. Same `.length > 0` rule
  // as the inline × below, so the two clear affordances appear together. A
  // list's own sort and "Fits my board" count too.
  const anyActive =
    hasActiveClimbFilters(selectedFilters, defaultFilters) ||
    hasActiveBoardFilters(selectedBoardFilters) ||
    nameDraft.length > 0 ||
    !!sortControl?.active ||
    !!boardFit?.value;

  return (
    <BottomSheetModal
      key={presentEpoch}
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      enableDynamicSizing={false}
      enablePanDownToClose
      onChange={managed.onChange}
      onFullyDismissed={managed.onFullyDismissed}
      handleIndicatorStyle={[styles.indicator, { backgroundColor: systemColors.separator }]}
      backgroundStyle={iosBackgroundStyle}
    >
      {/* #3922 instrumentation, dev builds only. The sentinel is in-flow but
          zero-height and the probe is absolutely positioned, so neither adds
          anything to the wrapper's content size — the one-in-flow-child rule
          below still holds. */}
      {sentinelProps ? <View {...sentinelProps} /> : null}
      {probeProps ? <View {...probeProps} /> : null}
      {Platform.OS === 'ios' ? (
        <View
          testID="sheet-keyboard-host"
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
          onLayout={onHostLayout}
        />
      ) : null}
      {/* One column child bounded to the detent height (JS-computed on iOS, see
          sheetColumnStyle) — the scroll body then actually scrolls. Handed
          multiple direct children, the native sheet sizes to content and the
          flex:1 ScrollView collapses (no scrolling). The column is padded by
          the keyboard overlap, as in ModalSheet: the padding keeps the scroll body, and
          the name field in it, above it (see sheet-keyboard-inset.ts). */}
      <View
        testID="climb-filter-column"
        style={keyboardOverlap > 0 ? [sheetColumnStyle, { paddingBottom: keyboardOverlap }] : sheetColumnStyle}
        ref={columnRef}
        onLayout={handleColumnLayout}
      >
        <SheetTopBar
          title={t('mobile.filter.title')}
          subtitle={previewCount != null ? t('mobile.filter.matchingCount', { count: previewCount }) : undefined}
          leading={{ kind: 'close', onPress: handleClose, accessibilityLabel: t('mobile.filter.close') }}
          trailing={{ kind: 'forward', label: t('mobile.filter.reset'), onPress: handleReset, disabled: !anyActive }}
        />

        <BottomSheetScrollView
          ref={subRoute.scrollRef}
          style={styles.scrollView}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={scrollContentStyle}
          onScroll={subRoute.onScroll}
          scrollEventThrottle={32}
          onContentSizeChange={subRoute.onContentSizeChange}
          // This sheet never hosted a text input before the name field below —
          // without this, a first tap on Close/Reset/another row while the
          // keyboard is up over the field can be swallowed (standard RN
          // ScrollView gotcha; the tap dismisses the keyboard instead of firing).
          keyboardShouldPersistTaps="handled"
        >
          {/* Flat, labeled sections — no accordions. The scroll body is one column
              child (filterSheetStyles.body) so the native sheet scrolls. */}
          <View style={filterSheetStyles.body}>
            {/* 1 · NAME — climb-name search term, first row so Reset has something
                visible to reset (#3606). Committed live via onNameChange/onClearName,
                same as the top-bar search field. */}
            <FilterSheetSection title={t('mobile.filter.section.name')} first>
              <FilterNameField
                value={nameDraft}
                onChangeText={handleNameTextChange}
                onClear={handleClearNameField}
                placeholder={namePlaceholder ?? t('search.placeholders.climbs')}
                accessibilityLabel={t('mobile.filter.section.name')}
              />
              {/* Recent: the saved searches as chips, a tap applies one. The
                  row and its pin (the toolbar Recent chip's) show with no
                  history too, with a line saying where searches will appear. */}
              {shownSections.recent ? (
                <>
                  <View style={filterSheetStyles.subsectionGap} />
                  <FilterLabelRow
                    label={t('mobile.search.recentFilters')}
                    description={recentFilters.length > 0 ? undefined : t('mobile.filter.recentDescription')}
                    {...pinProps('recent')}
                  />
                  {recentFilters.length > 0 ? (
                    <RecentSearchRail
                      recents={recentFilters}
                      currentId={currentRecentId}
                      onSelect={handleSelectRecent}
                      style={filterSheetStyles.inlineRail}
                    />
                  ) : null}
                </>
              ) : null}
            </FilterSheetSection>

            {/* 2 · DIFFICULTY — grade bound + grade accuracy. */}
            <FilterSheetSection title={t('mobile.filter.section.difficulty')}>
              {/* The inline grade rail updates the live selection. Its own title
                is replaced by a pinnable label row. */}
              <FilterLabelRow label={t('mobile.filter.gradeRange')} {...pinProps('grade')} />
              <GradeRangeRail
                grades={grades ?? []}
                bound={{ minGradeId: selectedFilters.minGrade, maxGradeId: selectedFilters.maxGrade }}
                lastUsedGradeId={lastUsedGradeId}
                boardName={gradesBoardName}
                onChange={handleGradeChange}
                style={filterSheetStyles.inlineRail}
              />

              <View style={filterSheetStyles.subsectionGap} />
              <FilterLabelRow
                label={t('mobile.filter.accuracy.label')}
                description={t('mobile.filter.accuracy.description')}
                {...pinProps('accuracy')}
              />
              <View style={filterSheetStyles.controlGap} />
              <SegmentedControl
                options={accuracyOptions}
                selectedKey={accuracyValue}
                onSelect={handleAccuracyChange}
                accessibilityLabel={t('mobile.filter.accuracy.label')}
              />
            </FilterSheetSection>

            {/* 3 · YOUR PROGRESS — auth-only; the per-user tick-flag selector plus
                the "My drafts" toggle (old Status 'drafts', with its side-effects). */}
            {isAuthenticated && shownSections.progress ? (
              <FilterSheetSection title={t('mobile.filter.progress.label')} {...pinProps('progress')}>
                {/* A single-select over the four per-user tick flags. "Projects" =
                  attempted-but-not-sent; "Unsent" = the old "hide climbs I've sent". */}
                <FilterChipGroup>
                  {PROGRESS_FILTER_VALUES.map((value) => (
                    <FilterChip
                      key={value}
                      label={progressLabels[value]}
                      value={value}
                      selected={flagsToProgress(selectedFilters) === value}
                      onPress={handleProgressChange}
                    />
                  ))}
                </FilterChipGroup>

                {/* My rating — the stars you gave, at the angle you're browsing.
                    The star row keeps climbs you never rated; the switch drops them.
                    A list whose rows all carry your stars (Five Stars) hides it,
                    unless a rating filter is already on. */}
                {showMyRating ? (
                  <>
                    <View style={filterSheetStyles.subsectionGap} />
                    <FilterLabelRow
                      label={t('mobile.filter.myRating')}
                      description={t('mobile.filter.myRatingDescription')}
                    />
                    <View style={filterSheetStyles.ratingRow}>
                      <FilterChip
                        label={t('mobile.filter.anyRating')}
                        value={undefined}
                        selected={selectedFilters.minUserRating == null}
                        onPress={handleClearMyRating}
                      />
                      <StarRating
                        value={selectedFilters.minUserRating}
                        onChange={(value) => setFiltersPatch({ minUserRating: value })}
                        clearValue={undefined}
                      />
                    </View>
                    <SwitchRow
                      label={t('mobile.filter.onlyRatedByMe')}
                      value={!!selectedFilters.onlyRatedByMe}
                      onValueChange={(value) => setFiltersPatch({ onlyRatedByMe: value || undefined })}
                    />
                  </>
                ) : null}
              </FilterSheetSection>
            ) : null}

            {/* 4 · QUALITY — benchmarks, min rating, popularity (incl. Unrepeated). */}
            <FilterSheetSection title={t('mobile.filter.section.quality')}>
              {/* Collection — Benchmarks, My drafts and Liked are mutually
                  exclusive. Personal collections are offered only when signed in. */}
              <FilterLabelRow label={t('mobile.filter.collection.label')} {...pinProps('collection')} />
              <View style={filterSheetStyles.controlGap} />
              <SegmentedControl
                options={collectionOptions}
                selectedKey={collectionFilter}
                onSelect={handleCollectionChange}
                accessibilityLabel={t('mobile.filter.collection.label')}
              />

              <View style={filterSheetStyles.subsectionGap} />
              <FilterLabelRow label={t('mobile.filter.minRating')} {...pinProps('rating')} />
              <View style={filterSheetStyles.ratingRow}>
                <FilterChip
                  label={t('mobile.filter.anyRating')}
                  value={undefined}
                  selected={selectedFilters.minRating == null}
                  onPress={handleClearMinRating}
                />
                <StarRating
                  value={selectedFilters.minRating}
                  onChange={(value) => setFiltersPatch({ minRating: value })}
                  clearValue={undefined}
                />
              </View>

              <View style={filterSheetStyles.subsectionGap} />
              <FilterLabelRow label={t('mobile.filter.popularity')} {...pinProps('popularity')} />
              {/* "Unrepeated" (status='projects') leads the group, then Any + the
                numeric min-ascents buckets. The whole row reads as single-select:
                picking any bucket clears projects (see handlePopularity), and the
                Unrepeated chip is selected iff status==='projects'. */}
              <FilterChipGroup>
                <FilterChip
                  label={t('mobile.filter.popularityUnrepeated')}
                  value="projects"
                  selected={selectedFilters.status === 'projects'}
                  onPress={handleStatusChange}
                />
                {POPULARITY_BUCKETS.map((bucket) => (
                  <FilterChip
                    key={bucket ?? 'any'}
                    label={popularityLabel(bucket)}
                    value={bucket}
                    selected={selectedFilters.minAscents === bucket && selectedFilters.status !== 'projects'}
                    onPress={handlePopularity}
                  />
                ))}
              </FilterChipGroup>
            </FilterSheetSection>

            {/* 5 · THE CLIMB — type, angle, shape, setters, holds, zones, beta. */}
            <FilterSheetSection title={t('mobile.filter.section.theClimb')}>
              {showClimbTypeControl ? (
                <>
                  <FilterLabelRow label={t('mobile.filter.climbType.label')} {...pinProps('climbType')} />
                  <View style={filterSheetStyles.controlGap} />
                  <SegmentedControl
                    options={climbTypeOptions}
                    selectedKey={climbTypeKey}
                    onSelect={handleClimbTypeChange}
                    textVariant="footnote"
                    trackColor={trackColor}
                  />
                </>
              ) : null}

              {showOtherAnglesControl ? (
                <>
                  <View style={filterSheetStyles.subsectionGap} />
                  <SwitchRow
                    label={t('mobile.filter.otherAngles')}
                    description={t('mobile.filter.otherAnglesDescription')}
                    value={!!selectedFilters.includeOtherAngles}
                    onValueChange={(value) => setFiltersPatch({ includeOtherAngles: value || undefined })}
                  />
                </>
              ) : null}

              {/* Tall / Wide — shown wherever a shorter/narrower sibling size exists
                  (Kilter homewall, Tension Board 2, Decoy, Grasshopper); each only
                  where it applies. Matches the chip row so the filter stays
                  reachable here even when its chip is unpinned. They're separate
                  chips, so each gets a header naming its chip with the pin (the
                  Beta videos layout), keeping the switches aligned with the rest. */}
              {showTallControl ? (
                <>
                  <View style={filterSheetStyles.subsectionGap} />
                  <FilterLabelRow label={t('mobile.search.chips.tall')} {...pinProps('tall')} />
                  {/* A locked Tall (iOS chip-row lock) reads on and can't be switched
                      off here; its hint says how to unlock it from the chip. */}
                  <SwitchRow
                    label={t('mobile.filter.tall')}
                    description={
                      lockedDimensions.tall ? t('mobile.filter.tallLockedHint') : t('mobile.filter.tallDescription')
                    }
                    value={lockedDimensions.tall || !!selectedFilters.onlyTallClimbs}
                    disabled={lockedDimensions.tall}
                    onValueChange={(value) => setFiltersPatch({ onlyTallClimbs: value || undefined })}
                  />
                </>
              ) : null}
              {showWideControl ? (
                <>
                  <View style={filterSheetStyles.subsectionGap} />
                  <FilterLabelRow label={t('mobile.search.chips.wide')} {...pinProps('wide')} />
                  <SwitchRow
                    label={t('mobile.filter.wide')}
                    description={
                      lockedDimensions.wide ? t('mobile.filter.wideLockedHint') : t('mobile.filter.wideDescription')
                    }
                    value={lockedDimensions.wide || !!selectedFilters.onlyWideClimbs}
                    disabled={lockedDimensions.wide}
                    onValueChange={(value) => setFiltersPatch({ onlyWideClimbs: value || undefined })}
                  />
                </>
              ) : null}

              {shownSections.setters ? (
                <>
                  <View style={filterSheetStyles.subsectionGap} />
                  <FilterTappableRow
                    label={t('mobile.filter.setters')}
                    value={
                      selectedFilters.setter && selectedFilters.setter.length > 0
                        ? formatSetterSelection(selectedFilters.setter)
                        : t('mobile.filter.none')
                    }
                    onPress={openSetters}
                    disabled={settersRowNeedsBoard && !boardConfig}
                  />
                </>
              ) : null}

              {/* Following sits under the Setters row it belongs with; without
                  that row it takes the usual gap instead. */}
              {isAuthenticated && shownSections.following && shownSections.setters ? (
                <View style={styles.followingSection}>{followingSwitch}</View>
              ) : null}
              {isAuthenticated && shownSections.following && !shownSections.setters ? (
                <>
                  <View style={filterSheetStyles.subsectionGap} />
                  {followingSwitch}
                </>
              ) : null}

              {shownSections.holds ? (
                <>
                  <View style={filterSheetStyles.subsectionGap} />
                  <FilterTappableRow
                    label={t('mobile.holdFilter.title')}
                    value={
                      holdFilterCount > 0
                        ? t('mobile.holdFilter.summaryCount', { count: holdFilterCount })
                        : t('mobile.filter.none')
                    }
                    onPress={openHoldFilter}
                    disabled={!boardConfig}
                  />
                </>
              ) : null}

              {shownSections.zone ? (
                <>
                  <View style={filterSheetStyles.subsectionGap} />
                  <FilterTappableRow
                    label={t('mobile.zoneFilter.title')}
                    value={zoneActive ? t('mobile.zoneFilter.summaryActive') : t('mobile.filter.none')}
                    onPress={openZoneFilter}
                    disabled={!boardConfig}
                  />
                </>
              ) : null}

              {/* Beta videos — a content property of the climb, not a quality signal.
                  A group header carries the pin; the switch uses the descriptive line
                  as its label so "Beta videos" isn't worded twice. */}
              {shownSections.beta ? (
                <>
                  <View style={filterSheetStyles.subsectionGap} />
                  <FilterLabelRow label={t('mobile.filter.betaVideos')} {...pinProps('beta')} />
                  <SwitchRow
                    label={t('mobile.filter.betaVideosDescription')}
                    value={!!selectedFilters.onlyWithBetaVideos}
                    onValueChange={(value) => setFiltersPatch({ onlyWithBetaVideos: value || undefined })}
                  />
                </>
              ) : null}

              {/* Fits my board — a playlist-only lever: hides the climbs set for
                  another board or size, the rows the list dims. */}
              {boardFit ? (
                <>
                  <View style={filterSheetStyles.subsectionGap} />
                  <FilterLabelRow label={t('mobile.filter.boardFit.label')} {...pinProps('boardFit')} />
                  <SwitchRow
                    label={t('mobile.filter.boardFit.switch')}
                    description={t('mobile.filter.boardFit.description')}
                    value={boardFit.value}
                    onValueChange={boardFit.onChange}
                  />
                </>
              ) : null}
            </FilterSheetSection>

            {/* 6 · SORT — sort key + direction (or reshuffle for random). */}
            <FilterSheetSection title={t('mobile.filter.section.sort')}>
              <FilterLabelRow label={t('mobile.filter.sortBy')} {...pinProps('sort')} />
              {/* Flex-wrap (matching the popularity/rating chip rows above), not a
                  horizontal ScrollView: a gesture-handler ScrollView nested in the
                  native bottom sheet collapsed the chip row's height on iOS and
                  clipped the labels. SORT_OPTIONS is short, so wrapping is fine. */}
              {sortControl ? (
                // A list's own sorts: its keys, then its directions in words
                // ("Easiest first"), Shuffle again for Random, nothing for a
                // one-direction key such as the playlist's own order.
                <>
                  <FilterChipGroup>
                    {sortControl.options.map((option) => (
                      <FilterChip
                        key={option.key}
                        label={option.label}
                        value={option.key}
                        selected={sortControl.selected === option.key}
                        onPress={sortControl.onSelect}
                      />
                    ))}
                  </FilterChipGroup>
                  {sortControl.showReshuffle ? (
                    <>
                      <View style={filterSheetStyles.subsectionGap} />
                      <Button
                        title={t('mobile.filter.sort.reshuffle')}
                        onPress={sortControl.onReshuffle}
                        variant="tonal"
                        size="medium"
                        icon="shuffle"
                      />
                    </>
                  ) : sortControl.orderOptions ? (
                    <>
                      <View style={filterSheetStyles.subsectionGap} />
                      <FilterLabelRow label={t('mobile.filter.sortOrderLabel')} />
                      <View style={filterSheetStyles.controlGap} />
                      <SegmentedControl
                        options={sortControl.orderOptions}
                        selectedKey={sortControl.order}
                        onSelect={sortControl.onOrderChange}
                        accessibilityLabel={t('mobile.filter.sortOrderLabel')}
                      />
                    </>
                  ) : null}
                </>
              ) : (
                <FilterChipGroup>
                  {SORT_OPTIONS.map((option) => (
                    <FilterChip
                      key={option}
                      label={sortLabels[option]}
                      value={option}
                      selected={selectedFilters.sortBy === option}
                      onPress={handleSortByChange}
                    />
                  ))}
                </FilterChipGroup>
              )}
              {/* For random, direction is meaningless — swap the asc/desc control for
                  an explicit reshuffle button (re-tapping the Random chip also works). */}
              {sortControl ? null : selectedFilters.sortBy === 'random' ? (
                <>
                  <View style={filterSheetStyles.subsectionGap} />
                  <Button
                    title={t('mobile.filter.sort.reshuffle')}
                    onPress={handleReshuffle}
                    variant="tonal"
                    size="medium"
                    icon="shuffle"
                  />
                </>
              ) : (
                <>
                  <View style={filterSheetStyles.subsectionGap} />
                  <FilterLabelRow label={t('mobile.filter.sortOrderLabel')} />
                  <View style={filterSheetStyles.controlGap} />
                  <SegmentedControl
                    options={sortOrderOptions}
                    selectedKey={selectedFilters.sortOrder}
                    onSelect={handleSortOrderChange}
                    textVariant="footnote"
                    trackColor={trackColor}
                  />
                </>
              )}
            </FilterSheetSection>
          </View>
        </BottomSheetScrollView>
      </View>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  indicator: {
    // Colour is themed at the call site (systemColors.separator adapts light/dark);
    // only the static dimensions live here.
    width: 36,
    height: 5,
    borderRadius: 3,
  },
  scrollView: {
    flex: 1,
  },
  followingSection: {
    marginTop: spacing[4],
  },
});
