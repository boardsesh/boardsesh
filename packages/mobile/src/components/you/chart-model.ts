import type { RawGroupedBar } from '@boardsesh/profile-stats';
import type { ColoredBar, ColoredBarSegment } from './profile-chart-colors';

export type ChartTooltipRow = {
  label: string;
  value: number;
  color: string;
};

export type ChartTooltipModel = {
  title: string;
  total: number;
  rows: ChartTooltipRow[];
};

export function sumSegments(segments: readonly Pick<ColoredBarSegment, 'value'>[]): number {
  return segments.reduce((total, segment) => total + Math.max(segment.value, 0), 0);
}

export function getStackedBarTotal(bar: ColoredBar): number {
  return sumSegments(bar.segments);
}

export function getStackedBarsMaxValue(bars: readonly ColoredBar[] | null | undefined): number {
  if (!bars || bars.length === 0) return 1;
  return Math.max(1, ...bars.map(getStackedBarTotal));
}

export function getGroupedBarsMaxValue(bars: readonly RawGroupedBar[] | null | undefined): number {
  if (!bars || bars.length === 0) return 1;
  return Math.max(1, ...bars.flatMap((bar) => bar.values.map((value) => Math.max(value.value, 0))));
}

export function createStackedTooltipModel(
  bar: ColoredBar,
  resolveColor: (segment: ColoredBarSegment) => string,
): ChartTooltipModel {
  const rows = bar.segments
    .filter((segment) => segment.value > 0)
    .map((segment) => ({
      label: segment.label,
      value: segment.value,
      color: resolveColor(segment),
    }));
  return {
    title: bar.label,
    total: rows.reduce((sum, row) => sum + row.value, 0),
    rows,
  };
}

export function createGroupedTooltipModel(bar: RawGroupedBar, resolveColor: (key: 'flash' | 'redpoint') => string) {
  const rows = bar.values
    .filter((value) => value.value > 0)
    .map((value) => ({
      label: value.label,
      value: value.value,
      color: resolveColor(value.key),
    }));
  return {
    title: bar.label,
    total: rows.reduce((sum, row) => sum + row.value, 0),
    rows,
  };
}
