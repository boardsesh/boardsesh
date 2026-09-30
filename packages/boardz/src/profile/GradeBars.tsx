import { StyleSheet, View } from 'react-native';
import type { RawStackedBars } from '@boardsesh/profile-stats';
import { bandColor, gradeBand } from '../grades/grades';
import { Text } from '../ui/Text';
import { useTheme } from '../ui/theme';

/** The grade pyramid: sends per grade, hardest on top, each bar in its grade band. */
export function GradeBars({ bars }: { bars: RawStackedBars }) {
  const theme = useTheme();
  const rows = bars.bars
    .map((bar) => ({
      key: bar.key,
      label: bar.label,
      total: bar.segments.reduce((sum, segment) => sum + segment.value, 0),
    }))
    .filter((row) => row.total > 0)
    .reverse();
  const most = Math.max(1, ...rows.map((row) => row.total));

  return (
    <View style={styles.list}>
      {rows.map((row) => (
        <View key={row.key} style={styles.row} accessible accessibilityLabel={`${row.label}: ${row.total} sent`}>
          <Text variant="mono" tone="secondary" style={styles.label}>
            {row.label}
          </Text>
          <View style={styles.track}>
            <View
              style={[
                styles.bar,
                {
                  width: `${(row.total / most) * 100}%`,
                  backgroundColor: bandColor(theme.grades, gradeBand(row.label)) ?? theme.fg1,
                },
              ]}
            />
          </View>
          <Text variant="mono" tone="tertiary" style={styles.count}>
            {row.total}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  label: { width: 40 },
  track: { flex: 1, alignItems: 'center' },
  bar: { height: 9, minWidth: 4, borderRadius: 2 },
  count: { width: 28, textAlign: 'right' },
});
