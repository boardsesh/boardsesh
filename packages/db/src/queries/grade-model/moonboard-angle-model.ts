/**
 * MoonBoard same-board angle grade estimate.
 *
 * MoonBoard problems are set at one of two fixed angles, 25° or 40°, and 96.7%
 * of them only ever get a grade at one of the two — nobody has climbed the
 * other angle, so there is nothing to show there at all. This module learns a
 * per-grade-band delta between the two angles from the small minority of
 * problems that DO carry a real grade at both, so the missing angle can be
 * filled with a clearly-marked estimate.
 *
 * This is deliberately NOT part of the empirical-Bayes Boardsesh grade
 * (blend.ts / cross-angle-estimate.ts / coefficients.ts). MoonBoard has no
 * crowd mean in our feed — `difficulty_average == display_difficulty ==
 * benchmark`, byte for byte — so the EB machinery has no signal to shrink and
 * MoonBoard is excluded from `CROWD_MEAN_BOARDS` on purpose. What follows works
 * from setter labels alone: a same-board transpose, not a community
 * projection, and it shares no types with the main pipeline so it can never
 * perturb it. See docs/boardsesh-grade.md.
 *
 * Robustness, because setter labels are noisy:
 *  - **Median, not mean.** ~15% of dual-graded pairs don't even get harder with
 *    angle, and the v9+ band (n=54 on the dev catalogue) flips sign under a
 *    plain mean. Median + a leave-one-out stability check is the same rigor
 *    bridges.ts already applies to Moon-adjacent data.
 *  - **Band guards.** A band's own delta is used only when it has enough
 *    climbs, its sign agrees with the pooled direction, and it is LOO-stable.
 *    Anything else falls back to the pooled `all` delta.
 */
import { BOULDER_GRADES } from '@boardsesh/board-constants/boulder-grade-mapping';
import { MOONBOARD_ANGLES } from '@boardsesh/board-config';
import { sql, type SQL } from 'drizzle-orm';
import { gradeBandForDifficulty } from './blend';
import {
  ANGLE_CELL_MIN_CLIMBS,
  DEFAULT_SIGMA_WITHIN,
  GRADE_BANDS,
  MOON_BRIDGE_MAX_LOO_DELTA,
  type GradeBandKey,
} from './constants';

/**
 * Version stamped on every `board_climb_grades` row this model produces.
 *
 * Deliberately NOT `GRADE_MODEL_VERSION`: that string already means "went
 * through the real EB blend", and reusing it would make `model_version`
 * ambiguous the moment anyone debugs a MoonBoard row.
 */
export const MOONBOARD_ANGLE_MODEL_VERSION = 'moonboard-angle-v1';

/** `board_grade_coefficients.kind` this model reads and writes. */
export const MOONBOARD_ANGLE_COEFFICIENT_KIND = 'moonboard_angle_offset';

/** The board's only two angles. Everything here is defined in terms of the pair. */
export const [MOONBOARD_SHALLOW_ANGLE, MOONBOARD_STEEP_ANGLE] = MOONBOARD_ANGLES;

/**
 * Leave-one-out instability that disqualifies a band's own median, reusing the
 * bridge estimator's bar (`MOON_BRIDGE_MAX_LOO_DELTA`) rather than inventing a
 * second number for the same "is this median pinned by more than one climb?"
 * question.
 */
export const MOONBOARD_ANGLE_MAX_LOO_DELTA = MOON_BRIDGE_MAX_LOO_DELTA;

/** Difficulty-scale bounds an estimate is clamped into (10 = 4a/V0). */
const MIN_DIFFICULTY_ID = BOULDER_GRADES[0].difficulty_id;
const MAX_DIFFICULTY_ID = BOULDER_GRADES[BOULDER_GRADES.length - 1].difficulty_id;

/** Which of the two angles a delta table transposes FROM. */
export type MoonboardKnownAngle = typeof MOONBOARD_SHALLOW_ANGLE | typeof MOONBOARD_STEEP_ANGLE;

/** The pooled cell is keyed `all`; every other cell is keyed by grade band. */
export type MoonboardAngleCellKey = GradeBandKey | 'all';

export interface MoonboardAngleDeltaCell {
  /** Median (grade₍other₎ − grade₍known₎) over the cell's dual-graded climbs. */
  delta: number;
  /** Dual-graded climbs behind the median. */
  n: number;
  /** Robust spread of those deltas, used as the ± band on an estimate. */
  sd: number;
  /** Worst leave-one-out movement of the median (0 when n ≤ 1). */
  looMaxDelta: number;
}

/** Band → cell, plus the pooled `all` fallback. Missing bands fell a guard. */
export type MoonboardAngleDeltaTable = Partial<Record<MoonboardAngleCellKey, MoonboardAngleDeltaCell>>;

export interface MoonboardAngleCoefficients {
  coeffVersion: string;
  /** Banded on the 25° grade; value = 40° grade − 25° grade (expected ≥ 0). */
  from25: MoonboardAngleDeltaTable;
  /** Banded on the 40° grade; value = 25° grade − 40° grade (expected ≤ 0). */
  from40: MoonboardAngleDeltaTable;
}

/** Why a band did not get to keep its own median (empty when it did). */
export type MoonboardAngleBandRejection = 'low_n' | 'sign_flip' | 'loo_unstable';

export interface MoonboardAngleBandReport {
  direction: MoonboardKnownAngle;
  band: GradeBandKey;
  n: number;
  median: number | null;
  sd: number | null;
  looMaxDelta: number | null;
  /** null when the band kept its own median. */
  rejectedBecause: MoonboardAngleBandRejection | null;
}

export interface MoonboardAngleFitReport {
  sampleClimbs: number;
  /** Share of dual-graded pairs where the 40° grade is not harder than the 25° one. */
  nonMonotonicShare: number;
  bands: MoonboardAngleBandReport[];
  /** Pooled cells must exist and point the right way or nothing may publish. */
  pooledFrom25: MoonboardAngleDeltaCell | null;
  pooledFrom40: MoonboardAngleDeltaCell | null;
  /** Human-readable reasons the pooled fit is unusable; empty means publishable. */
  problems: string[];
}

/** One MoonBoard problem carrying a real grade at BOTH 25° and 40°. */
export interface MoonboardDualAngleSampleRow {
  climb_uuid: string;
  grade_25: number;
  grade_40: number;
}

/**
 * The training sample: MoonBoard problems with a real, ascent-backed display
 * grade at both angles. "Real" is `display_difficulty IS NOT NULL AND
 * ascensionist_count > 0` — the same predicate the publish script uses to
 * decide an angle is missing, so a climb can never be both a training pair and
 * an estimate target.
 */
export function buildMoonboardDualAngleSampleSql(): SQL {
  return sql`
    SELECT s.climb_uuid,
           MAX(s.display_difficulty) FILTER (WHERE s.angle = ${MOONBOARD_SHALLOW_ANGLE})::float8 AS grade_25,
           MAX(s.display_difficulty) FILTER (WHERE s.angle = ${MOONBOARD_STEEP_ANGLE})::float8 AS grade_40
    FROM board_climb_stats s
    JOIN board_climbs bc ON bc.board_type = s.board_type AND bc.uuid = s.climb_uuid
    WHERE s.board_type = 'moonboard'
      AND s.angle IN (${MOONBOARD_SHALLOW_ANGLE}, ${MOONBOARD_STEEP_ANGLE})
      AND s.display_difficulty IS NOT NULL
      AND s.ascensionist_count > 0
      AND bc.is_listed = true
      AND COALESCE(bc.is_draft, false) = false
    GROUP BY s.climb_uuid
    HAVING COUNT(*) FILTER (WHERE s.angle = ${MOONBOARD_SHALLOW_ANGLE}) > 0
       AND COUNT(*) FILTER (WHERE s.angle = ${MOONBOARD_STEEP_ANGLE}) > 0
  `;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[midpoint - 1] + sorted[midpoint]) / 2 : sorted[midpoint];
}

function looMaxDeltaOf(values: readonly number[], estimate: number): number {
  if (values.length <= 1) return 0;
  let worst = 0;
  for (let index = 0; index < values.length; index++) {
    const leaveOneOut = median(values.slice(0, index).concat(values.slice(index + 1)));
    if (leaveOneOut !== null) worst = Math.max(worst, Math.abs(leaveOneOut - estimate));
  }
  return worst;
}

/**
 * Robust spread around the median: 1.4826 × MAD, the median-consistent
 * analogue of a standard deviation. A plain SD would be the wrong companion to
 * a median on a sample this skewed (a handful of pairs disagree by four grades
 * and would dominate it).
 *
 * Floored at `DEFAULT_SIGMA_WITHIN`, the model's fallback within-climb spread
 * of genuinely expressed grades: a band where every setter happened to label
 * the same delta is not evidence that a transposed grade is exact, and a
 * zero-width band would print as one.
 */
function robustSpread(values: readonly number[], centre: number): number {
  const absoluteDeviations = values.map((value) => Math.abs(value - centre));
  const mad = median(absoluteDeviations) ?? 0;
  return Math.max(DEFAULT_SIGMA_WITHIN, 1.4826 * mad);
}

function buildCell(values: readonly number[]): MoonboardAngleDeltaCell | null {
  const centre = median(values);
  if (centre === null) return null;
  return {
    delta: centre,
    n: values.length,
    sd: robustSpread(values, centre),
    looMaxDelta: looMaxDeltaOf(values, centre),
  };
}

/** Sign the pooled delta must carry for a direction to be usable at all. */
function expectedSign(knownAngle: MoonboardKnownAngle): 1 | -1 {
  return knownAngle === MOONBOARD_SHALLOW_ANGLE ? 1 : -1;
}

interface DirectionFit {
  table: MoonboardAngleDeltaTable;
  pooled: MoonboardAngleDeltaCell | null;
  bands: MoonboardAngleBandReport[];
}

/**
 * Fit one direction: band every pair on the KNOWN angle's grade, take the
 * median delta per band, and keep a band only when it is well-sampled, points
 * the same way as the pooled delta, and is LOO-stable. Rejected bands are
 * simply absent from the table — the lookup falls through to `all`.
 */
function fitDirection(
  deltasByBand: ReadonlyMap<GradeBandKey, number[]>,
  pooledValues: readonly number[],
  knownAngle: MoonboardKnownAngle,
): DirectionFit {
  const pooled = buildCell(pooledValues);
  const table: MoonboardAngleDeltaTable = {};
  if (pooled) table.all = pooled;

  const sign = expectedSign(knownAngle);
  const bands: MoonboardAngleBandReport[] = [];
  for (const { key } of GRADE_BANDS) {
    const values = deltasByBand.get(key) ?? [];
    const cell = buildCell(values);
    let rejectedBecause: MoonboardAngleBandRejection | null = null;
    if (cell === null || cell.n < ANGLE_CELL_MIN_CLIMBS) {
      rejectedBecause = 'low_n';
    } else if (cell.delta * sign < 0) {
      rejectedBecause = 'sign_flip';
    } else if (cell.looMaxDelta > MOONBOARD_ANGLE_MAX_LOO_DELTA) {
      rejectedBecause = 'loo_unstable';
    }
    if (cell !== null && rejectedBecause === null) table[key] = cell;
    bands.push({
      direction: knownAngle,
      band: key,
      n: values.length,
      median: cell?.delta ?? null,
      sd: cell?.sd ?? null,
      looMaxDelta: cell?.looMaxDelta ?? null,
      rejectedBecause,
    });
  }
  return { table, pooled, bands };
}

function pushBanded(byBand: Map<GradeBandKey, number[]>, band: GradeBandKey, value: number): void {
  const values = byBand.get(band);
  if (values) {
    values.push(value);
    return;
  }
  byBand.set(band, [value]);
}

/**
 * Fit both directional delta tables from the dual-graded sample.
 *
 * `from25` is banded on the 25° grade and carries (40° − 25°); `from40` is
 * banded on the 40° grade and carries (25° − 40°). Two tables rather than one
 * signed offset because the band a climb lands in depends on which grade you
 * know, and the sample's bands are not symmetric.
 */
export function estimateMoonboardAngleDeltas(
  samples: readonly MoonboardDualAngleSampleRow[],
  coeffVersion: string,
): { coefficients: MoonboardAngleCoefficients; report: MoonboardAngleFitReport } {
  const from25ByBand = new Map<GradeBandKey, number[]>();
  const from40ByBand = new Map<GradeBandKey, number[]>();
  const from25Pooled: number[] = [];
  const from40Pooled: number[] = [];
  let nonMonotonic = 0;

  for (const sample of samples) {
    const shallow = Number(sample.grade_25);
    const steep = Number(sample.grade_40);
    if (!Number.isFinite(shallow) || !Number.isFinite(steep)) continue;
    const up = steep - shallow;
    if (up <= 0) nonMonotonic += 1;

    pushBanded(from25ByBand, gradeBandForDifficulty(shallow), up);
    pushBanded(from40ByBand, gradeBandForDifficulty(steep), -up);
    from25Pooled.push(up);
    from40Pooled.push(-up);
  }

  const from25 = fitDirection(from25ByBand, from25Pooled, MOONBOARD_SHALLOW_ANGLE);
  const from40 = fitDirection(from40ByBand, from40Pooled, MOONBOARD_STEEP_ANGLE);

  const problems: string[] = [];
  if (from25.pooled === null || from40.pooled === null) {
    problems.push('no dual-angle sample: neither pooled delta could be estimated');
  } else {
    if (from25.pooled.delta <= 0) {
      problems.push(`pooled 25°→40° delta is ${from25.pooled.delta.toFixed(2)} (expected > 0)`);
    }
    if (from40.pooled.delta >= 0) {
      problems.push(`pooled 40°→25° delta is ${from40.pooled.delta.toFixed(2)} (expected < 0)`);
    }
  }

  return {
    coefficients: { coeffVersion, from25: from25.table, from40: from40.table },
    report: {
      sampleClimbs: from25Pooled.length,
      nonMonotonicShare: from25Pooled.length === 0 ? 0 : nonMonotonic / from25Pooled.length,
      bands: [...from25.bands, ...from40.bands],
      pooledFrom25: from25.pooled,
      pooledFrom40: from40.pooled,
      problems,
    },
  };
}

export interface MoonboardAngleEstimate {
  /** The estimated grade at the other angle, on the shared difficulty scale. */
  grade: number;
  /** The band the KNOWN grade fell in (what the lookup was keyed on). */
  band: GradeBandKey;
  /** Which cell actually supplied the delta — `all` means the band was rejected. */
  cellKey: MoonboardAngleCellKey;
  /** Half-width of the ± band to publish as grade_low/grade_high. */
  sd: number;
}

/**
 * What a MoonBoard problem graded `displayGrade` at `knownAngle` would grade at
 * the other angle. Pure: bands the known grade, picks the matching directional
 * cell (falling back to the pooled `all` delta), and returns the shifted grade
 * rounded to the integer difficulty scale and clamped to a real grade id.
 *
 * Null when the angle isn't one of MoonBoard's two, the grade isn't finite, or
 * the direction has no usable coefficients at all.
 */
export function estimateMoonboardGradeAtOtherAngle(
  displayGrade: number,
  knownAngle: number,
  coefficients: MoonboardAngleCoefficients,
): MoonboardAngleEstimate | null {
  if (!Number.isFinite(displayGrade)) return null;
  if (knownAngle !== MOONBOARD_SHALLOW_ANGLE && knownAngle !== MOONBOARD_STEEP_ANGLE) return null;

  const table = knownAngle === MOONBOARD_SHALLOW_ANGLE ? coefficients.from25 : coefficients.from40;
  const band = gradeBandForDifficulty(displayGrade);
  const cellKey: MoonboardAngleCellKey = table[band] !== undefined ? band : 'all';
  const cell = table[cellKey];
  if (!cell) return null;

  const shifted = Math.round(displayGrade + cell.delta);
  return {
    grade: Math.min(MAX_DIFFICULTY_ID, Math.max(MIN_DIFFICULTY_ID, shifted)),
    band,
    cellKey,
    sd: cell.sd,
  };
}

/** The other of MoonBoard's two angles, or null when given neither. */
export function otherMoonboardAngle(angle: number): MoonboardKnownAngle | null {
  if (angle === MOONBOARD_SHALLOW_ANGLE) return MOONBOARD_STEEP_ANGLE;
  if (angle === MOONBOARD_STEEP_ANGLE) return MOONBOARD_SHALLOW_ANGLE;
  return null;
}

/** `board_grade_coefficients` rows for one fit, keyed `from25:v0-2`, `from40:all`, … */
export function buildMoonboardAngleCoefficientRows(
  coefficients: MoonboardAngleCoefficients,
): { kind: string; key: string; payload: MoonboardAngleDeltaCell }[] {
  const rows: { kind: string; key: string; payload: MoonboardAngleDeltaCell }[] = [];
  for (const [prefix, table] of [
    ['from25', coefficients.from25],
    ['from40', coefficients.from40],
  ] as const) {
    for (const [cellKey, cell] of Object.entries(table)) {
      if (!cell) continue;
      rows.push({ kind: MOONBOARD_ANGLE_COEFFICIENT_KIND, key: `${prefix}:${cellKey}`, payload: cell });
    }
  }
  return rows;
}
