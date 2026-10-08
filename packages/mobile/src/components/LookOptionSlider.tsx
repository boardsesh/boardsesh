import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ValueSlider } from './ValueSlider';
import { Text } from './Text';
import { useReduceMotion } from '../hooks/use-reduce-motion';
import { spacing } from '../theme/tokens';

export type LookOptionSliderProps = {
  options: readonly { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
  accessibilityLabel: string;
  disabled?: boolean;
  testID?: string;
};

function roundIndex(index: number) {
  'worklet';
  return Math.round(index);
}

/** A discrete choice: dragging previews locally; release keeps that choice. */
export function LookOptionSlider({
  options,
  value,
  onChange,
  accessibilityLabel,
  disabled = false,
  testID,
}: LookOptionSliderProps) {
  const reduceMotion = useReduceMotion();
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.id === value),
  );
  const selected = options[selectedIndex];
  const [committedIndex, setCommittedIndex] = useState(selectedIndex);
  const latestRef = useRef({ options, onChange, disabled, value });
  latestRef.current = { options, onChange, disabled, value };
  const lastLiveIdRef = useRef(value);

  // An external reset updates the thumb; echoes of a live preview must not turn
  // a cancelled gesture into a committed choice.
  useEffect(() => {
    if (disabled || value !== lastLiveIdRef.current) {
      lastLiveIdRef.current = value;
      setCommittedIndex(selectedIndex);
    }
  }, [value, selectedIndex, disabled]);

  const changeIndex = useCallback((index: number) => {
    const latest = latestRef.current;
    if (latest.disabled) return;
    const option = latest.options[Math.max(0, Math.min(latest.options.length - 1, Math.round(index)))];
    if (!option || option.id === lastLiveIdRef.current) return;
    lastLiveIdRef.current = option.id;
    latest.onChange(option.id);
  }, []);
  const commitIndex = useCallback(
    (index: number) => {
      if (latestRef.current.disabled) return;
      setCommittedIndex(index);
      changeIndex(index);
    },
    [changeIndex],
  );
  const cancel = useCallback(() => changeIndex(committedIndex), [changeIndex, committedIndex]);
  const adjust = useCallback(
    (index: number, direction: 1 | -1) => Math.max(0, Math.min(options.length - 1, index + direction)),
    [options.length],
  );
  const format = useCallback((index: number) => options[Math.round(index)]?.label ?? '', [options]);
  const inactive = disabled || options.length < 2;

  return (
    <View style={styles.root}>
      <Text variant="headline" style={styles.label}>
        {selected?.label}
      </Text>
      <View
        style={styles.touchTarget}
        pointerEvents={inactive ? 'none' : 'auto'}
        accessible={inactive}
        accessibilityRole={inactive ? 'adjustable' : undefined}
        accessibilityLabel={inactive ? accessibilityLabel : undefined}
        accessibilityValue={inactive ? { text: selected?.label ?? '' } : undefined}
        accessibilityState={inactive ? { disabled: true } : undefined}
        testID={inactive ? testID : undefined}
      >
        <View
          style={styles.track}
          accessibilityElementsHidden={inactive}
          importantForAccessibility={inactive ? 'no-hide-descendants' : 'auto'}
        >
          {options.length > 1 ? (
            <ValueSlider
              value={Math.min(committedIndex, options.length - 1)}
              min={0}
              max={options.length - 1}
              round={roundIndex}
              notch={roundIndex}
              format={format}
              adjust={adjust}
              accessibilityLabel={accessibilityLabel}
              reduceMotion={reduceMotion}
              touchTargetHeight={44}
              disabled={inactive}
              onLiveChange={changeIndex}
              onCommit={commitIndex}
              onCancel={cancel}
              testID={inactive ? undefined : testID}
            />
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignSelf: 'stretch', paddingHorizontal: spacing[5] },
  label: { textAlign: 'center' },
  touchTarget: { minHeight: 44, justifyContent: 'center' },
  track: { paddingVertical: spacing[2] },
});
