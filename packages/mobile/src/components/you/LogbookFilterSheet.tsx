import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { View, Pressable, StyleSheet, Platform, type ViewStyle } from 'react-native';
import { BottomSheetModal, BottomSheetScrollView } from '@expo/ui/community/bottom-sheet';
import DateTimePicker, {
  DateTimePickerAndroid,
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { GradeBound } from '@boardsesh/climb-filters';
import {
  DEFAULT_LOGBOOK_ANGLE_RANGE,
  DEFAULT_LOGBOOK_FILTERS,
  DEFAULT_LOGBOOK_SORT,
  type LogbookFilterState,
  type LogbookSortPreset,
  type LogbookSortState,
} from '@boardsesh/logbook';
import { androidSafeSnapPoints } from '../sheet-snap-points';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { CollapsibleSection } from '../CollapsibleSection';
import { SegmentedControl } from '../SegmentedControl';
import { SwitchRow } from '../SwitchRow';
import { GradeRangeRail } from '../grade';
import { useTheme } from '../../providers/theme-provider';
import { useGrades } from '../../lib/graphql/hooks';
import { hapticSelection } from '../../lib/haptics';
import { springs } from '../../theme/animations';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';

// The logbook spans every board, but Kilter and Tension share an identical
// difficulty-id scale (the font/V-grade taxonomy), so one board's grade list is
// the canonical scale for the range rail. minDifficulty/maxDifficulty go to the
// backend as difficulty ids, board-agnostic.
const GRADE_SCALE_BOARD = 'kilter';

// Angle filter granularity — mirrors the web slider (0–70°, step 5).
const ANGLE_STEP = 5;
const ANGLE_VALUES: number[] = (() => {
  const [min, max] = DEFAULT_LOGBOOK_ANGLE_RANGE;
  const values: number[] = [];
  for (let angle = min; angle <= max; angle += ANGLE_STEP) values.push(angle);
  return values;
})();

type LogbookFilterSheetProps = {
  onDismiss: () => void;
  currentFilters: LogbookFilterState;
  currentSort: LogbookSortState;
  onApply: (filters: LogbookFilterState, sort: LogbookSortState) => void;
  /** Clear the toolbar's committed climb-name search (called by Reset). */
  onClearSearch?: () => void;
};

type StatusKey = 'sends' | 'attempts' | 'both';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Same filled-pill chip language as ClimbFilterSheet, reused locally for the
// angle min/max selectors (a horizontal chip rail).
// memo'd + value-based onPress so the ~30 angle chips (each carrying a Reanimated
// shared value + worklet) don't all re-render when an unrelated filter changes.
// The rails pass a stable handler, not a per-chip arrow.
const Chip = memo(function Chip({
  label,
  selected,
  value,
  onPress,
}: {
  label: string;
  selected: boolean;
  value: number;
  onPress: (value: number) => void;
}) {
  const { systemColors, brandColors } = useTheme();
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const chipStyle: ViewStyle = {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: 20,
    backgroundColor: selected ? brandColors.primaryFill : systemColors.fill,
  };
  return (
    <AnimatedPressable
      onPress={() => {
        hapticSelection();
        onPress(value);
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
      <Text variant="footnote" color={selected ? brandColors.onPrimary : undefined} style={styles.chipText}>
        {label}
      </Text>
    </AnimatedPressable>
  );
});

function statusKeyFor(filters: LogbookFilterState): StatusKey {
  if (filters.includeSends && !filters.includeAttempts) return 'sends';
  if (!filters.includeSends && filters.includeAttempts) return 'attempts';
  return 'both';
}

function statusPatchFor(key: StatusKey): Pick<LogbookFilterState, 'includeSends' | 'includeAttempts'> {
  if (key === 'sends') return { includeSends: true, includeAttempts: false };
  if (key === 'attempts') return { includeSends: false, includeAttempts: true };
  return { includeSends: true, includeAttempts: true };
}

function parseIsoDate(iso: string): Date | null {
  if (!iso) return null;
  const parsed = new Date(`${iso}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function LogbookFilterSheet({
  onDismiss,
  currentFilters,
  currentSort,
  onApply,
  onClearSearch,
}: LogbookFilterSheetProps) {
  const { t } = useTranslation('you');
  const theme = useTheme();
  const { systemColors } = theme;
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);
  const scrollRef = useRef<ComponentRef<typeof BottomSheetScrollView>>(null);

  const { data: grades } = useGrades(GRADE_SCALE_BOARD);

  const [draftFilters, setDraftFilters] = useState<LogbookFilterState>(currentFilters);
  const [draftSort, setDraftSort] = useState<LogbookSortState>(currentSort);
  // Bumped on Reset so the Refine/Advanced sections collapse back to default.
  const [sectionResetKey, setSectionResetKey] = useState(0);

  // The sheet remounts on each open (it is conditionally rendered), so the draft
  // initializes from the committed props above — no parent-sync effect needed.
  useEffect(() => {
    sheetRef.current?.present();
  }, []);

  const snapPoints = useMemo(() => androidSafeSnapPoints(['90%']), []);
  // One stable "today" ceiling so the To-date row's maximumDate prop keeps a
  // constant identity across renders (a fresh Date each render would re-arm
  // DateRangeRow's openAndroid useCallback every time). Captured at sheet mount,
  // so a sheet left open across midnight keeps the prior day's ceiling until it's
  // reopened — an acceptable tradeoff for the stable identity.
  const today = useMemo(() => new Date(), []);

  const updateFilters = useCallback((patch: Partial<LogbookFilterState>) => {
    setDraftFilters((previous) => ({ ...previous, ...patch }));
  }, []);

  const handlePreset = useCallback((preset: LogbookSortPreset) => {
    hapticSelection();
    setDraftSort({ ...DEFAULT_LOGBOOK_SORT, mode: 'preset', preset });
  }, []);

  const handleStatusChange = useCallback(
    (key: string) => {
      const patch = statusPatchFor(key as StatusKey);
      // Flash is a send refinement; drop it when sends leave the result set so a
      // hidden flashOnly can't silently empty an attempts-only view.
      updateFilters({ ...patch, ...(patch.includeSends ? {} : { flashOnly: false }) });
    },
    [updateFilters],
  );

  const handleGradeChange = useCallback(
    (bound: GradeBound) => {
      updateFilters({
        minGrade: bound.minGradeId ?? '',
        maxGrade: bound.maxGradeId ?? '',
      });
    },
    [updateFilters],
  );

  // Commit-on-close: there's no Apply button — the draft applies when the sheet
  // is dismissed (swipe down or tap the scrim). The ref holds the latest draft so
  // the stable dismiss handler commits the newest values, never a stale closure.
  const draftRef = useRef({ filters: draftFilters, sort: draftSort });
  useEffect(() => {
    draftRef.current = { filters: draftFilters, sort: draftSort };
  }, [draftFilters, draftSort]);

  const handleDismiss = useCallback(() => {
    onApply(draftRef.current.filters, draftRef.current.sort);
    onDismiss();
  }, [onApply, onDismiss]);

  const handleReset = useCallback(() => {
    hapticSelection();
    setDraftFilters(DEFAULT_LOGBOOK_FILTERS);
    setDraftSort(DEFAULT_LOGBOOK_SORT);
    setSectionResetKey((key) => key + 1);
    // Reset is a clean slate: also clear the toolbar's committed search term.
    onClearSearch?.();
  }, [onClearSearch]);

  const presetOptions = useMemo(
    () => [
      { key: 'recent' as const, label: t('mobile.logbook.preset.latest') },
      { key: 'hardest' as const, label: t('mobile.logbook.preset.hardest') },
    ],
    [t],
  );
  const presetKey: LogbookSortPreset = draftSort.mode === 'preset' ? draftSort.preset : 'recent';

  const statusOptions = useMemo(
    () => [
      { key: 'sends' as const, label: t('mobile.logbook.status.sends') },
      { key: 'attempts' as const, label: t('mobile.logbook.status.attempts') },
      { key: 'both' as const, label: t('mobile.logbook.status.both') },
    ],
    [t],
  );

  const gradeBound = useMemo<GradeBound>(
    () => ({
      minGradeId: draftFilters.minGrade === '' ? undefined : draftFilters.minGrade,
      maxGradeId: draftFilters.maxGrade === '' ? undefined : draftFilters.maxGrade,
    }),
    [draftFilters.minGrade, draftFilters.maxGrade],
  );

  const [draftMinAngle, draftMaxAngle] = draftFilters.angleRange;
  const handleMinAngle = useCallback(
    (angle: number) => updateFilters({ angleRange: [angle, Math.max(angle, draftMaxAngle)] }),
    [updateFilters, draftMaxAngle],
  );
  const handleMaxAngle = useCallback(
    (angle: number) => updateFilters({ angleRange: [Math.min(draftMinAngle, angle), angle] }),
    [updateFilters, draftMinAngle],
  );

  const handleFromDate = useCallback((iso: string) => updateFilters({ fromDate: iso }), [updateFilters]);
  const handleToDate = useCallback((iso: string) => updateFilters({ toDate: iso }), [updateFilters]);

  const flashDisabled = !draftFilters.includeSends;
  const refineSummary = useMemo(() => {
    const parts: string[] = [];
    const statusKey = statusKeyFor(draftFilters);
    if (statusKey !== 'both') parts.push(t(`mobile.logbook.status.${statusKey}`));
    if (draftFilters.flashOnly && draftFilters.includeSends) parts.push(t('mobile.logbook.flashOnly'));
    if (draftFilters.minGrade !== '' || draftFilters.maxGrade !== '') parts.push(t('mobile.logbook.grade'));
    if (draftMinAngle !== DEFAULT_LOGBOOK_ANGLE_RANGE[0] || draftMaxAngle !== DEFAULT_LOGBOOK_ANGLE_RANGE[1]) {
      parts.push(`${draftMinAngle}°–${draftMaxAngle}°`);
    }
    return parts.join(' · ') || null;
  }, [draftFilters, draftMinAngle, draftMaxAngle, t]);

  const advancedSummary = useMemo(() => {
    const parts: string[] = [];
    if (draftFilters.fromDate || draftFilters.toDate) {
      parts.push(`${draftFilters.fromDate || '…'} – ${draftFilters.toDate || '…'}`);
    }
    if (draftFilters.benchmarkOnly) parts.push(t('mobile.logbook.benchmarksOnly'));
    return parts.join(' · ') || null;
  }, [draftFilters.fromDate, draftFilters.toDate, draftFilters.benchmarkOnly, t]);

  const trackColor = systemColors.fill;

  return (
    <BottomSheetModal
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      enableDynamicSizing={false}
      enablePanDownToClose
      onDismiss={handleDismiss}
      handleIndicatorStyle={styles.indicator}
    >
      <View style={styles.header}>
        <Text variant="title3">{t('mobile.logbook.filter')}</Text>
        <Pressable onPress={handleReset} hitSlop={8} accessibilityRole="button">
          <Text variant="subheadline" color={theme.brandColors.primary}>
            {t('mobile.logbook.reset')}
          </Text>
        </Pressable>
      </View>

      <BottomSheetScrollView
        ref={scrollRef}
        style={styles.scrollView}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + spacing[4] }]}
      >
        {/* PRESET — the headline one-tap sort. Above Refine/Advanced. */}
        <View style={styles.primary}>
          <Text variant="footnote" style={styles.subsectionLabel}>
            {t('mobile.logbook.sort')}
          </Text>
          <SegmentedControl
            options={presetOptions}
            selectedKey={presetKey}
            onSelect={(key) => handlePreset(key)}
            textVariant="footnote"
            trackColor={trackColor}
            accessibilityLabel={t('mobile.logbook.sort')}
          />
        </View>

        <View style={styles.sectionsContainer}>
          {/* REFINE — status / flash / grade / angle. */}
          <CollapsibleSection title={t('mobile.logbook.refine')} summary={refineSummary} resetKey={sectionResetKey}>
            <Text variant="footnote" style={styles.subsectionLabel}>
              {t('mobile.logbook.statusLabel')}
            </Text>
            <SegmentedControl
              options={statusOptions}
              selectedKey={statusKeyFor(draftFilters)}
              onSelect={handleStatusChange}
              textVariant="footnote"
              trackColor={trackColor}
              accessibilityLabel={t('mobile.logbook.statusLabel')}
            />

            <View style={styles.subsectionGap} />
            <View style={styles.groupedCard}>
              <SwitchRow
                label={t('mobile.logbook.flashOnly')}
                value={draftFilters.flashOnly && !flashDisabled}
                disabled={flashDisabled}
                onValueChange={(value) => updateFilters({ flashOnly: value })}
              />
            </View>

            <View style={styles.subsectionGap} />
            <GradeRangeRail
              grades={grades ?? []}
              bound={gradeBound}
              onChange={handleGradeChange}
              dismissible={false}
              showTitle
              centerOnEmpty={false}
              style={styles.inlineGradeRail}
            />

            <View style={styles.subsectionGap} />
            <Text variant="footnote" style={styles.subsectionLabel}>
              {t('mobile.logbook.angleMin')}
            </Text>
            <View style={styles.chipRow}>
              {ANGLE_VALUES.map((angle) => (
                <Chip
                  key={`min-${angle}`}
                  label={`${angle}°`}
                  value={angle}
                  selected={draftMinAngle === angle}
                  onPress={handleMinAngle}
                />
              ))}
            </View>

            <View style={styles.subsectionGap} />
            <Text variant="footnote" style={styles.subsectionLabel}>
              {t('mobile.logbook.angleMax')}
            </Text>
            <View style={styles.chipRow}>
              {ANGLE_VALUES.map((angle) => (
                <Chip
                  key={`max-${angle}`}
                  label={`${angle}°`}
                  value={angle}
                  selected={draftMaxAngle === angle}
                  onPress={handleMaxAngle}
                />
              ))}
            </View>
          </CollapsibleSection>

          {/* ADVANCED — date range / benchmarks. */}
          <CollapsibleSection title={t('mobile.logbook.advanced')} summary={advancedSummary} resetKey={sectionResetKey}>
            <Text variant="footnote" style={styles.subsectionLabel}>
              {t('mobile.logbook.dateRange')}
            </Text>
            <DateRangeRow
              label={t('mobile.logbook.dateFrom')}
              value={draftFilters.fromDate}
              onChange={handleFromDate}
              clearLabel={t('mobile.logbook.dateAny')}
            />
            <View style={styles.dateRowGap} />
            <DateRangeRow
              label={t('mobile.logbook.dateTo')}
              value={draftFilters.toDate}
              onChange={handleToDate}
              clearLabel={t('mobile.logbook.dateAny')}
              maximumDate={today}
            />

            <View style={styles.subsectionGap} />
            <View style={styles.groupedCard}>
              <SwitchRow
                label={t('mobile.logbook.benchmarksOnly')}
                value={draftFilters.benchmarkOnly}
                onValueChange={(value) => updateFilters({ benchmarkOnly: value })}
              />
            </View>
          </CollapsibleSection>
        </View>
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

type DateRangeRowProps = {
  label: string;
  /** ISO date (YYYY-MM-DD) or '' when unset. */
  value: string;
  onChange: (iso: string) => void;
  clearLabel: string;
  maximumDate?: Date;
};

/**
 * One date bound (from / to). iOS shows the native compact picker inline; Android
 * opens the imperative dialog from a tappable row — mirroring LogbookEditSheet's
 * pattern. A Clear affordance resets the bound to "any" (empty ISO).
 */
function DateRangeRow({ label, value, onChange, clearLabel, maximumDate }: DateRangeRowProps) {
  const { systemColors } = useTheme();
  const selectedDate = parseIsoDate(value);
  // iOS: tapping the empty field reveals the inline picker WITHOUT committing a
  // date, so opening "From" doesn't silently filter to today and empty the list.
  const [revealed, setRevealed] = useState(false);

  const handleChange = useCallback(
    (_event: DateTimePickerEvent, picked?: Date) => {
      if (!picked) return;
      onChange(formatIsoDate(picked));
    },
    [onChange],
  );

  const openAndroid = useCallback(() => {
    DateTimePickerAndroid.open({
      value: selectedDate ?? new Date(),
      mode: 'date',
      display: 'default',
      maximumDate,
      onChange: (event, picked) => {
        if (event.type !== 'set' || !picked) return;
        onChange(formatIsoDate(picked));
      },
    });
  }, [selectedDate, maximumDate, onChange]);

  const handleClear = useCallback(() => {
    hapticSelection();
    setRevealed(false);
    onChange('');
  }, [onChange]);

  return (
    <View style={styles.dateRow}>
      <Text variant="body" style={styles.dateRowLabel}>
        {label}
      </Text>
      <View style={styles.dateRowTrailing}>
        {Platform.OS === 'ios' ? (
          selectedDate || revealed ? (
            <DateTimePicker
              value={selectedDate ?? maximumDate ?? new Date()}
              mode="date"
              display="compact"
              maximumDate={maximumDate}
              accessibilityLabel={label}
              onChange={handleChange}
            />
          ) : (
            <Pressable
              onPress={() => {
                hapticSelection();
                setRevealed(true);
              }}
              accessibilityRole="button"
              accessibilityLabel={label}
              style={({ pressed }) => [
                styles.dateButton,
                { backgroundColor: systemColors.fill },
                pressed && styles.dateButtonPressed,
              ]}
            >
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {clearLabel}
              </Text>
              <Icon name="calendar" size={16} color={systemColors.secondaryLabel} />
            </Pressable>
          )
        ) : (
          <Pressable
            onPress={openAndroid}
            accessibilityRole="button"
            accessibilityLabel={label}
            style={({ pressed }) => [
              styles.dateButton,
              { backgroundColor: systemColors.fill },
              pressed && styles.dateButtonPressed,
            ]}
          >
            <Text variant="footnote" color={value ? systemColors.label : systemColors.secondaryLabel}>
              {value || clearLabel}
            </Text>
            <Icon name="calendar" size={16} color={systemColors.secondaryLabel} />
          </Pressable>
        )}
        {value || revealed ? (
          <Pressable onPress={handleClear} hitSlop={8} accessibilityRole="button" accessibilityLabel={clearLabel}>
            <Icon name="close" size={14} color={systemColors.secondaryLabel} />
          </Pressable>
        ) : null}
      </View>
    </View>
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
  chipText: {
    fontWeight: '500',
  },
  groupedCard: {
    borderRadius: borderRadius.lg,
    backgroundColor: `${iosSystemColors.systemGray}14`,
    overflow: 'hidden',
  },
  inlineGradeRail: {
    marginTop: spacing[1],
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  dateRowGap: {
    height: spacing[2],
  },
  dateRowLabel: {
    flex: 1,
  },
  dateRowTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  dateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: 8,
    minHeight: 34,
  },
  dateButtonPressed: {
    opacity: 0.6,
  },
});
