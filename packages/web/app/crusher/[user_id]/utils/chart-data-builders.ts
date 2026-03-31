import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore';
import type { ChartData } from '../profile-stats-charts';
import type { GetUserProfileStatsQueryResponse } from '@/app/lib/graphql/operations';
import {
  type LogbookEntry,
  type TimeframeType,
  type AggregatedTimeframeType,
  difficultyMapping,
  angleColors,
  getGradeChartColor,
  getLayoutKey,
  getLayoutDisplayName,
  getLayoutColor,
  BOARD_TYPES,
} from './profile-constants';

dayjs.extend(isoWeek);
dayjs.extend(isSameOrAfter);
dayjs.extend(isSameOrBefore);

export function filterLogbookByTimeframe(
  logbook: LogbookEntry[],
  timeframe: TimeframeType,
  fromDate: string,
  toDate: string,
): LogbookEntry[] {
  const now = dayjs();
  switch (timeframe) {
    case 'lastWeek':
      return logbook.filter((entry) => dayjs(entry.climbed_at).isAfter(now.subtract(1, 'week')));
    case 'lastMonth':
      return logbook.filter((entry) => dayjs(entry.climbed_at).isAfter(now.subtract(1, 'month')));
    case 'lastYear':
      return logbook.filter((entry) => dayjs(entry.climbed_at).isAfter(now.subtract(1, 'year')));
    case 'custom':
      return logbook.filter((entry) => {
        const climbedAt = dayjs(entry.climbed_at);
        return climbedAt.isSameOrAfter(dayjs(fromDate), 'day') && climbedAt.isSameOrBefore(dayjs(toDate), 'day');
      });
    case 'all':
    default:
      return logbook;
  }
}

export function buildAggregatedChartData(
  allBoardsTicks: Record<string, LogbookEntry[]>,
  aggregatedTimeframe: AggregatedTimeframeType,
): ChartData | null {
  const now = dayjs();

  const filterByTimeframe = (entry: LogbookEntry) => {
    const climbedAt = dayjs(entry.climbed_at);
    switch (aggregatedTimeframe) {
      case 'today':
        return climbedAt.isSame(now, 'day');
      case 'lastWeek':
        return climbedAt.isAfter(now.subtract(1, 'week'));
      case 'lastMonth':
        return climbedAt.isAfter(now.subtract(1, 'month'));
      case 'lastYear':
        return climbedAt.isAfter(now.subtract(1, 'year'));
      case 'all':
      default:
        return true;
    }
  };

  const layoutGradeClimbs: Record<string, Record<string, Set<string>>> = {};
  const allGrades = new Set<string>();
  const allLayouts = new Set<string>();

  BOARD_TYPES.forEach((boardType) => {
    const ticks = allBoardsTicks[boardType] || [];
    const filteredTicks = ticks.filter(filterByTimeframe);

    filteredTicks.forEach((entry) => {
      if (entry.difficulty === null || entry.status === 'attempt' || !entry.climbUuid) return;
      const grade = difficultyMapping[entry.difficulty];
      if (grade) {
        const layoutKey = getLayoutKey(boardType, entry.layoutId);
        if (!layoutGradeClimbs[layoutKey]) {
          layoutGradeClimbs[layoutKey] = {};
        }
        if (!layoutGradeClimbs[layoutKey][grade]) {
          layoutGradeClimbs[layoutKey][grade] = new Set();
        }
        layoutGradeClimbs[layoutKey][grade].add(entry.climbUuid);
        allGrades.add(grade);
        allLayouts.add(layoutKey);
      }
    });
  });

  if (allGrades.size === 0) {
    return null;
  }

  const sortedGrades = Object.values(difficultyMapping).filter((g) => allGrades.has(g));

  const layoutOrder = [
    'kilter-1', 'kilter-8', 'tension-9', 'tension-10', 'tension-11',
    'moonboard-1', 'moonboard-2', 'moonboard-3', 'moonboard-4', 'moonboard-5',
  ];
  const sortedLayouts = Array.from(allLayouts).sort((a, b) => {
    const indexA = layoutOrder.indexOf(a);
    const indexB = layoutOrder.indexOf(b);
    if (indexA !== -1 && indexB !== -1) return indexA - indexB;
    if (indexA !== -1) return -1;
    if (indexB !== -1) return 1;
    return a.localeCompare(b);
  });

  const datasets = sortedLayouts.map((layoutKey) => {
    const [boardType, layoutIdStr] = layoutKey.split('-');
    const layoutId = layoutIdStr === 'unknown' ? null : parseInt(layoutIdStr, 10);
    return {
      label: getLayoutDisplayName(boardType, layoutId),
      data: sortedGrades.map((grade) => layoutGradeClimbs[layoutKey]?.[grade]?.size || 0),
      backgroundColor: getLayoutColor(boardType, layoutId),
    };
  }).filter((dataset) => dataset.data.some((value) => value > 0));

  return { labels: sortedGrades, datasets };
}

export function buildBoardChartData(filteredLogbook: LogbookEntry[]): {
  chartDataBar: ChartData | null;
  chartDataPie: ChartData | null;
  chartDataWeeklyBar: ChartData | null;
} {
  if (filteredLogbook.length === 0) {
    return { chartDataBar: null, chartDataPie: null, chartDataWeeklyBar: null };
  }

  // Bar chart - Flash vs Redpoint
  const greaterThanOne: Record<string, number> = {};
  const equalToOne: Record<string, number> = {};
  filteredLogbook.forEach((entry) => {
    if (entry.difficulty === null) return;
    const difficulty = difficultyMapping[entry.difficulty];
    if (difficulty) {
      if (entry.tries > 1) {
        greaterThanOne[difficulty] = (greaterThanOne[difficulty] || 0) + entry.tries;
      } else if (entry.tries === 1) {
        equalToOne[difficulty] = (equalToOne[difficulty] || 0) + 1;
      }
    }
  });
  const barLabels = Object.keys({ ...greaterThanOne, ...equalToOne }).sort();
  const chartDataBar: ChartData = {
    labels: barLabels,
    datasets: [
      { label: 'Flash', data: barLabels.map((l) => equalToOne[l] || 0), backgroundColor: 'rgba(75,192,192,0.5)' },
      { label: 'Redpoint', data: barLabels.map((l) => greaterThanOne[l] || 0), backgroundColor: 'rgba(192,75,75,0.5)' },
    ],
  };

  // Pie chart - Ascents by Angle
  const angleClimbs: Record<string, Set<string>> = {};
  filteredLogbook.forEach((entry) => {
    if (entry.status === 'attempt' || !entry.climbUuid) return;
    const angle = `${entry.angle}°`;
    if (!angleClimbs[angle]) {
      angleClimbs[angle] = new Set();
    }
    angleClimbs[angle].add(`${entry.climbUuid}-${entry.angle}`);
  });
  const angleLabels = Object.keys(angleClimbs).sort((a, b) => parseInt(a) - parseInt(b));
  const chartDataPie: ChartData = {
    labels: angleLabels,
    datasets: [
      {
        label: 'Ascents by Angle',
        data: angleLabels.map((angle) => angleClimbs[angle]?.size || 0),
        backgroundColor: angleLabels.map((_, index) => angleColors[index] || 'rgba(200,200,200,0.7)'),
      },
    ],
  };

  // Weekly bar chart
  const weeks: string[] = [];
  const first = dayjs(filteredLogbook[filteredLogbook.length - 1]?.climbed_at).startOf('isoWeek');
  const last = dayjs(filteredLogbook[0]?.climbed_at).endOf('isoWeek');
  let current = first;
  while (current.isBefore(last) || current.isSame(last)) {
    weeks.push(`W.${current.isoWeek()} / ${current.year()}`);
    current = current.add(1, 'week');
  }
  const weeklyData: Record<string, Record<string, number>> = {};
  filteredLogbook.forEach((entry) => {
    if (entry.difficulty === null) return;
    const week = `W.${dayjs(entry.climbed_at).isoWeek()} / ${dayjs(entry.climbed_at).year()}`;
    const difficulty = difficultyMapping[entry.difficulty];
    if (difficulty) {
      weeklyData[week] = { ...(weeklyData[week] || {}), [difficulty]: (weeklyData[week]?.[difficulty] || 0) + 1 };
    }
  });
  const datasets = Object.values(difficultyMapping)
    .map((difficulty) => ({
      label: difficulty,
      data: weeks.map((week) => weeklyData[week]?.[difficulty] || 0),
      backgroundColor: getGradeChartColor(difficulty),
    }))
    .filter((dataset) => dataset.data.some((value) => value > 0));
  const chartDataWeeklyBar: ChartData = { labels: weeks, datasets };

  return { chartDataBar, chartDataPie, chartDataWeeklyBar };
}

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
): { totalAscents: number; layoutPercentages: LayoutPercentage[] } {
  if (!profileStats) {
    return { totalAscents: 0, layoutPercentages: [] };
  }

  const totalAscents = profileStats.totalDistinctClimbs;

  const layoutsWithExactPercentages = profileStats.layoutStats
    .map((stats) => {
      const exactPercentage = totalAscents > 0 ? (stats.distinctClimbCount / totalAscents) * 100 : 0;
      const grades: Record<string, number> = {};
      stats.gradeCounts.forEach(({ grade, count }) => {
        if (grade) {
          grades[grade] = (grades[grade] ?? 0) + count;
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

  const layoutPercentages = layoutsWithExactPercentages.map(
    ({ exactPercentage, remainder, ...rest }) => rest,
  );

  return { totalAscents, layoutPercentages };
}
