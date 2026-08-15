import 'server-only';
import { getAllBoardConfigsOrThrow } from '@/app/lib/server-popular-configs';
import { absoluteUrl } from '@/app/lib/seo/base-url';
import { boardConfigsToItems } from './board-entries';
import { allLocalesUrlCount, expandAllLocales, latestLastModified, type SitemapItem } from './entries';
import { buildGymEntries } from './gym-entries';
import { playlistRowsToItems } from './playlist-entries';
import { fetchPlaylistSitemapRows } from './playlist-query';
import { buildSetterEntries } from './setter-entries';
import { buildStaticEntries } from './static-entries';
import { MAX_URLS_PER_SHARD, renderSitemapIndex, renderUrlset, type SitemapIndexEntry } from './sitemap-xml';

export type ShardId = 'static' | 'boards' | 'gyms' | 'setters' | 'playlists';

export type SitemapShard = {
  id: ShardId;
  path: `/sitemaps/${string}.xml`;
  build: () => Promise<SitemapItem[]>;
  /**
   * True when zero URLs means something broke rather than "nothing to list".
   * `static` is hardcoded and `boards` derives from the listed board catalogue,
   * so an empty result there is a poisoned cache or a regressed query, and the
   * shard must 503 instead of publishing an empty `<urlset>` that tells Google
   * those pages were deleted.
   *
   * False for `gyms`/`setters` (declared-empty by design) and for `playlists`,
   * where zero public playlists holding a climb is a legitimate state — failing
   * closed there would take the whole index down because nobody shared a list.
   */
  expectsUrls: boolean;
};

/**
 * Single source of truth: the index and the five route files both read this, so
 * a shard can never exist in one and not the other (pinned by a unit test that
 * walks `app/sitemaps/` on disk in both directions).
 */
export const SHARD_REGISTRY: readonly SitemapShard[] = [
  { id: 'static', path: '/sitemaps/static.xml', expectsUrls: true, build: async () => buildStaticEntries() },
  {
    id: 'boards',
    path: '/sitemaps/boards.xml',
    expectsUrls: true,
    build: async () => boardConfigsToItems(await getAllBoardConfigsOrThrow()),
  },
  { id: 'gyms', path: '/sitemaps/gyms.xml', expectsUrls: false, build: async () => buildGymEntries() },
  { id: 'setters', path: '/sitemaps/setters.xml', expectsUrls: false, build: async () => buildSetterEntries() },
  {
    id: 'playlists',
    path: '/sitemaps/playlists.xml',
    expectsUrls: false,
    build: async () => playlistRowsToItems(await fetchPlaylistSitemapRows()),
  },
];

const CACHE_CONTROL = 'public, s-maxage=3600, stale-while-revalidate=86400';

/**
 * A *degraded* index — one that dropped a shard — gets a minute, not 25 hours.
 *
 * The full window is `s-maxage=3600` plus a day of `stale-while-revalidate`, and
 * a 503 was never cached at all (`no-store`), so before the degradation rewrite
 * the copy the CDN eventually held was always complete. Serving a partial index
 * under the full window trades a self-healing 503 for a cacheable lie: one cold
 * start pins "boards.xml and playlists.xml do not exist" at the edge for up to
 * 25 hours, while both URLs serve perfectly the whole time. Sixty seconds with no
 * `stale-while-revalidate` keeps the "partial beats nothing" benefit and makes
 * the next crawl re-attempt the shards that missed.
 */
const DEGRADED_CACHE_CONTROL = 'public, s-maxage=60, must-revalidate';

/**
 * Names the shards a 200 is missing, so the degradation is visible on the
 * response rather than only in a `console.error` nobody reads. The post-deploy
 * smoke is the detector this bug was found by, and a silent partial index is
 * precisely what would make it permanently green.
 */
const DEGRADED_HEADER = 'X-Sitemap-Degraded';

function xmlResponse(
  body: string,
  cacheControl: string = CACHE_CONTROL,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': cacheControl,
      ...extraHeaders,
    },
  });
}

/**
 * A builder that *throws* must produce a 503, never a truncated 200: a short
 * 200 tells Google the missing URLs were removed, while a 5xx makes it retry
 * and keep the last good copy. A builder that returns `[]` on purpose (gyms,
 * setters) is a declared-empty shard, not a failure.
 *
 * This is the *shard route's* rule. The index degrades instead — see
 * `buildSitemapIndexXml` — and only reaches here when no shard built at all.
 */
function unavailableResponse(): Response {
  return new Response('sitemap shard temporarily unavailable', {
    status: 503,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * A data-backed shard that comes back empty is a failure wearing a 200: the
 * whole surface disappears from the index behind an hour of `s-maxage` with
 * nothing thrown. Fail closed instead — same reasoning as a throwing builder.
 */
function emptinessError(shard: SitemapShard): Error | null {
  return shard.expectsUrls
    ? new Error(`[sitemap] shard "${shard.id}" expects URLs but built none — refusing to publish an empty shard`)
    : null;
}

/**
 * A shard past the protocol's 50,000-URL ceiling is rejected wholesale by Search
 * Console, so serving it is strictly worse than serving nothing: 503 keeps the
 * last good copy while the shard gets split into paged files.
 */
function overBudgetError(shard: SitemapShard, urlCount: number): Error | null {
  return urlCount > MAX_URLS_PER_SHARD
    ? new Error(
        `[sitemap] shard "${shard.id}" built ${urlCount} locale-expanded URLs, past the ${MAX_URLS_PER_SHARD} budget — split it into paged shards`,
      )
    : null;
}

/**
 * **Deliberately unbounded, unlike the index walk below.** A `withDeadline` here
 * would 503 a legitimately slow-but-working shard: `getAllBoardConfigsOrThrow`
 * budgets itself 10 s, and any index-sized deadline would fail a URL that serves
 * ~2,600 correct URLs today. The asymmetry is the doctrine, not an oversight —
 * the index's deadline protects the *other* shards from one slow builder, and
 * omitting a shard for a minute is cheap where 503ing a working URL is not.
 *
 * The residual gap is honest: a builder that stalls past the platform ceiling
 * gets a platform 5xx instead of this handler's 503-with-`no-store`. Both are
 * retryable and neither is cached, so the crawler behaviour is the same; a real
 * bound needs an `AbortSignal` threaded into the builders, tracked as a
 * follow-up rather than approximated with a timer that cancels nothing.
 */
export async function shardRouteHandler(id: ShardId): Promise<Response> {
  const shard = SHARD_REGISTRY.find((candidate) => candidate.id === id);
  if (!shard) {
    return unavailableResponse();
  }

  let body: string;
  try {
    const items = await shard.build();
    const emptiness = emptinessError(shard);
    if (items.length === 0 && emptiness) {
      throw emptiness;
    }

    const urls = expandAllLocales(items);
    const overBudget = overBudgetError(shard, urls.length);
    if (overBudget) {
      throw overBudget;
    }

    body = renderUrlset(urls);
  } catch (err) {
    console.error(`[sitemap] shard "${id}" failed to build:`, err instanceof Error ? err.message : err);
    return unavailableResponse();
  }

  return xmlResponse(body);
}

/**
 * How long the index waits for one builder before publishing without it.
 *
 * Read it as a property of the *index*, not a verdict on the builder. The two
 * recorded production failures were rejections, not stalls — a 503 is this
 * file's own `unavailableResponse`, and `getAllBoardConfigsOrThrow`'s 10 s abort
 * surfaces as a throw — so the try/catch alone already covers what was measured.
 * The deadline covers the mode a try/catch structurally cannot see: a builder
 * that never settles (`fetchPlaylistSitemapRows` has no bound of its own) would
 * otherwise hold the whole index to the platform timeout, taking down the four
 * shards that were ready.
 *
 * Three seconds rather than the boards builder's own 10 s, and the two layers are
 * *supposed* to disagree: the shard route gives that fetch its full 10 s because
 * failing it costs a working URL, while here the cost of guessing low is one
 * shard omitted under `DEGRADED_CACHE_CONTROL` — sixty seconds, then re-attempted.
 * Cheap to be wrong, so be impatient. It is also the value W-23 (#4483) settled
 * on for its paged summary, so the two collapse into one constant on merge.
 *
 * Not a claim that the builders are cached: `getAllBoardConfigsOrThrow` is a bare
 * `executeGraphQLInternal` call (the `unstable_cache` wrapper in that file is
 * `fetchPopularBoardConfigs`, the limit=12 homepage variant), and `/sitemap.xml`
 * is `force-dynamic`, so every CDN miss re-runs it live. Caching the per-shard
 * summaries is the follow-up; the short degraded window is what makes missing it
 * survivable in the meantime.
 */
export const SHARD_DEADLINE_MS = 3_000;

/**
 * Bounds `work` without cancelling it — a builder that ignores the deadline keeps
 * running (and, for boards, still hits its own `AbortController`); we simply stop
 * waiting. So this bounds *this request's* latency, not the load the abandoned
 * query keeps putting on the pool. Real cancellation needs an `AbortSignal`
 * threaded into `fetchPlaylistSitemapRows` (or a statement timeout on its query),
 * which is a follow-up, not something to claim here.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded its ${ms}ms deadline`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One shard's `<sitemap>` entry, or null when the shard is legitimately empty.
 *
 * Throws for every failure the index degrades on, so the caller has exactly one
 * channel to catch: a builder that rejects, one that misses `SHARD_DEADLINE_MS`,
 * one that expects URLs and built none, and one past the URL budget.
 *
 * That last check is the index adopting the shard route's own rule. A shard over
 * `MAX_URLS_PER_SHARD` is rejected wholesale by Search Console, so its route 503s
 * it — and an index that keeps advertising it points Googlebot at a URL that can
 * never succeed. Counting via `allLocalesUrlCount` instead of expanding: this
 * runs on a `force-dynamic` route and the entries would be discarded immediately.
 */
async function buildIndexEntry(shard: SitemapShard): Promise<SitemapIndexEntry | null> {
  const items = await withDeadline(shard.build(), SHARD_DEADLINE_MS, `shard "${shard.id}"`);

  if (items.length === 0) {
    // A declared-empty shard (gyms, setters, a site with no public playlists) is
    // a success that contributes no entry. One that expects URLs is a regressed
    // query, and `emptinessError` says which is which.
    const emptiness = emptinessError(shard);
    if (emptiness) {
      throw emptiness;
    }
    return null;
  }

  const overBudget = overBudgetError(shard, allLocalesUrlCount(items));
  if (overBudget) {
    throw overBudget;
  }

  return { loc: absoluteUrl(shard.path), lastModified: latestLastModified(items) };
}

/** The index XML plus the shards it had to drop, so the caller can pick a cache window. */
export type SitemapIndexResult = { xml: string; degradedShards: ShardId[] };

/**
 * The index lists only shards that carry at least one URL — pointing Google at
 * an empty `<urlset>` burns a fetch and teaches it the shard is worthless.
 *
 * **The doctrine splits by layer.** A shard *route* stays fail-closed: it 503s
 * when its builder throws or when a shard that expects URLs builds none, because
 * telling Google those pages do not exist is worse than telling it to retry. The
 * *index* degrades instead: a builder that throws, times out, comes back
 * unexpectedly empty or blows the URL budget is logged loudly and its `<sitemap>`
 * entry omitted, and the index still answers 200 with whatever built — under a
 * one-minute cache window, so the omission self-heals. One slow builder taking
 * the other four shards down with it is #4476, and a partial sitemap is strictly
 * better than no sitemap when the shards Google is told about are each still
 * served fail-closed at their own URL.
 *
 * **Concurrent, with only a per-shard deadline.** An earlier draft sequenced the
 * walk under a total budget, which made the last entries in the registry the
 * deterministic victims: five builders each a comfortable 1.9 s — every one of
 * them inside its own deadline — spend the budget before `playlists` runs, and it
 * is dropped for its position rather than its latency. `Promise.allSettled`
 * bounds the walk by max(builder) instead of sum(builder), so no shard can starve
 * another and the total budget stops being needed at all. The fan-out this
 * "widens" is two I/O calls against two different backends (one GraphQL fetch,
 * one indexed query holding one connection of ten) plus three hardcoded builders
 * — not the many-concurrent-heavy-scans shape of #4461, which W-23 sequences
 * *within* its climbs query for exactly that reason. And sequencing would not
 * have bounded pool load anyway: `withDeadline` stops waiting, it does not cancel.
 *
 * Throws only when there is nothing left to publish — every builder failed, or
 * every shard that survived was declared-empty. An empty `<sitemapindex>` served
 * under an hour of `s-maxage` says "this site has no sitemaps", which is the
 * exact harm the fail-closed rule exists to avoid.
 */
export async function buildSitemapIndexXml(): Promise<SitemapIndexResult> {
  const settled = await Promise.allSettled(SHARD_REGISTRY.map((shard) => buildIndexEntry(shard)));

  const entries: SitemapIndexEntry[] = [];
  const degradedShards: ShardId[] = [];
  const emptyShards: ShardId[] = [];

  settled.forEach((outcome, index) => {
    const shard = SHARD_REGISTRY[index];
    if (outcome.status === 'rejected') {
      degradedShards.push(shard.id);
      console.error(
        `[sitemap] shard "${shard.id}" failed — serving the index WITHOUT it:`,
        outcome.reason instanceof Error ? outcome.reason.message : outcome.reason,
      );
      return;
    }
    if (outcome.value === null) {
      emptyShards.push(shard.id);
      return;
    }
    entries.push(outcome.value);
  });

  if (emptyShards.length > 0) {
    // Not a failure — but "the site genuinely has no public playlists" and "the
    // playlists query regressed and now returns []" look identical from here,
    // and without this line the second one leaves no trace anywhere.
    console.warn(`[sitemap] index omitted shards that built no URLs: ${emptyShards.join(', ')}`);
  }

  if (entries.length === 0) {
    throw new Error(
      `[sitemap] index has no shards to publish (${degradedShards.length} of ${SHARD_REGISTRY.length} builders failed) — refusing to publish an empty index`,
    );
  }

  return { xml: renderSitemapIndex(entries), degradedShards };
}

export async function sitemapIndexRouteHandler(): Promise<Response> {
  try {
    const { xml, degradedShards } = await buildSitemapIndexXml();
    if (degradedShards.length === 0) {
      return xmlResponse(xml);
    }
    return xmlResponse(xml, DEGRADED_CACHE_CONTROL, { [DEGRADED_HEADER]: degradedShards.join(',') });
  } catch (err) {
    console.error('[sitemap] index failed to build:', err instanceof Error ? err.message : err);
    return unavailableResponse();
  }
}
