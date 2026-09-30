import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import Svg, { Circle, G } from 'react-native-svg';
import type { BoardName } from '@boardsesh/shared-schema';
import { WEB_BASE_URL } from '../api/env';
import { Text } from '../ui/Text';
import { usePreferences } from '../settings/preferences-provider';
import { BOARD_BACKDROPS, holdLeds, useTheme } from '../ui/theme';
import { GUTTER, spacing } from '../ui/tokens';
import { getBoardGeometry, litHolds, type BoardGrid } from './board-geometry';

const COLUMN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// Row numbers sit in a 14pt column left of the panel, with a matching gap on the right.
const LABEL_COLUMN = 14;
const LABEL_GAP = 8;
// Column letters sit under the panel.
const LETTER_ROW = 16;
const CROP_MARK = 9;
const CROP_OFFSET = 6;

type BoardViewProps = {
  board: { boardName: BoardName; layoutId: number; sizeId: number; setIds: number[] };
  frames: string;
  /** Tallest the board may be drawn, labels included. */
  maxHeight: number;
  /** Space around the board, so it fits the screen width. */
  horizontalInset?: number;
  /** Rings glow while the wall shows this climb, and dim when it doesn't. */
  lit?: boolean;
};

/**
 * The board as a dark LED panel: crop marks at the corners, coordinates
 * outside, the real holds, and the climb's holds as glowing rings in the
 * board's own LED colours. The panel stays dark in both themes.
 */
export function BoardView({ board, frames, maxHeight, horizontalInset = GUTTER * 2, lit = true }: BoardViewProps) {
  const theme = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const backdrop = BOARD_BACKDROPS[usePreferences().boardBackdrop];
  const geometry = getBoardGeometry(board);

  if (!geometry) {
    return (
      <View style={[styles.placeholder, { height: maxHeight * 0.6, backgroundColor: backdrop.panel }]}>
        <Text variant="label" color={theme.boardLabel} align="center">
          This board setup can&apos;t be drawn
        </Text>
      </View>
    );
  }

  const { grid } = geometry;
  // The part of the art the panel shows, in image pixels.
  const view = grid ? grid.crop : { x: 0, y: 0, width: geometry.width, height: geometry.height };
  const aspectRatio = view.width / view.height;
  const sideSpace = grid ? (LABEL_COLUMN + LABEL_GAP) * 2 : 0;
  const belowSpace = grid ? LETTER_ROW + spacing.xs : 0;
  let panelWidth = windowWidth - horizontalInset - sideSpace;
  let panelHeight = panelWidth / aspectRatio;
  if (panelHeight + belowSpace > maxHeight) {
    panelHeight = maxHeight - belowSpace;
    panelWidth = panelHeight * aspectRatio;
  }
  const scale = panelWidth / view.width;
  const point = 1 / scale; // one screen point, in image pixels

  const holds = litHolds(geometry, board.boardName, frames);
  const leds = holdLeds(board.boardName);
  const viewBox = `${view.x} ${view.y} ${view.width} ${view.height}`;

  const panel = (
    <View style={{ width: panelWidth, height: panelHeight }}>
      <View
        style={[styles.panel, { backgroundColor: backdrop.panel, borderColor: backdrop.edge }]}
        accessible
        accessibilityRole="image"
        accessibilityLabel={`Board with ${holds.length} holds lit`}
      >
        {grid ? <HoleGrid grid={grid} viewBox={viewBox} color={backdrop.hole} /> : null}
        {geometry.imagePaths.map((path) => (
          <Image
            key={path}
            source={{ uri: `${WEB_BASE_URL}/images/${path}` }}
            style={{
              position: 'absolute',
              left: -view.x * scale,
              top: -view.y * scale,
              width: geometry.width * scale,
              height: geometry.height * scale,
            }}
            contentFit="fill"
            cachePolicy="memory-disk"
            transition={150}
          />
        ))}
        <Svg style={StyleSheet.absoluteFill} viewBox={viewBox}>
          {holds.map((hold) => {
            const color = leds[hold.role];
            return (
              <G key={hold.id}>
                {lit ? (
                  <>
                    <Circle
                      cx={hold.cx}
                      cy={hold.cy}
                      r={hold.r + 4 * point}
                      stroke={color}
                      strokeOpacity={0.14}
                      strokeWidth={6 * point}
                      fill="none"
                    />
                    <Circle
                      cx={hold.cx}
                      cy={hold.cy}
                      r={hold.r + 1.5 * point}
                      stroke={color}
                      strokeOpacity={0.32}
                      strokeWidth={3 * point}
                      fill="none"
                    />
                  </>
                ) : null}
                <Circle
                  cx={hold.cx}
                  cy={hold.cy}
                  r={hold.r}
                  stroke={color}
                  strokeWidth={2 * point}
                  fill={color}
                  fillOpacity={0.16}
                  opacity={lit ? 1 : 0.6}
                />
              </G>
            );
          })}
        </Svg>
      </View>
      <CropMarks color={theme.boardLabel} />
    </View>
  );

  if (!grid) return <View style={styles.center}>{panel}</View>;

  const rows = Array.from({ length: grid.rowTop }, (_, index) => grid.rowTop - index);
  const rowHeight = panelHeight / grid.rowTop;
  const columnWidth = panelWidth / grid.columns;
  return (
    <View style={styles.center}>
      <View style={styles.panelRow}>
        <View style={{ width: LABEL_COLUMN, height: panelHeight }}>
          {rows.map((row, index) => (
            <Text
              key={row}
              variant="mono"
              color={theme.boardLabel}
              align="right"
              style={[styles.coordinate, { position: 'absolute', right: 0, top: (index + 0.5) * rowHeight - 6 }]}
            >
              {row}
            </Text>
          ))}
        </View>
        {panel}
        <View style={{ width: LABEL_COLUMN }} />
      </View>
      <View style={[styles.letters, { width: panelWidth, height: LETTER_ROW }]}>
        {Array.from({ length: grid.columns }, (_, column) => (
          <Text
            key={column}
            variant="mono"
            color={theme.boardLabel}
            align="center"
            style={[
              styles.coordinate,
              { position: 'absolute', left: column * columnWidth, width: columnWidth, top: 4 },
            ]}
          >
            {COLUMN_LETTERS[column]}
          </Text>
        ))}
      </View>
    </View>
  );
}

/** Every bolt hole on a MoonBoard, as a faint dot under the holds. */
function HoleGrid({ grid, viewBox, color }: { grid: BoardGrid; viewBox: string; color: string }) {
  const cellWidth = grid.crop.width / grid.columns;
  const cellHeight = grid.crop.height / grid.rowTop;
  const dots: { key: string; cx: number; cy: number }[] = [];
  for (let slot = 0; slot < grid.rowTop; slot++) {
    for (let column = 0; column < grid.columns; column++) {
      dots.push({
        key: `${slot}-${column}`,
        cx: grid.crop.x + (column + 0.5) * cellWidth,
        cy: grid.crop.y + (slot + 0.5) * cellHeight,
      });
    }
  }
  return (
    <Svg style={StyleSheet.absoluteFill} viewBox={viewBox}>
      {dots.map((dot) => (
        <Circle key={dot.key} cx={dot.cx} cy={dot.cy} r={cellWidth * 0.06} fill={color} />
      ))}
    </Svg>
  );
}

/** Printer's crop marks framing the panel. */
function CropMarks({ color }: { color: string }) {
  const base = { position: 'absolute', width: CROP_MARK, height: CROP_MARK, borderColor: color } as const;
  return (
    <>
      <View style={[base, { left: -CROP_OFFSET, top: -CROP_OFFSET, borderLeftWidth: 1, borderTopWidth: 1 }]} />
      <View style={[base, { right: -CROP_OFFSET, top: -CROP_OFFSET, borderRightWidth: 1, borderTopWidth: 1 }]} />
      <View style={[base, { left: -CROP_OFFSET, bottom: -CROP_OFFSET, borderLeftWidth: 1, borderBottomWidth: 1 }]} />
      <View style={[base, { right: -CROP_OFFSET, bottom: -CROP_OFFSET, borderRightWidth: 1, borderBottomWidth: 1 }]} />
    </>
  );
}

const styles = StyleSheet.create({
  center: { alignSelf: 'center', alignItems: 'center' },
  panelRow: { flexDirection: 'row', gap: LABEL_GAP },
  panel: { flex: 1, borderRadius: 6, borderWidth: 1, overflow: 'hidden' },
  letters: { marginTop: spacing.xs },
  coordinate: { fontSize: 9, lineHeight: 12 },
  placeholder: {
    alignSelf: 'stretch',
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
});
