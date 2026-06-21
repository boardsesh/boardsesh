import { sql, type SQL } from 'drizzle-orm';
import type { RecommendationQueryParams } from './types';

/** Postgres int[] literal, safe for empty arrays (`&&` against `{}` is false). */
function intArray(ids: number[]): SQL {
  if (ids.length === 0) return sql`ARRAY[]::int[]`;
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::int[]`;
}

type QueryParts = {
  /** FROM board_climbs + the stats/setter/send joins. */
  from: SQL;
  /** WHERE conditions (base + size + sets + exclusions + variant). */
  where: SQL;
  /** Ranking expression (ORDER BY ... DESC). */
  orderBy: SQL;
};

/**
 * Build the shared FROM/WHERE/ORDER for a recommendation variant. The stats join
 * is INNER for every variant except FRESH (brand-new climbs may have no stats
 * row yet, so we LEFT-join and let setter popularity carry the ranking).
 */
function buildParts(params: RecommendationQueryParams): QueryParts {
  const { type, target, shorterSizeIds, narrowerSameHeightSizeIds, gradeBand, excludeUserId, freshWindowDays } = params;
  const { boardType, layoutId, sizeId, angle, setIds } = target;

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

  const conditions: SQL[] = [
    sql`bc.board_type = ${boardType}`,
    sql`bc.layout_id = ${layoutId}`,
    sql`bc.is_listed = true`,
    sql`bc.is_draft = false`,
    // `@>` (rather than `= ANY`) so the GIN index on compatible_size_ids applies.
    sql`bc.compatible_size_ids @> ${intArray([sizeId])}`,
  ];

  // Only recommend climbs the owner can actually build with their sets.
  if (setIds && setIds.length > 0) {
    conditions.push(sql`bc.required_set_ids <@ ${intArray(setIds)}`);
  }

  // "Find NEW climbs" — drop ones the user has already sent at this angle.
  if (excludeUserId) {
    conditions.push(sql`NOT EXISTS (
      SELECT 1 FROM boardsesh_ticks t
      WHERE t.user_id = ${excludeUserId}
        AND t.board_type = bc.board_type
        AND t.climb_uuid = bc.uuid
        AND t.angle = ${angle}
        AND t.status IN ('flash', 'send')
    )`);
  }

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
    case 'RECOMMENDED_CROWD_FAVORITES': {
      conditions.push(sql`COALESCE(s.quality_average, 0) >= 4.0`);
      conditions.push(sql`COALESCE(s.ascensionist_count, 0) >= 20`);
      orderBy = sql`${popularity} * ${quality} * ${fullness} * ${sendBoost} * ${setterLight} DESC, s.ascensionist_count DESC NULLS LAST`;
      break;
    }
    case 'RECOMMENDED_HIDDEN_GEMS': {
      conditions.push(sql`COALESCE(s.quality_average, 0) >= 4.5`);
      conditions.push(sql`COALESCE(s.ascensionist_count, 0) BETWEEN 5 AND 50`);
      orderBy = sql`${quality} * ${fullness} * ${sendBoost} DESC, s.ascensionist_count DESC NULLS LAST`;
      break;
    }
    case 'RECOMMENDED_AT_LEVEL': {
      // Callers must resolve the grade band before requesting this type (a null
      // band means "no graded sends" and the card should be hidden upstream).
      if (!gradeBand) {
        throw new Error('RECOMMENDED_AT_LEVEL requires a gradeBand');
      }
      const band = gradeBand;
      conditions.push(sql`COALESCE(s.quality_average, 0) >= 4.0`);
      conditions.push(sql`COALESCE(s.ascensionist_count, 0) >= 10`);
      conditions.push(
        sql`ROUND(s.display_difficulty::numeric, 0) BETWEEN ${band.minDifficultyId} AND ${band.maxDifficultyId}`,
      );
      orderBy = sql`${quality} * ${popularity} * ${fullness} DESC, s.ascensionist_count DESC NULLS LAST`;
      break;
    }
    case 'RECOMMENDED_FRESH': {
      // published_at is free-text; only cast rows that look like an ISO date so a
      // single malformed value can't error the whole query / nightly refresh.
      conditions.push(sql`bc.published_at ~ '^\\d{4}-\\d{2}-\\d{2}'`);
      conditions.push(sql`bc.published_at::timestamptz > now() - make_interval(days => ${freshWindowDays})`);
      // Setter popularity is the primary lever (new climbs have few ascents),
      // then recency, then community rating.
      orderBy = sql`COALESCE(ss.setter_score, 0) DESC, NULLIF(bc.published_at, '')::timestamptz DESC, ${quality} DESC`;
      break;
    }
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

/** Total candidate count for a recommendation variant (for paging + cards). */
export function buildRecommendationCountSql(params: RecommendationQueryParams): SQL {
  const { from, where } = buildParts(params);
  return sql`SELECT COUNT(*)::int AS count ${from} WHERE ${where}`;
}
