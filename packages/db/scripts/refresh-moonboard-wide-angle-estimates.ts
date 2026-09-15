/**
 * MoonBoard wide-angle grade estimate refresh.
 *
 * The `moonboard-wide-angles` feature flag lets a MoonBoard problem be climbed
 * at any angle (0°-70°, 5° steps), not just Moon's own catalog angles
 * (25°/40°). Real community evidence at those wide angles barely exists yet,
 * so unlike `refresh-moonboard-angle-estimates.ts` (which transposes between
 * MoonBoard's own two real angles), this job borrows another crowd-mean
 * board's fitted angle-EFFECT SHAPE and applies it to MoonBoard's own known
 * grade at 25°/40°. See src/queries/grade-model/moonboard-wide-angle-model.ts
 * for the estimator and the cross-board validation behind it. This trades
 * same-board accuracy for immediate coverage on purpose (see the module doc).
 *
 * Run locally: `vp run db:refresh-moonboard-wide-angle-estimates -- --dry-run`
 * Flags: --dry-run (full plan including row shapes, write nothing),
 * --publish (the only flag that writes; off by default).
 */
import { sql } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { boardClimbGrades } from '../src/schema/app/climb-grades.js';
import {
  CONFIDENCE,
  MOONBOARD_WIDE_ANGLE_SHAPE_BOARDS,
  buildAngleSurfaceSql,
  estimateAngleSurface,
  type AngleSurfaceRow,
  type GradeCoefficients,
} from '../src/queries/grade-model/index.js';
import { MOONBOARD_WIDE_ANGLES } from '@boardsesh/board-config';
import { rowsOf } from '../src/queries/util/rows.js';
import {
  MOONBOARD_BOARD_TYPE,
  MOONBOARD_WIDE_ANGLE_MODEL_VERSION,
  buildExistingMoonboardWideAngleKeysSql,
  buildMoonboardWideAngleTargetSql,
  planMoonboardWideAngleEstimates,
  type MoonboardWideAngleEstimateKey,
  type MoonboardWideAngleEstimatePlan,
  type MoonboardWideAngleTarget,
} from './moonboard-wide-angle-estimate-helpers.js';

const READ_PAGE_ROWS = 20000;
const UPSERT_BATCH = 500;
const DELETE_BATCH = 500;
const SAMPLE_ROWS = 5;

type Db = ReturnType<typeof createScriptDb>['db'];
type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];
type DbWriter = Pick<Db, 'execute' | 'insert'> | Pick<DbTransaction, 'execute' | 'insert'>;

async function loadShapeCoefficients(db: Db): Promise<GradeCoefficients> {
  const rows = rowsOf<AngleSurfaceRow>(await db.execute(buildAngleSurfaceSql()));
  const angleOffset = estimateAngleSurface(rows);
  console.log(
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

async function loadTargets(db: Db): Promise<MoonboardWideAngleTarget[]> {
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

async function loadExistingKeys(db: Db): Promise<MoonboardWideAngleEstimateKey[]> {
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
 * moonboard-angle-model.ts's same-board transpose only targets the OTHER of
 * those same two angles. That is a construction-time invariant, not something
 * the schema enforces — if a future job's target angles ever overlap this
 * one's, its upsert would silently overwrite these rows (see
 * deleteStaleGrades's model_version scoping in refresh-climb-grades.ts for the
 * same class of bug on the delete side).
 */
async function upsertEstimates(db: DbWriter, plan: MoonboardWideAngleEstimatePlan): Promise<number> {
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

async function reapStaleEstimates(db: DbWriter, reaps: readonly MoonboardWideAngleEstimateKey[]): Promise<number> {
  let deleted = 0;
  for (let start = 0; start < reaps.length; start += DELETE_BATCH) {
    const batch = reaps.slice(start, start + DELETE_BATCH);
    const keys = batch.map((key) => sql`(${key.climbUuid}, ${key.angle})`);
    await db.execute(sql`
      DELETE FROM board_climb_grades
      WHERE board_type = ${MOONBOARD_BOARD_TYPE}
        AND confidence = ${CONFIDENCE.moonboardWideAngleEstimate}
        AND (climb_uuid, angle) IN (${sql.join(keys, sql`, `)})
    `);
    deleted += batch.length;
  }
  return deleted;
}

function reportPlan(plan: MoonboardWideAngleEstimatePlan): void {
  console.log(
    `[moon-wide] plan: ${plan.upserts.length} estimate rows, ${plan.reaps.length} stale rows to reap, ${plan.skipped} targets skipped (no shape coverage)`,
  );
  for (const row of plan.upserts.slice(0, SAMPLE_ROWS)) {
    console.log(
      `[moon-wide]   ${row.climbUuid} @${row.angle}°: local=${row.localGrade}, band=[${row.gradeLow}, ${row.gradeHigh}], confidence=${row.confidence}`,
    );
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const publish = process.argv.includes('--publish');
  const { db, close } = createScriptDb();
  try {
    const coefficients = await loadShapeCoefficients(db);
    console.log(`[moon-wide] coefficients ${coefficients.coeffVersion} (model ${MOONBOARD_WIDE_ANGLE_MODEL_VERSION})`);

    // Guard mirroring the sibling angle-transpose script's `report.problems`
    // abort: with zero shape coverage, every target would fail
    // estimateMoonboardGradeAtWideAngle and planMoonboardWideAngleEstimates
    // would treat every existing row as "not wanted" — a --publish here would
    // reap the entire table with nothing to replace it. Abort before that
    // plan is ever built, not just when it's reported.
    if (!MOONBOARD_WIDE_ANGLE_SHAPE_BOARDS.some((board) => coefficients.angleOffset[board])) {
      console.error('[moon-wide] no angle-surface coverage from any shape board — nothing written.');
      process.exitCode = 1;
      return;
    }

    const targets = await loadTargets(db);
    const existing = await loadExistingKeys(db);
    console.log(
      `[moon-wide] ${targets.length} climbs with a known 25°/40° grade, ${existing.length} estimate rows already published`,
    );

    const plan = planMoonboardWideAngleEstimates(
      targets,
      MOONBOARD_WIDE_ANGLES,
      coefficients,
      existing,
      coefficients.coeffVersion,
    );
    reportPlan(plan);

    if (!publish) {
      console.log(
        dryRun
          ? '[moon-wide] dry run — no grade rows written.'
          : '[moon-wide] --publish not set — no grade rows written.',
      );
      return;
    }

    const { written, deleted } = await db.transaction(async (tx) => ({
      written: await upsertEstimates(tx, plan),
      deleted: await reapStaleEstimates(tx, plan.reaps),
    }));
    console.log(`[moon-wide] published ${written} estimate rows, reaped ${deleted} stale rows.`);
    console.log('[moon-wide] done.');
  } finally {
    await close();
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error('[moon-wide] failed:', error);
    process.exit(1);
  },
);
