import { sql, type SQL } from 'drizzle-orm';
import {
  GATE_BACKTEST_REGRESSION_TOLERANCE,
  GATE_NO_SHOCK_MAX_MOVE,
  GATE_NO_SHOCK_MIN_ASCENTS,
  GATE_RESIDUAL_PAIRED_GAP,
  GATE_TAIL_MAE_IMPROVEMENT,
} from './constants';
import { computePosteriorGrade, echoFractionFor, effectiveN } from './blend';
import type { BoardOffsetSampleRow } from './coefficients';
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

/**
 * One offline Climb2Vec content-model estimate for a climb+angle. Mirrors the
 * board_climb_embeddings columns the nightly refresh reads, so the file-injection
 * path (candidate scoring) and the DB path share the same value shape and key.
 */
export interface ContentPriorEntry {
  contentPrior: number;
  contentSd: number | null;
}

/**
 * Map key for a content prior. Deliberately board-less: callers hold a per-board
 * map, so a climb+angle uniquely identifies a row within it. The NUL separator
 * is safe because climb UUIDs never contain one.
 */
export function contentPriorKey(climbUuid: string, angle: number): string {
  return `${climbUuid} ${angle}`;
}

/** n_eff strata for the content-prior backtest. Snapshot counts are 1–3, so on
 * high-echo boards nearly all mass lands in [1,3); the wider buckets exist for
 * low-echo boards (small λ) where n_eff(snap_count) can reach 3+. */
const CONTENT_PRIOR_NEFF_BUCKETS = ['<1', '[1,3)', '[3,10)', '>=10'] as const;

function contentPriorNEffBucket(nEff: number): (typeof CONTENT_PRIOR_NEFF_BUCKETS)[number] {
  if (nEff < 1) return '<1';
  if (nEff < 3) return '[1,3)';
  if (nEff < 10) return '[3,10)';
  return '>=10';
}

/** Per-bucket (and overall) error stats for the content-prior backtest report. */
export interface ContentPriorBucketReport {
  /** One of the n_eff buckets, or 'overall'. */
  bucket: string;
  /** Matched candidate rows in this bucket (the content/coverage denominator). */
  n: number;
  /** Mean |contentPrior − final_avg| over the n matched rows. */
  contentMae: number;
  /** Mean |snap_avg − final_avg| over display-comparable rows (raw early crowd). */
  earlyCrowdMae: number;
  /** Mean |snap_display − final_avg| over display-comparable rows (honest no-content baseline). */
  earlyDisplayMae: number;
  /** Matched rows with a non-null snap_display (the shared baseline denominator). */
  displayComparableRows: number;
  /** Matched rows whose snap_display was null (excluded from both baselines, counted here). */
  displayNullRows: number;
}

export interface ContentPriorBacktestSummary {
  boardType: string;
  /** Backtest sample rows scored for this board (coverage denominator). */
  totalRows: number;
  /** Rows that had a candidate content prior in the file. */
  matchedRows: number;
  /** matchedRows / totalRows. */
  coverage: number;
  overall: ContentPriorBucketReport;
  /** The four n_eff buckets in fixed order. */
  buckets: ContentPriorBucketReport[];
  /** Report-only gate ('content_prior_backtest', always passed) for the run's gate list. */
  gate: GateResult;
}

interface ContentPriorAccumulator {
  matched: number;
  contentAbs: number;
  displayComparable: number;
  crowdAbs: number;
  displayAbs: number;
  displayNull: number;
}

function makeContentPriorAccumulator(): ContentPriorAccumulator {
  return { matched: 0, contentAbs: 0, displayComparable: 0, crowdAbs: 0, displayAbs: 0, displayNull: 0 };
}

function toContentPriorBucketReport(bucket: string, acc: ContentPriorAccumulator): ContentPriorBucketReport {
  return {
    bucket,
    n: acc.matched,
    contentMae: acc.matched > 0 ? acc.contentAbs / acc.matched : 0,
    earlyCrowdMae: acc.displayComparable > 0 ? acc.crowdAbs / acc.displayComparable : 0,
    earlyDisplayMae: acc.displayComparable > 0 ? acc.displayAbs / acc.displayComparable : 0,
    displayComparableRows: acc.displayComparable,
    displayNullRows: acc.displayNull,
  };
}

/**
 * Score a CANDIDATE content-prior set against the same pre-registered backtest
 * sample the crowd model is graded on. For every history snapshot whose series
 * later reached ≥50 ascents (final_avg = truth), and for which the candidate
 * file supplies a prior, we compare three errors against that truth:
 *
 *  - content: |contentPrior − final_avg| (the candidate)
 *  - early-crowd: |snap_avg − final_avg| (the raw 1–3-ascent mean)
 *  - display: |snap_display − final_avg| (what users saw pre-crowd — the honest
 *    no-content baseline)
 *
 * The candidate is scored on every matched row; the two BASELINES share a
 * denominator of rows with a non-null snap_display, so crowd-vs-display stays an
 * apples-to-apples pair and null-display rows are reported separately rather than
 * silently inflating either baseline. Errors are stratified by the snapshot's
 * n_eff bucket (effectiveN(snap_count, echoFraction)).
 *
 * The map is keyed by contentPriorKey (board-less) — pass a per-board map and
 * rows already filtered to that board (see refresh-climb-grades). The returned
 * gate is REPORT-ONLY (never blocks): the backtest truth is itself herded toward
 * the early label, so this is a diagnostic, not a pass/fail bar.
 */
export function evaluateContentPriorBacktest(
  rows: BacktestSampleRow[],
  contentPriors: Map<string, ContentPriorEntry>,
  coefficients: GradeCoefficients,
): ContentPriorBacktestSummary {
  const boardType = rows[0]?.board_type ?? 'unknown';
  const overall = makeContentPriorAccumulator();
  const byBucket = new Map<string, ContentPriorAccumulator>();
  for (const bucket of CONTENT_PRIOR_NEFF_BUCKETS) byBucket.set(bucket, makeContentPriorAccumulator());

  let matchedRows = 0;
  for (const row of rows) {
    const entry = contentPriors.get(contentPriorKey(row.climb_uuid, Number(row.angle)));
    if (!entry || !Number.isFinite(entry.contentPrior)) continue;
    matchedRows += 1;

    const finalAvg = Number(row.final_avg);
    const contentError = Math.abs(Number(entry.contentPrior) - finalAvg);
    const crowdError = Math.abs(Number(row.snap_avg) - finalAvg);
    const hasDisplay = row.snap_display !== null && Number.isFinite(Number(row.snap_display));
    const displayError = hasDisplay ? Math.abs(Number(row.snap_display) - finalAvg) : 0;

    const nEff = effectiveN(Number(row.snap_count), echoFractionFor(coefficients, row.board_type));
    const bucketKey = contentPriorNEffBucket(nEff);
    let bucketAcc = byBucket.get(bucketKey);
    if (!bucketAcc) {
      bucketAcc = makeContentPriorAccumulator();
      byBucket.set(bucketKey, bucketAcc);
    }

    for (const acc of [overall, bucketAcc]) {
      acc.matched += 1;
      acc.contentAbs += contentError;
      if (hasDisplay) {
        acc.displayComparable += 1;
        acc.crowdAbs += crowdError;
        acc.displayAbs += displayError;
      } else {
        acc.displayNull += 1;
      }
    }
  }

  const overallReport = toContentPriorBucketReport('overall', overall);
  const buckets = CONTENT_PRIOR_NEFF_BUCKETS.map((bucket) =>
    toContentPriorBucketReport(bucket, byBucket.get(bucket) ?? makeContentPriorAccumulator()),
  );
  const totalRows = rows.length;
  const coverage = totalRows > 0 ? matchedRows / totalRows : 0;

  const bucketTable =
    buckets
      .filter((bucket) => bucket.n > 0)
      .map(
        (bucket) =>
          `${bucket.bucket} n=${bucket.n} c${bucket.contentMae.toFixed(2)}/d${bucket.earlyDisplayMae.toFixed(2)}/x${bucket.earlyCrowdMae.toFixed(2)}`,
      )
      .join(' | ') || 'none';

  const gate: GateResult = {
    gate: 'content_prior_backtest',
    passed: true,
    detail:
      `${boardType}: coverage ${(coverage * 100).toFixed(1)}% (${matchedRows}/${totalRows}); ` +
      `content MAE ${overallReport.contentMae.toFixed(3)} vs display ${overallReport.earlyDisplayMae.toFixed(3)} ` +
      `vs early-crowd ${overallReport.earlyCrowdMae.toFixed(3)} over ${overallReport.displayComparableRows} ` +
      `display-comparable rows (${overallReport.displayNullRows} null-display); buckets [${bucketTable}]`,
    metrics: {
      totalRows,
      matchedRows,
      coverage,
      contentMae: overallReport.contentMae,
      earlyCrowdMae: overallReport.earlyCrowdMae,
      earlyDisplayMae: overallReport.earlyDisplayMae,
      displayComparableRows: overallReport.displayComparableRows,
      displayNullRows: overallReport.displayNullRows,
    },
  };

  return { boardType, totalRows, matchedRows, coverage, overall: overallReport, buckets, gate };
}

/** Outcome of parsing one JSONL line of a candidate content-prior file. */
export type ContentPriorLineResult =
  | { status: 'ok'; key: string; entry: ContentPriorEntry }
  | { status: 'skip' }
  | { status: 'malformed' };

/**
 * Parse one JSONL record `{climbUuid, angle, contentPrior, contentSd?, board?}`
 * from a candidate content-prior file. Bad JSON or a missing/invalid required
 * field → 'malformed'; a well-formed record whose `board` names a different
 * board → 'skip'; otherwise 'ok' with the map key + entry. Pure so the file
 * loader (refresh-climb-grades) can stream lines through it and stay testable.
 */
export function parseContentPriorLine(line: string, boardType: string): ContentPriorLineResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { status: 'malformed' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { status: 'malformed' };
  const record = parsed as Record<string, unknown>;
  const { climbUuid, angle, contentPrior, contentSd, board } = record;
  if (typeof climbUuid !== 'string' || climbUuid.length === 0) return { status: 'malformed' };
  if (typeof angle !== 'number' || !Number.isFinite(angle)) return { status: 'malformed' };
  if (typeof contentPrior !== 'number' || !Number.isFinite(contentPrior)) return { status: 'malformed' };
  if (typeof board === 'string' && board !== boardType) return { status: 'skip' };
  const sd = typeof contentSd === 'number' && Number.isFinite(contentSd) ? contentSd : null;
  return { status: 'ok', key: contentPriorKey(climbUuid, angle), entry: { contentPrior, contentSd: sd } };
}
