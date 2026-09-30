import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { RawActivityHeatmap } from '@boardsesh/profile-stats';
import { withAlpha } from '../ui/color';
import { Text } from '../ui/Text';
import { useTheme } from '../ui/theme';
import { spacing } from '../ui/tokens';

const GAP = 3;

/** One square per day, a column per week, in ink that deepens on busier days. */
export function ActivityCalendar({ heatmap }: { heatmap: RawActivityHeatmap }) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const cellSize = width > 0 ? (width - GAP * (heatmap.weeks - 1)) / heatmap.weeks : 0;
  const activeDays = heatmap.days.filter((day) => day.count > 0).length;
  const weeks = Array.from({ length: heatmap.weeks }, (_, week) => heatmap.days.slice(week * 7, week * 7 + 7));

  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      accessible
      accessibilityLabel={`${activeDays} days on the board in the last ${heatmap.weeks} weeks`}
    >
      {cellSize > 0 ? (
        <View style={styles.grid}>
          {weeks.map((days, week) => (
            <View key={days[0]?.date ?? week} style={styles.week}>
              {days.map((day) => (
                <View
                  key={day.date}
                  style={{
                    width: cellSize,
                    height: cellSize,
                    borderRadius: 2,
                    backgroundColor:
                      day.count === 0
                        ? theme.bgSurface3
                        : withAlpha(theme.fg1, 0.3 + 0.7 * (day.count / Math.max(1, heatmap.maxCount))),
                  }}
                />
              ))}
            </View>
          ))}
        </View>
      ) : null}
      <Text variant="label" style={styles.caption}>
        {activeDays === 0
          ? `No climbing in ${heatmap.weeks} weeks`
          : `${activeDays} ${activeDays === 1 ? 'day' : 'days'} on the board · ${heatmap.weeks} weeks`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', gap: GAP },
  week: { gap: GAP },
  caption: { marginTop: spacing.md },
});
