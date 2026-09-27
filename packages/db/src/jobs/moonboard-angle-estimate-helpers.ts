/**
 * Planning helpers for `refresh-moonboard-angle-estimates.ts`.
 *
 * Kept apart from the CLI so the decisions worth testing — which climbs get an
 * estimate row, what that row looks like, and which stale rows get reaped —
 * are pure functions with no database in the way.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { boardClimbGrades } from '../schema/app/climb-grades';
import {
  CONFIDENCE,
  MOONBOARD_ANGLE_MODEL_VERSION,
  MOONBOARD_SHALLOW_ANGLE,
  MOONBOARD_STEEP_ANGLE,
  estimateMoonboardGradeAtOtherAngle,
  otherMoonboardAngle,
  type MoonboardAngleCoefficients,
} from '../queries/grade-model';

export const MOONBOARD_BOARD_TYPE = 'moonboard';

/**
 * Widest ± half-band an estimate may publish, in grade points.
 *
 * The play drawer refuses to print a low–high range wider than four grade
 * points (`MAX_PRINTABLE_ESTIMATE_BAND` in
 * packages/mobile/src/components/play-drawer/boardsesh-grade-utils.ts) because
 * past that the range stops informing and starts looking broken. Capping the
 * half-width at two keeps every published band inside what the reader will
 * actually be shown, so a wide band degrades to a wide-but-legible range rather
 * than silently disappearing.
 */
export const MOONBOARD_ANGLE_MAX_BAND_HALF_WIDTH = 2;

/** A MoonBoard problem with a real grade at exactly one of the two angles. */
export interface MoonboardSingleAngleTarget {
  climbUuid: string;
  /** The angle that HAS a real, ascent-backed grade (25 or 40). */
  knownAngle: number;
  knownGrade: number;
}

/** Primary key of a persisted estimate row, minus the constant board type. */
export interface MoonboardAngleEstimateKey {
  climbUuid: string;
  angle: number;
}

export type MoonboardAngleEstimateRow = typeof boardClimbGrades.$inferInsert;

export interface MoonboardAngleEstimatePlan {
  /** One row per estimable target, at the angle the problem is missing. */
  upserts: MoonboardAngleEstimateRow[];
  /** Persisted estimate rows this run no longer stands behind. */
  reaps: MoonboardAngleEstimateKey[];
  /** Targets the model had no usable coefficients for. */
  skipped: number;
}

function estimateKey(climbUuid: string, angle: number): string {
  return `${climbUuid}\0${angle}`;
}

/**
 * The estimate targets: MoonBoard problems that are listed, not drafts, and
 * carry a real ascent-backed grade at exactly ONE of 25°/40°.
 *
 * The known grade reads `difficulty_average`, matching the training sample in
 * moonboard-angle-model.ts (`buildMoonboardDualAngleSampleSql`) — the app's
 * `userGrade` when the community has graded this angle, falling back to the
 * setter's `grade` otherwise. Transposing from whichever value trained the
 * coefficients keeps the two consistent; transposing a setter label through
 * coefficients fit on crowd deltas would quietly mismatch the two.
 *
 * The dual-angle problems are structurally excluded — they already have a real
 * grade at both angles and need nothing estimated — and they are the model's
 * training sample, so the exclusion also keeps the model off its own output.
 * Keyset-paginated on `climb_uuid`; one output row is one climb, so a LIMIT can
 * never split a group.
 */
export function buildMoonboardSingleAngleTargetSql(afterClimbUuid: string, limit: number): SQL {
  return sql`
    SELECT s.climb_uuid,
           MIN(s.angle)::int AS known_angle,
           MIN(s.difficulty_average)::float8 AS known_grade
    FROM board_climb_stats s
    JOIN board_climbs bc ON bc.board_type = s.board_type AND bc.uuid = s.climb_uuid
    WHERE s.board_type = ${MOONBOARD_BOARD_TYPE}
      AND s.angle IN (${MOONBOARD_SHALLOW_ANGLE}, ${MOONBOARD_STEEP_ANGLE})
      AND s.difficulty_average IS NOT NULL
      AND s.ascensionist_count > 0
      AND bc.is_listed = true
      AND COALESCE(bc.is_draft, false) = false
      AND s.climb_uuid > ${afterClimbUuid}
    GROUP BY s.climb_uuid
    HAVING COUNT(*) = 1
    ORDER BY s.climb_uuid
    LIMIT ${limit}
  `;
}

/** Every estimate row this job has already published, so stale ones can be reaped. */
export function buildExistingMoonboardEstimateKeysSql(): SQL {
  return sql`
    SELECT climb_uuid, angle
    FROM board_climb_grades
    WHERE board_type = ${MOONBOARD_BOARD_TYPE}
      AND confidence = ${CONFIDENCE.moonboardAngleEstimate}
  `;
}

/**
 * Turn this run's targets into the rows to write and the rows to remove.
 *
 * A row is written at the angle the problem is MISSING, never at the angle it
 * was graded at — the real grade there is the setter's own and nothing here
 * should overwrite it. `universalGrade` stays null (MoonBoard has no
 * cross-board bridge; see docs/boardsesh-grade.md) and `ascensionistCount` is
 * 0, the same convention `cross_angle_estimate` uses for an angle nobody has
 * climbed.
 *
 * Reaping is the flip side and this job owns it: nothing else ever writes a
 * MoonBoard grade row, so an estimate for a problem that has since been climbed
 * at both angles — or delisted, or lost its grade — would sit there forever.
 * Any persisted estimate key this run did not produce is reaped.
 *
 * Deliberately no publish hysteresis. The nightly EB job holds back small
 * moves because a recomputed posterior jitters night to night; a transposed
 * setter label only moves when the label or the fitted band delta moves, and
 * both are already stable by construction.
 */
export function planMoonboardAngleEstimates(
  targets: readonly MoonboardSingleAngleTarget[],
  coefficients: MoonboardAngleCoefficients,
  existingEstimateKeys: readonly MoonboardAngleEstimateKey[],
  coeffVersion: string,
): MoonboardAngleEstimatePlan {
  const upserts: MoonboardAngleEstimateRow[] = [];
  const wanted = new Set<string>();
  let skipped = 0;

  for (const target of targets) {
    const missingAngle = otherMoonboardAngle(target.knownAngle);
    if (missingAngle === null) {
      skipped += 1;
      continue;
    }
    const estimate = estimateMoonboardGradeAtOtherAngle(target.knownGrade, target.knownAngle, coefficients);
    if (estimate === null) {
      skipped += 1;
      continue;
    }
    const halfBand = Math.min(MOONBOARD_ANGLE_MAX_BAND_HALF_WIDTH, estimate.sd);
    wanted.add(estimateKey(target.climbUuid, missingAngle));
    upserts.push({
      boardType: MOONBOARD_BOARD_TYPE,
      climbUuid: target.climbUuid,
      angle: missingAngle,
      localGrade: estimate.grade,
      universalGrade: null,
      gradeLow: estimate.grade - halfBand,
      gradeHigh: estimate.grade + halfBand,
      confidence: CONFIDENCE.moonboardAngleEstimate,
      ascensionistCount: 0,
      contentPrior: null,
      modelVersion: MOONBOARD_ANGLE_MODEL_VERSION,
      coeffVersion,
    });
  }

  const reaps = existingEstimateKeys.filter((key) => !wanted.has(estimateKey(key.climbUuid, key.angle)));
  return { upserts, reaps, skipped };
}

export interface MoonboardAngleEstimateFlags {
  validateOnly: boolean;
  dryRun: boolean;
  publish: boolean;
}

/**
 * Flat flag parsing, same convention as refresh-climb-grades.ts. `--publish`
 * is off by default: a run with no flags computes and reports, exactly like
 * `--dry-run`, so a mis-scheduled job can never write.
 */
export function parseMoonboardAngleEstimateFlags(argv: readonly string[]): MoonboardAngleEstimateFlags {
  return {
    validateOnly: argv.includes('--validate-only'),
    dryRun: argv.includes('--dry-run'),
    publish: argv.includes('--publish'),
  };
}
