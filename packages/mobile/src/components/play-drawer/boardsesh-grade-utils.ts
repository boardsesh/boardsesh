// Pure view-model builders for the play drawer's "Boardsesh grade" section.
//
// The section leads with the CROSS-BOARD CORRECTION: what this board's crowd
// calls a climb (its community grade at the current angle) versus what it climbs
// everywhere (the nightly data-science Boardsesh grade). These helpers turn the
// grade floats (on the shared difficulty scale, where 10 = 4a/V0 and one unit is
// one Font letter step) into a display model: which confidence tier to show, the
// formatted labels + colours, whether the grade is cross-board (universal), and
// the magnitude + direction of the correction.
//
// Kept free of React so it unit-tests without a renderer.
import type { GradeDisplayFormat } from '@boardsesh/play-view';
import type { BoardseshGrade } from '@boardsesh/graphql/operations';
import { getBoardCapabilities } from '@boardsesh/board-config';
import { isCrossAngleEstimate, surfacedBoardseshGrade } from '@boardsesh/logbook';
import {
  renderDifficulty,
  clampDifficultyId,
  ESTIMATE_PREFIX,
  GRADE_BY_ID,
  MIN_DIFFICULTY_ID,
  MAX_DIFFICULTY_ID,
  type RenderedGrade,
} from '../../lib/boardsesh-grade-display';

// Re-exported for existing/back-compat call sites — the difficulty-scale
// primitives now live in lib/boardsesh-grade-display.ts (a lib must not
// import from components, so they moved there; this file, a component-tree
// helper, imports them like any other consumer).
export { renderDifficulty, clampDifficultyId, GRADE_BY_ID, MIN_DIFFICULTY_ID, MAX_DIFFICULTY_ID, type RenderedGrade };

// Compact status markers for the collapsed-header teaser. Not user-facing
// prose (glyphs, not words), so they stay out of i18n.
const TEASER_ARROW = '▸';
const TEASER_CONFIRMED = '✓';
const TEASER_PROVISIONAL = '~';

export type BoardseshGradeView =
  | { kind: 'noCrowdGrade'; boardName: string }
  | {
      kind: 'setterOnly';
      /** The setter's grade to show muted ("Setter's call: V4"), or null when there's none at all. */
      grade: RenderedGrade | null;
      count: number;
    }
  | {
      /**
       * Nobody has climbed this angle; the grade came from the same climb's
       * other angles. A real number with a real band, but not a measurement —
       * rendered muted, marked with `≈`, and never given the confirmed seal.
       */
      kind: 'crossAngle';
      /** True = cross-board (universal) grade; false = scoped to this board only. */
      universal: boolean;
      grade: RenderedGrade;
      /** Raw primary grade float (drives the chart reference line). */
      gradeValue: number;
      /**
       * The bounding grade labels, or null when the band is too wide to be
       * worth printing. A projection's band routinely spans four grades either
       * way (τ² is the transport error plus the siblings' own sampling error),
       * and "V1–V9" tells a climber nothing — the caveat sentence carries the
       * uncertainty in that case.
       */
      range: { low: string; high: string } | null;
      computedAt: string;
    }
  | {
      kind: 'confirmed';
      /** True = cross-board (universal) grade; false = scoped to this board only. */
      universal: boolean;
      grade: RenderedGrade;
      /** Raw primary grade float (drives the correction delta + chart reference line). */
      gradeValue: number;
      gradeLow: number | null;
      gradeHigh: number | null;
      count: number;
      computedAt: string;
    }
  | {
      kind: 'provisional';
      universal: boolean;
      grade: RenderedGrade;
      gradeValue: number;
      /** Non-null when the low/high bounds round to different grades ("V5–V6"). */
      rangeLabel: string | null;
      gradeLow: number | null;
      gradeHigh: number | null;
      count: number;
      computedAt: string;
    };

/** The label a bound rounds to, used to decide whether a range spans two grades. */
function boundLabel(value: number, gradeFormat: GradeDisplayFormat): string | null {
  return renderDifficulty(value, gradeFormat)?.label ?? null;
}

/**
 * The low/high grade labels for the trust line, falling back to the headline
 * grade when a bound is missing. `sameLabel` is true when both bounds round to
 * the SAME displayed grade — the caller then drops the range (a "V4–V4" reads
 * as a bug) and shows a single-grade trust line instead.
 */
export function buildTrustBand(
  low: number | null,
  high: number | null,
  headlineLabel: string,
  gradeFormat: GradeDisplayFormat,
): { low: string; high: string; sameLabel: boolean } {
  const lowLabel = (low != null ? boundLabel(low, gradeFormat) : null) ?? headlineLabel;
  const highLabel = (high != null ? boundLabel(high, gradeFormat) : null) ?? headlineLabel;
  return { low: lowLabel, high: highLabel, sameLabel: lowLabel === highLabel };
}

/**
 * Widest band, in grade points, still worth printing as a `low–high` range on a
 * projected angle. One grade point is one Font letter, so 4 spans two full
 * V-grades either side of the estimate — past that the range stops informing
 * and starts looking broken, and the caveat sentence says it better in words.
 */
export const MAX_PRINTABLE_ESTIMATE_BAND = 4;

/** The bounding grade labels for a projection, or null when the band is too wide or degenerate. */
export function buildEstimateRange(
  low: number | null,
  high: number | null,
  gradeFormat: GradeDisplayFormat,
): { low: string; high: string } | null {
  if (low == null || high == null) return null;
  if (high - low > MAX_PRINTABLE_ESTIMATE_BAND) return null;
  const lowLabel = boundLabel(low, gradeFormat);
  const highLabel = boundLabel(high, gradeFormat);
  if (!lowLabel || !highLabel || lowLabel === highLabel) return null;
  return { low: lowLabel, high: highLabel };
}

/**
 * Build the display model for a climb+angle's Boardsesh grade.
 * `grade` is null when the nightly job has no row yet (falls back to setter-only).
 */
export function buildBoardseshGradeView(
  boardName: string,
  grade: BoardseshGrade | null,
  gradeFormat: GradeDisplayFormat,
): BoardseshGradeView {
  if (!getBoardCapabilities(boardName).crowdGrade) return { kind: 'noCrowdGrade', boardName: boardName.toLowerCase() };
  if (!grade) return { kind: 'setterOnly', grade: null, count: 0 };

  // Prefer the cross-board universal grade; fall back to the board-local grade
  // (small boards that never earn a universal number). Shared with web via
  // @boardsesh/logbook so this rule can't diverge again — see #4414.
  const universal = grade.universalGrade != null;
  const primary = surfacedBoardseshGrade(grade);
  const rendered = primary != null ? renderDifficulty(primary, gradeFormat) : null;

  if (grade.confidence === 'setter_only' || primary == null || !rendered) {
    return { kind: 'setterOnly', grade: rendered, count: grade.ascensionistCount };
  }

  if (isCrossAngleEstimate(grade.confidence)) {
    return {
      kind: 'crossAngle',
      universal,
      grade: rendered,
      gradeValue: primary,
      range: buildEstimateRange(grade.gradeLow, grade.gradeHigh, gradeFormat),
      computedAt: grade.computedAt,
    };
  }

  if (grade.confidence === 'confirmed') {
    return {
      kind: 'confirmed',
      universal,
      grade: rendered,
      gradeValue: primary,
      gradeLow: grade.gradeLow,
      gradeHigh: grade.gradeHigh,
      count: grade.ascensionistCount,
      computedAt: grade.computedAt,
    };
  }

  // Everything else ('provisional', or any unexpected value) reads as still
  // settling. Show a range only when the bounds round to two different grades.
  let rangeLabel: string | null = null;
  if (grade.gradeLow != null && grade.gradeHigh != null) {
    const lowLabel = boundLabel(grade.gradeLow, gradeFormat);
    const highLabel = boundLabel(grade.gradeHigh, gradeFormat);
    if (lowLabel && highLabel && lowLabel !== highLabel) {
      rangeLabel = `${lowLabel}–${highLabel}`;
    }
  }

  return {
    kind: 'provisional',
    universal,
    grade: rendered,
    gradeValue: primary,
    rangeLabel,
    gradeLow: grade.gradeLow,
    gradeHigh: grade.gradeHigh,
    count: grade.ascensionistCount,
    computedAt: grade.computedAt,
  };
}

/** Direction of the crowd grade relative to the cross-board Boardsesh grade. */
export type DeltaDirection = 'easier' | 'stiffer' | 'equal';

export type BoardseshCorrection = {
  /** The crowd's community grade at this angle ("This board"). */
  crowd: RenderedGrade;
  /** Correction magnitude in V-grade steps (a multiple of ½), 0 when they agree. */
  steps: number;
  /** Magnitude label for the pill ("½", "1", "1½"), or null when the grades agree. */
  label: string | null;
  /** Which way the crowd sits relative to everywhere: `easier` = everywhere is
   *  easier than the crowd calls it (crowd over-grades); `stiffer` = the reverse. */
  direction: DeltaDirection;
};

/**
 * Render a ½-step magnitude as a compact label: 0.5 → "½", 1 → "1", 1.5 → "1½".
 * Returns null for a zero (or negative) magnitude.
 */
export function formatHalfGrades(steps: number): string | null {
  if (steps <= 0) return null;
  const whole = Math.floor(steps);
  const hasHalf = steps - whole >= 0.5;
  const label = `${whole > 0 ? whole : ''}${hasHalf ? '½' : ''}`;
  return label.length ? label : null;
}

/**
 * The correction between the crowd's grade at this angle and the cross-board
 * Boardsesh grade. Agreement is decided by the LABEL each side renders under the
 * viewer's grade format — not the raw id delta — so two ids that fall in the same
 * displayed V-grade read as "matches this board". When the labels differ, the
 * magnitude comes from the id delta (one id step is one Font letter, i.e. half a
 * V-grade), so it reads in ½-grades. Null when there's no crowd grade at this
 * angle (nothing to correct against).
 */
export function buildCorrection(
  crowdDifficulty: number | null,
  boardseshValue: number,
  gradeFormat: GradeDisplayFormat,
): BoardseshCorrection | null {
  if (crowdDifficulty == null) return null;
  const crowd = renderDifficulty(crowdDifficulty, gradeFormat);
  if (!crowd) return null;

  // Gate agreement on the LABEL the hero actually shows, not the id delta. Some
  // V-grades cover multiple ids that collapse to one label — V0 (4a/4b/4c) and V1
  // (5a/5b), whose Font members never take a "+" suffix — so a crowd id and a
  // Boardsesh id can differ yet render the identical label. When the two displayed
  // labels match it "matches this board" — no pill, no payoff — even if the ids
  // differ, which keeps the hero in step with the collapsed teaser (it gates the
  // same way on the label).
  const boardsesh = renderDifficulty(boardseshValue, gradeFormat);
  if (boardsesh && crowd.label === boardsesh.label) {
    return { crowd, steps: 0, label: null, direction: 'equal' };
  }

  const idDelta = clampDifficultyId(crowdDifficulty) - clampDifficultyId(boardseshValue);
  const steps = Math.abs(idDelta) / 2;
  const direction: DeltaDirection = idDelta > 0 ? 'easier' : idDelta < 0 ? 'stiffer' : 'equal';
  return { crowd, steps, label: formatHalfGrades(steps), direction };
}

/**
 * Collapsed-header teaser for the Boardsesh grade section — a compact plain
 * string leading with the correction. When a crowd label is supplied and it
 * differs from the confirmed cross-board grade, shows "{crowd} ▸ {bs} ✓"; a
 * confident cross-board grade alone reads "{bs} ✓"; provisional "{bs} ~";
 * a projected angle "≈{bs}"; local-only "{bs} · {localWord}". Null for
 * a no-crowd-grade board / setter-only.
 */
export function buildBoardseshGradeSummary(
  view: BoardseshGradeView,
  options?: { crowdLabel?: string | null; localWord?: string },
): string | null {
  const crowdLabel = options?.crowdLabel ?? null;
  const localWord = options?.localWord;

  switch (view.kind) {
    case 'confirmed': {
      const bs = view.grade.label;
      if (!view.universal) return localWord ? `${bs} · ${localWord}` : bs;
      if (crowdLabel && crowdLabel !== bs) return `${crowdLabel} ${TEASER_ARROW} ${bs} ${TEASER_CONFIRMED}`;
      return `${bs} ${TEASER_CONFIRMED}`;
    }
    case 'provisional': {
      const bs = view.rangeLabel ?? view.grade.label;
      if (!view.universal && localWord) return `${bs} · ${localWord}`;
      return `${bs} ${TEASER_PROVISIONAL}`;
    }
    case 'crossAngle':
      // No crowd number to compare against at an unclimbed angle, so the teaser
      // is just the marked estimate — never the ✓ seal or the correction arrow.
      return `${ESTIMATE_PREFIX}${view.grade.label}`;
    default:
      return null;
  }
}
