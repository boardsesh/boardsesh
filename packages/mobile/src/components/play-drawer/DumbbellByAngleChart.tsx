import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, View, Pressable, type LayoutChangeEvent } from 'react-native';
import { LineChart } from 'react-native-gifted-charts';
import type { GradeDisplayFormat } from '@boardsesh/play-view';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { useTranslation } from 'react-i18next';
import {
  buildDumbbellAxis,
  hasAnyBoardseshDiamond,
  type DumbbellAngleRow,
  type DumbbellSizeBin,
} from './by-angle-comparison';

type DumbbellByAngleChartProps = {
  /** Per-angle join model from `buildDumbbellByAngleModel` (sorted by angle). */
  rows: DumbbellAngleRow[];
  /** Overall Boardsesh grade (float) for the dashed reference line; null hides it. */
  headlineGrade: number | null;
  /** The viewer's grade-format preference, for the tap caption's dash fallback. */
  gradeFormat: GradeDisplayFormat;
  /** Screen-reader summary of the chart (built by the parent section). */
  accessibilityLabel: string;
};

const CHART_HEIGHT = 168;
const AXIS_LABEL_SIZE = 11;
// Slightly smaller x-axis labels once they rotate, so the diagonal stack stays
// tight — matching DifficultyByAngleChart, the chart directly below this one.
const ROTATED_AXIS_LABEL_SIZE = 10;
const INITIAL_SPACING = 26;
const END_SPACING = 16;
// A horizontal angle label ("70°") needs ~22px; once a marker's slot is tighter
// than this the label clips to "…", so we rotate the labels instead (#4164).
const MIN_HORIZONTAL_LABEL_WIDTH = 22;
// Room below the plot for the rotated diagonal labels. gifted's LineChart sizes
// the label box `spacing + labelsExtraHeight` and never drops it for the 60°
// turn the way its BarChart does, so this one number does all three jobs: it
// widens the box, lifts the plot off the labels, and grows the chart's own
// container to match (`actualContainerHeight` in gifted-charts-core).
const ROTATED_LABEL_EXTRA_HEIGHT = 28;
// Cap the per-angle tap column so a two-angle climb doesn't give each marker
// half the screen. There is deliberately NO lower floor: a column wider than the
// marker spacing overlaps its neighbour, and RN hands the overlap to the later
// sibling, so a marker's edge pixels would trigger the wrong angle. Tiling the
// column to the spacing (below the cap) keeps every marker owning its own tap
// target; the column runs the full plot height, so even a crowded ~30px-wide
// slot stays a usable target.
const MAX_SLOT_WIDTH = 76;

// Ring (crowd) outer diameter and diamond (Boardsesh) square side, by ascent bin.
const RING_DIAMETER: Record<DumbbellSizeBin, number> = { small: 12, medium: 16, large: 22 };
const DIAMOND_SIDE: Record<DumbbellSizeBin, number> = { small: 9, medium: 12, large: 16 };
const NESTED_DIAMOND_SIDE: Record<DumbbellSizeBin, number> = { small: 6, medium: 8, large: 10 };
const RING_BORDER = 2;
const ESTIMATED_DIAMOND_BORDER = 2;
const STEM_WIDTH = 2;
const WHISKER_WIDTH = 2;
const WHISKER_CAP = 6;

const BIN_ORDER: DumbbellSizeBin[] = ['small', 'medium', 'large'];

/** Bump a size bin up one step when its angle is focused (tap-to-enlarge). */
function bumpBin(bin: DumbbellSizeBin, focused: boolean): DumbbellSizeBin {
  if (!focused) return bin;
  return BIN_ORDER[Math.min(BIN_ORDER.length - 1, BIN_ORDER.indexOf(bin) + 1)];
}

// A per-angle dumbbell comparing the crowd's community grade (hollow ring) with
// the cross-board Boardsesh grade (filled diamond, tinted by its own grade) on
// ONE standardized-grade Y axis. The vertical gap between the two markers is the
// correction. Series are told apart by SHAPE + FILL + POSITION, never hue alone,
// so it survives colour-blindness. Ascent count drives marker size; a tap
// enlarges an angle and prints its numbers above the chart.
export const DumbbellByAngleChart = memo(function DumbbellByAngleChart({
  rows,
  headlineGrade,
  gradeFormat,
  accessibilityLabel,
}: DumbbellByAngleChartProps) {
  const { chartColors } = useTheme();
  const { t } = useTranslation('climbs');
  const [width, setWidth] = useState(0);
  const [focusedAngle, setFocusedAngle] = useState<number | null>(null);

  const axis = useMemo(() => buildDumbbellAxis(rows, gradeFormat), [rows, gradeFormat]);
  const anyDiamond = useMemo(() => hasAnyBoardseshDiamond(rows), [rows]);
  const anyEstimate = useMemo(() => rows.some((row) => row.estimated), [rows]);

  // A grade float → its y offset from the container top (0 = axis top). This
  // exactly mirrors gifted's own getY (slope = height / maxValue), so markers
  // register on the gridlines. Every anchor sits at the axis midpoint so each
  // customDataPoint container spans the full plot area (markers never clip).
  const localY = useCallback(
    (grade: number) => (CHART_HEIGHT * (axis.maxId - grade)) / axis.maxValue,
    [axis.maxId, axis.maxValue],
  );

  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);

  const plotWidth = Math.max(0, width - axis.yAxisLabelWidth);
  const count = rows.length;
  const rawSpacing = count > 1 ? (plotWidth - INITIAL_SPACING - END_SPACING) / (count - 1) : 0;
  const slotWidth = Math.min(rawSpacing, MAX_SLOT_WIDTH);
  // Once the angles crowd together, a horizontal "70°" clips to "…" — turn the
  // labels diagonal the way the Community chart below already does. A lone angle
  // has no spacing to measure (and renders as a sentence, not a chart) — opt out
  // rather than let its rawSpacing of 0 read as "crowded".
  const rotateLabels = count > 1 && plotWidth > 0 && rawSpacing < MIN_HORIZONTAL_LABEL_WIDTH;

  const neutralStroke = chartColors.secondaryLabel;
  const diamondEdge = chartColors.label;

  const renderMarker = useCallback(
    (row: DumbbellAngleRow): ReactNode => {
      const focused = row.angle === focusedAngle;
      const bin = bumpBin(row.sizeBin, focused);
      const centerX = slotWidth / 2;

      const crowdY = row.crowdGrade != null ? localY(row.crowdGrade) : null;
      const diamondY = row.boardseshGrade != null ? localY(row.boardseshGrade) : null;

      const ringSize = RING_DIAMETER[bin];
      const diaSize = DIAMOND_SIDE[bin];
      const isProvisional = row.tier === 'provisional';
      const markerAccessibilityLabel = row.estimated
        ? t('boardseshGrade.dumbbell.tapCaptionEstimated', {
            angle: row.angle,
            boardsesh: row.boardseshLabel ?? '—',
          })
        : t('boardseshGrade.dumbbell.tapCaption', {
            angle: row.angle,
            crowd: row.crowdLabel ?? '—',
            boardsesh: row.boardseshLabel ?? '—',
            count: row.sends,
          });

      return (
        <Pressable
          style={[styles.column, { width: slotWidth, height: CHART_HEIGHT }]}
          onPress={() => setFocusedAngle((current) => (current === row.angle ? null : row.angle))}
          accessibilityRole="button"
          accessibilityLabel={markerAccessibilityLabel}
        >
          {/* Provisional whisker: gradeLow–gradeHigh span behind the diamond. */}
          {isProvisional && row.gradeLow != null && row.gradeHigh != null && diamondY != null ? (
            <View
              pointerEvents="none"
              style={[
                styles.whisker,
                {
                  left: centerX - WHISKER_WIDTH / 2,
                  top: localY(row.gradeHigh),
                  height: Math.max(WHISKER_CAP, localY(row.gradeLow) - localY(row.gradeHigh)),
                  backgroundColor: chartColors.tertiaryLabel,
                },
              ]}
            />
          ) : null}

          {/* Connector stem — only when the two markers disagree and both exist. */}
          {!row.agree && crowdY != null && diamondY != null ? (
            <View
              pointerEvents="none"
              style={[
                styles.stem,
                {
                  left: centerX - STEM_WIDTH / 2,
                  top: Math.min(crowdY, diamondY),
                  height: Math.abs(crowdY - diamondY),
                  backgroundColor: chartColors.separator,
                },
              ]}
            />
          ) : null}

          {/* Crowd ring (hollow, neutral). */}
          {crowdY != null ? (
            <View
              pointerEvents="none"
              style={[
                styles.ring,
                {
                  width: ringSize,
                  height: ringSize,
                  borderRadius: ringSize / 2,
                  borderColor: neutralStroke,
                  left: centerX - ringSize / 2,
                  top: crowdY - ringSize / 2,
                },
              ]}
            />
          ) : null}

          {/* Agree → a small diamond nested in the ring (no stem). */}
          {row.agree && crowdY != null && row.boardseshColor ? (
            <View
              pointerEvents="none"
              style={[
                styles.diamond,
                {
                  width: NESTED_DIAMOND_SIDE[bin],
                  height: NESTED_DIAMOND_SIDE[bin],
                  backgroundColor: row.boardseshColor,
                  borderColor: diamondEdge,
                  left: centerX - NESTED_DIAMOND_SIDE[bin] / 2,
                  top: crowdY - NESTED_DIAMOND_SIDE[bin] / 2,
                },
              ]}
            />
          ) : null}

          {/* Boardsesh diamond — disagree case. Filled and grade-tinted when the
              angle was actually climbed; hollow (grade-tinted outline on the
              plot's own background) when the grade was projected from the
              climb's other angles, so measured and estimated never look alike. */}
          {!row.agree && diamondY != null && row.boardseshColor ? (
            <View
              pointerEvents="none"
              style={[
                styles.diamond,
                {
                  width: diaSize,
                  height: diaSize,
                  backgroundColor: row.estimated ? 'transparent' : row.boardseshColor,
                  borderColor: row.estimated ? row.boardseshColor : diamondEdge,
                  borderWidth: row.estimated ? ESTIMATED_DIAMOND_BORDER : undefined,
                  left: centerX - diaSize / 2,
                  top: diamondY - diaSize / 2,
                },
              ]}
            />
          ) : null}
        </Pressable>
      );
    },
    [focusedAngle, slotWidth, localY, neutralStroke, diamondEdge, chartColors.tertiaryLabel, chartColors.separator, t],
  );

  // All points anchor at the axis midpoint so every marker container spans the
  // full plot; the array identity also changes on focus so gifted re-runs
  // customDataPoint (enlarging the tapped angle).
  const chartData = useMemo(
    () => rows.map(() => ({ value: axis.maxValue / 2 })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focusedAngle forces a re-render of the custom points
    [rows, axis.maxValue, focusedAngle],
  );

  const caption = useMemo(() => {
    if (focusedAngle == null) return null;
    const row = rows.find((candidate) => candidate.angle === focusedAngle);
    if (!row) return null;
    if (row.estimated) {
      return t('boardseshGrade.dumbbell.tapCaptionEstimated', {
        angle: row.angle,
        boardsesh: row.boardseshLabel ?? '—',
      });
    }
    if (row.agree && row.boardseshLabel) {
      return t('boardseshGrade.dumbbell.tapCaptionAgree', {
        angle: row.angle,
        grade: row.boardseshLabel,
        count: row.sends,
      });
    }
    return t('boardseshGrade.dumbbell.tapCaption', {
      angle: row.angle,
      crowd: row.crowdLabel ?? '—',
      boardsesh: row.boardseshLabel ?? '—',
      count: row.sends,
    });
  }, [focusedAngle, rows, t]);

  if (count === 0) return null;

  // Single angle: a chart of one point reads as a bug — say it in a sentence.
  if (count === 1) {
    const [row] = rows;
    return (
      <Text variant="footnote" color={chartColors.secondaryLabel} accessibilityLabel={accessibilityLabel}>
        {t('boardseshGrade.dumbbell.singleAngle', {
          angle: row.angle,
          crowd: row.crowdLabel ?? '—',
          boardsesh: row.boardseshLabel ?? '—',
          count: row.sends,
        })}
      </Text>
    );
  }

  return (
    <View style={styles.container}>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={accessibilityLabel}
        style={styles.accessibilitySummary}
      />
      <Text
        variant="caption1"
        color={chartColors.label}
        style={styles.caption}
        numberOfLines={2}
        allowFontScaling={false}
      >
        {caption ?? ''}
      </Text>

      <View onLayout={onLayout}>
        {width > 0 ? (
          <LineChart
            data={chartData}
            width={plotWidth}
            height={CHART_HEIGHT}
            thickness={0}
            color="transparent"
            spacing={rawSpacing}
            initialSpacing={INITIAL_SPACING}
            endSpacing={END_SPACING}
            maxValue={axis.maxValue}
            noOfSections={axis.noOfSections}
            yAxisLabelTexts={axis.yAxisLabelTexts}
            yAxisLabelWidth={axis.yAxisLabelWidth}
            dataPointsWidth={slotWidth}
            dataPointsHeight={CHART_HEIGHT}
            customDataPoint={(_item: unknown, index: number) => renderMarker(rows[index])}
            showReferenceLine1={headlineGrade != null}
            referenceLine1Position={headlineGrade != null ? headlineGrade - axis.minId : undefined}
            referenceLine1Config={{
              thickness: 1,
              color: chartColors.tertiaryLabel,
              dashWidth: 4,
              dashGap: 4,
            }}
            rulesColor={chartColors.separator}
            rulesType="solid"
            yAxisThickness={0}
            xAxisThickness={StyleSheet.hairlineWidth}
            xAxisColor={chartColors.separator}
            yAxisTextStyle={{ color: chartColors.secondaryLabel, fontSize: AXIS_LABEL_SIZE }}
            xAxisLabelTexts={rows.map((row) => `${row.angle}°`)}
            xAxisLabelTextStyle={{
              color: chartColors.secondaryLabel,
              fontSize: rotateLabels ? ROTATED_AXIS_LABEL_SIZE : AXIS_LABEL_SIZE,
            }}
            rotateLabel={rotateLabels}
            labelsExtraHeight={rotateLabels ? ROTATED_LABEL_EXTRA_HEIGHT : undefined}
            // gifted's entry animation collapses points to 0 inside the drawer's
            // FadeIn on Android — render statically like every other chart here.
            isAnimated={false}
            disableScroll
          />
        ) : null}
      </View>

      {!anyDiamond ? (
        <Text variant="caption2" color={chartColors.secondaryLabel} style={styles.note}>
          {t('boardseshGrade.dumbbell.crowdOnlyNote')}
        </Text>
      ) : null}

      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDiamond, { backgroundColor: chartColors.label }]} />
          <Text variant="caption2" color={chartColors.secondaryLabel} allowFontScaling={false}>
            {t('boardseshGrade.dumbbell.legendBoardsesh')}
          </Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendRing, { borderColor: chartColors.secondaryLabel }]} />
          <Text variant="caption2" color={chartColors.secondaryLabel} allowFontScaling={false}>
            {t('boardseshGrade.dumbbell.legendCrowd')}
          </Text>
        </View>
        {anyEstimate ? (
          <View style={styles.legendItem}>
            <View style={[styles.legendDiamond, styles.legendEstimatedDiamond, { borderColor: chartColors.label }]} />
            <Text variant="caption2" color={chartColors.secondaryLabel} allowFontScaling={false}>
              {t('boardseshGrade.estimate.label')}
            </Text>
          </View>
        ) : null}
      </View>
      <Text variant="caption2" color={chartColors.tertiaryLabel} allowFontScaling={false}>
        {t('boardseshGrade.dumbbell.legendSize')}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    gap: spacing[2],
  },
  accessibilitySummary: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
  caption: {
    minHeight: 34,
  },
  column: {
    position: 'relative',
  },
  ring: {
    position: 'absolute',
    borderWidth: RING_BORDER,
    backgroundColor: 'transparent',
  },
  diamond: {
    position: 'absolute',
    borderWidth: 1,
    borderRadius: 2,
    transform: [{ rotate: '45deg' }],
  },
  stem: {
    position: 'absolute',
    width: STEM_WIDTH,
  },
  whisker: {
    position: 'absolute',
    width: WHISKER_WIDTH,
  },
  note: {
    fontStyle: 'italic',
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[4],
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  legendDiamond: {
    width: 10,
    height: 10,
    borderRadius: 2,
    transform: [{ rotate: '45deg' }],
  },
  legendEstimatedDiamond: {
    borderWidth: ESTIMATED_DIAMOND_BORDER,
    backgroundColor: 'transparent',
  },
  legendRing: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: RING_BORDER,
    backgroundColor: 'transparent',
  },
});
