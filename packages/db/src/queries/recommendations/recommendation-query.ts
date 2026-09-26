import { sql, type SQL } from 'drizzle-orm';
import type { RecommendationQueryParams, RecommendationType } from './types';

/** Postgres int[] literal, safe for empty arrays (`&&` against `{}` is false). */
function intArray(ids: number[]): SQL {
  if (ids.length === 0) return sql`ARRAY[]::int[]`;
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::int[]`;
}

/**
 * The per-angle stats bounds a variant filters on. Kept as data rather than SQL
 * so the same bounds render two ways: `COALESCE(s.x, 0) >= n` for the catalog-
 * driven plans (unchanged since they shipped), and a plain `s.x >= n` that the
 * stats-driven count can use as an index range on `board_climb_stats`.
 */
export type RecommendationStatsBounds = {
  minQuality: number;
  minAscents: number;
  maxAscents?: number;
  difficultyBand?: { minDifficultyId: number; maxDifficultyId: number };
};

type QueryParts = {
  /** FROM board_climbs + the stats/setter/send joins. */
  from: SQL;
  /** WHERE conditions (base + size + sets + exclusions + variant). */
  where: SQL;
  /** Ranking expression (ORDER BY ... DESC). */
  orderBy: SQL;
};

/** Variants whose count is driven from `board_climb_stats` (see `buildRecommendationCountSql`). */
const STATS_DRIVEN_COUNT_TYPES: ReadonlySet<RecommendationType> = new Set([
  'RECOMMENDED_CROWD_FAVORITES',
  'RECOMMENDED_AT_LEVEL',
]);

function statsBoundsFor(params: RecommendationQueryParams): RecommendationStatsBounds | null {
  switch (params.type) {
    case 'RECOMMENDED_CROWD_FAVORITES':
      return { minQuality: 4.0, minAscents: 20 };
    case 'RECOMMENDED_HIDDEN_GEMS':
      return { minQuality: 4.5, minAscents: 5, maxAscents: 50 };
    case 'RECOMMENDED_AT_LEVEL': {
      // Callers must resolve the grade band before requesting this type (a null
      // band means "no graded sends" and the card should be hidden upstream).
      if (!params.gradeBand) {
        throw new Error('RECOMMENDED_AT_LEVEL requires a gradeBand');
      }
      return { minQuality: 4.0, minAscents: 10, difficultyBand: params.gradeBand };
    }
    case 'RECOMMENDED_FRESH':
      return null;
  }
}

/**
 * Stats predicates on alias `s`. `sargable` drops the COALESCE wrappers, which is
 * only equivalent while every lower bound is above zero: `COALESCE(NULL, 0) >= n`
 * and `NULL >= n` are both not-true for n > 0, and differ for n <= 0. The throw
 * keeps a future variant with a zero bound from silently changing its count.
 */
export function recommendationStatsConditions(bounds: RecommendationStatsBounds, sargable: boolean): SQL[] {
  if (sargable && (bounds.minQuality <= 0 || bounds.minAscents <= 0)) {
    throw new Error('Sargable recommendation stats bounds need lower bounds above zero');
  }
  const quality = sargable ? sql`s.quality_average` : sql`COALESCE(s.quality_average, 0)`;
  const ascents = sargable ? sql`s.ascensionist_count` : sql`COALESCE(s.ascensionist_count, 0)`;
  const conditions: SQL[] = [sql`${quality} >= ${bounds.minQuality}`];
  conditions.push(
    bounds.maxAscents === undefined
      ? sql`${ascents} >= ${bounds.minAscents}`
      : sql`${ascents} BETWEEN ${bounds.minAscents} AND ${bounds.maxAscents}`,
  );
  if (bounds.difficultyBand) {
    conditions.push(
      sql`ROUND(s.display_difficulty::numeric, 0) BETWEEN ${bounds.difficultyBand.minDifficultyId} AND ${bounds.difficultyBand.maxDifficultyId}`,
    );
  }
  return conditions;
}

/**
 * The `board_climbs` half of the filter, shared by every shape: base listing
 * rules, size and sets, and FRESH's publication window. Nothing here reads
 * `board_climb_stats` or the viewer.
 */
function catalogConditions(params: RecommendationQueryParams): SQL[] {
  const { type, target, freshWindowDays } = params;
  const { boardType, layoutId, sizeId, setIds } = target;

  const conditions: SQL[] = [
    sql`bc.board_type = ${boardType}`,
    sql`bc.layout_id = ${layoutId}`,
    sql`bc.is_listed = true`,
    sql`bc.is_draft = false`,
    // Recommendations are a browse surface: a climb the community hid never gets
    // suggested, on any variant.
    sql`bc.is_hidden = false`,
    // `@>` (rather than `= ANY`) so the GIN index on compatible_size_ids applies.
    sql`bc.compatible_size_ids @> ${intArray([sizeId])}`,
  ];

  // Only recommend climbs the owner can actually build with their sets.
  if (setIds && setIds.length > 0) {
    conditions.push(sql`bc.required_set_ids <@ ${intArray(setIds)}`);
  }

  if (type === 'RECOMMENDED_FRESH') {
    // published_at is free-text; only cast rows that look like an ISO date so a
    // single malformed value can't error the whole query / nightly refresh.
    conditions.push(sql`bc.published_at ~ '^\\d{4}-\\d{2}-\\d{2}'`);
    conditions.push(sql`bc.published_at::timestamptz > now() - make_interval(days => ${freshWindowDays})`);
  }

  return conditions;
}

/** "Find NEW climbs": the user has not sent this climb at the target angle. */
function notSentByCondition(userId: string, angle: number): SQL {
  return sql`NOT EXISTS (
      SELECT 1 FROM boardsesh_ticks t
      WHERE t.user_id = ${userId}
        AND t.board_type = bc.board_type
        AND t.climb_uuid = bc.uuid
        AND t.angle = ${angle}
        AND t.status IN ('flash', 'send')
    )`;
}

/**
 * Build the shared FROM/WHERE/ORDER for a recommendation variant. The stats join
 * is INNER for every variant except FRESH (brand-new climbs may have no stats
 * row yet, so we LEFT-join and let setter popularity carry the ranking).
 */
function buildParts(params: RecommendationQueryParams): QueryParts {
  const { type, target, shorterSizeIds, narrowerSameHeightSizeIds, excludeUserId } = params;
  const { angle } = target;

  const isFresh = type === 'RECOMMENDED_FRESH';
  const statsJoin = isFresh ? sql`LEFT JOIN` : sql`JOIN`;

  const from = sql`
    FROM board_climbs bc
    ${statsJoin} board_climb_stats s
      ON s.board_type = bc.board_type AND s.climb_uuid = bc.uuid AND s.angle = ${angle}
    LEFT JOIN board_setter_stats ss
      ON ss.board_type = bc.board_type AND ss.setter_username = bc.setter_username
    LEFT JOIN board_climb_send_stats sd
      ON sd.board_type = bc.board_type AND sd.climb_uuid = bc.uuid
  `;

  const conditions = catalogConditions(params);
  if (excludeUserId) conditions.push(notSentByCondition(excludeUserId, angle));
  const bounds = statsBoundsFor(params);
  if (bounds) conditions.push(...recommendationStatsConditions(bounds, false));

  // Reusable score fragments.
  const popularity = sql`LN(COALESCE(s.ascensionist_count, 0) + 1)`;
  const quality = sql`COALESCE(s.quality_average, 0)`;
  const fullness = sql`CASE
    WHEN bc.compatible_size_ids && ${intArray(shorterSizeIds)} THEN 0.3
    WHEN bc.compatible_size_ids && ${intArray(narrowerSameHeightSizeIds)} THEN 0.6
    ELSE 1.0 END`;
  const sendBoost = sql`(1 + 0.5 * LN(COALESCE(sd.send_count_30d, 0) + 1))`;
  const setterLight = sql`(1 + 0.15 * LN(COALESCE(ss.setter_score, 0) + 1))`;

  let orderBy: SQL;

  switch (type) {
    case 'RECOMMENDED_CROWD_FAVORITES':
      orderBy = sql`${popularity} * ${quality} * ${fullness} * ${sendBoost} * ${setterLight} DESC, s.ascensionist_count DESC NULLS LAST`;
      break;
    case 'RECOMMENDED_HIDDEN_GEMS':
      orderBy = sql`${quality} * ${fullness} * ${sendBoost} DESC, s.ascensionist_count DESC NULLS LAST`;
      break;
    case 'RECOMMENDED_AT_LEVEL':
      orderBy = sql`${quality} * ${popularity} * ${fullness} DESC, s.ascensionist_count DESC NULLS LAST`;
      break;
    case 'RECOMMENDED_FRESH':
      // Setter popularity is the primary lever (new climbs have few ascents),
      // then recency, then community rating.
      orderBy = sql`COALESCE(ss.setter_score, 0) DESC, NULLIF(bc.published_at, '')::timestamptz DESC, ${quality} DESC`;
      break;
  }

  return { from, where: sql.join(conditions, sql` AND `), orderBy };
}

/**
 * Ranked page of `(climb_uuid, board_type)` refs for a recommendation variant.
 * Execute with `db.execute(...)` and hydrate the refs with the board's angle.
 */
export function buildRecommendationRefsSql(params: RecommendationQueryParams, page: number, pageSize: number): SQL {
  const { from, where, orderBy } = buildParts(params);
  const offset = page * pageSize;
  return sql`
    SELECT bc.uuid AS climb_uuid, bc.board_type AS board_type
    ${from}
    WHERE ${where}
    ORDER BY ${orderBy}, bc.uuid
    LIMIT ${pageSize} OFFSET ${offset}
  `;
}

/**
 * Candidate count for a recommendation variant, with the viewer's sends
 * excluded when `params.excludeUserId` is set (the playlist hero and paging).
 *
 * CROWD and AT_LEVEL are driven from `board_climb_stats`: a MATERIALIZED CTE
 * picks the qualifying stats rows at the angle through the stats index, then
 * joins them to `board_climbs`. Joined the other way round, the planner
 * estimates the size/set array predicates at ~8.6k rows when the real slice is
 * ~283k, and heap-scans nearly the whole layout for every count. The CTE does
 * not always fix that: it too is misestimated (~11k rows for CROWD at Kilter 40°
 * when ~385 qualify), so on some configs the planner still hash-joins the whole
 * slice. Replica, warm, viewer excluded: AT_LEVEL on Kilter 1/10 {1,20} 46.7k ->
 * 4.4k buffers and the Kilter homewall 117k -> 21k, but CROWD on Kilter 1/10
 * {1,20} only 47k -> 43k. The card count is cached (`rec-count`), so there
 * only a miss pays this; the playlist hero count pays it every time.
 * HIDDEN_GEMS stays catalog-driven: its 5-50 ascent range is wide enough that
 * the CTE read 2.5x more buffers than the shipped plan.
 *
 * The ranked query's setter/send LEFT JOINs are left out: both join on a unique
 * key and no count reads a column from them, so they cannot change the number
 * (the planner already removed them).
 */
export function buildRecommendationCountSql(params: RecommendationQueryParams): SQL {
  const { angle, boardType } = params.target;
  const conditions = catalogConditions(params);
  if (params.excludeUserId) conditions.push(notSentByCondition(params.excludeUserId, angle));
  const bounds = statsBoundsFor(params);

  if (bounds && STATS_DRIVEN_COUNT_TYPES.has(params.type)) {
    return sql`
      WITH cand AS MATERIALIZED (
        SELECT s.climb_uuid FROM board_climb_stats s
        WHERE s.board_type = ${boardType} AND s.angle = ${angle}
          AND ${sql.join(recommendationStatsConditions(bounds, true), sql` AND `)}
      )
      SELECT COUNT(*)::int AS count
      FROM cand JOIN board_climbs bc ON bc.uuid = cand.climb_uuid
      WHERE ${sql.join(conditions, sql` AND `)}
    `;
  }

  if (bounds) conditions.push(...recommendationStatsConditions(bounds, false));
  return sql`
    SELECT COUNT(*)::int AS count
    FROM board_climbs bc
    ${bounds ? sql`JOIN` : sql`LEFT JOIN`} board_climb_stats s
      ON s.board_type = bc.board_type AND s.climb_uuid = bc.uuid AND s.angle = ${angle}
    WHERE ${sql.join(conditions, sql` AND `)}
  `;
}

/**
 * How many of a variant's candidates `userId` has already sent (flash/send) at
 * the target angle.
 *
 * `buildRecommendationCountSql` without `excludeUserId`, minus this, is exactly
 * the count with it: the viewer-free count is |S|, this is |S ∩ sent|, and the
 * NOT EXISTS form is |S \ sent|. `board_climbs.uuid` is the primary key and the
 * stats join is on the stats primary key, so each candidate counts at most once.
 *
 * It is driven from the viewer's own ticks, so it costs a few primary-key probes
 * per distinct sent climb instead of a scan of the layout. That is what lets the
 * viewer-free half be cached across users (`rec-count` in the backend).
 *
 * FRESH has no stats bounds, so it skips the stats join entirely: a LEFT JOIN on
 * the stats primary key reads no column and cannot change the count.
 */
export function buildRecommendationSentOverlapSql(params: RecommendationQueryParams, userId: string): SQL {
  const { angle, boardType } = params.target;
  const conditions = catalogConditions(params);
  const bounds = statsBoundsFor(params);
  if (bounds) conditions.push(...recommendationStatsConditions(bounds, false));
  return sql`
    SELECT COUNT(*)::int AS count
    FROM (
      SELECT DISTINCT t.climb_uuid FROM boardsesh_ticks t
      WHERE t.user_id = ${userId}
        AND t.board_type = ${boardType}
        AND t.angle = ${angle}
        AND t.status IN ('flash', 'send')
    ) sent
    JOIN board_climbs bc ON bc.uuid = sent.climb_uuid
    ${
      bounds
        ? sql`JOIN board_climb_stats s
      ON s.board_type = bc.board_type AND s.climb_uuid = bc.uuid AND s.angle = ${angle}`
        : sql``
    }
    WHERE ${sql.join(conditions, sql` AND `)}
  `;
}
