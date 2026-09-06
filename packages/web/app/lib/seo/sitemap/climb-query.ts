import 'server-only';
import { unstable_cache } from 'next/cache';
import { and, asc, eq, gte, inArray, ne, notExists, sql } from 'drizzle-orm';
import { toBoardName } from '@boardsesh/board-config';
import { withSerialPlan, type SerialPlanDb } from '@boardsesh/db/queries';
import { dbzRead } from '@/app/lib/db/db';
import { boardClimbAliases, boardClimbStats, boardClimbs } from '@/app/lib/db/schema';
import { getSitemapClimbConfigsOrThrow } from './board-config-source';
import {
  climbRowsToItems,
  resolveClimbSitemapGroups,
  type ClimbConfigGroup,
  type ClimbSitemapRow,
} from './climb-entries';
import type { SitemapItem } from './entries';
import { publishableAngles, publishedAngleOrderBy } from './published-angle';

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

/** In-process TTL for the full item list; matches the shard's CDN freshness window. */
const ITEMS_TTL_MS = 6 * 60 * 60 * 1000;
/** Same window for the summary, in front of the Data Cache (which does not dedupe misses). */
const SUMMARY_TTL_MS = 6 * 60 * 60 * 1000;
/** Next Data Cache window for the (small) summary the index reads on every hit. */
const SUMMARY_REVALIDATE_SECONDS = 21_600;
const SUMMARY_CACHE_TAG = 'sitemap-climbs';

export type Tier2Summary = { itemCount: number; lastModified: Date | null };

function setIdArray(setIds: readonly number[]) {
  return sql`ARRAY[${sql.join(
    setIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::int[]`;
}

/**
 * The tier-2 selection for one board configuration, one row per climb.
 *
 * `DISTINCT ON (climb_uuid)` keeps the angle with the most ascents. Other valid
 * angles remain reachable through W-15's angle cross-links, but canonicalise to
 * this chosen URL and are not submitted as duplicate sitemap entries.
 *
 * Three raw `sql` fragments, all of them things Drizzle has no operator for and
 * all of them copied from the predicate the `/list` front door already runs
 * (`create-climb-filters.ts`): the `@>` size containment, the `<@` set
 * containment, and the `COALESCE(...)` angle tie-break.
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
        // `publishableAngles` is the same list the setter front door's angle
        // pick reads, so the two surfaces cannot disagree about what is
        // publishable.
        inArray(boardClimbStats.angle, publishableAngles(boardName)),
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
      // The angle pick itself lives in `published-angle.ts` because the setter
      // front door has to make the identical choice: the angle is a path
      // segment, so a second rule is a second indexable URL for the same climb.
      // It shipped as two hand-written ORDER BYs and they disagreed on 28
      // tier-2 climbs (measured on the dev image) — every one of them a setter
      // row linking to a URL this shard never submitted.
      //
      // The COALESCE tie-break is defensive HERE, and the earlier claim that it
      // was load-bearing was wrong: `board_climbs.uuid` is the primary key and
      // the join is on `(uuid, board_type)`, so every row inside one
      // `DISTINCT ON (climb_uuid)` group joins the SAME `board_climbs` row. A
      // null `climbs.angle` makes the comparison NULL for every row in the
      // group, NULLs sort equal, and the tie-break falls through to
      // `asc(stats.angle)` with or without it — measured over kilter layout 1
      // (16,233 tier-2 climbs with a NULL `board_climbs.angle`): zero differing
      // rows. It is load-bearing on the setter side, where the subquery reads
      // one climb's stats rows and `board_climbs.angle` is frequently non-null.
      ...publishedAngleOrderBy({
        ascensionistCount: boardClimbStats.ascensionistCount,
        statsAngle: boardClimbStats.angle,
        climbAngle: boardClimbs.angle,
      }),
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

export async function fetchTier2ClimbRows(group: ClimbConfigGroup): Promise<ClimbSitemapRow[]> {
  const rows = await withSerialPlan(dbzRead, async (tx) => buildTier2ClimbQuery(tx, group));

  if (rows.length === MAX_ROWS_PER_GROUP) {
    console.warn(
      `[sitemap] climbs group ${group.boardType}/${group.layoutId} hit its ${MAX_ROWS_PER_GROUP}-row cap — the tail is missing.`,
    );
  }

  return rows.map((row) => ({
    uuid: row.uuid,
    name: row.name,
    angle: row.angle,
    updatedAt: row.climbUpdatedAt > row.statsUpdatedAt ? row.climbUpdatedAt : row.statsUpdatedAt,
  }));
}

/**
 * The live tier-2 count and freshness, with no cache of any kind in front of it.
 *
 * The RESULT is two numbers. The COST is not: it is the same `DISTINCT ON` scan
 * as the item build, once per `(board_type, layout_id)` group — measured on the
 * full-board dev image at 16.7 s cold, 0.95 s fully warm, for the largest of
 * them. Read that as "small answer, expensive question".
 *
 * One caller: the cached `fetchTier2Summary` fallback below. The refresher used
 * to be the second (#4523), but it now derives the summary from the URL rows it
 * builds anyway (`buildAllTier2UrlRows`), so it runs one set of scans instead of
 * two. Request paths want `fetchClimbShardSummary()` (store first, the fallback
 * below only when the store is empty).
 *
 * Still sequential, and adding MoonBoard's groups is not a reason to change
 * that. An earlier draft of this change fanned the loop out three lanes wide to
 * bring the LIVE summary back inside `SHARD_DEADLINE_MS`; #4552 then took the
 * index off this path entirely, so the deadline this raced is no longer on the
 * far side of it. What is left is the pre-first-refresh fallback, where the
 * answer is to refresh the store, not to spend three of a ten-connection pool on
 * a path that should run once per deploy.
 */
async function computeTier2Summary(): Promise<{ itemCount: number; lastModifiedIso: string | null }> {
  const groups = resolveClimbSitemapGroups(await getSitemapClimbConfigsOrThrow());

  let itemCount = 0;
  let lastModified: Date | null = null;

  // Sequential, never Promise.all: a fan-out of concurrent heavy scans is the
  // pool starvation #4461 describes, on a pool of 10.
  for (const group of groups) {
    const [summary] = await withSerialPlan(dbzRead, async (tx) => buildTier2ClimbSummaryQuery(tx, group));
    if (!summary) continue;
    itemCount += summary.itemCount;
    const groupLatest = summary.lastModified ? new Date(summary.lastModified) : null;
    if (groupLatest && (!lastModified || groupLatest > lastModified)) {
      lastModified = groupLatest;
    }
  }

  return { itemCount, lastModifiedIso: lastModified ? lastModified.toISOString() : null };
}

/**
 * `unstable_cache`d, and only the summary is. On Vercel the item list could not
 * be cached at all: the production 52,842-item payload serialises to well over
 * 10 MB and the 2 MB Data Cache entry ceiling meant an `unstable_cache` around
 * it silently never cached. Off Vercel (#4648) there is no entry ceiling, and
 * the items still do not belong here — see `buildTier2ClimbItems` below for the
 * reason that replaced it.
 *
 * Dates do not survive the Data Cache intact, so the ISO string is what gets
 * stored and the public wrapper rehydrates it.
 */
const cachedTier2Summary = unstable_cache(computeTier2Summary, ['sitemap-climbs-summary'], {
  revalidate: SUMMARY_REVALIDATE_SECONDS,
  tags: [SUMMARY_CACHE_TAG],
});

let cachedSummary: { builtAt: number; summary: Tier2Summary } | null = null;
let summaryInFlight: Promise<Tier2Summary> | null = null;

/**
 * The tier-2 count and freshness, behind the SAME in-process TTL + single-flight
 * the item build gets.
 *
 * **No longer the index's read path.** `/sitemap.xml` and the shard route both go
 * through `fetchClimbShardSummary()` (climb-store.ts), which reads one row of
 * `sitemap_shard_refreshes`; this is the fallback for when that row does not exist
 * — a fresh migration, a truncated store, local dev, or a store read that threw.
 * That fallback is genuinely reached and genuinely slow, which is why it keeps
 * both cache layers rather than being deleted: on the deploy that adds the store,
 * every request takes this path until the first refresh runs.
 *
 * `unstable_cache` alone is not enough: it does not deduplicate concurrent
 * misses, and on a cold Data Cache a crawl burst is `/sitemap.xml` plus every
 * `/sitemaps/climbs/N.xml` page arriving together — each of which calls this.
 * Without the single-flight that is one full-catalogue scan per request against
 * a ten-connection pool, which is #4461 exactly. The item build already had this
 * guard; the summary costs the same scan and was missing it.
 */
export async function fetchTier2Summary(): Promise<Tier2Summary> {
  if (cachedSummary && Date.now() - cachedSummary.builtAt < SUMMARY_TTL_MS) {
    return cachedSummary.summary;
  }
  if (summaryInFlight) {
    return summaryInFlight;
  }

  const build = (async () => {
    const { itemCount, lastModifiedIso } = await cachedTier2Summary();
    const summary: Tier2Summary = { itemCount, lastModified: lastModifiedIso ? new Date(lastModifiedIso) : null };
    cachedSummary = { builtAt: Date.now(), summary };
    return summary;
  })();
  summaryInFlight = build;

  try {
    return await build;
  } finally {
    summaryInFlight = null;
  }
}

let cachedItems: { builtAt: number; items: SitemapItem[] } | null = null;
let inFlight: Promise<SitemapItem[]> | null = null;

/** One rendered climb URL, annotated with the group that emitted it. */
export type Tier2UrlRow = {
  path: string;
  lastModified: Date | null;
  boardType: string;
  layoutId: number;
};

/**
 * The full ordered tier-2 URL list, uncached, in EMISSION ORDER: groups in
 * `resolveClimbSitemapGroups` order, then `uuid ASC` within a group. That order
 * is a contract — `sitemap_climb_urls.ordinal` is the index into this array, and
 * the shard pages slice on it, so reordering this loop moves every page boundary.
 *
 * This is the ONE code path that decides which climbs the shard carries. Both
 * consumers — the store refresher (`refreshClimbSitemapStore`) and the live
 * request fallback (`buildTier2ClimbItems`) — go through it, deliberately. The
 * `buildChosenSubquery` comments above record two separate measured incidents
 * where a plausible-looking second copy of this selection silently dropped most
 * of the shard; a drifting duplicate is exactly how that recurs.
 *
 * `getSitemapClimbConfigsOrThrow`, not `getAllBoardConfigsOrThrow`, and that one
 * word is the whole of what puts MoonBoard in the sitemap. #4552 moved the pages
 * onto `sitemap_climb_urls`, so a board that is missing from the config source
 * the REFRESHER reads is missing from the stored rows, and every downstream read
 * — the shard pages, the index's item count, the per-page `<lastmod>` — is
 * missing it too, however many synthetic configs exist elsewhere. There is no
 * second place to add it: the refresher's only entry point is this function.
 */
export async function buildAllTier2UrlRows(): Promise<Tier2UrlRow[]> {
  const groups = resolveClimbSitemapGroups(await getSitemapClimbConfigsOrThrow());
  const urlRows: Tier2UrlRow[] = [];
  let dropped = 0;

  // Sequential, for the same pool reason as the summary.
  for (const group of groups) {
    const built = climbRowsToItems(await fetchTier2ClimbRows(group), group);
    for (const item of built.items) {
      urlRows.push({
        path: item.path,
        lastModified: item.lastModified ?? null,
        boardType: group.boardType,
        layoutId: group.layoutId,
      });
    }
    dropped += built.dropped;
  }

  if (dropped > 0) {
    // Should be zero: unresolvable configurations are filtered out a group at a
    // time. A non-zero count means a climb was dropped rather than published
    // under a URL we cannot prove matches its own canonical.
    console.warn(`[sitemap] climbs shard dropped ${dropped} climbs with no resolvable canonical URL.`);
  }

  return urlRows;
}

async function buildAllTier2Items(): Promise<SitemapItem[]> {
  return (await buildAllTier2UrlRows()).map((row) => ({ path: row.path, lastModified: row.lastModified }));
}

/**
 * The full ordered item list, behind a 6-hour TTL and a single-flight promise.
 *
 * One in-flight build per instance is the point: a crawl burst across N shard
 * pages on a cold instance would otherwise run N full scans against a
 * ten-connection pool while the front door waits behind them.
 *
 * **No longer the shard pages' read path.** #4552 materialised the URL list into
 * `sitemap_climb_urls`, so `buildClimbShardPage` (climb-store.ts) answers a page
 * from an ordinal range read in milliseconds; this is its fallback for an empty
 * or unreadable store — a fresh migration, a truncated table, local dev. That
 * fallback is genuinely reached and genuinely slow (51 s cold in production,
 * #4552), which is why it keeps both defences rather than being deleted: on the
 * deploy that adds the store, every page request takes this path until the first
 * refresh runs.
 *
 * The item list is deliberately not in the Next Data Cache, and the reason
 * changed with the host. On Vercel it *could* not be: ~20 MB is past the 2 MB
 * entry ceiling, so the cache was a no-op. Self-hosted on Railway there is no
 * entry ceiling, and it still should not go in — the standalone server's
 * incremental cache holds entries in a bounded in-process budget before
 * spilling to disk, so one 20 MB entry would evict the small ones that are
 * actually load-bearing, `getAllBoardConfigsOrThrow` among them (#4519).
 *
 * So the only protection on this fallback stays the in-process TTL above plus
 * the CDN: a genuinely cold crawl of N pages that all miss it really is N full
 * builds. That is the burn the URL table exists to stop; do not try to make the
 * fallback comfortable instead of refreshing the store.
 */
export async function buildTier2ClimbItems(): Promise<SitemapItem[]> {
  if (cachedItems && Date.now() - cachedItems.builtAt < ITEMS_TTL_MS) {
    return cachedItems.items;
  }
  if (inFlight) {
    return inFlight;
  }

  const build = buildAllTier2Items().then((items) => {
    cachedItems = { builtAt: Date.now(), items };
    return items;
  });
  inFlight = build;

  try {
    return await build;
  } finally {
    inFlight = null;
  }
}

/** Test seam: drops the in-process TTL caches. */
export function resetTier2ItemCacheForTests(): void {
  cachedItems = null;
  inFlight = null;
  cachedSummary = null;
  summaryInFlight = null;
}
