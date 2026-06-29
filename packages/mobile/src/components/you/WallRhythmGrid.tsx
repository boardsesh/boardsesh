import { Fragment, useMemo, useState } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import Svg, { Rect } from 'react-native-svg';
import type { RawWallRhythm } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { buildIntensityFills, colorForCount } from './heatmap-intensity';

type WallRhythmGridProps = {
  rhythm: RawWallRhythm;
};

type TFunc = (key: string, options?: Record<string, unknown>) => string;

const COLS = 4;
const GRID_ROWS = 7;
const CELL_GAP = 4;
const CELL_HEIGHT = 22;
const ROW_LABEL_WIDTH = 34;

// Literal t() keys (no dynamic key lookups) so the catalog stays statically
// analysable — mirrors `format-session-when.ts`'s weekday/part-of-day switches.
function weekdayShort(weekday: number, t: TFunc): string {
  switch (weekday) {
    case 0:
      return t('charts.weekday.mon');
    case 1:
      return t('charts.weekday.tue');
    case 2:
      return t('charts.weekday.wed');
    case 3:
      return t('charts.weekday.thu');
    case 4:
      return t('charts.weekday.fri');
    case 5:
      return t('charts.weekday.sat');
    default:
      return t('charts.weekday.sun');
  }
}

function weekdayFull(weekday: number, t: TFunc): string {
  switch (weekday) {
    case 0:
      return t('charts.weekdayFull.mon');
    case 1:
      return t('charts.weekdayFull.tue');
    case 2:
      return t('charts.weekdayFull.wed');
    case 3:
      return t('charts.weekdayFull.thu');
    case 4:
      return t('charts.weekdayFull.fri');
    case 5:
      return t('charts.weekdayFull.sat');
    default:
      return t('charts.weekdayFull.sun');
  }
}

function blockLabel(block: number, t: TFunc): string {
  switch (block) {
    case 0:
      return t('charts.block.morning');
    case 1:
      return t('charts.block.midday');
    case 2:
      return t('charts.block.evening');
    default:
      return t('charts.block.night');
  }
}

function timeOfDay(block: number, t: TFunc): string {
  switch (block) {
    case 0:
      return t('charts.timeOfDay.morning');
    case 1:
      return t('charts.timeOfDay.midday');
    case 2:
      return t('charts.timeOfDay.evening');
    default:
      return t('charts.timeOfDay.night');
  }
}

/**
 * "Wall rhythm" — a 7×4 grid (weekday × morning/midday/evening/night) with cell
 * intensity ∝ that slot's session count, reusing the activity calendar's
 * `colorForCount` ramp so the two heatmaps read as siblings. Cells are flat (a
 * gradient muddies the intensity steps). The busiest slot gets the same brand
 * accent ring the calendar uses for "today". Every fill is a plain `chartColors.*`
 * hex; parent gates the empty case.
 */
export function WallRhythmGrid({ rhythm }: WallRhythmGridProps) {
  const { colorScheme, chartColors, brandColors } = useTheme();
  const { t } = useTranslation('profile');
  const [width, setWidth] = useState(0);

  const fills = useMemo(
    () => buildIntensityFills(chartColors.accent, chartColors.secondaryBackground, colorScheme),
    [chartColors.accent, chartColors.secondaryBackground, colorScheme],
  );

  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);

  const gridWidth = Math.max(0, width - ROW_LABEL_WIDTH - spacing[2]);
  const cellWidth = gridWidth > 0 ? (gridWidth - (COLS - 1) * CELL_GAP) / COLS : 0;
  const gridHeight = GRID_ROWS * CELL_HEIGHT + (GRID_ROWS - 1) * CELL_GAP;
  const cornerRadius = Math.min(borderRadius.sm, Math.round(Math.min(cellWidth, CELL_HEIGHT) * 0.22));
  const ringWidth = Math.max(1.5, Math.min(cellWidth, CELL_HEIGHT) * 0.12);

  const hottestCaption =
    rhythm.hottest != null
      ? t('charts.wallRhythmCaption', {
          weekday: weekdayFull(rhythm.hottest.weekday, t),
          timeOfDay: timeOfDay(rhythm.hottest.block, t),
        })
      : null;

  return (
    <View onLayout={onLayout} accessibilityRole="image" accessibilityLabel={t('charts.wallRhythmA11y')}>
      {width > 0 && cellWidth > 0 ? (
        <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          {/* Column headers (time of day) aligned over the grid columns. */}
          <View style={styles.headerRow}>
            <View style={{ width: ROW_LABEL_WIDTH + spacing[2] }} />
            {Array.from({ length: COLS }, (_, block) => (
              <View key={block} style={{ width: cellWidth, marginRight: block < COLS - 1 ? CELL_GAP : 0 }}>
                <Text variant="caption2" color={chartColors.tertiaryLabel} numberOfLines={1} style={styles.colLabel}>
                  {blockLabel(block, t)}
                </Text>
              </View>
            ))}
          </View>

          <View style={styles.body}>
            {/* Weekday row labels, each aligned to its grid row. */}
            <View style={{ width: ROW_LABEL_WIDTH, marginRight: spacing[2] }}>
              {Array.from({ length: GRID_ROWS }, (_, weekday) => (
                <View
                  key={weekday}
                  style={{ height: CELL_HEIGHT, marginBottom: weekday < GRID_ROWS - 1 ? CELL_GAP : 0 }}
                >
                  <Text variant="caption2" color={chartColors.tertiaryLabel} style={styles.rowLabel}>
                    {weekdayShort(weekday, t)}
                  </Text>
                </View>
              ))}
            </View>

            <Svg width={gridWidth} height={gridHeight}>
              {Array.from({ length: GRID_ROWS }, (_, weekday) =>
                Array.from({ length: COLS }, (_, block) => {
                  const cellX = block * (cellWidth + CELL_GAP);
                  const cellY = weekday * (CELL_HEIGHT + CELL_GAP);
                  const count = rhythm.matrix[weekday]?.[block] ?? 0;
                  const isHottest = rhythm.hottest?.weekday === weekday && rhythm.hottest?.block === block;
                  return (
                    <Fragment key={`${weekday}-${block}`}>
                      <Rect
                        x={cellX}
                        y={cellY}
                        width={cellWidth}
                        height={CELL_HEIGHT}
                        rx={cornerRadius}
                        ry={cornerRadius}
                        fill={colorForCount(count, rhythm.max, fills)}
                        stroke={chartColors.separator}
                        strokeWidth={StyleSheet.hairlineWidth}
                      />
                      {isHottest ? (
                        <Rect
                          x={cellX + ringWidth / 2}
                          y={cellY + ringWidth / 2}
                          width={cellWidth - ringWidth}
                          height={CELL_HEIGHT - ringWidth}
                          rx={cornerRadius}
                          ry={cornerRadius}
                          fill="none"
                          stroke={brandColors.accent}
                          strokeWidth={ringWidth}
                        />
                      ) : null}
                    </Fragment>
                  );
                }),
              )}
            </Svg>
          </View>
        </View>
      ) : null}

      {hottestCaption ? (
        <Text variant="footnote" color={chartColors.secondaryLabel} style={styles.caption}>
          {hottestCaption}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    marginBottom: spacing[1],
  },
  colLabel: {
    textAlign: 'center',
  },
  body: {
    flexDirection: 'row',
  },
  rowLabel: {
    flex: 1,
    textAlignVertical: 'center',
  },
  caption: {
    marginTop: spacing[3],
  },
});
