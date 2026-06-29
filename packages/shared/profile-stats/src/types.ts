// Renderer-agnostic profile-stats types. This package owns the climbing-stats
// aggregation that both the web "You" page and the mobile profile screen
// consume. Output is keyed (gradeKey / layoutKey / 'flash'|'redpoint') and
// carries display labels but NO colors — each platform resolves colors at its
// own component layer (web → themeTokens, mobile → theme provider).

/** A single user ascent/attempt, normalised from the GraphQL `userTicks`. */
export type LogbookEntry = {
  climbed_at: string;
  // Raw user override (null when the user did not attach a personal grade).
  difficulty: number | null;
  // COALESCE(difficulty, climb consensus). Use this for charts/bucketing so
  // ungraded ticks fall back to the climb's consensus grade. Optional so test
  // fixtures can omit it; production producers always set it.
  effectiveDifficulty?: number | null;
  tries: number;
  angle: number;
  status?: 'flash' | 'send' | 'attempt';
  layoutId?: number | null;
  boardType?: string;
  climbUuid?: string;
  /** Setter handle for the climb (from `board_climbs.setter_username`). */
  setterUsername?: string | null;
  /**
   * Climb-level benchmark flag, sourced from the GraphQL `resolvedIsBenchmark`
   * field (the consensus benchmark resolution `userAscentsFeed` already uses).
   * Distinct from the tick-level `is_benchmark` flag, which is near-empty.
   */
  isBenchmark?: boolean | null;
};

export type UnifiedTimeframeType = 'all' | 'lastYear' | 'lastMonth' | 'lastWeek' | 'today' | 'custom';

// Structural shape of the `userProfileStats` GraphQL response. Defined here so
// the package stays decoupled from @boardsesh/graphql; web/mobile pass their
// query responses (structurally identical).
export type ProfileStatsGradeCount = { grade: string; count: number };
export type ProfileStatsLayout = {
  layoutKey: string;
  boardType: string;
  layoutId: number | null;
  distinctClimbCount: number;
  gradeCounts: ProfileStatsGradeCount[];
};
export type ProfileStatsData = {
  totalDistinctClimbs: number;
  layoutStats: ProfileStatsLayout[];
};

// ── Raw (color-less) chart output shapes ────────────────────────────

/** One stacked-bar segment. `key` identifies the series (grade or layout). */
export type RawBarSegment = {
  value: number;
  /** Series identity — a grade string (weekly) or a layoutKey (aggregated). */
  key: string;
  /** Display label for the segment (grade label or layout display name). */
  label: string;
};

/** One stacked bar (a week, or a grade column). */
export type RawBar = {
  key: string;
  label: string;
  segments: RawBarSegment[];
};

/** Aggregated grade × layout stacked bars + the layout legend. */
export type RawStackedBars = {
  bars: RawBar[];
  legend: Array<{ key: string; label: string }>;
};

/** One grouped-bar value (flash or redpoint for a grade). */
export type RawGroupedValue = {
  value: number;
  key: 'flash' | 'redpoint';
  label: string;
};

/** One grouped bar (a grade with its flash + redpoint values). */
export type RawGroupedBar = {
  key: string;
  label: string;
  values: RawGroupedValue[];
};

/** Cumulative V-points series for one layout. */
export type RawVPointsSeries = {
  layoutKey: string;
  displayName: string;
  /** Cumulative v-points per week. */
  data: number[];
};

export type RawVPointsTimeline = {
  weekLabels: string[];
  series: RawVPointsSeries[];
  totalPoints: number;
};

/** Per-layout share of the user's distinct climbs. */
export type RawLayoutPercentage = {
  layoutKey: string;
  boardType: string;
  layoutId: number | null;
  displayName: string;
  count: number;
  grades: Record<string, number>;
  percentage: number;
};

export type RawStatisticsSummary = {
  totalAscents: number;
  layoutPercentages: RawLayoutPercentage[];
};

/** The user's hardest send / flash, by difficulty id + display label. */
export type RawGradeHighlight = {
  difficulty: number;
  label: string;
  status: 'send' | 'flash';
};

/** One calendar day in the activity heatmap (local date, ascent count). */
export type RawActivityDay = {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  count: number;
};

/**
 * GitHub-style activity grid: a week-aligned run of days (ordered oldest→newest)
 * the renderer chunks into 7-row columns. Colors/intensity are resolved by the
 * renderer from `count` / `maxCount`.
 */
export type RawActivityHeatmap = {
  days: RawActivityDay[];
  /** Number of week columns (`ceil(days.length / 7)`). */
  weeks: number;
  /** Busiest single day in the window — the top of the intensity ramp. */
  maxCount: number;
  startDate: string;
  endDate: string;
};

// ── Dashboard metrics (the redesigned Progress tab) ─────────────────
// All additive and color-less, same contract as the chart outputs above.

/** Weekly "don't break the chain" streak (an active week = ≥1 logged tick). */
export type RawStreaks = {
  /** Consecutive active weeks ending at the most recent active week, or 0 when
   * the streak has lapsed (most recent active week is older than last week). */
  currentWeeks: number;
  /** Longest run of consecutive active weeks ever. */
  longestWeeks: number;
  /** Whether the current ISO week itself has a tick (drives the live flame). */
  isCurrentWeekActive: boolean;
};

/** One tries-to-send histogram bucket. */
export type RawProjectingBucket = {
  /** Stable bucket id. */
  key: '1' | '2-5' | '6-20' | '20+';
  label: string;
  /** Number of sent climbs whose attempt count falls in this bucket. */
  value: number;
};

/** The hardest-won send (most attempts) — the climber's "biggest fight". */
export type RawBiggestProject = {
  climbUuid: string | null;
  tries: number;
  difficulty: number | null;
  label: string;
};

/**
 * Tries-to-send distribution + the biggest project. Histogram and biggest pick
 * are scoped to sent climbs only (`status` send|flash) so an unsent project can
 * never be labelled an "N-try send". `unlocked` gates the whole section.
 */
export type RawProjectingStats = {
  buckets: RawProjectingBucket[];
  biggestProject: RawBiggestProject | null;
  /** True when the hardest-won send took ≥4 tries (worth featuring). */
  unlocked: boolean;
};

/** Active climbing days this calendar month vs last, with a 6-month sparkline. */
export type RawActiveDaysDelta = {
  thisMonth: number;
  lastMonth: number;
  delta: number;
  /** Active days per month, oldest→newest, trailing 6 months incl. current. */
  sparkline: number[];
};

/** Days since the last send + comeback detection for the welcome-back badge. */
export type RawLastSendGap = {
  daysSinceLastSend: number | null;
  /** ISO timestamp of the most recent send, or null when the user has none. */
  lastSendAt: string | null;
  /** The most recent send closed a gap longer than 30 days. */
  isComeback: boolean;
  /** Size of that closed gap in days (null when there's no prior send). */
  comebackGapDays: number | null;
};

/** Benchmarks (test-pieces) sent — count + hardest, by climb-level benchmark. */
export type RawBenchmarkSummary = {
  /** Distinct benchmark climbs sent. */
  count: number;
  hardestDifficulty: number | null;
  hardestLabel: string | null;
};
