import { memo, useCallback, useMemo, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, useWindowDimensions, View } from 'react-native';
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

// Mirrors the ScrollView's contentContainerStyle below so the peek math uses
// the padding/gap the row actually renders. Exported for the tests.
export const SHELF_HORIZONTAL_INSET = spacing[4];
export const TILE_GAP = spacing[3];

// #4278: a whole number of tiles filled a 375pt row exactly, so the shelf looked
// complete with 3 workout types off-screen. A partial tile is the scroll cue.
const PEEK_FRACTION = 0.35;

/** Never squeeze below two whole tiles, however narrow the container gets. */
const MIN_WHOLE_TILES = 2;

// Tiles stop growing here (the pre-#4278 width): the chart is drawn for a
// phone-sized tile, so wide containers gain more tiles rather than bigger ones.
export const TILE_MAX_WIDTH = 168;

// Floor for degenerate containers (Slide Over, a hairline first layout pass).
export const TILE_MIN_WIDTH = 104;

// Visible row is `inset + n*(tile + gap) + peek` — only the LEADING inset is on
// screen, the trailing one sits past the end of the content.
export function computeTileWidth(containerWidth: number, itemCount: number): number {
  const availableWidth = containerWidth - SHELF_HORIZONTAL_INSET;
  // All but one item whole is the widest the ladder can go and still have a peek.
  const maxWholeTiles = Math.max(MIN_WHOLE_TILES, itemCount - 1);

  // Widen the tile count, not the tile: clamping the tile instead would park the
  // leftover back on a whole number of tiles — the #4278 bug, one width over.
  for (let wholeTiles = MIN_WHOLE_TILES; wholeTiles <= maxWholeTiles; wholeTiles += 1) {
    const tileWidth = Math.round((availableWidth - TILE_GAP * wholeTiles) / (wholeTiles + PEEK_FRACTION));
    if (tileWidth <= TILE_MAX_WIDTH) return Math.max(TILE_MIN_WIDTH, tileWidth);
  }

  // Every workout type already fits, so there is nothing for a peek to advertise.
  return TILE_MAX_WIDTH;
}

// The shelf's own box, which is NOT the window: on the iPad adaptive shell it
// sits in `shellContent` between the sidebar and the play/wall panes, so an 11"
// landscape iPad reports 1194 while the shelf gets 399. Window is the first-paint
// estimate only, until onLayout reports the real box.
function useShelfWidth(): { containerWidth: number; onLayout: (event: LayoutChangeEvent) => void } {
  const { width: windowWidth } = useWindowDimensions();
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    if (width <= 0) return;
    setMeasuredWidth((previous) => (previous !== null && Math.abs(previous - width) < 1 ? previous : width));
  }, []);

  return { containerWidth: measuredWidth ?? windowWidth, onLayout };
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
  const { containerWidth, onLayout } = useShelfWidth();
  const itemCount = items.length;
  const tileWidth = useMemo(() => computeTileWidth(containerWidth, itemCount), [containerWidth, itemCount]);
  const snapInterval = tileWidth + TILE_GAP;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      nestedScrollEnabled
      onLayout={onLayout}
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
