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
import { MAX_URLS_PER_SHARD, renderSitemapIndex, renderUrlset } from './sitemap-xml';

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
 * The index lists only shards that carry at least one URL — pointing Google at
 * an empty `<urlset>` burns a fetch and teaches it the shard is worthless.
 *
 * Throws if any builder throws, or if a shard that expects URLs built none, so
 * the route answers 503 rather than publishing an index that quietly dropped a
 * shard. Same doctrine as the shards themselves.
 */
export async function buildSitemapIndexXml(): Promise<string> {
  const built = await Promise.all(SHARD_REGISTRY.map(async (shard) => ({ shard, items: await shard.build() })));

  for (const { shard, items } of built) {
    if (items.length > 0) continue;
    const emptiness = emptinessError(shard);
    if (emptiness) {
      throw emptiness;
    }
  }

  return renderSitemapIndex(
    built
      .filter(({ items }) => items.length > 0)
      .map(({ shard, items }) => ({
        loc: absoluteUrl(shard.path),
        lastModified: latestLastModified(items),
      })),
  );
}

export async function sitemapIndexRouteHandler(): Promise<Response> {
  try {
    return xmlResponse(await buildSitemapIndexXml());
  } catch (err) {
    console.error('[sitemap] index failed to build:', err instanceof Error ? err.message : err);
    return unavailableResponse();
  }
}
