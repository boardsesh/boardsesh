import { useCallback, useMemo, useRef, useState, useEffect, type ComponentRef, type SetStateAction } from 'react';
import {
  View,
  Pressable,
  StyleSheet,
  TextInput,
  type ViewStyle,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { BottomSheetModal, BottomSheetScrollView } from '@expo/ui/community/bottom-sheet';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useWindowBottomInset } from '../hooks/use-window-bottom-inset';
import { useRouter, useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import {
  hasActiveClimbFilters,
  hasActiveBoardFilters,
  applyStatusChange,
  normalizeRetiredStatus,
  toClimbSearchInput,
  mergeBoardFilters,
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
  type BoardSearchConfig,
  type ProgressFilter,
} from '@boardsesh/climb-filters';
import { Text } from './Text';
import { Button } from './Button';
import { SegmentedControl } from './SegmentedControl';
import { StarRating } from './StarRating';
import { SwitchRow } from './SwitchRow';
import { Icon } from './Icon';
import { PinToggle } from './search/PinToggle';
import { getCollectionFilter, getClimbTypeFilter, type CollectionFilter } from '../lib/collection-filter';
import { useTheme } from '../providers/theme-provider';
import { useManagedSheet } from '../providers/sheet-presentation-provider';
import { androidSafeSnapPoints } from './sheet-snap-points';
import { useSheetColumnStyle } from './use-sheet-column-style';
import { useSheetDetentProbe } from './sheet-detent-probe';
import { useGrades, useSearchClimbsCount } from '../lib/graphql/hooks';
import type { BoardName, HoldsFilter } from '@boardsesh/shared-schema';
import { getTallWideScope } from '@boardsesh/board-constants';
import type { OccupiedPlacementIndex, QuantumOverlapFilter } from '@boardsesh/board-layers';
import { buildFilterLabels, formatSettersLabel, progressFilterLabel } from '../lib/filter-labels';
import { parseSetIdsParam, prewarmCreateBoardHolds } from '../lib/create-board-holds';
import { subscribeToHoldsFilterSelection } from '../lib/hold-filter-handoff';
import { subscribeToZoneFilterSelection, type ZoneFilterSelection } from '../lib/zone-filter-handoff';
import { subscribeToSetterFilterSelection } from '../lib/setter-filter-handoff';
import { visibleSearchTextNeedsSync } from '../lib/search-name';
import { useAuth } from '../providers/auth-provider';
import { hapticSelection } from '../lib/haptics';
import { springs } from '../theme/animations';
// Aliased: the active-filter label reads scheme-aware brand from `useTheme()`.
// `staticBrandColors` is the static set, used only for the selected chip — a FILL
// with white text that must stay legible in both schemes.
import { brandColors as staticBrandColors } from '../theme/colors';
import { iosSystemColors } from '../theme/ios-colors';
import { spacing } from '../theme/tokens';
import { GradeRangeRail } from './grade';
import type { ClimbFilters } from '../lib/climb-filter-types';
import { DEFAULT_FILTERS, statusForAuth } from '../lib/climb-filter-types';

export type { ClimbFilters };
export { DEFAULT_FILTERS };

type ClimbFilterSheetProps = {
  onDismiss: () => void;
  boardConfig: BoardSearchConfig | null;
  currentFilters: ClimbFilters;
  currentBoardFilters: ClimbBoardFilterState;
  /** Current committed name term, so the live "Show N" count matches Apply and
   *  the in-sheet name field seeds correctly. */
  searchName?: string;
  /** Last-used grade id; centres the grade rail on a familiar grade when unset. */
  lastUsedGradeId?: number;
  onApply: (filters: ClimbFilters, boardFilters: ClimbBoardFilterState) => void;
  /** Fired per keystroke as the in-sheet name field changes (mirrors into the
   *  parent's live search — name is committed outside the Apply-gated draft
   *  model, same as the top-bar search field). Required: the sheet only owns the
   *  field's display state, so an unwired caller would render a name field that
   *  looks like it filters and doesn't. */
  onNameChange: (text: string) => void;
  /** Fired by Reset and the field's inline × — the ONE clearing path for name,
   *  shared so there is exactly one code path to reason about (#3606). Required
   *  for the same reason as `onNameChange`: without it, clearing would blank the
   *  field while the committed search term quietly survived. */
  onClearName: () => void;
  /** Sanitized live Quantum roster geometry. Unknown geometry disables overlap filtering. */
  quantumOccupancy?: OccupiedPlacementIndex;
};

// The status enum is still driven from the sheet — "My drafts" (Your progress
// section) writes 'drafts', and "Unrepeated" (Popularity) writes 'projects' —
// but there's no longer a Status radio, so no UI option list is needed here.
// "established" stays retired: it's the "min ascents ≥ 2" lever, folded into the
// Popularity buckets; the enum value survives only for recent-filter replay.

// `statusForAuth` (in ../lib/climb-filter-types) coerces a persisted signed-out
// `drafts` status to `any` at the SOURCE — the moment filters enter local state —
// so the "My drafts" switch never renders one frame on for a signed-out user.
// Applied in the useState initializer + the parent-sync effect.

// Popularity buckets consolidate the old min-ascents chips + the "established"
// status into one control. undefined = Any; 2 = Established (≥2 ascents). The
// leading "Unrepeated" bucket (status='projects') is rendered separately.
const POPULARITY_BUCKETS: ReadonlyArray<number | undefined> = [undefined, 2, 10, 100, 1000];

// The sheet's single native detent. The iOS JS-side height bound derived from it
// lives in the shared useSheetColumnStyle hook (see the sheetColumnStyle below).
const SHEET_DETENT_FRACTION = 0.9;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const { systemColors } = useTheme();
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  // Filled rest state (no faint border) so unselected chips are legible on the
  // near-black sheet, matching the search-pill language.
  const chipStyle: ViewStyle = {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: 20,
    // Selected chip is a FILL with white text (see `chipText` below) → static brand.
    backgroundColor: selected ? staticBrandColors.primary : systemColors.fill,
  };
  return (
    <AnimatedPressable
      onPress={() => {
        hapticSelection();
        onPress();
      }}
      onPressIn={() => {
        scale.value = withSpring(0.95, springs.snappy);
      }}
      onPressOut={() => {
        scale.value = withSpring(1, springs.snappy);
      }}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      style={[animatedStyle, chipStyle]}
    >
      <Text variant="footnote" color={selected ? iosSystemColors.white : undefined} style={styles.chipText}>
        {label}
      </Text>
    </AnimatedPressable>
  );
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
  onApply,
  onNameChange,
  onClearName,
  quantumOccupancy,
}: ClimbFilterSheetProps) {
  const { t } = useTranslation('climbs');
  const { t: tCommon } = useTranslation('common');
  const theme = useTheme();
  const { systemColors } = theme;
  const { isAuthenticated } = useAuth();
  // The WINDOW inset, not this mount point's: this sheet lives in the climbs
  // tab, whose per-tab provider folds the iOS 26 tab bar + accessory into
  // insets.bottom — chrome the sheet covers. Padding the Apply footer with that
  // floated it ~105pt up into the sheet (#3776's "dead gap").
  const windowInsetBottom = useWindowBottomInset();
  const sheetRef = useRef<BottomSheetModal>(null);
  const scrollRef = useRef<ComponentRef<typeof BottomSheetScrollView>>(null);
  // Latest scroll offset, captured on scroll into a ref (no re-render).
  const scrollOffsetRef = useRef(0);
  // Snapshotted at suspend: the remounted ScrollView's initial onScroll (y=0) can
  // land before onContentSizeChange, so a live read would restore to 0.
  const pendingRestoreOffsetRef = useRef(0);
  // The epoch whose offset has already been restored — makes the restore in
  // onContentSizeChange one-shot per remount, not re-fire on later content growth.
  const restoredScrollEpochRef = useRef(0);
  const hasLocalDraftEditsRef = useRef(false);
  const boardName = boardConfig?.boardName ?? '';
  const { data: grades } = useGrades(boardName);

  const [localFilters, setLocalFilters] = useState<ClimbFilters>(() =>
    statusForAuth(normalizeRetiredStatus(currentFilters), isAuthenticated),
  );
  const [localBoardFilters, setLocalBoardFilters] = useState<ClimbBoardFilterState>(currentBoardFilters);
  // The name field's own draft — seeded from the committed `searchName` prop.
  // Name lives outside the Apply-gated draft model (it's committed live via the
  // parent's debounce, same as the top-bar search field), so this is a plain
  // display draft, not part of localFilters/DEFAULT_FILTERS.
  const [nameDraft, setNameDraft] = useState(searchName ?? '');
  // Ref snapshot of the draft, read (not the reactive `nameDraft`) inside the
  // resync effect below so the effect's own deps stay just [searchName] — same
  // shape as the parent's top-bar sync effect, which reads visibleSearchTextRef.
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
  // The sub-pickers (setters / holds / zone) are pushed routes, not stacked
  // sheets (native sheets can't stack above this one). While a sub-route is open
  // we suspend — dismiss the native sheet without unmounting, so the draft below
  // survives — and re-present on focus when the route pops. pendingResumeRef
  // distinguishes "returned from a sub-route" from the initial focus-on-mount.
  const router = useRouter();
  const [suspended, setSuspended] = useState(false);
  const pendingResumeRef = useRef(false);
  // A sub-picker round trip re-presents the native sheet host. On iOS a re-present
  // of an ALREADY-MOUNTED SwiftUI sheet host loses the detent height bound, so the
  // flex:1 column stops being clamped to the 90% detent — the ScrollView then grows
  // to content height and pushes the pinned Apply footer off-screen (#3330). Bumping
  // this epoch on resume remounts the host under a fresh key, so every re-present
  // takes the same first-present path as the initial mount (Android already rebuilds
  // its native host each present; this just makes the code path uniform).
  const [presentEpoch, setPresentEpoch] = useState(0);

  // Sync committed parent filters only until the user starts editing. After that,
  // local edits are draft-only until Apply and must not be overwritten by parent
  // ref churn while the sheet is open.
  useEffect(() => {
    if (hasLocalDraftEditsRef.current) return;
    // These direct setters intentionally bypass the draft-guard wrappers:
    // parent prop sync should not mark committed state as an in-flight edit.
    setLocalFilters(statusForAuth(normalizeRetiredStatus(currentFilters), isAuthenticated));
    setLocalBoardFilters(currentBoardFilters);
  }, [currentFilters, currentBoardFilters, isAuthenticated]);

  // Safety net for an auth flip while the user is mid-edit. The parent-sync effect
  // also reacts to isAuthenticated, but it early-returns once there are local draft
  // edits — so it won't coerce then. This effect has no edit guard, so it still drops
  // a now-invalid drafts status if the user signs out with unsaved filter edits open.
  // (When not editing, both effects fire and set the same value — idempotent.) Direct
  // setter (not a user edit); statusForAuth returns the same reference when there's
  // nothing to change, so it can't loop or churn.
  useEffect(() => {
    if (isAuthenticated) return;
    // Past the guard isAuthenticated is always false; pass the literal to make the
    // "drop drafts" intent explicit at the call site.
    setLocalFilters((previous) => statusForAuth(previous, false));
  }, [isAuthenticated]);

  const detentSnapPoints = useMemo(() => [`${SHEET_DETENT_FRACTION * 100}%`], []);
  const snapPoints = useMemo(() => androidSafeSnapPoints(detentSnapPoints), [detentSnapPoints]);
  // On iOS the SwiftUI sheet host can propose an unbounded height, so a flex:1
  // column sizes to its CONTENT and the pinned Apply footer lands off-screen
  // (#3330). The shared hook pins the column to this single detent's height;
  // Android bounds the column natively, so it keeps flex:1.
  const sheetColumnStyle = useSheetColumnStyle(detentSnapPoints);
  // Dev-only observers for #3922 — they feed a log line, never layout. This is
  // the sheet #3776 was reported against, so it is the one to capture on an SE 3.
  const { probeProps, sentinelProps, onColumnLayout } = useSheetDetentProbe(sheetColumnStyle, 'ClimbFilterSheet');
  // Tall/Wide apply on any board whose active size has a shorter/narrower sibling
  // in its family (getTallWideScope — the shared source of truth the chip row and
  // server filter use), not just Kilter. Each toggle renders only where it applies,
  // so the sheet control stays reachable even when the Shape chip is unpinned.
  const { hasShorter: showTallControl, hasNarrower: showWideControl } = boardConfig
    ? getTallWideScope(boardConfig.boardName as BoardName, boardConfig.layoutId, boardConfig.sizeId)
    : { hasShorter: false, hasNarrower: false };

  // Live "Show N" preview for the in-progress edits (matches what Apply yields).
  // Debounced so rapid chip/toggle taps — and now keystrokes in the name field —
  // don't each fire a count request. `name` rides along so an in-sheet name edit
  // is reflected in the preview the same way a chip/toggle edit is.
  const [debouncedEdits, setDebouncedEdits] = useState({
    filters: localFilters,
    boardFilters: localBoardFilters,
    name: nameDraft,
  });
  useEffect(() => {
    const handle = setTimeout(
      () => setDebouncedEdits({ filters: localFilters, boardFilters: localBoardFilters, name: nameDraft }),
      250,
    );
    return () => clearTimeout(handle);
  }, [localFilters, localBoardFilters, nameDraft]);
  const previewInput = useMemo(() => {
    if (!boardConfig) return null;
    return mergeBoardFilters(
      toClimbSearchInput(debouncedEdits.filters, boardConfig, { page: 0, pageSize: 1 }, { name: debouncedEdits.name }),
      debouncedEdits.boardFilters,
      quantumOccupancy,
    );
  }, [boardConfig, debouncedEdits, quantumOccupancy]);
  const { data: previewCount } = useSearchClimbsCount(
    previewInput ?? { boardName: '', layoutId: 0, sizeId: 0, setIds: '', angle: 0 },
    !!previewInput,
  );

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

  const updateLocalFilters = useCallback((nextFilters: SetStateAction<ClimbFilters>) => {
    hasLocalDraftEditsRef.current = true;
    setLocalFilters(nextFilters);
  }, []);

  const updateLocalBoardFilters = useCallback((nextBoardFilters: SetStateAction<ClimbBoardFilterState>) => {
    hasLocalDraftEditsRef.current = true;
    setLocalBoardFilters(nextBoardFilters);
  }, []);

  const setFiltersPatch = useCallback(
    (patch: Partial<ClimbFilters>) => {
      updateLocalFilters((previous) => ({ ...previous, ...patch }));
    },
    [updateLocalFilters],
  );

  // Per-keystroke: update the field's own display state immediately, and mirror
  // the raw text out to the parent (which commits it live via its own debounce —
  // name is not part of the Apply-gated draft, see the `nameDraft` comment above).
  const handleNameTextChange = useCallback(
    (text: string) => {
      setNameDraft(text);
      onNameChange(text);
    },
    [onNameChange],
  );

  // The ONE clearing path for name, shared by the inline × and Reset (#3606) —
  // clears the field's own display state and asks the parent to clear the
  // committed name + the top-bar/native-search-bar mirror.
  const handleClearNameField = useCallback(() => {
    setNameDraft('');
    onClearName();
  }, [onClearName]);

  const handleSortByChange = useCallback(
    (sortBy: SortOption) =>
      // Tapping (or re-tapping) Random mints a fresh seed for a new shuffle;
      // any other sort clears the seed so it never lingers in the search input.
      setFiltersPatch(sortBy === 'random' ? { sortBy, sortSeed: newSortSeed() } : { sortBy, sortSeed: undefined }),
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
      updateLocalFilters((previous) => ({ ...previous, ...applyStatusChange(previous, status) }));
    },
    [updateLocalFilters],
  );
  // Collection — a single-select over Benchmarks (board filter) + My drafts
  // (status), which are mutually exclusive. Selecting one clears the other; only a
  // lingering *drafts* status is cleared (never 'projects'/Unrepeated, which lives
  // in the Popularity group and can coexist with Benchmarks).
  const handleCollectionChange = useCallback(
    (value: CollectionFilter) => {
      updateLocalBoardFilters((previous) => ({ ...previous, onlyBenchmarks: value === 'benchmarks' || undefined }));
      if (value === 'drafts') handleStatusChange('drafts');
      else if (localFilters.status === 'drafts') handleStatusChange('any');
    },
    [updateLocalBoardFilters, handleStatusChange, localFilters.status],
  );
  const collectionOptions = useMemo(
    () => [
      { key: 'any' as const, label: t('mobile.filter.collection.any') },
      { key: 'benchmarks' as const, label: t('mobile.filter.benchmark') },
      // My drafts is auth-only, matching the old drafts toggle's gating.
      ...(isAuthenticated ? [{ key: 'drafts' as const, label: t('mobile.filter.drafts') }] : []),
    ],
    [t, isAuthenticated],
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
      updateLocalFilters((previous) => {
        const clearsProjects = previous.status === 'projects';
        const clearsDrafts = bucket != null && previous.status === 'drafts';
        return { ...previous, minAscents: bucket, ...(clearsProjects || clearsDrafts ? { status: 'any' } : {}) };
      });
    },
    [updateLocalFilters],
  );
  const handleAccuracyChange = useCallback(
    (value: GradeAccuracyValue | 'off') => setFiltersPatch({ gradeAccuracy: value === 'off' ? undefined : value }),
    [setFiltersPatch],
  );
  const handleGradeChange = useCallback(
    (grade: { minGradeId: number | undefined; maxGradeId: number | undefined }) => {
      updateLocalFilters((previous) => ({ ...previous, minGrade: grade.minGradeId, maxGrade: grade.maxGradeId }));
    },
    [updateLocalFilters],
  );
  // Climb-type toggle (main's #2496 control). A 3-way control means there's no
  // UI path to "neither", so the never-both-off invariant is structural (see
  // toClimbSearchInput). "Both" = show everything; boulders-only is the default.
  // Same derivation as the chip row (getClimbTypeFilter) so they never disagree.
  const climbTypeKey = getClimbTypeFilter(localFilters);
  const handleClimbTypeChange = useCallback(
    (key: string) => {
      if (key === 'routes') setFiltersPatch({ boulders: false, routes: true });
      else if (key === 'both') setFiltersPatch({ boulders: true, routes: true });
      else setFiltersPatch({ boulders: true, routes: false });
    },
    [setFiltersPatch],
  );
  const climbTypeOptions = useMemo(
    () => [
      { key: 'boulders', label: t('mobile.filter.climbType.boulders') },
      { key: 'routes', label: t('mobile.filter.climbType.routes') },
      { key: 'both', label: t('mobile.filter.climbType.all') },
    ],
    [t],
  );

  const handleApply = useCallback(() => {
    hasLocalDraftEditsRef.current = false;
    onApply(localFilters, localBoardFilters);
    // Dismiss the raw native ref directly (not via the coordinator handle). This
    // is intentional and safe: the resulting native onChange(-1) routes back
    // through managed.onChange → coordinator.notifyClosed, which opens the settle
    // window. Keep it that way — don't assume the coordinator drove this close.
    sheetRef.current?.dismiss();
  }, [localFilters, localBoardFilters, onApply]);

  const handleSheetDismiss = useCallback(() => {
    hasLocalDraftEditsRef.current = false;
    onDismiss();
  }, [onDismiss]);

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
    hapticSelection();
    updateLocalFilters(DEFAULT_FILTERS);
    updateLocalBoardFilters(DEFAULT_CLIMB_BOARD_FILTER_STATE);
    // Clear the name field too (#3606) — CALLS handleClearNameField rather than
    // repeating its two lines, so Reset and the inline × are two callers of one
    // function, not two copies that can silently drift apart if the clearing
    // logic grows.
    handleClearNameField();
    hasLocalDraftEditsRef.current = false;
  }, [updateLocalBoardFilters, updateLocalFilters, handleClearNameField]);

  // The Holds row is always visible now (no Refine accordion to expand), so
  // prewarm the create-board hold geometry as soon as the sheet is visible with
  // a board config — the sheet only mounts while it's open, so mount == visible.
  // Prewarming is an idempotent cache warm, so a re-run on boardConfig churn is
  // harmless. (Replaces the old expand-triggered PREWARM_..._AFTER_REFINE path.)
  useEffect(() => {
    if (!boardConfig) return;
    prewarmCreateBoardHolds({
      boardName: boardConfig.boardName as BoardName,
      layoutId: boardConfig.layoutId,
      sizeId: boardConfig.sizeId,
      setIds: parseSetIdsParam(boardConfig.setIds),
    });
  }, [boardConfig]);

  // Shared suspend preamble for the sub-picker openers: snapshot the scroll
  // offset for the post-remount restore, then dismiss the native sheet without
  // unmounting (see the suspended/pendingResumeRef comment above).
  const beginSubPickerSuspend = useCallback(() => {
    pendingRestoreOffsetRef.current = scrollOffsetRef.current;
    pendingResumeRef.current = true;
    setSuspended(true);
  }, []);

  const openSetters = useCallback(() => {
    if (!boardConfig || pendingResumeRef.current) return;
    beginSubPickerSuspend();
    router.push({
      pathname: '/(tabs)/climbs/setters',
      params: {
        boardName: boardConfig.boardName,
        layoutId: String(boardConfig.layoutId),
        sizeId: String(boardConfig.sizeId),
        setIds: boardConfig.setIds,
        angle: String(boardConfig.angle),
        setters: JSON.stringify(localFilters.setter ?? []),
      },
    });
  }, [beginSubPickerSuspend, boardConfig, localFilters.setter, router]);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  // One-shot per epoch: a repeat restore on later content growth (e.g. a section
  // expanding) would yank the user's scroll position.
  const handleScrollContentSizeChange = useCallback(() => {
    if (restoredScrollEpochRef.current === presentEpoch) return;
    restoredScrollEpochRef.current = presentEpoch;
    scrollRef.current?.scrollTo({ y: pendingRestoreOffsetRef.current, animated: false });
  }, [presentEpoch]);

  const openHoldFilter = useCallback(() => {
    if (!boardConfig || pendingResumeRef.current) return;
    beginSubPickerSuspend();
    router.push({
      pathname: '/(tabs)/climbs/holds',
      params: {
        boardName: boardConfig.boardName,
        layoutId: String(boardConfig.layoutId),
        sizeId: String(boardConfig.sizeId),
        setIds: boardConfig.setIds,
        holdsFilter: JSON.stringify(localBoardFilters.holdsFilter ?? {}),
      },
    });
  }, [beginSubPickerSuspend, boardConfig, localBoardFilters.holdsFilter, router]);

  const openZoneFilter = useCallback(() => {
    if (!boardConfig || pendingResumeRef.current) return;
    beginSubPickerSuspend();
    router.push({
      pathname: '/(tabs)/climbs/zone',
      params: {
        boardName: boardConfig.boardName,
        layoutId: String(boardConfig.layoutId),
        sizeId: String(boardConfig.sizeId),
        setIds: boardConfig.setIds,
        angle: String(boardConfig.angle),
        zoneBox: JSON.stringify(localBoardFilters.zoneBox ?? null),
        zoneMode: localBoardFilters.zoneMode ?? 'allHolds',
        holdsFilter: JSON.stringify(localBoardFilters.holdsFilter ?? {}),
      },
    });
  }, [
    beginSubPickerSuspend,
    boardConfig,
    localBoardFilters.holdsFilter,
    localBoardFilters.zoneBox,
    localBoardFilters.zoneMode,
    router,
  ]);

  // Re-present after a sub-picker route pops (Done button OR swipe-back both
  // re-focus this screen). On initial mount the screen is already focused with no
  // pending resume, so this is a no-op until a sub-route has actually been pushed.
  useFocusEffect(
    useCallback(() => {
      if (pendingResumeRef.current) {
        pendingResumeRef.current = false;
        setSuspended(false);
        // Remount the native sheet host so the re-present is a first present (#3330).
        setPresentEpoch((epoch) => epoch + 1);
      }
    }, []),
  );

  const handleSelectedSettersChange = useCallback(
    (selectedSetters: string[]) => {
      updateLocalFilters((previous) => ({
        ...previous,
        setter: selectedSetters.length > 0 ? selectedSetters : undefined,
      }));
    },
    [updateLocalFilters],
  );

  const handleHoldsFilterChange = useCallback(
    (holdsFilter: HoldsFilter) => {
      updateLocalBoardFilters((previous) => ({
        ...previous,
        holdsFilter: Object.keys(holdsFilter).length > 0 ? holdsFilter : undefined,
      }));
    },
    [updateLocalBoardFilters],
  );

  const handleZoneFilterChange = useCallback(
    (selection: ZoneFilterSelection) => {
      updateLocalBoardFilters((previous) => {
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
    [updateLocalBoardFilters],
  );

  const handleQuantumOverlapChange = useCallback(
    (quantumOverlap: QuantumOverlapFilter) => {
      updateLocalBoardFilters((previous) => ({
        ...previous,
        quantumOverlap: quantumOverlap === 'off' ? undefined : quantumOverlap,
      }));
    },
    [updateLocalBoardFilters],
  );

  // The setter / hold / zone sub-pickers are pushed routes; each hands its result
  // back through these handoffs when it pops (focus-cleanup), merging into the
  // draft below. Kept subscribed for the lifetime of the (suspended-but-mounted)
  // sheet so the result lands even while the route is on top.
  useEffect(() => {
    const unsubscribeSetters = subscribeToSetterFilterSelection(handleSelectedSettersChange);
    const unsubscribeHolds = subscribeToHoldsFilterSelection(handleHoldsFilterChange);
    const unsubscribeZone = subscribeToZoneFilterSelection(handleZoneFilterChange);
    return () => {
      unsubscribeSetters();
      unsubscribeHolds();
      unsubscribeZone();
    };
  }, [handleSelectedSettersChange, handleHoldsFilterChange, handleZoneFilterChange]);

  const holdFilterCount = countFilteredHolds(localBoardFilters.holdsFilter);
  const zoneActive = localBoardFilters.zoneBox != null;
  const quantumGeometryAvailable = quantumOccupancy?.geometryKnown === true;
  const quantumOverlapOptions = useMemo(
    () => [
      { key: 'off' as const, label: t('mobile.filter.quantumOverlap.off') },
      { key: 'none' as const, label: t('mobile.filter.quantumOverlap.none') },
      { key: 'at_most_one' as const, label: t('mobile.filter.quantumOverlap.atMostOne') },
    ],
    [t],
  );
  const disabledQuantumOverlapKeys = useMemo<ReadonlySet<QuantumOverlapFilter>>(
    () => (quantumGeometryAvailable ? new Set() : new Set(['none', 'at_most_one'])),
    [quantumGeometryAvailable],
  );

  const trackColor = systemColors.fill;
  const accuracyValue: GradeAccuracyValue | 'off' = localFilters.gradeAccuracy ?? 'off';
  const applyLabel =
    previewCount != null ? t('mobile.filter.showCount', { count: previewCount }) : t('mobile.filter.apply');
  // Reset stays a quiet secondary accent until there's actually something to
  // reset — so the header isn't a second always-on violet next to Apply.
  // The name counts as something to reset (#3606): it lives outside
  // ClimbFilters, so neither hasActive* helper can see it, and a lone climb-name
  // search — the issue's own repro — would otherwise leave Reset disabled with
  // the one thing the user wants gone still on screen. Same `.length > 0` rule
  // as the inline × below, so the two clear affordances appear together.
  const anyActive =
    hasActiveClimbFilters(localFilters) || hasActiveBoardFilters(localBoardFilters) || nameDraft.length > 0;

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
    >
      {/* #3922 instrumentation, dev builds only. The sentinel is in-flow but
          zero-height and the probe is absolutely positioned, so neither adds
          anything to the wrapper's content size — the one-in-flow-child rule
          below still holds. */}
      {sentinelProps ? <View {...sentinelProps} /> : null}
      {probeProps ? <View {...probeProps} /> : null}
      {/* One column child bounded to the detent height (JS-computed on iOS, see
          sheetColumnStyle) — the scroll body then actually scrolls and the
          footer pins. Handed multiple direct children, the native sheet sizes
          to content and the flex:1 ScrollView collapses (no scrolling). */}
      <View style={sheetColumnStyle} onLayout={onColumnLayout}>
        <View style={styles.header}>
          <Text variant="title3">{t('mobile.filter.title')}</Text>
          <Pressable onPress={handleReset} hitSlop={8} accessibilityRole="button" disabled={!anyActive}>
            <Text variant="subheadline" color={anyActive ? theme.brandColors.primary : systemColors.secondaryLabel}>
              {t('mobile.filter.reset')}
            </Text>
          </Pressable>
        </View>

        <BottomSheetScrollView
          ref={scrollRef}
          style={styles.scrollView}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          onScroll={handleScroll}
          scrollEventThrottle={32}
          onContentSizeChange={handleScrollContentSizeChange}
          // This sheet never hosted a text input before the name field below —
          // without this, a first tap on Apply/Reset/another row while the
          // keyboard is up over the field can be swallowed (standard RN
          // ScrollView gotcha; the tap dismisses the keyboard instead of firing).
          keyboardShouldPersistTaps="handled"
        >
          {/* Flat, labeled sections — no accordions. The scroll body is one column
              child (styles.body) so the native sheet scrolls and the footer pins. */}
          <View style={styles.body}>
            {/* 1 · NAME — climb-name search term, first row so Reset has something
                visible to reset (#3606). Committed live via onNameChange/onClearName,
                same as the top-bar search field — NOT part of localFilters/Apply. */}
            <View style={styles.sectionFirst}>
              <Text variant="headline" style={styles.sectionHeader}>
                {t('mobile.filter.section.name')}
              </Text>
              <View style={[styles.nameInputRow, { backgroundColor: systemColors.tertiaryBackground }]}>
                <TextInput
                  value={nameDraft}
                  onChangeText={handleNameTextChange}
                  placeholder={t('search.placeholders.climbs')}
                  placeholderTextColor={systemColors.tertiaryLabel}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                  accessibilityLabel={t('mobile.filter.section.name')}
                  style={[styles.nameInput, { color: systemColors.label }]}
                />
                {nameDraft.length > 0 ? (
                  <Pressable
                    onPress={handleClearNameField}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={tCommon('actions.clear')}
                  >
                    <Icon name="close" size={14} color={systemColors.tertiaryLabel} />
                  </Pressable>
                ) : null}
              </View>
            </View>

            {/* 2 · DIFFICULTY — grade bound + grade accuracy. */}
            <View style={styles.section}>
              <Text variant="headline" style={styles.sectionHeader}>
                {t('mobile.filter.section.difficulty')}
              </Text>
              {/* Grade — inline and sheet-local, so dismissing the filter sheet does
                not commit grade edits until Apply. The rail's own title is replaced
                by a pinnable label row. */}
              <View style={styles.pinnableLabelRow}>
                <Text variant="footnote" style={styles.subsectionLabel}>
                  {t('mobile.filter.gradeRange')}
                </Text>
                <PinToggle kind="grade" />
              </View>
              <GradeRangeRail
                grades={grades ?? []}
                bound={{ minGradeId: localFilters.minGrade, maxGradeId: localFilters.maxGrade }}
                lastUsedGradeId={lastUsedGradeId}
                onChange={handleGradeChange}
                dismissible={false}
                style={styles.inlineGradeRail}
              />

              <View style={styles.subsectionGap} />
              <View style={styles.pinnableLabelRow}>
                <Text variant="footnote" style={styles.subsectionLabel}>
                  {t('mobile.filter.accuracy.label')}
                </Text>
                <PinToggle kind="accuracy" />
              </View>
              <Text variant="footnote" style={styles.subsectionDescription}>
                {t('mobile.filter.accuracy.description')}
              </Text>
              <View style={styles.controlGap} />
              <SegmentedControl
                options={accuracyOptions}
                selectedKey={accuracyValue}
                onSelect={handleAccuracyChange}
                accessibilityLabel={t('mobile.filter.accuracy.label')}
              />
            </View>

            {/* 3 · YOUR PROGRESS — auth-only; the per-user tick-flag selector plus
                the "My drafts" toggle (old Status 'drafts', with its side-effects). */}
            {isAuthenticated ? (
              <View style={styles.section}>
                <View style={styles.pinnableLabelRow}>
                  <Text variant="headline" style={styles.sectionHeader}>
                    {t('mobile.filter.progress.label')}
                  </Text>
                  <PinToggle kind="progress" />
                </View>
                {/* A single-select over the four per-user tick flags. "Projects" =
                  attempted-but-not-sent; "Unsent" = the old "hide climbs I've sent". */}
                <View style={styles.chipRow}>
                  {PROGRESS_FILTER_VALUES.map((value) => (
                    <Chip
                      key={value}
                      label={progressLabels[value]}
                      selected={flagsToProgress(localFilters) === value}
                      onPress={() => setFiltersPatch(progressToFlags(value))}
                    />
                  ))}
                </View>

                {/* My rating — the stars you gave, at the angle you're browsing.
                    The star row keeps climbs you never rated; the switch drops them. */}
                <View style={styles.subsectionGap} />
                <Text variant="footnote" style={styles.subsectionLabel}>
                  {t('mobile.filter.myRating')}
                </Text>
                <Text variant="footnote" style={styles.subsectionDescription}>
                  {t('mobile.filter.myRatingDescription')}
                </Text>
                <View style={styles.ratingRow}>
                  <Chip
                    label={t('mobile.filter.anyRating')}
                    selected={localFilters.minUserRating == null}
                    onPress={() => setFiltersPatch({ minUserRating: undefined })}
                  />
                  <StarRating
                    value={localFilters.minUserRating}
                    onChange={(value) => setFiltersPatch({ minUserRating: value })}
                    clearValue={undefined}
                  />
                </View>
                <SwitchRow
                  label={t('mobile.filter.onlyRatedByMe')}
                  value={!!localFilters.onlyRatedByMe}
                  onValueChange={(value) => setFiltersPatch({ onlyRatedByMe: value || undefined })}
                />
              </View>
            ) : null}

            {/* 4 · QUALITY — benchmarks, min rating, popularity (incl. Unrepeated). */}
            <View style={styles.section}>
              <Text variant="headline" style={styles.sectionHeader}>
                {t('mobile.filter.section.quality')}
              </Text>
              {/* Collection — Benchmarks (board filter) + My drafts (status) folded
                  into one single-select; they're mutually exclusive. My drafts is
                  offered only when signed in (auth-gated like the old drafts toggle). */}
              <View style={styles.pinnableLabelRow}>
                <Text variant="footnote" style={styles.subsectionLabel}>
                  {t('mobile.filter.collection.label')}
                </Text>
                <PinToggle kind="collection" />
              </View>
              <View style={styles.controlGap} />
              <SegmentedControl
                options={collectionOptions}
                selectedKey={getCollectionFilter(localFilters, localBoardFilters)}
                onSelect={handleCollectionChange}
                accessibilityLabel={t('mobile.filter.collection.label')}
              />

              <View style={styles.subsectionGap} />
              <View style={styles.pinnableLabelRow}>
                <Text variant="footnote" style={styles.subsectionLabel}>
                  {t('mobile.filter.minRating')}
                </Text>
                <PinToggle kind="rating" />
              </View>
              <View style={styles.ratingRow}>
                <Chip
                  label={t('mobile.filter.anyRating')}
                  selected={localFilters.minRating == null}
                  onPress={() => setFiltersPatch({ minRating: undefined })}
                />
                <StarRating
                  value={localFilters.minRating}
                  onChange={(value) => setFiltersPatch({ minRating: value })}
                  clearValue={undefined}
                />
              </View>

              <View style={styles.subsectionGap} />
              <View style={styles.pinnableLabelRow}>
                <Text variant="footnote" style={styles.subsectionLabel}>
                  {t('mobile.filter.popularity')}
                </Text>
                <PinToggle kind="popularity" />
              </View>
              {/* "Unrepeated" (status='projects') leads the group, then Any + the
                numeric min-ascents buckets. The whole row reads as single-select:
                picking any bucket clears projects (see handlePopularity), and the
                Unrepeated chip is selected iff status==='projects'. */}
              <View style={styles.chipRow}>
                <Chip
                  label={t('mobile.filter.popularityUnrepeated')}
                  selected={localFilters.status === 'projects'}
                  onPress={() => handleStatusChange('projects')}
                />
                {POPULARITY_BUCKETS.map((bucket) => (
                  <Chip
                    key={bucket ?? 'any'}
                    label={popularityLabel(bucket)}
                    selected={localFilters.minAscents === bucket && localFilters.status !== 'projects'}
                    onPress={() => handlePopularity(bucket)}
                  />
                ))}
              </View>
            </View>

            {/* 5 · THE CLIMB — type, shape, setters, holds, zones, beta. */}
            <View style={styles.section}>
              <Text variant="headline" style={styles.sectionHeader}>
                {t('mobile.filter.section.theClimb')}
              </Text>
              <View style={styles.pinnableLabelRow}>
                <Text variant="footnote" style={styles.subsectionLabel}>
                  {t('mobile.filter.climbType.label')}
                </Text>
                <PinToggle kind="climbType" />
              </View>
              <View style={styles.controlGap} />
              <SegmentedControl
                options={climbTypeOptions}
                selectedKey={climbTypeKey}
                onSelect={handleClimbTypeChange}
                textVariant="footnote"
                trackColor={trackColor}
              />

              {boardConfig?.boardName === 'quantum' ? (
                <>
                  <View style={styles.subsectionGap} />
                  <Text variant="footnote" style={styles.subsectionLabel}>
                    {t('mobile.filter.quantumOverlap.label')}
                  </Text>
                  <Text variant="footnote" style={styles.subsectionDescription}>
                    {quantumGeometryAvailable
                      ? t('mobile.filter.quantumOverlap.description')
                      : t('mobile.filter.quantumOverlap.unavailable')}
                  </Text>
                  <View style={styles.controlGap} />
                  <SegmentedControl<QuantumOverlapFilter>
                    options={quantumOverlapOptions}
                    selectedKey={localBoardFilters.quantumOverlap ?? 'off'}
                    onSelect={handleQuantumOverlapChange}
                    disabledKeys={disabledQuantumOverlapKeys}
                    accessibilityLabel={t('mobile.filter.quantumOverlap.label')}
                  />
                </>
              ) : null}

              {/* Shape — shown wherever a shorter/narrower sibling size exists (Kilter
                  homewall, Tension Board 2, Decoy, Grasshopper); each toggle only where
                  it applies. Matches the chip row so Tall/Wide stays reachable here even
                  when the Shape chip is unpinned. */}
              {showTallControl || showWideControl ? (
                <>
                  <View style={styles.subsectionGap} />
                  <View style={styles.pinnableLabelRow}>
                    <Text variant="footnote" style={styles.subsectionLabel}>
                      {t('mobile.filter.shape')}
                    </Text>
                    <PinToggle kind="shape" />
                  </View>
                  {showTallControl ? (
                    <SwitchRow
                      label={t('mobile.filter.tall')}
                      description={t('mobile.filter.tallDescription')}
                      value={!!localFilters.onlyTallClimbs}
                      onValueChange={(value) => setFiltersPatch({ onlyTallClimbs: value || undefined })}
                    />
                  ) : null}
                  {showWideControl ? (
                    <SwitchRow
                      label={t('mobile.filter.wide')}
                      description={t('mobile.filter.wideDescription')}
                      value={!!localFilters.onlyWideClimbs}
                      onValueChange={(value) => setFiltersPatch({ onlyWideClimbs: value || undefined })}
                    />
                  ) : null}
                </>
              ) : null}

              <View style={styles.subsectionGap} />
              <Pressable
                onPress={openSetters}
                disabled={!boardConfig}
                accessibilityRole="button"
                accessibilityLabel={t('mobile.filter.setters')}
                style={({ pressed }) => [
                  styles.tappableRow,
                  { backgroundColor: systemColors.tertiaryBackground },
                  pressed && styles.tappableRowPressed,
                  !boardConfig && styles.tappableRowDisabled,
                ]}
              >
                <Text variant="body">{t('mobile.filter.setters')}</Text>
                <View style={styles.tappableRowTrailing}>
                  <Text variant="footnote" style={styles.tappableRowValue}>
                    {localFilters.setter && localFilters.setter.length > 0
                      ? formatSetterSelection(localFilters.setter)
                      : t('mobile.filter.none')}
                  </Text>
                  <Icon name="chevron.right" size={14} color={systemColors.tertiaryLabel} />
                </View>
              </Pressable>

              <View style={styles.subsectionGap} />
              <Pressable
                onPress={openHoldFilter}
                disabled={!boardConfig}
                accessibilityRole="button"
                accessibilityLabel={t('mobile.holdFilter.title')}
                style={({ pressed }) => [
                  styles.tappableRow,
                  { backgroundColor: systemColors.tertiaryBackground },
                  pressed && styles.tappableRowPressed,
                  !boardConfig && styles.tappableRowDisabled,
                ]}
              >
                <Text variant="body">{t('mobile.holdFilter.title')}</Text>
                <View style={styles.tappableRowTrailing}>
                  <Text variant="footnote" style={styles.tappableRowValue}>
                    {holdFilterCount > 0
                      ? t('mobile.holdFilter.summaryCount', { count: holdFilterCount })
                      : t('mobile.filter.none')}
                  </Text>
                  <Icon name="chevron.right" size={14} color={systemColors.tertiaryLabel} />
                </View>
              </Pressable>

              <View style={styles.subsectionGap} />
              <Pressable
                onPress={openZoneFilter}
                disabled={!boardConfig}
                accessibilityRole="button"
                accessibilityLabel={t('mobile.zoneFilter.title')}
                style={({ pressed }) => [
                  styles.tappableRow,
                  { backgroundColor: systemColors.tertiaryBackground },
                  pressed && styles.tappableRowPressed,
                  !boardConfig && styles.tappableRowDisabled,
                ]}
              >
                <Text variant="body">{t('mobile.zoneFilter.title')}</Text>
                <View style={styles.tappableRowTrailing}>
                  <Text variant="footnote" style={styles.tappableRowValue}>
                    {zoneActive ? t('mobile.zoneFilter.summaryActive') : t('mobile.filter.none')}
                  </Text>
                  <Icon name="chevron.right" size={14} color={systemColors.tertiaryLabel} />
                </View>
              </Pressable>

              {/* Beta videos — a content property of the climb, not a quality signal.
                  A group header carries the pin; the switch uses the descriptive line
                  as its label so "Beta videos" isn't worded twice. */}
              <View style={styles.subsectionGap} />
              <View style={styles.pinnableLabelRow}>
                <Text variant="footnote" style={styles.subsectionLabel}>
                  {t('mobile.filter.betaVideos')}
                </Text>
                <PinToggle kind="beta" />
              </View>
              <SwitchRow
                label={t('mobile.filter.betaVideosDescription')}
                value={!!localFilters.onlyWithBetaVideos}
                onValueChange={(value) => setFiltersPatch({ onlyWithBetaVideos: value || undefined })}
              />
            </View>

            {/* 6 · SORT — sort key + direction (or reshuffle for random). */}
            <View style={styles.section}>
              <Text variant="headline" style={styles.sectionHeader}>
                {t('mobile.filter.section.sort')}
              </Text>
              <View style={styles.pinnableLabelRow}>
                <Text variant="footnote" style={styles.subsectionLabel}>
                  {t('mobile.filter.sortBy')}
                </Text>
                <PinToggle kind="sort" />
              </View>
              {/* Flex-wrap (matching the popularity/rating chip rows above), not a
                  horizontal ScrollView: a gesture-handler ScrollView nested in the
                  native bottom sheet collapsed the chip row's height on iOS and
                  clipped the labels. SORT_OPTIONS is short, so wrapping is fine. */}
              <View style={styles.chipRow}>
                {SORT_OPTIONS.map((option) => (
                  <Chip
                    key={option}
                    label={sortLabels[option]}
                    selected={localFilters.sortBy === option}
                    onPress={() => handleSortByChange(option)}
                  />
                ))}
              </View>
              {/* For random, direction is meaningless — swap the asc/desc control for
                  an explicit reshuffle button (re-tapping the Random chip also works). */}
              {localFilters.sortBy === 'random' ? (
                <>
                  <View style={styles.subsectionGap} />
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
                  <View style={styles.subsectionGap} />
                  <Text variant="footnote" style={styles.subsectionLabel}>
                    {t('mobile.filter.sortOrderLabel')}
                  </Text>
                  <View style={styles.controlGap} />
                  <SegmentedControl
                    options={sortOrderOptions}
                    selectedKey={localFilters.sortOrder}
                    onSelect={handleSortOrderChange}
                    textVariant="footnote"
                    trackColor={trackColor}
                  />
                </>
              )}
            </View>
          </View>
        </BottomSheetScrollView>

        <View
          style={[
            styles.footer,
            { paddingBottom: windowInsetBottom + spacing[3], borderTopColor: systemColors.separator },
          ]}
        >
          <Button title={applyLabel} onPress={handleApply} variant="filled" size="large" style={styles.applyButton} />
        </View>
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
  },
  scrollContent: {
    paddingBottom: spacing[4],
  },
  body: {
    paddingHorizontal: spacing[4],
  },
  // Each top-level group. A generous top pad separates the six headers into
  // distinct inset-style groups; the first group sits tighter under the sheet header.
  section: {
    paddingTop: spacing[5],
  },
  sectionFirst: {
    paddingTop: spacing[2],
  },
  // The six group titles — more prominent than the muted footnote sub-labels so
  // the flat sheet reads as six inset groups without accordions.
  sectionHeader: {
    marginBottom: spacing[3],
  },
  // The name field's row — same tertiaryBackground pill language as the
  // tappable rows below (setters/holds/zone), so it reads as part of the family.
  nameInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderRadius: 10,
    minHeight: 44,
  },
  nameInput: {
    flex: 1,
    fontSize: 17,
    paddingVertical: 0,
  },
  subsectionLabel: {
    opacity: 0.55,
    marginTop: spacing[1],
    marginBottom: spacing[2],
  },
  // A one-line hint under a sub-label (e.g. what "Grade accuracy" means). Sits
  // tight under the label (cancels its marginBottom) and more muted than it.
  subsectionDescription: {
    opacity: 0.4,
    marginTop: -spacing[2],
    marginBottom: spacing[1],
  },
  subsectionGap: {
    height: spacing[4],
  },
  // A control's label line with a trailing pin toggle (pin the control to the chip row).
  pinnableLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  // Breathing room between a footnote sub-label and a flush native SegmentedControl
  // (which, unlike the chip rows, has no intrinsic top padding).
  controlGap: {
    height: spacing[2],
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
  },
  chipText: {
    fontWeight: '500',
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[4],
  },
  tappableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderRadius: 10,
    minHeight: 44,
  },
  tappableRowPressed: {
    opacity: 0.6,
  },
  tappableRowDisabled: {
    opacity: 0.4,
  },
  tappableRowTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  tappableRowValue: {
    opacity: 0.55,
  },
  inlineGradeRail: {
    marginTop: spacing[2],
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    // borderTopColor is themed at the call site (systemColors.separator).
  },
  applyButton: {
    width: '100%',
  },
});
