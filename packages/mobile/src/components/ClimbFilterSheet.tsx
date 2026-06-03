import { useCallback, useMemo, useRef, useState, useEffect, type PropsWithChildren } from 'react';
import { View, Pressable, ScrollView, StyleSheet, Platform, type ViewStyle } from 'react-native';
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
import type { Grade } from '@boardsesh/shared-schema';
import {
  hasActiveClimbFilters,
  applyStatusChange,
  type SortOption,
  type SortOrder,
  type StatusFilter,
  type GradeAccuracyValue,
  SORT_OPTIONS,
  GRADE_ACCURACY_VALUES,
  STATUS_FILTER_VALUES,
  MIN_ASCENTS_FILTER_OPTIONS,
  formatMinAscentsFilterCount,
} from '@boardsesh/climb-filters';
import { Text } from './Text';
import { Button } from './Button';
import { SegmentedControl } from './SegmentedControl';
import { StarRating } from './StarRating';
import { CollapsibleSection } from './CollapsibleSection';
import { RadioGroup, type RadioOption } from './RadioGroup';
import { SwitchRow } from './SwitchRow';
import { Icon } from './Icon';
import { SheetHandle } from './SheetHandle';
import { useTheme } from '../providers/theme-provider';
import { useGrades } from '../lib/graphql/hooks';
import { useAuth } from '../providers/auth-provider';
import { hapticSelection } from '../lib/haptics';
import { subscribeToSetterSelection } from '../lib/filter-handoff';
import { springs } from '../theme/animations';
import { brandColors } from '../theme/colors';
import { iosSystemColors } from '../theme/ios-colors';
import { spacing } from '../theme/tokens';
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
  onApply: (filters: ClimbFilters) => void;
};

const ASCENT_BUCKET_VALUES = MIN_ASCENTS_FILTER_OPTIONS;

// Portal the sheet above the tab bar / persistent queue bar on iOS so the
// footer button isn't covered by those overlays.
function FilterSheetContainer({ children }: PropsWithChildren) {
  return <FullWindowOverlay>{children}</FullWindowOverlay>;
}
const modalContainerComponent = Platform.OS === 'ios' ? FilterSheetContainer : undefined;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const chipStyle: ViewStyle = {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: 20,
    borderWidth: 1,
    borderColor: selected ? brandColors.primary : iosSystemColors.separator,
    backgroundColor: selected ? brandColors.primary : 'transparent',
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

function GradeSelector({
  label,
  grades,
  selectedDifficultyId,
  onSelect,
}: {
  label: string;
  grades: Grade[];
  selectedDifficultyId: number | undefined;
  onSelect: (difficultyId: number | undefined) => void;
}) {
  const chipStyle = (selected: boolean): ViewStyle => ({
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: 16,
    borderWidth: 1,
    borderColor: selected ? brandColors.primary : iosSystemColors.separator,
    backgroundColor: selected ? brandColors.primary : 'transparent',
  });

  return (
    <View style={styles.gradeSelectorContainer}>
      <Text variant="footnote" style={styles.gradeSelectorLabel}>
        {label}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.gradeChipsRow}>
        {grades.map((grade) => {
          const selected = selectedDifficultyId === grade.difficultyId;
          return (
            <Pressable
              key={grade.difficultyId}
              onPress={() => {
                hapticSelection();
                onSelect(selected ? undefined : grade.difficultyId);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={grade.name}
            >
              <View style={chipStyle(selected)}>
                <Text variant="footnote" color={selected ? iosSystemColors.white : undefined} style={styles.chipText}>
                  {grade.name}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

export function hasActiveFilters(filters: ClimbFilters): boolean {
  return hasActiveClimbFilters(filters);
}

export function ClimbFilterSheet({ onDismiss, boardConfig, currentFilters, onApply }: ClimbFilterSheetProps) {
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

  const [localFilters, setLocalFilters] = useState<ClimbFilters>(currentFilters);
  // CollapsibleSection reads this prop to know when to collapse. With
  // mount-based control the section state is fresh on every open, so we never
  // actually need to bump this — but the prop is still required by the
  // component, so keep a stable zero.
  const sectionResetKey = 0;

  // Mount-based control: parent renders this only when the sheet should be
  // open, so we just present on mount and let the parent unmount on dismiss
  // (same pattern as DevicePickerSheet).
  useEffect(() => {
    sheetRef.current?.present();
  }, []);

  useEffect(() => {
    return subscribeToSetterSelection((setters) => {
      setLocalFilters((previous) => ({ ...previous, setter: setters.length > 0 ? setters : undefined }));
    });
  }, []);

  const snapPoints = useMemo(() => ['90%'], []);

  const isKilter = boardName === 'kilter';

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

  const gradeSummary = useMemo(() => {
    const { minGrade, maxGrade } = localFilters;
    if (minGrade == null && maxGrade == null) return null;
    const minName = minGrade != null ? (grades?.find((g) => g.difficultyId === minGrade)?.name ?? '?') : '–';
    const maxName = maxGrade != null ? (grades?.find((g) => g.difficultyId === maxGrade)?.name ?? '?') : '–';
    return `${minName}–${maxName}`;
  }, [localFilters.minGrade, localFilters.maxGrade, grades]);

  const climbSummary = useMemo(() => {
    const parts: string[] = [];
    if (gradeSummary) parts.push(gradeSummary);
    if (localFilters.setter && localFilters.setter.length > 0) {
      parts.push(t('mobile.search.settersCount', { count: localFilters.setter.length }));
    }
    if (localFilters.onlyTallClimbs) parts.push(t('mobile.filter.tall'));
    if (localFilters.onlyWideClimbs) parts.push(t('mobile.filter.wide'));
    if (localFilters.onlyWithBetaVideos) parts.push(t('mobile.filter.betaVideos'));
    if (localFilters.sortBy !== DEFAULT_FILTERS.sortBy || localFilters.sortOrder !== DEFAULT_FILTERS.sortOrder) {
      parts.push(
        `${sortLabels[localFilters.sortBy]} · ${
          localFilters.sortOrder === 'asc' ? t('mobile.filter.sortOrder.asc') : t('mobile.filter.sortOrder.desc')
        }`,
      );
    }
    return parts.join(' · ') || null;
  }, [
    gradeSummary,
    localFilters.setter,
    localFilters.onlyTallClimbs,
    localFilters.onlyWideClimbs,
    localFilters.onlyWithBetaVideos,
    localFilters.sortBy,
    localFilters.sortOrder,
    sortLabels,
    t,
  ]);

  const qualitySummary = useMemo(() => {
    const parts: string[] = [];
    if (localFilters.minAscents != null) {
      parts.push(t('mobile.search.ascents', { count: localFilters.minAscents }));
    }
    if (localFilters.minRating != null) {
      parts.push(t('mobile.search.rating', { count: localFilters.minRating }));
    }
    if (localFilters.gradeAccuracy != null) {
      parts.push(accuracyLabels[localFilters.gradeAccuracy]);
    }
    return parts.join(' · ') || null;
  }, [localFilters.minAscents, localFilters.minRating, localFilters.gradeAccuracy, accuracyLabels, t]);

  const statusSummary = localFilters.status !== 'any' ? statusLabels[localFilters.status] : null;

  const progressSummary = useMemo(() => {
    const parts: string[] = [];
    if (localFilters.hideAttempted) parts.push(t('mobile.filter.progress.hideAttempted'));
    if (localFilters.hideCompleted) parts.push(t('mobile.filter.progress.hideCompleted'));
    if (localFilters.showOnlyAttempted) parts.push(t('mobile.filter.progress.onlyAttempted'));
    if (localFilters.showOnlyCompleted) parts.push(t('mobile.filter.progress.onlyCompleted'));
    return parts.join(' · ') || (isAuthenticated ? null : t('mobile.filter.signInForProgress'));
  }, [
    localFilters.hideAttempted,
    localFilters.hideCompleted,
    localFilters.showOnlyAttempted,
    localFilters.showOnlyCompleted,
    isAuthenticated,
    t,
  ]);

  const sortOrderOptions = useMemo(
    () => [
      { key: 'desc', label: t('mobile.filter.sortOrder.desc') },
      { key: 'asc', label: t('mobile.filter.sortOrder.asc') },
    ],
    [t],
  );

  const statusOptions = useMemo<ReadonlyArray<RadioOption<StatusFilter>>>(
    () =>
      STATUS_FILTER_VALUES.map((value) => ({
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

  const setFiltersPatch = useCallback((patch: Partial<ClimbFilters>) => {
    setLocalFilters((previous) => ({ ...previous, ...patch }));
  }, []);

  const handleSortByChange = useCallback(
    (sortBy: SortOption) => {
      setFiltersPatch({ sortBy });
    },
    [setFiltersPatch],
  );

  const handleSortOrderChange = useCallback(
    (sortOrder: string) => {
      setFiltersPatch({ sortOrder: sortOrder as SortOrder });
    },
    [setFiltersPatch],
  );

  const handleStatusChange = useCallback((status: StatusFilter) => {
    setLocalFilters((previous) => ({ ...previous, ...applyStatusChange(previous, status) }));
  }, []);

  const handleAccuracyChange = useCallback(
    (value: GradeAccuracyValue | 'off') => {
      setFiltersPatch({ gradeAccuracy: value === 'off' ? undefined : value });
    },
    [setFiltersPatch],
  );

  const handleApply = useCallback(() => {
    onApply(localFilters);
    sheetRef.current?.dismiss();
  }, [localFilters, onApply]);

  const handleReset = useCallback(() => {
    hapticSelection();
    setLocalFilters(DEFAULT_FILTERS);
  }, []);

  // BottomSheetModal fires onDismiss when the sheet closes — we don't need to
  // watch index changes for dismiss anymore.

  const renderBackdrop = useCallback(
    (backdropProps: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...backdropProps} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.4} />
    ),
    [],
  );

  const renderHandle = useCallback(() => <SheetHandle onClose={() => sheetRef.current?.dismiss()} />, []);

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

  const backgroundStyle: ViewStyle = {
    backgroundColor: systemColors.secondaryBackground as string,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  };

  const trackColor = systemColors.fill;

  const accuracyValue: GradeAccuracyValue | 'off' = localFilters.gradeAccuracy ?? 'off';

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
      handleComponent={renderHandle}
      backgroundStyle={backgroundStyle}
    >
      <View style={styles.header}>
        <Text variant="title3">{t('mobile.filter.title')}</Text>
        <Pressable onPress={handleReset} hitSlop={8} accessibilityRole="button">
          <Text variant="subheadline" color={brandColors.primary}>
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
        <View style={styles.sectionsContainer}>
          <CollapsibleSection
            title={t('mobile.filter.section.climb')}
            summary={climbSummary}
            defaultExpanded
            resetKey={sectionResetKey}
          >
            {grades && grades.length > 0 ? (
              <View>
                <Text variant="footnote" style={styles.subsectionLabel}>
                  {t('mobile.filter.gradeRange')}
                </Text>
                <GradeSelector
                  label={t('mobile.filter.minGrade')}
                  grades={grades}
                  selectedDifficultyId={localFilters.minGrade}
                  onSelect={(value) => setFiltersPatch({ minGrade: value })}
                />
                <View style={styles.gradeSpacer} />
                <GradeSelector
                  label={t('mobile.filter.maxGrade')}
                  grades={grades}
                  selectedDifficultyId={localFilters.maxGrade}
                  onSelect={(value) => setFiltersPatch({ maxGrade: value })}
                />
                <View style={styles.subsectionGap} />
              </View>
            ) : null}

            <Pressable
              onPress={openSetters}
              accessibilityRole="button"
              accessibilityLabel={t('mobile.filter.setters')}
              style={({ pressed }) => [
                styles.tappableRow,
                { backgroundColor: systemColors.tertiaryBackground as string },
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

          <CollapsibleSection
            title={t('mobile.filter.section.quality')}
            summary={qualitySummary}
            resetKey={sectionResetKey}
          >
            <Text variant="footnote" style={styles.subsectionLabel}>
              {t('mobile.filter.minAscents')}
            </Text>
            <View style={styles.chipRow}>
              {ASCENT_BUCKET_VALUES.map((bucket) => {
                const isAny = bucket === 0;
                const filterValue = isAny ? undefined : bucket;
                return (
                  <Chip
                    key={bucket}
                    label={isAny ? t('mobile.filter.anyAscents') : `${formatMinAscentsFilterCount(bucket)}+`}
                    selected={localFilters.minAscents === filterValue}
                    onPress={() => setFiltersPatch({ minAscents: filterValue })}
                  />
                );
              })}
            </View>

            <View style={styles.subsectionGap} />
            <Text variant="footnote" style={styles.subsectionLabel}>
              {t('mobile.filter.minRating')}
            </Text>
            <View style={styles.ratingRow}>
              <Pressable
                onPress={() => {
                  hapticSelection();
                  setFiltersPatch({ minRating: undefined });
                }}
                accessibilityRole="button"
              >
                <Text
                  variant="footnote"
                  color={localFilters.minRating == null ? brandColors.primary : undefined}
                  style={localFilters.minRating == null ? styles.chipTextSelected : styles.chipText}
                >
                  {t('mobile.filter.anyRating')}
                </Text>
              </Pressable>
              <StarRating
                value={localFilters.minRating}
                onChange={(value) => setFiltersPatch({ minRating: value })}
                clearValue={undefined}
              />
            </View>

            <View style={styles.subsectionGap} />
            <Text variant="footnote" style={styles.subsectionLabel}>
              {t('mobile.filter.accuracy.label')}
            </Text>
            <RadioGroup options={accuracyOptions} value={accuracyValue} onChange={handleAccuracyChange} />
          </CollapsibleSection>

          <CollapsibleSection
            title={t('mobile.filter.section.status')}
            summary={statusSummary}
            resetKey={sectionResetKey}
          >
            <RadioGroup options={statusOptions} value={localFilters.status} onChange={handleStatusChange} />
          </CollapsibleSection>

          <CollapsibleSection
            title={t('mobile.filter.section.progress')}
            summary={progressSummary}
            resetKey={sectionResetKey}
          >
            {isAuthenticated ? (
              <>
                <SwitchRow
                  label={t('mobile.filter.progress.hideAttempted')}
                  value={!!localFilters.hideAttempted}
                  onValueChange={(value) => setFiltersPatch({ hideAttempted: value || undefined })}
                />
                <SwitchRow
                  label={t('mobile.filter.progress.hideCompleted')}
                  value={!!localFilters.hideCompleted}
                  onValueChange={(value) => setFiltersPatch({ hideCompleted: value || undefined })}
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
            ) : (
              <Text variant="footnote" style={styles.signInHint}>
                {t('mobile.filter.signInForProgress')}
              </Text>
            )}
          </CollapsibleSection>
        </View>
      </BottomSheetScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing[3] }]}>
        <Button
          title={t('mobile.filter.apply')}
          onPress={handleApply}
          variant="filled"
          size="large"
          style={styles.applyButton}
        />
      </View>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
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
  chipTextSelected: {
    fontWeight: '600',
  },
  gradeSelectorContainer: {
    gap: spacing[1],
  },
  gradeSelectorLabel: {
    opacity: 0.5,
    marginBottom: spacing[1],
  },
  gradeChipsRow: {
    gap: spacing[2],
    paddingVertical: spacing[1],
  },
  gradeSpacer: {
    height: spacing[2],
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
  tappableRowTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  tappableRowValue: {
    opacity: 0.55,
  },
  signInHint: {
    opacity: 0.55,
    paddingVertical: spacing[2],
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
