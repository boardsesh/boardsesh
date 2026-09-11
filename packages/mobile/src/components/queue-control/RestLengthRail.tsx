// Rest length as a one-tap chip rail — the tries rail (TickCountRail), applied
// to the other number a climber changes mid-session.
//
// It replaces a segmented control plus a revealed stepper: six segments, of
// which one ("Custom") was not a rest length at all but a mode, and behind it a
// ±1 stepper whose value read "60" while every segment beside it read "1:00".
// Here every rest length is a chip, the chip's label IS the value, and `Off` is
// the head chip rather than a seventh segment competing with six numbers.
//
// The seam after `Off` is deliberate: it is the one chip that turns the deadline
// off rather than setting one, so it gets a rule between it and `0:15` — same
// control, visible break.

import React, { useCallback, useEffect, useMemo, useRef, useState, type ElementRef } from 'react';
import { ScrollView, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { TickChip } from '../tick/TickChip';
import { TICK_GUTTER, TICK_RAIL_TRAIL_INSET } from '../tick/tick-sheet-metrics';
import { railRestOffset, railSnapOffsets, type RailChipLayout } from '../grade/grade-rail-offset';
import { hapticSelection } from '../../lib/haptics';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { REST_LENGTH_OFF, formatRestLengthChipLabel, restLengthRailSeconds } from './rest-length-rail.logic';

/** The rail owns its own leading gutter (it is full-bleed, not inside a padded
 *  row), so the snap table has to subtract it to land a chip flush on the edge. */
const RAIL_LEAD_IN = TICK_GUTTER;

/** The rule between `Off` and the first real rest length. */
const SEAM_WIDTH = 1;
const SEAM_HEIGHT = 24;

type RestLengthChipProps = {
  /** Seconds, or {@link REST_LENGTH_OFF} for the head chip. */
  seconds: number;
  label: string;
  selected: boolean;
  accessibilityLabel: string;
  onSelect: (seconds: number) => void;
  onMeasure: (seconds: number, layout: RailChipLayout) => void;
};

/**
 * One chip, bound to its own rest length.
 *
 * Same reason TickCountRail has TickCountChip: the rail's `.map` must hand
 * `TickChip` the SAME `onPress` / `onLayout` identities every render, or every
 * selection change re-renders all 28 chips instead of the two that changed tone.
 */
const RestLengthChip = React.memo(function RestLengthChip({
  seconds,
  label,
  selected,
  accessibilityLabel,
  onSelect,
  onMeasure,
}: RestLengthChipProps) {
  const handlePress = useCallback(() => onSelect(seconds), [onSelect, seconds]);
  const handleLayout = useCallback(
    ({ nativeEvent }: LayoutChangeEvent) => onMeasure(seconds, nativeEvent.layout),
    [onMeasure, seconds],
  );

  return (
    <TickChip
      label={label}
      tone={selected ? 'selected' : 'neutral'}
      onPress={handlePress}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      onLayout={handleLayout}
    />
  );
});

type RestLengthRailProps = {
  /** The persisted rest length in seconds; `null` is Off. */
  value: number | null;
  onSelect: (nextSeconds: number | null) => void;
  accessibilityLabel: string;
};

export const RestLengthRail = React.memo(function RestLengthRail({
  value,
  onSelect,
  accessibilityLabel,
}: RestLengthRailProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const scrollRef = useRef<ElementRef<typeof ScrollView>>(null);
  const chipLayoutsRef = useRef<Record<number, RailChipLayout>>({});
  const [railWidth, setRailWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  // Bumped on a re-measure so the snap table recomputes off the layout ref
  // without every chip's onLayout rendering the rail.
  const [layoutVersion, setLayoutVersion] = useState(0);
  const didCenterRef = useRef(false);
  // Latched by the first tap or drag: once the climber has touched the rail it
  // must never scroll out from under their thumb.
  const userInteractedRef = useRef(false);
  // The last value the rail ITSELF put on the wire. Anything else arriving in
  // `value` came from outside (the arm row and the sheet write the same setting
  // and can both be mounted), and has to clear the latch.
  const railSelectedRef = useRef(value);

  const railSeconds = useMemo(() => restLengthRailSeconds(value), [value]);

  const snapOffsets = useMemo(() => {
    void layoutVersion;
    return railSnapOffsets(chipLayoutsRef.current, RAIL_LEAD_IN);
  }, [layoutVersion]);

  // Rest with the selected chip readable and flush to a chip start.
  // `railRestOffset` clamps to the scrollable range and snaps DOWN to a chip
  // boundary, so the rail can neither overscroll nor come to rest mid-chip.
  const maybeCenter = useCallback(() => {
    if (userInteractedRef.current || didCenterRef.current) return;
    const offset = railRestOffset({
      layouts: chipLayoutsRef.current,
      focusId: value ?? REST_LENGTH_OFF,
      railWidth,
      contentWidth,
      leadIn: RAIL_LEAD_IN,
      snapToChipStart: true,
    });
    if (offset == null) return;
    didCenterRef.current = true;
    scrollRef.current?.scrollTo({ x: offset, animated: false });
  }, [value, railWidth, contentWidth]);

  useEffect(() => {
    if (railSelectedRef.current !== value) {
      railSelectedRef.current = value;
      userInteractedRef.current = false;
      didCenterRef.current = false;
    }
    if (userInteractedRef.current) return;
    didCenterRef.current = false;
    maybeCenter();
  }, [value, maybeCenter]);

  const handleChipLayout = useCallback(
    (seconds: number, layout: RailChipLayout) => {
      const previous = chipLayoutsRef.current[seconds];
      chipLayoutsRef.current[seconds] = layout;
      if (previous?.x !== layout.x || previous?.width !== layout.width) {
        setLayoutVersion((version) => version + 1);
      }
      maybeCenter();
    },
    [maybeCenter],
  );

  const handleSelect = useCallback(
    (seconds: number) => {
      const next = seconds === REST_LENGTH_OFF ? null : seconds;
      userInteractedRef.current = true;
      railSelectedRef.current = next;
      hapticSelection();
      onSelect(next);
    },
    [onSelect],
  );

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
      accessibilityLabel={accessibilityLabel}
      snapToOffsets={snapOffsets.length > 0 ? snapOffsets : undefined}
      snapToAlignment="start"
      decelerationRate="fast"
      contentContainerStyle={styles.content}
      onScrollBeginDrag={() => {
        userInteractedRef.current = true;
      }}
      onContentSizeChange={handleContentSizeChange}
      onLayout={(event) => {
        setRailWidth(event.nativeEvent.layout.width);
        maybeCenter();
      }}
      testID="rest-length-rail"
    >
      <RestLengthChip
        seconds={REST_LENGTH_OFF}
        label={t('mobile.restTimer.off')}
        selected={value === null}
        accessibilityLabel={t('mobile.restTimer.offAria')}
        onSelect={handleSelect}
        onMeasure={handleChipLayout}
      />
      {/* The seam. Purely decorative — the chips either side carry the meaning —
          so it is hidden from assistive tech rather than announced as a blank. */}
      <View
        style={[styles.seam, { backgroundColor: systemColors.separator }]}
        accessibilityElementsHidden
        importantForAccessibility="no"
        testID="rest-length-rail-seam"
      />
      {railSeconds.map((seconds) => (
        <RestLengthChip
          key={seconds}
          seconds={seconds}
          label={formatRestLengthChipLabel(seconds)}
          selected={value === seconds}
          accessibilityLabel={t('mobile.restTimer.setLengthAria', { time: formatRestLengthChipLabel(seconds) })}
          onSelect={handleSelect}
          onMeasure={handleChipLayout}
        />
      ))}
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingVertical: spacing[1],
    // The rail is full-bleed, so it owns the leading gutter itself (unlike the
    // tick rails, which sit inside a row that already applies it). The trailing
    // inset keeps the last chip short of the edge so the rail reads as
    // scrollable rather than clipped.
    paddingLeft: RAIL_LEAD_IN,
    paddingRight: TICK_RAIL_TRAIL_INSET,
  },
  seam: {
    width: SEAM_WIDTH,
    height: SEAM_HEIGHT,
  },
});
