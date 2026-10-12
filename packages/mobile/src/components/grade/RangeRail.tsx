import { useCallback, useEffect, useRef, useState, type ElementRef } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import {
  RANGE_EXTEND_WINDOW_MS,
  clearGradeBound,
  computeGradeTap,
  extendGradeRange,
  findSelectedGradeStop,
  isAnyGrade,
  isGradeStopEnd,
  isGradeStopInRange,
  isSameGradeBound,
  type GradeBound,
  type GradeStop,
} from '@boardsesh/climb-filters';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { hapticSelection } from '../../lib/haptics';
import { spacing } from '../../theme/tokens';
import { GRADE_CHIP_HEIGHT, GradeChip } from './GradeChip';

// How many frames to re-assert the centring scroll. One scrollTo can be dropped
// while the host sheet is still presenting; a few frames of re-assert lands it.
const CENTER_ASSERT_FRAMES = 4;
// How long a finger rests on a stop before the hold makes a range with it.
const HOLD_TO_EXTEND_MS = 400;

type ChipLayout = { x: number; width: number };

/**
 * One chip of a range rail: the run of ids it covers (ends included), its label,
 * and the colour its selected and in-range states paint with. A stop with no
 * colour keeps the neutral fill when selected and takes only the ring.
 */
export type RangeRailStop = GradeStop & { label: string; color?: string };

/** Rides along with every change the rail reports, for the caller's analytics. */
export type RangeRailChange = {
  /** How the climber changed the bound: a tap on a stop, a touch and hold, or the Any chip. */
  gesture: 'tap' | 'hold' | 'clear';
  /**
   * Set only on a tap made while one other stop was selected, the one case the
   * extend window decides: true when the tap landed inside it and made a range,
   * false when it landed after it and switched to the tapped stop.
   */
  withinRangeWindow?: boolean;
};

/** Where a stop sits relative to the bound, for its accessibility label. */
export type RangeRailStopState = 'end' | 'inRange' | 'outside';

export type RangeRailProps<Stop extends RangeRailStop> = {
  /** The rail's chips, lowest first. Keep the array stable across renders. */
  stops: readonly Stop[];
  bound: GradeBound;
  /**
   * The lowest id of the stop to open centred on. The caller works it out (the
   * grade rail from the climber's history, the angle rail from the selection),
   * so the rail itself knows nothing about what its stops stand for.
   */
  centerStopId?: number;
  onChange: (next: GradeBound, change: RangeRailChange) => void;
  /**
   * A value whose change centres the rail on the current selection again, even
   * after the climber has scrolled or tapped it. A change that lands while a
   * finger is on the rail is dropped. (A `bound` that changes from outside the
   * rail re-centres it the same way, with no key needed.)
   */
  recenterKey?: number;
  /** A small title above the strip. Most hosts label the rail themselves. */
  title?: string;
  /** The label of the leading "Any" chip, which clears the bound. */
  anyLabel: string;
  /** The Any chip's accessibility label while nothing is selected. */
  anySelectedAccessibilityLabel: string;
  /** The Any chip's accessibility label while a bound is set (it clears it). */
  clearAccessibilityLabel: string;
  /** Names a stop for a screen reader, including where it sits in the bound. */
  stopAccessibilityLabel: (stop: Stop, state: RangeRailStopState) => string;
  /**
   * The hint every other stop carries while one stop is selected: a screen
   * reader cannot count on the timing of a second tap, so this names the hold.
   */
  rangeHoldHint: string;
  /** Left padding inside the strip, in front of the Any chip (and the title).
   *  The rail has no frame of its own, so this is its container's gutter: the
   *  strip scrolls out to the rail's edge and the first chip rests on the gutter. */
  contentInsetLeft?: number;
  /** Right padding inside the strip, after the last chip. */
  contentInsetRight?: number;
  style?: StyleProp<ViewStyle>;
};

/**
 * A filter range as one plain row: a strip of stops that scrolls. It draws no
 * frame and no handle, since it is a row of whatever holds it (the chrome under
 * the filter chips, a filter sheet, a popover), not a sheet of its own.
 *
 * A tap picks one stop, and a tap on a second stop within
 * RANGE_EXTEND_WINDOW_MS of that pick makes a range. A touch and hold on the
 * far end makes one without the clock. The rules are `computeGradeTap` and
 * `extendGradeRange`: they work on any ascending run of integer ids, so the
 * grade rail (difficulty ids) and the angle rail (degrees) share them.
 */
export function RangeRail<Stop extends RangeRailStop>({
  stops,
  bound,
  centerStopId,
  onChange,
  recenterKey,
  title,
  anyLabel,
  anySelectedAccessibilityLabel,
  clearAccessibilityLabel,
  stopAccessibilityLabel,
  rangeHoldHint,
  contentInsetLeft = spacing[4],
  contentInsetRight = spacing[4],
  style,
}: RangeRailProps<Stop>) {
  const { systemColors } = useTheme();
  const scrollRef = useRef<ElementRef<typeof ScrollView>>(null);
  // Keyed by each stop's lowest id.
  const chipLayoutsRef = useRef<Record<number, ChipLayout>>({});
  const [railWidth, setRailWidth] = useState(0);
  const didCenterRef = useRef(false);
  const centeringRef = useRef(false);
  const centerAssertsRef = useRef(0);
  const centerRafRef = useRef<number | null>(null);
  // Set once the climber taps/drags the rail. After that we do not re-centre, so
  // the row can't yank out from under their finger; before that we re-centre as
  // the focus settles (e.g. lastUsedGrade resolving from storage after mount).
  // A new `recenterKey` clears it, and so does a selection made somewhere else.
  const userInteractedRef = useRef(false);
  // A finger resting on the strip, and a drag under way. While either is true
  // the rail does not scroll itself, whatever asks.
  const touchingRef = useRef(false);
  const draggingRef = useRef(false);
  // When a tap on this rail last left one stop selected. A tap on another stop
  // inside RANGE_EXTEND_WINDOW_MS of it makes a range. Undefined whenever the
  // selection on screen is not that tap's: it was there at mount, it is a range,
  // a hold or the Any chip made it, or the bound has since changed from outside
  // the rail (see the effect on `bound` below). Then the next tap switches stop,
  // however soon it lands.
  const lastSinglePickAtRef = useRef<number | undefined>(undefined);
  // The bound this rail last reported through onChange, until the parent hands
  // it back as `bound`. A `bound` that changes to anything else was set
  // somewhere else: Filters, a recent filter, a token, a restore.
  const reportedBoundRef = useRef<GradeBound | null>(null);

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
  // where the centre stop resolves a tick after mount (no layout event of its
  // own) and would otherwise leave the rail latched on an earlier centre.
  // Skipped once the climber has interacted, so a tap never yanks the row.
  // `startCentering` changes identity only when the centre stop or the width does.
  useEffect(() => {
    if (userInteractedRef.current) return;
    clearCenterRaf();
    didCenterRef.current = false;
    centeringRef.current = false;
    startCentering();
  }, [startCentering, clearCenterRaf]);

  // Lift the interaction latch and centre on the current selection again. Not
  // while a finger is on the rail: that request is dropped, the row stays where
  // the climber is holding it.
  const recenter = useCallback(() => {
    if (touchingRef.current || draggingRef.current) return;
    userInteractedRef.current = false;
    clearCenterRaf();
    didCenterRef.current = false;
    centeringRef.current = false;
    startCentering();
  }, [startCentering, clearCenterRaf]);

  // A new `recenterKey` asks for that. Not on mount: the effect above has it.
  const seenRecenterKeyRef = useRef(recenterKey);
  useEffect(() => {
    if (seenRecenterKeyRef.current === recenterKey) return;
    seenRecenterKeyRef.current = recenterKey;
    recenter();
  }, [recenterKey, recenter]);

  // So does a selection made somewhere else: without it, a far stop applied
  // from Filters or a recent filter stays off screen once the climber has
  // touched the rail. It is not this rail's pick either, so it closes the range
  // window: the next tap on another stop switches, it does not extend.
  const seenBoundRef = useRef(bound);
  useEffect(() => {
    if (isSameGradeBound(seenBoundRef.current, bound)) return;
    seenBoundRef.current = bound;
    const reportedBound = reportedBoundRef.current;
    reportedBoundRef.current = null;
    if (reportedBound && isSameGradeBound(reportedBound, bound)) return;
    lastSinglePickAtRef.current = undefined;
    recenter();
  }, [bound, recenter]);

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
    (next: GradeBound, change: RangeRailChange) => {
      if (isSameGradeBound(next, bound)) return;
      reportedBoundRef.current = next;
      onChange(next, change);
    },
    [bound, onChange],
  );

  const anySelected = isAnyGrade(bound);
  const selectedStop = findSelectedGradeStop(bound, stops);

  const handleTapStop = useCallback(
    (stop: Stop) => {
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
    (stop: Stop) => {
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

  return (
    <View style={style}>
      {title ? (
        <View style={[styles.topRow, { paddingStart: contentInsetLeft, paddingEnd: contentInsetRight }]}>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.title}>
            {title}
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
        {/* Any is not a stop, so it passes no colour: selected (no filter set)
            it keeps the neutral fill and takes only the ring. */}
        <GradeChip
          label={anyLabel}
          tone={anySelected ? 'selected' : 'neutral'}
          onPress={handleClear}
          accessibilityLabel={anySelected ? anySelectedAccessibilityLabel : clearAccessibilityLabel}
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
              gradeColor={stop.color}
              onPress={() => handleTapStop(stop)}
              onLongPress={() => handleHoldStop(stop)}
              delayLongPress={HOLD_TO_EXTEND_MS}
              accessibilityLabel={stopAccessibilityLabel(stop, end ? 'end' : insideRange ? 'inRange' : 'outside')}
              accessibilityHint={selectedStop && stop !== selectedStop ? rangeHoldHint : undefined}
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

const styles = StyleSheet.create({
  topRow: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
  },
  title: {
    fontWeight: '600',
  },
  // flexGrow 0 + the min height below keep the strip from collapsing inside a
  // native bottom sheet, where a horizontal gesture-handler ScrollView can be
  // handed no height of its own.
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
});
