import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../../Text';
import { ValueSlider } from '../../ValueSlider';
import { spacing } from '../../../theme/tokens';
import type { ParamSpec } from '../types';

const NOTCHES = 20;

/** One slider for a variant parameter: the label shows the value live while dragging, and `onCommit` fires once on release. */
export function ParamSlider({
  spec,
  value,
  onCommit,
}: {
  spec: ParamSpec;
  value: number;
  onCommit: (key: string, value: number) => void;
}) {
  const { key, min, max, step, unit } = spec;
  const [live, setLive] = useState<number | null>(null);
  const shown = live ?? value;

  const round = useCallback(
    (raw: number) => {
      'worklet';
      const snapped = Math.round((raw - min) / step) * step + min;
      return Math.min(max, Math.max(min, Number(snapped.toFixed(6))));
    },
    [min, max, step],
  );
  const notch = useCallback(
    (candidate: number) => {
      'worklet';
      return Math.round(((candidate - min) / (max - min)) * NOTCHES);
    },
    [min, max],
  );
  const adjust = useCallback(
    (candidate: number, direction: 1 | -1) =>
      Math.min(max, Math.max(min, Number((candidate + direction * step).toFixed(6)))),
    [min, max, step],
  );
  const format = useCallback((candidate: number) => `${candidate}${unit ? ` ${unit}` : ''}`, [unit]);
  const handleCommit = useCallback(
    (committed: number) => {
      setLive(null);
      onCommit(key, committed);
    },
    [key, onCommit],
  );

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text variant="subheadline">{spec.label}</Text>
        <Text variant="subheadline" tone="secondary" numeric>
          {format(shown)}
        </Text>
      </View>
      <ValueSlider
        value={value}
        min={min}
        max={max}
        round={round}
        notch={notch}
        format={format}
        adjust={adjust}
        accessibilityLabel={spec.label}
        touchTargetHeight={44}
        onLiveChange={setLive}
        onCommit={handleCommit}
        onCancel={() => setLive(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing[1] },
  header: { flexDirection: 'row', justifyContent: 'space-between' },
});
