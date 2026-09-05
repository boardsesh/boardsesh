// Pure join builder for the "crowd vs Boardsesh grade by angle" dumbbell chart.
//
// Fuses two per-angle series into ONE comparison model:
//  - the CROWD series (community displayDifficulty per angle, from
//    `buildAngleGradeBars`) — "what this board's crowd calls it".
//  - the BOARDSESH series (the nightly cross-board grade per angle, from
//    `useBoardseshGradesForAngles`) — "what it climbs everywhere".
//
// The gap between the two markers at an angle IS the correction. Kept free of
// React so the join + axis math unit-test without a renderer.
import type { GradeDisplayFormat } from '@boardsesh/play-view';
import type { BoardseshGradeAtAngle } from '@boardsesh/graphql/operations';
import { surfacedBoardseshGrade } from '@boardsesh/logbook';
import {
  renderDifficulty,
  clampDifficultyId,
  MIN_DIFFICULTY_ID,
  MAX_DIFFICULTY_ID,
} from '../../lib/boardsesh-grade-display';
import { estimateLabelWidth } from '../../lib/chart/label-metrics';
import type { AngleGradeBar } from './community-utils';

/** Boardsesh confidence at an angle. Mirrors the grade resolver's tiers. */
export type DumbbellTier = 'confirmed' | 'provisional' | 'setter_only' | 'cross_angle_estimate';

/** Ascent-count bin → marker size. `<5` small · `5–20` medium · `>20` large. */
export type DumbbellSizeBin = 'small' | 'medium' | 'large';

/**
 * One angle of the dumbbell chart. `crowd*` fields describe the community ring;
 * `boardsesh*` fields describe the Boardsesh diamond. Either side may be null
 * (an angle present in only one source draws a lone marker). A diamond is only
 * drawn when `hasBoardsesh` is true — a `setter_only` (or grade-less) Boardsesh
 * row keeps its crowd ring but carries no diamond.
 */
export type DumbbellAngleRow = {
  angle: number;
  /** Community display difficulty (float on the shared scale), or null. */
  crowdGrade: number | null;
  /** Formatted community grade label (e.g. "V5"), or null. */
  crowdLabel: string | null;
  /** Boardsesh grade (float), or null when no diamond is drawn at this angle. */
  boardseshGrade: number | null;
  /** Formatted Boardsesh grade label, or null. */
  boardseshLabel: string | null;
  /** Grade colour for the diamond (tinted by ITS grade), or null. */
  boardseshColor: string | null;
  /** Ascent count driving the marker size at this angle. */
  sends: number;
  /** Size bin derived from `sends`. */
  sizeBin: DumbbellSizeBin;
  /** Boardsesh confidence at this angle, or null when there's no Boardsesh row. */
  tier: DumbbellTier | null;
  /** Provisional whisker bounds (float), or null. */
  gradeLow: number | null;
  gradeHigh: number | null;
  /** True when crowd + Boardsesh round to the same grade (draw a nested glyph, no stem). */
  agree: boolean;
  /** True when the crowd has a grade at this angle (draw a ring). */
  hasCrowd: boolean;
  /** True when a Boardsesh diamond is drawn at this angle. */
  hasBoardsesh: boolean;
  /**
   * True when this angle's Boardsesh grade was projected from the climb's other
   * angles because nobody has climbed it. Drawn as a hollow diamond, so the
   * shape of the angle curve reads at a glance while the filled diamonds stay
   * unambiguously the measured ones.
   */
  estimated: boolean;
};

const KNOWN_TIERS: ReadonlySet<string> = new Set<DumbbellTier>([
  'confirmed',
  'provisional',
  'setter_only',
  'cross_angle_estimate',
]);

/** Normalise a confidence string to a known tier, defaulting unknowns to provisional. */
function toTier(confidence: string | undefined): DumbbellTier | null {
  if (confidence == null) return null;
  if (KNOWN_TIERS.has(confidence)) return confidence as DumbbellTier;
  // An unexpected confidence value reads as still-settling, matching the
  // singular grade view's "everything else is provisional" rule.
  return 'provisional';
}

/** `<5` small · `5–20` medium · `>20` large. */
export function sizeBinForSends(sends: number): DumbbellSizeBin {
  if (sends < 5) return 'small';
  if (sends <= 20) return 'medium';
  return 'large';
}

/**
 * Join the Boardsesh per-angle rows with the community per-angle bars into one
 * dumbbell model, sorted ascending by angle.
 *
 * Rules:
 *  - Boardsesh series prefers each row's `universalGrade`, falling back to
 *    `localGrade` (small boards that never earn a universal number).
 *  - A `setter_only` Boardsesh row (or one with no usable grade) draws NO
 *    diamond, but its crowd ring is still kept when the crowd has that angle.
 *  - A `cross_angle_estimate` row draws a HOLLOW diamond and no whisker: the
 *    grade is projected from the climb's other angles, so it belongs on the
 *    curve but must not read as a measurement.
 *  - An angle present in only one source yields a lone marker (no stem).
 *  - An angle with neither a crowd grade nor a Boardsesh diamond is dropped.
 *  - `sends` (marker size) uses the larger of the community count and the
 *    Boardsesh ascensionist count at that angle, so a lone marker still sizes.
 */
export function buildDumbbellByAngleModel(
  boardseshRows: BoardseshGradeAtAngle[],
  crowdBars: AngleGradeBar[],
  gradeFormat: GradeDisplayFormat,
): DumbbellAngleRow[] {
  const crowdByAngle = new Map<number, AngleGradeBar>();
  for (const bar of crowdBars) crowdByAngle.set(bar.angle, bar);

  const boardseshByAngle = new Map<number, BoardseshGradeAtAngle>();
  for (const row of boardseshRows) boardseshByAngle.set(row.angle, row);

  const angles = Array.from(new Set([...crowdByAngle.keys(), ...boardseshByAngle.keys()])).sort((a, b) => a - b);

  const rows: DumbbellAngleRow[] = [];
  for (const angle of angles) {
    const crowd = crowdByAngle.get(angle);
    const boardsesh = boardseshByAngle.get(angle);

    const crowdGrade = crowd?.difficulty ?? null;
    const crowdLabel = crowd?.gradeName ?? null;
    const crowdSends = crowd?.sends ?? 0;

    const tier = toTier(boardsesh?.confidence);
    // No Boardsesh-branded number for setter-only rows — they carry no diamond.
    // Shared with web via @boardsesh/logbook so this rule can't diverge again
    // — see #4414.
    const boardseshRaw = boardsesh && tier !== 'setter_only' ? surfacedBoardseshGrade(boardsesh) : null;
    const rendered = boardseshRaw != null ? renderDifficulty(boardseshRaw, gradeFormat) : null;
    const boardseshGrade = rendered ? boardseshRaw : null;
    const boardseshLabel = rendered?.label ?? null;
    const boardseshColor = rendered?.color ?? null;

    const hasCrowd = crowdGrade != null;
    const hasBoardsesh = boardseshGrade != null && boardseshLabel != null;
    if (!hasCrowd && !hasBoardsesh) continue;

    const sends = Math.max(crowdSends, boardsesh?.ascensionistCount ?? 0);
    const agree = hasCrowd && hasBoardsesh && clampDifficultyId(crowdGrade) === clampDifficultyId(boardseshGrade);
    const estimated = tier === 'cross_angle_estimate';

    rows.push({
      angle,
      crowdGrade,
      crowdLabel,
      boardseshGrade,
      boardseshLabel,
      boardseshColor,
      sends,
      sizeBin: sizeBinForSends(sends),
      tier,
      // A projected angle's band is the transport error plus the siblings' own
      // sampling error — routinely eight grade points wide. Carrying it here
      // would draw a whisker taller than the plot AND stretch the shared y-axis
      // (buildDumbbellAxis windows on these bounds) until every real marker
      // collapsed into the middle third. The estimate's uncertainty is stated in
      // words above the chart instead.
      gradeLow: hasBoardsesh && !estimated ? (boardsesh?.gradeLow ?? null) : null,
      gradeHigh: hasBoardsesh && !estimated ? (boardsesh?.gradeHigh ?? null) : null,
      agree,
      hasCrowd,
      hasBoardsesh,
      estimated,
    });
  }

  return rows;
}

/** True when at least one row carries a Boardsesh diamond. */
export function hasAnyBoardseshDiamond(rows: DumbbellAngleRow[]): boolean {
  return rows.some((row) => row.hasBoardsesh);
}

/**
 * The standardized-grade Y axis for the dumbbell: an integer grade window that
 * covers every plotted value (both markers + whisker bounds) with ~1 grade of
 * padding on each side, plus its tick labels. Values are plotted after shifting
 * by `minId` (so a V12 project's axis can start near V10 instead of wasting the
 * lower two thirds of the plot on grades nobody is looking at).
 */
export type DumbbellAxis = {
  /** Integer grade id at the axis bottom. May sit below MIN_DIFFICULTY_ID —
   *  that padding is what keeps a V0 climb's markers off the x-axis. */
  minId: number;
  /** Integer grade id at the axis top. */
  maxId: number;
  /** Number of gridline sections. */
  noOfSections: number;
  /** Plotted-unit span (a grade float shifted by `minId` never exceeds this). */
  maxValue: number;
  /** Tick labels bottom→top, one per gridline (`noOfSections + 1`). Ticks that
   *  would repeat the label below them (or sit off the real grade scale) carry
   *  BLANK_TICK, so the gridline draws without a label. */
  yAxisLabelTexts: string[];
  /** Width the y-axis label gutter needs for the longest label it emits. */
  yAxisLabelWidth: number;
};

/**
 * An unlabelled gridline. It has to be a SPACE, not an empty string: gifted
 * treats `''` as "no label given" and prints its numeric fallback, so a blank
 * tick would read "0" (see `getLabelTextUtil` in gifted-charts-core). A single
 * space is truthy there and is passed through to the axis verbatim.
 */
export const BLANK_TICK = ' ';

/** ~One grade of headroom on each side of the plotted values (two Font steps). */
const AXIS_PADDING_IDS = 2;
// One gridline per grade id is the goal — that puts a line on every Font grade,
// which is what a climber reading French grades expects. Past this many lines
// the 11px labels start colliding on a 168px-tall plot, so the step coarsens to
// 2 then 3 ids per line for a climb whose grade swings wildly across angles.
const MAX_GRIDLINES = 12;
const MAX_IDS_PER_SECTION = 3;
// Widest y-axis gutter we'll hand over. Only the "both formats" preference on a
// double-digit V grade ("V13 / 8B+") gets near it; a single-format label needs
// about 30, so the plot keeps the width it has today.
const MAX_Y_AXIS_LABEL_WIDTH = 72;
/** Breathing room between the tick label and the plot's left edge. */
const Y_AXIS_GUTTER = 4;

/**
 * Build the shared Y axis from the dumbbell rows. Falls back to a small window
 * around V0 when there are no plottable values (an empty/degenerate model).
 *
 * One gridline per grade id, so every marker lands ON a line rather than
 * floating between two. Difficulty ids map 1:1 to Font grades and 1:3 to
 * V-grades, so the labelling rule is simply "label a tick unless it repeats the
 * tick below it": Font format labels every line, V-grade format labels the line
 * where each new V starts and leaves the in-between lines bare.
 *
 * The window is padded by AXIS_PADDING_IDS on each side so markers and whiskers
 * never sit on the axis edge. At the bottom that padding may run past the
 * easiest real grade (V0) — those ticks go unlabelled rather than being clamped
 * away, because clamping is what used to drop a V0 climb's markers straight onto
 * the x-axis labels. The top stays clamped to the hardest real grade so the top
 * tick always reads truthfully.
 */
export function buildDumbbellAxis(rows: DumbbellAngleRow[], gradeFormat: GradeDisplayFormat): DumbbellAxis {
  const values: number[] = [];
  for (const row of rows) {
    if (row.crowdGrade != null) values.push(row.crowdGrade);
    if (row.boardseshGrade != null) values.push(row.boardseshGrade);
    if (row.gradeLow != null) values.push(row.gradeLow);
    if (row.gradeHigh != null) values.push(row.gradeHigh);
  }

  const lowValue = values.length ? Math.min(...values) : MIN_DIFFICULTY_ID;
  const highValue = values.length ? Math.max(...values) : MIN_DIFFICULTY_ID + AXIS_PADDING_IDS;

  let minId = clampDifficultyId(lowValue) - AXIS_PADDING_IDS;
  const maxId = Math.max(
    minId + AXIS_PADDING_IDS, // a window even when every value rounds to the hardest grade
    Math.min(MAX_DIFFICULTY_ID, clampDifficultyId(highValue) + AXIS_PADDING_IDS),
  );

  // Coarsen the step until the gridlines stop crowding, then stretch the window
  // to a whole number of steps. That stretch goes DOWNWARD: the bottom already
  // runs past the easiest grade as padding, whereas dropping the top tick off
  // the scale would cost the axis its hardest, most-read label.
  let idsPerSection = 1;
  while (idsPerSection < MAX_IDS_PER_SECTION && (maxId - minId) / idsPerSection > MAX_GRIDLINES) {
    idsPerSection += 1;
  }
  minId -= (idsPerSection - ((maxId - minId) % idsPerSection)) % idsPerSection;

  const span = maxId - minId;
  const noOfSections = span / idsPerSection;

  // index 0 = bottom (minId), index noOfSections = top (maxId). Only the bottom
  // can run off the scale — maxId is clamped to the hardest real grade above.
  const yAxisLabelTexts: string[] = [];
  let labelBelow = '';
  for (let index = 0; index <= noOfSections; index++) {
    const id = minId + index * idsPerSection;
    const label = id < MIN_DIFFICULTY_ID ? '' : (renderDifficulty(id, gradeFormat)?.label ?? '');
    yAxisLabelTexts.push(label && label !== labelBelow ? label : BLANK_TICK);
    if (label) labelBelow = label;
  }

  // Blank ticks print nothing, so only the real grade labels can claim gutter,
  // and they're compared as rendered rather than by character count — " / " is
  // worth about half a digit, so the longest string isn't always the widest.
  const longestLabel = yAxisLabelTexts.reduce(
    (longest, label) =>
      label !== BLANK_TICK && estimateLabelWidth(label) > estimateLabelWidth(longest) ? label : longest,
    '',
  );

  return {
    minId,
    maxId,
    noOfSections,
    // Keep the plotted-unit span equal to the id span so `localY` (which divides
    // by maxValue) lands a grade float at `grade - minId`.
    maxValue: span,
    yAxisLabelTexts,
    yAxisLabelWidth: Math.min(MAX_Y_AXIS_LABEL_WIDTH, estimateLabelWidth(longestLabel) + Y_AXIS_GUTTER),
  };
}
