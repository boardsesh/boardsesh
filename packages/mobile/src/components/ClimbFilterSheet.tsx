import { useCallback, useMemo, useRef, useState, useEffect, type ComponentRef, type SetStateAction } from 'react';
import { View, Pressable, StyleSheet, type ViewStyle } from 'react-native';
// react-native-gesture-handler's ScrollView (not the bare RN one) for the
// horizontal sort-by chip rail: nested inside the sheet's vertical
// BottomSheetScrollView, a plain RN ScrollView won't scroll on Android because
// the parent scroll/pan gestures capture the touch. The gesture-handler
// scrollable coordinates nested scrolling correctly.
import { ScrollView } from 'react-native-gesture-handler';
import { BottomSheetModal, BottomSheetScrollView } from '@expo/ui/community/bottom-sheet';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
  type BoardSearchConfig,
} from '@boardsesh/climb-filters';
import { Text } from './Text';
import { Button } from './Button';
import { SegmentedControl } from './SegmentedControl';
import { StarRating } from './StarRating';
import { CollapsibleSection } from './CollapsibleSection';
import { RadioGroup, type RadioOption } from './RadioGroup';
import { SwitchRow } from './SwitchRow';
import { Icon } from './Icon';
import { useTheme } from '../providers/theme-provider';
import { useManagedSheet } from '../providers/sheet-presentation-provider';
import { androidSafeSnapPoints } from './sheet-snap-points';
import { useGrades, useSearchClimbsCount } from '../lib/graphql/hooks';
import type { BoardName, HoldsFilter } from '@boardsesh/shared-schema';
import { buildFilterLabels, formatSettersLabel } from '../lib/filter-labels';
import { parseSetIdsParam, prewarmCreateBoardHolds } from '../lib/create-board-holds';
import { subscribeToHoldsFilterSelection } from '../lib/hold-filter-handoff';
import { subscribeToZoneFilterSelection } from '../lib/zone-filter-handoff';
import { useAuth } from '../providers/auth-provider';
import { hapticSelection } from '../lib/haptics';
import { springs } from '../theme/animations';
// Aliased: the active-filter label reads scheme-aware brand from `useTheme()`.
// `staticBrandColors` is the static set, used only for the selected chip — a FILL
// with white text that must stay legible in both schemes.
import { brandColors as staticBrandColors } from '../theme/colors';
import { iosSystemColors } from '../theme/ios-colors';
import { spacing, borderRadius } from '../theme/tokens';
import { GradeRangeRail } from './grade';
import { SettersFilterSheet } from './search/SettersFilterSheet';
import { HoldFilterEditorSheet } from './search/HoldFilterEditorSheet';
import { ZoneFilterEditorSheet, type ZoneFilterEditorSelection } from './search/ZoneFilterEditorSheet';
import type { ClimbFilters } from '../lib/climb-filter-types';
import { DEFAULT_FILTERS } from '../lib/climb-filter-types';

export type { ClimbFilters };
export { DEFAULT_FILTERS };

type ClimbFilterSheetProps = {
  onDismiss: () => void;
  boardConfig: BoardSearchConfig | null;
  currentFilters: ClimbFilters;
  currentBoardFilters: ClimbBoardFilterState;
  /** Current committed name term, so the live "Show N" count matches Apply. */
  searchName?: string;
  onApply: (filters: ClimbFilters, boardFilters: ClimbBoardFilterState) => void;
};

type ActiveChildFilterSheet = 'setters' | 'holds' | 'zone' | null;

// Status options exposed in the sheet. "established" is retired as a user-facing
// status — it's the same lever as "min ascents ≥ 2", now folded into the
// Popularity control — but the enum value is kept for recent-filter replay.
const STATUS_OPTIONS_UI = ['any', 'drafts', 'projects'] as const;

// Popularity buckets consolidate the old min-ascents chips + the "established"
// status into one control. undefined = Any; 2 = Established (≥2 ascents).
const POPULARITY_BUCKETS: ReadonlyArray<number | undefined> = [undefined, 2, 10, 100, 1000];
const PREWARM_BOARD_HOLDS_AFTER_REFINE_EXPAND_MS = 150;

// This sheet's child editors (setters / holds / zone) stack ON TOP of it and
// present off the default `root` group. Keep this sheet in its own presenter
// group so the coordinator doesn't treat a stacked child as an exclusive
// hand-off and dismiss the filter sheet out from under it.
const CLIMB_FILTER_PRESENTER_GROUP = 'climb-filter';

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
  onApply,
}: ClimbFilterSheetProps) {
  const { t } = useTranslation('climbs');
  const theme = useTheme();
  const { systemColors } = theme;
  const { isAuthenticated } = useAuth();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);
  const scrollRef = useRef<ComponentRef<typeof BottomSheetScrollView>>(null);
  const refinePrewarmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLocalDraftEditsRef = useRef(false);
  const boardName = boardConfig?.boardName ?? '';
  const { data: grades } = useGrades(boardName);

  const [localFilters, setLocalFilters] = useState<ClimbFilters>(() => normalizeRetiredStatus(currentFilters));
  const [localBoardFilters, setLocalBoardFilters] = useState<ClimbBoardFilterState>(currentBoardFilters);
  // Bumped on Reset so the Refine/Advanced sections collapse back to default.
  const [sectionResetKey, setSectionResetKey] = useState(0);
  const [refineExpanded, setRefineExpanded] = useState(false);
  const [activeChildSheet, setActiveChildSheet] = useState<ActiveChildFilterSheet>(null);
  const [mountedChildSheet, setMountedChildSheet] = useState<ActiveChildFilterSheet>(null);

  // Sync committed parent filters only until the user starts editing. After that,
  // local edits are draft-only until Apply and must not be overwritten by parent
  // ref churn while the sheet is open.
  useEffect(() => {
    if (hasLocalDraftEditsRef.current) return;
    // These direct setters intentionally bypass the draft-guard wrappers:
    // parent prop sync should not mark committed state as an in-flight edit.
    setLocalFilters(normalizeRetiredStatus(currentFilters));
    setLocalBoardFilters(currentBoardFilters);
  }, [currentFilters, currentBoardFilters]);

  useEffect(() => {
    return () => {
      if (refinePrewarmTimeoutRef.current) clearTimeout(refinePrewarmTimeoutRef.current);
    };
  }, []);

  const snapPoints = useMemo(() => androidSafeSnapPoints(['90%']), []);
  const isKilter = boardName === 'kilter';
  const childSheetOpen = activeChildSheet != null;

  // Live "Show N" preview for the in-progress edits (matches what Apply yields).
  // Debounced so rapid chip/toggle taps don't each fire a count request.
  const [debouncedEdits, setDebouncedEdits] = useState({ filters: localFilters, boardFilters: localBoardFilters });
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedEdits({ filters: localFilters, boardFilters: localBoardFilters }), 250);
    return () => clearTimeout(handle);
  }, [localFilters, localBoardFilters]);
  const previewInput = useMemo(() => {
    if (!boardConfig) return null;
    return mergeBoardFilters(
      toClimbSearchInput(debouncedEdits.filters, boardConfig, { page: 0, pageSize: 1 }, { name: searchName }),
      debouncedEdits.boardFilters,
    );
  }, [boardConfig, debouncedEdits, searchName]);
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
    }),
    [t],
  );

  const statusLabels = useMemo<Record<StatusFilter, string>>(
    () => ({
      any: t('mobile.filter.status.any'),
      drafts: t('mobile.filter.status.drafts'),
      established: t('mobile.filter.status.established'),
      projects: t('mobile.filter.status.projects'),
    }),
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

  const statusOptions = useMemo<ReadonlyArray<RadioOption<StatusFilter>>>(
    () =>
      STATUS_OPTIONS_UI.map((value) => ({
        value,
        label: statusLabels[value],
        disabled: value === 'drafts' && !isAuthenticated,
        description: value === 'drafts' && !isAuthenticated ? t('mobile.filter.signInForDrafts') : undefined,
      })),
    [statusLabels, isAuthenticated, t],
  );

  const accuracyOptions = useMemo<ReadonlyArray<RadioOption<GradeAccuracyValue | 'off'>>>(
    () =>
      GRADE_ACCURACY_VALUES.map((value) => ({
        value: value === '0' ? 'off' : value,
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

  const handleSortByChange = useCallback((sortBy: SortOption) => setFiltersPatch({ sortBy }), [setFiltersPatch]);
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
  const handlePopularity = useCallback(
    (bucket: number | undefined) => {
      // minAscents is mutually exclusive with projects/drafts at the DB layer
      // (createClimbFilters skips minAscents under projectsOnly; drafts drop all
      // stats conditions). Clearing the status here stops a bucket from rendering
      // active-but-inert when one of those statuses is set.
      updateLocalFilters((previous) => {
        const conflicts = bucket != null && (previous.status === 'projects' || previous.status === 'drafts');
        return { ...previous, minAscents: bucket, ...(conflicts ? { status: 'any' } : {}) };
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
  const climbTypeKey = useMemo<'boulders' | 'routes' | 'both'>(() => {
    const bouldersOn = localFilters.boulders ?? true;
    const routesOn = localFilters.routes ?? false;
    if (bouldersOn && !routesOn) return 'boulders';
    if (!bouldersOn && routesOn) return 'routes';
    return 'both';
  }, [localFilters.boulders, localFilters.routes]);
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
      { key: 'boulders', label: t('mobile.filter.boulders') },
      { key: 'routes', label: t('mobile.filter.routes') },
      { key: 'both', label: t('mobile.filter.both') },
    ],
    [t],
  );

  const handleApply = useCallback(() => {
    hasLocalDraftEditsRef.current = false;
    onApply(localFilters, localBoardFilters);
    sheetRef.current?.dismiss();
  }, [localFilters, localBoardFilters, onApply]);

  const handleSheetDismiss = useCallback(() => {
    hasLocalDraftEditsRef.current = false;
    onDismiss();
  }, [onDismiss]);

  // The parent mounts this sheet only while it should be open, so present/dismiss
  // route through the coordinator (serialized, no overlapping native
  // transitions). `onClose` (handleSheetDismiss) clears the parent's open state
  // on a user pan-down / backdrop. See CLIMB_FILTER_PRESENTER_GROUP for why this
  // sheet keeps its own group instead of the default `root`.
  const managed = useManagedSheet({
    open: true,
    sheetRef,
    onClose: handleSheetDismiss,
    group: CLIMB_FILTER_PRESENTER_GROUP,
  });

  const handleReset = useCallback(() => {
    hapticSelection();
    updateLocalFilters(DEFAULT_FILTERS);
    updateLocalBoardFilters(DEFAULT_CLIMB_BOARD_FILTER_STATE);
    setRefineExpanded(false);
    hasLocalDraftEditsRef.current = false;
    setSectionResetKey((key) => key + 1);
  }, [updateLocalBoardFilters, updateLocalFilters]);

  const openSetters = useCallback(() => {
    if (!boardConfig) return;
    setMountedChildSheet('setters');
    setActiveChildSheet('setters');
  }, [boardConfig]);

  const scheduleBoardHoldsPrewarm = useCallback(() => {
    if (!boardConfig) return;
    if (refinePrewarmTimeoutRef.current) clearTimeout(refinePrewarmTimeoutRef.current);
    refinePrewarmTimeoutRef.current = setTimeout(() => {
      refinePrewarmTimeoutRef.current = null;
      prewarmCreateBoardHolds({
        boardName: boardConfig.boardName as BoardName,
        layoutId: boardConfig.layoutId,
        sizeId: boardConfig.sizeId,
        setIds: parseSetIdsParam(boardConfig.setIds),
      });
    }, PREWARM_BOARD_HOLDS_AFTER_REFINE_EXPAND_MS);
  }, [boardConfig]);

  const handleRefineExpandedChange = useCallback(
    (expanded: boolean) => {
      setRefineExpanded(expanded);
      if (expanded) scheduleBoardHoldsPrewarm();
    },
    [scheduleBoardHoldsPrewarm],
  );

  const openHoldFilter = useCallback(() => {
    if (!boardConfig) return;
    setMountedChildSheet('holds');
    setActiveChildSheet('holds');
  }, [boardConfig]);

  const openZoneFilter = useCallback(() => {
    if (!boardConfig) return;
    setMountedChildSheet('zone');
    setActiveChildSheet('zone');
  }, [boardConfig]);

  const closeChildSheet = useCallback(() => {
    setActiveChildSheet(null);
  }, []);

  const handleChildSheetDismiss = useCallback(() => {
    setActiveChildSheet(null);
    setMountedChildSheet(null);
  }, []);

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
    (selection: ZoneFilterEditorSelection) => {
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

  // Primary editing happens in stacked child sheets, but the standalone hold and
  // zone routes are retained as fallbacks; keep their focus-cleanup handoff live.
  useEffect(() => {
    const unsubscribeHolds = subscribeToHoldsFilterSelection(handleHoldsFilterChange);
    const unsubscribeZone = subscribeToZoneFilterSelection(handleZoneFilterChange);
    return () => {
      unsubscribeHolds();
      unsubscribeZone();
    };
  }, [handleHoldsFilterChange, handleZoneFilterChange]);

  const holdFilterCount = countFilteredHolds(localBoardFilters.holdsFilter);
  const zoneActive = localBoardFilters.zoneBox != null;

  const refineSummary = useMemo(() => {
    const parts: string[] = [];
    // Boulders-only is the default, so only surface a chip when it differs.
    const bouldersOn = localFilters.boulders ?? true;
    const routesOn = localFilters.routes ?? false;
    if (routesOn && !bouldersOn) parts.push(t('mobile.filter.routes'));
    else if (routesOn && bouldersOn) parts.push(t('mobile.filter.both'));
    if (localFilters.gradeAccuracy != null) parts.push(accuracyLabels[localFilters.gradeAccuracy]);
    if (localFilters.setter && localFilters.setter.length > 0) {
      parts.push(formatSetterSelection(localFilters.setter));
    }
    if (holdFilterCount > 0) parts.push(t('mobile.holdFilter.summaryCount', { count: holdFilterCount }));
    if (zoneActive) parts.push(t('mobile.zoneFilter.title'));
    if (localFilters.onlyTallClimbs) parts.push(t('mobile.filter.tallClimbs'));
    if (localFilters.onlyWideClimbs) parts.push(t('mobile.filter.wideClimbs'));
    return parts.join(' · ') || null;
  }, [localFilters, accuracyLabels, holdFilterCount, zoneActive, formatSetterSelection, t]);

  const advancedSummary = useMemo(() => {
    const parts: string[] = [];
    if (localFilters.status !== 'any') parts.push(statusLabels[localFilters.status]);
    if (localFilters.hideAttempted) parts.push(t('mobile.filter.progress.hideAttempted'));
    if (localFilters.showOnlyAttempted) parts.push(t('mobile.filter.progress.onlyAttempted'));
    if (localFilters.showOnlyCompleted) parts.push(t('mobile.filter.progress.onlyCompleted'));
    if (localFilters.onlyWithBetaVideos) parts.push(t('mobile.filter.betaVideosShort'));
    if (localFilters.sortBy !== DEFAULT_FILTERS.sortBy || localFilters.sortOrder !== DEFAULT_FILTERS.sortOrder) {
      parts.push(sortLabels[localFilters.sortBy]);
    }
    return parts.join(' · ') || null;
  }, [
    localFilters.status,
    localFilters.hideAttempted,
    localFilters.showOnlyAttempted,
    localFilters.showOnlyCompleted,
    localFilters.onlyWithBetaVideos,
    localFilters.sortBy,
    localFilters.sortOrder,
    statusLabels,
    sortLabels,
    t,
  ]);

  const trackColor = systemColors.fill;
  const accuracyValue: GradeAccuracyValue | 'off' = localFilters.gradeAccuracy ?? 'off';
  const applyLabel =
    previewCount != null ? t('mobile.filter.showCount', { count: previewCount }) : t('mobile.filter.apply');
  // Reset stays a quiet secondary accent until there's actually something to
  // reset — so the header isn't a second always-on violet next to Apply.
  const anyActive = hasActiveClimbFilters(localFilters) || hasActiveBoardFilters(localBoardFilters);

  return (
    <>
      <BottomSheetModal
        ref={sheetRef}
        index={0}
        snapPoints={snapPoints}
        enableDynamicSizing={false}
        enablePanDownToClose={!childSheetOpen}
        enableContentPanningGesture={!childSheetOpen}
        enableHandlePanningGesture={!childSheetOpen}
        onChange={managed.onChange}
        handleIndicatorStyle={styles.indicator}
      >
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
        >
          {/* PRIMARY — the levers the analytics say carry the product. Always open. */}
          <View style={styles.primary}>
            {/* Grade — inline and sheet-local, so dismissing the filter sheet does
              not commit grade edits until Apply. */}
            <GradeRangeRail
              grades={grades ?? []}
              bound={{ minGradeId: localFilters.minGrade, maxGradeId: localFilters.maxGrade }}
              onChange={handleGradeChange}
              dismissible={false}
              showTitle
              style={styles.inlineGradeRail}
            />

            {/* Quality toggles, grouped as one iOS inset card. */}
            <View style={styles.subsectionGap} />
            <View style={styles.groupedCard}>
              {isAuthenticated ? (
                <>
                  <SwitchRow
                    label={t('mobile.filter.hideSent')}
                    description={t('mobile.filter.hideSentDescription')}
                    value={!!localFilters.hideCompleted}
                    onValueChange={(value) => setFiltersPatch({ hideCompleted: value || undefined })}
                  />
                  <View style={[styles.groupDivider, { backgroundColor: systemColors.separator }]} />
                </>
              ) : null}
              <SwitchRow
                label={t('mobile.filter.benchmark')}
                description={t('mobile.filter.benchmarkDescription')}
                value={!!localBoardFilters.onlyBenchmarks}
                onValueChange={(value) =>
                  updateLocalBoardFilters((previous) => ({ ...previous, onlyBenchmarks: value || undefined }))
                }
              />
            </View>

            <View style={styles.subsectionGap} />
            <Text variant="footnote" style={styles.subsectionLabel}>
              {t('mobile.filter.popularity')}
            </Text>
            <View style={styles.chipRow}>
              {POPULARITY_BUCKETS.map((bucket) => (
                <Chip
                  key={bucket ?? 'any'}
                  label={popularityLabel(bucket)}
                  selected={localFilters.minAscents === bucket}
                  onPress={() => handlePopularity(bucket)}
                />
              ))}
            </View>

            <View style={styles.subsectionGap} />
            <Text variant="footnote" style={styles.subsectionLabel}>
              {t('mobile.filter.minRating')}
            </Text>
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
          </View>

          <View style={styles.sectionsContainer}>
            {/* REFINE — mid-band controls, opt-in. */}
            {/* `defaultExpanded` is read when `sectionResetKey` remounts this
                section; Reset clears `refineExpanded` before bumping the key. */}
            <CollapsibleSection
              title={t('mobile.filter.section.refine')}
              defaultExpanded={refineExpanded}
              summary={refineSummary ?? t('mobile.filter.refineHint')}
              resetKey={sectionResetKey}
              onExpandedChange={handleRefineExpandedChange}
            >
              <Text variant="footnote" style={styles.subsectionLabel}>
                {t('mobile.filter.climbType')}
              </Text>
              <SegmentedControl
                options={climbTypeOptions}
                selectedKey={climbTypeKey}
                onSelect={handleClimbTypeChange}
                textVariant="footnote"
                trackColor={trackColor}
              />

              <View style={styles.subsectionGap} />
              <Pressable
                onPress={openSetters}
                accessibilityRole="button"
                accessibilityLabel={t('mobile.filter.setters')}
                style={({ pressed }) => [
                  styles.tappableRow,
                  { backgroundColor: systemColors.tertiaryBackground },
                  pressed && styles.tappableRowPressed,
                ]}
              >
                <Text variant="body">{t('mobile.filter.setters')}</Text>
                <View style={styles.tappableRowTrailing}>
                  <Text variant="footnote" style={styles.tappableRowValue}>
                    {localFilters.setter && localFilters.setter.length > 0
                      ? formatSetterSelection(localFilters.setter)
                      : t('mobile.filter.none')}
                  </Text>
                  <Icon name="chevron.right" size={14} color={iosSystemColors.systemGray4} />
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
                  <Icon name="chevron.right" size={14} color={iosSystemColors.systemGray4} />
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
                  <Icon name="chevron.right" size={14} color={iosSystemColors.systemGray4} />
                </View>
              </Pressable>

              <View style={styles.subsectionGap} />
              <Text variant="footnote" style={styles.subsectionLabel}>
                {t('mobile.filter.accuracy.label')}
              </Text>
              <RadioGroup options={accuracyOptions} value={accuracyValue} onChange={handleAccuracyChange} />

              {isKilter ? (
                <>
                  <View style={styles.subsectionGap} />
                  <SwitchRow
                    label={t('mobile.filter.tall')}
                    description={t('mobile.filter.tallDescription')}
                    value={!!localFilters.onlyTallClimbs}
                    onValueChange={(value) => setFiltersPatch({ onlyTallClimbs: value || undefined })}
                  />
                  <SwitchRow
                    label={t('mobile.filter.wide')}
                    description={t('mobile.filter.wideDescription')}
                    value={!!localFilters.onlyWideClimbs}
                    onValueChange={(value) => setFiltersPatch({ onlyWideClimbs: value || undefined })}
                  />
                </>
              ) : null}
            </CollapsibleSection>

            {/* ADVANCED — the sub-2% long tail. Kept, off the primary surface. */}
            <CollapsibleSection
              title={t('mobile.filter.section.advanced')}
              summary={advancedSummary ?? t('mobile.filter.advancedHint')}
              resetKey={sectionResetKey}
            >
              <Text variant="footnote" style={styles.subsectionLabel}>
                {t('mobile.filter.section.status')}
              </Text>
              <RadioGroup options={statusOptions} value={localFilters.status} onChange={handleStatusChange} />

              {isAuthenticated ? (
                <>
                  <View style={styles.subsectionGap} />
                  <SwitchRow
                    label={t('mobile.filter.progress.hideAttempted')}
                    value={!!localFilters.hideAttempted}
                    onValueChange={(value) => setFiltersPatch({ hideAttempted: value || undefined })}
                  />
                  <SwitchRow
                    label={t('mobile.filter.progress.onlyAttempted')}
                    value={!!localFilters.showOnlyAttempted}
                    onValueChange={(value) => setFiltersPatch({ showOnlyAttempted: value || undefined })}
                  />
                  <SwitchRow
                    label={t('mobile.filter.progress.onlyCompleted')}
                    value={!!localFilters.showOnlyCompleted}
                    onValueChange={(value) => setFiltersPatch({ showOnlyCompleted: value || undefined })}
                  />
                </>
              ) : null}

              <View style={styles.subsectionGap} />
              <SwitchRow
                label={t('mobile.filter.betaVideos')}
                description={t('mobile.filter.betaVideosDescription')}
                value={!!localFilters.onlyWithBetaVideos}
                onValueChange={(value) => setFiltersPatch({ onlyWithBetaVideos: value || undefined })}
              />

              <View style={styles.subsectionGap} />
              <Text variant="footnote" style={styles.subsectionLabel}>
                {t('mobile.filter.sortBy')}
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.horizontalChipRow}
              >
                {SORT_OPTIONS.map((option) => (
                  <Chip
                    key={option}
                    label={sortLabels[option]}
                    selected={localFilters.sortBy === option}
                    onPress={() => handleSortByChange(option)}
                  />
                ))}
              </ScrollView>
              <View style={styles.subsectionGap} />
              <Text variant="footnote" style={styles.subsectionLabel}>
                {t('mobile.filter.sortOrderLabel')}
              </Text>
              <SegmentedControl
                options={sortOrderOptions}
                selectedKey={localFilters.sortOrder}
                onSelect={handleSortOrderChange}
                textVariant="footnote"
                trackColor={trackColor}
              />
            </CollapsibleSection>
          </View>
        </BottomSheetScrollView>

        <View
          style={[styles.footer, { paddingBottom: insets.bottom + spacing[3], borderTopColor: systemColors.separator }]}
        >
          <Button title={applyLabel} onPress={handleApply} variant="filled" size="large" style={styles.applyButton} />
        </View>
      </BottomSheetModal>

      {boardConfig ? (
        <>
          {mountedChildSheet === 'setters' ? (
            <SettersFilterSheet
              visible={activeChildSheet === 'setters'}
              boardConfig={boardConfig}
              selectedSetters={localFilters.setter ?? []}
              onSelectedSettersChange={handleSelectedSettersChange}
              onClose={closeChildSheet}
              onDismiss={handleChildSheetDismiss}
            />
          ) : null}
          {mountedChildSheet === 'holds' ? (
            <HoldFilterEditorSheet
              visible={activeChildSheet === 'holds'}
              boardConfig={boardConfig}
              holdsFilter={localBoardFilters.holdsFilter ?? {}}
              onHoldsFilterChange={handleHoldsFilterChange}
              onClose={closeChildSheet}
              onDismiss={handleChildSheetDismiss}
            />
          ) : null}
          {mountedChildSheet === 'zone' ? (
            <ZoneFilterEditorSheet
              visible={activeChildSheet === 'zone'}
              boardConfig={boardConfig}
              zoneBox={localBoardFilters.zoneBox ?? null}
              zoneMode={localBoardFilters.zoneMode ?? 'allHolds'}
              holdsFilter={localBoardFilters.holdsFilter ?? {}}
              onZoneFilterChange={handleZoneFilterChange}
              onClose={closeChildSheet}
              onDismiss={handleChildSheetDismiss}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  indicator: {
    backgroundColor: iosSystemColors.separator,
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
  primary: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[3],
  },
  sectionsContainer: {
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
  },
  subsectionLabel: {
    opacity: 0.55,
    marginTop: spacing[1],
    marginBottom: spacing[2],
  },
  subsectionGap: {
    height: spacing[4],
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
  },
  horizontalChipRow: {
    flexDirection: 'row',
    gap: spacing[2],
  },
  chipText: {
    fontWeight: '500',
  },
  groupedCard: {
    borderRadius: borderRadius.lg,
    backgroundColor: `${iosSystemColors.systemGray}14`,
    overflow: 'hidden',
  },
  groupDivider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: spacing[4],
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
    borderTopColor: iosSystemColors.separator,
  },
  applyButton: {
    width: '100%',
  },
});
