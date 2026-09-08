/**
 * MoonBoard same-board angle grade estimate refresh.
 *
 * 96.7% of MoonBoard problems carry a grade at only one of the board's two
 * fixed angles (25° / 40°) — the other angle has never been climbed, so today
 * it shows nothing at all. This job fits a per-grade-band delta from the small
 * minority of problems graded at BOTH angles, transposes each single-angle
 * problem's grade onto its missing angle, and persists the result as an
 * ordinary `board_climb_grades` row tiered `moonboard_angle_estimate` — which
 * the existing resolvers, offline sync and display plumbing then carry for
 * free.
 *
 * This is NOT the Boardsesh grade. MoonBoard has no crowd mean in our feed and
 * is excluded from the nightly `refresh-climb-grades` run on purpose; the model
 * here works from setter labels alone and never claims a `universal_grade`.
 * Model + rationale: src/queries/grade-model/moonboard-angle-model.ts and
 * docs/boardsesh-grade.md.
 *
 * Run locally: `vp run db:refresh-moonboard-angle-estimates -- --dry-run`
 * Flags: --validate-only (fit the coefficients and print the per-band report,
 * touch nothing), --dry-run (full plan including row shapes, write nothing),
 * --publish (the only flag that writes; off by default).
 */
import { sql } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { boardClimbGrades, boardGradeCoefficients } from '../src/schema/app/climb-grades.js';
import {
  CONFIDENCE,
  MOONBOARD_ANGLE_MODEL_VERSION,
  buildMoonboardAngleCoefficientRows,
  buildMoonboardDualAngleSampleSql,
  estimateMoonboardAngleDeltas,
  type MoonboardAngleCoefficients,
  type MoonboardAngleFitReport,
  type MoonboardDualAngleSampleRow,
} from '../src/queries/grade-model/index.js';
import { rowsOf } from '../src/queries/util/rows.js';
import {
  MOONBOARD_BOARD_TYPE,
  buildExistingMoonboardEstimateKeysSql,
  buildMoonboardSingleAngleTargetSql,
  parseMoonboardAngleEstimateFlags,
  planMoonboardAngleEstimates,
  type MoonboardAngleEstimateKey,
  type MoonboardAngleEstimatePlan,
  type MoonboardSingleAngleTarget,
} from './moonboard-angle-estimate-helpers.js';

const READ_PAGE_ROWS = 20000;
const UPSERT_BATCH = 500;
const DELETE_BATCH = 500;
/** How many planned rows --dry-run prints in full, so the output stays readable. */
const SAMPLE_ROWS = 3;

type Db = ReturnType<typeof createScriptDb>['db'];
type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];
type DbWriter = Pick<Db, 'execute' | 'insert'> | Pick<DbTransaction, 'execute' | 'insert'>;

async function fitCoefficients(
  db: Db,
): Promise<{ coefficients: MoonboardAngleCoefficients; report: MoonboardAngleFitReport }> {
  const coeffVersion = new Date().toISOString();
  const samples = rowsOf<MoonboardDualAngleSampleRow>(await db.execute(buildMoonboardDualAngleSampleSql()));
  return estimateMoonboardAngleDeltas(samples, coeffVersion);
}

function reportFit(report: MoonboardAngleFitReport): void {
  console.log(
    `[moon-angle] dual-angle sample: ${report.sampleClimbs} problems, ${(report.nonMonotonicShare * 100).toFixed(1)}% not harder at 40°`,
  );
  for (const [label, cell] of [
    ['25°→40°', report.pooledFrom25],
    ['40°→25°', report.pooledFrom40],
  ] as const) {
    console.log(
      cell === null
        ? `[moon-angle]   pooled ${label}: none (no sample)`
        : `[moon-angle]   pooled ${label}: ${cell.delta.toFixed(2)} ± ${cell.sd.toFixed(2)} (n=${cell.n}, LOO max Δ ${cell.looMaxDelta.toFixed(3)})`,
    );
  }
  for (const band of report.bands) {
    const direction = band.direction === 25 ? '25°→40°' : '40°→25°';
    const verdict = band.rejectedBecause === null ? 'used' : `falls back to all (${band.rejectedBecause})`;
    console.log(
      `[moon-angle]   ${direction} ${band.band}: n=${band.n}, median=${band.median === null ? 'n/a' : band.median.toFixed(2)}, sd=${band.sd === null ? 'n/a' : band.sd.toFixed(2)}, LOO max Δ=${band.looMaxDelta === null ? 'n/a' : band.looMaxDelta.toFixed(3)} — ${verdict}`,
    );
  }
  for (const problem of report.problems) {
    console.error(`[moon-angle]   UNUSABLE: ${problem}`);
  }
}

/** Stream every MoonBoard problem graded at exactly one of the two angles. */
async function loadSingleAngleTargets(db: Db): Promise<MoonboardSingleAngleTarget[]> {
  const targets: MoonboardSingleAngleTarget[] = [];
  let lastClimbUuid = '';
  for (;;) {
    const rows = rowsOf<{ climb_uuid: string; known_angle: number; known_grade: number }>(
      await db.execute(buildMoonboardSingleAngleTargetSql(lastClimbUuid, READ_PAGE_ROWS)),
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      targets.push({
        climbUuid: row.climb_uuid,
        knownAngle: Number(row.known_angle),
        knownGrade: Number(row.known_grade),
      });
    }
    lastClimbUuid = rows[rows.length - 1].climb_uuid;
    if (rows.length < READ_PAGE_ROWS) break;
  }
  return targets;
}

async function loadExistingEstimateKeys(db: Db): Promise<MoonboardAngleEstimateKey[]> {
  const rows = rowsOf<{ climb_uuid: string; angle: number }>(await db.execute(buildExistingMoonboardEstimateKeysSql()));
  return rows.map((row) => ({ climbUuid: row.climb_uuid, angle: Number(row.angle) }));
}

async function persistCoefficients(db: DbWriter, coefficients: MoonboardAngleCoefficients): Promise<void> {
  for (const row of buildMoonboardAngleCoefficientRows(coefficients)) {
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

async function upsertEstimates(db: DbWriter, plan: MoonboardAngleEstimatePlan): Promise<number> {
  let written = 0;
  for (let start = 0; start < plan.upserts.length; start += UPSERT_BATCH) {
    const batch = plan.upserts.slice(start, start + UPSERT_BATCH);
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
  }
  return written;
}

/**
 * Remove estimate rows this run no longer stands behind — most often because
 * the problem has since been climbed at the angle we were estimating, so a real
 * grade belongs there instead. Scoped to this job's own tier so it can never
 * touch a row another writer owns.
 */
async function reapStaleEstimates(db: DbWriter, reaps: readonly MoonboardAngleEstimateKey[]): Promise<number> {
  let deleted = 0;
  for (let start = 0; start < reaps.length; start += DELETE_BATCH) {
    const batch = reaps.slice(start, start + DELETE_BATCH);
    const keys = batch.map((key) => sql`(${key.climbUuid}, ${key.angle})`);
    await db.execute(sql`
      DELETE FROM board_climb_grades
      WHERE board_type = ${MOONBOARD_BOARD_TYPE}
        AND confidence = ${CONFIDENCE.moonboardAngleEstimate}
        AND (climb_uuid, angle) IN (${sql.join(keys, sql`, `)})
    `);
    deleted += batch.length;
  }
  return deleted;
}

function reportPlan(plan: MoonboardAngleEstimatePlan): void {
  console.log(
    `[moon-angle] plan: ${plan.upserts.length} estimate rows, ${plan.reaps.length} stale rows to reap, ${plan.skipped} targets skipped (no usable coefficients)`,
  );
  for (const row of plan.upserts.slice(0, SAMPLE_ROWS)) {
    console.log(
      `[moon-angle]   ${row.climbUuid} @${row.angle}°: local=${row.localGrade}, band=[${row.gradeLow}, ${row.gradeHigh}], confidence=${row.confidence}, ascents=${row.ascensionistCount}, universal=${row.universalGrade}`,
    );
  }
}

async function main(): Promise<void> {
  const flags = parseMoonboardAngleEstimateFlags(process.argv);
  const { db, close } = createScriptDb();
  try {
    const { coefficients, report } = await fitCoefficients(db);
    console.log(`[moon-angle] coefficients ${coefficients.coeffVersion} (model ${MOONBOARD_ANGLE_MODEL_VERSION})`);
    reportFit(report);

    if (report.problems.length > 0) {
      console.error('[moon-angle] pooled fit is unusable — nothing written.');
      process.exitCode = 1;
      return;
    }
    if (flags.validateOnly) {
      console.log('[moon-angle] validate-only done (nothing written).');
      return;
    }

    const targets = await loadSingleAngleTargets(db);
    const existing = await loadExistingEstimateKeys(db);
    console.log(
      `[moon-angle] ${targets.length} single-angle problems, ${existing.length} estimate rows already published`,
    );
    const plan = planMoonboardAngleEstimates(targets, coefficients, existing, coefficients.coeffVersion);
    reportPlan(plan);

    if (!flags.publish) {
      console.log(
        flags.dryRun
          ? '[moon-angle] dry run — no coefficients or grade rows written.'
          : '[moon-angle] --publish not set — no coefficients or grade rows written.',
      );
      return;
    }

    const { written, deleted } = await db.transaction(async (tx) => {
      await persistCoefficients(tx, coefficients);
      return { written: await upsertEstimates(tx, plan), deleted: await reapStaleEstimates(tx, plan.reaps) };
    });
    console.log(`[moon-angle] published ${written} estimate rows, reaped ${deleted} stale rows.`);
    console.log('[moon-angle] done.');
  } finally {
    await close();
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error('[moon-angle] failed:', error);
    process.exit(1);
  },
);
