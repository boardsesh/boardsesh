import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore';
import { type GradeDisplayFormat } from '@boardsesh/play-view';
import { parseTickTime, tickTimeMs } from './format-tick-time';
import { difficultyMapping, getDifficultyMapping, sortGrades } from './grade-mapping';
import { BOARD_TYPES, getLayoutKey, getLayoutDisplayName, parseLayoutKey, sortLayoutKeys } from './layouts';
import type {
  LogbookEntry,
  UnifiedTimeframeType,
  ProfileStatsData,
  RawBar,
  RawStackedBars,
  RawGroupedBar,
  RawVPointsTimeline,
  RawVPointsSeries,
  RawStatisticsSummary,
  RawLayoutPercentage,
  RawActivityDay,
  RawActivityHeatmap,
} from './types';

dayjs.extend(isoWeek);
dayjs.extend(isSameOrAfter);
dayjs.extend(isSameOrBefore);

/**
 * Grade id to use for chart bucketing: prefer the server-supplied
 * `effectiveDifficulty` (COALESCE of user override + climb consensus) and fall
 * back to the raw `difficulty` when absent. See docs/ascents-and-attempts.md.
 */
function gradeIdForEntry(entry: LogbookEntry): number | null {
  return entry.effectiveDifficulty ?? entry.difficulty ?? null;
}

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
      return logbook.filter((entry) => parseTickTime(entry.climbed_at).isSame(now, 'day'));
    case 'lastWeek':
      return logbook.filter((entry) => parseTickTime(entry.climbed_at).isAfter(now.subtract(1, 'week')));
    case 'lastMonth':
      return logbook.filter((entry) => parseTickTime(entry.climbed_at).isAfter(now.subtract(1, 'month')));
    case 'lastYear':
      return logbook.filter((entry) => parseTickTime(entry.climbed_at).isAfter(now.subtract(1, 'year')));
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

// ── Aggregated stacked bars (grade x layout, for stats summary) ─────

export function buildAggregatedStackedBars(
  allBoardsTicks: Record<string, LogbookEntry[]>,
  timeframe: UnifiedTimeframeType,
  gradeFormat: GradeDisplayFormat = 'v-grade',
  fromDate?: string,
  toDate?: string,
): RawStackedBars | null {
  const mapping = getDifficultyMapping(gradeFormat);
  const layoutGradeClimbs: Record<string, Record<string, Set<string>>> = {};
  const allGrades = new Set<string>();
  const allLayouts = new Set<string>();

  BOARD_TYPES.forEach((boardType) => {
    const ticks = allBoardsTicks[boardType] || [];
    const filteredTicks = filterLogbookByTimeframe(ticks, timeframe, fromDate ?? '', toDate ?? '');

    filteredTicks.forEach((entry) => {
      const gradeId = gradeIdForEntry(entry);
      if (gradeId == null || entry.status === 'attempt' || !entry.climbUuid) return;
      const grade = mapping[gradeId];
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
  const sortedLayouts = sortLayoutKeys(Array.from(allLayouts));

  const legend = sortedLayouts.map((layoutKey) => {
    const { boardType, layoutId } = parseLayoutKey(layoutKey);
    return { key: layoutKey, label: getLayoutDisplayName(boardType, layoutId) };
  });

  const bars: RawBar[] = sortedGrades.map((grade) => ({
    key: grade,
    label: grade,
    segments: sortedLayouts.map((layoutKey) => {
      const { boardType, layoutId } = parseLayoutKey(layoutKey);
      return {
        value: layoutGradeClimbs[layoutKey]?.[grade]?.size || 0,
        key: layoutKey,
        label: getLayoutDisplayName(boardType, layoutId),
      };
    }),
  }));

  return { bars, legend };
}

// ── Weekly stacked bars ─────────────────────────────────────────────

export function buildWeeklyBars(
  filteredLogbook: LogbookEntry[],
  fromDate?: string,
  toDate?: string,
  gradeFormat: GradeDisplayFormat = 'v-grade',
): RawBar[] | null {
  if (filteredLogbook.length === 0) return null;

  const mapping = getDifficultyMapping(gradeFormat);

  const entries =
    fromDate || toDate
      ? filteredLogbook.filter((entry) => {
          const d = parseTickTime(entry.climbed_at);
          if (fromDate && d.isBefore(dayjs(fromDate), 'day')) return false;
          if (toDate && d.isAfter(dayjs(toDate), 'day')) return false;
          return true;
        })
      : filteredLogbook;

  if (entries.length === 0) return null;

  const DEFAULT_MAX_WEEKS = 52;
  const allWeekKeys: string[] = [];
  // `entries` is per-board tick arrays concatenated in BOARD_TYPES order
  // (derive-view-model `Object.values(...).flat()`), each newest-first, so the
  // combined array is NOT globally sorted. Derive the range from the true
  // min/max timestamps rather than the array endpoints — otherwise multi-board
  // logbooks can yield first > last (empty week loop → null chart). A single
  // reduce pass avoids spread limits on huge logbooks.
  let oldestMs = tickTimeMs(entries[0].climbed_at);
  let newestMs = oldestMs;
  for (const entry of entries) {
    const ms = tickTimeMs(entry.climbed_at);
    if (ms < oldestMs) oldestMs = ms;
    if (ms > newestMs) newestMs = ms;
  }
  // `dayjs(ms)` is in local time (matching `parseTickTime`), so the isoWeek
  // bounds line up with the per-entry week keys computed below.
  const first = dayjs(oldestMs).startOf('isoWeek');
  const last = dayjs(newestMs).endOf('isoWeek');
  let current = first;
  while (current.isBefore(last) || current.isSame(last)) {
    allWeekKeys.push(`${current.isoWeekYear()}-W${current.isoWeek()}`);
    current = current.add(1, 'week');
  }
  const weekKeys = allWeekKeys.length > DEFAULT_MAX_WEEKS ? allWeekKeys.slice(-DEFAULT_MAX_WEEKS) : allWeekKeys;

  const weeklyData: Record<string, Record<string, number>> = {};
  entries.forEach((entry) => {
    const gradeId = gradeIdForEntry(entry);
    if (gradeId == null) return;
    const grade = mapping[gradeId];
    if (!grade) return;
    const d = parseTickTime(entry.climbed_at);
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
        key: grade,
        label: grade,
      })),
    };
  });
}

// ── Flash vs Redpoint grouped bars ──────────────────────────────────

export function buildFlashRedpointBars(
  filteredLogbook: LogbookEntry[],
  gradeFormat: GradeDisplayFormat = 'v-grade',
): RawGroupedBar[] | null {
  if (filteredLogbook.length === 0) return null;

  const mapping = getDifficultyMapping(gradeFormat);
  const flash: Record<string, number> = {};
  const redpoint: Record<string, number> = {};

  filteredLogbook.forEach((entry) => {
    const gradeId = gradeIdForEntry(entry);
    if (gradeId == null) return;
    const difficulty = mapping[gradeId];
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
      { value: flash[grade] || 0, key: 'flash', label: 'Flash' },
      { value: redpoint[grade] || 0, key: 'redpoint', label: 'Redpoint' },
    ],
  }));
}

export function buildAggregatedFlashRedpointBars(
  allBoardsTicks: Record<string, LogbookEntry[]>,
  timeframe: UnifiedTimeframeType,
  gradeFormat: GradeDisplayFormat = 'v-grade',
  fromDate?: string,
  toDate?: string,
): RawGroupedBar[] | null {
  const allEntries = BOARD_TYPES.flatMap((boardType) =>
    filterLogbookByTimeframe(allBoardsTicks[boardType] || [], timeframe, fromDate ?? '', toDate ?? ''),
  );

  return buildFlashRedpointBars(allEntries, gradeFormat);
}

// ── V-Points stacked area timeline ──────────────────────────────────

/**
 * Extract the numeric V-grade value from a V-grade string. "V3" → 3, "V10" →
 * 10, etc. V0 returns 1 so every send counts.
 */
function vGradeToPoints(vGrade: string): number {
  const match = vGrade.match(/^V(\d+)$/);
  if (!match) return 0;
  const num = parseInt(match[1], 10);
  return Math.max(num, 1);
}

export function buildVPointsTimeline(
  allBoardsTicks: Record<string, LogbookEntry[]>,
  timeframe: UnifiedTimeframeType,
  fromDate?: string,
  toDate?: string,
): RawVPointsTimeline | null {
  // Collect entries per layout, filter by timeframe, exclude attempts
  const entriesByLayout: Record<string, LogbookEntry[]> = {};

  BOARD_TYPES.forEach((boardType) => {
    const ticks = allBoardsTicks[boardType] || [];
    const filtered = filterLogbookByTimeframe(ticks, timeframe, fromDate ?? '', toDate ?? '').filter(
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
  const sorted = [...allEntries].sort((a, b) => tickTimeMs(a.climbed_at) - tickTimeMs(b.climbed_at));

  // Build full week key range
  const allWeekKeys: string[] = [];
  const first = parseTickTime(sorted[0].climbed_at).startOf('isoWeek');
  const last = parseTickTime(sorted[sorted.length - 1].climbed_at).endOf('isoWeek');
  let current = first;
  while (current.isBefore(last) || current.isSame(last, 'day')) {
    allWeekKeys.push(`${current.isoWeekYear()}-W${current.isoWeek()}`);
    current = current.add(1, 'week');
  }

  if (allWeekKeys.length === 0) return null;

  // Cap at 104 weeks
  const cappedKeys = allWeekKeys.length > 104 ? allWeekKeys.slice(-104) : allWeekKeys;
  const skippedKeys = allWeekKeys.length > 104 ? allWeekKeys.slice(0, -104) : [];

  // Per-layout: sum points per week.
  // V-Points always use V-grade mapping regardless of display format.
  const layoutWeeklyPoints: Record<string, Record<string, number>> = {};
  for (const layoutKey of activeLayouts) {
    const weekPoints: Record<string, number> = {};
    for (const entry of entriesByLayout[layoutKey]) {
      const gradeId = gradeIdForEntry(entry);
      if (gradeId == null) continue;
      const grade = difficultyMapping[gradeId];
      if (!grade) continue;
      const d = parseTickTime(entry.climbed_at);
      const wk = `${d.isoWeekYear()}-W${d.isoWeek()}`;
      weekPoints[wk] = (weekPoints[wk] || 0) + vGradeToPoints(grade);
    }
    layoutWeeklyPoints[layoutKey] = weekPoints;
  }

  const sortedLayouts = sortLayoutKeys(activeLayouts);

  // Week label formatting
  const spansYears =
    cappedKeys.length > 1 && cappedKeys[0].split('-')[0] !== cappedKeys[cappedKeys.length - 1].split('-')[0];

  const weekLabels = cappedKeys.map((wk) => {
    const [year, weekPart] = wk.split('-');
    return spansYears ? `${weekPart} '${year.slice(2)}` : weekPart;
  });

  // Build cumulative series per layout
  const series: RawVPointsSeries[] = sortedLayouts.map((layoutKey) => {
    const { boardType, layoutId } = parseLayoutKey(layoutKey);
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

    return {
      layoutKey,
      displayName: getLayoutDisplayName(boardType, layoutId),
      data,
    };
  });

  // Only keep series that have at least 1 point
  const nonEmptySeries = series.filter((s) => s.data[s.data.length - 1] > 0);
  if (nonEmptySeries.length === 0) return null;

  // Total = sum of each *displayed* series' final cumulative value. Computed
  // from nonEmptySeries (not the raw map) so dropped/empty layouts can never
  // contribute to the headline number.
  const totalPoints = nonEmptySeries.reduce((sum, s) => sum + (s.data[s.data.length - 1] ?? 0), 0);

  return { weekLabels, series: nonEmptySeries, totalPoints };
}

// ── Statistics summary (layout percentages) ─────────────────────────

export function buildStatisticsSummary(
  profileStats: ProfileStatsData | null,
  gradeFormat: GradeDisplayFormat = 'v-grade',
): RawStatisticsSummary {
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

  const layoutPercentages: RawLayoutPercentage[] = layoutsWithExactPercentages.map(
    ({ exactPercentage: _exactPercentage, remainder: _remainder, ...rest }) => rest,
  );

  return { totalAscents, layoutPercentages };
}

// ── Activity heatmap (GitHub-style calendar) ────────────────────────

const HEATMAP_WEEKS = 53;

/**
 * Per-day ascent counts over a trailing, week-aligned window ending this week —
 * the data for a GitHub-style activity calendar. Every logged entry counts as
 * activity (attempts included: you still showed up). Days are emitted oldest→
 * newest and zero-filled so the renderer can chunk them into 7-row week columns
 * without gap handling. Returns null when no activity falls inside the window.
 *
 * `today` defaults to now; pass a fixed day for deterministic tests so the
 * window anchor doesn't drift with the wall clock.
 */
export function buildActivityHeatmap(
  filteredLogbook: LogbookEntry[],
  weeksWindow: number = HEATMAP_WEEKS,
  today: dayjs.Dayjs = dayjs(),
): RawActivityHeatmap | null {
  if (filteredLogbook.length === 0) return null;

  const countsByDay = new Map<string, number>();
  for (const entry of filteredLogbook) {
    const day = parseTickTime(entry.climbed_at).format('YYYY-MM-DD');
    countsByDay.set(day, (countsByDay.get(day) ?? 0) + 1);
  }

  // Week-align the grid to whole ISO weeks (Mon→Sun) so it lays out as clean
  // 7-row columns. End on the current week, start `weeksWindow` weeks earlier.
  // ISO weeks (not locale `week`) keep the grid deterministic regardless of the
  // runtime locale's first-day-of-week, and match every other builder here.
  const gridEnd = today.endOf('isoWeek');
  const gridStart = gridEnd.subtract(weeksWindow * 7 - 1, 'day').startOf('isoWeek');

  const days: RawActivityDay[] = [];
  let maxCount = 0;
  let cursor = gridStart;
  while (cursor.isBefore(gridEnd) || cursor.isSame(gridEnd, 'day')) {
    const key = cursor.format('YYYY-MM-DD');
    const count = countsByDay.get(key) ?? 0;
    if (count > maxCount) maxCount = count;
    days.push({ date: key, count });
    cursor = cursor.add(1, 'day');
  }

  // Every day in range was empty (e.g. an all-time logbook whose climbs predate
  // the window) — nothing to draw.
  if (maxCount === 0) return null;

  return {
    days,
    weeks: Math.ceil(days.length / 7),
    maxCount,
    startDate: gridStart.format('YYYY-MM-DD'),
    endDate: gridEnd.format('YYYY-MM-DD'),
  };
}
