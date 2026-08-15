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
import { renderSitemapIndex, renderUrlset } from './sitemap-xml';

export type ShardId = 'static' | 'boards' | 'gyms' | 'setters' | 'playlists';

export type SitemapShard = {
  id: ShardId;
  path: `/sitemaps/${string}.xml`;
  build: () => Promise<SitemapItem[]>;
};

/**
 * Single source of truth: the index and the five route files both read this, so
 * a shard can never exist in one and not the other (pinned by a unit test that
 * checks each id has a matching route file on disk).
 */
export const SHARD_REGISTRY: readonly SitemapShard[] = [
  { id: 'static', path: '/sitemaps/static.xml', build: async () => buildStaticEntries() },
  {
    id: 'boards',
    path: '/sitemaps/boards.xml',
    build: async () => boardConfigsToItems(await getAllBoardConfigsOrThrow()),
  },
  { id: 'gyms', path: '/sitemaps/gyms.xml', build: async () => buildGymEntries() },
  { id: 'setters', path: '/sitemaps/setters.xml', build: async () => buildSetterEntries() },
  {
    id: 'playlists',
    path: '/sitemaps/playlists.xml',
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

export async function shardRouteHandler(id: ShardId): Promise<Response> {
  const shard = SHARD_REGISTRY.find((candidate) => candidate.id === id);
  if (!shard) {
    return unavailableResponse();
  }

  let items: SitemapItem[];
  try {
    items = await shard.build();
  } catch (err) {
    console.error(`[sitemap] shard "${id}" failed to build:`, err instanceof Error ? err.message : err);
    return unavailableResponse();
  }

  return xmlResponse(renderUrlset(expandAllLocales(items)));
}

/**
 * The index lists only shards that carry at least one URL — pointing Google at
 * an empty `<urlset>` burns a fetch and teaches it the shard is worthless.
 *
 * Throws if any builder throws, so the route answers 503 rather than publishing
 * an index that quietly dropped a shard. Same doctrine as the shards themselves.
 */
export async function buildSitemapIndexXml(): Promise<string> {
  const built = await Promise.all(SHARD_REGISTRY.map(async (shard) => ({ shard, items: await shard.build() })));

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
