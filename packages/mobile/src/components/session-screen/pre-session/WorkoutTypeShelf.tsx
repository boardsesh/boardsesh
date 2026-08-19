import { memo, useMemo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
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

const CHART_HEIGHT = 82;

// Mirrors the ScrollView's contentContainerStyle below, so the peek math
// below accounts for exactly the padding/gap the row actually renders.
const SHELF_HORIZONTAL_INSET = spacing[4];
const TILE_GAP = spacing[3];

// Deliberately not a whole number: sizing tiles so a whole number of them
// fills the screen edge-to-edge is what caused #4278 — on a 375pt phone the
// old hardcoded TILE_WIDTH happened to fit exactly 2 tiles with no partial
// tile showing, so the row looked complete even though 3 more workout types
// were off-screen. Targeting "a bit past 2 tiles" means the row always ends
// mid-tile on common phone widths, so the cut-off tile itself signals there's
// more to scroll to, on top of the restored scroll indicator below.
const VISIBLE_TILES_TARGET = 2.35;

/** Pure so it can be unit tested at fixed device widths without rendering. */
export function computeTileWidth(windowWidth: number): number {
  const fullGapCount = Math.floor(VISIBLE_TILES_TARGET);
  const availableWidth = windowWidth - SHELF_HORIZONTAL_INSET * 2 - TILE_GAP * fullGapCount;
  return Math.round(availableWidth / VISIBLE_TILES_TARGET);
}

/** Tile width derived from the viewport so a partial tile always peeks at
 *  the trailing edge, instead of a hardcoded width that only avoided a full
 *  peek by accident on some screen sizes and not others. */
function useTileWidth(): number {
  const { width: windowWidth } = useWindowDimensions();
  return useMemo(() => computeTileWidth(windowWidth), [windowWidth]);
}

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
  const tileWidth = useTileWidth();
  const snapInterval = tileWidth + TILE_GAP;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      nestedScrollEnabled
      snapToInterval={snapInterval}
      snapToAlignment="start"
      decelerationRate="fast"
    >
      {items.map((item) => (
        <WorkoutTypeTile item={item} key={item.key} tileWidth={tileWidth} />
      ))}
    </ScrollView>
  );
});

function WorkoutTypeTile({ item, tileWidth }: { item: WorkoutTypeShelfItem; tileWidth: number }) {
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
          width: tileWidth,
          backgroundColor: item.selected ? selectedBackground : systemColors.secondaryBackground,
          borderColor: item.selected ? brandColors.primary : systemColors.separator,
        },
      ]}
    >
      <View style={styles.chartSlot}>
        <View pointerEvents="none">
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
        {/* react-native-gifted-charts renders each bar with its own explicit
            pointerEvents:'auto', which on web overrides the `pointerEvents="none"`
            above and swallows the tap before it bubbles to this tile's Pressable.
            An unhandled transparent overlay on top absorbs the tap there instead,
            so it bubbles normally to the tile. */}
        <View style={styles.chartTapOverlay} />
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
    paddingHorizontal: SHELF_HORIZONTAL_INSET,
    gap: TILE_GAP,
  },
  tile: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing[3],
    paddingTop: spacing[3],
    paddingBottom: spacing[2],
  },
  chartSlot: {
    height: CHART_HEIGHT,
  },
  chartTapOverlay: {
    ...StyleSheet.absoluteFill,
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
