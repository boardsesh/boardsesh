import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import type { ColoredBar } from '../../you/profile-chart-colors';
import { StackedBarChart } from '../../you/YouCharts';
import { Icon } from '../../Icon';
import { type IconName } from '../../icon-map';
import { PressableSurface } from '../../PressableSurface';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { withAlpha } from '../../../theme/colors';
import { borderRadius, spacing } from '../../../theme/tokens';

const TILE_WIDTH = 168;
const CHART_HEIGHT = 82;

export type WorkoutTypeShelfItem = {
  key: string;
  label: string;
  selected: boolean;
  bars: ColoredBar[] | null;
  onPress: () => void;
  accessibilityLabel: string;
  emptyIcon?: IconName;
};

type WorkoutTypeShelfProps = {
  items: WorkoutTypeShelfItem[];
};

export const WorkoutTypeShelf = memo(function WorkoutTypeShelf({ items }: WorkoutTypeShelfProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      nestedScrollEnabled
    >
      {items.map((item) => (
        <WorkoutTypeTile item={item} key={item.key} />
      ))}
    </ScrollView>
  );
});

function WorkoutTypeTile({ item }: { item: WorkoutTypeShelfItem }) {
  const { systemColors, brandColors } = useTheme();
  const selectedBackground = withAlpha(brandColors.primary, 0.08);

  return (
    <PressableSurface
      onPress={item.onPress}
      feedback="scale"
      scaleTo={0.98}
      accessibilityRole="button"
      accessibilityLabel={item.accessibilityLabel}
      accessibilityState={{ selected: item.selected }}
      style={[
        styles.tile,
        {
          backgroundColor: item.selected ? selectedBackground : systemColors.secondaryBackground,
          borderColor: item.selected ? brandColors.primary : systemColors.separator,
        },
      ]}
    >
      <View pointerEvents="none" style={styles.chartSlot}>
        {item.bars ? (
          <StackedBarChart
            bars={item.bars}
            colorBy="grade"
            height={CHART_HEIGHT}
            maxXLabels={5}
            fitYAxisToData
            interactive={false}
            zoomable={false}
          />
        ) : (
          <View style={[styles.emptyChart, { backgroundColor: systemColors.fill }]}>
            <Icon name={item.emptyIcon ?? 'chart.bar'} size={24} color={systemColors.secondaryLabel} />
          </View>
        )}
      </View>
      <Text
        variant="footnote"
        color={item.selected ? brandColors.primary : systemColors.secondaryLabel}
        numberOfLines={1}
        style={styles.label}
      >
        {item.label}
      </Text>
    </PressableSurface>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing[4],
    gap: spacing[3],
  },
  tile: {
    width: TILE_WIDTH,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing[3],
    paddingTop: spacing[3],
    paddingBottom: spacing[2],
  },
  chartSlot: {
    height: CHART_HEIGHT,
  },
  emptyChart: {
    height: CHART_HEIGHT,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    marginTop: spacing[2],
    textAlign: 'center',
    fontWeight: '600',
  },
});
