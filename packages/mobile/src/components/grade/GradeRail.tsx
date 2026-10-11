import { useCallback, useEffect, useMemo, useRef, useState, type ElementRef } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import type { Grade } from '@boardsesh/shared-schema';
import {
  clearGradeBound,
  collapseToLowerEnd,
  computeGradeTap,
  isAnyGrade,
  isGradeEndpoint,
  isGradeInRange,
  isRangeGrade,
  isSingleGrade,
  type GradeBound,
} from '@boardsesh/climb-filters';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { distinctGradeChipLabels } from './grade-chip-labels';
import { gradeRailCenter } from '../../lib/grade-seed';
import { hapticSelection } from '../../lib/haptics';
import { glassSize } from '../../theme/layout';
import { borderRadius, spacing } from '../../theme/tokens';
import { GradeChip, type GradeChipColorway } from './GradeChip';
import { railRestOffset, railSnapOffsets } from './grade-rail-offset';

// How many frames to re-assert the centring scroll. One scrollTo can be dropped
// while the host sheet is still presenting; a few frames of re-assert lands it.
const CENTER_ASSERT_FRAMES = 4;
// The Range toggle's glyph, in its 44pt capsule.
const RANGE_GLYPH_SIZE = 18;

type ChipLayout = { x: number; width: number };

function sortedGrades(grades: readonly Grade[]): Grade[] {
  return [...grades].sort((firstGrade, secondGrade) => firstGrade.difficultyId - secondGrade.difficultyId);
}

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
  onChange: (next: GradeBound) => void;
  showTitle?: boolean;
  /** Left padding inside the strip, in front of the Any chip (and the title).
   *  The rail has no frame of its own, so this is its container's gutter: the
   *  strip scrolls out to the rail's edge and the first chip rests on the gutter. */
  contentInsetLeft?: number;
  /** Space between the Range toggle and the rail's right edge. */
  contentInsetRight?: number;
  /** The board the grades belong to, so labels follow its scale (MoonBoard's 6A is V2). */
  boardName?: string | null;
  style?: StyleProp<ViewStyle>;
};

/**
 * The grade filter as one plain row: a strip of grade chips that scrolls, a
 * hairline, and a Range toggle pinned at the end. It draws no frame and no
 * handle, since it is a row of whatever holds it (the chrome under the filter
 * chips, a filter sheet, a popover), not a sheet of its own.
 *
 * Range off, a tap picks one grade. Range on, the first tap is one end and the
 * second makes the range (rules in `computeGradeTap`).
 */
export function GradeRangeRail({
  grades: unsortedGrades,
  bound,
  sendDifficultyIds = [],
  lastUsedGradeId,
  centerOnEmpty = true,
  onChange,
  showTitle = false,
  contentInsetLeft = spacing[4],
  contentInsetRight = spacing[4],
  boardName,
  style,
}: GradeRangeRailProps) {
  const { t } = useTranslation('climbs');
  const { systemColors, brandColors } = useTheme();
  const { gradeFormat } = useGradeFormat();
  const scrollRef = useRef<ElementRef<typeof ScrollView>>(null);
  const chipLayoutsRef = useRef<Record<number, ChipLayout>>({});
  const [railWidth, setRailWidth] = useState(0);
  const didCenterRef = useRef(false);
  const centeringRef = useRef(false);
  const centerAssertsRef = useRef(0);
  const centerRafRef = useRef<number | null>(null);
  // Set once the climber taps/drags the rail. After that we never re-centre, so
  // the row can't yank out from under their finger; before that we re-centre as
  // the focus settles (e.g. lastUsedGrade resolving from storage after mount).
  const userInteractedRef = useRef(false);
  // The Range toggle. Local to this mount and never stored: a rail that opens on
  // a range opens with it on, and it stays as the climber left it until the rail
  // closes. A range set from outside the rail while it is open (a recent filter)
  // reads as on too, so the toggle never contradicts the chips beside it.
  const [rangeMode, setRangeMode] = useState(() => isRangeGrade(bound));
  const rangeOn = rangeMode || isRangeGrade(bound);
  // `rangeOn` can be true through the bound alone. A tap that replaces or clears
  // that range would then switch the toggle off under the climber, so every tap
  // on the strip first stores the mode the toggle is showing.
  const keepShownRangeMode = useCallback(() => setRangeMode(rangeOn), [rangeOn]);

  const grades = useMemo(() => sortedGrades(unsortedGrades), [unsortedGrades]);
  // No two chips read the same: "V0 V0 V0" becomes "V0 / 4A", "V0 / 4B"... (#5960).
  const chipLabels = useMemo(
    () => distinctGradeChipLabels(grades, gradeFormat, boardName),
    [grades, gradeFormat, boardName],
  );
  const centerId = useMemo(() => {
    // With centering-on-empty off (the logbook filter), only auto-center when a
    // grade is actually selected; otherwise open at the start, not mid-scrolled.
    if (!centerOnEmpty && bound.minGradeId == null && bound.maxGradeId == null) return undefined;
    return gradeRailCenter(bound, grades, sendDifficultyIds, lastUsedGradeId);
  }, [centerOnEmpty, bound, grades, sendDifficultyIds, lastUsedGradeId]);

  const clearCenterRaf = useCallback(() => {
    if (centerRafRef.current != null) {
      cancelAnimationFrame(centerRafRef.current);
      centerRafRef.current = null;
    }
  }, []);

  // Scroll the focus grade into the centre once both the rail width and the
  // focus chip's position are known. A single scrollTo issued while the host
  // sheet is still presenting can be swallowed (the rail stays pinned at the
  // start), so re-assert the offset across a few frames before latching.
  const startCentering = useCallback(() => {
    if (didCenterRef.current || centeringRef.current) return;
    if (railWidth === 0 || centerId == null) return;
    if (chipLayoutsRef.current[centerId] == null) return;
    centeringRef.current = true;
    centerAssertsRef.current = 0;
    const assertCenter = () => {
      const chipLayout = chipLayoutsRef.current[centerId];
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
  }, [centerId, railWidth]);

  // Re-centre whenever the focus or measured width settles — covers the case
  // where lastUsedGrade resolves from storage a tick after mount (no layout
  // event of its own) and would otherwise leave the rail latched on the default
  // band centre. Skipped once the climber has interacted, so a tap never yanks
  // the row. `startCentering` changes identity only when centerId/railWidth do.
  useEffect(() => {
    if (userInteractedRef.current) return;
    clearCenterRaf();
    didCenterRef.current = false;
    centeringRef.current = false;
    startCentering();
  }, [startCentering, clearCenterRaf]);

  // Cancel any in-flight re-assert loop on unmount.
  useEffect(() => clearCenterRaf, [clearCenterRaf]);

  // The user dragging the rail latches centring for good so it never fights
  // their finger.
  const handleScrollBeginDrag = useCallback(() => {
    clearCenterRaf();
    userInteractedRef.current = true;
    centeringRef.current = false;
    didCenterRef.current = true;
  }, [clearCenterRaf]);

  const handleTapGrade = useCallback(
    (difficultyId: number) => {
      hapticSelection();
      userInteractedRef.current = true;
      didCenterRef.current = true;
      keepShownRangeMode();
      onChange(computeGradeTap(bound, difficultyId, rangeOn));
    },
    [bound, onChange, rangeOn, keepShownRangeMode],
  );

  const handleClear = useCallback(() => {
    hapticSelection();
    userInteractedRef.current = true;
    didCenterRef.current = true;
    keepShownRangeMode();
    onChange(clearGradeBound());
  }, [onChange, keepShownRangeMode]);

  // Turning Range off cannot leave a range behind: keep its lower end. Turning
  // it on leaves the bound alone, so a grade already picked is the first end.
  const handleToggleRange = useCallback(() => {
    hapticSelection();
    setRangeMode(!rangeOn);
    if (rangeOn && isRangeGrade(bound)) onChange(collapseToLowerEnd(bound));
  }, [bound, onChange, rangeOn]);

  const anySelected = isAnyGrade(bound);
  // Range on with one grade picked: any other chip is the second end.
  const awaitingSecondEnd = rangeOn && isSingleGrade(bound);

  return (
    <View style={style}>
      {showTitle ? (
        <View style={[styles.topRow, { paddingStart: contentInsetLeft, paddingEnd: contentInsetRight }]}>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.title}>
            {t('mobile.filter.gradeRange')}
          </Text>
        </View>
      ) : null}
      <View style={styles.rangeRow}>
        <ScrollView
          ref={scrollRef}
          horizontal
          nestedScrollEnabled={Platform.OS === 'android'}
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={styles.railScroll}
          contentContainerStyle={[styles.railContent, { paddingStart: contentInsetLeft }]}
          onScrollBeginDrag={handleScrollBeginDrag}
          onContentSizeChange={startCentering}
          onLayout={(event) => {
            setRailWidth(event.nativeEvent.layout.width);
            startCentering();
          }}
        >
          {/* Any is not a grade, so it passes no grade colour and gets no dot.
              While no filter is set it takes the in-range look: a checkmark on
              the neutral fill. */}
          <GradeChip
            label={t('mobile.search.gradeClear')}
            tone={anySelected ? 'range' : 'neutral'}
            onPress={handleClear}
            accessibilityLabel={
              anySelected ? t('mobile.gradeRail.anyGradeAria') : t('mobile.gradeRail.clearFilterAria')
            }
            accessibilityState={{ selected: anySelected }}
          />
          {grades.map((grade) => {
            const label = chipLabels.get(grade.difficultyId) ?? grade.name;
            const gradeColor = getGradeColor(grade.name) ?? DEFAULT_GRADE_COLOR;
            const endpoint = isGradeEndpoint(bound, grade.difficultyId);
            const insideRange = !endpoint && isGradeInRange(bound, grade.difficultyId);
            const tone = endpoint ? 'selected' : insideRange ? 'range' : 'neutral';
            return (
              <GradeChip
                key={grade.difficultyId}
                label={label}
                tone={tone}
                gradeColor={gradeColor}
                onPress={() => handleTapGrade(grade.difficultyId)}
                accessibilityLabel={
                  endpoint
                    ? t('mobile.gradeRail.selectedFilterAria', { grade: label })
                    : insideRange
                      ? t('mobile.gradeRail.rangeFilterAria', { grade: label })
                      : t('mobile.gradeRail.setFilterAria', { grade: label })
                }
                accessibilityHint={awaitingSecondEnd && !endpoint ? t('mobile.gradeRail.rangeHint') : undefined}
                accessibilityState={{ selected: endpoint }}
                onLayout={({ nativeEvent }) => {
                  chipLayoutsRef.current[grade.difficultyId] = nativeEvent.layout;
                  startCentering();
                }}
              />
            );
          })}
        </ScrollView>
        {/* The hairline is where the strip stops: chips scroll under this edge,
            and the toggle past it stays put. */}
        <View style={[styles.rangeDivider, { backgroundColor: systemColors.separator }]} />
        <PressableSurface
          onPress={handleToggleRange}
          feedback="scale"
          scaleTo={0.94}
          accessibilityRole="togglebutton"
          accessibilityLabel={t('mobile.gradeRail.rangeToggle')}
          accessibilityHint={t('mobile.gradeRail.rangeToggleHint')}
          accessibilityState={{ checked: rangeOn }}
          style={[
            styles.rangeToggle,
            { backgroundColor: rangeOn ? brandColors.primaryFill : systemColors.fill, marginEnd: contentInsetRight },
          ]}
        >
          <Icon name="range" size={RANGE_GLYPH_SIZE} color={rangeOn ? brandColors.onPrimary : systemColors.label} />
        </PressableSurface>
      </View>
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
  rangeRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  railScroll: {
    flex: 1,
  },
  railContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: 52,
    // The leading padding is NOT set here: it comes from contentInsetLeft. The
    // trailing padding is the last chip's clearance from the hairline.
    paddingEnd: spacing[3],
    paddingVertical: spacing[1],
  },
  rangeDivider: {
    width: 1,
    height: spacing[6],
    marginEnd: spacing[2],
  },
  rangeToggle: {
    width: glassSize.inline,
    height: glassSize.inline,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
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
