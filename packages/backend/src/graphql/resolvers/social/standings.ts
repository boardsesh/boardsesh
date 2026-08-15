import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import {
  isRankedBoardType,
  parseLayoutScopeKey,
  scopeDefinition,
  scopeToId,
  type ScopeKind,
} from '@boardsesh/leaderboard';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { anonymousClimberId, applyRateLimit, validateInput } from '../shared/helpers';
import { StandingsInputSchema } from '../../../validation/schemas/standings';
import { getCachedStandings, setCachedStandings, standingsCacheKey } from './standings-cache';

/**
 * Standings — ranked leaderboards over a rolling window.
 *
 * Three properties of the ranking are load-bearing; changing any of them
 * changes what the product is:
 *
 * 1. **DISTINCT climbs, not tick rows.** Production holds 41,598 excess
 *    same-day repeat rows, so a row count made re-logging the cheapest route up.
 * 2. **A per-day cap** at the measured 99th percentile of climbs-per-day
 *    (p50 4, p90 12, p99 25, max 373) — it never touches a real session but
 *    bounds what a script buys.
 * 3. **Rolling windows only, never all-time.** 69.4% of the tick history is a
 *    frozen bulk import whose newest row is 2026-03-26, so an all-time board
 *    would rank whoever uploaded a file — and no rolling window can reach it.
 *
 * Written as raw SQL rather than the query builder, matching
 * `computeBoardPresenceStats`: it needs a window function over a grouped
 * subquery over a per-day ROW_NUMBER cap, which the builder cannot express.
 * The scope predicates stay composable `SQL` fragments so adding a granularity
 * is still a one-place change.
 */

/** Above the 99th percentile of climbs logged in a single day. */
const MAX_SCORED_CLIMBS_PER_DAY = 30;

const WINDOW_DAYS = { week: 7, month: 30 } as const;

type StandingsRow = {
  user_id: string;
  score: number;
  rank: number;
  tie_size: number;
  percentile: number;
  total_count: number;
  display_name: string | null;
  avatar_url: string | null;
  is_anonymous: boolean;
};

type ViewerRow = {
  rank: number;
  score: number;
  tie_size: number;
  percentile: number;
  scores_above: number[] | null;
};

type StandingsScopeResult = { kind: ScopeKind; key: string; label: string; climberCount: number };

type StandingsEntryResult = {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  isAnonymous: boolean;
  rank: number;
  tieSize: number;
  score: number;
  hardestGrade: number | null;
  isViewer: boolean;
};

type StandingsResult = {
  requestedScope: StandingsScopeResult;
  resolvedScope: StandingsScopeResult;
  demotionReason: 'empty' | 'unknownScope' | null;
  entries: StandingsEntryResult[];
  totalCount: number;
  hasMore: boolean;
  viewer: { rank: number; score: number; tieSize: number; percentile: number; scoresAbove: number[] } | null;
  coverage: number;
};

/**
 * Rows that never appear in any ranking, whatever the scope. Written against
 * the `t` / `u` / `up` aliases the queries below use.
 *
 * The `json_import` exclusion is belt-and-braces — a rolling window already
 * cannot reach that corpus — but it keeps the intent explicit for whoever later
 * adds a longer window.
 */
function baseTickPredicate(windowDays: number): SQL {
  return sql`
    t.status IN ('flash','send')
    AND t.origin <> 'json_import'
    AND t.climbed_at >= NOW() - make_interval(days => ${windowDays}::int)
    -- A tick dated in the future would sit inside every window forever. The
    -- create path rejects those now, but rows written before that guard exists
    -- are still in the table.
    AND t.climbed_at <= NOW()
    AND u.is_internal = false
    AND COALESCE(up.leaderboard_visibility::text, 'public') <> 'off'
  `;
}

/**
 * A scope's own predicate, plus its human label. This is the single place a new
 * granularity has to touch — nothing about a specific kind reaches the query
 * shape, the ranking, or the surface that renders it.
 *
 * Returns null when the key does not resolve to something real.
 */
async function scopePredicate(kind: ScopeKind, key: string): Promise<{ predicate: SQL; label: string } | null> {
  switch (kind) {
    case 'global':
      return { predicate: sql`TRUE`, label: '' };

    case 'boardType':
      if (!isRankedBoardType(key)) return null;
      return { predicate: sql`t.board_type = ${key}`, label: key };

    case 'layout': {
      const parsed = parseLayoutScopeKey(key);
      if (!parsed) return null;
      // Resolved through board_climbs rather than board_id, which is why this
      // tier has essentially no attribution gap (99.99%) where board and gym
      // sit at 86.8% and 46.9%.
      return {
        predicate: sql`
          t.board_type = ${parsed.boardType}
          AND EXISTS (
            SELECT 1 FROM board_climbs bc
            WHERE bc.uuid = t.climb_uuid
              AND bc.board_type = t.board_type
              AND bc.layout_id = ${parsed.layoutId}
          )`,
        label: '',
      };
    }

    case 'board': {
      const [board] = await db
        .select({ id: dbSchema.userBoards.id, name: dbSchema.userBoards.name })
        .from(dbSchema.userBoards)
        .where(
          and(
            eq(dbSchema.userBoards.uuid, key),
            isNull(dbSchema.userBoards.deletedAt),
            // Shared Feed pseudo-boards are not walls: 39 of them absorb ~7,780
            // ticks and would sit above every real board.
            eq(dbSchema.userBoards.isVirtual, false),
          ),
        )
        .limit(1);
      if (!board) return null;
      return { predicate: sql`t.board_id = ${board.id}`, label: board.name };
    }

    case 'gym': {
      const [gym] = await db
        .select({ id: dbSchema.gyms.id, name: dbSchema.gyms.name })
        .from(dbSchema.gyms)
        .where(eq(dbSchema.gyms.uuid, key))
        .limit(1);
      if (!gym) return null;
      return {
        predicate: sql`EXISTS (
          SELECT 1 FROM user_boards ub
          WHERE ub.id = t.board_id
            AND ub.gym_id = ${gym.id}
            AND ub.is_virtual = false
            AND ub.deleted_at IS NULL
        )`,
        label: gym.name,
      };
    }
  }
}

/** The ranked page. `where` is already fully composed. */
async function fetchRankedPage(where: SQL, limit: number, offset: number): Promise<StandingsRow[]> {
  const rows = await db.execute(sql<StandingsRow>`
    WITH first_send AS (
      SELECT t.user_id, t.climb_uuid, MIN(t.climbed_at) AS first_at
      FROM boardsesh_ticks t
      JOIN users u ON u.id = t.user_id
      LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE ${where}
      GROUP BY t.user_id, t.climb_uuid
    ),
    capped AS (
      SELECT user_id,
             ROW_NUMBER() OVER (
               PARTITION BY user_id, date_trunc('day', first_at) ORDER BY first_at
             ) AS per_day
      FROM first_send
    ),
    ranked AS (
      SELECT c.user_id,
             COUNT(*)::int AS score,
             RANK() OVER (ORDER BY COUNT(*) DESC)::int AS rank,
             COUNT(*) OVER (PARTITION BY COUNT(*))::int AS tie_size,
             PERCENT_RANK() OVER (ORDER BY COUNT(*) ASC)::float8 AS percentile,
             COUNT(*) OVER ()::int AS total_count
      FROM capped c
      WHERE c.per_day <= ${MAX_SCORED_CLIMBS_PER_DAY}
      GROUP BY c.user_id
    )
    SELECT r.user_id, r.score, r.rank, r.tie_size, r.percentile, r.total_count,
           COALESCE(up.display_name, u.name) AS display_name,
           COALESCE(up.avatar_url, u.image) AS avatar_url,
           (COALESCE(up.leaderboard_visibility::text, 'public') = 'anonymous') AS is_anonymous
    FROM ranked r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN user_profiles up ON up.user_id = u.id
    -- Deterministic in-tie order: arbitrary, but stable across refetches, so
    -- tied rows cannot shuffle under the reader between polls.
    ORDER BY r.score DESC, r.user_id ASC
    LIMIT ${limit} OFFSET ${offset}
  `);
  return rows as unknown as StandingsRow[];
}

/**
 * The viewer's own row, resolved with the same window function rather than by
 * paging until the client finds itself. `scores_above` carries the distinct
 * scores above so the UI can say "two more and you're 81st" without naming the
 * person standing on that rank.
 */
async function fetchViewerStanding(where: SQL, viewerId: string): Promise<ViewerRow | null> {
  const rows = await db.execute(sql<ViewerRow>`
    WITH first_send AS (
      SELECT t.user_id, t.climb_uuid, MIN(t.climbed_at) AS first_at
      FROM boardsesh_ticks t
      JOIN users u ON u.id = t.user_id
      LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE ${where}
      GROUP BY t.user_id, t.climb_uuid
    ),
    capped AS (
      SELECT user_id,
             ROW_NUMBER() OVER (
               PARTITION BY user_id, date_trunc('day', first_at) ORDER BY first_at
             ) AS per_day
      FROM first_send
    ),
    ranked AS (
      SELECT c.user_id,
             COUNT(*)::int AS score,
             RANK() OVER (ORDER BY COUNT(*) DESC)::int AS rank,
             COUNT(*) OVER (PARTITION BY COUNT(*))::int AS tie_size,
             PERCENT_RANK() OVER (ORDER BY COUNT(*) ASC)::float8 AS percentile
      FROM capped c
      WHERE c.per_day <= ${MAX_SCORED_CLIMBS_PER_DAY}
      GROUP BY c.user_id
    )
    SELECT r.rank, r.score, r.tie_size, r.percentile,
           COALESCE(
             (SELECT array_agg(DISTINCT other.score ORDER BY other.score ASC)
              FROM ranked other WHERE other.score > r.score),
             ARRAY[]::int[]
           ) AS scores_above
    FROM ranked r
    WHERE r.user_id = ${viewerId}
  `);
  const row = (rows as unknown as ViewerRow[])[0];
  return row ?? null;
}

async function runStandings(args: {
  requestedKind: ScopeKind;
  requestedKey: string;
  resolvedKind: ScopeKind;
  resolvedKey: string;
  label: string;
  predicate: SQL;
  windowDays: number;
  limit: number;
  offset: number;
  viewerId: string | null;
  demotionReason: 'empty' | 'unknownScope' | null;
}): Promise<StandingsResult> {
  const where = sql`${baseTickPredicate(args.windowDays)} AND (${args.predicate})`;

  const rows = await fetchRankedPage(where, args.limit, args.offset);
  const totalCount = rows.length > 0 ? Number(rows[0].total_count) : 0;

  const viewerRow = args.viewerId ? await fetchViewerStanding(where, args.viewerId) : null;

  const entries: StandingsEntryResult[] = rows.map((row) => {
    const isAnonymous = Boolean(row.is_anonymous);
    const isViewer = args.viewerId != null && row.user_id === args.viewerId;
    // The viewer always sees their own real id and name — they already know who
    // they are, and their row has to be identifiable to be pinned.
    const hide = isAnonymous && !isViewer;
    return {
      userId: hide ? anonymousClimberId(row.user_id) : row.user_id,
      displayName: hide ? null : row.display_name,
      avatarUrl: hide ? null : row.avatar_url,
      isAnonymous,
      rank: Number(row.rank),
      tieSize: Number(row.tie_size),
      score: Number(row.score),
      // Grade never sorts and is only meaningful within a single board type;
      // filled in by a later phase off the nightly grade materialisation.
      hardestGrade: null,
      isViewer,
    };
  });

  const scope = (kind: ScopeKind, key: string): StandingsScopeResult => ({
    kind,
    key,
    label: args.label,
    climberCount: totalCount,
  });

  return {
    requestedScope: scope(args.requestedKind, args.requestedKey),
    resolvedScope: scope(args.resolvedKind, args.resolvedKey),
    demotionReason: args.demotionReason,
    entries,
    totalCount,
    hasMore: args.offset + rows.length < totalCount,
    viewer: viewerRow
      ? {
          rank: Number(viewerRow.rank),
          score: Number(viewerRow.score),
          tieSize: Number(viewerRow.tie_size),
          percentile: Number(viewerRow.percentile),
          scoresAbove: (viewerRow.scores_above ?? []).map(Number),
        }
      : null,
    // From the registry, not hardcoded: this is what lets the surface explain a
    // low gym number ("sends synced from the Kilter app carry no wall") instead
    // of quietly under-reporting. It describes the scope actually ranked.
    coverage: scopeDefinition(args.resolvedKind).coverage,
  };
}

export const standingsQueries = {
  standings: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<StandingsResult> => {
    await applyRateLimit(ctx, 60, 'standings');
    const validated = validateInput(StandingsInputSchema, input, 'input');
    const windowDays = WINDOW_DAYS[validated.window];
    const viewerId = ctx.userId ?? null;
    const requestedKind = validated.scope.kind;
    const requestedKey = validated.scope.key ?? '';

    const common = {
      requestedKind,
      requestedKey,
      windowDays,
      limit: validated.limit,
      offset: validated.offset,
      viewerId,
    };

    // Measured on production: ~95 ms server-side warm, but ~1.25 s cold. The
    // three CTE layers touch enough pages that a post-deploy or evicted cache
    // costs an order of magnitude more than the steady state — and that cold
    // path is precisely what climbers meet right after a release. A ranking is
    // stale-tolerant, so 60 seconds of staleness buys that back.
    //
    // Keyed on the viewer too: the payload carries their real name and id on a
    // row anonymised for everyone else, so a shared entry would leak exactly
    // what the anonymity setting exists to withhold.
    const cacheKey = standingsCacheKey({
      scopeId: scopeToId({ kind: requestedKind, key: requestedKey }),
      window: validated.window,
      limit: validated.limit,
      offset: validated.offset,
      viewerId,
    });
    const cached = await getCachedStandings<StandingsResult>(cacheKey);
    if (cached) return cached;

    /**
     * Demote to global rather than returning an empty list. The intermediate
     * rungs of the ladder need a key we no longer have once the original entity
     * failed to resolve (a board's layout, a gym's layout), so this drops
     * straight to the one scope that is always resolvable. There is deliberately
     * no path here to a screen with nothing on it.
     */
    const demoteToGlobal = async (reason: 'empty' | 'unknownScope') => {
      const global = await scopePredicate('global', '');
      return runStandings({
        ...common,
        resolvedKind: 'global',
        resolvedKey: '',
        label: '',
        predicate: global!.predicate,
        demotionReason: reason,
      });
    };

    const requested = await scopePredicate(requestedKind, requestedKey);
    if (!requested) {
      const demoted = await demoteToGlobal('unknownScope');
      setCachedStandings(cacheKey, demoted);
      return demoted;
    }

    const result = await runStandings({
      ...common,
      resolvedKind: requestedKind,
      resolvedKey: requestedKey,
      label: requested.label,
      predicate: requested.predicate,
      demotionReason: null,
    });

    // Demote only from the FIRST page. `totalCount` is read off the returned
    // rows (COUNT(*) OVER ()), so a page past the end of the list comes back
    // empty and reports zero — without this guard, scrolling to the bottom of a
    // real wall's standings would silently swap the reader onto the global
    // board, which is far worse than the empty tail they actually asked for.
    const isEmptyFirstPage = result.totalCount === 0 && validated.offset === 0;
    const resolved = isEmptyFirstPage && requestedKind !== 'global' ? await demoteToGlobal('empty') : result;

    // Cache the demoted response under the REQUESTED key, so a repeat request
    // for the same empty wall skips the wasted round trip too.
    setCachedStandings(cacheKey, resolved);
    return resolved;
  },
};
