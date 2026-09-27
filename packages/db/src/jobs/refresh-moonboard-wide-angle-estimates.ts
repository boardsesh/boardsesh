/**
 * MoonBoard wide-angle grade estimate refresh.
 *
 * The `moonboard-wide-angles` feature flag lets a MoonBoard problem be climbed
 * at any angle (0°-70°, 5° steps), not just Moon's own catalog angles
 * (25°/40°). Real community evidence at those wide angles barely exists yet,
 * so unlike the same-board transpose (`refresh-moonboard-angle-estimates.ts`),
 * this job borrows another crowd-mean board's fitted angle-EFFECT SHAPE and
 * applies it to MoonBoard's own known grade at 25°/40°. See
 * ../queries/grade-model/moonboard-wide-angle-model.ts for the estimator and
 * the cross-board validation behind it. This trades same-board accuracy for
 * immediate coverage on purpose (see the module doc).
 *
 * Callers: the CLI `packages/db/scripts/refresh-moonboard-wide-angle-estimates.ts`
 * (flags --dry-run, --publish) and the batch worker's
 * `refresh-moonboard-wide-angle-estimates` family (docs/background-workers.md).
 * Zero angle-surface coverage from any shape board throws
 * {@link MoonboardFitUnusableError}: nothing is written. There is no
 * coefficient persistence step here (the angle surface is refit from
 * board_climb_stats every run, never stored).
 *
 * The publish commits in chunks, not one transaction. The output is ~2.89M
 * rows (production, Sep 2026), and one transaction that size took ~1,429 s on
 * GitHub Actions: too close to any fence or lease a worker can hold, and the
 * run row's lock would stall the reconciler for the whole time. So the upserts
 * commit in keyset chunks of about {@link PUBLISH_CHUNK_ROWS} rows by
 * climb_uuid (~3,850 climbs x 13 angles), each chunk one `transact` call, and
 * every one of a climb's angles lands in the same chunk. The stale-row reap
 * runs after all upserts, in chunks of its own.
 *
 * Accepted trade-off: while a publish is running, readers can see this week's
 * surface for some climbs and last week's for others. Each climb's 13-angle
 * ladder is always from one run. Only rows whose values moved are rewritten
 * (the IS DISTINCT FROM guard in grade-estimate-upsert.ts), so the mix is
 * limited to climbs whose integer grade changed. An interrupted run leaves a
 * committed prefix of whole climbs; the retry re-plans from scratch, and the
 * rows the first attempt committed are no-ops. A generation column that would
 * flip the whole surface at once was rejected: it rewrites all 2.89M rows
 * every week and re-sends ~1.2M rows to every MoonBoard device.
 */
import { sql } from 'drizzle-orm';
import { MOONBOARD_WIDE_ANGLES } from '@boardsesh/board-config';
import {
  CONFIDENCE,
  MOONBOARD_WIDE_ANGLE_SHAPE_BOARDS,
  buildAngleSurfaceSql,
  estimateAngleSurface,
  type AngleSurfaceRow,
  type GradeCoefficients,
} from '../queries/grade-model';
import { rowsOf } from '../queries/util/rows';
import { chunkRowsByClimb, upsertGradeEstimates } from './grade-estimate-upsert';
import { MoonboardFitUnusableError } from './refresh-moonboard-angle-estimates';
import {
  MOONBOARD_BOARD_TYPE,
  MOONBOARD_WIDE_ANGLE_MODEL_VERSION,
  buildExistingMoonboardWideAngleKeysSql,
  buildMoonboardWideAngleTargetSql,
  planMoonboardWideAngleEstimates,
  type MoonboardWideAngleEstimateKey,
  type MoonboardWideAngleEstimatePlan,
  type MoonboardWideAngleTarget,
} from './moonboard-wide-angle-estimate-helpers';
import { defaultTransact, type JobDatabase, type JobLogger, type JobRunOptions, type JobTransact } from './types';

export { MoonboardFitUnusableError } from './refresh-moonboard-angle-estimates';
export { MOONBOARD_WIDE_ANGLE_MODEL_VERSION } from './moonboard-wide-angle-estimate-helpers';

const READ_PAGE_ROWS = 20000;
const DELETE_BATCH = 500;
/**
 * Rows per committed publish chunk. At the measured ~0.49 ms per row (1,429 s
 * for 2.89M rows, insert-only, on GitHub Actions) one chunk is about 25 s,
 * against the family's 290 s bound (300 s heartbeat minus the 10 s touch lag).
 */
const PUBLISH_CHUNK_ROWS = 50_000;
const SAMPLE_ROWS = 5;

async function loadShapeCoefficients(db: JobDatabase, log: JobLogger): Promise<GradeCoefficients> {
  const rows = rowsOf<AngleSurfaceRow>(await db.execute(buildAngleSurfaceSql()));
  const angleOffset = estimateAngleSurface(rows);
  log.info(
    `[moon-wide] angle-surface coverage from: ${MOONBOARD_WIDE_ANGLE_SHAPE_BOARDS.filter((board) => angleOffset[board]).join(', ') || 'none'}`,
  );
  return {
    coeffVersion: new Date().toISOString(),
    echoFraction: {},
    sigmaWithin: {},
    tauSquared: {},
    angleOffset,
    boardOffset: {},
    raterModel: {},
    behaviorModel: {},
    bridgeReadiness: {},
  };
}

async function loadTargets(db: JobDatabase): Promise<MoonboardWideAngleTarget[]> {
  const targets: MoonboardWideAngleTarget[] = [];
  let lastClimbUuid = '';
  for (;;) {
    const rows = rowsOf<{
      climb_uuid: string;
      grade_25: number | null;
      grade_25_is_real: boolean;
      grade_40: number | null;
      grade_40_is_real: boolean;
    }>(await db.execute(buildMoonboardWideAngleTargetSql(lastClimbUuid, READ_PAGE_ROWS)));
    if (rows.length === 0) break;
    for (const row of rows) {
      targets.push({
        climbUuid: row.climb_uuid,
        grade25: row.grade_25 === null ? null : Number(row.grade_25),
        grade25IsReal: row.grade_25_is_real,
        grade40: row.grade_40 === null ? null : Number(row.grade_40),
        grade40IsReal: row.grade_40_is_real,
      });
    }
    lastClimbUuid = rows[rows.length - 1].climb_uuid;
    if (rows.length < READ_PAGE_ROWS) break;
  }
  return targets;
}

async function loadExistingKeys(db: JobDatabase): Promise<MoonboardWideAngleEstimateKey[]> {
  const rows = rowsOf<{ climb_uuid: string; angle: number }>(
    await db.execute(buildExistingMoonboardWideAngleKeysSql()),
  );
  return rows.map((row) => ({ climbUuid: row.climb_uuid, angle: Number(row.angle) }));
}

/**
 * The conflict target is (board_type, climb_uuid, angle) — no model_version.
 * Safe only because this job's targets (angles outside {25, 40} — see
 * buildMoonboardWideAngleTargetSql) never overlap the two other MoonBoard
 * producers writing to this table: the main model only computes 25°/40°, and
 * the same-board transpose only targets the OTHER of those same two angles.
 * That is a construction-time invariant, not something the schema enforces.
 */
async function upsertEstimates(
  db: JobDatabase,
  rows: MoonboardWideAngleEstimatePlan['upserts'],
  signal: AbortSignal,
): Promise<number> {
  return upsertGradeEstimates(db, rows, undefined, signal);
}

async function reapStaleEstimates(
  db: JobDatabase,
  reaps: readonly MoonboardWideAngleEstimateKey[],
  signal: AbortSignal,
): Promise<number> {
  let deleted = 0;
  for (let start = 0; start < reaps.length; start += DELETE_BATCH) {
    signal.throwIfAborted();
    const batch = reaps.slice(start, start + DELETE_BATCH);
    const keys = batch.map((key) => sql`(${key.climbUuid}, ${key.angle})`);
    const removed = await db.execute(sql`
      DELETE FROM board_climb_grades
      WHERE board_type = ${MOONBOARD_BOARD_TYPE}
        AND confidence = ${CONFIDENCE.moonboardWideAngleEstimate}
        AND (climb_uuid, angle) IN (${sql.join(keys, sql`, `)})
      RETURNING 1
    `);
    // Rows actually removed: a retry after a committed prefix can find some
    // keys already gone, so the batch size would overcount.
    deleted += rowsOf(removed).length;
  }
  return deleted;
}

function reportPlan(plan: MoonboardWideAngleEstimatePlan, log: JobLogger): void {
  log.info(
    `[moon-wide] plan: ${plan.upserts.length} estimate rows, ${plan.reaps.length} stale rows to reap, ${plan.skipped} targets skipped (no shape coverage)`,
  );
  for (const row of plan.upserts.slice(0, SAMPLE_ROWS)) {
    log.info(
      `[moon-wide]   ${row.climbUuid} @${row.angle}°: local=${row.localGrade}, band=[${row.gradeLow}, ${row.gradeHigh}], confidence=${row.confidence}`,
    );
  }
}

export type RefreshMoonboardWideAngleEstimatesParams = {
  /** Full plan including row shapes, write nothing. */
  dryRun: boolean;
  /** The only flag that writes, and only when `dryRun` is off. */
  publish: boolean;
};

export type RefreshMoonboardWideAngleEstimatesOptions = JobRunOptions &
  RefreshMoonboardWideAngleEstimatesParams & {
    /** Rows per committed chunk; defaults to {@link PUBLISH_CHUNK_ROWS}. Tests shrink it. */
    chunkRows?: number;
  };

export type RefreshMoonboardWideAngleEstimatesResult = {
  coeffVersion: string;
  planned: number;
  written: number;
  deleted: number;
  skipped: number;
};

export async function runMoonboardWideAngleEstimates(
  options: RefreshMoonboardWideAngleEstimatesOptions,
): Promise<RefreshMoonboardWideAngleEstimatesResult> {
  const { db, signal, log, dryRun, publish } = options;
  const transact: JobTransact = options.transact ?? defaultTransact(db);
  signal.throwIfAborted();

  const coefficients = await loadShapeCoefficients(db, log);
  log.info(`[moon-wide] coefficients ${coefficients.coeffVersion} (model ${MOONBOARD_WIDE_ANGLE_MODEL_VERSION})`);

  // Guard mirroring the sibling angle-transpose job's `report.problems` abort:
  // with zero shape coverage, every target would fail estimation and the plan
  // would treat every existing row as "not wanted" — a publish here would reap
  // the entire table with nothing to replace it. Abort before that plan is
  // ever built, not just when it's reported.
  if (!MOONBOARD_WIDE_ANGLE_SHAPE_BOARDS.some((board) => coefficients.angleOffset[board])) {
    throw new MoonboardFitUnusableError(['no angle-surface coverage from any shape board']);
  }

  const targets = await loadTargets(db);
  const existing = await loadExistingKeys(db);
  log.info(
    `[moon-wide] ${targets.length} climbs with a known 25°/40° grade, ${existing.length} estimate rows already published`,
  );

  const plan = planMoonboardWideAngleEstimates(
    targets,
    MOONBOARD_WIDE_ANGLES,
    coefficients,
    existing,
    coefficients.coeffVersion,
  );
  reportPlan(plan, log);

  // dryRun wins over publish: `{ dryRun: true }` on a payload whose publish
  // defaults to true must still write nothing.
  if (!publish || dryRun) {
    log.info(
      dryRun
        ? '[moon-wide] dry run — no grade rows written.'
        : '[moon-wide] --publish not set — no grade rows written.',
    );
    return {
      coeffVersion: coefficients.coeffVersion,
      planned: plan.upserts.length,
      written: 0,
      deleted: 0,
      skipped: plan.skipped,
    };
  }

  const chunkRows = options.chunkRows ?? PUBLISH_CHUNK_ROWS;
  const upsertChunks = chunkRowsByClimb(plan.upserts, chunkRows);
  const reapChunks = chunkRowsByClimb(plan.reaps, chunkRows);
  let written = 0;
  for (const [index, chunk] of upsertChunks.entries()) {
    // Between chunks the fence is released, so an abort lands here or inside
    // the upsert loop (rolling back only the chunk in flight).
    signal.throwIfAborted();
    const changed = await transact((transaction) => upsertEstimates(transaction, chunk, signal));
    written += changed;
    log.info(
      `[moon-wide] upsert chunk ${index + 1}/${upsertChunks.length}: ${chunk.length} rows, ${changed} changed (committed)`,
    );
  }
  let deleted = 0;
  for (const [index, chunk] of reapChunks.entries()) {
    signal.throwIfAborted();
    deleted += await transact((transaction) => reapStaleEstimates(transaction, chunk, signal));
    log.info(`[moon-wide] reap chunk ${index + 1}/${reapChunks.length}: ${chunk.length} rows (committed)`);
  }
  log.info(
    `[moon-wide] published ${written} changed estimate rows (${plan.upserts.length - written} unchanged, left alone), reaped ${deleted} stale rows.`,
  );
  log.info('[moon-wide] done.');
  return {
    coeffVersion: coefficients.coeffVersion,
    planned: plan.upserts.length,
    written,
    deleted,
    skipped: plan.skipped,
  };
}
