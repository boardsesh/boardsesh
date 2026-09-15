/**
 * EXPERIMENTAL (branch: experiment/moonboard-boardsesh-grade) — planning
 * helpers for `refresh-moonboard-wide-angle-estimates.ts`. See
 * moonboard-wide-angle-model.ts for the estimation math and why this exists.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { boardClimbGrades } from '../src/schema/app/climb-grades.js';
import {
  CONFIDENCE,
  MOONBOARD_SHALLOW_ANGLE,
  MOONBOARD_STEEP_ANGLE,
  estimateMoonboardGradeAtWideAngle,
  pickWideAngleAnchor,
  type GradeCoefficients,
  type MoonboardWideAngleAnchor,
} from '../src/queries/grade-model/index.js';

export const MOONBOARD_WIDE_ANGLE_MODEL_VERSION = 'moonboard-wide-angle-v1';
export const MOONBOARD_BOARD_TYPE = 'moonboard';

/** A MoonBoard climb's known-or-transposed grade at 25° and/or 40°. */
export interface MoonboardWideAngleTarget {
  climbUuid: string;
  grade25: number | null;
  grade25IsReal: boolean;
  grade40: number | null;
  grade40IsReal: boolean;
}

export interface MoonboardWideAngleEstimateKey {
  climbUuid: string;
  angle: number;
}

export type MoonboardWideAngleRow = typeof boardClimbGrades.$inferInsert;

export interface MoonboardWideAngleEstimatePlan {
  upserts: MoonboardWideAngleRow[];
  reaps: MoonboardWideAngleEstimateKey[];
  skipped: number;
}

function estimateKey(climbUuid: string, angle: number): string {
  return `${climbUuid} ${angle}`;
}

/**
 * Every listed, non-draft MoonBoard climb's known grade at 25°/40°: a real
 * ascent-backed value from `board_climb_stats.difficulty_average` where one
 * exists, else the same-board transposed estimate from
 * `board_climb_grades` (confidence = moonboard_angle_estimate). A climb with
 * neither is excluded — there is nothing to anchor a wide-angle estimate on.
 */
export function buildMoonboardWideAngleTargetSql(afterClimbUuid: string, limit: number): SQL {
  return sql`
    SELECT bc.uuid AS climb_uuid,
           COALESCE(s25.difficulty_average, g25.local_grade)::float8 AS grade_25,
           (s25.difficulty_average IS NOT NULL) AS grade_25_is_real,
           COALESCE(s40.difficulty_average, g40.local_grade)::float8 AS grade_40,
           (s40.difficulty_average IS NOT NULL) AS grade_40_is_real
    FROM board_climbs bc
    LEFT JOIN board_climb_stats s25
      ON s25.board_type = ${MOONBOARD_BOARD_TYPE} AND s25.climb_uuid = bc.uuid
      AND s25.angle = ${MOONBOARD_SHALLOW_ANGLE} AND s25.ascensionist_count > 0
      AND s25.difficulty_average IS NOT NULL
    LEFT JOIN board_climb_stats s40
      ON s40.board_type = ${MOONBOARD_BOARD_TYPE} AND s40.climb_uuid = bc.uuid
      AND s40.angle = ${MOONBOARD_STEEP_ANGLE} AND s40.ascensionist_count > 0
      AND s40.difficulty_average IS NOT NULL
    LEFT JOIN board_climb_grades g25
      ON g25.board_type = ${MOONBOARD_BOARD_TYPE} AND g25.climb_uuid = bc.uuid
      AND g25.angle = ${MOONBOARD_SHALLOW_ANGLE} AND g25.confidence = ${CONFIDENCE.moonboardAngleEstimate}
    LEFT JOIN board_climb_grades g40
      ON g40.board_type = ${MOONBOARD_BOARD_TYPE} AND g40.climb_uuid = bc.uuid
      AND g40.angle = ${MOONBOARD_STEEP_ANGLE} AND g40.confidence = ${CONFIDENCE.moonboardAngleEstimate}
    WHERE bc.board_type = ${MOONBOARD_BOARD_TYPE}
      AND bc.is_listed = true
      AND COALESCE(bc.is_draft, false) = false
      AND bc.uuid > ${afterClimbUuid}
      AND (s25.difficulty_average IS NOT NULL OR g25.local_grade IS NOT NULL
        OR s40.difficulty_average IS NOT NULL OR g40.local_grade IS NOT NULL)
    ORDER BY bc.uuid
    LIMIT ${limit}
  `;
}

/** Every estimate row this job has already published, so stale ones can be reaped. */
export function buildExistingMoonboardWideAngleKeysSql(): SQL {
  return sql`
    SELECT climb_uuid, angle
    FROM board_climb_grades
    WHERE board_type = ${MOONBOARD_BOARD_TYPE}
      AND confidence = ${CONFIDENCE.moonboardWideAngleEstimate}
  `;
}

/**
 * Turn this run's targets into rows to write (one per wide angle a climb
 * doesn't already have a real-or-25/40-transposed grade at) and stale rows to
 * remove. Never writes to 25°/40° — those belong to the same-board transpose
 * job or a real ascent, never this one.
 */
export function planMoonboardWideAngleEstimates(
  targets: readonly MoonboardWideAngleTarget[],
  wideAngles: readonly number[],
  coefficients: GradeCoefficients,
  existingEstimateKeys: readonly MoonboardWideAngleEstimateKey[],
  coeffVersion: string,
): MoonboardWideAngleEstimatePlan {
  const upserts: MoonboardWideAngleRow[] = [];
  const wanted = new Set<string>();
  let skipped = 0;

  for (const target of targets) {
    const anchors: MoonboardWideAngleAnchor[] = [];
    if (target.grade25 !== null)
      anchors.push({ angle: MOONBOARD_SHALLOW_ANGLE, grade: target.grade25, isReal: target.grade25IsReal });
    if (target.grade40 !== null)
      anchors.push({ angle: MOONBOARD_STEEP_ANGLE, grade: target.grade40, isReal: target.grade40IsReal });
    if (anchors.length === 0) continue;

    for (const targetAngle of wideAngles) {
      if (targetAngle === MOONBOARD_SHALLOW_ANGLE || targetAngle === MOONBOARD_STEEP_ANGLE) continue;
      const anchor = pickWideAngleAnchor(anchors, targetAngle);
      if (!anchor) {
        skipped += 1;
        continue;
      }
      const estimate = estimateMoonboardGradeAtWideAngle(anchor, targetAngle, coefficients);
      if (!estimate) {
        skipped += 1;
        continue;
      }
      wanted.add(estimateKey(target.climbUuid, targetAngle));
      upserts.push({
        boardType: MOONBOARD_BOARD_TYPE,
        climbUuid: target.climbUuid,
        angle: targetAngle,
        localGrade: estimate.grade,
        universalGrade: null,
        gradeLow: estimate.grade - estimate.halfBand,
        gradeHigh: estimate.grade + estimate.halfBand,
        confidence: CONFIDENCE.moonboardWideAngleEstimate,
        ascensionistCount: 0,
        contentPrior: null,
        modelVersion: MOONBOARD_WIDE_ANGLE_MODEL_VERSION,
        coeffVersion,
      });
    }
  }

  const reaps = existingEstimateKeys.filter((key) => !wanted.has(estimateKey(key.climbUuid, key.angle)));
  return { upserts, reaps, skipped };
}
