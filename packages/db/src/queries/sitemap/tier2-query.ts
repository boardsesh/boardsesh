import { and, asc, desc, eq, gte, inArray, ne, notExists, sql } from 'drizzle-orm';
import { ANGLES, toBoardName } from '@boardsesh/board-config';
import { boardClimbAliases, boardClimbStats, boardClimbs } from '../../schema/index';
import type { SerialPlanDb } from '../util/serial-plan';
import type { ClimbConfigGroup } from './tier2-groups';

/**
 * Tier 2 is the slice of the catalogue worth a crawl budget: a climb people have
 * actually done. Tier 3 (every listed climb) is deliberately NOT submitted until
 * Search Console shows healthy tier-2 coverage.
 */
export const TIER_2_MIN_ASCENTS = 10;

/**
 * Per-group safety cap. Not a tuning knob — it exists so one pathological group
 * cannot pull an unbounded result set into memory. Hitting it means the shard is
 * silently losing its tail, so it warns rather than truncating quietly.
 */
export const MAX_ROWS_PER_GROUP = 250_000;

function setIdArray(setIds: readonly number[]) {
  return sql`ARRAY[${sql.join(
    setIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::int[]`;
}

/**
 * The tier-2 selection for one board configuration, one row per climb.
 *
 * `DISTINCT ON (climb_uuid)` keeps the angle with the most ascents. Other angles
 * of the same climb stay self-canonical and reachable through W-15's angle
 * cross-links — they are just not submitted, because submitting fifteen URLs per
 * climb spends the crawl budget on near-duplicates.
 *
 * Three raw `sql` fragments, all of them things Drizzle has no operator for and
 * all of them copied from the predicate the `/list` front door already runs
 * (`create-climb-filters.ts`): the `@>` size containment, the `<@` set
 * containment, and the `COALESCE(...)` angle tie-break.
 *
 * **This lives in `@boardsesh/db` rather than in web** so the nightly
 * `refresh-sitemap-tier2` job and the web fallback path run byte-identical SQL
 * (#4583). Both sides are `drizzle-orm/postgres-js`, so `.toSQL()` renders the
 * same text on both. A second copy of this predicate is the failure mode the
 * ruling on #4583 names explicitly: a table built from a restatement of the
 * predicate submits a different set than the code selects.
 */
function buildChosenSubquery(db: SerialPlanDb, group: ClimbConfigGroup) {
  const boardName = toBoardName(group.boardType);
  if (!boardName) {
    throw new Error(`[sitemap] climbs shard: unknown board type "${group.boardType}"`);
  }
  const isMoonboard = boardName === 'moonboard';

  return db
    .selectDistinctOn([boardClimbStats.climbUuid], {
      uuid: boardClimbStats.climbUuid,
      angle: boardClimbStats.angle,
      name: boardClimbs.name,
      // Both source columns are named `updated_at`; explicit aliases keep them
      // distinct through the `chosen` subquery. `mapWith` preserves drizzle's
      // UTC timestamp decoder for the per-URL item path.
      statsUpdatedAt: sql`${boardClimbStats.updatedAt}`.mapWith(boardClimbStats.updatedAt).as('stats_updated_at'),
      climbUpdatedAt: sql`${boardClimbs.updatedAt}`.mapWith(boardClimbs.updatedAt).as('climb_updated_at'),
    })
    .from(boardClimbStats)
    .innerJoin(
      boardClimbs,
      and(eq(boardClimbs.uuid, boardClimbStats.climbUuid), eq(boardClimbs.boardType, boardClimbStats.boardType)),
    )
    .where(
      and(
        eq(boardClimbs.boardType, group.boardType),
        eq(boardClimbs.layoutId, group.layoutId),
        eq(boardClimbs.isListed, true),
        eq(boardClimbs.isDraft, false),
        gte(boardClimbStats.ascensionistCount, TIER_2_MIN_ASCENTS),
        // Never publish an angle the route tables don't carry — that URL 404s.
        inArray(boardClimbStats.angle, [...ANGLES[boardName]]),
        // The same two predicates the /list front door filters on, so the climb
        // genuinely renders on the configuration we are about to name in its URL.
        // MoonBoard has one fixed size, so it has no size predicate at all.
        ...(isMoonboard ? [] : [sql`${boardClimbs.compatibleSizeIds} @> ARRAY[${group.sizeId}]::int[]`]),
        ...(group.setIds.length === 0
          ? []
          : [
              isMoonboard
                ? sql`(${boardClimbs.requiredSetIds} IS NULL OR ${boardClimbs.requiredSetIds} <@ ${setIdArray(group.setIds)})`
                : sql`${boardClimbs.requiredSetIds} <@ ${setIdArray(group.setIds)}`,
            ]),
        // A *genuine* alias uuid keeps its own URL and self-canonicalises there,
        // so submitting both forms is duplicate content by construction.
        //
        // `alias_uuid <> canonical_uuid` is load-bearing, not defensive.
        // `board_climb_aliases` is mostly SELF-aliases: every synced Kilter climb
        // has a row mapping its uuid to itself (migration
        // 0160_backfill_kilter_self_aliases, plus catalog-sync's identity path),
        // because deletion reconciliation resolves upstream removals through this
        // table. Measured in production: the broken predicate would drop 106,550
        // of 127,131 tier-2 climbs (84%), while zero genuine aliases currently
        // meet the tier-2 threshold. Excluding "any uuid present as alias_uuid"
        // would therefore remove most of the sitemap silently, because the
        // remaining boards keep the shard non-empty and `expectsUrls` never fires.
        notExists(
          db
            .select({ one: sql<number>`1` })
            .from(boardClimbAliases)
            .where(
              and(
                eq(boardClimbAliases.boardType, boardClimbs.boardType),
                eq(boardClimbAliases.aliasUuid, boardClimbs.uuid),
                ne(boardClimbAliases.aliasUuid, boardClimbAliases.canonicalUuid),
              ),
            ),
        ),
      ),
    )
    .orderBy(
      boardClimbStats.climbUuid,
      desc(boardClimbStats.ascensionistCount),
      // COALESCE rather than a bare `stats.angle = climbs.angle`, but DEFENSIVE
      // rather than load-bearing, and the earlier claim that it was load-bearing
      // was wrong. `board_climbs.uuid` is the primary key and the join is on
      // `(uuid, board_type)`, so every row inside one `DISTINCT ON (climb_uuid)`
      // group joins to the SAME `board_climbs` row. A null `climbs.angle` makes
      // the comparison NULL for every row in the group, NULLs sort equal, and the
      // tie-break falls through to `asc(stats.angle)` with or without the
      // COALESCE — measured over kilter layout 1 (16,233 tier-2 climbs with a
      // NULL `board_climbs.angle`): zero differing rows. Kept because it costs
      // nothing and survives a future join that does compare across climbs.
      desc(sql`COALESCE(${boardClimbStats.angle} = ${boardClimbs.angle}, false)`),
      asc(boardClimbStats.angle),
    )
    .as('chosen');
}

/**
 * Split out from the fetch so a test can render this query's real SQL with
 * `.toSQL()` instead of grepping the source for the predicate it hopes is there.
 */
export function buildTier2ClimbQuery(db: SerialPlanDb, group: ClimbConfigGroup, limit = MAX_ROWS_PER_GROUP) {
  const chosen = buildChosenSubquery(db, group);
  return db.select().from(chosen).orderBy(asc(chosen.uuid)).limit(limit);
}

/**
 * The count and freshness of exactly what `buildTier2ClimbQuery` would return —
 * same `buildChosenSubquery`, so the two can never describe different sets.
 *
 * The freshness clock covers both halves of the visible page. Stats changes
 * advance `board_climb_stats.updated_at`; name, description and frame edits
 * independently advance `board_climbs.updated_at`. Production's update triggers
 * guarantee both clocks, so the later one is the honest `<lastmod>`.
 *
 * `to_char(...)` rather than a bare timestamp aggregate: the raw `sql` fragment
 * bypasses drizzle's timestamp mapper, so the driver otherwise hands back pg text
 * like `2026-08-10 20:39:19.492499`. `new Date()` reads that non-ISO form in the
 * process timezone. Both columns are `timestamp without time zone` holding UTC;
 * rendering an explicit `Z` keeps the summary aligned with the per-row values
 * that go through drizzle's ordinary timestamp mapper.
 */
export function buildTier2ClimbSummaryQuery(db: SerialPlanDb, group: ClimbConfigGroup) {
  const chosen = buildChosenSubquery(db, group);
  return db
    .select({
      itemCount: sql<number>`count(*)::int`,
      lastModified: sql<
        string | null
      >`to_char(max(GREATEST(${chosen.statsUpdatedAt}, ${chosen.climbUpdatedAt})), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(chosen);
}
