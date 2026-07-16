import {
  GATE_NO_SHOCK_MAX_MOVE,
  GATE_NO_SHOCK_MIN_ASCENTS,
  combineDeherdedSignals,
  computePosteriorGrade,
  echoFractionFor,
  effectiveN,
  gradeBandForDifficulty,
  type BacktestSampleRow,
  type BacktestSummary,
  type ClimbAngleObservation,
  type DeherdedGradeSignal,
  type GradeCoefficients,
} from '../grade-model/index';
import { createRecordValidator } from './runtime-validation';

export const CONTENT_SIGNAL_MAX_MOVE = 0.5;
export const CONTENT_SIGNAL_MAX_EFFECTIVE_N = 2;
export const SHADOW_MAE_REGRESSION_TOLERANCE = 0.01;
export const SHADOW_SEGMENT_REGRESSION_TOLERANCE = 0.05;
export const SHADOW_GATE_MIN_ROWS = 100;
export const SHADOW_SEGMENT_MIN_ROWS = 50;
/**
 * Missing predictions are a no-op in shadow and can otherwise dilute a weak
 * model toward the baseline. Requiring 95% overall and per-board coverage caps
 * that dilution at 5% while tolerating a small number of extraction/key misses.
 */
export const SHADOW_MIN_ELIGIBLE_COVERAGE = 0.95;
export const SHADOW_SUPPORTED_BACKTEST_BOARDS = ['kilter', 'tension'] as const;
export const SHADOW_FINGERPRINT_MAX_BAD_RATIO = 0.01;
export const SHADOW_FINGERPRINT_MAX_SPREAD = 1;
export const CLIMB2VEC_STAGE3_MODEL_VERSION = 'climb2vec-relational-morphology-v1';

export interface ContentPriorCandidate {
  boardType: string;
  climbUuid: string;
  angle: number;
  contentPrior: number;
  contentSd: number;
  ascents?: number | null;
  difficultyAverage?: number | null;
  displayDifficulty?: number | null;
  layoutId?: number | null;
  fingerprint?: string | null;
  physicalKey?: string | null;
}

export interface ParsedContentPriorArtifactRecord {
  key: string;
  candidate: ContentPriorCandidate | null;
}

export interface ShadowMaeGate {
  gate: 'content_shadow_tail' | 'content_shadow_head';
  passed: boolean;
  n: number;
  baselineMae: number;
  shadowMae: number;
  regression: number;
  tolerance: number;
}

export interface ShadowSegmentResult {
  dimension: 'grade_band' | 'angle';
  segment: string;
  n: number;
  baselineMae: number;
  shadowMae: number;
  regression: number;
  passed: boolean;
}

export interface ShadowCoverageResult {
  gate: 'content_shadow_coverage';
  passed: boolean;
  eligible: number;
  matched: number;
  ratio: number;
  minimumRatio: number;
  byBoard: Record<string, { eligible: number; matched: number; ratio: number; passed: boolean }>;
}

export interface ShadowNoShockResult {
  gate: 'content_shadow_no_shock';
  passed: boolean;
  checked: number;
  violations: number;
  maxMove: number;
}

export interface ShadowFingerprintResult {
  gate: 'content_shadow_fingerprint_consistency';
  passed: boolean;
  groups: number;
  violations: number;
  violationRatio: number;
  maxAllowedRatio: number;
}

export interface ContentPriorShadowReport {
  passed: boolean;
  candidateRows: number;
  matchedBacktestRows: number;
  baseline: BacktestSummary;
  coverage: ShadowCoverageResult;
  tail: ShadowMaeGate;
  head: ShadowMaeGate;
  segments: ShadowSegmentResult[];
  noShock: ShadowNoShockResult;
  fingerprintConsistency: ShadowFingerprintResult;
}

interface ErrorAccumulator {
  n: number;
  baselineAbsoluteError: number;
  shadowAbsoluteError: number;
}

interface ScoredBacktestRow {
  row: BacktestSampleRow;
  baselineError: number;
  shadowError: number;
}

export function contentCandidateKey(boardType: string, climbUuid: string, angle: number): string {
  return `${boardType}\u0000${climbUuid}\u0000${angle}`;
}

/** Parse one Stage-3 artifact row; explicit unsupported tombstones carry no signal. */
export function parseContentPriorArtifactRecord(parsed: unknown, lineNumber: number): ParsedContentPriorArtifactRecord {
  const validation = createRecordValidator((message) => new Error(`Candidate line ${lineNumber}: ${message}.`));
  const record = validation.record(parsed, 'must be a JSON object');
  const boardType = validation.nonEmptyString(record, 'boardType');
  const climbUuid = validation.nonEmptyString(record, 'climbUuid');
  const angle = validation.finiteNumber(record, 'angle');
  const modelVersion = validation.nonEmptyString(record, 'modelVersion');
  if (modelVersion !== CLIMB2VEC_STAGE3_MODEL_VERSION) {
    throw new Error(
      `Candidate line ${lineNumber} has modelVersion=${modelVersion}; expected ${CLIMB2VEC_STAGE3_MODEL_VERSION}.`,
    );
  }
  if (typeof record.supported !== 'boolean') {
    throw new Error(`Candidate line ${lineNumber} must declare supported=true|false.`);
  }
  const key = contentCandidateKey(boardType, climbUuid, angle);
  if (!record.supported) {
    if (record.contentPrior !== null || record.contentSd !== null || record.embedding !== null) {
      throw new Error(`Unsupported candidate line ${lineNumber} must carry null model outputs.`);
    }
    return { key, candidate: null };
  }

  const contentSd = validation.finiteNumber(record, 'contentSd');
  if (contentSd <= 0) throw new Error(`Candidate line ${lineNumber} has non-positive contentSd.`);
  return {
    key,
    candidate: {
      boardType,
      climbUuid,
      angle,
      contentPrior: validation.finiteNumber(record, 'contentPrior'),
      contentSd,
      ascents: validation.optionalFiniteNumber(record, 'ascents'),
      difficultyAverage: validation.optionalFiniteNumber(record, 'difficultyAverage'),
      displayDifficulty: validation.optionalFiniteNumber(record, 'displayDifficulty'),
      layoutId: validation.optionalFiniteNumber(record, 'layoutId'),
      fingerprint: validation.optionalString(record, 'fingerprint'),
      physicalKey: validation.optionalString(record, 'physicalKey'),
    },
  };
}

function finiteNumber(numberValue: number | null | undefined): numberValue is number {
  return numberValue !== null && numberValue !== undefined && Number.isFinite(numberValue);
}

function clamp(numberValue: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, numberValue));
}

export function contentSignalEffectiveWeight(contentSd: number): number | null {
  if (!Number.isFinite(contentSd) || contentSd <= 0) return null;
  return Math.min(CONTENT_SIGNAL_MAX_EFFECTIVE_N, 1 / (contentSd * contentSd));
}

/**
 * Add the content estimate to an observation as one capped, precision-weighted
 * signal. The observation still carries its original ascent count into the
 * posterior, so this does not manufacture crowd evidence.
 *
 * A no-crowd target receives the existing contentPrior/contentSd fields. A
 * no-crowd sibling remains untouched: manufacturing an ascent would overstate
 * weak content weights because effectiveN floors every positive count at one,
 * and production does not treat content estimates as crowd observations.
 */
export function applyContentSignalToObservation(
  observation: ClimbAngleObservation,
  candidate: ContentPriorCandidate | undefined,
  coefficients: GradeCoefficients,
  asSibling = false,
): ClimbAngleObservation {
  if (!candidate || !Number.isFinite(candidate.contentPrior)) return observation;
  const contentWeight = contentSignalEffectiveWeight(candidate.contentSd);
  if (contentWeight === null) return observation;

  if (finiteNumber(observation.difficultyAverage)) {
    const echoFraction = echoFractionFor(coefficients, observation.boardType);
    const crowdWeight = Math.max(1, effectiveN(observation.ascensionistCount, echoFraction));
    const cappedContentGrade = clamp(
      candidate.contentPrior,
      observation.difficultyAverage - CONTENT_SIGNAL_MAX_MOVE,
      observation.difficultyAverage + CONTENT_SIGNAL_MAX_MOVE,
    );
    const signals: DeherdedGradeSignal[] = [
      {
        name: 'modeled_crowd',
        grade: observation.difficultyAverage,
        standardError: null,
        weight: crowdWeight,
      },
      {
        name: 'content_prior',
        grade: cappedContentGrade,
        standardError: candidate.contentSd,
        weight: contentWeight,
      },
    ];
    const blended = combineDeherdedSignals(signals);
    return blended === null ? observation : { ...observation, difficultyAverage: blended.grade };
  }

  if (!asSibling) {
    return {
      ...observation,
      contentPrior: candidate.contentPrior,
      contentSd: candidate.contentSd,
    };
  }

  return observation;
}

function targetObservation(row: BacktestSampleRow): ClimbAngleObservation {
  return {
    boardType: row.board_type,
    climbUuid: row.climb_uuid,
    angle: Number(row.angle),
    difficultyAverage: Number(row.snap_avg),
    displayDifficulty: row.snap_display === null ? null : Number(row.snap_display),
    ascensionistCount: Number(row.snap_count),
  };
}

function siblingObservations(row: BacktestSampleRow): ClimbAngleObservation[] {
  return (row.sibling_states ?? []).map((sibling) => ({
    boardType: row.board_type,
    climbUuid: row.climb_uuid,
    angle: Number(sibling.angle),
    difficultyAverage: sibling.difficulty_average === null ? null : Number(sibling.difficulty_average),
    displayDifficulty: sibling.display_difficulty === null ? null : Number(sibling.display_difficulty),
    ascensionistCount: Number(sibling.ascensionist_count ?? 0),
  }));
}

function emptyAccumulator(): ErrorAccumulator {
  return { n: 0, baselineAbsoluteError: 0, shadowAbsoluteError: 0 };
}

function accumulateError(accumulator: ErrorAccumulator, baselineError: number, shadowError: number): ErrorAccumulator {
  accumulator.n += 1;
  accumulator.baselineAbsoluteError += baselineError;
  accumulator.shadowAbsoluteError += shadowError;
  return accumulator;
}

function maeGate(gate: ShadowMaeGate['gate'], accumulator: ErrorAccumulator): ShadowMaeGate {
  const baselineMae = accumulator.n > 0 ? accumulator.baselineAbsoluteError / accumulator.n : 0;
  const shadowMae = accumulator.n > 0 ? accumulator.shadowAbsoluteError / accumulator.n : 0;
  const regression = shadowMae - baselineMae;
  return {
    gate,
    passed: accumulator.n >= SHADOW_GATE_MIN_ROWS && regression <= SHADOW_MAE_REGRESSION_TOLERANCE + 1e-12,
    n: accumulator.n,
    baselineMae,
    shadowMae,
    regression,
    tolerance: SHADOW_MAE_REGRESSION_TOLERANCE,
  };
}

function segmentRows(scoredRows: readonly ScoredBacktestRow[]): ShadowSegmentResult[] {
  const accumulators = new Map<
    string,
    { dimension: ShadowSegmentResult['dimension']; segment: string; errors: ErrorAccumulator }
  >();

  const add = (dimension: ShadowSegmentResult['dimension'], segment: string, scoredRow: ScoredBacktestRow): void => {
    const mapKey = `${dimension}\u0000${segment}`;
    const entry = accumulators.get(mapKey) ?? { dimension, segment, errors: emptyAccumulator() };
    accumulateError(entry.errors, scoredRow.baselineError, scoredRow.shadowError);
    accumulators.set(mapKey, entry);
  };

  for (const scoredRow of scoredRows) {
    add('grade_band', gradeBandForDifficulty(Number(scoredRow.row.final_avg)), scoredRow);
    add('angle', String(scoredRow.row.angle), scoredRow);
  }

  return [...accumulators.values()]
    .filter((entry) => entry.errors.n >= SHADOW_SEGMENT_MIN_ROWS)
    .map((entry) => {
      const baselineMae = entry.errors.baselineAbsoluteError / entry.errors.n;
      const shadowMae = entry.errors.shadowAbsoluteError / entry.errors.n;
      const regression = shadowMae - baselineMae;
      return {
        dimension: entry.dimension,
        segment: entry.segment,
        n: entry.errors.n,
        baselineMae,
        shadowMae,
        regression,
        passed: regression <= SHADOW_SEGMENT_REGRESSION_TOLERANCE + 1e-12,
      };
    })
    .sort(
      (left, right) =>
        left.dimension.localeCompare(right.dimension) ||
        left.segment.localeCompare(right.segment, undefined, { numeric: true }),
    );
}

function supportedBacktestBoard(boardType: string): boolean {
  return (SHADOW_SUPPORTED_BACKTEST_BOARDS as readonly string[]).includes(boardType);
}

function candidateSuppliesSignal(candidate: ContentPriorCandidate | undefined): candidate is ContentPriorCandidate {
  return (
    candidate !== undefined &&
    Number.isFinite(candidate.contentPrior) &&
    contentSignalEffectiveWeight(candidate.contentSd) !== null
  );
}

export function evaluateShadowCoverage(
  rows: readonly BacktestSampleRow[],
  candidatesByKey: ReadonlyMap<string, ContentPriorCandidate>,
): ShadowCoverageResult {
  const boardCounts = new Map<string, { eligible: number; matched: number }>();
  let eligible = 0;
  let matched = 0;

  for (const row of rows) {
    if (!supportedBacktestBoard(row.board_type)) continue;
    eligible += 1;
    const counts = boardCounts.get(row.board_type) ?? { eligible: 0, matched: 0 };
    counts.eligible += 1;
    const candidate = candidatesByKey.get(contentCandidateKey(row.board_type, row.climb_uuid, Number(row.angle)));
    if (candidateSuppliesSignal(candidate)) {
      matched += 1;
      counts.matched += 1;
    }
    boardCounts.set(row.board_type, counts);
  }

  const byBoard: ShadowCoverageResult['byBoard'] = {};
  for (const boardType of SHADOW_SUPPORTED_BACKTEST_BOARDS) {
    const counts = boardCounts.get(boardType) ?? { eligible: 0, matched: 0 };
    const ratio = counts.eligible > 0 ? counts.matched / counts.eligible : 0;
    byBoard[boardType] = {
      ...counts,
      ratio,
      passed: counts.eligible > 0 && ratio >= SHADOW_MIN_ELIGIBLE_COVERAGE,
    };
  }
  const ratio = eligible > 0 ? matched / eligible : 0;
  return {
    gate: 'content_shadow_coverage',
    passed:
      eligible > 0 && ratio >= SHADOW_MIN_ELIGIBLE_COVERAGE && Object.values(byBoard).every((board) => board.passed),
    eligible,
    matched,
    ratio,
    minimumRatio: SHADOW_MIN_ELIGIBLE_COVERAGE,
    byBoard,
  };
}

export function evaluateShadowNoShock(
  candidates: readonly ContentPriorCandidate[],
  coefficients: GradeCoefficients,
): ShadowNoShockResult {
  const candidatesByClimb = new Map<string, ContentPriorCandidate[]>();
  for (const candidate of candidates) {
    const climbKey = `${candidate.boardType}\u0000${candidate.climbUuid}`;
    const climbCandidates = candidatesByClimb.get(climbKey) ?? [];
    climbCandidates.push(candidate);
    candidatesByClimb.set(climbKey, climbCandidates);
  }

  let checked = 0;
  let violations = 0;
  for (const candidate of candidates) {
    if (
      !finiteNumber(candidate.ascents) ||
      candidate.ascents < GATE_NO_SHOCK_MIN_ASCENTS ||
      !finiteNumber(candidate.difficultyAverage)
    ) {
      continue;
    }
    checked += 1;
    const target: ClimbAngleObservation = {
      boardType: candidate.boardType,
      climbUuid: candidate.climbUuid,
      angle: candidate.angle,
      difficultyAverage: candidate.difficultyAverage,
      displayDifficulty: finiteNumber(candidate.displayDifficulty) ? candidate.displayDifficulty : null,
      ascensionistCount: candidate.ascents,
    };
    const targetWithContent = applyContentSignalToObservation(target, candidate, coefficients);
    const siblings = (candidatesByClimb.get(`${candidate.boardType}\u0000${candidate.climbUuid}`) ?? [])
      .filter(
        (siblingCandidate) =>
          siblingCandidate.angle !== candidate.angle &&
          finiteNumber(siblingCandidate.difficultyAverage) &&
          finiteNumber(siblingCandidate.ascents),
      )
      .map((siblingCandidate) => {
        const sibling: ClimbAngleObservation = {
          boardType: siblingCandidate.boardType,
          climbUuid: siblingCandidate.climbUuid,
          angle: siblingCandidate.angle,
          difficultyAverage: siblingCandidate.difficultyAverage ?? null,
          displayDifficulty: finiteNumber(siblingCandidate.displayDifficulty)
            ? siblingCandidate.displayDifficulty
            : null,
          ascensionistCount: siblingCandidate.ascents ?? 0,
        };
        return applyContentSignalToObservation(sibling, siblingCandidate, coefficients, true);
      });
    const posterior = computePosteriorGrade(targetWithContent, siblings, coefficients);
    if (
      posterior.localGrade !== null &&
      Math.abs(posterior.localGrade - candidate.difficultyAverage) > GATE_NO_SHOCK_MAX_MOVE + 1e-6
    ) {
      violations += 1;
    }
  }

  return {
    gate: 'content_shadow_no_shock',
    passed: checked > 0 && violations === 0,
    checked,
    violations,
    maxMove: GATE_NO_SHOCK_MAX_MOVE,
  };
}

export function evaluateShadowFingerprintConsistency(
  candidates: readonly ContentPriorCandidate[],
): ShadowFingerprintResult {
  const groups = new Map<string, ContentPriorCandidate[]>();
  for (const candidate of candidates) {
    const identity =
      candidate.physicalKey ??
      (candidate.fingerprint ? `${candidate.layoutId ?? 'unknown'}\u0000${candidate.fingerprint}` : null);
    if (identity === null) continue;
    const groupKey = `${candidate.boardType}\u0000${identity}\u0000${candidate.angle}`;
    const group = groups.get(groupKey) ?? [];
    group.push(candidate);
    groups.set(groupKey, group);
  }

  let checkedGroups = 0;
  let violations = 0;
  for (const group of groups.values()) {
    if (new Set(group.map((candidate) => candidate.climbUuid)).size < 2) continue;
    const predictions = group.map((candidate) => candidate.contentPrior).filter(Number.isFinite);
    if (predictions.length < 2) continue;
    checkedGroups += 1;
    const spread = Math.max(...predictions) - Math.min(...predictions);
    if (spread > SHADOW_FINGERPRINT_MAX_SPREAD) violations += 1;
  }
  const violationRatio = checkedGroups > 0 ? violations / checkedGroups : 0;
  return {
    gate: 'content_shadow_fingerprint_consistency',
    passed: checkedGroups > 0 && violationRatio <= SHADOW_FINGERPRINT_MAX_BAD_RATIO,
    groups: checkedGroups,
    violations,
    violationRatio,
    maxAllowedRatio: SHADOW_FINGERPRINT_MAX_BAD_RATIO,
  };
}

export function evaluateContentPriorShadow(
  rows: readonly BacktestSampleRow[],
  candidates: readonly ContentPriorCandidate[],
  coefficients: GradeCoefficients,
  baseline: BacktestSummary,
): ContentPriorShadowReport {
  const candidatesByKey = new Map(
    candidates.map((candidate) => [
      contentCandidateKey(candidate.boardType, candidate.climbUuid, candidate.angle),
      candidate,
    ]),
  );
  const coverage = evaluateShadowCoverage(rows, candidatesByKey);
  const tailErrors = emptyAccumulator();
  const headErrors = emptyAccumulator();
  const scoredRows: ScoredBacktestRow[] = [];

  for (const row of rows) {
    if (!supportedBacktestBoard(row.board_type)) continue;
    const candidate = candidatesByKey.get(contentCandidateKey(row.board_type, row.climb_uuid, Number(row.angle)));
    if (!candidateSuppliesSignal(candidate)) continue;

    const target = targetObservation(row);
    const siblings = siblingObservations(row);
    const baselinePosterior = computePosteriorGrade(target, siblings, coefficients);
    const shadowTarget = applyContentSignalToObservation(target, candidate, coefficients);
    const shadowSiblings = siblings.map((sibling) =>
      applyContentSignalToObservation(
        sibling,
        candidatesByKey.get(contentCandidateKey(sibling.boardType, sibling.climbUuid, sibling.angle)),
        coefficients,
        true,
      ),
    );
    const shadowPosterior = computePosteriorGrade(shadowTarget, shadowSiblings, coefficients);
    if (baselinePosterior.localGrade === null || shadowPosterior.localGrade === null) continue;

    const truth = Number(row.final_avg);
    const baselineError = Math.abs(baselinePosterior.localGrade - truth);
    const shadowError = Math.abs(shadowPosterior.localGrade - truth);
    const hasSiblingEvidence = siblings.some(
      (sibling) => sibling.difficultyAverage !== null && sibling.ascensionistCount > 0,
    );
    accumulateError(hasSiblingEvidence ? tailErrors : headErrors, baselineError, shadowError);
    scoredRows.push({ row, baselineError, shadowError });
  }

  const tail = maeGate('content_shadow_tail', tailErrors);
  const head = maeGate('content_shadow_head', headErrors);
  const segments = segmentRows(scoredRows);
  const noShock = evaluateShadowNoShock(candidates, coefficients);
  const fingerprintConsistency = evaluateShadowFingerprintConsistency(candidates);
  const passed =
    coverage.passed &&
    tail.passed &&
    head.passed &&
    segments.every((segment) => segment.passed) &&
    noShock.passed &&
    fingerprintConsistency.passed;

  return {
    passed,
    candidateRows: candidates.length,
    matchedBacktestRows: scoredRows.length,
    baseline,
    coverage,
    tail,
    head,
    segments,
    noShock,
    fingerprintConsistency,
  };
}
