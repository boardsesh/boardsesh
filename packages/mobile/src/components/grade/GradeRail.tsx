import { useCallback, useEffect, useMemo, useRef, useState, type ElementRef } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import type { Grade } from '@boardsesh/shared-schema';
import { findGradeStop, isAnyGrade, type GradeBound } from '@boardsesh/climb-filters';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { distinctGradeChipLabels } from './grade-chip-labels';
import { gradeRailCenter } from '../../lib/grade-seed';
import { buildGradeRailStops, type GradeRailStop } from '../../lib/grade-stops';
import { hapticSelection } from '../../lib/haptics';
import { spacing } from '../../theme/tokens';
import { GradeChip, type GradeChipColorway } from './GradeChip';
import { railRestOffset, railSnapOffsets } from './grade-rail-offset';
import { RangeRail, type RangeRailChange, type RangeRailStopState } from './RangeRail';

type ChipLayout = { x: number; width: number };

function sortedGrades(grades: readonly Grade[]): Grade[] {
  return [...grades].sort((firstGrade, secondGrade) => firstGrade.difficultyId - secondGrade.difficultyId);
}

/** Rides along with every change the rail reports, for the caller's analytics. */
export type GradeRailChange = RangeRailChange;

// A stable default, so an unset `sendDifficultyIds` does not re-run the centre memo.
const EMPTY_DIFFICULTY_IDS: readonly number[] = [];

type GradeRangeRailProps = {
  grades: readonly Grade[];
  bound: GradeBound;
  sendDifficultyIds?: readonly number[];
  /**
   * The climber's last-used grade. When nothing is selected (and centerOnEmpty
   * is on), the rail opens centred on this instead of the generic band default,
   * so reopening the filter lands on the grade they actually climb.
   */
  lastUsedGradeId?: number;
  /**
   * Auto-center the rail on mount when there is no grade selection. True (the
   * default) surfaces the climber's typical grades; the logbook filter passes
   * false so an unset rail opens at the easiest grade instead of mid-scrolled.
   */
  centerOnEmpty?: boolean;
  onChange: (next: GradeBound, change: GradeRailChange) => void;
  /**
   * A value whose change centres the rail on the current selection again, even
   * after the climber has scrolled or tapped it. A rail that stays on screen
   * needs it: the climbs list bumps it when the screen regains focus. A change
   * that lands while a finger is on the rail is dropped. (A `bound` that changes
   * from outside the rail re-centres it the same way, with no key needed.)
   */
  recenterKey?: number;
  showTitle?: boolean;
  /** Left padding inside the strip, in front of the Any chip (and the title).
   *  The rail has no frame of its own, so this is its container's gutter: the
   *  strip scrolls out to the rail's edge and the first chip rests on the gutter. */
  contentInsetLeft?: number;
  /** Right padding inside the strip, after the last chip. */
  contentInsetRight?: number;
  /** The board the grades belong to, so labels follow its scale (MoonBoard's 6A is V2). */
  boardName?: string | null;
  style?: StyleProp<ViewStyle>;
};

/**
 * The grade filter as one plain row: a strip of grade stops that scrolls. It
 * draws no frame and no handle, since it is a row of whatever holds it (the
 * chrome under the filter chips, a filter sheet, a popover), not a sheet of its
 * own.
 *
 * A stop is one chip. Grades that read the same in the climber's format share
 * one (`buildGradeRailStops`), so "V0" is a single chip under V grades.
 *
 * A tap picks one stop, and a tap on a second stop within
 * RANGE_EXTEND_WINDOW_MS of that pick makes a range. A touch and hold on the
 * far end makes one without the clock. The gestures, centring and range window
 * live in the shared `RangeRail`; this wrapper supplies the grade stops, the
 * centre grade and the grade wording.
 */
export function GradeRangeRail({
  grades: unsortedGrades,
  bound,
  sendDifficultyIds = EMPTY_DIFFICULTY_IDS,
  lastUsedGradeId,
  centerOnEmpty = true,
  onChange,
  recenterKey,
  showTitle = false,
  contentInsetLeft = spacing[4],
  contentInsetRight = spacing[4],
  boardName,
  style,
}: GradeRangeRailProps) {
  const { t } = useTranslation('climbs');
  const { gradeFormat } = useGradeFormat();

  const grades = useMemo(() => sortedGrades(unsortedGrades), [unsortedGrades]);
  const stops = useMemo(
    () =>
      buildGradeRailStops(unsortedGrades, gradeFormat, boardName).map((stop) => ({ ...stop, color: stop.gradeColor })),
    [unsortedGrades, gradeFormat, boardName],
  );
  const centerStopId = useMemo(() => {
    // With centering-on-empty off (the logbook filter), only auto-center when a
    // grade is actually selected; otherwise open at the start, not mid-scrolled.
    if (!centerOnEmpty && isAnyGrade(bound)) return undefined;
    const centerGradeId = gradeRailCenter(bound, grades, sendDifficultyIds, lastUsedGradeId);
    return centerGradeId == null ? undefined : findGradeStop(stops, centerGradeId)?.minGradeId;
  }, [centerOnEmpty, bound, grades, stops, sendDifficultyIds, lastUsedGradeId]);

  const stopAccessibilityLabel = useCallback(
    (stop: GradeRailStop, state: RangeRailStopState) =>
      state === 'end'
        ? t('mobile.gradeRail.selectedFilterAria', { grade: stop.label })
        : state === 'inRange'
          ? t('mobile.gradeRail.rangeFilterAria', { grade: stop.label })
          : t('mobile.gradeRail.setFilterAria', { grade: stop.label }),
    [t],
  );

  return (
    <RangeRail
      stops={stops}
      bound={bound}
      centerStopId={centerStopId}
      onChange={onChange}
      recenterKey={recenterKey}
      title={showTitle ? t('mobile.filter.gradeRange') : undefined}
      anyLabel={t('mobile.search.gradeClear')}
      anySelectedAccessibilityLabel={t('mobile.gradeRail.anyGradeAria')}
      clearAccessibilityLabel={t('mobile.gradeRail.clearFilterAria')}
      stopAccessibilityLabel={stopAccessibilityLabel}
      // A screen reader cannot count on the timing of a second tap, so the hint
      // names the gesture that does not need it.
      rangeHoldHint={t('mobile.gradeRail.rangeHoldHint')}
      contentInsetLeft={contentInsetLeft}
      contentInsetRight={contentInsetRight}
      style={style}
    />
  );
}

type GradeSingleSelectRailProps = {
  grades: readonly Grade[];
  selectedDifficultyId: number | null | undefined;
  consensusDifficultyId?: number | null;
  onSelect: (difficultyId: number | undefined) => void;
  allowClear?: boolean;
  /**
   * Which palette the chips paint from. `grade` (the default) keeps the grade
   * ramp; the tick sheets pass `selection` so the rail reads as "which one did I
   * pick?" against the sheet's single violet-and-amber budget.
   */
  colorway?: GradeChipColorway;
  /** Left padding inside the rail's content. A rail rendered inside a row that
   *  already owns the gutter passes 0 so its first chip sits on the row's
   *  control seam. */
  contentInsetLeft?: number;
  /** Right padding inside the rail's content — the trailing inset that keeps the
   *  last chip short of the screen edge so the rail reads as scrollable. */
  contentInsetRight?: number;
  /** The board the grades belong to, so labels follow its scale (MoonBoard's 6A is V2). */
  boardName?: string | null;
  style?: StyleProp<ViewStyle>;
};

export function GradeSingleSelectRail({
  grades: unsortedGrades,
  selectedDifficultyId,
  consensusDifficultyId,
  onSelect,
  allowClear = true,
  colorway = 'grade',
  contentInsetLeft = spacing[4],
  contentInsetRight = spacing[4],
  boardName,
  style,
}: GradeSingleSelectRailProps) {
  const { t } = useTranslation('climbs');
  const { gradeFormat } = useGradeFormat();
  const scrollRef = useRef<ElementRef<typeof ScrollView>>(null);
  const chipLayoutsRef = useRef<Record<number, ChipLayout>>({});
  const [railWidth, setRailWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  // Bumped whenever a chip re-measures, so the snap table recomputes off the
  // layout ref without every chip's onLayout forcing a render of its own.
  const [layoutVersion, setLayoutVersion] = useState(0);
  const didCenterRef = useRef(false);
  // Latched by the first tap or drag: after the climber has touched the rail it
  // must never scroll itself out from under their thumb. Reset only when the rail
  // takes on a new identity (below) — never on `focusId`, since a tap moves the
  // focus and re-centring there IS the yank.
  const userInteractedRef = useRef(false);
  const grades = useMemo(() => sortedGrades(unsortedGrades), [unsortedGrades]);
  // No two chips read the same: "V0 V0 V0" becomes "V0 / 4A", "V0 / 4B"... (#5960).
  const chipLabels = useMemo(
    () => distinctGradeChipLabels(grades, gradeFormat, boardName),
    [grades, gradeFormat, boardName],
  );
  const focusId = selectedDifficultyId ?? consensusDifficultyId ?? undefined;

  // Snapping is a tick-sheet behaviour. Every other consumer (the generator
  // picker) opened this rail before the tick redesign and expects a free scroll
  // that just rests on the focus chip, so gate the three snap props on colorway.
  const snapsToChips = colorway === 'selection';

  const snapOffsets = useMemo(() => {
    void layoutVersion;
    return railSnapOffsets(chipLayoutsRef.current, contentInsetLeft);
  }, [layoutVersion, contentInsetLeft]);

  // What makes this a DIFFERENT rail rather than the same one with a new pick:
  // the grade set it renders, and whose consensus grade it is pointing at. Both
  // change when the sheet is reused for another climb or board while staying
  // mounted; neither changes when the climber taps a chip.
  const railIdentity = useMemo(
    () => `${consensusDifficultyId ?? ''}|${grades.map((grade) => grade.difficultyId).join(',')}`,
    [consensusDifficultyId, grades],
  );

  // Rest with the focus chip readable and flush to a chip start. `railRestOffset`
  // clamps to the scrollable range and snaps DOWN to a chip boundary, so the rail
  // can neither overscroll past its content nor come to rest mid-chip.
  const maybeCenter = useCallback(() => {
    if (userInteractedRef.current || didCenterRef.current) return;
    const offset = railRestOffset({
      layouts: chipLayoutsRef.current,
      focusId,
      railWidth,
      contentWidth,
      leadIn: contentInsetLeft,
      snapToChipStart: snapsToChips,
    });
    if (offset == null) return;
    didCenterRef.current = true;
    scrollRef.current?.scrollTo({ x: offset, animated: false });
  }, [focusId, railWidth, contentWidth, contentInsetLeft, snapsToChips]);

  // A new rail starts fresh: drop both latches so it rests on its own focus chip
  // even if the previous climb's rail had been dragged. One effect (rather than a
  // reset effect plus a centring effect) so the reset can never land in a commit
  // where the centring pass has already run.
  const railIdentityRef = useRef(railIdentity);
  useEffect(() => {
    if (railIdentityRef.current !== railIdentity) {
      railIdentityRef.current = railIdentity;
      userInteractedRef.current = false;
      didCenterRef.current = false;
    }
    maybeCenter();
  }, [railIdentity, maybeCenter]);

  const handleChipLayout = useCallback(
    (difficultyId: number, layout: ChipLayout) => {
      const previous = chipLayoutsRef.current[difficultyId];
      chipLayoutsRef.current[difficultyId] = layout;
      if (previous?.x !== layout.x || previous?.width !== layout.width) {
        setLayoutVersion((version) => version + 1);
      }
      maybeCenter();
    },
    [maybeCenter],
  );

  const handleContentSizeChange = useCallback(
    (width: number) => {
      setContentWidth(width);
      maybeCenter();
    },
    [maybeCenter],
  );

  const handleSelect = useCallback(
    (difficultyId: number) => {
      userInteractedRef.current = true;
      hapticSelection();
      onSelect(allowClear && selectedDifficultyId === difficultyId ? undefined : difficultyId);
    },
    [allowClear, selectedDifficultyId, onSelect],
  );

  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      snapToOffsets={snapsToChips && snapOffsets.length > 0 ? snapOffsets : undefined}
      snapToAlignment={snapsToChips ? 'start' : undefined}
      decelerationRate={snapsToChips ? 'fast' : undefined}
      onScrollBeginDrag={() => {
        userInteractedRef.current = true;
      }}
      contentContainerStyle={[
        styles.singleSelectContent,
        style,
        { paddingStart: contentInsetLeft, paddingEnd: contentInsetRight },
      ]}
      onContentSizeChange={handleContentSizeChange}
      onLayout={(event) => {
        setRailWidth(event.nativeEvent.layout.width);
        maybeCenter();
      }}
    >
      {grades.map((grade) => {
        const label = chipLabels.get(grade.difficultyId) ?? grade.name;
        const gradeColor = getGradeColor(grade.name) ?? DEFAULT_GRADE_COLOR;
        const selected = grade.difficultyId === selectedDifficultyId;
        const consensus = !selected && grade.difficultyId === consensusDifficultyId;
        return (
          <GradeChip
            key={grade.difficultyId}
            label={label}
            tone={selected ? 'selected' : consensus ? 'consensus' : 'neutral'}
            colorway={colorway}
            gradeColor={gradeColor}
            onPress={() => handleSelect(grade.difficultyId)}
            accessibilityLabel={
              selected
                ? t('mobile.gradeRail.selectedLogGradeAria', { grade: label })
                : consensus
                  ? t('mobile.gradeRail.consensusGradeAria', { grade: label })
                  : t('mobile.gradeRail.setLogGradeAria', { grade: label })
            }
            accessibilityState={{ selected }}
            onLayout={({ nativeEvent }) => handleChipLayout(grade.difficultyId, nativeEvent.layout)}
          />
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  singleSelectContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    // Horizontal padding is NOT set here: it comes from contentInsetLeft /
    // contentInsetRight so `railRestOffset` can subtract the exact lead-in and
    // land each chip flush against the rail's left edge.
    paddingVertical: spacing[2],
  },
});
