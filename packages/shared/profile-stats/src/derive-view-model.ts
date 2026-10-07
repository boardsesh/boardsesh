import { formatGradeByDifficultyId, type GradeDisplayFormat } from '@boardsesh/play-view';
import type { Dayjs } from 'dayjs';
import {
  filterLogbookByTimeframe,
  buildAggregatedStackedBars,
  buildWeeklyBars,
  buildAggregatedFlashRedpointBars,
  buildStatisticsSummary,
  buildVPointsTimeline,
  buildActivityHeatmap,
  buildPeriodComparison,
  HEATMAP_WEEKS,
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
  PeriodComparisonMode,
  RawPeriodComparison,
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
  /** Trailing vs. year-over-year for the period comparison card. The caller
   *  owns the default ('trailing') — this function is a pure pass-through, like
   *  every other filter field. */
  comparisonMode: PeriodComparisonMode;
  /** `now` defaults to the real wall clock (each downstream builder's own
   *  default). Mobile threads its screenshot-mode frozen clock through here
   *  (`dayjs(nowMs())`) so timeframe filtering, the activity heatmap window,
   *  and the period comparison card all agree on one "now" per render. */
  now?: Dayjs;
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
  periodComparison: RawPeriodComparison | null;
};

/**
 * Pure orchestration behind mobile's `useYouProfileData`. Given the raw
 * per-board ticks plus the active board / timeframe / grade-format filters,
 * derives every chart's renderer-agnostic data plus the hardest send/flash
 * highlights. Color resolution happens at the component layer. Web's
 * `useProfileData` does its own orchestration (calls the individual raw
 * builders directly via a local color-adapter) rather than going through this
 * function — see the web/mobile split noted on each raw builder.
 */
export function deriveProfileViewModel(input: DeriveProfileViewModelInput): ProfileViewModel {
  const { allBoardsTicks, selectedBoard, timeframe, fromDate, toDate, gradeFormat, profileStats, comparisonMode, now } =
    input;

  const selectedBoardsTicks: Record<string, LogbookEntry[]> =
    selectedBoard === 'all' ? allBoardsTicks : { [selectedBoard]: allBoardsTicks[selectedBoard] || [] };
  // Stamp each entry with the board it was filed under: grade labels are per
  // board (MoonBoard's 6A is V2), and producers don't always set boardType.
  const filteredBoardsTicks: Record<string, LogbookEntry[]> = Object.fromEntries(
    Object.entries(selectedBoardsTicks).map(([boardType, ticks]) => [
      boardType,
      ticks.map((tick) => (tick.boardType ? tick : { ...tick, boardType })),
    ]),
  );

  const filteredLogbook = filterLogbookByTimeframe(
    Object.values(filteredBoardsTicks).flat(),
    timeframe,
    fromDate,
    toDate,
    now,
  );

  const aggregatedStackedBars = buildAggregatedStackedBars(
    filteredBoardsTicks,
    timeframe,
    gradeFormat,
    fromDate,
    toDate,
    now,
  );

  const weeklyBars = buildWeeklyBars(filteredLogbook, undefined, undefined, gradeFormat);

  const aggregatedFlashRedpointBars = buildAggregatedFlashRedpointBars(
    filteredBoardsTicks,
    timeframe,
    gradeFormat,
    fromDate,
    toDate,
    now,
  );

  const statisticsSummary = buildStatisticsSummary(profileStats, gradeFormat);

  const vPointsTimeline = buildVPointsTimeline(filteredBoardsTicks, timeframe, fromDate, toDate, now);

  const activityHeatmap = buildActivityHeatmap(filteredLogbook, HEATMAP_WEEKS, now);

  const periodComparison = buildPeriodComparison(filteredBoardsTicks, timeframe, comparisonMode, now);

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
    periodComparison,
  };
}

function computeHardest(
  filteredBoardsTicks: Record<string, LogbookEntry[]>,
  gradeFormat: GradeDisplayFormat,
): { hardestSend: RawGradeHighlight | null; hardestFlash: RawGradeHighlight | null } {
  const allTicks = Object.values(filteredBoardsTicks).flat();
  let hardestSendTick: LogbookEntry | null = null;
  let hardestFlashTick: LogbookEntry | null = null;
  let maxSendDifficulty = -1;
  let maxFlashDifficulty = -1;

  for (const tick of allTicks) {
    // Prefer the server-coalesced consensus value; fall back to the raw
    // override when absent (test fixtures, transient optimistic writes).
    const grade = tick.effectiveDifficulty ?? tick.difficulty;
    if (grade == null) continue;
    if (tick.status === 'send' || tick.status === 'flash') {
      if (grade > maxSendDifficulty) {
        maxSendDifficulty = grade;
        hardestSendTick = tick;
      }
    }
    if (tick.status === 'flash') {
      if (grade > maxFlashDifficulty) {
        maxFlashDifficulty = grade;
        hardestFlashTick = tick;
      }
    }
  }

  // Labelled on the hardest tick's own board, so a MoonBoard 6A reads V2.
  const makeHighlight = (
    difficulty: number,
    status: 'send' | 'flash',
    tick: LogbookEntry | null,
  ): RawGradeHighlight => ({
    difficulty,
    label:
      formatGradeByDifficultyId(difficulty, gradeFormat, tick?.boardType) ??
      getDifficultyMapping(gradeFormat, tick?.boardType)[difficulty] ??
      `${difficulty}`,
    status,
  });

  return {
    hardestSend: maxSendDifficulty >= 0 ? makeHighlight(maxSendDifficulty, 'send', hardestSendTick) : null,
    hardestFlash: maxFlashDifficulty >= 0 ? makeHighlight(maxFlashDifficulty, 'flash', hardestFlashTick) : null,
  };
}
