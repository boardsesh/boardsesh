import { memo, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { BarChart } from 'react-native-gifted-charts';
import { Text } from '../Text';
import { buildAscentChartScale, type AngleGradeBar } from './community-utils';
import { useTheme } from '../../providers/theme-provider';
import { gradeChartColor } from '../you/profile-chart-colors';
import { borderRadius, spacing } from '../../theme/tokens';

type DifficultyByAngleChartProps = {
  data: AngleGradeBar[];
  accessibilityLabel?: string;
  /** Localised "Log scale" caption, shown (and folded into the a11y label) only
   *  when the y-axis switches to log. */
  logScaleLabel?: string;
  /** Small label rendered above the y-axis (e.g. "sends") so the axis reads. */
  yAxisTitle?: string;
  /**
   * Shown in place of the bars, inside the reserved chart height, when the
   * selected source has zero ascents across every angle. Keeps the frame so the
   * layout doesn't jump when the user toggles to an empty source.
   */
  emptyMessage?: string;
};

const CHART_HEIGHT = 150;
const AXIS_LABEL_SIZE = 11;
// Slightly smaller x-axis labels once they rotate, so the diagonal stack stays tight.
const ROTATED_AXIS_LABEL_SIZE = 10;
// Default top-corner radius for bars; the hardest angle gets a softer, larger cap.
const BAR_RADIUS = borderRadius.sm;
const PEAK_BAR_RADIUS = borderRadius.md;
const TOP_LABEL_HEIGHT = 16;
// Measurement box for the grade label above each bar — wide enough that even a
// long combined grade ("V13 / 8B") never clips to "…", while a short grade stays
// centred over the bar.
const GRADE_LABEL_WIDTH = 60;
const MIN_BAR_WIDTH = 10;
// Width reserved for the y-axis ascent-count labels (e.g. "120", "1.2k").
const Y_AXIS_LABEL_WIDTH = 32;
// A horizontal angle label ("70°") needs ~22px; once a bar + its gap is tighter
// than this the label clips to "…", so we rotate the labels instead.
const MIN_HORIZONTAL_LABEL_WIDTH = 22;
// Label-box width for rotated angle labels — enough to hold "70°" before the
// 60° transform fans them out diagonally.
const ROTATED_LABEL_WIDTH = 30;
// Extra room below the plot for the rotated diagonal labels.
const ROTATED_LABEL_EXTRA_HEIGHT = 28;

// Ascents-by-angle column chart: x-axis angles, bar height = the number of
// ascents (ascensionist count) at that angle, the bar drawn in the grade's
// scheme-aware colour with the grade label above it and the ascent count on the
// y-axis. The y-axis switches to a log scale when one angle dominates, so
// rarely-climbed angles stay legible. The hardest angle is flagged with a
// non-colour cue (bold label + larger cap) so the hardest grade survives
// colour-blindness and both schemes/variants — note that, since height now means
// ascents, the hardest angle is no longer necessarily the tallest bar.
export const DifficultyByAngleChart = memo(function DifficultyByAngleChart({
  data,
  accessibilityLabel,
  logScaleLabel,
  yAxisTitle,
  emptyMessage,
}: DifficultyByAngleChartProps) {
  const { chartColors, colorScheme } = useTheme();
  const [width, setWidth] = useState(0);

  // All bars at zero for the chosen source — show the in-place empty message
  // inside the reserved height rather than a row of flat bars.
  const allZero = data.length > 0 && data.every((bar) => bar.sends === 0);

  // Bars + axis scale only depend on the data + scheme — memoize so a parent
  // re-render (or a width change) doesn't rebuild them (and their top-label
  // closures) every time.
  const model = useMemo(() => {
    if (data.length === 0) return null;
    const scale = buildAscentChartScale(data.map((bar) => bar.sends));
    // The single hardest angle (first max wins on ties) gets the redundant cue.
    const hardestAngle = data.reduce((peak, bar) => (bar.difficulty > peak.difficulty ? bar : peak)).angle;
    const barData = data.map((bar) => {
      const fill = gradeChartColor(bar.gradeName, colorScheme);
      const isHardest = bar.angle === hardestAngle;
      const topRadius = isHardest ? PEAK_BAR_RADIUS : BAR_RADIUS;
      return {
        value: scale.plot(bar.sends),
        frontColor: fill,
        label: `${bar.angle}°`,
        barBorderTopLeftRadius: topRadius,
        barBorderTopRightRadius: topRadius,
        barBorderBottomLeftRadius: 0,
        barBorderBottomRightRadius: 0,
        topLabelComponentHeight: TOP_LABEL_HEIGHT,
        // gifted sizes the top-label box to ~1.5× the bar, so on a narrow bar
        // the grade clips to "V…". Wrap it in a fixed, wider centred box and pin
        // the font (no Dynamic Type growth) so the grade always reads in full —
        // the short label still sits centred over the bar without overlapping.
        topLabelComponent: (): ReactNode => (
          <View style={styles.topLabelWrap} pointerEvents="none">
            <Text
              variant="caption2"
              color={fill}
              style={isHardest ? styles.topLabelPeak : styles.topLabel}
              numberOfLines={1}
              allowFontScaling={false}
            >
              {bar.gradeName}
            </Text>
          </View>
        ),
      };
    });
    return {
      barData,
      maxValue: scale.maxValue,
      noOfSections: scale.noOfSections,
      yAxisLabelTexts: scale.yAxisLabelTexts,
      isLog: scale.isLog,
    };
  }, [data, colorScheme]);

  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);

  if (!model) return null;

  const count = data.length;
  const barSpacing = count > 8 ? 6 : 12;
  const initialSpacing = 10;
  // Reserve space for the y-axis labels so the bars + axis fit the measured width.
  const plotWidth = Math.max(0, width - Y_AXIS_LABEL_WIDTH);
  const barWidth =
    plotWidth > 0
      ? Math.max(MIN_BAR_WIDTH, Math.floor((plotWidth - initialSpacing * 2 - barSpacing * count) / count))
      : MIN_BAR_WIDTH;
  // Once the bars get too narrow for a horizontal angle label, rotate the labels
  // and give each its own wider box so the angle reads in full instead of "…".
  const rotateLabels = plotWidth > 0 && barWidth + barSpacing < MIN_HORIZONTAL_LABEL_WIDTH;
  // Flag the log axis in the caption + a11y label so a bar twice as tall isn't
  // misread as twice the ascents (it's 10× per section on a log scale).
  const showLogScale = model.isLog && !!logScaleLabel;
  const chartAccessibilityLabel =
    showLogScale && accessibilityLabel ? `${accessibilityLabel}, ${logScaleLabel}` : accessibilityLabel;

  return (
    <View
      style={[styles.container, rotateLabels && styles.containerRotated]}
      onLayout={onLayout}
      accessible={chartAccessibilityLabel ? true : undefined}
      accessibilityRole={chartAccessibilityLabel ? 'image' : undefined}
      accessibilityLabel={chartAccessibilityLabel}
    >
      {yAxisTitle ? (
        <Text variant="caption2" color={chartColors.secondaryLabel} style={styles.yAxisTitle}>
          {yAxisTitle}
        </Text>
      ) : null}
      {showLogScale ? (
        <Text variant="caption2" color={chartColors.secondaryLabel} style={styles.logScaleLabel}>
          {logScaleLabel}
        </Text>
      ) : null}
      {allZero && emptyMessage ? (
        <View style={styles.emptyOverlay}>
          <Text variant="footnote" color={chartColors.secondaryLabel}>
            {emptyMessage}
          </Text>
        </View>
      ) : width > 0 ? (
        <BarChart
          data={model.barData}
          width={plotWidth - 8}
          height={CHART_HEIGHT}
          barWidth={barWidth}
          spacing={barSpacing}
          initialSpacing={initialSpacing}
          maxValue={model.maxValue}
          noOfSections={model.noOfSections}
          yAxisLabelTexts={model.yAxisLabelTexts}
          yAxisLabelWidth={Y_AXIS_LABEL_WIDTH}
          rotateLabel={rotateLabels}
          labelWidth={rotateLabels ? ROTATED_LABEL_WIDTH : undefined}
          labelsExtraHeight={rotateLabels ? ROTATED_LABEL_EXTRA_HEIGHT : undefined}
          topLabelContainerStyle={styles.topLabelContainer}
          rulesColor={chartColors.separator}
          rulesType="solid"
          yAxisThickness={0}
          xAxisThickness={StyleSheet.hairlineWidth}
          xAxisColor={chartColors.separator}
          xAxisLabelTextStyle={{
            color: chartColors.secondaryLabel,
            fontSize: rotateLabels ? ROTATED_AXIS_LABEL_SIZE : AXIS_LABEL_SIZE,
          }}
          yAxisTextStyle={{ color: chartColors.secondaryLabel, fontSize: AXIS_LABEL_SIZE }}
          // gifted-charts' entry animation is unreliable on Android when the chart
          // mounts inside the collapsible's FadeIn transition — bars flash then
          // collapse to 0 height and never grow back. Render statically, matching
          // every other chart in the app (see YouCharts).
          isAnimated={false}
          disableScroll
          disablePress
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    minHeight: CHART_HEIGHT + spacing[6],
    justifyContent: 'center',
  },
  containerRotated: {
    minHeight: CHART_HEIGHT + spacing[6] + ROTATED_LABEL_EXTRA_HEIGHT,
  },
  logScaleLabel: {
    alignSelf: 'flex-end',
    marginBottom: spacing[1],
  },
  yAxisTitle: {
    marginBottom: spacing[1],
  },
  emptyOverlay: {
    height: CHART_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topLabelContainer: {
    marginBottom: spacing[1],
  },
  topLabelWrap: {
    width: GRADE_LABEL_WIDTH,
    alignItems: 'center',
  },
  topLabel: {
    fontWeight: '600',
    textAlign: 'center',
  },
  topLabelPeak: {
    fontWeight: '700',
    textAlign: 'center',
  },
});
