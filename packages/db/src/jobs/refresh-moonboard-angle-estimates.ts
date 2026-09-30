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
 * Model + rationale: ../queries/grade-model/moonboard-angle-model.ts and
 * docs/boardsesh-grade.md.
 *
 * Callers: the CLI `packages/db/scripts/refresh-moonboard-angle-estimates.ts`
 * (flags --validate-only, --dry-run, --publish) and the batch worker's
 * `refresh-moonboard-angle-estimates` family (docs/background-workers.md). An
 * unusable pooled fit throws {@link MoonboardFitUnusableError}: nothing is
 * written. The publish (coefficients + estimate upserts + stale-row reap) is
 * one fenced transaction, on purpose: it is ~216k rows (~131 s measured on
 * GitHub Actions, Sep 2026), so it fits the family's 600 s heartbeat whole
 * (docs/background-workers.md). The much larger wide-angle job commits in
 * chunks instead.
 */
import { sql } from 'drizzle-orm';
import { boardGradeCoefficients } from '../schema/app/climb-grades';
import {
  CONFIDENCE,
  MOONBOARD_ANGLE_MODEL_VERSION,
  buildMoonboardAngleCoefficientRows,
  buildMoonboardDualAngleSampleSql,
  estimateMoonboardAngleDeltas,
  type MoonboardAngleCoefficients,
  type MoonboardAngleFitReport,
  type MoonboardDualAngleSampleRow,
} from '../queries/grade-model';
import { rowsOf } from '../queries/util/rows';
import { upsertGradeEstimates } from './grade-estimate-upsert';
import {
  MOONBOARD_BOARD_TYPE,
  buildExistingMoonboardEstimateKeysSql,
  buildMoonboardSingleAngleTargetSql,
  planMoonboardAngleEstimates,
  type MoonboardAngleEstimateKey,
  type MoonboardAngleEstimatePlan,
  type MoonboardSingleAngleTarget,
} from './moonboard-angle-estimate-helpers';
import { defaultTransact, type JobDatabase, type JobLogger, type JobRunOptions, type JobTransact } from './types';

export {
  MOONBOARD_BOARD_TYPE,
  MOONBOARD_ANGLE_MAX_BAND_HALF_WIDTH,
  parseMoonboardAngleEstimateFlags,
  type MoonboardAngleEstimateFlags,
} from './moonboard-angle-estimate-helpers';

const READ_PAGE_ROWS = 20000;
const DELETE_BATCH = 500;
/** How many planned rows the log prints in full, so output stays readable. */
const SAMPLE_ROWS = 3;

/**
 * Thrown when the pooled dual-angle fit is unusable (no dual-angle sample, or
 * a pooled delta pointing the wrong way). Nothing was written; a retry would
 * only refit the same unusable data.
 */
export class MoonboardFitUnusableError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`moonboard angle fit is unusable: ${problems.join('; ')}`);
    this.name = 'MoonboardFitUnusableError';
    this.problems = problems;
  }
}

async function fitCoefficients(
  db: JobDatabase,
): Promise<{ coefficients: MoonboardAngleCoefficients; report: MoonboardAngleFitReport }> {
  const coeffVersion = new Date().toISOString();
  const samples = rowsOf<MoonboardDualAngleSampleRow>(await db.execute(buildMoonboardDualAngleSampleSql()));
  return estimateMoonboardAngleDeltas(samples, coeffVersion);
}

function reportFit(report: MoonboardAngleFitReport, log: JobLogger): void {
  log.info(
    `[moon-angle] dual-angle sample: ${report.sampleClimbs} problems, ${(report.nonMonotonicShare * 100).toFixed(1)}% not harder at 40°`,
  );
  for (const [label, cell] of [
    ['25°→40°', report.pooledFrom25],
    ['40°→25°', report.pooledFrom40],
  ] as const) {
    log.info(
      cell === null
        ? `[moon-angle]   pooled ${label}: none (no sample)`
        : `[moon-angle]   pooled ${label}: ${cell.delta.toFixed(2)} ± ${cell.sd.toFixed(2)} (n=${cell.n}, LOO max Δ ${cell.looMaxDelta.toFixed(3)})`,
    );
  }
  for (const band of report.bands) {
    const direction = band.direction === 25 ? '25°→40°' : '40°→25°';
    const verdict = band.rejectedBecause === null ? 'used' : `falls back to all (${band.rejectedBecause})`;
    log.info(
      `[moon-angle]   ${direction} ${band.band}: n=${band.n}, median=${band.median === null ? 'n/a' : band.median.toFixed(2)}, sd=${band.sd === null ? 'n/a' : band.sd.toFixed(2)}, LOO max Δ=${band.looMaxDelta === null ? 'n/a' : band.looMaxDelta.toFixed(3)} — ${verdict}`,
    );
  }
  for (const problem of report.problems) {
    log.warn(`[moon-angle]   UNUSABLE: ${problem}`, { title: 'moonboard angle fit unusable' });
  }
}

/** Stream every MoonBoard problem graded at exactly one of the two angles. */
async function loadSingleAngleTargets(db: JobDatabase): Promise<MoonboardSingleAngleTarget[]> {
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

async function loadExistingEstimateKeys(db: JobDatabase): Promise<MoonboardAngleEstimateKey[]> {
  const rows = rowsOf<{ climb_uuid: string; angle: number }>(await db.execute(buildExistingMoonboardEstimateKeysSql()));
  return rows.map((row) => ({ climbUuid: row.climb_uuid, angle: Number(row.angle) }));
}

async function persistCoefficients(db: JobDatabase, coefficients: MoonboardAngleCoefficients): Promise<void> {
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

async function upsertEstimates(db: JobDatabase, plan: MoonboardAngleEstimatePlan): Promise<number> {
  return upsertGradeEstimates(db, plan.upserts);
}

/**
 * Remove estimate rows this run no longer stands behind — most often because
 * the problem has since been climbed at the angle we were estimating, so a real
 * grade belongs there instead. Scoped to this job's own tier so it can never
 * touch a row another writer owns.
 */
async function reapStaleEstimates(db: JobDatabase, reaps: readonly MoonboardAngleEstimateKey[]): Promise<number> {
  let deleted = 0;
  for (let start = 0; start < reaps.length; start += DELETE_BATCH) {
    const batch = reaps.slice(start, start + DELETE_BATCH);
    const keys = batch.map((key) => sql`(${key.climbUuid}, ${key.angle})`);
    const removed = await db.execute(sql`
      DELETE FROM board_climb_grades
      WHERE board_type = ${MOONBOARD_BOARD_TYPE}
        AND confidence = ${CONFIDENCE.moonboardAngleEstimate}
        AND (climb_uuid, angle) IN (${sql.join(keys, sql`, `)})
      RETURNING 1
    `);
    // Rows actually removed: a retry after a committed prefix can find some
    // keys already gone, so the batch size would overcount.
    deleted += rowsOf(removed).length;
  }
  return deleted;
}

function reportPlan(plan: MoonboardAngleEstimatePlan, log: JobLogger): void {
  log.info(
    `[moon-angle] plan: ${plan.upserts.length} estimate rows, ${plan.reaps.length} stale rows to reap, ${plan.skipped} targets skipped (no usable coefficients)`,
  );
  for (const row of plan.upserts.slice(0, SAMPLE_ROWS)) {
    log.info(
      `[moon-angle]   ${row.climbUuid} @${row.angle}°: local=${row.localGrade}, band=[${row.gradeLow}, ${row.gradeHigh}], confidence=${row.confidence}, ascents=${row.ascensionistCount}, universal=${row.universalGrade}`,
    );
  }
}

export type RefreshMoonboardAngleEstimatesParams = {
  /** Fit and report the coefficients only, write nothing. */
  validateOnly: boolean;
  /** Full plan including row shapes, write nothing. */
  dryRun: boolean;
  /** The only flag that writes, and only when `dryRun` and `validateOnly` are off. */
  publish: boolean;
};

export type RefreshMoonboardAngleEstimatesOptions = JobRunOptions & RefreshMoonboardAngleEstimatesParams;

export type RefreshMoonboardAngleEstimatesResult = {
  coeffVersion: string;
  planned: number;
  written: number;
  deleted: number;
  skipped: number;
};

export async function runMoonboardAngleEstimates(
  options: RefreshMoonboardAngleEstimatesOptions,
): Promise<RefreshMoonboardAngleEstimatesResult> {
  const { db, signal, log, validateOnly, dryRun, publish } = options;
  const transact: JobTransact = options.transact ?? defaultTransact(db);
  signal.throwIfAborted();

  const { coefficients, report } = await fitCoefficients(db);
  log.info(`[moon-angle] coefficients ${coefficients.coeffVersion} (model ${MOONBOARD_ANGLE_MODEL_VERSION})`);
  reportFit(report, log);

  if (report.problems.length > 0) {
    throw new MoonboardFitUnusableError(report.problems);
  }
  if (validateOnly) {
    log.info('[moon-angle] validate-only done (nothing written).');
    return { coeffVersion: coefficients.coeffVersion, planned: 0, written: 0, deleted: 0, skipped: 0 };
  }

  const targets = await loadSingleAngleTargets(db);
  const existing = await loadExistingEstimateKeys(db);
  log.info(`[moon-angle] ${targets.length} single-angle problems, ${existing.length} estimate rows already published`);
  const plan = planMoonboardAngleEstimates(targets, coefficients, existing, coefficients.coeffVersion);
  reportPlan(plan, log);

  // dryRun wins over publish: `{ dryRun: true }` on a payload whose publish
  // defaults to true must still write nothing.
  if (!publish || dryRun) {
    log.info(
      dryRun
        ? '[moon-angle] dry run — no coefficients or grade rows written.'
        : '[moon-angle] --publish not set — no coefficients or grade rows written.',
    );
    return {
      coeffVersion: coefficients.coeffVersion,
      planned: plan.upserts.length,
      written: 0,
      deleted: 0,
      skipped: plan.skipped,
    };
  }

  // Between the fit/plan (all reads) and the publish (the fenced write): the
  // worker's context.transaction() below IS the attempt fence, so an abort
  // must land before it opens, never mid-transaction.
  signal.throwIfAborted();

  const { written, deleted } = await transact(async (transaction) => {
    await persistCoefficients(transaction, coefficients);
    return {
      written: await upsertEstimates(transaction, plan),
      deleted: await reapStaleEstimates(transaction, plan.reaps),
    };
  });
  log.info(
    `[moon-angle] published ${written} changed estimate rows (${plan.upserts.length - written} unchanged, left alone), reaped ${deleted} stale rows.`,
  );
  log.info('[moon-angle] done.');
  return {
    coeffVersion: coefficients.coeffVersion,
    planned: plan.upserts.length,
    written,
    deleted,
    skipped: plan.skipped,
  };
}
