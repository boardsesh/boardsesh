import 'server-only';
import { getAllBoardConfigsOrThrow } from '@/app/lib/server-popular-configs';
import { absoluteUrl } from '@/app/lib/seo/base-url';
import { boardConfigsToItems } from './board-entries';
import { expandAllLocales, latestLastModified, type SitemapItem } from './entries';
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

function xmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': CACHE_CONTROL,
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
 * How long the index waits for one builder before giving up on it.
 *
 * A try/catch only sees a builder that *rejects*. The failure #4476 records in
 * production is the other one: a cold serverless instance against a cold backend
 * and a cold database, where `getAllBoardConfigsOrThrow` sits on its 10s abort
 * and `fetchPlaylistSitemapRows` has no bound at all. Without a deadline that
 * builder holds the request until the platform kills it, which is a 5xx on the
 * whole index — strictly worse than the 503 the fail-closed doctrine was written
 * to prevent, because it takes the four shards that *were* ready down with it.
 *
 * Three seconds: the index has no latency requirement that justifies more, the
 * same value W-23 (#4483) settled on for its paged-shard summary, and every
 * builder behind it is cached (`unstable_cache` for boards, the CDN's hourly
 * `s-maxage` for the response itself). A builder that misses it is omitted for
 * one cache generation, not deleted — Google keeps the copy of the shard it
 * already has, which is the whole reason omitting beats 503ing.
 */
export const SHARD_DEADLINE_MS = 3_000;

/**
 * Total wall-clock budget for the sequential walk, so N slow shards cannot add
 * up to a platform timeout the per-shard deadline never sees. Five shards ×3s
 * is 15s, past the serverless ceiling; 8s leaves the response room to render and
 * still lets a first slow shard spend its full deadline without starving the
 * rest.
 */
export const INDEX_DEADLINE_MS = 8_000;

/**
 * Bounds `work` without cancelling it — a builder that ignores the deadline keeps
 * running (and, for boards, still hits its own `AbortController`); we simply stop
 * waiting. Cancellation would need every builder to thread a signal, which is a
 * bigger change than the one this bug needs.
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
 * The index lists only shards that carry at least one URL — pointing Google at
 * an empty `<urlset>` burns a fetch and teaches it the shard is worthless.
 *
 * **The doctrine splits by layer.** A shard *route* stays fail-closed: it 503s
 * when its builder throws or when a shard that expects URLs builds none, because
 * telling Google those pages do not exist is worse than telling it to retry. The
 * *index* degrades instead: a builder that throws, times out, or comes back
 * unexpectedly empty is logged loudly and its `<sitemap>` entry omitted, and the
 * index still answers 200 with whatever built. One slow builder taking the other
 * four shards down with it is #4476, and a partial sitemap is strictly better
 * than no sitemap when the shards Google is told about are each still served
 * fail-closed at their own URL.
 *
 * Sequential, not `Promise.all`: the concurrent fan-out is the pool-starvation
 * shape #4461 is about (the playlists builder reads the database, the boards one
 * the GraphQL backend), and the index has no latency requirement that justifies
 * it. The walk is bounded by `INDEX_DEADLINE_MS`, so sequencing cannot trade one
 * timeout for another.
 *
 * Throws only when there is nothing left to publish — every builder failed, or
 * every shard that survived was declared-empty. An empty `<sitemapindex>` served
 * under an hour of `s-maxage` says "this site has no sitemaps", which is the
 * exact harm the fail-closed rule exists to avoid.
 */
export async function buildSitemapIndexXml(): Promise<string> {
  const entries: SitemapIndexEntry[] = [];
  let failureCount = 0;
  const startedAt = Date.now();

  for (const shard of SHARD_REGISTRY) {
    try {
      const budget = Math.min(SHARD_DEADLINE_MS, INDEX_DEADLINE_MS - (Date.now() - startedAt));
      if (budget <= 0) {
        throw new Error(`the index spent its ${INDEX_DEADLINE_MS}ms budget before this shard ran`);
      }

      const items = await withDeadline(shard.build(), budget, `shard "${shard.id}"`);
      if (items.length === 0) {
        // A declared-empty shard (gyms, setters, a site with no public
        // playlists) is a success that contributes no entry. One that expects
        // URLs is a regressed query, and `emptinessError` says which is which.
        const emptiness = emptinessError(shard);
        if (emptiness) {
          throw emptiness;
        }
        continue;
      }

      entries.push({ loc: absoluteUrl(shard.path), lastModified: latestLastModified(items) });
    } catch (err) {
      failureCount += 1;
      console.error(
        `[sitemap] shard "${shard.id}" failed — serving the index WITHOUT it:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (entries.length === 0) {
    throw new Error(
      `[sitemap] index has no shards to publish (${failureCount} of ${SHARD_REGISTRY.length} builders failed) — refusing to publish an empty index`,
    );
  }

  return renderSitemapIndex(entries);
}

export async function sitemapIndexRouteHandler(): Promise<Response> {
  try {
    return xmlResponse(await buildSitemapIndexXml());
  } catch (err) {
    console.error('[sitemap] index failed to build:', err instanceof Error ? err.message : err);
    return unavailableResponse();
  }
}
