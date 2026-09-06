import { memo, useCallback, useMemo, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  type ScrollView as RNScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { useFocusEffect } from 'expo-router';
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

// A whole number of tiles filling the row exactly is what made the shelf look
// complete with three workout types off-screen. A partial tile is the scroll cue,
// so the row is sized to end mid-tile.
const PEEK_FRACTION = 0.35;

// The band a peek has to land in to read as a cut-off card: under the floor it is
// a sliver you skim past, over the ceiling it reads as another whole card and the
// row looks finished again.
export const MIN_PEEK_FRACTION = 0.2;
export const MAX_PEEK_FRACTION = 0.5;

/** Never squeeze below two whole tiles, however narrow the container gets. */
const MIN_WHOLE_TILES = 2;

// Tiles stop growing here (the width the shelf shipped with): the chart is drawn
// for a phone-sized tile, so wide containers gain more tiles, not bigger ones.
export const TILE_MAX_WIDTH = 168;

// Floor for degenerate containers (Slide Over, a hairline first layout pass).
export const TILE_MIN_WIDTH = 104;

// Long enough for the tab transition to settle — a flash fired mid-push is drawn
// under the incoming screen and nobody sees it.
export const INDICATOR_FLASH_DELAY_MS = 350;

// Visible row is `inset + n*(tile + gap) + peek` — only the LEADING inset is on
// screen, the trailing one sits past the end of the content.
export function computeTileWidth(containerWidth: number, itemCount: number): number {
  const availableWidth = containerWidth - SHELF_HORIZONTAL_INSET;
  // All but one item whole is the widest the ladder can go and still have a peek.
  const maxWholeTiles = Math.max(MIN_WHOLE_TILES, itemCount - 1);

  // Widen the tile count, not the tile: clamping the tile at every width would
  // park the leftover back on a whole number of tiles — the same bug, one width
  // over.
  for (let wholeTiles = MIN_WHOLE_TILES; wholeTiles <= maxWholeTiles; wholeTiles += 1) {
    const tileWidth = Math.round((availableWidth - TILE_GAP * wholeTiles) / (wholeTiles + PEEK_FRACTION));
    if (tileWidth <= TILE_MAX_WIDTH) return Math.max(TILE_MIN_WIDTH, tileWidth);

    // The ideal tile is over the cap, but where capping it already leaves a peek
    // inside the band, capping wins: stepping up a tile buys one more column at
    // the price of shrinking every tile. 440pt (iPhone 16 Pro Max) is the case —
    // stepping up took tiles from 168 to 116 and the peek from 64pt down to 40.
    const cappedPeek = availableWidth - wholeTiles * (TILE_MAX_WIDTH + TILE_GAP);
    if (cappedPeek >= TILE_MAX_WIDTH * MIN_PEEK_FRACTION && cappedPeek <= TILE_MAX_WIDTH * MAX_PEEK_FRACTION) {
      return TILE_MAX_WIDTH;
    }
  }

  // Past four whole tiles there is no rung left to climb — the fifth workout type
  // is the peek. Cap the tile and let the leftover be however wide it lands: it is
  // over half a tile on some tablet widths, which still reads as clipped, and on a
  // container wide enough for all five the row simply doesn't scroll.
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
  const scrollRef = useRef<RNScrollView>(null);

  // The peek only helps where the row previously ended flush; on a 430pt phone a
  // slice of the next tile was already showing and it still read as a finished
  // row. iOS paints the scroll indicator only during an active drag, so at rest
  // nothing says the rail moves. Flashing it each time the screen comes forward
  // puts the platform's own bar under the row for a beat, on every width.
  useFocusEffect(
    useCallback(() => {
      const flash = setTimeout(() => scrollRef.current?.flashScrollIndicators(), INDICATOR_FLASH_DELAY_MS);
      return () => clearTimeout(flash);
    }, []),
  );

  return (
    <ScrollView
      ref={scrollRef}
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
