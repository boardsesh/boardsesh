import { sql, type SQL } from 'drizzle-orm';
import {
  CROSS_ANGLE_ESTIMATE_MIN_SIBLINGS,
  GATE_BACKTEST_REGRESSION_TOLERANCE,
  GATE_NO_SHOCK_MAX_MOVE,
  GATE_NO_SHOCK_MIN_ASCENTS,
  GATE_RESIDUAL_PAIRED_GAP,
  GATE_TAIL_MAE_IMPROVEMENT,
  GATE_ZERO_EVIDENCE_MIN_ASCENTS,
  GATE_ZERO_EVIDENCE_MIN_ROWS,
  GATE_ZERO_EVIDENCE_MIN_MAE_IMPROVEMENT,
} from './constants';
import { computePosteriorGrade, echoFractionFor, effectiveN } from './blend';
import { projectAngleObservation } from './cross-angle-estimate';
import type { BoardOffsetSampleRow, TauSampleRow } from './coefficients';
import type { ClimbAngleObservation, GateResult, GradeCoefficients } from './types';

/**
 * No-shock guard: an established climb's published local grade must sit within
 * GATE_NO_SHOCK_MAX_MOVE of its raw crowd mean. If the model moves the head,
 * the prior is too strong — refuse the run.
 */
export function buildNoShockCheckSql(): SQL {
  return sql`
    SELECT COUNT(*) FILTER (
             WHERE g.local_grade IS NOT NULL
               -- 1e-6 tolerance: clamps place grades exactly ON the bound and
               -- float noise can push the difference a hair past it.
               AND ABS(g.local_grade - s.difficulty_average) > ${GATE_NO_SHOCK_MAX_MOVE} + 1e-6
           )::int AS violations,
           COUNT(*)::int AS checked
    FROM board_climb_grades g
    JOIN board_climb_stats s
      ON s.board_type = g.board_type AND s.climb_uuid = g.climb_uuid AND s.angle = g.angle
    WHERE s.ascensionist_count >= ${GATE_NO_SHOCK_MIN_ASCENTS}
      AND s.difficulty_average IS NOT NULL
  `;
}

export function evaluateNoShockGate(row: { violations: number; checked: number }): GateResult {
  return {
    gate: 'no_shock',
    passed: row.violations === 0,
    detail: `${row.violations} of ${row.checked} established climbs moved > ${GATE_NO_SHOCK_MAX_MOVE} grade points`,
    metrics: { violations: row.violations, checked: row.checked },
  };
}

/**
 * Honesty report, per board: if the published grade never deviates from the
 * display grade, the section is dressing the label as a data product — the UI
 * copy must not claim community backing there. Report-only (never blocks).
 */
export function buildHonestyCheckSql(): SQL {
  return sql`
    SELECT g.board_type,
           corr(g.local_grade, s.display_difficulty) AS correlation,
           AVG(ABS(g.local_grade - s.display_difficulty)) AS mean_abs_delta,
           COUNT(*)::int AS rows
    FROM board_climb_grades g
    JOIN board_climb_stats s
      ON s.board_type = g.board_type AND s.climb_uuid = g.climb_uuid AND s.angle = g.angle
    WHERE g.local_grade IS NOT NULL AND s.display_difficulty IS NOT NULL
    GROUP BY g.board_type
  `;
}

/**
 * Duplicate-consistency invariant: climbs sharing a hold_fingerprint are the
 * same physical problem, so their published grades at the same angle must
 * agree. A handful of legitimately ambiguous groups exist; more than 1%
 * disagreement means the pipeline is splitting evidence badly.
 */
export function buildFingerprintInvariantSql(): SQL {
  return sql`
    WITH groups AS (
      SELECT bc.board_type, bc.hold_fingerprint, g.angle,
             MAX(g.local_grade) - MIN(g.local_grade) AS spread
      FROM board_climbs bc
      JOIN board_climb_grades g ON g.board_type = bc.board_type AND g.climb_uuid = bc.uuid
      WHERE bc.hold_fingerprint IS NOT NULL AND g.local_grade IS NOT NULL
      GROUP BY bc.board_type, bc.hold_fingerprint, g.angle
      HAVING COUNT(DISTINCT bc.uuid) >= 2
    )
    SELECT COUNT(*) FILTER (WHERE spread > 1.0)::int AS violations,
           COUNT(*)::int AS groups
    FROM groups
  `;
}

export function evaluateFingerprintGate(row: { violations: number; groups: number }): GateResult {
  const ratio = row.groups > 0 ? row.violations / row.groups : 0;
  return {
    gate: 'fingerprint_consistency',
    passed: ratio <= 0.01,
    detail: `${row.violations} of ${row.groups} duplicate-fingerprint groups disagree by > 1 grade`,
    metrics: { violations: row.violations, groups: row.groups, ratio },
  };
}

/**
 * Cross-board residual: with the Kilter offset applied, the shared-user mean
 * gap must collapse (the median is what the offset was fit on; the mean is the
 * held-out statistic — if they disagree badly the "constant offset" story is
 * wrong and universal grades must not publish).
 */
export function evaluateResidualGapGate(rows: BoardOffsetSampleRow[], kilterOffset: number): GateResult {
  const gaps = rows.map((row) => Number(row.tension_median) - Number(row.kilter_median));
  if (gaps.length === 0) {
    return {
      gate: 'residual_paired_gap',
      passed: false,
      detail: 'no shared Kilter/Tension users with enough graded sends',
      metrics: { users: 0 },
    };
  }
  const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const residual = Math.abs(meanGap - kilterOffset);
  return {
    gate: 'residual_paired_gap',
    passed: residual <= GATE_RESIDUAL_PAIRED_GAP,
    detail: `shared-user mean gap ${meanGap.toFixed(2)} vs fitted offset ${kilterOffset.toFixed(2)} (residual ${residual.toFixed(2)})`,
    metrics: { users: gaps.length, meanGap, kilterOffset, residual },
  };
}

/**
 * Raw material for the zero-evidence projection gate: head climbs (every angle
 * at ≥ GATE_ZERO_EVIDENCE_MIN_ASCENTS ascents) with enough angles that hiding
 * one still leaves CROSS_ANGLE_ESTIMATE_MIN_SIBLINGS behind — the same bar a
 * real climb has to clear before any of its angles get projected. Same row
 * shape as the τ² sample, ordered by climb so the scorer can group in one pass.
 */
export function buildZeroEvidenceSampleSql(): SQL {
  return sql`
    WITH head AS (
      SELECT s.board_type, s.climb_uuid, s.angle, s.difficulty_average, s.display_difficulty, s.ascensionist_count,
             COUNT(*) OVER (PARTITION BY s.board_type, s.climb_uuid) AS n_angles
      FROM board_climb_stats s
      WHERE s.ascensionist_count >= ${GATE_ZERO_EVIDENCE_MIN_ASCENTS}
        AND s.difficulty_average IS NOT NULL
    )
    SELECT board_type, climb_uuid, angle, difficulty_average, display_difficulty, ascensionist_count
    FROM head
    WHERE n_angles >= ${CROSS_ANGLE_ESTIMATE_MIN_SIBLINGS + 1}
    ORDER BY board_type, climb_uuid, angle
  `;
}

/**
 * Score the zero-evidence projection: for each head climb, hide one angle at a
 * time, rebuild it through `buildProjectedAngleObservations` exactly as the
 * pipeline builds a genuinely unclimbed angle, and compare the published grade
 * to the crowd mean that was hidden.
 *
 * Blocks on MAE no-regression against the naive sibling mean (see
 * GATE_ZERO_EVIDENCE_* in constants.ts). Interval coverage is reported
 * alongside rather than enforced: τ² is fitted as the leave-one-angle-out
 * residual variance on this same head population, so coverage here is close to
 * self-referential — informative to watch run over run, not independent enough
 * to gate on.
 */
export function evaluateZeroEvidenceProjection(rows: TauSampleRow[], coefficients: GradeCoefficients): GateResult {
  const byClimb = new Map<string, TauSampleRow[]>();
  for (const row of rows) {
    const key = `${row.board_type}\0${row.climb_uuid}`;
    const bucket = byClimb.get(key);
    if (bucket) bucket.push(row);
    else byClimb.set(key, [row]);
  }

  let scored = 0;
  let projectedAbs = 0;
  let naiveAbs = 0;
  let covered = 0;
  let displayScored = 0;
  let displayAbs = 0;
  for (const climbRows of byClimb.values()) {
    if (climbRows.length <= CROSS_ANGLE_ESTIMATE_MIN_SIBLINGS) continue;
    const observations: ClimbAngleObservation[] = climbRows.map((row) => ({
      boardType: row.board_type,
      climbUuid: row.climb_uuid,
      angle: Number(row.angle),
      difficultyAverage: Number(row.difficulty_average),
      displayDifficulty: row.display_difficulty === null ? null : Number(row.display_difficulty),
      ascensionistCount: Number(row.ascensionist_count),
    }));

    for (const heldOut of observations) {
      const siblings = observations.filter((observation) => observation.angle !== heldOut.angle);
      // One angle, hidden: build it exactly as the pipeline builds an angle with
      // no stats row, minus the publish width cap — the gate is scoring the
      // model, and a cap tight enough to publish nothing must not be able to
      // empty this sample and turn the gate into a vacuous pass.
      const candidate = projectAngleObservation(siblings, heldOut.angle, coefficients);
      if (!candidate) continue;
      const posterior = computePosteriorGrade(candidate, siblings, coefficients);
      if (posterior.localGrade === null || posterior.postSd === null) continue;

      // Naive baseline: the siblings' effective-n-weighted mean with no angle
      // transport at all — "assume it grades the same at every angle".
      const echo = echoFractionFor(coefficients, heldOut.boardType);
      let weightedSum = 0;
      let weightTotal = 0;
      for (const sibling of siblings) {
        if (sibling.difficultyAverage === null) continue;
        const weight = effectiveN(sibling.ascensionistCount, echo);
        weightedSum += sibling.difficultyAverage * weight;
        weightTotal += weight;
      }
      if (weightTotal <= 0) continue;

      const truth = Number(heldOut.difficultyAverage);
      scored += 1;
      projectedAbs += Math.abs(posterior.localGrade - truth);
      naiveAbs += Math.abs(weightedSum / weightTotal - truth);
      if (Math.abs(posterior.localGrade - truth) <= 1.96 * posterior.postSd) covered += 1;
      // Report-only yardstick: the setter's own label at this angle is what the
      // UI falls back to when there is no projection, so it is the number a
      // projection has to be worth showing INSTEAD of. Not a pass criterion —
      // a real unclimbed angle has no stats row and therefore no display label
      // at all, so this is the friendlier-than-reality comparison.
      if (heldOut.displayDifficulty !== null) {
        displayScored += 1;
        displayAbs += Math.abs(heldOut.displayDifficulty - truth);
      }
    }
  }

  const projectedMae = scored > 0 ? projectedAbs / scored : 0;
  const naiveMae = scored > 0 ? naiveAbs / scored : 0;
  const coverage = scored > 0 ? covered / scored : 0;
  const improvement = naiveMae > 0 ? 1 - projectedMae / naiveMae : 0;
  const displayMae = displayScored > 0 ? displayAbs / displayScored : 0;
  return {
    gate: 'zero_evidence_projection',
    passed: scored >= GATE_ZERO_EVIDENCE_MIN_ROWS && projectedMae <= naiveMae - GATE_ZERO_EVIDENCE_MIN_MAE_IMPROVEMENT,
    detail:
      `held-out angle n=${scored}: projected MAE ${projectedMae.toFixed(3)} vs naive sibling mean ${naiveMae.toFixed(3)} ` +
      `(${(improvement * 100).toFixed(1)}% better); display label MAE ${displayMae.toFixed(3)} (report only); ` +
      `95% band covers ${(coverage * 100).toFixed(1)}%`,
    metrics: { scored, projectedMae, naiveMae, improvement, coverage, displayMae, displayScored },
  };
}

/** Score projection quality independently so a large board cannot mask a weak one. */
export function evaluateZeroEvidenceProjectionByBoard(
  rows: TauSampleRow[],
  coefficients: GradeCoefficients,
  boardTypes: readonly string[],
): GateResult[] {
  return boardTypes.map((boardType) => {
    const gate = evaluateZeroEvidenceProjection(
      rows.filter((row) => row.board_type === boardType),
      coefficients,
    );
    return {
      ...gate,
      boardType,
      detail: `${boardType}: ${gate.detail}`,
    };
  });
}

/**
 * Backtest raw material (the decisive gate): for history series that went on
 * to accumulate ≥50 ascents (their latest crowd mean ≈ truth), grab the
 * earliest snapshot where the climb had only 1–3 ascents, plus each sibling
 * angle's state at that same moment. The gate then asks: knowing only what we
 * knew then, does the blended grade beat the raw 1–3-ascent average?
 */
export function buildBacktestSampleSql(limit: number): SQL {
  return sql`
    WITH truth AS (
      SELECT board_type, climb_uuid, angle, difficulty_average AS final_avg
      FROM board_climb_stats
      WHERE ascensionist_count >= 50 AND difficulty_average IS NOT NULL
    ),
    early AS (
      SELECT DISTINCT ON (h.board_type, h.climb_uuid, h.angle)
             h.board_type, h.climb_uuid, h.angle,
             h.difficulty_average AS snap_avg,
             h.display_difficulty AS snap_display,
             h.ascensionist_count AS snap_count,
             h.created_at AS snap_at
      FROM board_climb_stats_history h
      JOIN truth ON truth.board_type = h.board_type AND truth.climb_uuid = h.climb_uuid AND truth.angle = h.angle
      WHERE h.ascensionist_count BETWEEN 1 AND 3 AND h.difficulty_average IS NOT NULL
      ORDER BY h.board_type, h.climb_uuid, h.angle, h.created_at ASC
    ),
    sampled AS (
      SELECT * FROM early ORDER BY md5(climb_uuid || angle::text) LIMIT ${limit}
    )
    SELECT sampled.board_type, sampled.climb_uuid, sampled.angle,
           sampled.snap_avg, sampled.snap_display, sampled.snap_count,
           truth.final_avg,
           COALESCE(siblings.states, '[]'::jsonb) AS sibling_states
    FROM sampled
    JOIN truth ON truth.board_type = sampled.board_type AND truth.climb_uuid = sampled.climb_uuid
              AND truth.angle = sampled.angle
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'angle', s.angle,
               'difficulty_average', s.difficulty_average,
               'display_difficulty', s.display_difficulty,
               'ascensionist_count', s.ascensionist_count)) AS states
      FROM (
        SELECT DISTINCT ON (h2.angle)
               h2.angle, h2.difficulty_average, h2.display_difficulty, h2.ascensionist_count
        FROM board_climb_stats_history h2
        WHERE h2.board_type = sampled.board_type
          AND h2.climb_uuid = sampled.climb_uuid
          AND h2.angle <> sampled.angle
          AND h2.created_at <= sampled.snap_at
        ORDER BY h2.angle, h2.created_at DESC
      ) s
    ) siblings ON true
  `;
}

export interface BacktestSampleRow {
  board_type: string;
  climb_uuid: string;
  angle: number;
  snap_avg: number;
  snap_display: number | null;
  snap_count: number;
  final_avg: number;
  sibling_states: Array<{
    angle: number;
    difficulty_average: number | null;
    display_difficulty: number | null;
    ascensionist_count: number | null;
  }>;
}

export interface BacktestSummary {
  tailGate: GateResult;
  headGate: GateResult;
  /** For the validation report: overall + per-subset error stats. */
  report: {
    multiAngle: { n: number; rawMae: number; shrunkMae: number };
    singleAngle: { n: number; rawMae: number; shrunkMae: number };
  };
}

/**
 * Score the backtest sample. The ≥20% improvement gate applies to the
 * multi-angle subset — the only rows where the model has independent evidence
 * to add at n≤3 (for single-angle rows the posterior ≈ the raw mean by
 * design, so demanding improvement there would be self-deception). Single-angle
 * rows instead assert no-regression, and the head gate bounds absolute error.
 */
export function evaluateBacktest(rows: BacktestSampleRow[], coefficients: GradeCoefficients): BacktestSummary {
  let multi = { n: 0, rawAbs: 0, shrunkAbs: 0 };
  let single = { n: 0, rawAbs: 0, shrunkAbs: 0 };
  for (const row of rows) {
    const target: ClimbAngleObservation = {
      boardType: row.board_type,
      climbUuid: row.climb_uuid,
      angle: row.angle,
      difficultyAverage: Number(row.snap_avg),
      displayDifficulty: row.snap_display === null ? null : Number(row.snap_display),
      ascensionistCount: Number(row.snap_count),
    };
    const siblings: ClimbAngleObservation[] = (row.sibling_states ?? []).map((state) => ({
      boardType: row.board_type,
      climbUuid: row.climb_uuid,
      angle: Number(state.angle),
      difficultyAverage: state.difficulty_average === null ? null : Number(state.difficulty_average),
      displayDifficulty: state.display_difficulty === null ? null : Number(state.display_difficulty),
      ascensionistCount: Number(state.ascensionist_count ?? 0),
    }));
    const posterior = computePosteriorGrade(target, siblings, coefficients);
    if (posterior.localGrade === null) continue;
    const rawError = Math.abs(Number(row.snap_avg) - Number(row.final_avg));
    const shrunkError = Math.abs(posterior.localGrade - Number(row.final_avg));
    const hasSiblingEvidence = siblings.some(
      (sibling) => sibling.difficultyAverage !== null && sibling.ascensionistCount > 0,
    );
    const bucket = hasSiblingEvidence ? multi : single;
    bucket.n += 1;
    bucket.rawAbs += rawError;
    bucket.shrunkAbs += shrunkError;
  }

  const multiRawMae = multi.n > 0 ? multi.rawAbs / multi.n : 0;
  const multiShrunkMae = multi.n > 0 ? multi.shrunkAbs / multi.n : 0;
  const singleRawMae = single.n > 0 ? single.rawAbs / single.n : 0;
  const singleShrunkMae = single.n > 0 ? single.shrunkAbs / single.n : 0;
  const improvement = multiRawMae > 0 ? 1 - multiShrunkMae / multiRawMae : 0;

  // Pass criterion is NO-REGRESSION, not "beat raw by X": the backtest's
  // "truth" (the eventual consensus) is itself herded toward the early label
  // (quick-log echoes), so the raw early mean partly *creates* the target it
  // is scored against. Under that metric a corrective model can't win by much
  // — what it must never do is lose. The improvement number is still reported
  // (and GATE_TAIL_MAE_IMPROVEMENT marks the aspirational bar) so refits that
  // help or hurt are visible run over run.
  const tailGate: GateResult = {
    gate: 'tail_backtest',
    passed: multi.n >= 100 && multiShrunkMae <= multiRawMae + GATE_BACKTEST_REGRESSION_TOLERANCE,
    detail:
      `multi-angle n=${multi.n}: shrunk MAE ${multiShrunkMae.toFixed(3)} vs raw ${multiRawMae.toFixed(3)} ` +
      `(${(improvement * 100).toFixed(1)}% better; aspirational bar ${GATE_TAIL_MAE_IMPROVEMENT * 100}%)`,
    metrics: {
      multiN: multi.n,
      multiRawMae,
      multiShrunkMae,
      improvement,
      singleN: single.n,
      singleRawMae,
      singleShrunkMae,
    },
  };
  const headGate: GateResult = {
    gate: 'head_holdout',
    passed: single.n >= 100 && singleShrunkMae <= singleRawMae + GATE_BACKTEST_REGRESSION_TOLERANCE,
    detail: `single-angle n=${single.n}: shrunk MAE ${singleShrunkMae.toFixed(3)} vs raw ${singleRawMae.toFixed(3)} (no-regression)`,
    metrics: { singleN: single.n, singleRawMae, singleShrunkMae },
  };
  return {
    tailGate,
    headGate,
    report: {
      multiAngle: { n: multi.n, rawMae: multiRawMae, shrunkMae: multiShrunkMae },
      singleAngle: { n: single.n, rawMae: singleRawMae, shrunkMae: singleShrunkMae },
    },
  };
}
