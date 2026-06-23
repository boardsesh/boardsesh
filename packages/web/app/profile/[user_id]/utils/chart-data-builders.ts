import {
  filterLogbookByTimeframe,
  buildAggregatedStackedBars as buildAggregatedStackedBarsRaw,
  buildWeeklyBars as buildWeeklyBarsRaw,
  buildFlashRedpointBars as buildFlashRedpointBarsRaw,
  buildAggregatedFlashRedpointBars as buildAggregatedFlashRedpointBarsRaw,
  buildVPointsTimeline as buildVPointsTimelineRaw,
  buildStatisticsSummary as buildStatisticsSummaryRaw,
  parseLayoutKey,
  type LogbookEntry,
  type UnifiedTimeframeType,
} from '@boardsesh/profile-stats';
import type { GetUserProfileStatsQueryResponse } from '@boardsesh/graphql/operations';
import type { CssBarChartBar, GroupedBar } from '@/app/components/charts/css-bar-chart';
import { type GradeDisplayFormat } from '@/app/lib/grade-colors';
import { getGradeChartColor, getLayoutColor } from './profile-constants';

// The aggregation logic lives in @boardsesh/profile-stats (renderer-agnostic,
// keyed by gradeKey/layoutKey/flash|redpoint, no colors). This module is the
// WEB adapter: it calls the shared raw builders and maps the keys back to the
// web's design-token colors, reconstructing the exact CssBarChartBar /
// GroupedBar / VPointsTimelineData / LayoutPercentage shapes the chart
// components already consume.

// Re-export the (color-less) timeframe filter unchanged.
export { filterLogbookByTimeframe };

// Flash/redpoint legend colours (60% opacity). Scheme-neutral mid-tones so the bars
// read on both light and dark surfaces — these feed chart data (not CSS), so a
// scheme-aware var() can't be used.
const FLASH_COLOR = '#10b98199';
const REDPOINT_COLOR = '#ef444499';

const layoutColorForKey = (layoutKey: string): string => {
  const { boardType, layoutId } = parseLayoutKey(layoutKey);
  return getLayoutColor(boardType, layoutId);
};

// ── Aggregated stacked bars (grade x layout, for stats summary) ─────

export type LayoutLegendEntry = {
  label: string;
  color: string;
};

export function buildAggregatedStackedBars(
  allBoardsTicks: Record<string, LogbookEntry[]>,
  timeframe: UnifiedTimeframeType,
  gradeFormat: GradeDisplayFormat = 'v-grade',
  fromDate?: string,
  toDate?: string,
): { bars: CssBarChartBar[]; legendEntries: LayoutLegendEntry[] } | null {
  const raw = buildAggregatedStackedBarsRaw(allBoardsTicks, timeframe, gradeFormat, fromDate, toDate);
  if (!raw) return null;

  const legendEntries: LayoutLegendEntry[] = raw.legend.map((entry) => ({
    label: entry.label,
    color: layoutColorForKey(entry.key),
  }));

  const bars: CssBarChartBar[] = raw.bars.map((bar) => ({
    key: bar.key,
    label: bar.label,
    segments: bar.segments.map((segment) => ({
      value: segment.value,
      color: layoutColorForKey(segment.key),
      label: segment.label,
    })),
  }));

  return { bars, legendEntries };
}

// ── Weekly stacked bars ─────────────────────────────────────────────

export function buildWeeklyBars(
  filteredLogbook: LogbookEntry[],
  fromDate?: string,
  toDate?: string,
  gradeFormat: GradeDisplayFormat = 'v-grade',
): CssBarChartBar[] | null {
  const raw = buildWeeklyBarsRaw(filteredLogbook, fromDate, toDate, gradeFormat);
  if (!raw) return null;

  return raw.map((bar) => ({
    key: bar.key,
    label: bar.label,
    segments: bar.segments.map((segment) => ({
      value: segment.value,
      color: getGradeChartColor(segment.key),
      label: segment.label,
    })),
  }));
}

// ── Flash vs Redpoint grouped bars ──────────────────────────────────

function colorGroupedBars(raw: ReturnType<typeof buildFlashRedpointBarsRaw>): GroupedBar[] | null {
  if (!raw) return null;
  return raw.map((bar) => ({
    key: bar.key,
    label: bar.label,
    values: bar.values.map((value) => ({
      value: value.value,
      color: value.key === 'flash' ? FLASH_COLOR : REDPOINT_COLOR,
      label: value.label,
    })),
  }));
}

export function buildFlashRedpointBars(
  filteredLogbook: LogbookEntry[],
  gradeFormat: GradeDisplayFormat = 'v-grade',
): GroupedBar[] | null {
  return colorGroupedBars(buildFlashRedpointBarsRaw(filteredLogbook, gradeFormat));
}

export function buildAggregatedFlashRedpointBars(
  allBoardsTicks: Record<string, LogbookEntry[]>,
  timeframe: UnifiedTimeframeType,
  gradeFormat: GradeDisplayFormat = 'v-grade',
  fromDate?: string,
  toDate?: string,
): GroupedBar[] | null {
  return colorGroupedBars(
    buildAggregatedFlashRedpointBarsRaw(allBoardsTicks, timeframe, gradeFormat, fromDate, toDate),
  );
}

// ── V-Points stacked area timeline ──────────────────────────────────

export type VPointsLayoutSeries = {
  layoutKey: string;
  displayName: string;
  color: string;
  /** Cumulative v-points per week for this layout */
  data: number[];
};

export type VPointsTimelineData = {
  weekLabels: string[];
  series: VPointsLayoutSeries[];
  totalPoints: number;
};

export function buildVPointsTimeline(
  allBoardsTicks: Record<string, LogbookEntry[]>,
  timeframe: UnifiedTimeframeType,
  fromDate?: string,
  toDate?: string,
): VPointsTimelineData | null {
  const raw = buildVPointsTimelineRaw(allBoardsTicks, timeframe, fromDate, toDate);
  if (!raw) return null;

  return {
    weekLabels: raw.weekLabels,
    totalPoints: raw.totalPoints,
    series: raw.series.map((series) => ({
      layoutKey: series.layoutKey,
      displayName: series.displayName,
      color: layoutColorForKey(series.layoutKey),
      data: series.data,
    })),
  };
}

// ── Statistics summary (layout percentages) ─────────────────────────

export type LayoutPercentage = {
  layoutKey: string;
  boardType: string;
  layoutId: number | null;
  displayName: string;
  color: string;
  count: number;
  grades: Record<string, number>;
  percentage: number;
};

export function buildStatisticsSummary(
  profileStats: GetUserProfileStatsQueryResponse['userProfileStats'] | null,
  gradeFormat: GradeDisplayFormat = 'v-grade',
): { totalAscents: number; layoutPercentages: LayoutPercentage[] } {
  const raw = buildStatisticsSummaryRaw(profileStats, gradeFormat);
  return {
    totalAscents: raw.totalAscents,
    layoutPercentages: raw.layoutPercentages.map((layout) => ({
      ...layout,
      color: getLayoutColor(layout.boardType, layout.layoutId),
    })),
  };
}
