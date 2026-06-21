import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, View, StyleSheet, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { BarChart, LineChart } from 'react-native-gifted-charts';
import type { RawGroupedBar, RawVPointsTimeline } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius, opacity, materialElevationByLevel } from '../../theme/tokens';
import { useVariantValue } from '../../theme/variants';
import { hapticSelection } from '../../lib/haptics';
import { gradeChartColor, layoutChartColor, flashRedpointColor, type ColoredBar } from './profile-chart-colors';
import {
  createGroupedTooltipModel,
  createStackedTooltipModel,
  getGroupedBarsMaxValue,
  getStackedBarsMaxValue,
  type ChartTooltipModel,
} from './chart-model';

const MAX_X_LABELS = 12;
const AXIS_LABEL_SIZE = 11;
const STACK_BAR_RADIUS = 3;
const MIN_ZOOM_SCALE = 1;
const MAX_ZOOM_SCALE = 2.75;
// Floor for grouped flash|redpoint bars so a dense V0-V17 axis keeps each bar
// above the iOS 44pt / Android 48dp touch target instead of shrinking to 4px.
const MIN_GROUPED_BAR = 6;
// Selection lowlight for the interactive grouped chart: the flash/redpoint fills
// already carry their own 0.85 alpha, so a deeper dim keeps unselected pairs
// readable on the dark violet card while the focused pair still pops.
const CHART_LOWLIGHT_OPACITY = 0.5;

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

function clampZoomScale(value: number): number {
  return Math.max(MIN_ZOOM_SCALE, Math.min(MAX_ZOOM_SCALE, value));
}

function touchDistance(event: GestureResponderEvent): number | null {
  const [firstTouch, secondTouch] = event.nativeEvent.touches;
  if (!firstTouch || !secondTouch) return null;
  return Math.hypot(secondTouch.pageX - firstTouch.pageX, secondTouch.pageY - firstTouch.pageY);
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
  zoomable?: boolean;
  children: (width: number, zoomScale: number, scrollEnabled: boolean) => ReactNode;
};

/** Measures available width and renders loading / empty / chart states. */
function ChartFrame({ height, loading, emptyLabel, isEmpty, zoomable, children }: FrameProps) {
  const { systemColors, chartColors } = useTheme();
  // Material casts a shadow under the floating chrome; Liquid Glass stays flat
  // (its border carries the edge). Routed through the variant selector so the
  // mobile-variant guard stays happy.
  const floatingElevation = useVariantValue({ material: materialElevationByLevel.level2, liquidGlass: null });
  const { t } = useTranslation('common');
  const [width, setWidth] = useState(0);
  const [zoomScale, setZoomScale] = useState(MIN_ZOOM_SCALE);
  const pinchStartDistanceRef = useRef<number | null>(null);
  const pinchStartScaleRef = useRef(MIN_ZOOM_SCALE);
  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);
  const updateZoomScale = useCallback((nextScale: number) => {
    setZoomScale((currentScale) => {
      const clampedScale = clampZoomScale(nextScale);
      return Math.abs(currentScale - clampedScale) < 0.01 ? currentScale : clampedScale;
    });
  }, []);
  const canZoom = zoomable === true && !loading && !isEmpty && width > 0;
  const resetZoom = useCallback(() => {
    pinchStartDistanceRef.current = null;
    pinchStartScaleRef.current = MIN_ZOOM_SCALE;
    setZoomScale(MIN_ZOOM_SCALE);
  }, []);
  const shouldCapturePinch = useCallback(
    (event: GestureResponderEvent) => canZoom && event.nativeEvent.touches.length >= 2,
    [canZoom],
  );
  const startPinch = useCallback(
    (event: GestureResponderEvent) => {
      const distance = touchDistance(event);
      if (!distance) return;
      pinchStartDistanceRef.current = distance;
      pinchStartScaleRef.current = zoomScale;
    },
    [zoomScale],
  );
  const updatePinch = useCallback(
    (event: GestureResponderEvent) => {
      const distance = touchDistance(event);
      if (!distance) return;

      if (pinchStartDistanceRef.current == null) {
        pinchStartDistanceRef.current = distance;
        pinchStartScaleRef.current = zoomScale;
      }

      const nextScale = pinchStartScaleRef.current * (distance / pinchStartDistanceRef.current);
      updateZoomScale(nextScale);
    },
    [updateZoomScale, zoomScale],
  );
  const endPinch = useCallback(() => {
    pinchStartDistanceRef.current = null;
    pinchStartScaleRef.current = zoomScale;
  }, [zoomScale]);
  const shouldReleaseResponder = useCallback(() => pinchStartDistanceRef.current == null, []);

  useEffect(() => {
    if (!canZoom) resetZoom();
  }, [canZoom, resetZoom]);

  const isZoomed = zoomScale > MIN_ZOOM_SCALE + 0.01;

  return (
    <View
      style={[styles.frame, { height }]}
      onLayout={onLayout}
      onStartShouldSetResponderCapture={shouldCapturePinch}
      onMoveShouldSetResponderCapture={shouldCapturePinch}
      onResponderGrant={startPinch}
      onResponderMove={updatePinch}
      onResponderRelease={endPinch}
      onResponderTerminate={endPinch}
      onResponderTerminationRequest={shouldReleaseResponder}
    >
      {loading ? (
        <ActivityIndicator size="small" color={chartColors.secondaryLabel} />
      ) : isEmpty ? (
        <View style={styles.emptyState} accessibilityRole="image" accessibilityLabel={emptyLabel}>
          <Icon name="chart.bar" size={22} color={systemColors.tertiaryLabel} />
          <Text variant="footnote" color={systemColors.tertiaryLabel}>
            {emptyLabel}
          </Text>
        </View>
      ) : width > 0 ? (
        children(width, zoomScale, canZoom && isZoomed)
      ) : null}
      {canZoom && isZoomed ? (
        <Pressable
          onPress={resetZoom}
          style={[
            styles.resetZoomButton,
            {
              backgroundColor: systemColors.elevatedSurface,
              borderColor: systemColors.separator,
            },
            floatingElevation,
          ]}
          accessibilityRole="button"
          accessibilityLabel={t('resetZoom')}
          hitSlop={8}
        >
          <Icon name="crop.free" size={15} color={systemColors.label} />
        </Pressable>
      ) : null}
    </View>
  );
}

function TooltipBubble({ model, totalLabel }: { model: ChartTooltipModel | undefined; totalLabel: string }) {
  const { systemColors } = useTheme();
  const floatingElevation = useVariantValue({ material: materialElevationByLevel.level2, liquidGlass: null });
  if (!model) return null;

  return (
    <View
      style={[
        styles.tooltip,
        {
          backgroundColor: systemColors.elevatedSurface,
          borderColor: systemColors.separator,
        },
        floatingElevation,
      ]}
    >
      <Text variant="caption1" style={styles.tooltipTitle} numberOfLines={1}>
        {model.title}
      </Text>
      <View style={styles.tooltipTotal}>
        <Text variant="caption2" color={systemColors.secondaryLabel}>
          {totalLabel}
        </Text>
        <Text variant="caption2" style={styles.tooltipValue}>
          {formatThousands(model.total)}
        </Text>
      </View>
      {model.rows.slice(0, 4).map((row) => (
        <View key={`${row.label}-${row.value}`} style={styles.tooltipRow}>
          <View style={[styles.tooltipDot, { backgroundColor: row.color }]} />
          <Text variant="caption2" color={systemColors.secondaryLabel} style={styles.tooltipRowLabel} numberOfLines={1}>
            {row.label}
          </Text>
          <Text variant="caption2" style={styles.tooltipValue}>
            {formatThousands(row.value)}
          </Text>
        </View>
      ))}
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
  interactive?: boolean;
  zoomable?: boolean;
  fitYAxisToData?: boolean;
  showYAxisScale?: boolean;
  minBarWidth?: number;
  /**
   * Screen-reader summary for the whole chart. When set, the outer wrapper
   * announces it as an image and the inner SVG primitives are hidden from
   * accessibility so VoiceOver/TalkBack don't traverse the bars individually.
   */
  accessibilityLabel?: string;
};

/** Stacked bars (weekly activity, grade distribution). */
export const StackedBarChart = memo(function StackedBarChart({
  bars,
  colorBy,
  height = 170,
  loading,
  emptyLabel,
  legend,
  maxXLabels,
  interactive = true,
  zoomable = true,
  fitYAxisToData,
  showYAxisScale,
  minBarWidth = 4,
  accessibilityLabel,
}: StackedBarsProps) {
  // gifted-charts colour props require plain strings (not PlatformColor); `chartColors`
  // is the matching string table per variant+scheme, resolved once by the provider.
  const { colorScheme, chartColors } = useTheme();
  const { t } = useTranslation('profile');
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const isEmpty = !bars || bars.length === 0;

  // Color resolution is width-independent, so memoize it off the data.
  const tooltipModels = useMemo(
    () =>
      (bars ?? []).map((bar) =>
        createStackedTooltipModel(
          bar,
          (segment) =>
            segment.color ??
            (colorBy === 'grade'
              ? gradeChartColor(segment.key, colorScheme)
              : layoutChartColor(segment.key, colorScheme)),
        ),
      ),
    [bars, colorBy, colorScheme],
  );
  const yAxisMaxValue = fitYAxisToData ? getStackedBarsMaxValue(bars) : undefined;
  const handlePress = useCallback(
    (index: number) => {
      if (!interactive) return;
      setSelectedIndex(index);
      hapticSelection();
    },
    [interactive],
  );

  const stackData = useMemo(
    () =>
      (bars ?? []).map((bar, index) => {
        const filled = bar.segments
          .filter((segment) => segment.value > 0)
          .map((segment) => ({
            value: segment.value,
            // An explicit segment colour wins; otherwise fall back to colorBy.
            color:
              segment.color ??
              (colorBy === 'grade'
                ? gradeChartColor(segment.key, colorScheme)
                : layoutChartColor(segment.key, colorScheme)),
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
          onPress: interactive ? () => handlePress(index) : undefined,
        };
      }),
    [bars, colorBy, colorScheme, handlePress, interactive, maxXLabels],
  );
  const selectedTooltip = selectedIndex == null ? undefined : tooltipModels[selectedIndex];

  return (
    <View
      accessible={accessibilityLabel ? true : undefined}
      accessibilityRole={accessibilityLabel ? 'image' : undefined}
      accessibilityLabel={accessibilityLabel}
    >
      <View style={styles.chartShell} importantForAccessibility={accessibilityLabel ? 'no-hide-descendants' : 'auto'}>
        <ChartFrame
          height={height}
          loading={loading}
          isEmpty={isEmpty}
          emptyLabel={emptyLabel}
          zoomable={interactive && zoomable}
        >
          {(width, zoomScale, scrollEnabled) => {
            const fitted = fitBars(width, stackData.length, minBarWidth);
            const barWidth = Math.max(minBarWidth, Math.round(fitted.barWidth * zoomScale));
            const spacing = Math.max(2, Math.round(fitted.spacing * zoomScale));
            // gifted sizes each x-axis label box to ~one bar by default, so a wide
            // week label ("W23 '24") on a 5px bar clips to "...". Give every KEPT
            // label the full downsample-step width so it renders in full; blanked
            // labels keep a 0 box so they don't steal layout.
            const effectiveMaxLabels = maxXLabels ?? MAX_X_LABELS;
            const labelStep =
              stackData.length > effectiveMaxLabels ? Math.ceil(stackData.length / effectiveMaxLabels) : 1;
            const labelBudget = labelStep * (barWidth + spacing);
            const sizedData = stackData.map((bar) => (bar.label ? { ...bar, labelWidth: labelBudget } : bar));
            return (
              <BarChart
                stackData={sizedData}
                width={width - 8}
                height={height - 28}
                barWidth={barWidth}
                spacing={spacing}
                initialSpacing={8}
                hideRules={!showYAxisScale}
                hideYAxisText={!showYAxisScale}
                yAxisLabelWidth={showYAxisScale ? 32 : 0}
                maxValue={yAxisMaxValue}
                yAxisThickness={0}
                xAxisThickness={StyleSheet.hairlineWidth}
                xAxisColor={chartColors.separator}
                xAxisLabelTextStyle={{ color: chartColors.tertiaryLabel, fontSize: AXIS_LABEL_SIZE }}
                yAxisTextStyle={{ color: chartColors.tertiaryLabel, fontSize: AXIS_LABEL_SIZE }}
                rulesColor={chartColors.separator}
                rulesType="solid"
                focusBarOnPress={interactive}
                highlightedBarIndex={selectedIndex ?? -1}
                highlightEnabled={interactive && selectedIndex != null}
                lowlightOpacity={opacity.peek}
                onBackgroundPress={interactive ? () => setSelectedIndex(null) : undefined}
                isAnimated={false}
                disableScroll={!scrollEnabled}
                disablePress={!interactive}
              />
            );
          }}
        </ChartFrame>
        {interactive && selectedTooltip ? (
          <View pointerEvents="none" style={styles.tooltipOverlay}>
            <TooltipBubble model={selectedTooltip} totalLabel={t('stats.chartTooltipTotal')} />
          </View>
        ) : null}
      </View>
      {legend && !isEmpty ? <Legend items={legend} /> : null}
    </View>
  );
});

type GroupedBarsProps = {
  bars: RawGroupedBar[] | null;
  height?: number;
  loading?: boolean;
  emptyLabel?: string;
  legend?: ChartLegendItem[];
  interactive?: boolean;
  zoomable?: boolean;
  fitYAxisToData?: boolean;
};

/**
 * Grouped bars (flash vs redpoint). gifted-charts has no first-class grouped
 * API, so we flatten to a single data array: two adjacent bars per grade with a
 * wider gap separating groups, and the grade label centered under each pair.
 */
export const GroupedBarChart = memo(function GroupedBarChart({
  bars,
  height = 150,
  loading,
  emptyLabel,
  legend,
  interactive = true,
  zoomable = true,
  fitYAxisToData,
}: GroupedBarsProps) {
  const { colorScheme, chartColors } = useTheme();
  const { t } = useTranslation('profile');
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const isEmpty = !bars || bars.length === 0;
  const groupGap = 16;
  const innerGap = 3;
  const tooltipModels = useMemo(
    () => (bars ?? []).map((bar) => createGroupedTooltipModel(bar, (key) => flashRedpointColor(key, colorScheme))),
    [bars, colorScheme],
  );
  const yAxisMaxValue = fitYAxisToData ? getGroupedBarsMaxValue(bars) : undefined;
  const handlePress = useCallback(
    (index: number) => {
      if (!interactive) return;
      setSelectedIndex(index);
      hapticSelection();
    },
    [interactive],
  );
  const selectedTooltip = selectedIndex == null ? undefined : tooltipModels[selectedIndex];

  return (
    <View>
      <View style={styles.chartShell}>
        <ChartFrame
          height={height}
          loading={loading}
          isEmpty={isEmpty}
          emptyLabel={emptyLabel}
          zoomable={interactive && zoomable}
        >
          {(width, zoomScale, scrollEnabled) => {
            const list = bars ?? [];
            const initial = 8;
            const baseBarWidth = Math.max(
              MIN_GROUPED_BAR,
              Math.floor((width - initial * 2 - groupGap * list.length - innerGap * list.length) / (list.length * 2)),
            );
            const barWidth = Math.max(MIN_GROUPED_BAR, Math.round(baseBarWidth * zoomScale));
            const zoomedGroupGap = Math.max(groupGap, Math.round(groupGap * zoomScale));
            const zoomedInnerGap = Math.max(innerGap, Math.round(innerGap * zoomScale));
            const data = list.flatMap((bar, barIndex) =>
              bar.values.map((value, valueIndex) => ({
                value: value.value,
                frontColor: flashRedpointColor(value.key, colorScheme),
                spacing: valueIndex === 0 ? zoomedInnerGap : zoomedGroupGap,
                label: valueIndex === 0 ? bar.label : undefined,
                labelWidth: barWidth * 2 + zoomedInnerGap,
                onPress: interactive ? () => handlePress(barIndex) : undefined,
                topLabelComponent:
                  value.value > 0
                    ? () => (
                        <Text variant="caption2" color={chartColors.secondaryLabel} style={styles.barTopLabel}>
                          {value.value}
                        </Text>
                      )
                    : undefined,
              })),
            );
            return (
              <BarChart
                data={data}
                width={width - 8}
                height={height - 28}
                barWidth={barWidth}
                initialSpacing={initial}
                barBorderRadius={STACK_BAR_RADIUS}
                topLabelContainerStyle={{ width: barWidth }}
                hideRules
                hideYAxisText
                maxValue={yAxisMaxValue}
                yAxisThickness={0}
                xAxisThickness={StyleSheet.hairlineWidth}
                xAxisColor={chartColors.separator}
                xAxisLabelTextStyle={{ color: chartColors.tertiaryLabel, fontSize: AXIS_LABEL_SIZE }}
                focusBarOnPress={interactive}
                highlightedBarIndex={selectedIndex == null ? -1 : [selectedIndex * 2, selectedIndex * 2 + 1]}
                highlightEnabled={interactive && selectedIndex != null}
                lowlightOpacity={CHART_LOWLIGHT_OPACITY}
                onBackgroundPress={interactive ? () => setSelectedIndex(null) : undefined}
                isAnimated={false}
                disableScroll={!scrollEnabled}
                disablePress={!interactive}
              />
            );
          }}
        </ChartFrame>
        {interactive && selectedTooltip ? (
          <View pointerEvents="none" style={styles.tooltipOverlay}>
            <TooltipBubble model={selectedTooltip} totalLabel={t('stats.chartTooltipTotal')} />
          </View>
        ) : null}
      </View>
      {legend && !isEmpty ? <Legend items={legend} /> : null}
    </View>
  );
});

type AreaProps = {
  timeline: RawVPointsTimeline | null;
  color: string;
  height?: number;
  loading?: boolean;
  emptyLabel?: string;
  interactive?: boolean;
  zoomable?: boolean;
  /** Max x-axis labels before downsampling blanks the rest (default 6 here —
   *  week labels are wide, so fewer-but-readable beats a dense dotted axis). */
  maxXLabels?: number;
};

/**
 * Cumulative V-points over time. The shared series are per-layout cumulative;
 * we sum them per week into a single running total and render one filled area
 * (gifted-charts' multi-area stacking is unreliable; the per-layout breakdown
 * is conveyed by the grade-distribution chart instead).
 */
export const TotalAreaChart = memo(function TotalAreaChart({
  timeline,
  color,
  height = 170,
  loading,
  emptyLabel,
  interactive = true,
  zoomable = true,
  maxXLabels = 6,
}: AreaProps) {
  const { chartColors, colorScheme } = useTheme();
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
    const latestTotal = totals[totals.length - 1] ?? 0;
    // Mark only the final datum: a coloured end dot + a value pill so the eye
    // lands on the current cumulative total. Interior points stay hidden.
    const data = totals.map((value, index) => {
      const isLast = index === totals.length - 1;
      return {
        value,
        label: downsampleLabel(index, weekLabels.length, weekLabels[index], maxXLabels),
        hideDataPoint: !isLast,
        ...(isLast
          ? {
              dataPointColor: color,
              dataPointRadius: 4,
              dataPointLabelShiftY: -14,
              dataPointLabelShiftX: -12,
              dataPointLabelComponent: () => (
                <View
                  style={[
                    styles.endValuePill,
                    { backgroundColor: chartColors.elevatedSurface, borderColor: chartColors.separator },
                  ]}
                >
                  <Text variant="caption2" color={chartColors.label} style={styles.endValueText}>
                    {formatThousands(latestTotal)}
                  </Text>
                </View>
              ),
            }
          : {}),
      };
    });
    return { data, maxValue, sections, yAxisLabelTexts, pointCount: weekLabels.length, latestTotal };
  }, [timeline, color, maxXLabels, chartColors.elevatedSurface, chartColors.separator, chartColors.label]);

  return (
    <ChartFrame
      height={height}
      loading={loading}
      isEmpty={isEmpty}
      emptyLabel={emptyLabel}
      zoomable={interactive && zoomable}
    >
      {(width, zoomScale, scrollEnabled) => {
        if (!model) return null;
        const baseSpacing = Math.max(1, Math.floor((width - 48) / Math.max(1, model.pointCount - 1)));
        const lineSpacing = Math.max(1, Math.round(baseSpacing * zoomScale));
        // lineDataItem has no labelWidth, so the default axis label box is ~one
        // point wide and a "W23 '24" label collapses to a dot. Render kept labels
        // through a fixed-width labelComponent (step budget) so they're legible.
        const labelStep = model.pointCount > maxXLabels ? Math.ceil(model.pointCount / maxXLabels) : 1;
        const labelBudget = labelStep * lineSpacing;
        const sizedData = model.data.map((point) =>
          point.label
            ? {
                ...point,
                labelComponent: () => (
                  <Text
                    variant="caption2"
                    color={chartColors.tertiaryLabel}
                    style={[styles.lineAxisLabel, { width: labelBudget }]}
                    numberOfLines={1}
                  >
                    {point.label}
                  </Text>
                ),
              }
            : point,
        );
        return (
          <LineChart
            areaChart
            data={sizedData}
            width={width - 48}
            height={height - 28}
            spacing={lineSpacing}
            initialSpacing={4}
            endSpacing={spacing[4]}
            color={color}
            startFillColor={color}
            endFillColor={color}
            startOpacity={colorScheme === 'dark' ? 0.55 : 0.42}
            endOpacity={colorScheme === 'dark' ? 0.1 : 0.04}
            gradientDirection="vertical"
            thickness={2}
            curved
            curvature={0.2}
            maxValue={model.maxValue}
            noOfSections={model.sections}
            yAxisLabelTexts={model.yAxisLabelTexts}
            yAxisThickness={0}
            xAxisThickness={StyleSheet.hairlineWidth}
            xAxisColor={chartColors.separator}
            rulesColor={chartColors.separator}
            rulesType="solid"
            yAxisTextStyle={{ color: chartColors.tertiaryLabel, fontSize: AXIS_LABEL_SIZE }}
            xAxisLabelTextStyle={{ color: chartColors.tertiaryLabel, fontSize: AXIS_LABEL_SIZE }}
            pointerConfig={{
              pointerStripColor: chartColors.separator,
              pointerStripWidth: 1,
              stripOverPointer: true,
              pointerColor: color,
              radius: 4,
              pointerLabelWidth: 96,
              pointerLabelHeight: 44,
              activatePointersOnLongPress: false,
              autoAdjustPointerLabelPosition: true,
              pointerVanishDelay: 1600,
              pointerLabelComponent: (items: { value: number; label?: string }[]) => (
                <View
                  style={[
                    styles.tooltip,
                    { backgroundColor: chartColors.elevatedSurface, borderColor: chartColors.separator },
                  ]}
                >
                  <Text variant="caption2" color={chartColors.secondaryLabel} numberOfLines={1}>
                    {items[0]?.label}
                  </Text>
                  <Text variant="caption1" style={styles.tooltipValue}>
                    {formatThousands(items[0]?.value ?? 0)}
                  </Text>
                </View>
              ),
            }}
            isAnimated={false}
            disableScroll={!scrollEnabled}
          />
        );
      }}
    </ChartFrame>
  );
});

const styles = StyleSheet.create({
  frame: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyState: {
    alignItems: 'center',
    gap: spacing[2],
  },
  barTopLabel: {
    marginBottom: 2,
    textAlign: 'center',
    fontWeight: '600',
  },
  lineAxisLabel: {
    textAlign: 'center',
  },
  endValuePill: {
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing[1],
    paddingVertical: 1,
    borderWidth: StyleSheet.hairlineWidth,
  },
  endValueText: {
    fontWeight: '700',
    textAlign: 'center',
  },
  resetZoomButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 5,
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chartShell: {
    position: 'relative',
  },
  tooltipOverlay: {
    position: 'absolute',
    top: 8,
    left: 12,
    right: 12,
    alignItems: 'center',
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
  tooltip: {
    minWidth: 128,
    maxWidth: 168,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 4,
  },
  tooltipTitle: {
    fontWeight: '700',
  },
  tooltipTotal: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  tooltipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  tooltipDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  tooltipRowLabel: {
    flex: 1,
  },
  tooltipValue: {
    fontWeight: '700',
  },
});
