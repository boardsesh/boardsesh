import { sql, type SQL } from 'drizzle-orm';
import {
  ANGLE_CELL_MIN_CLIMBS,
  ANGLE_FIT_MIN_ASCENTS,
  DEFAULT_ECHO_FRACTION,
  DEFAULT_SIGMA_WITHIN,
  DEFAULT_TAU_SQUARED,
  ECHO_FRACTION_CLAMP,
  ECHO_MIN_GRADED_TICKS,
  GRADE_BANDS,
  OFFSET_MIN_GRADED_SENDS_PER_BOARD,
  TAU_SQUARED_CLAMP,
  type GradeBandKey,
} from './constants';

/** SQL CASE mapping a display difficulty to its grade-band key. */
function gradeBandCase(column: SQL): SQL {
  const cases = GRADE_BANDS.map((band) => sql`WHEN ${column} BETWEEN ${band.min} AND ${band.max} THEN ${band.key}`);
  return sql`CASE ${sql.join(cases, sql` `)} ELSE 'v9+' END`;
}

/**
 * Echo-rate raw material, per board: how often graded send ticks state exactly
 * the climb's displayed grade, split by provenance. Restricted to established
 * climbs (≥20 ascents) so "the displayed grade" is a stable reference, and to
 * one row per user/climb/angle (latest) so re-logs don't double count.
 *
 * Provenance comes from `origin`, not the upstream IDs: push-back stamps
 * aurora_id/kilter_id on a native tick while origin stays 'native'
 * (see tickOriginEnum in schema/app/ascents.ts).
 */
export function buildEchoRatesSql(): SQL {
  return sql`
    WITH graded AS (
      SELECT DISTINCT ON (t.user_id, t.board_type, t.climb_uuid, t.angle)
             t.board_type,
             (t.origin = 'native') AS is_native,
             (t.difficulty = round(s.display_difficulty)) AS is_echo
      FROM boardsesh_ticks t
      JOIN board_climb_stats s
        ON s.board_type = t.board_type AND s.climb_uuid = t.climb_uuid AND s.angle = t.angle
      WHERE t.difficulty IS NOT NULL
        AND t.status IN ('flash', 'send')
        AND s.display_difficulty IS NOT NULL
        AND s.ascensionist_count >= 20
      ORDER BY t.user_id, t.board_type, t.climb_uuid, t.angle, t.climbed_at DESC
    )
    SELECT board_type,
           COUNT(*) FILTER (WHERE NOT is_native)::int AS synced_graded,
           COUNT(*) FILTER (WHERE NOT is_native AND is_echo)::int AS synced_echo,
           COUNT(*) FILTER (WHERE is_native)::int AS native_graded,
           COUNT(*) FILTER (WHERE is_native AND is_echo)::int AS native_echo
    FROM graded
    GROUP BY board_type
  `;
}

export interface EchoRateRow {
  board_type: string;
  synced_graded: number;
  synced_echo: number;
  native_graded: number;
  native_echo: number;
}

/**
 * Deconvolve the per-board echo fraction λ (share of upstream logged grades
 * that are quick-log auto-copies, carrying no opinion).
 *
 * Native Boardsesh ticks opt in to grading (grade is optional by design), so
 * their exact-echo rate `a` is honest agreement — a genuine opinion that the
 * label is right. Upstream-synced ticks mix auto-copies with genuine opinions:
 * observed echo rate e = λ + (1−λ)·a, hence λ = (e − a)/(1 − a). Boards with
 * too few native ticks borrow the pooled agreement rate; boards with too few
 * synced ticks fall back to DEFAULT_ECHO_FRACTION.
 */
export function estimateEchoFractions(rows: EchoRateRow[]): Record<string, number> {
  const pooledNative = rows.reduce(
    (acc, row) => ({ graded: acc.graded + row.native_graded, echo: acc.echo + row.native_echo }),
    { graded: 0, echo: 0 },
  );
  const pooledAgreement = pooledNative.graded >= ECHO_MIN_GRADED_TICKS ? pooledNative.echo / pooledNative.graded : null;

  const result: Record<string, number> = {};
  for (const row of rows) {
    if (row.synced_graded < ECHO_MIN_GRADED_TICKS) {
      result[row.board_type] = DEFAULT_ECHO_FRACTION;
      continue;
    }
    const agreement =
      row.native_graded >= ECHO_MIN_GRADED_TICKS ? row.native_echo / row.native_graded : pooledAgreement;
    const observedEcho = row.synced_echo / row.synced_graded;
    if (agreement === null || agreement >= 1) {
      result[row.board_type] = DEFAULT_ECHO_FRACTION;
      continue;
    }
    const lambda = (observedEcho - agreement) / (1 - agreement);
    result[row.board_type] = Math.min(ECHO_FRACTION_CLAMP[1], Math.max(ECHO_FRACTION_CLAMP[0], lambda));
  }
  return result;
}

/**
 * σ_within raw material: dispersion of genuinely expressed grades around the
 * established crowd mean, per board × grade band. "Expressed" = native graded
 * ticks (opt-in ⇒ intentional, echo included as honest agreement) plus synced
 * non-echo ticks (synced echoes are probable auto-fills, not opinions).
 * Aggregated per user first so a single power user can't set the variance.
 */
export function buildSigmaWithinSql(): SQL {
  return sql`
    WITH expressed AS (
      SELECT DISTINCT ON (t.user_id, t.board_type, t.climb_uuid, t.angle)
             t.board_type,
             t.user_id,
             ${gradeBandCase(sql`s.display_difficulty`)} AS grade_band,
             (t.difficulty - s.difficulty_average) AS deviation
      FROM boardsesh_ticks t
      JOIN board_climb_stats s
        ON s.board_type = t.board_type AND s.climb_uuid = t.climb_uuid AND s.angle = t.angle
      WHERE t.difficulty IS NOT NULL
        AND t.status IN ('flash', 'send')
        AND s.difficulty_average IS NOT NULL
        AND s.display_difficulty IS NOT NULL
        AND s.ascensionist_count >= 20
        AND (
          t.origin = 'native'
          OR t.difficulty <> round(s.display_difficulty)
        )
      ORDER BY t.user_id, t.board_type, t.climb_uuid, t.angle, t.climbed_at DESC
    ),
    per_user AS (
      SELECT board_type, grade_band, user_id,
             AVG(deviation * deviation) AS mean_sq_dev,
             COUNT(*) AS n_ticks
      FROM expressed
      GROUP BY board_type, grade_band, user_id
      HAVING COUNT(*) >= 3
    )
    SELECT board_type, grade_band,
           AVG(mean_sq_dev) AS mean_sq_deviation,
           COUNT(*)::int AS n_users
    FROM per_user
    GROUP BY board_type, grade_band
  `;
}

export interface SigmaWithinRow {
  board_type: string;
  grade_band: GradeBandKey;
  mean_sq_deviation: number;
  n_users: number;
}

export function estimateSigmaWithin(rows: SigmaWithinRow[]): Record<string, Record<GradeBandKey, number>> {
  const result: Record<string, Record<GradeBandKey, number>> = {};
  for (const row of rows) {
    if (row.n_users < 10) continue;
    const sigma = Math.sqrt(Math.max(0.01, Number(row.mean_sq_deviation)));
    (result[row.board_type] ??= {} as Record<GradeBandKey, number>)[row.grade_band] = sigma;
  }
  // Bands without support inherit the board's average, then the global default.
  for (const perBand of Object.values(result)) {
    const known = Object.values(perBand);
    const boardMean = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : DEFAULT_SIGMA_WITHIN;
    for (const band of GRADE_BANDS) {
      perBand[band.key] ??= boardMean;
    }
  }
  return result;
}

/**
 * Angle-surface raw material: within-climb deviation of each angle's crowd
 * mean from the climb's own cross-angle mean, per board × band × angle. Only
 * climbs with ≥2 angles at ≥ANGLE_FIT_MIN_ASCENTS ascents contribute, so the
 * curve measures re-grading of a fixed climb, not which climbs exist per angle.
 */
export function buildAngleSurfaceSql(): SQL {
  return sql`
    WITH qualifying AS (
      SELECT s.board_type, s.climb_uuid, s.angle, s.difficulty_average,
             ${gradeBandCase(sql`AVG(s.display_difficulty) OVER (PARTITION BY s.board_type, s.climb_uuid)`)} AS grade_band,
             AVG(s.difficulty_average) OVER (PARTITION BY s.board_type, s.climb_uuid) AS climb_mean,
             COUNT(*) OVER (PARTITION BY s.board_type, s.climb_uuid) AS n_angles
      FROM board_climb_stats s
      WHERE s.ascensionist_count >= ${ANGLE_FIT_MIN_ASCENTS}
        AND s.difficulty_average IS NOT NULL
        AND s.display_difficulty IS NOT NULL
    )
    SELECT board_type, grade_band, angle,
           AVG(difficulty_average - climb_mean) AS offset_from_climb_mean,
           COUNT(*)::int AS n_climbs
    FROM qualifying
    WHERE n_angles >= 2
    GROUP BY board_type, grade_band, angle
  `;
}

export interface AngleSurfaceRow {
  board_type: string;
  grade_band: GradeBandKey;
  angle: number;
  offset_from_climb_mean: number;
  n_climbs: number;
}

export function estimateAngleSurface(
  rows: AngleSurfaceRow[],
): Record<string, Partial<Record<GradeBandKey | 'all', Record<number, number>>>> {
  const result: Record<string, Partial<Record<GradeBandKey | 'all', Record<number, number>>>> = {};
  // Band-agnostic fallback: n-weighted mean across bands per (board, angle).
  const allAccumulator = new Map<string, { weighted: number; n: number }>();
  for (const row of rows) {
    const offset = Number(row.offset_from_climb_mean);
    if (row.n_climbs >= ANGLE_CELL_MIN_CLIMBS) {
      const perBoard = (result[row.board_type] ??= {});
      ((perBoard[row.grade_band] ??= {}) as Record<number, number>)[row.angle] = offset;
    }
    const key = `${row.board_type} ${row.angle}`;
    const acc = allAccumulator.get(key) ?? { weighted: 0, n: 0 };
    acc.weighted += offset * row.n_climbs;
    acc.n += row.n_climbs;
    allAccumulator.set(key, acc);
  }
  for (const [key, acc] of allAccumulator) {
    if (acc.n < ANGLE_CELL_MIN_CLIMBS) continue;
    const [boardType, angleText] = key.split(' ');
    const perBoard = (result[boardType] ??= {});
    ((perBoard.all ??= {}) as Record<number, number>)[Number(angleText)] = acc.weighted / acc.n;
  }
  return result;
}

/**
 * τ² raw material: multi-angle head climbs (every listed angle ≥20 ascents)
 * whose target-angle crowd mean we can try to predict from the other angles.
 * τ² is then the variance of that prediction error — the honest uncertainty of
 * the cross-angle prior. Computed in TS (needs the fitted angle surface).
 */
export function buildTauSampleSql(): SQL {
  return sql`
    WITH head AS (
      SELECT s.board_type, s.climb_uuid, s.angle, s.difficulty_average, s.display_difficulty, s.ascensionist_count,
             COUNT(*) OVER (PARTITION BY s.board_type, s.climb_uuid) AS n_angles
      FROM board_climb_stats s
      WHERE s.ascensionist_count >= 20
        AND s.difficulty_average IS NOT NULL
    )
    SELECT board_type, climb_uuid, angle, difficulty_average, display_difficulty, ascensionist_count
    FROM head
    WHERE n_angles >= 2
    ORDER BY board_type, climb_uuid, angle
  `;
}

export interface TauSampleRow {
  board_type: string;
  climb_uuid: string;
  angle: number;
  difficulty_average: number;
  display_difficulty: number | null;
  ascensionist_count: number;
}

/**
 * Leave-one-angle-out prediction error variance per board × band, using the
 * frozen angle surface: predict each head angle from its siblings, take the
 * variance of the residuals. Falls back to DEFAULT_TAU_SQUARED where thin.
 */
export function estimateTauSquared(
  rows: TauSampleRow[],
  angleOffset: Record<string, Partial<Record<GradeBandKey | 'all', Record<number, number>>>>,
): Record<string, Record<GradeBandKey, number>> {
  const lookupOffset = (boardType: string, band: GradeBandKey, angle: number): number => {
    const surface = angleOffset[boardType];
    return surface?.[band]?.[angle] ?? surface?.all?.[angle] ?? 0;
  };

  // Group rows per climb (input is ordered by board, climb).
  const residuals = new Map<string, number[]>();
  let group: TauSampleRow[] = [];
  const flush = () => {
    if (group.length < 2) {
      group = [];
      return;
    }
    for (const target of group) {
      let weightedSum = 0;
      let weightTotal = 0;
      for (const sibling of group) {
        if (sibling.angle === target.angle) continue;
        const band = gradeBandFor(sibling);
        weightedSum +=
          (sibling.difficulty_average - lookupOffset(sibling.board_type, band, sibling.angle)) *
          sibling.ascensionist_count;
        weightTotal += sibling.ascensionist_count;
      }
      if (weightTotal <= 0) continue;
      const targetBand = gradeBandFor(target);
      const predicted = weightedSum / weightTotal + lookupOffset(target.board_type, targetBand, target.angle);
      const key = `${target.board_type} ${targetBand}`;
      (residuals.get(key) ?? residuals.set(key, []).get(key)!).push(target.difficulty_average - predicted);
    }
    group = [];
  };
  const gradeBandFor = (row: TauSampleRow): GradeBandKey => {
    const difficulty = row.display_difficulty ?? row.difficulty_average;
    for (const band of GRADE_BANDS) {
      if (difficulty >= band.min && difficulty <= band.max) return band.key;
    }
    return 'v9+';
  };
  for (const row of rows) {
    const last = group[group.length - 1];
    if (last && (last.board_type !== row.board_type || last.climb_uuid !== row.climb_uuid)) flush();
    group.push(row);
  }
  flush();

  const result: Record<string, Record<GradeBandKey, number>> = {};
  for (const [key, values] of residuals) {
    if (values.length < 30) continue;
    const [boardType, band] = key.split(' ') as [string, GradeBandKey];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (values.length - 1);
    (result[boardType] ??= {} as Record<GradeBandKey, number>)[band] = Math.min(
      TAU_SQUARED_CLAMP[1],
      Math.max(TAU_SQUARED_CLAMP[0], variance),
    );
  }
  for (const perBand of Object.values(result)) {
    const known = Object.values(perBand);
    const boardMean = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : DEFAULT_TAU_SQUARED;
    for (const band of GRADE_BANDS) {
      perBand[band.key] ??= boardMean;
    }
  }
  return result;
}

/**
 * Cross-board offset raw material: per-user median graded-send difficulty on
 * Kilter and Tension, for users with ≥OFFSET_MIN_GRADED_SENDS_PER_BOARD graded
 * sends on each. The offset compares which labels the same person sends, so
 * echoed grades are fine here — they still identify the climb's label.
 */
export function buildBoardOffsetSampleSql(): SQL {
  return sql`
    WITH per_board AS (
      SELECT user_id, board_type,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY difficulty) AS median_grade,
             COUNT(*) AS n
      FROM boardsesh_ticks
      WHERE difficulty IS NOT NULL
        AND status IN ('flash', 'send')
        AND board_type IN ('kilter', 'tension')
      GROUP BY user_id, board_type
      HAVING COUNT(*) >= ${OFFSET_MIN_GRADED_SENDS_PER_BOARD}
    )
    SELECT k.user_id,
           k.median_grade AS kilter_median,
           t.median_grade AS tension_median,
           k.n AS kilter_n,
           t.n AS tension_n
    FROM per_board k
    JOIN per_board t ON t.user_id = k.user_id AND t.board_type = 'tension'
    WHERE k.board_type = 'kilter'
  `;
}

export interface BoardOffsetSampleRow {
  user_id: string;
  kilter_median: number;
  tension_median: number;
  kilter_n: number;
  tension_n: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Kilter→universal offset: median over shared users of (tension − kilter)
 * median sent grade (negative ≈ Kilter reads soft), with SD and the
 * leave-one-user-out max delta the publish gate checks. Tension is the anchor
 * (offset 0 by definition).
 */
export function estimateBoardOffsets(rows: BoardOffsetSampleRow[]): {
  kilter: { offset: number; sd: number; users: number; looMaxDelta: number } | null;
} {
  if (rows.length < 20) return { kilter: null };
  const gaps = rows.map((row) => Number(row.tension_median) - Number(row.kilter_median));
  const offset = median(gaps);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (gaps.length - 1));
  let looMaxDelta = 0;
  for (let i = 0; i < gaps.length; i++) {
    const rest = gaps.slice(0, i).concat(gaps.slice(i + 1));
    looMaxDelta = Math.max(looMaxDelta, Math.abs(median(rest) - offset));
  }
  return { kilter: { offset, sd, users: gaps.length, looMaxDelta } };
}
