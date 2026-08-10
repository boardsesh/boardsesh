// Tries as a one-tap chip rail.
//
// Tries is 28% of all tick interactions and used to be the weakest affordance on
// the sheet: a grey minus / violet plus pair at 1.11:1, three taps to get from 1
// to 4, and two separate hand-rolled implementations (InlineTriesPicker in the
// create sheet, an inline pair in the edit sheet). One rail replaces both, any
// visible count is one tap, and a screen-reader user can jump straight to '7'
// instead of swiping an adjustable six times.
import React, { useCallback, useEffect, useMemo, useRef, useState, type ElementRef } from 'react';
import { ScrollView, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { MIN_ATTEMPT_COUNT } from '@boardsesh/play-view';
import { TickChip } from './TickChip';
import { railRestOffset, railSnapOffsets, type RailChipLayout } from '../grade/grade-rail-offset';
import { hapticSelection } from '../../lib/haptics';
import { useTheme } from '../../providers/theme-provider';
import { TICK_COUNT_RAIL_MIN_CHIPS, TICK_RAIL_TRAIL_INSET } from './tick-sheet-metrics';

/** The rail sits inside a row that already owns the gutter, so its content
 *  starts flush on the control seam — no lead-in to subtract. */
const RAIL_LEAD_IN = 0;

/** Label of the trailing chip that walks past the rendered range. Punctuation,
 *  identical in every locale; its meaning is carried by `moreTriesAria`. */
const MORE_CHIP_LABEL = '+';

type TickCountChipProps = {
  count: number;
  selected: boolean;
  disabled: boolean;
  /** Translated outside the chip — a plain string, so it stays memo-stable. */
  accessibilityLabel: string;
  onSelect: (count: number) => void;
  onMeasure: (count: number, layout: RailChipLayout) => void;
};

/**
 * One chip, bound to its own count.
 *
 * It exists so the rail's `.map` hands `TickChip` the SAME `onPress` and
 * `onLayout` identities on every render. Inline arrows in the map defeat
 * `TickChip`'s `React.memo` outright: every count change re-rendered all 16
 * chips (and their `PressableSurface` + `Text` subtrees) instead of the two that
 * actually changed tone. See docs/react-native-performance.md.
 */
const TickCountChip = React.memo(function TickCountChip({
  count,
  selected,
  disabled,
  accessibilityLabel,
  onSelect,
  onMeasure,
}: TickCountChipProps) {
  const handlePress = useCallback(() => onSelect(count), [onSelect, count]);
  const handleLayout = useCallback(
    ({ nativeEvent }: LayoutChangeEvent) => onMeasure(count, nativeEvent.layout),
    [onMeasure, count],
  );

  return (
    <TickChip
      label={String(count)}
      tone={selected ? 'selected' : 'neutral'}
      onPress={handlePress}
      accessibilityLabel={accessibilityLabel}
      // `disabled` travels with `selected`: under a flash the edit sheet's Tries
      // row is inert, and without this the rail still offers ~15 focusable
      // "Set to N tries" buttons that do nothing when activated.
      accessibilityState={{ selected, disabled }}
      onLayout={handleLayout}
    />
  );
});

type TickCountRailProps = {
  value: number;
  /** Floor of the rendered range. Defaults to the same floor the save path
   *  clamps to, so the rail can never show a count the mutation would reject. */
  min?: number;
  onSelect: (next: number) => void;
  disabled?: boolean;
  accessibilityLabel: string;
  /** Identity of the thing being counted — the climb uuid in practice. Both host
   *  sheets stay mounted between climbs, so a value change alone cannot tell a
   *  new climb from the climber tapping a chip: loading a different climb that
   *  happens to have the same try count would leave the rail parked where the
   *  previous one was dragged. Changing this drops the scroll latches. */
  resetKey?: string;
};

export const TickCountRail = React.memo(function TickCountRail({
  value,
  min = MIN_ATTEMPT_COUNT,
  onSelect,
  disabled = false,
  accessibilityLabel,
  resetKey,
}: TickCountRailProps) {
  const { t } = useTranslation('climbs');
  const { spacing } = useTheme();
  const scrollRef = useRef<ElementRef<typeof ScrollView>>(null);
  const chipLayoutsRef = useRef<Record<number, RailChipLayout>>({});
  const [railWidth, setRailWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  // Bumped whenever a chip re-measures, so the snap table recomputes off the
  // layout ref without every chip's onLayout rendering the rail.
  const [layoutVersion, setLayoutVersion] = useState(0);
  const didCenterRef = useRef(false);
  // Latched by the first tap or drag: after the climber has touched the rail it
  // must never scroll itself out from under their thumb.
  const userInteractedRef = useRef(false);
  // The last count the rail ITSELF put on the wire. Anything else arriving in
  // `value` came from outside — a new climb loaded into a still-mounted sheet —
  // and has to clear the latch. PlayDrawer keeps LogAscentSheet mounted for the
  // life of the player, so without this the second climb's rail opens parked on
  // the first climb's scroll position.
  const railSelectedRef = useRef(value);

  const counts = useMemo(() => {
    const last = Math.max(TICK_COUNT_RAIL_MIN_CHIPS, value);
    const range: number[] = [];
    for (let count = min; count <= last; count += 1) range.push(count);
    return range;
  }, [min, value]);

  const snapOffsets = useMemo(() => {
    void layoutVersion;
    return railSnapOffsets(chipLayoutsRef.current, RAIL_LEAD_IN);
  }, [layoutVersion]);

  // Rest with the selected count readable and flush to a chip start.
  // `railRestOffset` clamps to the scrollable range and snaps DOWN to a chip
  // boundary, so the rail can neither overscroll nor come to rest mid-chip.
  const maybeCenter = useCallback(() => {
    if (userInteractedRef.current || didCenterRef.current) return;
    const offset = railRestOffset({
      layouts: chipLayoutsRef.current,
      focusId: value,
      railWidth,
      contentWidth,
      leadIn: RAIL_LEAD_IN,
      // This rail snaps while scrolling, so it must also come to rest on a chip
      // start rather than mid-chip.
      snapToChipStart: true,
    });
    if (offset == null) return;
    didCenterRef.current = true;
    scrollRef.current?.scrollTo({ x: offset, animated: false });
  }, [value, railWidth, contentWidth]);

  const resetKeyRef = useRef(resetKey);
  useEffect(() => {
    // Reset BEFORE the bail-out: the latch is what makes the rail hold still
    // for the climber, but it must not outlive the climb it was set on.
    //
    // A new climb is the authoritative signal, because a value change alone
    // cannot distinguish one from a chip tap — and a different climb carrying
    // the same try count changes no value at all.
    const climbChanged = resetKeyRef.current !== resetKey;
    if (climbChanged) resetKeyRef.current = resetKey;
    if (climbChanged || railSelectedRef.current !== value) {
      railSelectedRef.current = value;
      userInteractedRef.current = false;
      didCenterRef.current = false;
    }
    if (userInteractedRef.current) return;
    didCenterRef.current = false;
    maybeCenter();
  }, [value, resetKey, maybeCenter]);

  const handleChipLayout = useCallback(
    (count: number, layout: RailChipLayout) => {
      const previous = chipLayoutsRef.current[count];
      chipLayoutsRef.current[count] = layout;
      if (previous?.x !== layout.x || previous?.width !== layout.width) {
        setLayoutVersion((version) => version + 1);
      }
      maybeCenter();
    },
    [maybeCenter],
  );

  const handleSelect = useCallback(
    (next: number) => {
      if (disabled) return;
      userInteractedRef.current = true;
      railSelectedRef.current = next;
      hapticSelection();
      onSelect(next);
    },
    [disabled, onSelect],
  );

  const handleMore = useCallback(() => handleSelect(value + 1), [handleSelect, value]);

  const handleContentSizeChange = useCallback(
    (width: number) => {
      setContentWidth(width);
      maybeCenter();
    },
    [maybeCenter],
  );

  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      scrollEnabled={!disabled}
      accessibilityLabel={accessibilityLabel}
      snapToOffsets={snapOffsets.length > 0 ? snapOffsets : undefined}
      snapToAlignment="start"
      decelerationRate="fast"
      contentContainerStyle={[styles.content, { gap: spacing[2], paddingVertical: spacing[1] }]}
      onScrollBeginDrag={() => {
        userInteractedRef.current = true;
      }}
      onContentSizeChange={handleContentSizeChange}
      onLayout={(event) => {
        setRailWidth(event.nativeEvent.layout.width);
        maybeCenter();
      }}
    >
      {counts.map((count) => (
        <TickCountChip
          key={count}
          count={count}
          selected={count === value}
          disabled={disabled}
          accessibilityLabel={t('mobile.tick.setTriesAria', { count })}
          onSelect={handleSelect}
          onMeasure={handleChipLayout}
        />
      ))}
      <TickChip
        label={MORE_CHIP_LABEL}
        onPress={handleMore}
        accessibilityLabel={t('mobile.tick.moreTriesAria')}
        accessibilityState={{ disabled }}
      />
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    // The row owns the leading gutter (TICK_CONTROL_ORIGIN); the rail only adds
    // the trailing inset that keeps the last chip short of the screen edge.
    paddingLeft: RAIL_LEAD_IN,
    paddingRight: TICK_RAIL_TRAIL_INSET,
  },
});
