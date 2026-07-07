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
 * Run locally: `node --import tsx packages/db/scripts/refresh-climb-grades.ts`
 * Flags: --refit-coefficients (force a refit), --dry-run (gates + stats only),
 * --validate-only (read-only gates report, works without the grade tables),
 * --allow-empty-backtest (dev DBs without stats history: skip the backtest
 * instead of blocking — never use in prod).
 */
import { sql } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { boardClimbGrades, boardGradeCoefficients } from '../src/schema/app/climb-grades.js';
import {
  ANCHOR_BOARD,
  CROWD_MEAN_BOARDS,
  GRADE_MODEL_VERSION,
  OFFSET_LOO_MAX_DELTA,
  buildAngleSurfaceSql,
  buildBacktestSampleSql,
  buildBoardOffsetSampleSql,
  buildEchoRatesSql,
  buildHonestyCheckSql,
  buildSigmaWithinSql,
  buildTauSampleSql,
  computePosteriorGrade,
  estimateAngleSurface,
  estimateBoardOffsets,
  estimateEchoFractions,
  estimateSigmaWithin,
  estimateTauSquared,
  evaluateBacktest,
  evaluateFingerprintGate,
  evaluateResidualGapGate,
  shouldPublish,
  GATE_NO_SHOCK_MAX_MOVE,
  GATE_NO_SHOCK_MIN_ASCENTS,
  type AngleSurfaceRow,
  type BacktestSampleRow,
  type BoardOffsetSampleRow,
  type ClimbAngleObservation,
  type EchoRateRow,
  type GateResult,
  type GradeCoefficients,
  type SigmaWithinRow,
  type TauSampleRow,
} from '../src/queries/grade-model/index.js';
import { rowsOf } from '../src/queries/util/rows.js';

const COEFF_MAX_AGE_DAYS = 7;
const BACKTEST_SAMPLE_LIMIT = 20000;
const READ_PAGE_ROWS = 20000;
const UPSERT_BATCH = 500;

type Db = ReturnType<typeof createScriptDb>['db'];

interface CoefficientRow {
  coeff_version: string;
  kind: string;
  key: string;
  payload: unknown;
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
  const coefficients: GradeCoefficients = {
    coeffVersion: latest[0].coeff_version,
    echoFraction: {},
    sigmaWithin: {},
    tauSquared: {},
    angleOffset: {},
    boardOffset: {},
  };
  // Payload shapes are documented per `kind` on the boardGradeCoefficients
  // schema; the writer below is the only producer, so shape-by-kind casts are
  // safe here.
  for (const row of rows) {
    if (row.kind === 'echo_fraction') {
      coefficients.echoFraction[row.key] = (row.payload as { lambda: number }).lambda;
    } else if (row.kind === 'sigma_within') {
      coefficients.sigmaWithin[row.key] = row.payload as GradeCoefficients['sigmaWithin'][string];
    } else if (row.kind === 'tau_squared') {
      coefficients.tauSquared[row.key] = row.payload as GradeCoefficients['tauSquared'][string];
    } else if (row.kind === 'angle_offset') {
      coefficients.angleOffset[row.key] = row.payload as GradeCoefficients['angleOffset'][string];
    } else if (row.kind === 'board_offset') {
      coefficients.boardOffset[row.key] = row.payload as GradeCoefficients['boardOffset'][string];
    }
  }
  return coefficients;
}

async function refitCoefficients(
  db: Db,
  options: { persist: boolean } = { persist: true },
): Promise<GradeCoefficients> {
  console.log('[grades] refitting coefficients…');
  const coeffVersion = new Date().toISOString().slice(0, 10);

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

  const coefficients: GradeCoefficients = {
    coeffVersion,
    echoFraction,
    sigmaWithin,
    tauSquared,
    angleOffset,
    boardOffset: { [ANCHOR_BOARD]: { offset: 0, sd: 0, users: 0, looMaxDelta: 0 } },
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

  const rows = [
    ...Object.entries(echoFraction).map(([board, lambda]) => ({
      kind: 'echo_fraction',
      key: board,
      payload: { lambda },
    })),
    ...Object.entries(sigmaWithin).map(([board, payload]) => ({ kind: 'sigma_within', key: board, payload })),
    ...Object.entries(tauSquared).map(([board, payload]) => ({ kind: 'tau_squared', key: board, payload })),
    ...Object.entries(angleOffset).map(([board, payload]) => ({ kind: 'angle_offset', key: board, payload })),
    ...Object.entries(coefficients.boardOffset).map(([board, payload]) => ({
      kind: 'board_offset',
      key: board,
      payload,
    })),
  ];
  if (!options.persist) {
    console.log(`[grades] coefficients ${coeffVersion} (in-memory only): λ=${JSON.stringify(echoFraction)}`);
    return coefficients;
  }
  for (const row of rows) {
    await db
      .insert(boardGradeCoefficients)
      .values({ coeffVersion, kind: row.kind, key: row.key, payload: row.payload })
      .onConflictDoUpdate({
        target: [boardGradeCoefficients.coeffVersion, boardGradeCoefficients.kind, boardGradeCoefficients.key],
        set: { payload: row.payload },
      });
  }
  console.log(
    `[grades] coefficients ${coeffVersion}: λ=${JSON.stringify(echoFraction)}, boards with angle surface: ${Object.keys(angleOffset).join(', ') || 'none'}`,
  );
  return coefficients;
}

interface StatsRow {
  climb_uuid: string;
  angle: number;
  difficulty_average: number | null;
  display_difficulty: number | null;
  ascensionist_count: number;
  hold_fingerprint: string | null;
}

interface ComputedRow {
  climbUuid: string;
  angle: number;
  localGrade: number | null;
  universalGrade: number | null;
  gradeLow: number | null;
  gradeHigh: number | null;
  confidence: string;
  ascensionistCount: number;
  postSd: number | null;
  rawAverage: number | null;
  holdFingerprint: string | null;
}

interface PooledAngleEvidence {
  angle: number;
  pooledAverage: number | null;
  pooledCount: number;
  pooledDisplay: number | null;
}

/**
 * Duplicate climbs (same hold_fingerprint = same physical problem under
 * different UUIDs) must not split their crowd evidence — measured on prod,
 * 44% of Kilter duplicate groups disagreed by >1 grade before pooling. A
 * fingerprint group is treated as ONE climb: per angle an n-weighted pooled
 * mean/count and averaged display, and every member uses the group's full
 * angle set as its cross-angle evidence — so members produce identical
 * posteriors by construction.
 */
async function loadPooledFingerprintEvidence(db: Db, boardType: string): Promise<Map<string, PooledAngleEvidence[]>> {
  // Two-step shape on purpose: finding duplicate fingerprints over the small
  // board_climbs table first keeps the stats join tiny — the single-pass
  // GROUP BY ... HAVING COUNT(DISTINCT) variant exhausted shared memory on prod.
  const rows = rowsOf<{
    hold_fingerprint: string;
    angle: number;
    pooled_average: number | null;
    pooled_count: number;
    pooled_display: number | null;
  }>(
    await db.execute(sql`
      WITH duplicate_fingerprints AS (
        SELECT hold_fingerprint
        FROM board_climbs
        WHERE board_type = ${boardType}
          AND hold_fingerprint IS NOT NULL
          AND is_listed = true
          AND COALESCE(is_draft, false) = false
        GROUP BY hold_fingerprint
        HAVING COUNT(*) >= 2
      )
      SELECT bc.hold_fingerprint, s.angle,
             SUM(s.difficulty_average * s.ascensionist_count) FILTER (WHERE s.difficulty_average IS NOT NULL AND s.ascensionist_count > 0)
               / NULLIF(SUM(s.ascensionist_count) FILTER (WHERE s.difficulty_average IS NOT NULL AND s.ascensionist_count > 0), 0)
               AS pooled_average,
             COALESCE(SUM(s.ascensionist_count), 0)::int AS pooled_count,
             AVG(s.display_difficulty) AS pooled_display
      FROM duplicate_fingerprints df
      JOIN board_climbs bc ON bc.hold_fingerprint = df.hold_fingerprint AND bc.board_type = ${boardType}
      JOIN board_climb_stats s ON s.board_type = bc.board_type AND s.climb_uuid = bc.uuid
      WHERE bc.is_listed = true AND COALESCE(bc.is_draft, false) = false
      GROUP BY bc.hold_fingerprint, s.angle
    `),
  );
  const pooled = new Map<string, PooledAngleEvidence[]>();
  for (const row of rows) {
    const list = pooled.get(row.hold_fingerprint) ?? [];
    list.push({
      angle: Number(row.angle),
      pooledAverage: row.pooled_average === null ? null : Number(row.pooled_average),
      pooledCount: Number(row.pooled_count),
      pooledDisplay: row.pooled_display === null ? null : Number(row.pooled_display),
    });
    pooled.set(row.hold_fingerprint, list);
  }
  return pooled;
}

/** Stream one board's listed, non-draft climb+angle stats, grouped by climb. */
async function computeBoard(db: Db, boardType: string, coefficients: GradeCoefficients): Promise<ComputedRow[]> {
  const pooledEvidence = await loadPooledFingerprintEvidence(db, boardType);
  const computed: ComputedRow[] = [];
  let lastClimbUuid = '';
  for (;;) {
    const rows = rowsOf<StatsRow>(
      await db.execute(sql`
        SELECT s.climb_uuid, s.angle, s.difficulty_average, s.display_difficulty,
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
      const fingerprintEvidence = group[0].hold_fingerprint ? pooledEvidence.get(group[0].hold_fingerprint) : undefined;
      const observations: ClimbAngleObservation[] = fingerprintEvidence
        ? fingerprintEvidence.map((pooled) => ({
            boardType,
            climbUuid: group[0].climb_uuid,
            angle: pooled.angle,
            difficultyAverage: pooled.pooledAverage,
            displayDifficulty: pooled.pooledDisplay,
            ascensionistCount: pooled.pooledCount,
          }))
        : group.map((row) => ({
            boardType,
            climbUuid: row.climb_uuid,
            angle: row.angle,
            difficultyAverage: row.difficulty_average === null ? null : Number(row.difficulty_average),
            displayDifficulty: row.display_difficulty === null ? null : Number(row.display_difficulty),
            ascensionistCount: Number(row.ascensionist_count),
          }));
      // Emit one output row per angle THIS climb actually has (the pooled
      // angle set may be wider than this member's own angles).
      const ownAngles = new Set(group.map((row) => row.angle));
      for (const target of observations) {
        if (!ownAngles.has(target.angle)) continue;
        const posterior = computePosteriorGrade(target, observations, coefficients);
        computed.push({
          climbUuid: group[0].climb_uuid,
          angle: target.angle,
          localGrade: posterior.localGrade,
          universalGrade: posterior.universalGrade,
          gradeLow: posterior.gradeLow,
          gradeHigh: posterior.gradeHigh,
          confidence: posterior.confidence,
          ascensionistCount: target.ascensionistCount,
          postSd: posterior.postSd,
          rawAverage: target.difficultyAverage,
          holdFingerprint: group[0].hold_fingerprint,
        });
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
  return computed;
}

/** No-shock gate evaluated in memory on the freshly computed rows. */
function evaluateNoShock(computed: ComputedRow[]): GateResult {
  let violations = 0;
  let checked = 0;
  for (const row of computed) {
    if (row.ascensionistCount < GATE_NO_SHOCK_MIN_ASCENTS || row.rawAverage === null || row.localGrade === null)
      continue;
    checked += 1;
    if (Math.abs(row.localGrade - row.rawAverage) > GATE_NO_SHOCK_MAX_MOVE) violations += 1;
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
    const key = `${row.holdFingerprint}:${row.angle}`;
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

async function upsertGrades(
  db: Db,
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
          modelVersion: sql`EXCLUDED.model_version`,
          coeffVersion: sql`EXCLUDED.coeff_version`,
          computedAt: sql`now()`,
        },
      });
    written += batch.length;
    batch = [];
  };

  for (const row of computed) {
    const posteriorLike = {
      localGrade: row.localGrade,
      universalGrade: row.universalGrade,
      gradeLow: row.gradeLow,
      gradeHigh: row.gradeHigh,
      confidence: row.confidence as never,
      postSd: row.postSd,
    };
    if (!shouldPublish(previous.get(`${row.climbUuid}:${row.angle}`), posteriorLike)) {
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
      modelVersion: GRADE_MODEL_VERSION,
      coeffVersion: coefficients.coeffVersion,
    });
    if (batch.length >= UPSERT_BATCH) await flush();
  }
  await flush();
  return { written, held };
}

async function recordGateResults(db: Db, coefficients: GradeCoefficients, gates: GateResult[]): Promise<void> {
  const runKey = new Date().toISOString();
  await db.insert(boardGradeCoefficients).values({
    coeffVersion: coefficients.coeffVersion,
    kind: 'gate_results',
    key: runKey,
    payload: { modelVersion: GRADE_MODEL_VERSION, gates },
  });
}

/**
 * Read-only validation against a database that may not have the grade tables
 * yet (e.g. prod before the migration lands): refit coefficients in memory,
 * run the input-side gates, compute every board, evaluate the in-memory gates,
 * and print the report. Writes nothing.
 */
async function validateOnly(db: Db): Promise<void> {
  const coefficients = await refitCoefficients(db, { persist: false });
  console.log('[grades] validate-only: running gates against live data…');
  const backtestRows = rowsOf<BacktestSampleRow>(await db.execute(buildBacktestSampleSql(BACKTEST_SAMPLE_LIMIT)));
  const backtest = evaluateBacktest(backtestRows, coefficients);
  console.log(`[grades]   tail_backtest: ${backtest.tailGate.passed ? 'PASS' : 'FAIL'} — ${backtest.tailGate.detail}`);
  console.log(`[grades]   head_holdout: ${backtest.headGate.passed ? 'PASS' : 'FAIL'} — ${backtest.headGate.detail}`);
  const kilterOffset = coefficients.boardOffset.kilter;
  if (kilterOffset) {
    const offsetRows = rowsOf<BoardOffsetSampleRow>(await db.execute(buildBoardOffsetSampleSql()));
    const residualGate = evaluateResidualGapGate(offsetRows, kilterOffset.offset);
    console.log(`[grades]   residual_paired_gap: ${residualGate.passed ? 'PASS' : 'FAIL'} — ${residualGate.detail}`);
    console.log(
      `[grades]   kilter offset ${kilterOffset.offset.toFixed(2)} ± ${kilterOffset.sd.toFixed(2)} (${kilterOffset.users} users, LOO max Δ ${kilterOffset.looMaxDelta.toFixed(3)})`,
    );
  }
  for (const boardType of CROWD_MEAN_BOARDS) {
    const computed = await computeBoard(db, boardType, coefficients);
    const noShock = evaluateNoShock(computed);
    const fingerprint = evaluateFingerprintConsistency(computed);
    const tiers = computed.reduce<Record<string, number>>((acc, row) => {
      acc[row.confidence] = (acc[row.confidence] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `[grades]   ${boardType}: ${computed.length} rows, tiers=${JSON.stringify(tiers)}; no_shock ${noShock.passed ? 'PASS' : 'FAIL'} (${noShock.detail}); fingerprint ${fingerprint.passed ? 'PASS' : 'FAIL'} (${fingerprint.detail})`,
    );
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
      await validateOnly(db);
      return;
    }
    const coefficients = (!forceRefit && (await loadFrozenCoefficients(db))) || (await refitCoefficients(db));
    console.log(`[grades] using coefficients ${coefficients.coeffVersion} (model ${GRADE_MODEL_VERSION})`);

    const gates: GateResult[] = [];

    // Pre-write gates: history backtest + cross-board residual.
    console.log('[grades] running backtest gate…');
    const backtestRows = rowsOf<BacktestSampleRow>(await db.execute(buildBacktestSampleSql(BACKTEST_SAMPLE_LIMIT)));
    if (backtestRows.length === 0 && allowEmptyBacktest) {
      // Environments without stats history (e.g. the dev DB image) can't run
      // the backtest at all — that's "no evidence", not a model regression.
      // Prod keeps the strict behavior: an empty sample there means a broken
      // query and must block.
      console.warn('[grades]   backtest SKIPPED — no stats-history sample (--allow-empty-backtest).');
      gates.push({
        gate: 'tail_backtest',
        passed: true,
        detail: 'skipped: empty history sample (--allow-empty-backtest)',
        metrics: { multiN: 0 },
      });
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
    for (const boardType of CROWD_MEAN_BOARDS) {
      console.log(`[grades] computing ${boardType}…`);
      const computed = await computeBoard(db, boardType, coefficients);
      computedByBoard.set(boardType, computed);
      console.log(`[grades]   ${computed.length} climb+angle rows`);
    }
    const allComputed = [...computedByBoard.values()].flat();
    const noShockGate = evaluateNoShock(allComputed);
    const fingerprintGate = evaluateFingerprintConsistency(allComputed);
    gates.push(noShockGate, fingerprintGate);
    console.log(`[grades]   no_shock: ${noShockGate.passed ? 'PASS' : 'FAIL'} — ${noShockGate.detail}`);
    console.log(
      `[grades]   fingerprint_consistency: ${fingerprintGate.passed ? 'PASS' : 'FAIL'} — ${fingerprintGate.detail}`,
    );

    await recordGateResults(db, coefficients, gates);

    const blocking = gates.filter((gate) => !gate.passed && gate.gate !== 'residual_paired_gap');
    if (blocking.length > 0) {
      console.error(
        `[grades] blocking gate(s) failed: ${blocking.map((gate) => gate.gate).join(', ')} — no grades written.`,
      );
      process.exitCode = 1;
      return;
    }
    if (dryRun) {
      console.log('[grades] dry run — gates recorded, no grades written.');
      return;
    }

    for (const [boardType, computed] of computedByBoard) {
      const { written, held } = await upsertGrades(db, boardType, computed, coefficients);
      console.log(`[grades]   ${boardType}: ${written} published, ${held} held by hysteresis`);
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
