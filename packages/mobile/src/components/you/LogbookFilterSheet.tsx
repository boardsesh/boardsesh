import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { BottomSheetModal, BottomSheetScrollView } from '@expo/ui/community/bottom-sheet';
import { useWindowBottomInset } from '../../hooks/use-window-bottom-inset';
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
import { CollapsibleSection } from '../CollapsibleSection';
import { SegmentedControl } from '../SegmentedControl';
import { SwitchRow } from '../SwitchRow';
import { GradeRangeRail } from '../grade';
import { LogbookAngleRail, DateRangeRow } from './logbook-facet-controls';
import { useTheme } from '../../providers/theme-provider';
import { useManagedSheet } from '../../providers/sheet-presentation-provider';
import { useGrades } from '../../lib/graphql/hooks';
import { hapticSelection } from '../../lib/haptics';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';

// The logbook spans every board, but Kilter and Tension share an identical
// difficulty-id scale (the font/V-grade taxonomy), so one board's grade list is
// the canonical scale for the range rail. minDifficulty/maxDifficulty go to the
// backend as difficulty ids, board-agnostic.
const GRADE_SCALE_BOARD = 'kilter';

type LogbookFilterSheetProps = {
  onDismiss: () => void;
  currentFilters: LogbookFilterState;
  currentSort: LogbookSortState;
  onApply: (filters: LogbookFilterState, sort: LogbookSortState) => void;
  /** Clear the toolbar's committed climb-name search (called by Reset). */
  onClearSearch?: () => void;
  /** Show the in-sheet Sort (Latest/Hardest) block. Defaults true; the caller
   *  passes false when the top-level sort chips own the sort, so it isn't shown
   *  twice (Liquid Glass). The draft still tracks/commits sort either way. */
  showSort?: boolean;
};

type StatusKey = 'sends' | 'attempts' | 'both';

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

export function LogbookFilterSheet({
  onDismiss,
  currentFilters,
  currentSort,
  onApply,
  onClearSearch,
  showSort = true,
}: LogbookFilterSheetProps) {
  const { t } = useTranslation('you');
  const theme = useTheme();
  const { systemColors } = theme;
  const windowInsetBottom = useWindowBottomInset();
  const sheetRef = useRef<BottomSheetModal>(null);
  const scrollRef = useRef<ComponentRef<typeof BottomSheetScrollView>>(null);

  const { data: grades } = useGrades(GRADE_SCALE_BOARD);

  const [draftFilters, setDraftFilters] = useState<LogbookFilterState>(currentFilters);
  const [draftSort, setDraftSort] = useState<LogbookSortState>(currentSort);
  // Bumped on Reset so the Refine/Advanced sections collapse back to default.
  const [sectionResetKey, setSectionResetKey] = useState(0);

  // Commit-on-close: there's no Apply button — the draft applies when the sheet
  // closes. The ref holds the latest draft so the stable commit reads the newest
  // values, never a stale closure.
  const draftRef = useRef({ filters: draftFilters, sort: draftSort });
  useEffect(() => {
    draftRef.current = { filters: draftFilters, sort: draftSort };
  }, [draftFilters, draftSort]);

  // One commit per open. A user pan-down (onClose → handleDismiss) and the
  // unmount cleanup below both call this, so the guard prevents a double-apply.
  const committedRef = useRef(false);
  const commitDraft = useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    onApply(draftRef.current.filters, draftRef.current.sort);
  }, [onApply]);

  const handleDismiss = useCallback(() => {
    commitDraft();
    onDismiss();
  }, [commitDraft, onDismiss]);

  // The parent only mounts the sheet while it should be open, so present/dismiss
  // route through the coordinator (serialized, no overlapping native transitions).
  // A user pan-down / scrim tap fires onClose → handleDismiss (commit the draft).
  const managed = useManagedSheet({ open: true, sheetRef, onClose: handleDismiss });

  // Commit on unmount too: a programmatic close — the parent unmounting the sheet,
  // or a coordinator-driven dismiss — never fires onClose, so the draft would
  // otherwise be discarded silently. Read commitDraft through a ref so the cleanup
  // runs only on real unmount (empty deps), not on every onApply identity change.
  const commitDraftRef = useRef(commitDraft);
  commitDraftRef.current = commitDraft;
  useEffect(() => {
    return () => commitDraftRef.current();
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
  const handleAngleRange = useCallback(
    (angleRange: [number, number]) => updateFilters({ angleRange }),
    [updateFilters],
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
      onChange={managed.onChange}
      onFullyDismissed={managed.onFullyDismissed}
      handleIndicatorStyle={styles.indicator}
    >
      <View style={styles.header}>
        <Text variant="title3">{t('mobile.logbook.filter')}</Text>
        <Pressable onPress={handleReset} hitSlop={8} accessibilityRole="button">
          <Text variant="subheadline" color={theme.brandColors.accent}>
            {t('mobile.logbook.reset')}
          </Text>
        </Pressable>
      </View>

      <BottomSheetScrollView
        ref={scrollRef}
        style={styles.scrollView}
        showsVerticalScrollIndicator={false}
        // With a fixed 90% snap point + enableDynamicSizing off, the content must
        // flex to fill the sheet and carry generous bottom padding so the last row
        // (Benchmarks only) scrolls fully into view when both sections are expanded.
        contentContainerStyle={[styles.scrollContent, { paddingBottom: windowInsetBottom + spacing[8] }]}
      >
        {/* PRESET — the headline one-tap sort. Above Refine/Advanced. Suppressed
            when the toolbar's top-level sort chips own it (Liquid Glass), so sort
            isn't worded twice; the draft still tracks/commits it from chips. */}
        {showSort ? (
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
              tint={theme.brandColors.accent}
              accessibilityLabel={t('mobile.logbook.sort')}
            />
          </View>
        ) : null}

        <View style={styles.sectionsContainer}>
          {/* REFINE — status / flash / grade / angle. Open by default (the core
              filters); Advanced (date / benchmarks) stays collapsed below. */}
          <CollapsibleSection
            title={t('mobile.logbook.refine')}
            summary={refineSummary}
            resetKey={sectionResetKey}
            defaultExpanded
          >
            <Text variant="footnote" style={styles.subsectionLabel}>
              {t('mobile.logbook.statusLabel')}
            </Text>
            <SegmentedControl
              options={statusOptions}
              selectedKey={statusKeyFor(draftFilters)}
              onSelect={handleStatusChange}
              textVariant="footnote"
              trackColor={trackColor}
              tint={theme.brandColors.accent}
              accessibilityLabel={t('mobile.logbook.statusLabel')}
            />

            <View style={styles.subsectionGap} />
            <View style={styles.groupedCard}>
              <SwitchRow
                label={t('mobile.logbook.flashOnly')}
                value={draftFilters.flashOnly && !flashDisabled}
                disabled={flashDisabled}
                tint={theme.brandColors.accent}
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
              accentColor={theme.brandColors.accent}
              style={styles.inlineGradeRail}
            />

            <View style={styles.subsectionGap} />
            <LogbookAngleRail angleRange={draftFilters.angleRange} onChange={handleAngleRange} />
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
                tint={theme.brandColors.accent}
                onValueChange={(value) => updateFilters({ benchmarkOnly: value })}
              />
            </View>
          </CollapsibleSection>
        </View>
      </BottomSheetScrollView>
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
    // Fill the sheet so the content is always scrollable to the last row (the
    // inline override supplies the generous safe-area-aware bottom padding).
    flexGrow: 1,
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
  groupedCard: {
    borderRadius: borderRadius.lg,
    backgroundColor: `${iosSystemColors.systemGray}14`,
    overflow: 'hidden',
  },
  inlineGradeRail: {
    marginTop: spacing[1],
  },
  dateRowGap: {
    height: spacing[2],
  },
});
