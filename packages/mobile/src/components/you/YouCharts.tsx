import { useMemo, useState, type ReactNode } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { BarChart, LineChart } from 'react-native-gifted-charts';
import type { RawGroupedBar, RawVPointsTimeline } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { ActivityIndicator } from '../ActivityIndicator';
import { useTheme } from '../../providers/theme-provider';
import { gradeChartColor, layoutChartColor, flashRedpointColor, type ColoredBar } from './profile-chart-colors';

const MAX_X_LABELS = 12;
const AXIS_LABEL_SIZE = 10;
const STACK_BAR_RADIUS = 3;

export type ChartLegendItem = { color: string; label: string };

// Keep only ~MAX_X_LABELS evenly-spaced labels; blank the rest so a dense
// 52-week axis stays legible.
function downsampleLabel(index: number, total: number, label: string, max: number = MAX_X_LABELS): string {
  if (total <= max) return label;
  const step = Math.ceil(total / max);
  return index % step === 0 ? label : '';
}

/** Bar width + spacing that fit `count` bars into `width` without scrolling. */
function fitBars(width: number, count: number, minBar = 3): { barWidth: number; spacing: number } {
  if (count <= 0 || width <= 0) return { barWidth: minBar, spacing: 2 };
  const spacing = count > 26 ? 2 : count > 12 ? 4 : 8;
  const initial = 8;
  const available = width - initial * 2 - spacing * (count - 1);
  const barWidth = Math.max(minBar, Math.floor(available / count));
  return { barWidth, spacing };
}

function formatThousands(value: number): string {
  return value >= 1000 ? `${Math.round(value / 100) / 10}k` : `${Math.round(value)}`;
}

/** Color-dot + label row beneath a chart so its colors can be decoded. */
function Legend({ items }: { items: ChartLegendItem[] }) {
  const { systemColors } = useTheme();
  return (
    <View style={styles.legend}>
      {items.map((item) => (
        <View key={item.label} style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: item.color }]} />
          <Text variant="caption2" color={systemColors.secondaryLabel}>
            {item.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

type FrameProps = {
  height: number;
  loading?: boolean;
  emptyLabel?: string;
  isEmpty?: boolean;
  children: (width: number) => ReactNode;
};

/** Measures available width and renders loading / empty / chart states. */
function ChartFrame({ height, loading, emptyLabel, isEmpty, children }: FrameProps) {
  const { systemColors } = useTheme();
  const [width, setWidth] = useState(0);
  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);

  return (
    <View style={[styles.frame, { height }]} onLayout={onLayout}>
      {loading ? (
        <ActivityIndicator size="small" />
      ) : isEmpty ? (
        <Text variant="footnote" color={systemColors.tertiaryLabel}>
          {emptyLabel}
        </Text>
      ) : width > 0 ? (
        children(width)
      ) : null}
    </View>
  );
}

type StackedBarsProps = {
  bars: ColoredBar[] | null;
  /**
   * Fallback colour resolution when a segment has no explicit `color`:
   * 'grade' colours by grade label, 'layout' by layoutKey. A segment that
   * carries its own `color` (e.g. the gold flash cap on session grade bars)
   * overrides this.
   */
  colorBy: 'grade' | 'layout';
  height?: number;
  loading?: boolean;
  emptyLabel?: string;
  legend?: ChartLegendItem[];
  /**
   * Max x-axis labels to keep before downsampling blanks the rest (default 12).
   * Lower it for long labels (weekly "W23 '24") that would overlap horizontally.
   */
  maxXLabels?: number;
};

/** Stacked bars (weekly activity, grade distribution). */
export function StackedBarChart({
  bars,
  colorBy,
  height = 170,
  loading,
  emptyLabel,
  legend,
  maxXLabels,
}: StackedBarsProps) {
  const { systemColors } = useTheme();
  const isEmpty = !bars || bars.length === 0;

  // Color resolution is width-independent, so memoize it off the data.
  const stackData = useMemo(
    () =>
      (bars ?? []).map((bar, index) => {
        const filled = bar.segments
          .filter((segment) => segment.value > 0)
          .map((segment) => ({
            value: segment.value,
            // An explicit segment colour wins; otherwise fall back to colorBy.
            color: segment.color ?? (colorBy === 'grade' ? gradeChartColor(segment.key) : layoutChartColor(segment.key)),
          }));
        const stacks = filled.length > 0 ? filled : [{ value: 0, color: 'transparent' }];
        // Round only the stack's outer corners (bottom of the bottom segment,
        // top of the top segment). gifted-charts otherwise rounds every segment
        // via barBorderRadius, which beads each band.
        const top = stacks.length - 1;
        const rounded = stacks.map((segment, segmentIndex) => ({
          ...segment,
          borderBottomLeftRadius: segmentIndex === 0 ? STACK_BAR_RADIUS : 0,
          borderBottomRightRadius: segmentIndex === 0 ? STACK_BAR_RADIUS : 0,
          borderTopLeftRadius: segmentIndex === top ? STACK_BAR_RADIUS : 0,
          borderTopRightRadius: segmentIndex === top ? STACK_BAR_RADIUS : 0,
        }));
        return {
          stacks: rounded,
          label: downsampleLabel(index, bars!.length, bar.label, maxXLabels),
        };
      }),
    [bars, colorBy, maxXLabels],
  );

  return (
    <View>
      <ChartFrame height={height} loading={loading} isEmpty={isEmpty} emptyLabel={emptyLabel}>
        {(width) => {
          const { barWidth, spacing } = fitBars(width, stackData.length);
          // gifted-charts color props are typed `string`, not RN `ColorValue`,
          // so the systemColors values below are cast rather than passed directly.
          return (
            <BarChart
              stackData={stackData}
              width={width - 8}
              height={height - 28}
              barWidth={barWidth}
              spacing={spacing}
              initialSpacing={8}
              hideRules
              hideYAxisText
              yAxisThickness={0}
              xAxisThickness={StyleSheet.hairlineWidth}
              xAxisColor={systemColors.separator as string}
              xAxisLabelTextStyle={{ color: systemColors.secondaryLabel as string, fontSize: AXIS_LABEL_SIZE }}
              isAnimated={false}
              disableScroll
            />
          );
        }}
      </ChartFrame>
      {legend && !isEmpty ? <Legend items={legend} /> : null}
    </View>
  );
}

type GroupedBarsProps = {
  bars: RawGroupedBar[] | null;
  height?: number;
  loading?: boolean;
  emptyLabel?: string;
  legend?: ChartLegendItem[];
};

/**
 * Grouped bars (flash vs redpoint). gifted-charts has no first-class grouped
 * API, so we flatten to a single data array: two adjacent bars per grade with a
 * wider gap separating groups, and the grade label centered under each pair.
 */
export function GroupedBarChart({ bars, height = 150, loading, emptyLabel, legend }: GroupedBarsProps) {
  const { systemColors } = useTheme();
  const isEmpty = !bars || bars.length === 0;
  const groupGap = 14;
  const innerGap = 2;

  return (
    <View>
      <ChartFrame height={height} loading={loading} isEmpty={isEmpty} emptyLabel={emptyLabel}>
        {(width) => {
          const list = bars ?? [];
          const initial = 8;
          const barWidth = Math.max(
            4,
            Math.floor((width - initial * 2 - groupGap * list.length - innerGap * list.length) / (list.length * 2)),
          );
          const data = list.flatMap((bar) =>
            bar.values.map((value, valueIndex) => ({
              value: value.value,
              frontColor: flashRedpointColor(value.key),
              spacing: valueIndex === 0 ? innerGap : groupGap,
              label: valueIndex === 0 ? bar.label : undefined,
              labelWidth: barWidth * 2 + innerGap,
            })),
          );
          // gifted-charts color props are typed `string`, not RN `ColorValue`,
          // so the systemColors values below are cast rather than passed directly.
          return (
            <BarChart
              data={data}
              width={width - 8}
              height={height - 28}
              barWidth={barWidth}
              initialSpacing={initial}
              barBorderRadius={2}
              hideRules
              hideYAxisText
              yAxisThickness={0}
              xAxisThickness={StyleSheet.hairlineWidth}
              xAxisColor={systemColors.separator as string}
              xAxisLabelTextStyle={{ color: systemColors.tertiaryLabel as string, fontSize: AXIS_LABEL_SIZE }}
              isAnimated={false}
              disableScroll
            />
          );
        }}
      </ChartFrame>
      {legend && !isEmpty ? <Legend items={legend} /> : null}
    </View>
  );
}

type AreaProps = {
  timeline: RawVPointsTimeline | null;
  color: string;
  height?: number;
  loading?: boolean;
  emptyLabel?: string;
};

/**
 * Cumulative V-points over time. The shared series are per-layout cumulative;
 * we sum them per week into a single running total and render one filled area
 * (gifted-charts' multi-area stacking is unreliable; the per-layout breakdown
 * is conveyed by the grade-distribution chart instead).
 */
export function TotalAreaChart({ timeline, color, height = 170, loading, emptyLabel }: AreaProps) {
  const { systemColors } = useTheme();
  const isEmpty = !timeline || timeline.series.length === 0;

  // Data + axis labels are width-independent — memoize off the timeline.
  const model = useMemo(() => {
    if (!timeline) return null;
    const weekLabels = timeline.weekLabels;
    const totals = weekLabels.map((_, index) =>
      timeline.series.reduce((sum, series) => sum + (series.data[index] ?? 0), 0),
    );
    const maxValue = Math.max(...totals, 1);
    const sections = 4;
    const yAxisLabelTexts = Array.from({ length: sections + 1 }, (_, index) =>
      formatThousands((maxValue * index) / sections),
    );
    const data = totals.map((value, index) => ({
      value,
      label: downsampleLabel(index, weekLabels.length, weekLabels[index]),
    }));
    return { data, maxValue, sections, yAxisLabelTexts, pointCount: weekLabels.length };
  }, [timeline]);

  return (
    <ChartFrame height={height} loading={loading} isEmpty={isEmpty} emptyLabel={emptyLabel}>
      {(width) => {
        if (!model) return null;
        const spacing = Math.max(1, Math.floor((width - 48) / Math.max(1, model.pointCount - 1)));
        // gifted-charts color props are typed `string`, not RN `ColorValue`,
        // so the systemColors values below are cast rather than passed directly.
        return (
          <LineChart
            areaChart
            data={model.data}
            width={width - 48}
            height={height - 28}
            spacing={spacing}
            initialSpacing={4}
            color={color}
            startFillColor={color}
            endFillColor={color}
            startOpacity={0.35}
            endOpacity={0.05}
            thickness={2}
            hideDataPoints
            curved
            maxValue={model.maxValue}
            noOfSections={model.sections}
            yAxisLabelTexts={model.yAxisLabelTexts}
            yAxisThickness={0}
            xAxisThickness={StyleSheet.hairlineWidth}
            xAxisColor={systemColors.separator as string}
            rulesColor={systemColors.separator as string}
            rulesType="solid"
            yAxisTextStyle={{ color: systemColors.tertiaryLabel as string, fontSize: AXIS_LABEL_SIZE }}
            xAxisLabelTextStyle={{ color: systemColors.tertiaryLabel as string, fontSize: AXIS_LABEL_SIZE }}
            isAnimated={false}
            disableScroll
          />
        );
      }}
    </ChartFrame>
  );
}

const styles = StyleSheet.create({
  frame: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 8,
    paddingHorizontal: 4,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
