import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { BottomSheetModal, BottomSheetScrollView } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { GradeBound } from '@boardsesh/climb-filters';
import {
  DEFAULT_LOGBOOK_FILTERS,
  LOGBOOK_DATE_WINDOWS,
  LOGBOOK_SORT_KEYS,
  LOGBOOK_STATUS_SEGMENTS,
  filtersForStatusSegment,
  logbookSortFor,
  logbookSortKeyOf,
  parseLocalIsoDate,
  statusSegmentFor,
  type LogbookDateWindow,
  type LogbookFilterState,
  type LogbookSortDirection,
  type LogbookSortKey,
  type LogbookSortState,
  type LogbookStatusSegment,
} from '@boardsesh/logbook';
import type { Grade } from '@boardsesh/shared-schema';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import { SheetTopBar } from '../SheetTopBar';
import { SegmentedControl } from '../SegmentedControl';
import { StarRating } from '../StarRating';
import { SwitchRow } from '../SwitchRow';
import { GradeRangeRail } from '../grade';
import { AngleRangeRail } from '../filter-sheet/AngleRangeRail';
import { FilterSheetSection } from '../filter-sheet/FilterSheetSection';
import { FilterLabelRow } from '../filter-sheet/FilterLabelRow';
import { FilterChip, FilterChipGroup } from '../filter-sheet/FilterChip';
import { FilterNameField } from '../filter-sheet/FilterNameField';
import { FilterTappableRow } from '../filter-sheet/FilterTappableRow';
import { filterSheetStyles } from '../filter-sheet/filter-sheet-styles';
import { androidSafeSnapPoints } from '../sheet-snap-points';
import { useSheetColumnStyle } from '../use-sheet-column-style';
import { useSheetKeyboardInset } from '../sheet-keyboard-inset';
import { useIosSheetBackgroundStyle } from '../use-ios-sheet-background-style';
import { useWindowBottomInset } from '../../hooks/use-window-bottom-inset';
import { useSheetSubRoute } from '../../hooks/use-sheet-sub-route';
import { useManagedSheet } from '../../providers/sheet-presentation-provider';
import { useTheme } from '../../providers/theme-provider';
import { useLogbookPinnedChips } from '../../lib/logbook-pinned-chips-store';
import { LOGBOOK_PINNABLE_CHIP_KINDS, type LogbookPinnableChipKind } from '../../lib/logbook-pinnable-chips';
import { visibleSearchTextNeedsSync } from '../../lib/search-name';
import { hapticSelection } from '../../lib/haptics';
import { spacing } from '../../theme/tokens';
import { DateRangeRow } from './logbook-facet-controls';
import {
  countLogbookFilters,
  isLogbookSortActive,
  logbookAnglePatch,
  logbookAngleRailValue,
  logbookDateWindowLabel,
  logbookSetterLabel,
  logbookStatusLabel,
} from './logbook-capsules';
import type { LogbookBoardOption } from './use-logbook-board-options';

type LogbookFilterSheetProps = {
  onDismiss: () => void;
  filters: LogbookFilterState;
  sort: LogbookSortState;
  /** The committed climb-name search; seeds the name field. */
  name: string;
  /** False on someone else's logbook: the copy says "Their", never "Your". */
  viewerIsOwner: boolean;
  /** The grade scale the capsule row's rail uses too. */
  grades: readonly Grade[];
  boardOptions: readonly LogbookBoardOption[];
  /** Entries the live filters match, or null when there is no honest count (the date feed). */
  matchCount: number | null;
  /** Local midnight of today: the latest day the date rows offer. */
  today: Date;
  /** Each control commits as it changes; there is no Apply. */
  onChangeFilters: (patch: Partial<LogbookFilterState>) => void;
  onChangeSort: (sort: LogbookSortState) => void;
  /** Every keystroke of the name field; the parent debounces the commit. */
  onNameChange: (text: string) => void;
  /** The name field's ×, and part of Reset: clears the committed name at once. */
  onClearName: () => void;
  /** Filters, sort and name back to their defaults. */
  onReset: () => void;
  /**
   * Pushes the setter picker, calling `beforePush` (the sheet's suspend) only
   * once the push is going ahead. Returns whether it pushed: a refused push
   * leaves the sheet where it was.
   */
  onOpenSetters: (beforePush: () => void) => boolean;
  /** Open scrolled to this section: the When capsule's "Custom…" lands on the date rows. */
  initialSection?: 'when';
};

// One native detent. The iOS height bound comes from useSheetColumnStyle.
const SHEET_DETENT_FRACTION = 0.9;
const ALL_BOARDS = '';

/**
 * The Logbook's full filter set: the climb-name search, then every filter the
 * capsule row can pin, then sort. Built from the shared filter-sheet parts, so
 * it reads and spaces like the climbs sheet. Everything applies live: X and a
 * swipe only close it. The setter row pushes a picker route; the sheet suspends
 * around it the way the climbs sheet does (useSheetSubRoute).
 */
export function LogbookFilterSheet({
  onDismiss,
  filters,
  sort,
  name,
  viewerIsOwner,
  grades,
  boardOptions,
  matchCount,
  today,
  onChangeFilters,
  onChangeSort,
  onNameChange,
  onClearName,
  onReset,
  onOpenSetters,
  initialSection,
}: LogbookFilterSheetProps) {
  const { t } = useTranslation('you');
  const { systemColors } = useTheme();
  const iosBackgroundStyle = useIosSheetBackgroundStyle();
  const windowInsetBottom = useWindowBottomInset();
  const sheetRef = useRef<BottomSheetModal>(null);

  // Native callbacks can arrive after unmount, or after a close already finished.
  const isMountedRef = useRef(true);
  const closingRef = useRef(false);
  const dismissedRef = useRef(false);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const isCurrentPresentation = useCallback(() => isMountedRef.current && !dismissedRef.current, []);

  // The latest committed state, so the stable handlers below build on what was
  // just published even before the parent re-renders.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const sortRef = useRef(sort);
  sortRef.current = sort;

  const subRoute = useSheetSubRoute<ComponentRef<typeof BottomSheetScrollView>>({ canResume: isCurrentPresentation });
  const { suspended, presentEpoch, isAwaitingReturn, suspend } = subRoute;

  const detentSnapPoints = useMemo(() => [`${SHEET_DETENT_FRACTION * 100}%`], []);
  const snapPoints = useMemo(() => androidSafeSnapPoints(detentSnapPoints), [detentSnapPoints]);
  // On iOS the SwiftUI host can propose an unbounded height; pin the one column
  // child to the detent so the body scrolls (#3330). Android bounds it natively.
  const sheetColumnStyle = useSheetColumnStyle(detentSnapPoints);
  // The sheet mounts only while open and has one detent: nothing to raise.
  const { keyboardOverlap, columnRef, onColumnLayout } = useSheetKeyboardInset({ enabled: true });
  const scrollContentStyle = useMemo(() => ({ paddingBottom: windowInsetBottom + spacing[4] }), [windowInsetBottom]);

  // The name field keeps its own display text (a trailing space survives while
  // typing); the parent debounces the commit.
  const [nameDraft, setNameDraft] = useState(name);
  const nameDraftRef = useRef(nameDraft);
  nameDraftRef.current = nameDraft;
  useEffect(() => {
    if (!visibleSearchTextNeedsSync(nameDraftRef.current, name)) return;
    setNameDraft(name);
  }, [name]);

  const handleNameChange = useCallback(
    (text: string) => {
      if (!isCurrentPresentation() || closingRef.current) return;
      setNameDraft(text);
      onNameChange(text);
    },
    [isCurrentPresentation, onNameChange],
  );
  const handleClearName = useCallback(() => {
    if (!isCurrentPresentation() || closingRef.current) return;
    setNameDraft('');
    onClearName();
  }, [isCurrentPresentation, onClearName]);

  const patchFilters = useCallback(
    (patch: Partial<LogbookFilterState>) => {
      if (!isCurrentPresentation() || closingRef.current) return;
      filtersRef.current = { ...filtersRef.current, ...patch };
      onChangeFilters(patch);
    },
    [isCurrentPresentation, onChangeFilters],
  );
  const commitSort = useCallback(
    (nextSort: LogbookSortState) => {
      if (!isCurrentPresentation() || closingRef.current) return;
      sortRef.current = nextSort;
      onChangeSort(nextSort);
    },
    [isCurrentPresentation, onChangeSort],
  );

  // Every selection is committed already: closing only waits for the native
  // animation before releasing the parent.
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

  // `open: !suspended` lets the setter route dismiss the native sheet without
  // unmounting it, then re-present on return (see useSheetSubRoute).
  const managed = useManagedSheet({ open: !suspended, sheetRef, onClose: handleSheetDismiss });

  const handleReset = useCallback(() => {
    if (!isCurrentPresentation() || closingRef.current) return;
    hapticSelection();
    setNameDraft('');
    onReset();
  }, [isCurrentPresentation, onReset]);

  const handleOpenSetters = useCallback(() => {
    if (!isCurrentPresentation() || isAwaitingReturn() || closingRef.current) return;
    onOpenSetters(suspend);
  }, [isCurrentPresentation, isAwaitingReturn, suspend, onOpenSetters]);

  // Opened from "Custom…": scroll the When block to the top once both of its
  // offsets are known (the section within the body, the block within the section).
  const pendingWhenScrollRef = useRef(initialSection === 'when');
  const ascentsSectionYRef = useRef<number | null>(null);
  const whenBlockYRef = useRef<number | null>(null);
  const { scrollRef } = subRoute;
  const scrollToWhenWhenMeasured = useCallback(() => {
    const sectionY = ascentsSectionYRef.current;
    const blockY = whenBlockYRef.current;
    if (!pendingWhenScrollRef.current || sectionY == null || blockY == null) return;
    pendingWhenScrollRef.current = false;
    scrollRef.current?.scrollTo({ y: Math.max(0, sectionY + blockY - spacing[3]), animated: false });
  }, [scrollRef]);
  const handleAscentsLayout = useCallback(
    (event: LayoutChangeEvent) => {
      ascentsSectionYRef.current = event.nativeEvent.layout.y;
      scrollToWhenWhenMeasured();
    },
    [scrollToWhenWhenMeasured],
  );
  const handleWhenLayout = useCallback(
    (event: LayoutChangeEvent) => {
      whenBlockYRef.current = event.nativeEvent.layout.y;
      scrollToWhenWhenMeasured();
    },
    [scrollToWhenWhenMeasured],
  );

  // --- Pins: one stable toggle per kind, so a pin tap re-renders only its row.
  const { isPinned, togglePin } = useLogbookPinnedChips();
  const pinToggles = useMemo(() => {
    const toggles = {} as Record<LogbookPinnableChipKind, () => void>;
    for (const kind of LOGBOOK_PINNABLE_CHIP_KINDS) toggles[kind] = () => togglePin(kind);
    return toggles;
  }, [togglePin]);
  const pinProps = (kind: LogbookPinnableChipKind) => ({ pinned: isPinned(kind), onTogglePin: pinToggles[kind] });

  // --- Difficulty
  const gradeBound = useMemo<GradeBound>(
    () => ({
      minGradeId: filters.minGrade === '' ? undefined : filters.minGrade,
      maxGradeId: filters.maxGrade === '' ? undefined : filters.maxGrade,
    }),
    [filters.minGrade, filters.maxGrade],
  );
  const handleGradeChange = useCallback(
    (bound: GradeBound) => patchFilters({ minGrade: bound.minGradeId ?? '', maxGrade: bound.maxGradeId ?? '' }),
    [patchFilters],
  );

  // --- Your ascents
  const statusOptions = useMemo(
    () => LOGBOOK_STATUS_SEGMENTS.map((segment) => ({ key: segment, label: logbookStatusLabel(segment, t) })),
    [t],
  );
  const handleStatusChange = useCallback(
    (segment: LogbookStatusSegment) => patchFilters(filtersForStatusSegment(segment)),
    [patchFilters],
  );
  const handleAnyStars = useCallback(() => patchFilters({ minQuality: '' }), [patchFilters]);
  const handleStarsChange = useCallback(
    (stars: number | undefined) => patchFilters({ minQuality: stars ?? '' }),
    [patchFilters],
  );
  const handleDateWindow = useCallback((dateWindow: LogbookDateWindow) => patchFilters({ dateWindow }), [patchFilters]);
  // Only the Custom window reads the dates, so picking one keeps it selected.
  const handleFromDate = useCallback(
    (fromDate: string) => patchFilters({ fromDate, dateWindow: 'custom' }),
    [patchFilters],
  );
  const handleToDate = useCallback((toDate: string) => patchFilters({ toDate, dateWindow: 'custom' }), [patchFilters]);
  // From can't pass To, and neither can pass today. Keyed on the ISO strings so
  // the memo'd rows keep their props between unrelated edits.
  const fromDay = useMemo(() => parseLocalIsoDate(filters.fromDate) ?? undefined, [filters.fromDate]);
  const toDay = useMemo(() => parseLocalIsoDate(filters.toDate) ?? undefined, [filters.toDate]);
  const fromCeiling = toDay && toDay < today ? toDay : today;

  // --- The climb
  const selectedBoard = boardOptions.find((board) => board.boardType === filters.boardType);
  const showBoardControl = boardOptions.length >= 2 || filters.boardType !== '';
  const boardChoices = useMemo(() => {
    const choices = boardOptions.map((board) => ({ value: board.boardType, label: board.label }));
    // A board saved from another logbook stays listed, so it can be cleared.
    if (filters.boardType && !choices.some((choice) => choice.value === filters.boardType)) {
      choices.push({ value: filters.boardType, label: formatBoardDisplayName(filters.boardType) });
    }
    return choices;
  }, [boardOptions, filters.boardType]);
  const layoutChoices = selectedBoard && selectedBoard.layouts.length >= 2 ? selectedBoard.layouts : null;
  const handleBoardChange = useCallback(
    (boardType: string) => patchFilters({ boardType, layoutIds: [] }),
    [patchFilters],
  );
  const handleAllLayouts = useCallback(() => patchFilters({ layoutIds: [] }), [patchFilters]);
  const handleLayoutToggle = useCallback(
    (layoutId: number) => {
      const current = filtersRef.current.layoutIds;
      patchFilters({
        layoutIds: current.includes(layoutId) ? current.filter((id) => id !== layoutId) : [...current, layoutId],
      });
    },
    [patchFilters],
  );
  const angleValue = useMemo(() => logbookAngleRailValue(filters.angleRange), [filters.angleRange]);
  const handleAngleChange = useCallback(
    (next: [number, number] | null) => patchFilters(logbookAnglePatch(next)),
    [patchFilters],
  );
  const handleBenchmarks = useCallback((benchmarkOnly: boolean) => patchFilters({ benchmarkOnly }), [patchFilters]);

  // --- Sort
  const currentSort = logbookSortKeyOf(sort);
  const sortKeyLabels = useMemo<Record<LogbookSortKey, string>>(
    () => ({
      date: t('mobile.logbook.filterSheet.sortKey.date'),
      grade: t('mobile.logbook.filterSheet.sortKey.grade'),
      loggedGrade: viewerIsOwner
        ? t('mobile.logbook.filterSheet.sortKey.yourGrade')
        : t('mobile.logbook.filterSheet.sortKey.theirGrade'),
      climbName: t('mobile.logbook.filterSheet.sortKey.name'),
      attemptCount: t('mobile.logbook.filterSheet.sortKey.attempts'),
    }),
    [t, viewerIsOwner],
  );
  const orderOptions = useMemo(
    () => [
      { key: 'desc' as const, label: t('mobile.logbook.filterSheet.descending') },
      { key: 'asc' as const, label: t('mobile.logbook.filterSheet.ascending') },
    ],
    [t],
  );
  // A new key keeps the order the climber set below it.
  const handleSortKey = useCallback(
    (key: LogbookSortKey) => commitSort(logbookSortFor(key, logbookSortKeyOf(sortRef.current).direction)),
    [commitSort],
  );
  const handleSortOrder = useCallback(
    (direction: LogbookSortDirection) => commitSort(logbookSortFor(logbookSortKeyOf(sortRef.current).key, direction)),
    [commitSort],
  );

  // Reset greys out until there is something to reset, the name included.
  const anyActive =
    countLogbookFilters(filters, nameDraft) > 0 ||
    filters.dateWindow !== DEFAULT_LOGBOOK_FILTERS.dateWindow ||
    isLogbookSortActive(sort);

  const subtitle = matchCount == null ? undefined : t('mobile.logbook.filterSheet.entryCount', { count: matchCount });

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
      {/* One column child bounded to the detent, padded by the keyboard overlap
          (neither native sheet window resizes for the keyboard). */}
      <View
        testID="logbook-filter-column"
        style={keyboardOverlap > 0 ? [sheetColumnStyle, { paddingBottom: keyboardOverlap }] : sheetColumnStyle}
        ref={columnRef}
        onLayout={onColumnLayout}
      >
        <SheetTopBar
          title={t('mobile.logbook.filterSheet.title')}
          subtitle={subtitle}
          leading={{ kind: 'close', onPress: handleClose, accessibilityLabel: t('mobile.logbook.filterSheet.close') }}
          trailing={{ kind: 'forward', label: t('mobile.logbook.reset'), onPress: handleReset, disabled: !anyActive }}
        />

        <BottomSheetScrollView
          ref={subRoute.scrollRef}
          style={styles.scrollView}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={scrollContentStyle}
          onScroll={subRoute.onScroll}
          scrollEventThrottle={32}
          onContentSizeChange={subRoute.onContentSizeChange}
          // A first tap on X / Reset / a chip while the keyboard is up over the
          // name field would otherwise only dismiss the keyboard.
          keyboardShouldPersistTaps="handled"
        >
          <View style={filterSheetStyles.body}>
            <FilterSheetSection title={t('mobile.logbook.filterSheet.sectionName')} first>
              <FilterNameField
                value={nameDraft}
                onChangeText={handleNameChange}
                onClear={handleClearName}
                placeholder={t('mobile.logbook.filterSheet.namePlaceholder')}
                accessibilityLabel={t('mobile.logbook.filterSheet.sectionName')}
              />
            </FilterSheetSection>

            <FilterSheetSection title={t('mobile.logbook.filterSheet.sectionDifficulty')}>
              <FilterLabelRow label={t('mobile.logbook.filterSheet.gradeRange')} {...pinProps('grade')} />
              <GradeRangeRail
                grades={grades}
                bound={gradeBound}
                onChange={handleGradeChange}
                centerOnEmpty={false}
                style={filterSheetStyles.inlineRail}
              />
            </FilterSheetSection>

            <View pointerEvents="box-none" testID="logbook-filter-ascents" onLayout={handleAscentsLayout}>
              <FilterSheetSection
                title={
                  viewerIsOwner
                    ? t('mobile.logbook.filterSheet.sectionYourAscents')
                    : t('mobile.logbook.filterSheet.sectionTheirAscents')
                }
              >
                <FilterLabelRow label={t('mobile.logbook.filterSheet.status')} {...pinProps('status')} />
                <View style={filterSheetStyles.controlGap} />
                <SegmentedControl
                  options={statusOptions}
                  selectedKey={statusSegmentFor(filters)}
                  onSelect={handleStatusChange}
                  accessibilityLabel={t('mobile.logbook.filterSheet.status')}
                />

                <View style={filterSheetStyles.subsectionGap} />
                <FilterLabelRow
                  label={
                    viewerIsOwner
                      ? t('mobile.logbook.filterSheet.yourStars')
                      : t('mobile.logbook.filterSheet.theirStars')
                  }
                  {...pinProps('stars')}
                />
                <View style={filterSheetStyles.ratingRow}>
                  <FilterChip
                    label={t('mobile.logbook.filterSheet.anyStars')}
                    value={undefined}
                    selected={filters.minQuality === ''}
                    onPress={handleAnyStars}
                  />
                  <StarRating
                    value={filters.minQuality === '' ? undefined : filters.minQuality}
                    onChange={handleStarsChange}
                    clearValue={undefined}
                  />
                </View>

                <View style={filterSheetStyles.subsectionGap} />
                <View pointerEvents="box-none" testID="logbook-filter-when" onLayout={handleWhenLayout}>
                  <FilterLabelRow label={t('mobile.logbook.filterSheet.when')} {...pinProps('date')} />
                  <FilterChipGroup>
                    {LOGBOOK_DATE_WINDOWS.map((window) => (
                      <FilterChip
                        key={window}
                        label={logbookDateWindowLabel(window, t)}
                        value={window}
                        selected={filters.dateWindow === window}
                        onPress={handleDateWindow}
                      />
                    ))}
                  </FilterChipGroup>
                  {filters.dateWindow === 'custom' ? (
                    <View style={styles.dateRows}>
                      <DateRangeRow
                        label={t('mobile.logbook.dateFrom')}
                        value={filters.fromDate}
                        onChange={handleFromDate}
                        clearLabel={t('mobile.logbook.dateAny')}
                        maximumDate={fromCeiling}
                      />
                      <DateRangeRow
                        label={t('mobile.logbook.dateTo')}
                        value={filters.toDate}
                        onChange={handleToDate}
                        clearLabel={t('mobile.logbook.dateAny')}
                        minimumDate={fromDay}
                        maximumDate={today}
                      />
                    </View>
                  ) : null}
                </View>
              </FilterSheetSection>
            </View>

            <FilterSheetSection title={t('mobile.logbook.filterSheet.sectionTheClimb')}>
              {showBoardControl ? (
                <>
                  <FilterLabelRow label={t('mobile.logbook.filterSheet.board')} {...pinProps('board')} />
                  <FilterChipGroup>
                    <FilterChip
                      label={t('mobile.filter.allBoards')}
                      value={ALL_BOARDS}
                      selected={filters.boardType === ''}
                      onPress={handleBoardChange}
                    />
                    {boardChoices.map((board) => (
                      <FilterChip
                        key={board.value}
                        label={board.label}
                        value={board.value}
                        selected={filters.boardType === board.value}
                        onPress={handleBoardChange}
                      />
                    ))}
                  </FilterChipGroup>
                  {layoutChoices ? (
                    <>
                      <View style={filterSheetStyles.subsectionGap} />
                      <FilterLabelRow label={t('mobile.logbook.filterSheet.layout')} />
                      <FilterChipGroup>
                        <FilterChip
                          label={t('mobile.logbook.filterSheet.allLayouts')}
                          value={undefined}
                          selected={filters.layoutIds.length === 0}
                          onPress={handleAllLayouts}
                        />
                        {layoutChoices.map((layout) => (
                          <FilterChip
                            key={layout.layoutId}
                            label={layout.label}
                            value={layout.layoutId}
                            selected={filters.layoutIds.includes(layout.layoutId)}
                            onPress={handleLayoutToggle}
                          />
                        ))}
                      </FilterChipGroup>
                    </>
                  ) : null}
                  <View style={filterSheetStyles.subsectionGap} />
                </>
              ) : null}

              <FilterLabelRow label={t('mobile.logbook.angle')} {...pinProps('angle')} />
              <AngleRangeRail value={angleValue} onChange={handleAngleChange} style={filterSheetStyles.inlineRail} />

              <View style={filterSheetStyles.subsectionGap} />
              <FilterLabelRow label={t('mobile.logbook.filterSheet.setter')} {...pinProps('setter')} />
              <FilterTappableRow
                label={t('mobile.logbook.filterSheet.setter')}
                value={logbookSetterLabel(filters.setterUsernames, t) ?? t('mobile.logbook.filterSheet.setterAny')}
                onPress={handleOpenSetters}
              />

              <View style={filterSheetStyles.subsectionGap} />
              <FilterLabelRow label={t('mobile.logbook.filterSheet.benchmarks')} {...pinProps('benchmarks')} />
              <SwitchRow
                label={t('mobile.logbook.filterSheet.onlyBenchmarks')}
                value={filters.benchmarkOnly}
                onValueChange={handleBenchmarks}
              />
            </FilterSheetSection>

            <FilterSheetSection title={t('mobile.logbook.filterSheet.sectionSort')}>
              <FilterLabelRow label={t('mobile.logbook.filterSheet.sortBy')} {...pinProps('sort')} />
              <FilterChipGroup>
                {LOGBOOK_SORT_KEYS.map((key) => (
                  <FilterChip
                    key={key}
                    label={sortKeyLabels[key]}
                    value={key}
                    selected={currentSort.key === key}
                    onPress={handleSortKey}
                  />
                ))}
              </FilterChipGroup>
              <View style={filterSheetStyles.subsectionGap} />
              <FilterLabelRow label={t('mobile.logbook.filterSheet.order')} />
              <View style={filterSheetStyles.controlGap} />
              <SegmentedControl
                options={orderOptions}
                selectedKey={currentSort.direction}
                onSelect={handleSortOrder}
                accessibilityLabel={t('mobile.logbook.filterSheet.order')}
              />
            </FilterSheetSection>
          </View>
        </BottomSheetScrollView>
      </View>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  indicator: {
    width: 36,
    height: 5,
    borderRadius: 3,
  },
  scrollView: {
    flex: 1,
  },
  dateRows: {
    marginTop: spacing[2],
  },
});
