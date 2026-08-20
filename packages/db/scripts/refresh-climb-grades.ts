/**
 * Nightly Boardsesh grade refresh.
 *
 *   1. Refit coefficients if the frozen set is older than a week (echo
 *      fraction λ, σ_within, angle surface, τ², Kilter↔Tension offset) —
 *      otherwise reuse the frozen set so grades can't wander on hyperparameter
 *      noise between refits.
 *   2. Run the validation gates (history backtest, cross-board residual,
 *      offset stability, no-shock, fingerprint consistency). Any blocking gate
 *      failing aborts the run before a single grade row is written.
 *   3. Recompute board_climb_grades for every listed, non-draft climb+angle on
 *      boards with a crowd mean (MoonBoard is deliberately excluded — its feed
 *      has no crowd signal; the UI explains instead). Publish hysteresis keeps
 *      surfaced grades stable.
 *
 * Model spec and the reasoning behind every threshold: docs/boardsesh-grade.md.
 *
 * Run locally: `vp run db:refresh-climb-grades --`
 * Flags: --refit-coefficients (force a refit), --dry-run (gates + stats only),
 * --validate-only (read-only gates report, works without the grade tables),
 * --allow-empty-backtest (dev DBs without stats history: skip the backtest
 * instead of blocking — never use in prod).
 */
import { sql } from 'drizzle-orm';
import { ANGLES } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';
import { createScriptDb } from './db-connection.js';
import { boardClimbGrades, boardGradeCoefficients } from '../src/schema/app/climb-grades.js';
import {
  ANCHOR_BOARD,
  CROWD_MEAN_BOARDS,
  GRADE_MODEL_VERSION,
  OFFSET_LOO_MAX_DELTA,
  applyIsotonicAngleConstraint,
  type AngleGradeRow,
  applyDisplayDeltaHygiene,
  buildAngleSurfaceSql,
  buildBacktestSampleSql,
  buildBehaviorEvidence,
  buildBehaviorSampleSql,
  buildBoardOffsetSampleSql,
  buildEchoRatesSql,
  buildHonestyCheckSql,
  buildMoonBridgeSampleSql,
  buildRaterEvidence,
  buildRaterSampleSql,
  buildSigmaWithinSql,
  buildProjectedAngleObservations,
  buildTauSampleSql,
  buildTensionBenchmarkHoldoutSql,
  buildZeroEvidenceSampleSql,
  computePosteriorGrade,
  createDisplayDeltaHygieneStats,
  deherdCrowdMean,
  estimateAngleSurface,
  estimateBehaviorModels,
  estimateBoardOffsets,
  estimateEchoFractions,
  estimateRaterModels,
  evaluateMoonBridgeReadiness,
  estimateSigmaWithin,
  estimateTauSquared,
  evaluateBacktest,
  evaluateDisplayDeltaHygiene,
  evaluateFingerprintGate,
  evaluateTensionBenchmarkHoldout,
  evaluateZeroEvidenceProjection,
  echoFractionFor,
  foldCoefficientRows,
  effectiveN,
  evaluateResidualGapGate,
  mergeDisplayDeltaHygieneStats,
  moonBridgeReadinessGate,
  recordDisplayDeltaHygiene,
  shouldPublish,
  GATE_NO_SHOCK_MAX_MOVE,
  GATE_NO_SHOCK_MIN_ASCENTS,
  GATE_ZERO_EVIDENCE_MIN_ROWS,
  STAGE2_BEHAVIOR_MAX_EFFECTIVE_N,
  STAGE2_BEHAVIOR_MAX_MOVE,
  STAGE2_DEECHO_MAX_MOVE,
  STAGE2_RATER_MAX_EFFECTIVE_N,
  STAGE2_RATER_MAX_MOVE,
  type AngleSurfaceRow,
  type BacktestSampleRow,
  type BehaviorSampleRow,
  type BoardOffsetSampleRow,
  type ConfidenceTier,
  type ClimbAngleObservation,
  type EchoRateRow,
  type DisplayDeltaHygieneStats,
  type GateResult,
  type GradeCoefficients,
  type MoonBridgeSampleRow,
  type RaterSampleRow,
  type SigmaWithinRow,
  type Stage2Evidence,
  type Stage2EvidenceMap,
  type TensionBenchmarkHoldoutRow,
  type TensionBenchmarkPrediction,
  type TauSampleRow,
} from '../src/queries/grade-model/index.js';
import { rowsOf } from '../src/queries/util/rows.js';

const COEFF_MAX_AGE_DAYS = 7;
const BACKTEST_SAMPLE_LIMIT = 20000;
const READ_PAGE_ROWS = 20000;
const UPSERT_BATCH = 500;
const REFRESH_KEY_BATCH = 5000;

type Db = ReturnType<typeof createScriptDb>['db'];
type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];
type DbWriter = Pick<Db, 'execute' | 'insert'> | Pick<DbTransaction, 'execute' | 'insert'>;

interface CoefficientRow {
  coeff_version: string;
  kind: string;
  key: string;
  payload: unknown;
}

interface PendingCoefficientRow {
  kind: string;
  key: string;
  payload: unknown;
}

function buildCoefficientRows(coefficients: GradeCoefficients): PendingCoefficientRow[] {
  return [
    ...Object.entries(coefficients.echoFraction).map(([board, lambda]) => ({
      kind: 'echo_fraction',
      key: board,
      payload: { lambda },
    })),
    ...Object.entries(coefficients.sigmaWithin).map(([board, payload]) => ({
      kind: 'sigma_within',
      key: board,
      payload,
    })),
    ...Object.entries(coefficients.tauSquared).map(([board, payload]) => ({
      kind: 'tau_squared',
      key: board,
      payload,
    })),
    ...Object.entries(coefficients.angleOffset).map(([board, payload]) => ({
      kind: 'angle_offset',
      key: board,
      payload,
    })),
    ...Object.entries(coefficients.boardOffset).map(([board, payload]) => ({
      kind: 'board_offset',
      key: board,
      payload,
    })),
    ...Object.entries(coefficients.raterModel).map(([board, payload]) => ({
      kind: 'rater_model',
      key: board,
      payload,
    })),
    ...Object.entries(coefficients.behaviorModel).map(([board, payload]) => ({
      kind: 'behavior_model',
      key: board,
      payload,
    })),
    ...Object.entries(coefficients.bridgeReadiness).map(([board, payload]) => ({
      kind: 'bridge_readiness',
      key: board,
      payload,
    })),
  ];
}

async function persistCoefficients(db: DbWriter, coefficients: GradeCoefficients): Promise<void> {
  for (const row of buildCoefficientRows(coefficients)) {
    await db
      .insert(boardGradeCoefficients)
      .values({
        coeffVersion: coefficients.coeffVersion,
        kind: row.kind,
        key: row.key,
        payload: row.payload,
      })
      .onConflictDoUpdate({
        target: [boardGradeCoefficients.coeffVersion, boardGradeCoefficients.kind, boardGradeCoefficients.key],
        set: { payload: row.payload },
      });
  }
}

async function loadFrozenCoefficients(db: Db): Promise<GradeCoefficients | null> {
  const latest = rowsOf<{ coeff_version: string; created_at: string }>(
    await db.execute(sql`
      SELECT coeff_version, MAX(created_at) AS created_at
      FROM board_grade_coefficients
      WHERE kind <> 'gate_results'
      GROUP BY coeff_version
      ORDER BY MAX(created_at) DESC
      LIMIT 1
    `),
  );
  if (latest.length === 0) return null;
  const ageMs = Date.now() - new Date(latest[0].created_at).getTime();
  if (ageMs > COEFF_MAX_AGE_DAYS * 24 * 3600 * 1000) return null;

  const rows = rowsOf<CoefficientRow>(
    await db.execute(
      sql`SELECT coeff_version, kind, key, payload FROM board_grade_coefficients WHERE coeff_version = ${latest[0].coeff_version}`,
    ),
  );
  // Payload-shape-by-kind knowledge lives next to the model rather than in this
  // script, so a reader of `board_grade_coefficients` doesn't have to restate it.
  return foldCoefficientRows(latest[0].coeff_version, rows);
}

async function refitCoefficients(
  db: Db,
  options: { persist: boolean } = { persist: true },
): Promise<GradeCoefficients> {
  console.log('[grades] refitting coefficients…');
  const coeffVersion = new Date().toISOString();
  await db.execute(sql`SET max_parallel_workers_per_gather = 0`);

  const echoRows = rowsOf<EchoRateRow>(await db.execute(buildEchoRatesSql()));
  const echoFraction = estimateEchoFractions(echoRows);

  const sigmaRows = rowsOf<SigmaWithinRow>(await db.execute(buildSigmaWithinSql()));
  const sigmaWithin = estimateSigmaWithin(sigmaRows);

  const angleRows = rowsOf<AngleSurfaceRow>(await db.execute(buildAngleSurfaceSql()));
  const angleOffset = estimateAngleSurface(angleRows);

  const tauRows = rowsOf<TauSampleRow>(await db.execute(buildTauSampleSql()));
  const tauSquared = estimateTauSquared(tauRows, angleOffset);

  const offsetRows = rowsOf<BoardOffsetSampleRow>(await db.execute(buildBoardOffsetSampleSql()));
  const { kilter } = estimateBoardOffsets(offsetRows);

  const raterRows = rowsOf<RaterSampleRow>(
    await db.execute(buildRaterSampleSql({ excludeTensionBenchmarkHoldout: true })),
  );
  const raterModel = estimateRaterModels(raterRows);

  const behaviorRows = rowsOf<BehaviorSampleRow>(
    await db.execute(buildBehaviorSampleSql({ excludeTensionBenchmarkHoldout: true })),
  );
  const behaviorModel = estimateBehaviorModels(behaviorRows);

  const moonBridgeRows = rowsOf<MoonBridgeSampleRow>(await db.execute(buildMoonBridgeSampleSql()));
  const moonBridgeReadiness = evaluateMoonBridgeReadiness(moonBridgeRows);

  const coefficients: GradeCoefficients = {
    coeffVersion,
    echoFraction,
    sigmaWithin,
    tauSquared,
    angleOffset,
    boardOffset: { [ANCHOR_BOARD]: { offset: 0, sd: 0, users: 0, looMaxDelta: 0 } },
    raterModel,
    behaviorModel,
    bridgeReadiness: { moonboard: moonBridgeReadiness },
  };
  if (kilter && kilter.looMaxDelta <= OFFSET_LOO_MAX_DELTA) {
    coefficients.boardOffset.kilter = kilter;
  } else if (kilter) {
    console.warn(
      `[grades] Kilter offset unstable (LOO max delta ${kilter.looMaxDelta.toFixed(2)} > ${OFFSET_LOO_MAX_DELTA}) — universal grades for Kilter withheld this refit.`,
    );
  } else {
    console.warn('[grades] too few shared Kilter/Tension users — universal grades for Kilter withheld.');
  }

  if (!options.persist) {
    console.log(`[grades] coefficients ${coeffVersion} (in-memory only): λ=${JSON.stringify(echoFraction)}`);
    return coefficients;
  }
  await db.transaction(async (tx) => {
    await persistCoefficients(tx, coefficients);
  });
  console.log(
    `[grades] coefficients ${coeffVersion}: λ=${JSON.stringify(echoFraction)}, boards with angle surface: ${Object.keys(angleOffset).join(', ') || 'none'}`,
  );
  return coefficients;
}

interface StatsRow {
  climb_uuid: string;
  layout_id: number;
  angle: number;
  difficulty_average: number | null;
  display_difficulty: number | null;
  ascensionist_count: number;
  hold_fingerprint: string | null;
}

interface ComputedRow {
  boardType: string;
  climbUuid: string;
  layoutId: number;
  angle: number;
  localGrade: number | null;
  universalGrade: number | null;
  gradeLow: number | null;
  gradeHigh: number | null;
  confidence: ConfidenceTier;
  ascensionistCount: number;
  postSd: number | null;
  /** Climb2Vec content-model grade estimate for this row (persisted to content_prior); null when unscored. */
  contentPrior: number | null;
  rawAverage: number | null;
  holdFingerprint: string | null;
}

interface ContentPriorEntry {
  contentPrior: number;
  contentSd: number | null;
}

function contentPriorKey(climbUuid: string, angle: number): string {
  return `${climbUuid} ${angle}`;
}

/** Load the Climb2Vec content-model estimates (board_climb_embeddings) for a board. */
async function loadContentPriors(db: Db, boardType: string): Promise<Map<string, ContentPriorEntry>> {
  const rows = rowsOf<{ climb_uuid: string; angle: number; content_prior: number | null; content_sd: number | null }>(
    await db.execute(sql`
      SELECT climb_uuid, angle, content_prior, content_sd
      FROM board_climb_embeddings
      WHERE board_type = ${boardType} AND content_prior IS NOT NULL
    `),
  );
  const map = new Map<string, ContentPriorEntry>();
  for (const row of rows) {
    map.set(contentPriorKey(row.climb_uuid, Number(row.angle)), {
      contentPrior: Number(row.content_prior),
      contentSd: row.content_sd === null ? null : Number(row.content_sd),
    });
  }
  return map;
}

interface PooledAngleEvidence {
  angle: number;
  pooledAverage: number | null;
  pooledCount: number;
  pooledDisplay: number | null;
}

interface PooledFingerprintEvidence {
  layoutId: number;
  holdFingerprint: string;
  climbUuids: string[];
  angles: PooledAngleEvidence[];
}

async function loadStage2Evidence(db: Db, coefficients: GradeCoefficients): Promise<Stage2EvidenceMap> {
  await db.execute(sql`SET max_parallel_workers_per_gather = 0`);
  const raterTrainingRows = rowsOf<RaterSampleRow>(
    await db.execute(buildRaterSampleSql({ excludeTensionBenchmarkHoldout: true })),
  );
  const raterPredictionRows = rowsOf<RaterSampleRow>(
    await db.execute(buildRaterSampleSql({ excludeTensionBenchmarkHoldout: false })),
  );
  const raterEvidence = buildRaterEvidence(raterPredictionRows, coefficients.raterModel, raterTrainingRows);
  const behaviorTrainingRows = rowsOf<BehaviorSampleRow>(
    await db.execute(buildBehaviorSampleSql({ excludeTensionBenchmarkHoldout: true })),
  );
  const behaviorPredictionRows = rowsOf<BehaviorSampleRow>(
    await db.execute(buildBehaviorSampleSql({ excludeTensionBenchmarkHoldout: false })),
  );
  return buildBehaviorEvidence(behaviorPredictionRows, coefficients.behaviorModel, raterEvidence, behaviorTrainingRows);
}

function clampDelta(delta: number, maxAbsDelta: number): number {
  return Math.min(maxAbsDelta, Math.max(-maxAbsDelta, delta));
}

function finiteNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

function applyCappedStage2Evidence(
  observation: ClimbAngleObservation,
  coefficients: GradeCoefficients,
  evidence: Stage2Evidence | undefined,
): ClimbAngleObservation {
  if (!finiteNumber(observation.difficultyAverage)) return observation;

  const echoFraction = echoFractionFor(coefficients, observation.boardType);
  const rawEffectiveN = effectiveN(observation.ascensionistCount, echoFraction);
  const deherded = deherdCrowdMean(
    {
      observedMean: observation.difficultyAverage,
      displayGrade: observation.displayDifficulty,
      echoFraction,
      independentWeight: rawEffectiveN,
    },
    { maxMoveFromObserved: STAGE2_DEECHO_MAX_MOVE },
  );

  const signals: Array<{ grade: number; weight: number }> = [
    {
      grade: finiteNumber(deherded.grade) ? deherded.grade : observation.difficultyAverage,
      weight: Math.max(1, rawEffectiveN),
    },
  ];

  if (evidence?.raterMean !== null && evidence?.raterMean !== undefined && evidence.raterEffectiveN > 0) {
    signals.push({
      grade:
        observation.difficultyAverage +
        clampDelta(evidence.raterMean - observation.difficultyAverage, STAGE2_RATER_MAX_MOVE),
      weight: Math.min(STAGE2_RATER_MAX_EFFECTIVE_N, evidence.raterEffectiveN),
    });
  }

  if (evidence?.behaviorMean !== null && evidence?.behaviorMean !== undefined && evidence.behaviorEffectiveN > 0) {
    signals.push({
      grade:
        observation.difficultyAverage +
        clampDelta(evidence.behaviorMean - observation.difficultyAverage, STAGE2_BEHAVIOR_MAX_MOVE),
      weight: Math.min(STAGE2_BEHAVIOR_MAX_EFFECTIVE_N, evidence.behaviorEffectiveN),
    });
  }

  const weightTotal = signals.reduce((total, signal) => total + signal.weight, 0);
  const modeledAverage =
    weightTotal > 0
      ? signals.reduce((total, signal) => total + signal.grade * signal.weight, 0) / weightTotal
      : observation.difficultyAverage;

  return { ...observation, difficultyAverage: modeledAverage };
}

function withoutStage2Coefficients(coefficients: GradeCoefficients): GradeCoefficients {
  return {
    ...coefficients,
    raterModel: {},
    behaviorModel: {},
    bridgeReadiness: {},
  };
}

function fingerprintGroupKey(layoutId: number, holdFingerprint: string): string {
  return `${layoutId}\u0000${holdFingerprint}`;
}

function pooledStage2Evidence(
  boardType: string,
  pooled: PooledFingerprintEvidence | undefined,
  angle: number,
  stage2Evidence: Stage2EvidenceMap,
): Stage2Evidence | undefined {
  if (!pooled) return undefined;
  let raterWeighted = 0;
  let raterEffectiveN = 0;
  let behaviorWeighted = 0;
  let behaviorEffectiveN = 0;
  for (const climbUuid of pooled.climbUuids) {
    const evidence = stage2Evidence.get(`${boardType}\u0000${climbUuid}\u0000${angle}`);
    if (evidence?.raterMean !== null && evidence?.raterMean !== undefined && evidence.raterEffectiveN > 0) {
      raterWeighted += evidence.raterMean * evidence.raterEffectiveN;
      raterEffectiveN += evidence.raterEffectiveN;
    }
    if (evidence?.behaviorMean !== null && evidence?.behaviorMean !== undefined && evidence.behaviorEffectiveN > 0) {
      behaviorWeighted += evidence.behaviorMean * evidence.behaviorEffectiveN;
      behaviorEffectiveN += evidence.behaviorEffectiveN;
    }
  }
  if (raterEffectiveN === 0 && behaviorEffectiveN === 0) return undefined;
  return {
    raterMean: raterEffectiveN > 0 ? raterWeighted / raterEffectiveN : null,
    raterEffectiveN,
    behaviorMean: behaviorEffectiveN > 0 ? behaviorWeighted / behaviorEffectiveN : null,
    behaviorEffectiveN,
  };
}

/**
 * Duplicate climbs (same layout_id + hold_fingerprint = same physical problem
 * under different UUIDs) must not split their crowd evidence — measured on
 * prod, 44% of Kilter duplicate groups disagreed by >1 grade before pooling. A
 * fingerprint group is treated as ONE climb: per angle an n-weighted pooled
 * mean/count and averaged display, and every member uses the group's full angle
 * set as its cross-angle evidence — so members produce identical posteriors by
 * construction.
 */
async function loadPooledFingerprintEvidence(
  db: Db,
  boardType: string,
): Promise<Map<string, PooledFingerprintEvidence>> {
  // Two-step shape on purpose: finding duplicate fingerprints over the small
  // board_climbs table first keeps the stats join tiny — the single-pass
  // GROUP BY ... HAVING COUNT(DISTINCT) variant exhausted shared memory on prod.
  const rows = rowsOf<{
    layout_id: number;
    hold_fingerprint: string;
    angle: number;
    pooled_average: number | null;
    pooled_count: number;
    pooled_display: number | null;
    climb_uuids: string[];
  }>(
    await db.execute(sql`
      WITH duplicate_fingerprints AS (
        SELECT layout_id, hold_fingerprint
        FROM board_climbs
        WHERE board_type = ${boardType}
          AND hold_fingerprint IS NOT NULL
          AND is_listed = true
          AND COALESCE(is_draft, false) = false
        GROUP BY layout_id, hold_fingerprint
        HAVING COUNT(*) >= 2
      )
      SELECT bc.layout_id, bc.hold_fingerprint, s.angle,
             SUM(s.difficulty_average * s.ascensionist_count) FILTER (WHERE s.difficulty_average IS NOT NULL AND s.ascensionist_count > 0)
               / NULLIF(SUM(s.ascensionist_count) FILTER (WHERE s.difficulty_average IS NOT NULL AND s.ascensionist_count > 0), 0)
               AS pooled_average,
             COALESCE(SUM(s.ascensionist_count), 0)::int AS pooled_count,
             AVG(s.display_difficulty) AS pooled_display,
             ARRAY_AGG(DISTINCT bc.uuid) AS climb_uuids
      FROM duplicate_fingerprints df
      JOIN board_climbs bc
        ON bc.layout_id = df.layout_id
       AND bc.hold_fingerprint = df.hold_fingerprint
       AND bc.board_type = ${boardType}
      JOIN board_climb_stats s ON s.board_type = bc.board_type AND s.climb_uuid = bc.uuid
      WHERE bc.is_listed = true AND COALESCE(bc.is_draft, false) = false
      GROUP BY bc.layout_id, bc.hold_fingerprint, s.angle
    `),
  );
  const pooled = new Map<string, PooledFingerprintEvidence>();
  for (const row of rows) {
    const key = fingerprintGroupKey(Number(row.layout_id), row.hold_fingerprint);
    const group = pooled.get(key) ?? {
      layoutId: Number(row.layout_id),
      holdFingerprint: row.hold_fingerprint,
      climbUuids: [],
      angles: [],
    };
    group.angles.push({
      angle: Number(row.angle),
      pooledAverage: row.pooled_average === null ? null : Number(row.pooled_average),
      pooledCount: Number(row.pooled_count),
      pooledDisplay: row.pooled_display === null ? null : Number(row.pooled_display),
    });
    group.climbUuids = Array.from(new Set([...group.climbUuids, ...row.climb_uuids]));
    pooled.set(key, group);
  }
  return pooled;
}

/** Stream one board's listed, non-draft climb+angle stats, grouped by climb. */
async function computeBoard(
  db: Db,
  boardType: string,
  coefficients: GradeCoefficients,
  stage2Evidence: Stage2EvidenceMap = new Map(),
  options: {
    applyStage2?: boolean;
    contentPriors?: Map<string, ContentPriorEntry>;
    /**
     * Manufacture zero-evidence rows for the angles a climb has no stats at
     * (see cross-angle-estimate.ts). Off for the Stage-1 baseline pass, whose
     * only consumer is the Tension benchmark holdout — benchmarks are real
     * angles, so projections there would be computed and thrown away.
     */
    projectUnclimbedAngles?: boolean;
  } = { applyStage2: true },
): Promise<{
  computed: ComputedRow[];
  isotonicStats: { movedRows: number; residualInversions: number };
  displayDeltaHygieneStats: DisplayDeltaHygieneStats;
  projectedRows: number;
}> {
  const pooledEvidence = await loadPooledFingerprintEvidence(db, boardType);
  // MoonBoard can't reach this (the caller only walks CROWD_MEAN_BOARDS) and
  // `buildProjectedAngleObservations` refuses it a second time anyway.
  const boardAngles =
    options.projectUnclimbedAngles === false ? [] : (ANGLES[boardType as BoardName] ?? ([] as readonly number[]));
  const contentPriors = options.contentPriors ?? new Map<string, ContentPriorEntry>();
  const contentFor = (climbUuid: string, angle: number): { contentPrior: number | null; contentSd: number | null } => {
    const entry = contentPriors.get(contentPriorKey(climbUuid, angle));
    return { contentPrior: entry?.contentPrior ?? null, contentSd: entry?.contentSd ?? null };
  };
  const computed: ComputedRow[] = [];
  const isotonicStats = { movedRows: 0, residualInversions: 0 };
  const displayDeltaHygieneStats = createDisplayDeltaHygieneStats();
  let projectedRows = 0;
  let lastClimbUuid = '';
  for (;;) {
    const rows = rowsOf<StatsRow>(
      await db.execute(sql`
        SELECT s.climb_uuid, bc.layout_id, s.angle, s.difficulty_average, s.display_difficulty,
               COALESCE(s.ascensionist_count, 0)::int AS ascensionist_count,
               bc.hold_fingerprint
        FROM board_climb_stats s
        JOIN board_climbs bc ON bc.board_type = s.board_type AND bc.uuid = s.climb_uuid
        WHERE s.board_type = ${boardType}
          AND bc.is_listed = true
          AND COALESCE(bc.is_draft, false) = false
          AND s.climb_uuid > ${lastClimbUuid}
        ORDER BY s.climb_uuid, s.angle
        LIMIT ${READ_PAGE_ROWS}
      `),
    );
    if (rows.length === 0) break;
    // Keep whole climb groups: drop the trailing (possibly split) climb unless
    // this is the final page.
    const isFinalPage = rows.length < READ_PAGE_ROWS;
    const boundaryUuid = rows[rows.length - 1].climb_uuid;
    const usable = isFinalPage ? rows : rows.filter((row) => row.climb_uuid !== boundaryUuid);
    // A single climb larger than a page can't happen (angles ≤ ~20), but guard anyway.
    const effective = usable.length > 0 ? usable : rows;

    let group: StatsRow[] = [];
    const flushGroup = () => {
      if (group.length === 0) return;
      // Duplicated fingerprint → the whole group's pooled angle set stands in
      // for this climb's own rows (same physical problem, shared evidence).
      const fingerprintEvidence = group[0].hold_fingerprint
        ? pooledEvidence.get(fingerprintGroupKey(Number(group[0].layout_id), group[0].hold_fingerprint))
        : undefined;
      const rawObservations: ClimbAngleObservation[] = fingerprintEvidence
        ? fingerprintEvidence.angles.map((pooled) => ({
            boardType,
            climbUuid: group[0].climb_uuid,
            angle: pooled.angle,
            difficultyAverage: pooled.pooledAverage,
            displayDifficulty: pooled.pooledDisplay,
            ascensionistCount: pooled.pooledCount,
            ...contentFor(group[0].climb_uuid, pooled.angle),
          }))
        : group.map((row) => ({
            boardType,
            climbUuid: row.climb_uuid,
            angle: row.angle,
            difficultyAverage: row.difficulty_average === null ? null : Number(row.difficulty_average),
            displayDifficulty: row.display_difficulty === null ? null : Number(row.display_difficulty),
            ascensionistCount: Number(row.ascensionist_count),
            ...contentFor(row.climb_uuid, row.angle),
          }));
      const observations = rawObservations.map((observation) =>
        options.applyStage2 === false
          ? observation
          : applyCappedStage2Evidence(
              observation,
              coefficients,
              fingerprintEvidence
                ? pooledStage2Evidence(observation.boardType, fingerprintEvidence, observation.angle, stage2Evidence)
                : stage2Evidence.get(
                    `${observation.boardType}\u0000${observation.climbUuid}\u0000${observation.angle}`,
                  ),
            ),
      );
      // Angles the board supports that this climb has no stats row at get a
      // zero-evidence observation projected from the angles it does have, so
      // they publish a `cross_angle_estimate` instead of nothing at all. They
      // are appended to the same array the posteriors are computed against:
      // `crossAnglePrior` ignores them as siblings (no crowd mean), so they
      // can't feed each other, and each is graded purely off the real angles.
      const projected = buildProjectedAngleObservations(observations, boardAngles, coefficients);
      const allObservations = [...observations, ...projected];

      // Posteriors for the full angle set first (pooled set may be wider than
      // this member's own angles), then the per-climb isotonic projection —
      // grades may not decrease as the wall gets steeper (see isotonic.ts;
      // The Enchiridion @30° > @35° was the motivating inversion).
      const rawObservationByAngle = new Map(rawObservations.map((observation) => [observation.angle, observation]));
      const angleRows: AngleGradeRow[] = allObservations.map((target) => ({
        angle: target.angle,
        posterior: computePosteriorGrade(target, allObservations, coefficients),
        observedMean: rawObservationByAngle.get(target.angle)?.difficultyAverage ?? null,
        ascensionistCount: rawObservationByAngle.get(target.angle)?.ascensionistCount ?? target.ascensionistCount,
        projectedAngle: target.projectedAngle === true,
      }));
      const { adjusted, residualInversions, movedRows } = applyIsotonicAngleConstraint(angleRows);
      isotonicStats.movedRows += movedRows;
      isotonicStats.residualInversions += residualInversions;

      // Emit one output row per angle THIS climb actually has, plus every angle
      // projected onto it. (Pooled duplicate-fingerprint members still don't
      // borrow each other's real angles — only the shared evidence behind them
      // — but they do share the projected set, which is the same by
      // construction since the pooled evidence is.)
      const ownAngles = new Set([...group.map((row) => row.angle), ...projected.map((row) => row.angle)]);
      // Grade evidence may be pooled across duplicate fingerprints, but hygiene
      // compares against this emitted row's own upstream display label.
      const ownDisplayDifficultyByAngle = new Map(
        group.map((row) => [row.angle, row.display_difficulty === null ? null : Number(row.display_difficulty)]),
      );
      for (let i = 0; i < angleRows.length; i++) {
        if (!ownAngles.has(angleRows[i].angle)) continue;
        const hygiene = applyDisplayDeltaHygiene({
          boardType,
          displayDifficulty: ownDisplayDifficultyByAngle.get(angleRows[i].angle) ?? null,
          posterior: adjusted[i],
        });
        recordDisplayDeltaHygiene(displayDeltaHygieneStats, hygiene);
        const posterior = hygiene.posterior;
        computed.push({
          boardType,
          climbUuid: group[0].climb_uuid,
          layoutId: Number(group[0].layout_id),
          angle: angleRows[i].angle,
          localGrade: posterior.localGrade,
          universalGrade: posterior.universalGrade,
          gradeLow: posterior.gradeLow,
          gradeHigh: posterior.gradeHigh,
          confidence: posterior.confidence,
          ascensionistCount: angleRows[i].ascensionistCount,
          postSd: posterior.postSd,
          contentPrior: contentFor(group[0].climb_uuid, angleRows[i].angle).contentPrior,
          rawAverage: angleRows[i].observedMean,
          holdFingerprint: group[0].hold_fingerprint,
        });
        if (angleRows[i].projectedAngle === true) projectedRows += 1;
      }
      group = [];
    };
    for (const row of effective) {
      if (group.length > 0 && group[group.length - 1].climb_uuid !== row.climb_uuid) flushGroup();
      group.push(row);
    }
    flushGroup();

    lastClimbUuid = effective[effective.length - 1].climb_uuid;
    if (isFinalPage) break;
  }
  return { computed, isotonicStats, displayDeltaHygieneStats, projectedRows };
}

/** No-shock gate evaluated in memory on the freshly computed rows. */
function evaluateNoShock(computed: ComputedRow[]): GateResult {
  let violations = 0;
  let checked = 0;
  for (const row of computed) {
    if (row.ascensionistCount < GATE_NO_SHOCK_MIN_ASCENTS || row.rawAverage === null || row.localGrade === null)
      continue;
    checked += 1;
    // 1e-6 tolerance: the blend/isotonic clamps place grades exactly ON the
    // bound, and (x + 1.0) - x can exceed 1.0 by float noise.
    if (Math.abs(row.localGrade - row.rawAverage) > GATE_NO_SHOCK_MAX_MOVE + 1e-6) violations += 1;
  }
  return {
    gate: 'no_shock',
    passed: violations === 0,
    detail: `${violations} of ${checked} established climb+angles moved > ${GATE_NO_SHOCK_MAX_MOVE} grade points`,
    metrics: { violations, checked },
  };
}

/** Fingerprint-consistency gate evaluated in memory (same physical problem must agree). */
function evaluateFingerprintConsistency(computed: ComputedRow[]): GateResult {
  const groups = new Map<string, { min: number; max: number; uuids: Set<string> }>();
  for (const row of computed) {
    if (!row.holdFingerprint || row.localGrade === null) continue;
    const key = `${row.boardType}:${row.layoutId}:${row.holdFingerprint}:${row.angle}`;
    const group = groups.get(key) ?? { min: row.localGrade, max: row.localGrade, uuids: new Set<string>() };
    group.min = Math.min(group.min, row.localGrade);
    group.max = Math.max(group.max, row.localGrade);
    group.uuids.add(row.climbUuid);
    groups.set(key, group);
  }
  let violations = 0;
  let multiGroups = 0;
  for (const group of groups.values()) {
    if (group.uuids.size < 2) continue;
    multiGroups += 1;
    if (group.max - group.min > 1.0) violations += 1;
  }
  return evaluateFingerprintGate({ violations, groups: multiGroups });
}

function computedRowKey(climbUuid: string, angle: number): string {
  return `${climbUuid}\u0000${angle}`;
}

function indexComputedRows(rows: ComputedRow[]): Map<string, ComputedRow> {
  const indexed = new Map<string, ComputedRow>();
  for (const row of rows) indexed.set(computedRowKey(row.climbUuid, row.angle), row);
  return indexed;
}

function buildBenchmarkPredictions(
  holdoutRows: TensionBenchmarkHoldoutRow[],
  stage1Computed: ComputedRow[],
  stage2Computed: ComputedRow[],
): TensionBenchmarkPrediction[] {
  const stage1ByKey = indexComputedRows(stage1Computed);
  const stage2ByKey = indexComputedRows(stage2Computed);
  return holdoutRows.map((row) => {
    const stage1 = stage1ByKey.get(computedRowKey(row.climb_uuid, Number(row.angle)));
    const stage2 = stage2ByKey.get(computedRowKey(row.climb_uuid, Number(row.angle)));
    return {
      climbUuid: row.climb_uuid,
      angle: Number(row.angle),
      displayDifficulty: Number(row.display_difficulty),
      benchmarkDifficulty: Number(row.benchmark_difficulty),
      ascensionistCount: Number(row.ascensionist_count),
      stage1Grade: stage1?.universalGrade ?? stage1?.localGrade ?? null,
      stage1Low: stage1?.gradeLow ?? null,
      stage1High: stage1?.gradeHigh ?? null,
      stage2Grade: stage2?.universalGrade ?? stage2?.localGrade ?? null,
      stage2Low: stage2?.gradeLow ?? null,
      stage2High: stage2?.gradeHigh ?? null,
    };
  });
}

function evaluateBehaviorEligibility(coefficients: GradeCoefficients): GateResult {
  let eligibleBoards = 0;
  let modeledBoards = 0;
  for (const model of Object.values(coefficients.behaviorModel)) {
    modeledBoards += 1;
    if (model.eligible) eligibleBoards += 1;
  }
  return {
    gate: 'behavior_eligibility',
    passed: true,
    detail: `${eligibleBoards} of ${modeledBoards} behavior models eligible for Stage 2 evidence`,
    metrics: { eligibleBoards, modeledBoards },
  };
}

async function upsertGrades(
  db: DbWriter,
  boardType: string,
  computed: ComputedRow[],
  coefficients: GradeCoefficients,
): Promise<{ written: number; held: number }> {
  // Previous rows drive publish hysteresis.
  const previous = new Map<string, { localGrade: number | null; universalGrade: number | null; confidence: string }>();
  const previousRows = rowsOf<{
    climb_uuid: string;
    angle: number;
    local_grade: number | null;
    universal_grade: number | null;
    confidence: string;
  }>(
    await db.execute(
      sql`SELECT climb_uuid, angle, local_grade, universal_grade, confidence FROM board_climb_grades WHERE board_type = ${boardType}`,
    ),
  );
  for (const row of previousRows) {
    previous.set(`${row.climb_uuid}:${row.angle}`, {
      localGrade: row.local_grade === null ? null : Number(row.local_grade),
      universalGrade: row.universal_grade === null ? null : Number(row.universal_grade),
      confidence: row.confidence,
    });
  }

  let written = 0;
  let held = 0;
  let batch: (typeof boardClimbGrades.$inferInsert)[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await db
      .insert(boardClimbGrades)
      .values(batch)
      .onConflictDoUpdate({
        target: [boardClimbGrades.boardType, boardClimbGrades.climbUuid, boardClimbGrades.angle],
        set: {
          localGrade: sql`EXCLUDED.local_grade`,
          universalGrade: sql`EXCLUDED.universal_grade`,
          gradeLow: sql`EXCLUDED.grade_low`,
          gradeHigh: sql`EXCLUDED.grade_high`,
          confidence: sql`EXCLUDED.confidence`,
          ascensionistCount: sql`EXCLUDED.ascensionist_count`,
          contentPrior: sql`EXCLUDED.content_prior`,
          modelVersion: sql`EXCLUDED.model_version`,
          coeffVersion: sql`EXCLUDED.coeff_version`,
          computedAt: sql`now()`,
        },
      });
    written += batch.length;
    batch = [];
  };

  // Hysteresis is CLIMB-scoped, not row-scoped: the isotonic projection keeps a
  // climb's angles mutually consistent, and holding back one angle's small
  // correction while publishing its neighbour's would put the inversion right
  // back in the published table. If ANY angle of a climb crosses the publish
  // threshold, all of that climb's angles publish together.
  const publishClimb = new Map<string, boolean>();
  for (const row of computed) {
    if (publishClimb.get(row.climbUuid)) continue;
    const posteriorLike = {
      localGrade: row.localGrade,
      universalGrade: row.universalGrade,
      gradeLow: row.gradeLow,
      gradeHigh: row.gradeHigh,
      confidence: row.confidence,
      postSd: row.postSd,
    };
    if (shouldPublish(previous.get(`${row.climbUuid}:${row.angle}`), posteriorLike)) {
      publishClimb.set(row.climbUuid, true);
    } else if (!publishClimb.has(row.climbUuid)) {
      publishClimb.set(row.climbUuid, false);
    }
  }

  for (const row of computed) {
    if (!publishClimb.get(row.climbUuid)) {
      held += 1;
      continue;
    }
    batch.push({
      boardType,
      climbUuid: row.climbUuid,
      angle: row.angle,
      localGrade: row.localGrade,
      universalGrade: row.universalGrade,
      gradeLow: row.gradeLow,
      gradeHigh: row.gradeHigh,
      confidence: row.confidence,
      ascensionistCount: row.ascensionistCount,
      contentPrior: row.contentPrior,
      modelVersion: GRADE_MODEL_VERSION,
      coeffVersion: coefficients.coeffVersion,
    });
    if (batch.length >= UPSERT_BATCH) await flush();
  }
  await flush();
  return { written, held };
}

async function createRefreshKeyTable(db: DbWriter): Promise<void> {
  await db.execute(sql`
    CREATE TEMP TABLE IF NOT EXISTS boardsesh_grade_refresh_keys (
      board_type text NOT NULL,
      climb_uuid text NOT NULL,
      angle integer NOT NULL,
      PRIMARY KEY (board_type, climb_uuid, angle)
    ) ON COMMIT DROP
  `);
  await db.execute(sql`TRUNCATE TABLE pg_temp.boardsesh_grade_refresh_keys`);
}

async function insertRefreshKeys(db: DbWriter, boardType: string, computed: ComputedRow[]): Promise<void> {
  for (let start = 0; start < computed.length; start += REFRESH_KEY_BATCH) {
    const batch = computed.slice(start, start + REFRESH_KEY_BATCH);
    const valueRows = batch.map((row) => sql`(${boardType}, ${row.climbUuid}, ${row.angle})`);
    await db.execute(sql`
      INSERT INTO pg_temp.boardsesh_grade_refresh_keys (board_type, climb_uuid, angle)
      VALUES ${sql.join(valueRows, sql`, `)}
      ON CONFLICT DO NOTHING
    `);
  }
}

async function deleteStaleGrades(db: DbWriter, boardType: string): Promise<number> {
  const rows = rowsOf<{ deleted: number }>(
    await db.execute(sql`
      WITH deleted AS (
        DELETE FROM board_climb_grades g
        WHERE g.board_type = ${boardType}
          AND NOT EXISTS (
            SELECT 1
            FROM pg_temp.boardsesh_grade_refresh_keys k
            WHERE k.board_type = g.board_type
              AND k.climb_uuid = g.climb_uuid
              AND k.angle = g.angle
          )
        RETURNING 1
      )
      SELECT COUNT(*)::int AS deleted FROM deleted
    `),
  );
  return rows[0]?.deleted ?? 0;
}

interface PublishedBoardResult {
  boardType: string;
  written: number;
  held: number;
  deleted: number;
}

async function publishPassedRun(
  db: Db,
  coefficients: GradeCoefficients,
  gates: GateResult[],
  computedByBoard: Map<string, ComputedRow[]>,
  persistCoefficientSet: boolean,
): Promise<PublishedBoardResult[]> {
  return db.transaction(async (tx) => {
    if (persistCoefficientSet) {
      await persistCoefficients(tx, coefficients);
    }
    await recordGateResults(tx, coefficients, gates);
    await createRefreshKeyTable(tx);
    for (const [boardType, computed] of computedByBoard) {
      await insertRefreshKeys(tx, boardType, computed);
    }

    const published: PublishedBoardResult[] = [];
    for (const [boardType, computed] of computedByBoard) {
      const { written, held } = await upsertGrades(tx, boardType, computed, coefficients);
      const deleted = await deleteStaleGrades(tx, boardType);
      published.push({ boardType, written, held, deleted });
    }
    return published;
  });
}

async function recordGateResults(db: DbWriter, coefficients: GradeCoefficients, gates: GateResult[]): Promise<void> {
  const runKey = new Date().toISOString();
  await db.insert(boardGradeCoefficients).values({
    coeffVersion: coefficients.coeffVersion,
    kind: 'gate_results',
    key: runKey,
    payload: { modelVersion: GRADE_MODEL_VERSION, gates },
  });
}

/**
 * Run the zero-evidence projection gate (the guard on the `cross_angle_estimate`
 * rows the widened pipeline writes). A database with too few head climbs to
 * score — the dev image, mostly — has no evidence either way, which is not a
 * model regression, so `--allow-empty-backtest` downgrades it to a skip there
 * the same way it does the history backtest. Production keeps it blocking.
 */
async function runZeroEvidenceGate(
  db: Db,
  coefficients: GradeCoefficients,
  allowEmptyBacktest: boolean,
): Promise<GateResult> {
  const rows = rowsOf<TauSampleRow>(await db.execute(buildZeroEvidenceSampleSql()));
  const gate = evaluateZeroEvidenceProjection(rows, coefficients);
  if (!gate.passed && allowEmptyBacktest && (gate.metrics.scored ?? 0) < GATE_ZERO_EVIDENCE_MIN_ROWS) {
    return {
      ...gate,
      passed: true,
      detail: `skipped: only ${gate.metrics.scored ?? 0} scorable held-out angles (--allow-empty-backtest)`,
    };
  }
  return gate;
}

function blockingGates(gates: GateResult[]): GateResult[] {
  return gates.filter((gate) => !gate.passed && gate.gate !== 'residual_paired_gap');
}

/**
 * Read-only validation against a database that may not have the grade tables
 * yet (e.g. prod before the migration lands): refit coefficients in memory,
 * run the input-side gates, compute every board, evaluate the in-memory gates,
 * and print the report. Writes nothing.
 */
async function validateOnly(db: Db, allowEmptyBacktest: boolean): Promise<void> {
  const coefficients = await refitCoefficients(db, { persist: false });
  const baselineCoefficients = withoutStage2Coefficients(coefficients);
  const stage2Evidence = await loadStage2Evidence(db, coefficients);
  const gates: GateResult[] = [];
  console.log('[grades] validate-only: running gates against live data…');
  const backtestRows = rowsOf<BacktestSampleRow>(await db.execute(buildBacktestSampleSql(BACKTEST_SAMPLE_LIMIT)));
  if (backtestRows.length === 0 && allowEmptyBacktest) {
    console.warn('[grades]   backtest SKIPPED — no stats-history sample (--allow-empty-backtest).');
    gates.push(
      {
        gate: 'tail_backtest',
        passed: true,
        detail: 'skipped: empty history sample (--allow-empty-backtest)',
        metrics: { multiN: 0 },
      },
      {
        gate: 'head_holdout',
        passed: true,
        detail: 'skipped: empty history sample (--allow-empty-backtest)',
        metrics: { singleN: 0 },
      },
    );
  } else {
    const backtest = evaluateBacktest(backtestRows, coefficients);
    gates.push(backtest.tailGate, backtest.headGate);
    console.log(
      `[grades]   tail_backtest: ${backtest.tailGate.passed ? 'PASS' : 'FAIL'} — ${backtest.tailGate.detail}`,
    );
    console.log(`[grades]   head_holdout: ${backtest.headGate.passed ? 'PASS' : 'FAIL'} — ${backtest.headGate.detail}`);
  }
  const zeroEvidenceGate = await runZeroEvidenceGate(db, coefficients, allowEmptyBacktest);
  gates.push(zeroEvidenceGate);
  console.log(
    `[grades]   zero_evidence_projection: ${zeroEvidenceGate.passed ? 'PASS' : 'FAIL'} — ${zeroEvidenceGate.detail}`,
  );
  const behaviorGate = evaluateBehaviorEligibility(coefficients);
  gates.push(behaviorGate);
  console.log(`[grades]   behavior_eligibility: ${behaviorGate.passed ? 'PASS' : 'FAIL'} — ${behaviorGate.detail}`);
  const moonReadiness = coefficients.bridgeReadiness.moonboard;
  if (moonReadiness) {
    const moonGate = moonBridgeReadinessGate(moonReadiness);
    gates.push(moonGate);
    console.log(`[grades]   moon_bridge_readiness: ${moonGate.passed ? 'PASS' : 'FAIL'} — ${moonGate.detail}`);
  }
  const kilterOffset = coefficients.boardOffset.kilter;
  if (kilterOffset) {
    const offsetRows = rowsOf<BoardOffsetSampleRow>(await db.execute(buildBoardOffsetSampleSql()));
    const residualGate = evaluateResidualGapGate(offsetRows, kilterOffset.offset);
    gates.push(residualGate);
    console.log(`[grades]   residual_paired_gap: ${residualGate.passed ? 'PASS' : 'FAIL'} — ${residualGate.detail}`);
    console.log(
      `[grades]   kilter offset ${kilterOffset.offset.toFixed(2)} ± ${kilterOffset.sd.toFixed(2)} (${kilterOffset.users} users, LOO max Δ ${kilterOffset.looMaxDelta.toFixed(3)})`,
    );
  }
  const computedByBoard = new Map<string, ComputedRow[]>();
  for (const boardType of CROWD_MEAN_BOARDS) {
    const contentPriors = await loadContentPriors(db, boardType);
    const { computed, isotonicStats, displayDeltaHygieneStats, projectedRows } = await computeBoard(
      db,
      boardType,
      coefficients,
      stage2Evidence,
      {
        contentPriors,
      },
    );
    computedByBoard.set(boardType, computed);
    const noShock = evaluateNoShock(computed);
    const fingerprint = evaluateFingerprintConsistency(computed);
    const displayDeltaHygiene = evaluateDisplayDeltaHygiene(displayDeltaHygieneStats);
    gates.push(noShock, fingerprint, displayDeltaHygiene);
    const tiers = computed.reduce<Record<string, number>>((acc, row) => {
      acc[row.confidence] = (acc[row.confidence] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `[grades]   ${boardType}: ${computed.length} rows (${projectedRows} projected), tiers=${JSON.stringify(tiers)}; isotonic moved ${isotonicStats.movedRows} rows (${isotonicStats.residualInversions} residual inversions); no_shock ${noShock.passed ? 'PASS' : 'FAIL'} (${noShock.detail}); fingerprint ${fingerprint.passed ? 'PASS' : 'FAIL'} (${fingerprint.detail}); display_delta_hygiene ${displayDeltaHygiene.passed ? 'PASS' : 'FAIL'} (${displayDeltaHygiene.detail})`,
    );
  }
  const baselineTension = await computeBoard(db, 'tension', baselineCoefficients, new Map(), {
    applyStage2: false,
    projectUnclimbedAngles: false,
  });
  const holdoutRows = rowsOf<TensionBenchmarkHoldoutRow>(await db.execute(buildTensionBenchmarkHoldoutSql()));
  const benchmarkPredictions = buildBenchmarkPredictions(
    holdoutRows,
    baselineTension.computed,
    computedByBoard.get('tension') ?? [],
  );
  const benchmarkGates = evaluateTensionBenchmarkHoldout(benchmarkPredictions);
  gates.push(...benchmarkGates);
  for (const gate of benchmarkGates) {
    console.log(`[grades]   ${gate.gate}: ${gate.passed ? 'PASS' : 'FAIL'} — ${gate.detail}`);
  }
  const blocking = blockingGates(gates);
  if (blocking.length > 0) {
    console.error(`[grades] validate-only blocking gate(s) failed: ${blocking.map((gate) => gate.gate).join(', ')}`);
    process.exitCode = 1;
  }
  console.log('[grades] validate-only done (nothing written).');
}

async function main(): Promise<void> {
  const forceRefit = process.argv.includes('--refit-coefficients');
  const dryRun = process.argv.includes('--dry-run');
  const allowEmptyBacktest = process.argv.includes('--allow-empty-backtest');
  const { db, close } = createScriptDb();
  try {
    if (process.argv.includes('--validate-only')) {
      await validateOnly(db, allowEmptyBacktest);
      return;
    }
    let coefficients = forceRefit ? null : await loadFrozenCoefficients(db);
    let persistCoefficientSet = false;
    if (!coefficients) {
      coefficients = await refitCoefficients(db, { persist: false });
      persistCoefficientSet = true;
    }
    if (!forceRefit && Object.keys(coefficients.raterModel).length === 0) {
      console.log('[grades] latest frozen coefficients do not include Stage 2 models; refitting.');
      coefficients = await refitCoefficients(db, { persist: false });
      persistCoefficientSet = true;
    }
    const baselineCoefficients = withoutStage2Coefficients(coefficients);
    const stage2Evidence = await loadStage2Evidence(db, coefficients);
    console.log(`[grades] using coefficients ${coefficients.coeffVersion} (model ${GRADE_MODEL_VERSION})`);

    const gates: GateResult[] = [];
    const zeroEvidenceGate = await runZeroEvidenceGate(db, coefficients, allowEmptyBacktest);
    gates.push(zeroEvidenceGate);
    console.log(
      `[grades]   zero_evidence_projection: ${zeroEvidenceGate.passed ? 'PASS' : 'FAIL'} — ${zeroEvidenceGate.detail}`,
    );
    const behaviorGate = evaluateBehaviorEligibility(coefficients);
    gates.push(behaviorGate);
    console.log(`[grades]   behavior_eligibility: ${behaviorGate.passed ? 'PASS' : 'FAIL'} — ${behaviorGate.detail}`);
    const moonReadiness = coefficients.bridgeReadiness.moonboard;
    if (moonReadiness) {
      const moonGate = moonBridgeReadinessGate(moonReadiness);
      gates.push(moonGate);
      console.log(`[grades]   moon_bridge_readiness: ${moonGate.passed ? 'PASS' : 'FAIL'} — ${moonGate.detail}`);
    }

    // Pre-write gates: history backtest + cross-board residual.
    console.log('[grades] running backtest gate…');
    const backtestRows = rowsOf<BacktestSampleRow>(await db.execute(buildBacktestSampleSql(BACKTEST_SAMPLE_LIMIT)));
    if (backtestRows.length === 0 && allowEmptyBacktest) {
      // Environments without stats history (e.g. the dev DB image) can't run
      // the backtest at all — that's "no evidence", not a model regression.
      // Prod keeps the strict behavior: an empty sample there means a broken
      // query and must block.
      console.warn('[grades]   backtest SKIPPED — no stats-history sample (--allow-empty-backtest).');
      gates.push(
        {
          gate: 'tail_backtest',
          passed: true,
          detail: 'skipped: empty history sample (--allow-empty-backtest)',
          metrics: { multiN: 0 },
        },
        {
          gate: 'head_holdout',
          passed: true,
          detail: 'skipped: empty history sample (--allow-empty-backtest)',
          metrics: { singleN: 0 },
        },
      );
    } else {
      const backtest = evaluateBacktest(backtestRows, coefficients);
      gates.push(backtest.tailGate, backtest.headGate);
      console.log(
        `[grades]   tail_backtest: ${backtest.tailGate.passed ? 'PASS' : 'FAIL'} — ${backtest.tailGate.detail}`,
      );
      console.log(
        `[grades]   head_holdout: ${backtest.headGate.passed ? 'PASS' : 'FAIL'} — ${backtest.headGate.detail}`,
      );
    }

    const kilterOffset = coefficients.boardOffset.kilter;
    if (kilterOffset) {
      const offsetRows = rowsOf<BoardOffsetSampleRow>(await db.execute(buildBoardOffsetSampleSql()));
      const residualGate = evaluateResidualGapGate(offsetRows, kilterOffset.offset);
      gates.push(residualGate);
      console.log(`[grades]   residual_paired_gap: ${residualGate.passed ? 'PASS' : 'FAIL'} — ${residualGate.detail}`);
      if (!residualGate.passed) {
        // A broken offset invalidates universal grades but not local ones.
        delete coefficients.boardOffset.kilter;
        console.warn('[grades] residual gate failed — Kilter universal grades withheld this run.');
      }
    }

    // Compute all boards up front so the in-memory gates see the whole run.
    const computedByBoard = new Map<string, ComputedRow[]>();
    const displayDeltaHygieneStats = createDisplayDeltaHygieneStats();
    for (const boardType of CROWD_MEAN_BOARDS) {
      console.log(`[grades] computing ${boardType}…`);
      const contentPriors = await loadContentPriors(db, boardType);
      const {
        computed,
        isotonicStats,
        displayDeltaHygieneStats: boardDisplayDeltaHygieneStats,
        projectedRows,
      } = await computeBoard(db, boardType, coefficients, stage2Evidence, { contentPriors });
      mergeDisplayDeltaHygieneStats(displayDeltaHygieneStats, boardDisplayDeltaHygieneStats);
      computedByBoard.set(boardType, computed);
      console.log(
        `[grades]   ${computed.length} climb+angle rows (${projectedRows} projected onto unclimbed angles; isotonic moved ${isotonicStats.movedRows}, ${isotonicStats.residualInversions} residual inversions; display-delta hygiene downgraded ${boardDisplayDeltaHygieneStats.downgradedRows})`,
      );
    }
    const allComputed = [...computedByBoard.values()].flat();
    const noShockGate = evaluateNoShock(allComputed);
    const fingerprintGate = evaluateFingerprintConsistency(allComputed);
    const displayDeltaHygieneGate = evaluateDisplayDeltaHygiene(displayDeltaHygieneStats);
    gates.push(noShockGate, fingerprintGate, displayDeltaHygieneGate);
    const baselineTension = await computeBoard(db, 'tension', baselineCoefficients, new Map(), {
      applyStage2: false,
      projectUnclimbedAngles: false,
    });
    const holdoutRows = rowsOf<TensionBenchmarkHoldoutRow>(await db.execute(buildTensionBenchmarkHoldoutSql()));
    const benchmarkPredictions = buildBenchmarkPredictions(
      holdoutRows,
      baselineTension.computed,
      computedByBoard.get('tension') ?? [],
    );
    const benchmarkGates = evaluateTensionBenchmarkHoldout(benchmarkPredictions);
    gates.push(...benchmarkGates);
    console.log(`[grades]   no_shock: ${noShockGate.passed ? 'PASS' : 'FAIL'} — ${noShockGate.detail}`);
    console.log(
      `[grades]   fingerprint_consistency: ${fingerprintGate.passed ? 'PASS' : 'FAIL'} — ${fingerprintGate.detail}`,
    );
    console.log(
      `[grades]   display_delta_hygiene: ${displayDeltaHygieneGate.passed ? 'PASS' : 'FAIL'} — ${displayDeltaHygieneGate.detail}`,
    );
    for (const gate of benchmarkGates) {
      console.log(`[grades]   ${gate.gate}: ${gate.passed ? 'PASS' : 'FAIL'} — ${gate.detail}`);
    }

    const blocking = blockingGates(gates);
    if (dryRun) {
      if (blocking.length > 0) {
        console.error(
          `[grades] dry-run blocking gate(s) failed: ${blocking.map((gate) => gate.gate).join(', ')} — nothing written.`,
        );
        process.exitCode = 1;
      }
      console.log('[grades] dry run — no coefficients, gates, or grade rows written.');
      return;
    }

    if (blocking.length > 0) {
      console.error(
        `[grades] blocking gate(s) failed: ${blocking.map((gate) => gate.gate).join(', ')} — no coefficients, gates, or grade rows written.`,
      );
      process.exitCode = 1;
      return;
    }

    const publishedBoards = await publishPassedRun(db, coefficients, gates, computedByBoard, persistCoefficientSet);
    for (const { boardType, written, held, deleted } of publishedBoards) {
      console.log(
        `[grades]   ${boardType}: ${written} published, ${held} held by hysteresis, ${deleted} stale deleted`,
      );
    }

    // Honesty report (never blocks): boards whose grade is just the label.
    // Run it inside a transaction with parallel workers off — the 589k×900k
    // hash join's parallel workers exhausted prod's /dev/shm (SQLSTATE 53100)
    // on the first prod run; serial execution spills to disk instead. And a
    // report-only failure must never fail the run after grades published.
    try {
      const honesty = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL max_parallel_workers_per_gather = 0`);
        return rowsOf<{
          board_type: string;
          correlation: number | null;
          mean_abs_delta: number | null;
          rows: number;
        }>(await tx.execute(buildHonestyCheckSql()));
      });
      for (const row of honesty) {
        console.log(
          `[grades]   honesty ${row.board_type}: corr(display)=${row.correlation === null ? 'n/a' : Number(row.correlation).toFixed(3)}, mean|Δ|=${row.mean_abs_delta === null ? 'n/a' : Number(row.mean_abs_delta).toFixed(3)} over ${row.rows} rows`,
        );
      }
    } catch (honestyError) {
      console.warn('[grades] honesty report failed (grades already published, run continues):', honestyError);
    }
    console.log('[grades] done.');
  } finally {
    await close();
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error('[grades] failed:', error);
    process.exit(1);
  },
);
