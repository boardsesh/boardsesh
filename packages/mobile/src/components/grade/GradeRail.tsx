import { useCallback, useEffect, useMemo, useRef, useState, type ElementRef } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import type { Grade } from '@boardsesh/shared-schema';
import {
  RANGE_EXTEND_WINDOW_MS,
  clearGradeBound,
  computeGradeTap,
  extendGradeRange,
  findGradeStop,
  findSelectedGradeStop,
  isAnyGrade,
  isGradeStopEnd,
  isGradeStopInRange,
  isSameGradeBound,
  type GradeBound,
} from '@boardsesh/climb-filters';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { distinctGradeChipLabels } from './grade-chip-labels';
import { gradeRailCenter } from '../../lib/grade-seed';
import { buildGradeRailStops, type GradeRailStop } from '../../lib/grade-stops';
import { hapticSelection } from '../../lib/haptics';
import { spacing } from '../../theme/tokens';
import { GRADE_CHIP_HEIGHT, GradeChip, type GradeChipColorway } from './GradeChip';
import { railRestOffset, railSnapOffsets } from './grade-rail-offset';

// How many frames to re-assert the centring scroll. One scrollTo can be dropped
// while the host sheet is still presenting; a few frames of re-assert lands it.
const CENTER_ASSERT_FRAMES = 4;
// How long a finger rests on a stop before the hold makes a range with it.
const HOLD_TO_EXTEND_MS = 400;

type ChipLayout = { x: number; width: number };

function sortedGrades(grades: readonly Grade[]): Grade[] {
  return [...grades].sort((firstGrade, secondGrade) => firstGrade.difficultyId - secondGrade.difficultyId);
}

/** How the climber changed the bound: a tap on a stop, a touch and hold, or the Any chip. */
export type GradeRailGesture = 'tap' | 'hold' | 'clear';

/** Rides along with every change the rail reports, for the caller's analytics. */
export type GradeRailChange = {
  gesture: GradeRailGesture;
  /**
   * Set only on a tap made while one other stop was selected, the one case the
   * extend window decides: true when the tap landed inside it and made a range,
   * false when it landed after it and switched to the tapped stop.
   */
  withinRangeWindow?: boolean;
};

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
   * that lands while a finger is on the rail is dropped.
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
 * far end makes one without the clock. The rules are `computeGradeTap` and
 * `extendGradeRange`.
 */
export function GradeRangeRail({
  grades: unsortedGrades,
  bound,
  sendDifficultyIds = [],
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
  const { systemColors } = useTheme();
  const { gradeFormat } = useGradeFormat();
  const scrollRef = useRef<ElementRef<typeof ScrollView>>(null);
  // Keyed by each stop's lowest grade id.
  const chipLayoutsRef = useRef<Record<number, ChipLayout>>({});
  const [railWidth, setRailWidth] = useState(0);
  const didCenterRef = useRef(false);
  const centeringRef = useRef(false);
  const centerAssertsRef = useRef(0);
  const centerRafRef = useRef<number | null>(null);
  // Set once the climber taps/drags the rail. After that we do not re-centre, so
  // the row can't yank out from under their finger; before that we re-centre as
  // the focus settles (e.g. lastUsedGrade resolving from storage after mount).
  // Only a new `recenterKey` clears it.
  const userInteractedRef = useRef(false);
  // A finger resting on the strip, and a drag under way. While either is true
  // the rail does not scroll itself, whatever asks.
  const touchingRef = useRef(false);
  const draggingRef = useRef(false);
  // When a tap on this rail last left exactly one stop selected. A tap on
  // another stop inside RANGE_EXTEND_WINDOW_MS of it makes a range. Undefined
  // when the selection did not come from such a tap (it was there at mount, it
  // came from outside, it is a range, a hold made it): then the next tap
  // switches stop, however soon it lands.
  const lastSinglePickAtRef = useRef<number | undefined>(undefined);

  const grades = useMemo(() => sortedGrades(unsortedGrades), [unsortedGrades]);
  const stops = useMemo(
    () => buildGradeRailStops(unsortedGrades, gradeFormat, boardName),
    [unsortedGrades, gradeFormat, boardName],
  );
  const centerStopId = useMemo(() => {
    // With centering-on-empty off (the logbook filter), only auto-center when a
    // grade is actually selected; otherwise open at the start, not mid-scrolled.
    if (!centerOnEmpty && isAnyGrade(bound)) return undefined;
    const centerGradeId = gradeRailCenter(bound, grades, sendDifficultyIds, lastUsedGradeId);
    return centerGradeId == null ? undefined : findGradeStop(stops, centerGradeId)?.minGradeId;
  }, [centerOnEmpty, bound, grades, stops, sendDifficultyIds, lastUsedGradeId]);

  const clearCenterRaf = useCallback(() => {
    if (centerRafRef.current != null) {
      cancelAnimationFrame(centerRafRef.current);
      centerRafRef.current = null;
    }
  }, []);

  // Scroll the focus stop into the centre once both the rail width and the
  // stop's position are known. A single scrollTo issued while the host sheet is
  // still presenting can be swallowed (the rail stays pinned at the start), so
  // re-assert the offset across a few frames before latching.
  const startCentering = useCallback(() => {
    if (didCenterRef.current || centeringRef.current) return;
    if (touchingRef.current || draggingRef.current) return;
    if (railWidth === 0 || centerStopId == null) return;
    if (chipLayoutsRef.current[centerStopId] == null) return;
    centeringRef.current = true;
    centerAssertsRef.current = 0;
    const assertCenter = () => {
      const chipLayout = chipLayoutsRef.current[centerStopId];
      if (chipLayout) {
        const offset = Math.max(0, chipLayout.x + chipLayout.width / 2 - railWidth / 2);
        scrollRef.current?.scrollTo({ x: offset, animated: false });
      }
      centerAssertsRef.current += 1;
      if (centerAssertsRef.current >= CENTER_ASSERT_FRAMES) {
        didCenterRef.current = true;
        centeringRef.current = false;
        centerRafRef.current = null;
        return;
      }
      centerRafRef.current = requestAnimationFrame(assertCenter);
    };
    assertCenter();
  }, [centerStopId, railWidth]);

  // Re-centre whenever the focus or measured width settles — covers the case
  // where lastUsedGrade resolves from storage a tick after mount (no layout
  // event of its own) and would otherwise leave the rail latched on the default
  // band centre. Skipped once the climber has interacted, so a tap never yanks
  // the row. `startCentering` changes identity only when the centre stop or the
  // width does.
  useEffect(() => {
    if (userInteractedRef.current) return;
    clearCenterRaf();
    didCenterRef.current = false;
    centeringRef.current = false;
    startCentering();
  }, [startCentering, clearCenterRaf]);

  // A new `recenterKey` lifts the interaction latch and centres on the current
  // selection again. Not on mount (the effect above has that), and not while a
  // finger is on the rail: that request is dropped, the row stays where the
  // climber is holding it.
  const seenRecenterKeyRef = useRef(recenterKey);
  useEffect(() => {
    if (seenRecenterKeyRef.current === recenterKey) return;
    seenRecenterKeyRef.current = recenterKey;
    if (touchingRef.current || draggingRef.current) return;
    userInteractedRef.current = false;
    clearCenterRaf();
    didCenterRef.current = false;
    centeringRef.current = false;
    startCentering();
  }, [recenterKey, startCentering, clearCenterRaf]);

  // Cancel any in-flight re-assert loop on unmount.
  useEffect(() => clearCenterRaf, [clearCenterRaf]);

  // A finger landing on the strip stops a centring scroll that is still asserting.
  const handleTouchStart = useCallback(() => {
    touchingRef.current = true;
    clearCenterRaf();
    centeringRef.current = false;
  }, [clearCenterRaf]);

  // The user dragging the rail latches centring so it never fights their finger.
  const handleScrollBeginDrag = useCallback(() => {
    draggingRef.current = true;
    clearCenterRaf();
    userInteractedRef.current = true;
    centeringRef.current = false;
    didCenterRef.current = true;
  }, [clearCenterRaf]);

  const markInteracted = useCallback(() => {
    userInteractedRef.current = true;
    didCenterRef.current = true;
  }, []);

  // Report a change the climber made. A hold on a stop that already ends the
  // range changes nothing, so it reports nothing.
  const commit = useCallback(
    (next: GradeBound, change: GradeRailChange) => {
      if (!isSameGradeBound(next, bound)) onChange(next, change);
    },
    [bound, onChange],
  );

  const anySelected = isAnyGrade(bound);
  const selectedStop = findSelectedGradeStop(bound, stops);

  const handleTapStop = useCallback(
    (stop: GradeRailStop) => {
      hapticSelection();
      markInteracted();
      const tappedAt = Date.now();
      const lastSinglePickAt = lastSinglePickAtRef.current;
      const withinExtendWindow = lastSinglePickAt !== undefined && tappedAt - lastSinglePickAt < RANGE_EXTEND_WINDOW_MS;
      const next = computeGradeTap(bound, stop, stops, withinExtendWindow);
      // Any tap that leaves one stop selected is a fresh pick and opens the
      // window; a tap that made a range or cleared closes it.
      lastSinglePickAtRef.current = findSelectedGradeStop(next, stops) ? tappedAt : undefined;
      // The window only decides a tap on a different stop than the one selected.
      const decidedByWindow = selectedStop !== undefined && stop !== selectedStop;
      commit(next, { gesture: 'tap', ...(decidedByWindow && { withinRangeWindow: withinExtendWindow }) });
    },
    [bound, stops, selectedStop, commit, markInteracted],
  );

  // Touch and hold makes or moves a range without the clock. It also closes the
  // window, so the tap after a hold is a plain pick.
  const handleHoldStop = useCallback(
    (stop: GradeRailStop) => {
      hapticSelection();
      markInteracted();
      lastSinglePickAtRef.current = undefined;
      commit(extendGradeRange(bound, stop, stops), { gesture: 'hold' });
    },
    [bound, stops, commit, markInteracted],
  );

  const handleClear = useCallback(() => {
    hapticSelection();
    markInteracted();
    lastSinglePickAtRef.current = undefined;
    commit(clearGradeBound(), { gesture: 'clear' });
  }, [commit, markInteracted]);

  // A screen reader cannot count on the timing of a second tap, so the hint
  // names the gesture that does not need it. With one stop selected, every other
  // stop can be the far end of a range.
  const farEndHint = t('mobile.gradeRail.rangeHoldHint');

  return (
    <View style={style}>
      {showTitle ? (
        <View style={[styles.topRow, { paddingStart: contentInsetLeft, paddingEnd: contentInsetRight }]}>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.title}>
            {t('mobile.filter.gradeRange')}
          </Text>
        </View>
      ) : null}
      <ScrollView
        ref={scrollRef}
        horizontal
        nestedScrollEnabled={Platform.OS === 'android'}
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        style={styles.railScroll}
        contentContainerStyle={[styles.railContent, { paddingStart: contentInsetLeft, paddingEnd: contentInsetRight }]}
        onTouchStart={handleTouchStart}
        onTouchEnd={(event) => {
          touchingRef.current = event.nativeEvent.touches.length > 0;
        }}
        onTouchCancel={() => {
          touchingRef.current = false;
        }}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={() => {
          // The finger is up. Clearing both here means a touch whose end was
          // never delivered cannot block re-centring for good.
          draggingRef.current = false;
          touchingRef.current = false;
        }}
        onContentSizeChange={startCentering}
        onLayout={(event) => {
          setRailWidth(event.nativeEvent.layout.width);
          startCentering();
        }}
      >
        {/* Any is not a grade, so it passes no grade colour: selected (no filter
            set) it keeps the neutral fill and takes only the ring. */}
        <GradeChip
          label={t('mobile.search.gradeClear')}
          tone={anySelected ? 'selected' : 'neutral'}
          onPress={handleClear}
          accessibilityLabel={anySelected ? t('mobile.gradeRail.anyGradeAria') : t('mobile.gradeRail.clearFilterAria')}
          accessibilityState={{ selected: anySelected }}
        />
        {stops.map((stop) => {
          const end = isGradeStopEnd(bound, stop);
          const insideRange = isGradeStopInRange(bound, stop);
          const tone = end ? 'selected' : insideRange ? 'range' : 'neutral';
          return (
            <GradeChip
              key={stop.minGradeId}
              label={stop.label}
              tone={tone}
              gradeColor={stop.gradeColor}
              onPress={() => handleTapStop(stop)}
              onLongPress={() => handleHoldStop(stop)}
              delayLongPress={HOLD_TO_EXTEND_MS}
              accessibilityLabel={
                end
                  ? t('mobile.gradeRail.selectedFilterAria', { grade: stop.label })
                  : insideRange
                    ? t('mobile.gradeRail.rangeFilterAria', { grade: stop.label })
                    : t('mobile.gradeRail.setFilterAria', { grade: stop.label })
              }
              accessibilityHint={selectedStop && stop !== selectedStop ? farEndHint : undefined}
              accessibilityState={{ selected: end }}
              onLayout={({ nativeEvent }) => {
                chipLayoutsRef.current[stop.minGradeId] = nativeEvent.layout;
                startCentering();
              }}
            />
          );
        })}
      </ScrollView>
    </View>
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
  topRow: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
  },
  title: {
    fontWeight: '600',
  },
  railScroll: {
    flexGrow: 0,
  },
  railContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    // The chip plus the vertical padding below, which gives its hit slop room.
    minHeight: GRADE_CHIP_HEIGHT + spacing[1] * 2,
    // Horizontal padding is NOT set here: it comes from contentInsetLeft /
    // contentInsetRight.
    paddingVertical: spacing[1],
  },
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
