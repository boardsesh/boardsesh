import { useCallback, useMemo, useRef, useState, useEffect, type PropsWithChildren } from 'react';
import { View, Pressable, StyleSheet, Platform, type ViewStyle } from 'react-native';
// react-native-gesture-handler's ScrollView (not the bare RN one) for the
// horizontal sort-by chip rail: nested inside the sheet's vertical
// BottomSheetScrollView, a plain RN ScrollView won't scroll on Android because
// the parent scroll/pan gestures capture the touch. The gesture-handler
// scrollable coordinates nested scrolling correctly.
import { ScrollView } from 'react-native-gesture-handler';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
  type BottomSheetScrollViewMethods,
} from '@gorhom/bottom-sheet';
import { FullWindowOverlay } from 'react-native-screens';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
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
} from '@boardsesh/climb-filters';
import { Text } from './Text';
import { GlassSheetBackground } from './GlassSheetBackground';
import { Button } from './Button';
import { SegmentedControl } from './SegmentedControl';
import { StarRating } from './StarRating';
import { CollapsibleSection } from './CollapsibleSection';
import { RadioGroup, type RadioOption } from './RadioGroup';
import { SwitchRow } from './SwitchRow';
import { Icon } from './Icon';
import { useTheme } from '../providers/theme-provider';
import { useGrades, useSearchClimbsCount } from '../lib/graphql/hooks';
import { useAuth } from '../providers/auth-provider';
import { hapticSelection } from '../lib/haptics';
import { subscribeToSetterSelection } from '../lib/filter-handoff';
import { subscribeToHoldsFilterSelection } from '../lib/hold-filter-handoff';
import { subscribeToZoneFilterSelection } from '../lib/zone-filter-handoff';
import { springs } from '../theme/animations';
// Aliased: the active-filter label reads scheme-aware brand from `useTheme()`.
// `staticBrandColors` is the static set, used only for the selected chip — a FILL
// with white text that must stay legible in both schemes.
import { brandColors as staticBrandColors } from '../theme/colors';
import { iosSystemColors } from '../theme/ios-colors';
import { spacing, borderRadius } from '../theme/tokens';
import { GradeRangeRail } from './grade';
import type { ClimbFilters } from '../lib/climb-filter-types';
import { DEFAULT_FILTERS } from '../lib/climb-filter-types';

export type { ClimbFilters };
export { DEFAULT_FILTERS };

type BoardSearchConfig = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

type ClimbFilterSheetProps = {
  onDismiss: () => void;
  boardConfig: BoardSearchConfig | null;
  currentFilters: ClimbFilters;
  currentBoardFilters: ClimbBoardFilterState;
  /** Current committed name term, so the live "Show N" count matches Apply. */
  searchName?: string;
  onApply: (filters: ClimbFilters, boardFilters: ClimbBoardFilterState) => void;
};

// Status options exposed in the sheet. "established" is retired as a user-facing
// status — it's the same lever as "min ascents ≥ 2", now folded into the
// Popularity control — but the enum value is kept for recent-filter replay.
const STATUS_OPTIONS_UI = ['any', 'drafts', 'projects'] as const;

// Popularity buckets consolidate the old min-ascents chips + the "established"
// status into one control. undefined = Any; 2 = Established (≥2 ascents).
const POPULARITY_BUCKETS: ReadonlyArray<number | undefined> = [undefined, 2, 10, 100, 1000];

// Portal the sheet above the tab bar / persistent queue bar on iOS.
function FilterSheetContainer({ children }: PropsWithChildren) {
  return <FullWindowOverlay>{children}</FullWindowOverlay>;
}
const modalContainerComponent = Platform.OS === 'ios' ? FilterSheetContainer : undefined;

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
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);
  const scrollRef = useRef<BottomSheetScrollViewMethods>(null);
  const boardName = boardConfig?.boardName ?? '';
  const { data: grades } = useGrades(boardName);

  const [localFilters, setLocalFilters] = useState<ClimbFilters>(() => normalizeRetiredStatus(currentFilters));
  const [localBoardFilters, setLocalBoardFilters] = useState<ClimbBoardFilterState>(currentBoardFilters);
  // Bumped on Reset so the Refine/Advanced sections collapse back to default.
  const [sectionResetKey, setSectionResetKey] = useState(0);

  useEffect(() => {
    sheetRef.current?.present();
  }, []);

  useEffect(() => {
    return subscribeToSetterSelection((setters) => {
      setLocalFilters((previous) => ({ ...previous, setter: setters.length > 0 ? setters : undefined }));
    });
  }, []);

  useEffect(() => {
    return subscribeToHoldsFilterSelection((holdsFilter) => {
      setLocalBoardFilters((previous) => ({
        ...previous,
        holdsFilter: Object.keys(holdsFilter).length > 0 ? holdsFilter : undefined,
      }));
    });
  }, []);

  useEffect(() => {
    return subscribeToZoneFilterSelection(({ zoneBox, zoneMode, holdsFilter }) => {
      setLocalBoardFilters((previous) => ({
        ...previous,
        zoneBox,
        zoneMode: zoneBox ? zoneMode : undefined,
        // The zone editor may have pruned out-of-zone hold filters; fold the
        // possibly-edited holds filter back in when it handed one over.
        ...(holdsFilter !== undefined
          ? { holdsFilter: Object.keys(holdsFilter).length > 0 ? holdsFilter : undefined }
          : {}),
      }));
    });
  }, []);

  const snapPoints = useMemo(() => ['90%'], []);
  const isKilter = boardName === 'kilter';

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

  const popularityLabel = useCallback(
    (bucket: number | undefined): string => {
      if (bucket === undefined) return t('mobile.filter.anyAscents');
      if (bucket === 2) return t('mobile.filter.established2plus');
      return `${formatMinAscentsFilterCount(bucket)}+`;
    },
    [t],
  );

  const setFiltersPatch = useCallback((patch: Partial<ClimbFilters>) => {
    setLocalFilters((previous) => ({ ...previous, ...patch }));
  }, []);

  const handleSortByChange = useCallback((sortBy: SortOption) => setFiltersPatch({ sortBy }), [setFiltersPatch]);
  const handleSortOrderChange = useCallback(
    (sortOrder: string) => setFiltersPatch({ sortOrder: sortOrder as SortOrder }),
    [setFiltersPatch],
  );
  const handleStatusChange = useCallback((status: StatusFilter) => {
    setLocalFilters((previous) => ({ ...previous, ...applyStatusChange(previous, status) }));
  }, []);
  const handlePopularity = useCallback((bucket: number | undefined) => {
    // minAscents is mutually exclusive with projects/drafts at the DB layer
    // (createClimbFilters skips minAscents under projectsOnly; drafts drop all
    // stats conditions). Clearing the status here stops a bucket from rendering
    // active-but-inert when one of those statuses is set.
    setLocalFilters((previous) => {
      const conflicts = bucket != null && (previous.status === 'projects' || previous.status === 'drafts');
      return { ...previous, minAscents: bucket, ...(conflicts ? { status: 'any' } : {}) };
    });
  }, []);
  const handleAccuracyChange = useCallback(
    (value: GradeAccuracyValue | 'off') => setFiltersPatch({ gradeAccuracy: value === 'off' ? undefined : value }),
    [setFiltersPatch],
  );
  const handleGradeChange = useCallback((grade: { minGradeId: number | undefined; maxGradeId: number | undefined }) => {
    setLocalFilters((previous) => ({ ...previous, minGrade: grade.minGradeId, maxGrade: grade.maxGradeId }));
  }, []);
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
    onApply(localFilters, localBoardFilters);
    sheetRef.current?.dismiss();
  }, [localFilters, localBoardFilters, onApply]);

  const handleReset = useCallback(() => {
    hapticSelection();
    setLocalFilters(DEFAULT_FILTERS);
    setLocalBoardFilters(DEFAULT_CLIMB_BOARD_FILTER_STATE);
    setSectionResetKey((key) => key + 1);
  }, []);

  const renderBackdrop = useCallback(
    (backdropProps: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...backdropProps} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.4} />
    ),
    [],
  );

  const openSetters = useCallback(() => {
    if (!boardConfig) return;
    router.push({
      pathname: '/(tabs)/climbs/setters',
      params: {
        boardName: boardConfig.boardName,
        layoutId: String(boardConfig.layoutId),
        sizeId: String(boardConfig.sizeId),
        setIds: boardConfig.setIds,
        angle: String(boardConfig.angle),
        selected: JSON.stringify(localFilters.setter ?? []),
      },
    });
  }, [router, boardConfig, localFilters.setter]);

  const openHoldFilter = useCallback(() => {
    if (!boardConfig) return;
    router.push({
      pathname: '/(tabs)/climbs/holds',
      params: {
        boardName: boardConfig.boardName,
        layoutId: String(boardConfig.layoutId),
        sizeId: String(boardConfig.sizeId),
        setIds: boardConfig.setIds,
        angle: String(boardConfig.angle),
        holdsFilter: JSON.stringify(localBoardFilters.holdsFilter ?? {}),
      },
    });
  }, [router, boardConfig, localBoardFilters.holdsFilter]);

  const openZoneFilter = useCallback(() => {
    if (!boardConfig) return;
    router.push({
      pathname: '/(tabs)/climbs/zone',
      params: {
        boardName: boardConfig.boardName,
        layoutId: String(boardConfig.layoutId),
        sizeId: String(boardConfig.sizeId),
        setIds: boardConfig.setIds,
        angle: String(boardConfig.angle),
        layoutName: boardConfig.boardName,
        zoneBox: JSON.stringify(localBoardFilters.zoneBox ?? null),
        zoneMode: localBoardFilters.zoneMode ?? 'allHolds',
        holdsFilter: JSON.stringify(localBoardFilters.holdsFilter ?? {}),
      },
    });
  }, [router, boardConfig, localBoardFilters.zoneBox, localBoardFilters.zoneMode, localBoardFilters.holdsFilter]);

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
      parts.push(t('mobile.search.settersCount', { count: localFilters.setter.length }));
    }
    if (holdFilterCount > 0) parts.push(t('mobile.holdFilter.summaryCount', { count: holdFilterCount }));
    if (zoneActive) parts.push(t('mobile.zoneFilter.title'));
    if (localFilters.onlyTallClimbs) parts.push(t('mobile.filter.tallClimbs'));
    if (localFilters.onlyWideClimbs) parts.push(t('mobile.filter.wideClimbs'));
    return parts.join(' · ') || null;
  }, [localFilters, accuracyLabels, holdFilterCount, zoneActive, t]);

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
    <BottomSheetModal
      ref={sheetRef}
      name="climb-filter"
      index={0}
      snapPoints={snapPoints}
      enableDynamicSizing={false}
      stackBehavior="push"
      containerComponent={modalContainerComponent}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      onDismiss={onDismiss}
      handleIndicatorStyle={styles.indicator}
      backgroundComponent={GlassSheetBackground}
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
                setLocalBoardFilters((previous) => ({ ...previous, onlyBenchmarks: value || undefined }))
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
          <CollapsibleSection
            title={t('mobile.filter.section.refine')}
            summary={refineSummary ?? t('mobile.filter.refineHint')}
            resetKey={sectionResetKey}
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
                    ? t('mobile.search.settersCount', { count: localFilters.setter.length })
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
