import { type GradeDisplayFormat } from '@boardsesh/play-view';
import {
  filterLogbookByTimeframe,
  buildAggregatedStackedBars,
  buildWeeklyBars,
  buildAggregatedFlashRedpointBars,
  buildStatisticsSummary,
  buildVPointsTimeline,
  buildActivityHeatmap,
  buildWeeklyStreak,
  buildProjectingStats,
  buildActiveDaysMoM,
  buildLastSendGap,
  buildBenchmarkSummary,
  buildAngleBreakdown,
  buildWallRhythm,
  findNextProjectGrade,
  buildRunningMaxCeiling,
  buildGradeMilestones,
  buildSetterSummary,
  buildBenchmarkGradeBars,
} from './chart-builders';
import { getDifficultyMapping } from './grade-mapping';
import type {
  LogbookEntry,
  UnifiedTimeframeType,
  ProfileStatsData,
  RawBar,
  RawStackedBars,
  RawGroupedBar,
  RawVPointsTimeline,
  RawStatisticsSummary,
  RawGradeHighlight,
  RawActivityHeatmap,
  RawStreaks,
  RawProjectingStats,
  RawActiveDaysDelta,
  RawLastSendGap,
  RawBenchmarkSummary,
  RawAngleBreakdown,
  RawWallRhythm,
  RawNextProject,
  RawRunningMaxCeiling,
  RawGradeMilestone,
  RawSetterSummary,
} from './types';

export type DeriveProfileViewModelInput = {
  /** Ticks keyed by board type, as returned by per-board `userTicks` queries. */
  allBoardsTicks: Record<string, LogbookEntry[]>;
  /** `'all'` or a board type to scope every chart to one board. */
  selectedBoard: string;
  timeframe: UnifiedTimeframeType;
  /** Custom-range start, `''` when unset. */
  fromDate: string;
  /** Custom-range end, `''` when unset. */
  toDate: string;
  gradeFormat: GradeDisplayFormat;
  /** `userProfileStats` response, or null while loading / for a fresh user. */
  profileStats: ProfileStatsData | null;
};

export type ProfileViewModel = {
  filteredLogbook: LogbookEntry[];
  weeklyBars: RawBar[] | null;
  aggregatedStackedBars: RawStackedBars | null;
  aggregatedFlashRedpointBars: RawGroupedBar[] | null;
  statisticsSummary: RawStatisticsSummary;
  vPointsTimeline: RawVPointsTimeline | null;
  activityHeatmap: RawActivityHeatmap | null;
  hardestSend: RawGradeHighlight | null;
  hardestFlash: RawGradeHighlight | null;
  // ── Dashboard metrics (redesigned Progress tab). Scoped to the active
  // board + timeframe via `filteredLogbook`, same as the heatmap/weekly bars.
  streaks: RawStreaks;
  projectingStats: RawProjectingStats;
  activeDaysDelta: RawActiveDaysDelta;
  lastSendGap: RawLastSendGap;
  benchmarkSummary: RawBenchmarkSummary;
  // ── Deep-chart sections (PR2). Angle/rhythm/next-project follow the timeframe
  // filter (detailed charts); ceiling + milestones are lifetime progression
  // (board-scoped, all-time) like the hero's hardestSend.
  angleBreakdown: RawAngleBreakdown | null;
  wallRhythm: RawWallRhythm | null;
  nextProjectGrade: RawNextProject;
  runningMaxCeiling: RawRunningMaxCeiling | null;
  gradeMilestones: RawGradeMilestone[];
  // ── Community cluster (PR3). Lifetime identity stats (board-scoped).
  setterSummary: RawSetterSummary;
  benchmarkGradeBars: RawBar[] | null;
};

/**
 * Pure orchestration shared by web's `useProfileData` and mobile's
 * `useYouProfileData`. Given the raw per-board ticks plus the active board /
 * timeframe / grade-format filters, derives every chart's renderer-agnostic
 * data plus the hardest send/flash highlights. Color resolution happens at
 * each platform's component layer.
 */
export function deriveProfileViewModel(input: DeriveProfileViewModelInput): ProfileViewModel {
  const { allBoardsTicks, selectedBoard, timeframe, fromDate, toDate, gradeFormat, profileStats } = input;

  const filteredBoardsTicks: Record<string, LogbookEntry[]> =
    selectedBoard === 'all' ? allBoardsTicks : { [selectedBoard]: allBoardsTicks[selectedBoard] || [] };

  const filteredLogbook = filterLogbookByTimeframe(
    Object.values(filteredBoardsTicks).flat(),
    timeframe,
    fromDate,
    toDate,
  );

  const aggregatedStackedBars = buildAggregatedStackedBars(
    filteredBoardsTicks,
    timeframe,
    gradeFormat,
    fromDate,
    toDate,
  );

  const weeklyBars = buildWeeklyBars(filteredLogbook, undefined, undefined, gradeFormat);

  const aggregatedFlashRedpointBars = buildAggregatedFlashRedpointBars(
    filteredBoardsTicks,
    timeframe,
    gradeFormat,
    fromDate,
    toDate,
  );

  const statisticsSummary = buildStatisticsSummary(profileStats, gradeFormat);

  const vPointsTimeline = buildVPointsTimeline(filteredBoardsTicks, timeframe, fromDate, toDate);

  const activityHeatmap = buildActivityHeatmap(filteredLogbook);

  const { hardestSend, hardestFlash } = computeHardest(filteredBoardsTicks, gradeFormat);

  // Dashboard hero + glance metrics are lifetime identity stats: scoped to the
  // selected board but NOT the timeframe (same as `hardestSend` above), so the
  // timeframe filter only narrows the detailed charts below — not "best streak
  // ever" or "benchmarks sent". Avoids the mixed-scope confusion of an all-time
  // hardest send sitting next to a timeframe-capped streak.
  const boardScopedTicks = Object.values(filteredBoardsTicks).flat();
  const streaks = buildWeeklyStreak(boardScopedTicks);
  const projectingStats = buildProjectingStats(boardScopedTicks, gradeFormat);
  const activeDaysDelta = buildActiveDaysMoM(boardScopedTicks);
  const lastSendGap = buildLastSendGap(boardScopedTicks);
  const benchmarkSummary = buildBenchmarkSummary(boardScopedTicks, gradeFormat);

  // Deep-chart sections.
  const angleBreakdown = buildAngleBreakdown(filteredLogbook, gradeFormat);
  const wallRhythm = buildWallRhythm(filteredLogbook);
  const nextProjectGrade = findNextProjectGrade(filteredLogbook, gradeFormat);
  const runningMaxCeiling = buildRunningMaxCeiling(boardScopedTicks, gradeFormat);
  const gradeMilestones = buildGradeMilestones(boardScopedTicks, gradeFormat);

  // Community cluster — lifetime identity stats.
  const setterSummary = buildSetterSummary(boardScopedTicks);
  const benchmarkGradeBars = buildBenchmarkGradeBars(boardScopedTicks, gradeFormat);

  return {
    filteredLogbook,
    weeklyBars,
    aggregatedStackedBars,
    aggregatedFlashRedpointBars,
    statisticsSummary,
    vPointsTimeline,
    activityHeatmap,
    hardestSend,
    hardestFlash,
    streaks,
    projectingStats,
    activeDaysDelta,
    lastSendGap,
    benchmarkSummary,
    angleBreakdown,
    wallRhythm,
    nextProjectGrade,
    runningMaxCeiling,
    gradeMilestones,
    setterSummary,
    benchmarkGradeBars,
  };
}

function computeHardest(
  filteredBoardsTicks: Record<string, LogbookEntry[]>,
  gradeFormat: GradeDisplayFormat,
): { hardestSend: RawGradeHighlight | null; hardestFlash: RawGradeHighlight | null } {
  const allTicks = Object.values(filteredBoardsTicks).flat();
  const mapping = getDifficultyMapping(gradeFormat);
  let maxSendDifficulty = -1;
  let maxFlashDifficulty = -1;

  for (const tick of allTicks) {
    // Prefer the server-coalesced consensus value; fall back to the raw
    // override when absent (test fixtures, transient optimistic writes).
    const grade = tick.effectiveDifficulty ?? tick.difficulty;
    if (grade == null) continue;
    if (tick.status === 'send' || tick.status === 'flash') {
      if (grade > maxSendDifficulty) maxSendDifficulty = grade;
    }
    if (tick.status === 'flash') {
      if (grade > maxFlashDifficulty) maxFlashDifficulty = grade;
    }
  }

  const makeHighlight = (difficulty: number, status: 'send' | 'flash'): RawGradeHighlight => ({
    difficulty,
    label: mapping[difficulty] ?? `${difficulty}`,
    status,
  });

  return {
    hardestSend: maxSendDifficulty >= 0 ? makeHighlight(maxSendDifficulty, 'send') : null,
    hardestFlash: maxFlashDifficulty >= 0 ? makeHighlight(maxFlashDifficulty, 'flash') : null,
  };
}
