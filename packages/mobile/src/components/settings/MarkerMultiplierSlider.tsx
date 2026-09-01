import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, View, StyleSheet, type GestureResponderEvent } from 'react-native';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

/**
 * A drag-to-set slider for one numeric render setting (marker brush/size in
 * Classic, glow reach/plateau share/veil/fill opacity in Boardsesh). Extracted
 * from the old AccessibilitySettingsScreen so every numeric knob on the "Board
 * look" screen (issue #2202) shares one PanResponder implementation instead of
 * six near-identical copies.
 *
 * `onChange` fires continuously while dragging (and from the increment/decrement
 * accessibility action) — wire it to local draft state for a live label/thumb.
 * `onChangeEnd` fires once, with the final stepped value, when the drag ends.
 * A caller that writes straight to the persisted settings store (rather than
 * through a separate Save button, like the old brush/size sheets did) MUST
 * commit there, not in `onChange`: the store write is an AsyncStorage round
 * trip that notifies every subscriber, and firing it once per touch-move event
 * would spam disk writes and re-renders down a whole drag gesture.
 */
export type MarkerMultiplierSliderProps = {
  accessibilityLabel: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Renders the live value (and the track's min/max end labels). */
  format: (value: number) => string;
  onChange: (value: number) => void;
  onChangeEnd?: (value: number) => void;
};

function normalizeToStep(raw: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, raw));
  const steps = Math.round((clamped - min) / step);
  const stepped = min + steps * step;
  // Guards against float dust (0.1 + 0.2 territory) without claiming the
  // precision the persisted store itself owns — sanitizeBoardseshRenderSettings
  // rounds to two decimals on every write regardless of what this hands it.
  return Math.round(stepped * 1000) / 1000;
}

export function MarkerMultiplierSlider({
  accessibilityLabel,
  value,
  min,
  max,
  step,
  format,
  onChange,
  onChangeEnd,
}: MarkerMultiplierSliderProps) {
  const { systemColors } = useTheme();
  const trackRef = useRef<View>(null);
  const trackLayoutRef = useRef<{ pageLeft: number; width: number } | null>(null);
  // The last value `applyPageX` actually applied via `onChange`. RN seeds
  // `gestureState.moveX` at 0 and only updates it on a touch-move, so a tap
  // that releases (or is interrupted) without ever moving reports
  // `moveX === 0` — recomputing the release/terminate value from that
  // coordinate would silently commit `min`. Committing this ref instead means
  // release and terminate always land on wherever the gesture actually left
  // the thumb (the grant coordinate, if the touch never moved).
  const lastAppliedValueRef = useRef<number | null>(null);
  const ratio = (value - min) / (max - min);

  const valueFromPageX = useCallback(
    (pageX: number, trackLayout: { pageLeft: number; width: number }): number | null => {
      if (trackLayout.width <= 0) return null;
      const nextRatio = Math.max(0, Math.min(1, (pageX - trackLayout.pageLeft) / trackLayout.width));
      return normalizeToStep(min + nextRatio * (max - min), min, max, step);
    },
    [max, min, step],
  );

  const applyPageX = useCallback(
    (pageX: number, trackLayout: { pageLeft: number; width: number }) => {
      const nextValue = valueFromPageX(pageX, trackLayout);
      if (nextValue === null) return;
      lastAppliedValueRef.current = nextValue;
      onChange(nextValue);
    },
    [onChange, valueFromPageX],
  );

  const measureTrackAndSetFromPageX = useCallback(
    (pageX: number) => {
      trackRef.current?.measure((_x, _y, width, _height, pageLeft) => {
        if (width <= 0) return;
        const trackLayout = { pageLeft, width };
        trackLayoutRef.current = trackLayout;
        applyPageX(pageX, trackLayout);
      });
    },
    [applyPageX],
  );

  const setFromPageX = useCallback(
    (pageX: number) => {
      const trackLayout = trackLayoutRef.current;
      if (trackLayout) {
        applyPageX(pageX, trackLayout);
        return;
      }
      measureTrackAndSetFromPageX(pageX);
    },
    [applyPageX, measureTrackAndSetFromPageX],
  );

  const commitLastAppliedValue = useCallback(() => {
    if (!onChangeEnd) return;
    const finalValue = lastAppliedValueRef.current;
    if (finalValue !== null) onChangeEnd(finalValue);
  }, [onChangeEnd]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event: GestureResponderEvent) => measureTrackAndSetFromPageX(event.nativeEvent.pageX),
        onPanResponderMove: (_event, gestureState) => setFromPageX(gestureState.moveX),
        onPanResponderRelease: () => commitLastAppliedValue(),
        onPanResponderTerminate: () => commitLastAppliedValue(),
      }),
    [commitLastAppliedValue, measureTrackAndSetFromPageX, setFromPageX],
  );

  const handleAccessibilityAction = useCallback(
    (event: { nativeEvent: { actionName: string } }) => {
      const delta = event.nativeEvent.actionName === 'increment' ? step : -step;
      const nextValue = normalizeToStep(value + delta, min, max, step);
      onChange(nextValue);
      onChangeEnd?.(nextValue);
    },
    [max, min, onChange, onChangeEnd, step, value],
  );

  const valueText = format(value);

  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ text: valueText }}
      accessibilityActions={ACCESSIBILITY_ACTIONS}
      onAccessibilityAction={handleAccessibilityAction}
      style={styles.container}
      {...panResponder.panHandlers}
    >
      <View style={styles.labels}>
        <Text variant="caption1" color={systemColors.secondaryLabel}>
          {format(min)}
        </Text>
        <Text variant="headline">{valueText}</Text>
        <Text variant="caption1" color={systemColors.secondaryLabel}>
          {format(max)}
        </Text>
      </View>
      <View
        ref={trackRef}
        onLayout={() => {
          trackLayoutRef.current = null;
        }}
        style={[styles.track, { backgroundColor: systemColors.separator }]}
      >
        <View
          style={[
            styles.fill,
            { backgroundColor: systemColors.accent, width: `${Math.max(0, Math.min(1, ratio)) * 100}%` },
          ]}
        />
        <View
          style={[
            styles.thumb,
            {
              backgroundColor: systemColors.background,
              borderColor: systemColors.accent,
              left: `${Math.max(0, Math.min(1, ratio)) * 100}%`,
            },
          ]}
        />
      </View>
    </View>
  );
}

/**
 * Local-draft + commit-on-release for a slider that writes straight to the
 * persisted settings store (no separate sheet with its own Save button, like
 * the Classic marker brush/size sheets have). `draftValue` tracks every
 * in-drag `onChange`; `handleChangeEnd` is the `onChangeEnd` to commit through
 * — the only place this ever calls `commit`, so a whole drag gesture writes to
 * AsyncStorage once, not once per touch-move event.
 *
 * `draftValue` re-seeds whenever `externalValue` changes (a preset apply, Reset
 * all, or the initial mount) — safe because `commit` finishing is itself an
 * `externalValue` change that resolves to the same number.
 */
export function useCommittedSliderValue(
  externalValue: number,
  commit: (value: number) => void,
): { draftValue: number; setDraftValue: (value: number) => void; handleChangeEnd: (value: number) => void } {
  const [draftValue, setDraftValue] = useState(externalValue);

  useEffect(() => {
    setDraftValue(externalValue);
  }, [externalValue]);

  const handleChangeEnd = useCallback((value: number) => commit(value), [commit]);

  return { draftValue, setDraftValue, handleChangeEnd };
}

const ACCESSIBILITY_ACTIONS = [{ name: 'increment' }, { name: 'decrement' }] as const;

const styles = StyleSheet.create({
  container: {
    gap: spacing[3],
    paddingVertical: spacing[2],
  },
  labels: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[2],
  },
  track: {
    height: 6,
    borderRadius: 3,
  },
  fill: {
    height: 6,
    borderRadius: 3,
  },
  thumb: {
    position: 'absolute',
    top: -9,
    width: 24,
    height: 24,
    marginLeft: -12,
    borderRadius: 12,
    borderWidth: 2,
  },
});
