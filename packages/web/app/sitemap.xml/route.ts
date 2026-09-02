import { after } from 'next/server';
import { climbSitemapsEnabled } from '@/app/lib/seo/sitemap/climb-sitemaps-enabled';
import { refreshClimbStoreIfStale } from '@/app/lib/seo/sitemap/climb-store';
import { warmPlaylistSitemapCache } from '@/app/lib/seo/sitemap/playlist-query';
import { sitemapIndexRouteHandler } from '@/app/lib/seo/sitemap/shard-registry';

/**
 * `MetadataRoute.Sitemap` can only express a `<urlset>` — grep Next 16.2's dist
 * for `sitemapindex` and you get zero hits — so the index is a route handler.
 * Next supports the shape explicitly: `normalizeMetadataRoute` documents
 * "Support both /<metadata-route.ext> and custom routes /<metadata-route>/route.ts".
 *
 * `force-dynamic` is mandatory, not decorative: `isMetadataRoute('/sitemap.xml/route')`
 * is true, and Next's app-route exporter uses that to skip its static-gen bail-out,
 * so without this the build would try to prerender a database-backed route.
 */
export const dynamic = 'force-dynamic';

// There is deliberately no `maxDuration` export here. It was 300 — Vercel's Pro
// ceiling — bought not for the response (every shard is bounded at
// `SHARD_DEADLINE_MS` and the handler answers in well under a second) but as
// headroom for the `after()` refresh below, which takes tens of seconds when it
// fires. www serves from a Railway container now (#4648), where there is no
// per-invocation ceiling and the `after()` work runs to completion regardless,
// so the export only described a platform this route no longer runs on.

export async function GET(): Promise<Response> {
  const response = await sitemapIndexRouteHandler();

  // Repopulate the climb sitemap store — the summary row AND the URL rows — when
  // it is missing or two days stale, on THIS route: the index is the path that
  // exhibited #4523, and `after()` runs once the response has flushed, so it
  // cannot touch the 3 s shard deadline or the latency the crawler sees.
  // `refreshClimbStoreIfStale` no-ops cheaply on a fresh store and is
  // single-flighted behind a 15-minute floor per instance.
  //
  // It keeps the enabled surface scheduler-independent: a missing or stale store
  // degrades to "healed by the next crawl" rather than to a sitemap that quietly
  // goes back to dropping the shard.
  //
  // `after` from 'next/server', never `waitUntil` from '@vercel/functions' — Next
  // 16.2 supplies a real awaiter on self-hosted Node too, and the Vercel-only
  // import would not survive the move off Vercel.
  if (climbSitemapsEnabled()) {
    after(refreshClimbStoreIfStale);
  }

  // Same slot, same reason, different shard. The playlists rows are cached rather
  // than stored (#4524), and a first-population `unstable_cache` miss registers
  // its write only after the callback resolves — so an index that abandoned the
  // query at the 3 s deadline has already returned and the write is not covered
  // by `pendingWaitUntil`. Re-running it here puts it under the after-context's
  // `withExecuteRevalidates`, where the write is actually executed, which is what
  // turns "heals on some later request" into "heals on this one".
  after(warmPlaylistSitemapCache);

  return response;
}
