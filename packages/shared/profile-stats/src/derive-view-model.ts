import { type GradeDisplayFormat } from '@boardsesh/play-view';
import {
  filterLogbookByTimeframe,
  buildAggregatedStackedBars,
  buildWeeklyBars,
  buildAggregatedFlashRedpointBars,
  buildStatisticsSummary,
  buildVPointsTimeline,
  buildActivityHeatmap,
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
