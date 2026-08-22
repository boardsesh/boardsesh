import 'server-only';
import { getAllBoardConfigsOrThrow } from '@/app/lib/server-popular-configs';
import { absoluteUrl } from '@/app/lib/seo/base-url';
import { boardConfigsToItems } from './board-entries';
import { buildTier2ClimbItems } from './climb-query';
import { fetchClimbShardSummary } from './climb-store';
import { buildTier2TablePage, tier2SourceHeaders } from './tier2-table';
import {
  allLocalesUrlCount,
  expandAllLocales,
  expandDefaultLocaleOnly,
  latestLastModified,
  type SitemapItem,
} from './entries';
import { buildGymEntries } from './gym-entries';
import { playlistRowsToItems } from './playlist-entries';
import { fetchPlaylistSitemapRows } from './playlist-query';
import { buildSetterEntries } from './setter-entries';
import { buildStaticEntries } from './static-entries';
import {
  CLIMB_URLS_PER_SHARD,
  MAX_SHARD_BYTES,
  MAX_URLS_PER_SHARD,
  renderSitemapIndex,
  renderUrlset,
  type SitemapIndexEntry,
  type SitemapUrlEntry,
} from './sitemap-xml';

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

/**
 * Climb shards get a far longer window than the hourly one the small shards use.
 * Google refetches a sitemap on the order of days, tier 2 changes on the order of
 * hours, and the CDN is what absorbs a crawl burst across a dozen pages before it
 * reaches a ten-connection pool.
 */
const CLIMB_CACHE_CONTROL = 'public, s-maxage=21600, stale-while-revalidate=604800';

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
 * A page number that was never valid is not a transient failure: `/…/0.xml`,
 * `/…/abc.xml` and a page past the end must 404 so a crawler stops asking,
 * where a 503 would have it retry forever.
 */
function notFoundResponse(): Response {
  return new Response('sitemap shard page not found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
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

// ---------------------------------------------------------------------------
// Paged shards
// ---------------------------------------------------------------------------

/**
 * How a shard's items become `<url>` entries. `all-locales` is W-22's original
 * behaviour; `default-locale-only` exists for the climb shards, where the
 * four-locale fan-out is what makes the payload undeployable (see
 * `expandDefaultLocaleOnly`).
 */
export type ShardExpansion = 'all-locales' | 'default-locale-only';

export type PagedShardId = 'climbs';

/**
 * The shard's total item count and freshness.
 *
 * For climbs this is now a single-row read of `sitemap_shard_refreshes`
 * (`fetchClimbShardSummary`), ~1 ms at every temperature. It used to be a small
 * ANSWER to an expensive QUESTION — the same sixteen `DISTINCT ON` scans as the
 * item build, 16.7 s cold — which is why the index dropped the shard on any cache
 * miss (#4523).
 *
 * The deadline below stays regardless: the live scan is still the fallback while
 * the store is empty, and `playlists` has no precomputation at all.
 */
export type PagedShardSummary = { itemCount: number; lastModified: Date | null };

/** One page's slice, plus the length of the list it was sliced from. */
export type PagedShardPage = { items: SitemapItem[]; totalItems: number };

/**
 * A shard too large for one file, split across `/sitemaps/<dir>/1.xml … N.xml`.
 *
 * `N` is derived from `summary()` at request time, never from the filesystem:
 * Next has no partial dynamic segments, so a `climbs-1.xml` shape would need one
 * directory per page and would hardcode today's page count in the tree.
 */
export type PagedSitemapShard = {
  id: PagedShardId;
  /** Directory under `app/sitemaps/`, pinned against the on-disk walk. */
  routeDirectory: string;
  pagePath: (page: number) => string;
  expansion: ShardExpansion;
  urlsPerShard: number;
  expectsUrls: boolean;
  cacheControl: string;
  /** The index calls this, never `buildPage`. Raced against `SHARD_DEADLINE_MS`. */
  summary: () => Promise<PagedShardSummary>;
  buildPage: (page: number) => Promise<PagedShardPage>;
  /**
   * Headers naming which path served this shard, set on the index AND on every
   * page. Never allowed to fail the response — a diagnostic that can 503 the
   * thing it diagnoses is worse than no diagnostic.
   */
  responseHeaders?: () => Promise<Record<string, string>>;
};

export const PAGED_SHARD_REGISTRY: readonly PagedSitemapShard[] = [
  {
    id: 'climbs',
    routeDirectory: 'climbs',
    pagePath: (page: number) => `/sitemaps/climbs/${page}.xml`,
    expansion: 'default-locale-only',
    urlsPerShard: CLIMB_URLS_PER_SHARD,
    // A climbs page that renders zero URLs is a regressed query, not a state:
    // the summary already said there were items on it.
    expectsUrls: true,
    cacheControl: CLIMB_CACHE_CONTROL,
    summary: () => fetchClimbShardSummary(),
    /**
     * Two bounded range scans over `sitemap_tier2_climbs`, or the live grouped
     * build when the table cannot be trusted (#4583).
     *
     * The fallback is the shape this replaced: it builds the ENTIRE ordered list
     * before it can slice page N — measured at 27.4 s for a genuinely cold
     * production page fetch on 2026-08-21 — so on a cold crawl across N lambdas
     * the cost really is N full builds. The table path pays one PK-prefix index
     * range scan of at most `CLIMB_URLS_PER_SHARD` rows instead.
     */
    buildPage: async (page: number) => {
      const fromTable = await buildTier2TablePage(page, CLIMB_URLS_PER_SHARD);
      if (fromTable) return fromTable;

      const items = await buildTier2ClimbItems();
      const start = (page - 1) * CLIMB_URLS_PER_SHARD;
      return { items: items.slice(start, start + CLIMB_URLS_PER_SHARD), totalItems: items.length };
    },
    responseHeaders: () => tier2SourceHeaders(),
  },
];

function expandForShard(items: readonly SitemapItem[], expansion: ShardExpansion): SitemapUrlEntry[] {
  return expansion === 'all-locales' ? expandAllLocales(items) : expandDefaultLocaleOnly(items);
}

export function pagedShardPageCount(summary: PagedShardSummary, urlsPerShard: number): number {
  return Math.ceil(summary.itemCount / urlsPerShard);
}

export async function pagedShardRouteHandler(id: PagedShardId, rawPage: string): Promise<Response> {
  const shard = PAGED_SHARD_REGISTRY.find((candidate) => candidate.id === id);
  if (!shard) {
    return unavailableResponse();
  }

  // `[1-9]\d*` and not `\d+`: `Number('007')` is 7, so a permissive parser gives
  // every real page an unbounded family of alias URLs (`01.xml`, `0000001.xml`)
  // that each 200 with a six-hour cache header and each look to Search Console
  // like a separate submission of the same URLs. A page number that was never
  // canonical is exactly the "never valid" case this route 404s.
  const parsed = /^([1-9]\d*)\.xml$/.exec(rawPage);
  if (!parsed) {
    return notFoundResponse();
  }
  const page = Number(parsed[1]);
  if (!Number.isSafeInteger(page)) {
    return notFoundResponse();
  }

  let body: string;
  try {
    const summary = await shard.summary();
    if (page > pagedShardPageCount(summary, shard.urlsPerShard)) {
      return notFoundResponse();
    }

    const { items, totalItems } = await shard.buildPage(page);
    // The summary and item list have independent epochs — the summary is a row in
    // `sitemap_shard_refreshes` (global, refreshed on a cron), while the list is an
    // in-process TTL (per instance). A fresh summary can therefore advertise page 2
    // while a warm instance still holds exactly 10,000 items. Materialising the
    // summary made that gap wider, not narrower, and the follow-up that stores the
    // URLs too is what finally closes it by giving both halves one epoch.
    // That empty slice is transient disagreement, not
    // a permanently invalid URL: 503/no-store asks the crawler to retry after the
    // item epoch catches up. A true out-of-range page was already rejected above
    // by the current summary and remains a 404.
    if (items.length === 0 && totalItems > 0) {
      throw new Error(
        `[sitemap] paged shard "${shard.id}" page ${page} is listed by a ${summary.itemCount}-item summary but its cached ${totalItems}-item build has no slice — cache epochs disagree`,
      );
    }
    if (items.length === 0 && shard.expectsUrls) {
      throw new Error(
        `[sitemap] paged shard "${shard.id}" page ${page} built no items although the summary listed it — refusing to publish an empty page`,
      );
    }

    const urls = expandForShard(items, shard.expansion);
    if (urls.length > shard.urlsPerShard) {
      throw new Error(
        `[sitemap] paged shard "${shard.id}" page ${page} built ${urls.length} URLs, past its ${shard.urlsPerShard} budget`,
      );
    }

    body = renderUrlset(urls);
    // The guard runs on the rendered body, not on a row count: a constant that
    // nothing measures is a comment, and Vercel truncates a response past
    // 4.5 MB into a platform error that looks like a sitemap outage.
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > MAX_SHARD_BYTES) {
      throw new Error(
        `[sitemap] paged shard "${shard.id}" page ${page} rendered ${bytes} bytes, past the ${MAX_SHARD_BYTES} response budget — lower urlsPerShard`,
      );
    }
  } catch (err) {
    console.error(
      `[sitemap] paged shard "${id}" page "${rawPage}" failed to build:`,
      err instanceof Error ? err.message : err,
    );
    return unavailableResponse();
  }

  return xmlResponse(body, shard.cacheControl, await safeShardHeaders(shard));
}

/**
 * A shard's diagnostic headers, or none. Swallows a failure on purpose: these
 * exist so a degradation is legible from a `curl -I`, and a diagnostic that can
 * take down the response it annotates would be a worse bug than the one it
 * reports.
 */
async function safeShardHeaders(shard: PagedSitemapShard): Promise<Record<string, string> | undefined> {
  if (!shard.responseHeaders) return undefined;
  try {
    return await shard.responseHeaders();
  } catch (err) {
    console.error(
      `[sitemap] paged shard "${shard.id}" could not describe its source:`,
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}

/**
 * How long the index waits for one fixed builder or paged-shard summary before
 * publishing without it.
 *
 * Read it as a property of the *index*, not a verdict on the builder. The two
 * recorded production failures were rejections, not stalls — a 503 is this
 * file's own `unavailableResponse`, and `getAllBoardConfigsOrThrow`'s 10 s abort
 * surfaces as a throw — so the try/catch alone already covers what was measured.
 * The deadline covers the mode a try/catch structurally cannot see: a builder or
 * paged summary that never settles would otherwise hold the whole index to the
 * platform timeout, taking down every shard that was ready.
 *
 * Three seconds rather than the boards builder's own 10 s, and the two layers are
 * *supposed* to disagree: the shard route gives that fetch its full 10 s because
 * failing it costs a working URL, while here the cost of guessing low is one
 * shard omitted under `DEGRADED_CACHE_CONTROL` — sixty seconds, then re-attempted.
 * Cheap to be wrong, so be impatient. W-23 (#4483) settled on the same value for
 * its paged summary, so fixed and paged work intentionally share one constant.
 *
 * The data-backed builders no longer share one shape, and the difference is the
 * point. `getAllBoardConfigsOrThrow` is cached at two levels — a Next Data Cache
 * entry plus an in-process TTL and single-flight — because `/sitemap.xml` is
 * `force-dynamic` and every CDN miss otherwise re-ran it live: the uncached boards
 * fetch took ~10 s cold and deterministically lost its shard on the first request
 * after a deploy (#4519). The climbs summary is no longer cached-expensive but
 * PRECOMPUTED: one row of `sitemap_shard_refreshes`, written by a cron and an
 * `after()` self-heal, because caching an expensive question only moves when you
 * pay for it — a cold miss on sixteen sequential `DISTINCT ON` scans could never
 * meet 3 s at any cache temperature (#4523). `fetchPlaylistSitemapRows` is cached
 * like boards rather than precomputed like climbs, because its answer is small
 * enough to hold — ~200 KB of rows today, ~840 KB at the item cap, against
 * Vercel's 2 MB Data Cache entry ceiling (#4524). All three data-backed builders
 * are covered now; none of them is covered on a genuinely cold entry.
 *
 * None of that makes the deadline redundant. It makes it *reachable*: the first
 * boards or playlists miss after a cold start still pays full price, and an empty
 * climbs store falls back to the same scan that used to blow the budget.
 */
export const SHARD_DEADLINE_MS = 3_000;

/**
 * Bounds `work` without cancelling it — a builder that ignores the deadline keeps
 * running (and, for boards, still hits its own `AbortController`); we simply stop
 * waiting. So this bounds *this request's* latency, not the load the abandoned
 * query keeps putting on the pool.
 *
 * Still not cancellation, and the wording matters. The playlists query now runs
 * under `SET LOCAL statement_timeout = '15s'` (#4524), which bounds a pathological
 * plan rather than releasing the connection at 3 s — deliberately, since the
 * `/sitemaps/playlists.xml` route legitimately takes up to ~4 s and a deadline-tight
 * timeout would break a working URL. Real cancellation still needs an `AbortSignal`
 * threaded through, which is a follow-up, not something to claim here.
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

async function buildPagedIndexEntries(shard: PagedSitemapShard): Promise<SitemapIndexEntry[] | null> {
  // `summary()`, NEVER `buildPage()`. Running the full climb-item build on every
  // `/sitemap.xml` hit is the pool-starvation failure (#4461) this split avoids.
  const summary = await withDeadline(shard.summary(), SHARD_DEADLINE_MS, `paged shard "${shard.id}" summary`);
  const pageCount = pagedShardPageCount(summary, shard.urlsPerShard);

  if (pageCount === 0) {
    if (shard.expectsUrls) {
      throw new Error(
        `[sitemap] paged shard "${shard.id}" expects URLs but its summary reports 0 — the entire surface is absent from the index`,
      );
    }
    return null;
  }

  // Every page carries the shard's global max of the climb-content and stats
  // clocks, so one content or stats update can make all N pages look changed. A
  // per-page `<lastmod>` would require building the items to know which page a
  // climb fell on — the exact scan the summary/build split exists to avoid — so
  // the uniform value is the deliberate trade.
  return Array.from({ length: pageCount }, (_, pageIndex) => ({
    loc: absoluteUrl(shard.pagePath(pageIndex + 1)),
    lastModified: summary.lastModified,
  }));
}

export type SitemapIndexShardId = ShardId | PagedShardId;

/** The index XML plus the shards it had to drop, so the caller can pick a cache window. */
export type SitemapIndexResult = { xml: string; degradedShards: SitemapIndexShardId[] };

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
 * every other ready shard down with it is #4476, and a partial sitemap is strictly
 * better than no sitemap when the shards Google is told about are each still
 * served fail-closed at their own URL.
 *
 * **Concurrent, with only a per-shard deadline.** An earlier draft sequenced the
 * fixed walk under a total budget, which made the tail of the registry the
 * deterministic victim even when every builder met its own deadline.
 * `Promise.allSettled` bounds the walk by max(builder or summary) instead of their
 * sum, so no shard is dropped for its position. The climb query still sequences
 * its heavy per-board scans internally; the registry only starts its cached
 * summary alongside the boards fetch and playlists query. `withDeadline` stops
 * waiting rather than cancelling, so sequencing here would not bound pool load.
 *
 * Throws only when there is nothing left to publish — every builder failed, or
 * every shard that survived was declared-empty. An empty `<sitemapindex>` served
 * under an hour of `s-maxage` says "this site has no sitemaps", which is the
 * exact harm the fail-closed rule exists to avoid.
 */
export async function buildSitemapIndexXml(): Promise<SitemapIndexResult> {
  const [fixedSettled, pagedSettled] = await Promise.all([
    Promise.allSettled(SHARD_REGISTRY.map((shard) => buildIndexEntry(shard))),
    Promise.allSettled(PAGED_SHARD_REGISTRY.map((shard) => buildPagedIndexEntries(shard))),
  ]);

  const entries: SitemapIndexEntry[] = [];
  const degradedShards: SitemapIndexShardId[] = [];
  const emptyShards: SitemapIndexShardId[] = [];

  fixedSettled.forEach((outcome, index) => {
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

  pagedSettled.forEach((outcome, index) => {
    const shard = PAGED_SHARD_REGISTRY[index];
    if (outcome.status === 'rejected') {
      degradedShards.push(shard.id);
      console.error(
        `[sitemap] paged shard "${shard.id}" failed — serving the index WITHOUT its pages:`,
        outcome.reason instanceof Error ? outcome.reason.message : outcome.reason,
      );
      return;
    }
    if (outcome.value === null) {
      emptyShards.push(shard.id);
      return;
    }
    entries.push(...outcome.value);
  });

  if (emptyShards.length > 0) {
    // Not a failure — but "the site genuinely has no public playlists" and "the
    // playlists query regressed and now returns []" look identical from here,
    // and without this line the second one leaves no trace anywhere.
    console.warn(`[sitemap] index omitted shards that built no URLs: ${emptyShards.join(', ')}`);
  }

  if (entries.length === 0) {
    const builderCount = SHARD_REGISTRY.length + PAGED_SHARD_REGISTRY.length;
    throw new Error(
      `[sitemap] index has no shards to publish (${degradedShards.length} of ${builderCount} builders failed) — refusing to publish an empty index`,
    );
  }

  return { xml: renderSitemapIndex(entries), degradedShards };
}

export async function sitemapIndexRouteHandler(): Promise<Response> {
  try {
    const { xml, degradedShards } = await buildSitemapIndexXml();
    // Every paged shard gets to say which path answered it, degraded or not.
    // `climbs` is the one that does today (`X-Sitemap-Tier2-Source`): the index
    // no longer drops the shard, so "is it being served from the materialised
    // table or from the live scan" is the question a `curl -I` needs answered,
    // and it is what the post-deploy smoke asserts.
    const shardHeaders: Record<string, string> = {};
    for (const shard of PAGED_SHARD_REGISTRY) {
      Object.assign(shardHeaders, await safeShardHeaders(shard));
    }

    if (degradedShards.length === 0) {
      return xmlResponse(xml, CACHE_CONTROL, shardHeaders);
    }
    return xmlResponse(xml, DEGRADED_CACHE_CONTROL, {
      ...shardHeaders,
      [DEGRADED_HEADER]: degradedShards.join(','),
    });
  } catch (err) {
    console.error('[sitemap] index failed to build:', err instanceof Error ? err.message : err);
    return unavailableResponse();
  }
}
