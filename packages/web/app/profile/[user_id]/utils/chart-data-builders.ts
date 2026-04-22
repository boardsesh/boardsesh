import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore';
import type { GetUserProfileStatsQueryResponse } from '@/app/lib/graphql/operations';
import type { CssBarChartBar } from '@/app/components/charts/css-bar-chart';
import type { GroupedBar } from '@/app/components/charts/css-bar-chart';
import { themeTokens } from '@/app/theme/theme-config';
import { type GradeDisplayFormat } from '@/app/lib/grade-colors';
import {
  type LogbookEntry,
  type UnifiedTimeframeType,
  difficultyMapping,
  getDifficultyMapping,
  sortGrades,
  getGradeChartColor,
  getLayoutKey,
  getLayoutDisplayName,
  getLayoutColor,
  BOARD_TYPES,
} from './profile-constants';

// Derive flash/redpoint colors from design tokens
const FLASH_COLOR = `${themeTokens.colors.success}99`; // 60% opacity hex
const REDPOINT_COLOR = `${themeTokens.colors.error}99`;

dayjs.extend(isoWeek);
dayjs.extend(isSameOrAfter);
dayjs.extend(isSameOrBefore);

// ── Timeframe filtering ─────────────────────────────────────────────

export function filterLogbookByTimeframe(
  logbook: LogbookEntry[],
  timeframe: UnifiedTimeframeType,
  fromDate: string,
  toDate: string,
): LogbookEntry[] {
  const now = dayjs();
  switch (timeframe) {
    case 'today':
      return logbook.filter((entry) => dayjs(entry.climbed_at).isSame(now, 'day'));
    case 'lastWeek':
      return logbook.filter((entry) => dayjs(entry.climbed_at).isAfter(now.subtract(1, 'week')));
    case 'lastMonth':
      return logbook.filter((entry) => dayjs(entry.climbed_at).isAfter(now.subtract(1, 'month')));
    case 'lastYear':
      return logbook.filter((entry) => dayjs(entry.climbed_at).isAfter(now.subtract(1, 'year')));
    case 'custom':
      return logbook.filter((entry) => {
        // Compare date strings only (YYYY-MM-DD) to avoid timezone issues.
        // climbed_at is an ISO 8601 UTC timestamp, but the user picks calendar
        // dates — matching on the date portion keeps the filter intuitive and
        // timezone-agnostic.
        const dateStr = entry.climbed_at.slice(0, 10); // 'YYYY-MM-DD'
        return dateStr >= fromDate && dateStr <= toDate;
      });
    case 'all':
    default:
      return logbook;
  }
}

// ── Shared timeframe filter ─────────────────────────────────────────

function filterByUnifiedTimeframe(
  entries: LogbookEntry[],
  timeframe: UnifiedTimeframeType,
  fromDate?: string,
  toDate?: string,
): LogbookEntry[] {
  if (timeframe === 'all') return entries;
  const now = dayjs();
  return entries.filter((entry) => {
    switch (timeframe) {
      case 'today':
        return dayjs(entry.climbed_at).isSame(now, 'day');
      case 'lastWeek':
        return dayjs(entry.climbed_at).isAfter(now.subtract(1, 'week'));
      case 'lastMonth':
        return dayjs(entry.climbed_at).isAfter(now.subtract(1, 'month'));
      case 'lastYear':
        return dayjs(entry.climbed_at).isAfter(now.subtract(1, 'year'));
      case 'custom': {
        const dateStr = entry.climbed_at.slice(0, 10);
        return (!fromDate || dateStr >= fromDate) && (!toDate || dateStr <= toDate);
      }
      default:
        return true;
    }
  });
}

// ── Aggregated stacked bars (grade x layout, for stats summary) ─────

export interface LayoutLegendEntry {
  label: string;
  color: string;
}

export function buildAggregatedStackedBars(
  allBoardsTicks: Record<string, LogbookEntry[]>,
  timeframe: UnifiedTimeframeType,
  gradeFormat: GradeDisplayFormat = 'v-grade',
  fromDate?: string,
  toDate?: string,
): { bars: CssBarChartBar[]; legendEntries: LayoutLegendEntry[] } | null {
  const mapping = getDifficultyMapping(gradeFormat);
  const layoutGradeClimbs: Record<string, Record<string, Set<string>>> = {};
  const allGrades = new Set<string>();
  const allLayouts = new Set<string>();

  BOARD_TYPES.forEach((boardType) => {
    const ticks = allBoardsTicks[boardType] || [];
    const filteredTicks = filterByUnifiedTimeframe(ticks, timeframe, fromDate, toDate);

    filteredTicks.forEach((entry) => {
      if (entry.difficulty === null || entry.status === 'attempt' || !entry.climbUuid) return;
      const grade = mapping[entry.difficulty];
      if (grade) {
        const layoutKey = getLayoutKey(boardType, entry.layoutId);
        if (!layoutGradeClimbs[layoutKey]) layoutGradeClimbs[layoutKey] = {};
        if (!layoutGradeClimbs[layoutKey][grade]) layoutGradeClimbs[layoutKey][grade] = new Set();
        layoutGradeClimbs[layoutKey][grade].add(entry.climbUuid);
        allGrades.add(grade);
        allLayouts.add(layoutKey);
      }
    });
  });

  if (allGrades.size === 0) return null;

  const sortedGrades = sortGrades(Array.from(allGrades), gradeFormat);

  const layoutOrder = [
    'kilter-1',
    'kilter-8',
    'tension-9',
    'tension-10',
    'tension-11',
    'moonboard-1',
    'moonboard-2',
    'moonboard-3',
    'moonboard-4',
    'moonboard-5',
  ];
  const sortedLayouts = Array.from(allLayouts).sort((a, b) => {
    const indexA = layoutOrder.indexOf(a);
    const indexB = layoutOrder.indexOf(b);
    if (indexA !== -1 && indexB !== -1) return indexA - indexB;
    if (indexA !== -1) return -1;
    if (indexB !== -1) return 1;
    return a.localeCompare(b);
  });

  const legendEntries: LayoutLegendEntry[] = sortedLayouts.map((layoutKey) => {
    const [boardType, layoutIdStr] = layoutKey.split('-');
    const layoutId = layoutIdStr === 'unknown' ? null : parseInt(layoutIdStr, 10);
    return {
      label: getLayoutDisplayName(boardType, layoutId),
      color: getLayoutColor(boardType, layoutId),
    };
  });

  const bars: CssBarChartBar[] = sortedGrades.map((grade) => ({
    key: grade,
    label: grade,
    segments: sortedLayouts.map((layoutKey) => {
      const [boardType, layoutIdStr] = layoutKey.split('-');
      const layoutId = layoutIdStr === 'unknown' ? null : parseInt(layoutIdStr, 10);
      return {
        value: layoutGradeClimbs[layoutKey]?.[grade]?.size || 0,
        color: getLayoutColor(boardType, layoutId),
        label: getLayoutDisplayName(boardType, layoutId),
      };
    }),
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
  if (filteredLogbook.length === 0) return null;

  const mapping = getDifficultyMapping(gradeFormat);

  const entries =
    fromDate || toDate
      ? filteredLogbook.filter((entry) => {
          const d = dayjs(entry.climbed_at);
          if (fromDate && d.isBefore(dayjs(fromDate), 'day')) return false;
          if (toDate && d.isAfter(dayjs(toDate), 'day')) return false;
          return true;
        })
      : filteredLogbook;

  if (entries.length === 0) return null;

  const DEFAULT_MAX_WEEKS = 52;
  const allWeekKeys: string[] = [];
  const first = dayjs(entries[entries.length - 1]?.climbed_at).startOf('isoWeek');
  const last = dayjs(entries[0]?.climbed_at).endOf('isoWeek');
  let current = first;
  while (current.isBefore(last) || current.isSame(last)) {
    allWeekKeys.push(`${current.isoWeekYear()}-W${current.isoWeek()}`);
    current = current.add(1, 'week');
  }
  const weekKeys = allWeekKeys.length > DEFAULT_MAX_WEEKS ? allWeekKeys.slice(-DEFAULT_MAX_WEEKS) : allWeekKeys;

  const weeklyData: Record<string, Record<string, number>> = {};
  entries.forEach((entry) => {
    if (entry.difficulty === null) return;
    const grade = mapping[entry.difficulty];
    if (!grade) return;
    const d = dayjs(entry.climbed_at);
    const weekKey = `${d.isoWeekYear()}-W${d.isoWeek()}`;
    if (!weeklyData[weekKey]) weeklyData[weekKey] = {};
    weeklyData[weekKey][grade] = (weeklyData[weekKey][grade] || 0) + 1;
  });

  const usedGrades = new Set<string>();
  Object.values(weeklyData).forEach((weekGrades) => {
    Object.keys(weekGrades).forEach((grade) => usedGrades.add(grade));
  });
  const activeGrades = sortGrades(
    Array.from(usedGrades).filter((grade) => weekKeys.some((wk) => (weeklyData[wk]?.[grade] || 0) > 0)),
    gradeFormat,
  );

  if (activeGrades.length === 0) return null;

  const spansYears = weekKeys.length > 1 && weekKeys[0].split('-')[0] !== weekKeys[weekKeys.length - 1].split('-')[0];

  return weekKeys.map((wk) => {
    const [year, weekPart] = wk.split('-');
    const displayLabel = spansYears ? `${weekPart} '${year.slice(2)}` : weekPart;
    return {
      key: wk,
      label: displayLabel,
      segments: activeGrades.map((grade) => ({
        value: weeklyData[wk]?.[grade] || 0,
        color: getGradeChartColor(grade),
        label: grade,
      })),
    };
  });
}

// ── Flash vs Redpoint grouped bars ──────────────────────────────────

export function buildFlashRedpointBars(
  filteredLogbook: LogbookEntry[],
  gradeFormat: GradeDisplayFormat = 'v-grade',
): GroupedBar[] | null {
  if (filteredLogbook.length === 0) return null;

  const mapping = getDifficultyMapping(gradeFormat);
  const flash: Record<string, number> = {};
  const redpoint: Record<string, number> = {};

  filteredLogbook.forEach((entry) => {
    if (entry.difficulty === null) return;
    const difficulty = mapping[entry.difficulty];
    if (!difficulty) return;
    // Prefer the canonical status field when available. Fall back to the old
    // tries-based heuristic for legacy rows that don't have status set.
    const isFlash = entry.status === 'flash' || (entry.status == null && entry.tries === 1);
    const isRedpoint = entry.status === 'send' || (entry.status == null && entry.tries > 1);
    if (isFlash) {
      flash[difficulty] = (flash[difficulty] || 0) + 1;
    } else if (isRedpoint) {
      redpoint[difficulty] = (redpoint[difficulty] || 0) + Math.max(entry.tries, 1);
    }
  });

  const allGrades = new Set([...Object.keys(flash), ...Object.keys(redpoint)]);
  const sortedGrades = sortGrades(Array.from(allGrades), gradeFormat);

  if (sortedGrades.length === 0) return null;

  return sortedGrades.map((grade) => ({
    key: grade,
    label: grade,
    values: [
      { value: flash[grade] || 0, color: FLASH_COLOR, label: 'Flash' },
      { value: redpoint[grade] || 0, color: REDPOINT_COLOR, label: 'Redpoint' },
    ],
  }));
}

// ── Aggregated flash vs redpoint (all boards) ─────────────────────────

export function buildAggregatedFlashRedpointBars(
  allBoardsTicks: Record<string, LogbookEntry[]>,
  timeframe: UnifiedTimeframeType,
  gradeFormat: GradeDisplayFormat = 'v-grade',
  fromDate?: string,
  toDate?: string,
): GroupedBar[] | null {
  const allEntries = BOARD_TYPES.flatMap((boardType) =>
    filterByUnifiedTimeframe(allBoardsTicks[boardType] || [], timeframe, fromDate, toDate),
  );

  return buildFlashRedpointBars(allEntries, gradeFormat);
}

// ── V-Points stacked area timeline ──────────────────────────────────

export interface VPointsLayoutSeries {
  layoutKey: string;
  displayName: string;
  color: string;
  /** Cumulative v-points per week for this layout */
  data: number[];
}

export interface VPointsTimelineData {
  weekLabels: string[];
  series: VPointsLayoutSeries[];
  totalPoints: number;
}

/**
 * Extract the numeric V-grade value from a V-grade string.
 * "V3" → 3, "V10" → 10, etc. V0 returns 1 so every send counts.
 */
function vGradeToPoints(vGrade: string): number {
  const match = vGrade.match(/^V(\d+)$/);
  if (!match) return 0;
  const num = parseInt(match[1], 10);
  return Math.max(num, 1);
}

const LAYOUT_ORDER = [
  'kilter-1',
  'kilter-8',
  'tension-9',
  'tension-10',
  'tension-11',
  'moonboard-1',
  'moonboard-2',
  'moonboard-3',
  'moonboard-4',
  'moonboard-5',
];

export function buildVPointsTimeline(
  allBoardsTicks: Record<string, LogbookEntry[]>,
  timeframe: UnifiedTimeframeType,
  fromDate?: string,
  toDate?: string,
): VPointsTimelineData | null {
  // Collect entries per layout, filter by timeframe, exclude attempts
  const entriesByLayout: Record<string, LogbookEntry[]> = {};

  BOARD_TYPES.forEach((boardType) => {
    const ticks = allBoardsTicks[boardType] || [];
    const filtered = filterByUnifiedTimeframe(ticks, timeframe, fromDate, toDate).filter(
      (e) => e.difficulty !== null && e.status !== 'attempt',
    );

    for (const entry of filtered) {
      const layoutKey = getLayoutKey(boardType, entry.layoutId);
      if (!entriesByLayout[layoutKey]) entriesByLayout[layoutKey] = [];
      entriesByLayout[layoutKey].push(entry);
    }
  });

  const activeLayouts = Object.keys(entriesByLayout);
  if (activeLayouts.length === 0) return null;

  // Collect all entries to find the overall time range
  const allEntries = activeLayouts.flatMap((lk) => entriesByLayout[lk]);
  const sorted = [...allEntries].sort((a, b) => new Date(a.climbed_at).getTime() - new Date(b.climbed_at).getTime());

  // Build full week key range
  const allWeekKeys: string[] = [];
  const first = dayjs(sorted[0].climbed_at).startOf('isoWeek');
  const last = dayjs(sorted[sorted.length - 1].climbed_at).endOf('isoWeek');
  let current = first;
  while (current.isBefore(last) || current.isSame(last, 'day')) {
    allWeekKeys.push(`${current.isoWeekYear()}-W${current.isoWeek()}`);
    current = current.add(1, 'week');
  }

  if (allWeekKeys.length === 0) return null;

  // Cap at 104 weeks
  const cappedKeys = allWeekKeys.length > 104 ? allWeekKeys.slice(-104) : allWeekKeys;
  const skippedKeys = allWeekKeys.length > 104 ? allWeekKeys.slice(0, -104) : [];

  // Per-layout: sum points per week
  // V-Points always use V-grade mapping regardless of display format
  const layoutWeeklyPoints: Record<string, Record<string, number>> = {};
  for (const layoutKey of activeLayouts) {
    const weekPoints: Record<string, number> = {};
    for (const entry of entriesByLayout[layoutKey]) {
      if (entry.difficulty === null) continue;
      const grade = difficultyMapping[entry.difficulty];
      if (!grade) continue;
      const d = dayjs(entry.climbed_at);
      const wk = `${d.isoWeekYear()}-W${d.isoWeek()}`;
      weekPoints[wk] = (weekPoints[wk] || 0) + vGradeToPoints(grade);
    }
    layoutWeeklyPoints[layoutKey] = weekPoints;
  }

  // Sort layouts in consistent order
  const sortedLayouts = activeLayouts.sort((a, b) => {
    const idxA = LAYOUT_ORDER.indexOf(a);
    const idxB = LAYOUT_ORDER.indexOf(b);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return a.localeCompare(b);
  });

  // Week label formatting
  const spansYears =
    cappedKeys.length > 1 && cappedKeys[0].split('-')[0] !== cappedKeys[cappedKeys.length - 1].split('-')[0];

  const weekLabels = cappedKeys.map((wk) => {
    const [year, weekPart] = wk.split('-');
    return spansYears ? `${weekPart} '${year.slice(2)}` : weekPart;
  });

  // Build cumulative series per layout
  let totalPoints = 0;
  const series: VPointsLayoutSeries[] = sortedLayouts.map((layoutKey) => {
    const [boardType, layoutIdStr] = layoutKey.split('-');
    const layoutId = layoutIdStr === 'unknown' ? null : parseInt(layoutIdStr, 10);
    const weekPoints = layoutWeeklyPoints[layoutKey];

    // Base from skipped weeks
    let cumulative = 0;
    for (const wk of skippedKeys) {
      cumulative += weekPoints[wk] || 0;
    }

    const data = cappedKeys.map((wk) => {
      cumulative += weekPoints[wk] || 0;
      return cumulative;
    });

    totalPoints += cumulative;

    return {
      layoutKey,
      displayName: getLayoutDisplayName(boardType, layoutId),
      color: getLayoutColor(boardType, layoutId),
      data,
    };
  });

  // Only keep series that have at least 1 point
  const nonEmptySeries = series.filter((s) => s.data[s.data.length - 1] > 0);
  if (nonEmptySeries.length === 0) return null;

  return { weekLabels, series: nonEmptySeries, totalPoints };
}

// ── Statistics summary (layout percentages) ─────────────────────────

export interface LayoutPercentage {
  layoutKey: string;
  boardType: string;
  layoutId: number | null;
  displayName: string;
  color: string;
  count: number;
  grades: Record<string, number>;
  percentage: number;
}

export function buildStatisticsSummary(
  profileStats: GetUserProfileStatsQueryResponse['userProfileStats'] | null,
  gradeFormat: GradeDisplayFormat = 'v-grade',
): { totalAscents: number; layoutPercentages: LayoutPercentage[] } {
  if (!profileStats) {
    return { totalAscents: 0, layoutPercentages: [] };
  }

  const mapping = getDifficultyMapping(gradeFormat);
  const totalAscents = profileStats.totalDistinctClimbs;

  const layoutsWithExactPercentages = profileStats.layoutStats
    .map((stats) => {
      const exactPercentage = totalAscents > 0 ? (stats.distinctClimbCount / totalAscents) * 100 : 0;
      const grades: Record<string, number> = {};
      stats.gradeCounts.forEach(({ grade, count }) => {
        const difficultyNum = parseInt(grade, 10);
        if (!isNaN(difficultyNum)) {
          const gradeName = mapping[difficultyNum];
          if (gradeName) {
            grades[gradeName] = (grades[gradeName] || 0) + count;
          }
        }
      });
      return {
        layoutKey: stats.layoutKey,
        boardType: stats.boardType,
        layoutId: stats.layoutId,
        displayName: getLayoutDisplayName(stats.boardType, stats.layoutId),
        color: getLayoutColor(stats.boardType, stats.layoutId),
        count: stats.distinctClimbCount,
        grades,
        exactPercentage,
        percentage: Math.floor(exactPercentage),
        remainder: exactPercentage - Math.floor(exactPercentage),
      };
    })
    .filter((layout) => layout.count > 0)
    .sort((a, b) => b.count - a.count);

  // Distribute remaining percentage points using largest remainder method
  const totalFloored = layoutsWithExactPercentages.reduce((sum, l) => sum + l.percentage, 0);
  const remaining = 100 - totalFloored;
  const sortedByRemainder = [...layoutsWithExactPercentages].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < remaining && i < sortedByRemainder.length; i++) {
    sortedByRemainder[i].percentage += 1;
  }

  const layoutPercentages = layoutsWithExactPercentages.map(({ exactPercentage, remainder, ...rest }) => rest);

  return { totalAscents, layoutPercentages };
}
