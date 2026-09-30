import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius, spacing } from './tokens';

type StatTileProps = {
  label: string;
  value: string;
  unit?: string;
  /** "+8 vs Aug": shown with an arrow, in muted success or danger. */
  delta?: string;
  /** Colour for the value, e.g. a grade's band. */
  valueColor?: string;
  style?: StyleProp<ViewStyle>;
};

/** A hairline tile: mono label, light mono figure. */
export function StatTile({ label, value, unit, delta, valueColor, style }: StatTileProps) {
  const theme = useTheme();
  const down = delta?.trim().startsWith('-') ?? false;
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}${unit ? ` ${unit}` : ''}${delta ? `, ${delta}` : ''}`}
      style={[styles.tile, { backgroundColor: theme.bgSurface, borderColor: theme.border1 }, style]}
    >
      <Text variant="label">{label}</Text>
      <View style={styles.valueRow}>
        <Text variant="figure" color={valueColor} numberOfLines={1} style={styles.shrink}>
          {value}
        </Text>
        {unit ? (
          <Text variant="caption" tone="tertiary">
            {unit}
          </Text>
        ) : null}
      </View>
      {delta ? (
        <Text variant="mono" color={down ? theme.danger : theme.success}>
          {down ? '↓ ' : '↑ '}
          {delta.replace(/^[+-]/, '')}
        </Text>
      ) : null}
    </View>
  );
}

export type Readout = {
  label: string;
  value: string;
  unit?: string;
  valueColor?: string;
  /** Widens this cell, e.g. for a clock that has run past an hour. */
  grow?: number;
};

/** A hairline-bounded row of figures, the Graphite way to show a few numbers. */
export function ReadoutStrip({ items }: { items: readonly Readout[] }) {
  const theme = useTheme();
  return (
    <View style={[styles.strip, { borderColor: theme.border2 }]}>
      {items.map((item, index) => (
        <View
          key={item.label}
          accessible
          accessibilityLabel={`${item.label}: ${item.value}${item.unit ? ` ${item.unit}` : ''}`}
          style={[
            styles.cell,
            { flex: item.grow ?? 1 },
            index > 0 && { borderLeftWidth: 1, borderLeftColor: theme.border2, paddingLeft: spacing.md },
          ]}
        >
          <Text variant="label" style={styles.cellLabel}>
            {item.label}
          </Text>
          <View style={styles.valueRow}>
            <Text variant="value" color={item.valueColor} numberOfLines={1} style={styles.shrink}>
              {item.value}
            </Text>
            {item.unit ? (
              <Text variant="caption" tone="tertiary">
                {item.unit}
              </Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    gap: spacing.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
  },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  shrink: { flexShrink: 1 },
  strip: { flexDirection: 'row', borderTopWidth: 1, borderBottomWidth: 1 },
  cell: { minWidth: 0, gap: 6, paddingVertical: 10 },
  cellLabel: { fontSize: 9, lineHeight: 11 },
});
