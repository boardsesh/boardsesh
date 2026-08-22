import 'server-only';
import { unstable_cache } from 'next/cache';
import {
  buildTier2ClimbQuery,
  buildTier2ClimbSummaryQuery,
  MAX_ROWS_PER_GROUP,
  TIER_2_MIN_ASCENTS,
  withSerialPlan,
} from '@boardsesh/db/queries';
import { dbzRead } from '@/app/lib/db/db';
import { getAllBoardConfigsOrThrow } from '@/app/lib/server-popular-configs';
import {
  climbRowsToItems,
  resolveClimbSitemapGroups,
  type ClimbConfigGroup,
  type ClimbSitemapRow,
} from './climb-entries';
import type { SitemapItem } from './entries';

/**
 * The tier-2 predicate itself now lives in `@boardsesh/db/queries/sitemap`, not
 * here (#4583).
 *
 * It moved because the nightly `refresh-sitemap-tier2` job materialises the rows
 * this file used to build live, and the two must run byte-identical SQL — a
 * restatement of the predicate in the job is how the stored table would come to
 * describe a different set of climbs than the shard emits. Web re-exports the
 * builders so existing importers and the query tests keep working, and so the
 * fallback path below is provably the same query the job ran.
 *
 * Everything below is the FALLBACK. It is what runs when the materialised table
 * cannot be trusted (empty, or selected by a different predicate) — see
 * `tier2-table.ts` for that verdict and for the loud channels a fallback fires.
 */
export { buildTier2ClimbQuery, buildTier2ClimbSummaryQuery, MAX_ROWS_PER_GROUP, TIER_2_MIN_ASCENTS };

/** In-process TTL for the full item list; matches the shard's CDN freshness window. */
const ITEMS_TTL_MS = 6 * 60 * 60 * 1000;
/** Same window for the summary, in front of the Data Cache (which does not dedupe misses). */
const SUMMARY_TTL_MS = 6 * 60 * 60 * 1000;
/** Next Data Cache window for the (small) summary the index reads on every hit. */
const SUMMARY_REVALIDATE_SECONDS = 21_600;
const SUMMARY_CACHE_TAG = 'sitemap-climbs';

export type Tier2Summary = { itemCount: number; lastModified: Date | null };

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
 * sixteen groups. Read that as "small answer, expensive question".
 *
 * Exported for ONE caller: `refreshStoredClimbSummary` in `climb-store.ts`, which
 * writes the answer into `sitemap_shard_refreshes` so `/sitemap.xml` can read it
 * back in a millisecond (#4523). The refresher must bypass both caches below —
 * storing a six-hour-old cached answer would defeat the point of refreshing — but
 * it must not describe a DIFFERENT set from the request path, hence one function
 * both sides call rather than a second copy of the loop.
 *
 * Do not add a third per-request caller. Request paths want
 * `fetchClimbShardSummary()` (store first, this only as the empty-store fallback).
 */
export async function computeTier2Summary(): Promise<{ itemCount: number; lastModifiedIso: string | null }> {
  const groups = resolveClimbSitemapGroups(await getAllBoardConfigsOrThrow());

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
 * `unstable_cache`d, and only the summary is: the production 52,842-item payload
 * serialises to well over 10 MB, past Vercel's 2 MB Data Cache entry ceiling, so
 * caching the items there would silently never cache.
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

async function buildAllTier2Items(): Promise<SitemapItem[]> {
  const groups = resolveClimbSitemapGroups(await getAllBoardConfigsOrThrow());
  const items: SitemapItem[] = [];
  let dropped = 0;

  // Sequential, for the same pool reason as the summary.
  for (const group of groups) {
    const built = climbRowsToItems(await fetchTier2ClimbRows(group), group);
    for (const item of built.items) {
      items.push(item);
    }
    dropped += built.dropped;
  }

  if (dropped > 0) {
    // Should be zero: unresolvable configurations are filtered out a group at a
    // time. A non-zero count means a climb was dropped rather than published
    // under a URL we cannot prove matches its own canonical.
    console.warn(`[sitemap] climbs shard dropped ${dropped} climbs with no resolvable canonical URL.`);
  }

  return items;
}

/**
 * The full ordered item list, behind a 6-hour TTL and a single-flight promise.
 *
 * One in-flight build per instance is the point: a crawl burst across N shard
 * pages on a cold instance would otherwise run N full scans against a
 * ten-connection pool while the front door waits behind them.
 *
 * Scope, stated plainly because the comment above overstates it on its own:
 * this is a PER-INSTANCE defence. The item list is deliberately not in the Next
 * Data Cache (~20 MB, past the 2 MB entry ceiling), so on Vercel the only
 * cross-instance protection is the CDN — and on a genuinely cold crawl, where
 * Googlebot fetches N pages that all miss the CDN and land on N lambdas, the
 * cost really is N full builds. Per-page Data Cache entries would not fix it
 * either: building page N still needs the whole ordered list before it can
 * slice, so it would be N full builds plus N cache writes. The real fix is a
 * materialised tier-2 URL table.
 *
 * **Still true after #4523**, which is the point worth being precise about. That
 * change materialised the SUMMARY only (`sitemap_shard_refreshes`), because the
 * bug it closed was the index dropping the shard on a missed 3 s deadline. The
 * item path is untouched: `/sitemaps/climbs/N.xml` still runs the full grouped
 * scan on a cold instance, still measured at 51 s in production, and page N still
 * costs the whole ordered list. The URL table that fixes that is a follow-up, and
 * it is purely additive on the store scaffolding #4523 added.
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
