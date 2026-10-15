import { useCallback, useEffect, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { NativeMarkerSlider } from './NativeMarkerSlider';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { brandControlTint } from '../../theme/expo-ui-modifiers';
import { spacing } from '../../theme/tokens';

/**
 * A drag-to-set slider for one numeric render setting (marker brush/size in
 * Classic, glow reach/plateau share/veil/fill opacity in Boardsesh). Extracted
 * from the old AccessibilitySettingsScreen so every numeric knob on the "Board
 * look" screen (issue #2202) uses the platform slider, with a responder fallback on the browser.
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
  /** A settings row shows its name in place of the track's endpoint labels. */
  showLabel?: boolean;
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
  return Math.min(max, Math.max(min, Math.round(stepped * 1000) / 1000));
}

export function MarkerMultiplierSlider({
  accessibilityLabel,
  showLabel = false,
  value,
  min,
  max,
  step,
  format,
  onChange,
  onChangeEnd,
}: MarkerMultiplierSliderProps) {
  const { systemColors, brandColors } = useTheme();
  // The control tint the settings forms' native Slider and Switch use, so this
  // slider matches them. The foreground violet, not the fill: the track sits on
  // the card with no white text over it.
  const onTrackColor = brandControlTint(brandColors);
  const lastAppliedValueRef = useRef(value);
  useEffect(() => {
    lastAppliedValueRef.current = value;
  }, [value]);
  const handleValueChange = useCallback(
    (nextValue: number) => {
      const stepped = normalizeToStep(nextValue, min, max, step);
      lastAppliedValueRef.current = stepped;
      onChange(stepped);
    },
    [min, max, step, onChange],
  );
  const handleValueChangeEnd = useCallback(() => {
    onChangeEnd?.(lastAppliedValueRef.current);
  }, [onChangeEnd]);

  const handleAccessibilityAction = useCallback(
    (event: { nativeEvent: { actionName: string } }) => {
      if (event.nativeEvent.actionName !== 'increment' && event.nativeEvent.actionName !== 'decrement') return;
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
    >
      <View style={styles.labels}>
        <Text
          variant={showLabel ? 'subheadline' : 'caption1'}
          color={systemColors.secondaryLabel}
          style={showLabel ? styles.settingLabel : undefined}
        >
          {showLabel ? accessibilityLabel : format(min)}
        </Text>
        <Text variant="headline">{valueText}</Text>
        {showLabel ? null : (
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {format(max)}
          </Text>
        )}
      </View>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <NativeMarkerSlider
          value={value}
          min={min}
          max={max}
          step={step}
          accessibilityLabel={accessibilityLabel}
          color={onTrackColor}
          onValueChange={handleValueChange}
          onValueChangeEnd={handleValueChangeEnd}
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
  settingLabel: {
    flex: 1,
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
    marginStart: -12,
    borderRadius: 12,
    borderWidth: 2,
  },
});
