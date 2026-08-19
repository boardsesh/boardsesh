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

// Mirrors the ScrollView's contentContainerStyle below, so the peek math
// accounts for exactly the padding/gap the row actually renders.
// Exported so tests can assert against it instead of hardcoding the token.
export const SHELF_HORIZONTAL_INSET = spacing[4];
export const TILE_GAP = spacing[3];

// Deliberately not a whole number of tiles: sizing tiles so a whole number of
// them fills the row edge-to-edge is what caused #4278 — on a 375pt phone the
// old hardcoded TILE_WIDTH happened to fit exactly 2 tiles with no partial tile
// showing, so the row looked complete even though 3 more workout types were
// off-screen. Leaving a fixed fraction of the next tile in view means the
// cut-off tile itself signals there's more to scroll to.
const PEEK_FRACTION = 0.35;

/** Never squeeze below two whole tiles, however narrow the container gets. */
const MIN_WHOLE_TILES = 2;

/** Tiles stop growing here. The chart inside each tile is drawn for a
 *  phone-sized tile; a 480pt-wide one just stretches it. 168 is the width the
 *  shelf shipped with before #4278, which read fine on iPad — wide containers
 *  gain more tiles in view rather than bigger ones. */
export const TILE_MAX_WIDTH = 168;

/** Floor for degenerate containers (a Slide Over pane, a first layout pass that
 *  reports a hairline width) so a tile never collapses to nothing. */
export const TILE_MIN_WIDTH = 104;

/**
 * Tile width for a shelf `containerWidth` points wide holding `itemCount` tiles.
 *
 * Only the LEADING inset sits between the viewport edge and the first tile — the
 * trailing one lives at the far end of the content, past everything the user can
 * see — so the visible row is `inset + n*(tile + gap) + peek`.
 *
 * Widens the whole-tile count until tiles stop exceeding {@link TILE_MAX_WIDTH},
 * which keeps the peek proportional at every width instead of clamping the tile
 * and letting the leftover land back on a whole number of tiles (the #4278 bug,
 * one container width over).
 *
 * Pure so it can be unit tested at fixed widths without rendering.
 */
export function computeTileWidth(containerWidth: number, itemCount: number): number {
  const availableWidth = containerWidth - SHELF_HORIZONTAL_INSET;
  // Showing every item but one as a whole tile is the widest the ladder can go
  // and still have a tile left over to peek with.
  const maxWholeTiles = Math.max(MIN_WHOLE_TILES, itemCount - 1);

  for (let wholeTiles = MIN_WHOLE_TILES; wholeTiles <= maxWholeTiles; wholeTiles += 1) {
    const tileWidth = Math.round((availableWidth - TILE_GAP * wholeTiles) / (wholeTiles + PEEK_FRACTION));
    if (tileWidth <= TILE_MAX_WIDTH) return Math.max(TILE_MIN_WIDTH, tileWidth);
  }

  // Wider than `itemCount` capped tiles: every workout type is already on screen,
  // so there is nothing hidden for a peek to advertise.
  return TILE_MAX_WIDTH;
}

/**
 * The shelf's own box, which is NOT the window: on the iPad adaptive shell it
 * renders inside `shellContent` — a flex column between the sidebar and the
 * play/wall panes (`app/(tabs)/_layout.tsx`) — so on an 11" landscape iPad the
 * window is 1194pt while the shelf gets 399. Sizing tiles off the window there
 * produced a single tile wider than the pane it lives in. The window is only the
 * first-paint estimate, used until onLayout reports the real box.
 */
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
