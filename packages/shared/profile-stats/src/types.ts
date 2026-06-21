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
