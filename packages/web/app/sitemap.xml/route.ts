import { after } from 'next/server';
import { refreshClimbSummaryIfStale } from '@/app/lib/seo/sitemap/climb-store';
import { warmPlaylistSitemapCache } from '@/app/lib/seo/sitemap/playlist-query';
import { auditTier2ConfigDrift } from '@/app/lib/seo/sitemap/tier2-table';
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

/**
 * Not for the response — the handler bounds every shard at `SHARD_DEADLINE_MS` and
 * answers in well under a second. This is headroom for the `after()` work below,
 * which recomputes the climbs summary and takes tens of seconds when it fires.
 *
 * Vercel-only, and inert everywhere else: on self-hosted Node (the Railway target,
 * #3795) there is no per-invocation ceiling to raise and the `after()` work runs to
 * completion regardless. Harmless to keep after the move, and load-bearing until it.
 */
export const maxDuration = 300;

export async function GET(): Promise<Response> {
  const response = await sitemapIndexRouteHandler();

  // Repopulate the climbs summary store when it is missing or two days stale, on
  // THIS route: the index is the path that exhibited #4523, and `after()` runs
  // once the response has flushed, so it cannot touch the 3 s shard deadline or
  // the latency the crawler sees. `refreshClimbSummaryIfStale` no-ops cheaply on a
  // fresh store and is single-flighted behind a 15-minute floor per instance.
  //
  // It is what makes the fix scheduler-independent: a cron the Railway cutover
  // (#3795/#3798) forgets to re-point degrades to "healed by the next crawl"
  // rather than to a sitemap that quietly goes back to dropping the shard.
  //
  // `after` from 'next/server', never `waitUntil` from '@vercel/functions' — Next
  // 16.2 supplies a real awaiter on self-hosted Node too, and the Vercel-only
  // import would not survive the move off Vercel.
  after(refreshClimbSummaryIfStale);

  // Same slot, same reason, different shard. The playlists rows are cached rather
  // than stored (#4524), and a first-population `unstable_cache` miss registers
  // its write only after the callback resolves — so an index that abandoned the
  // query at the 3 s deadline has already returned and the write is not covered
  // by `pendingWaitUntil`. Re-running it here puts it under the after-context's
  // `withExecuteRevalidates`, where the write is actually executed, which is what
  // turns "heals on some later request" into "heals on this one".
  after(warmPlaylistSitemapCache);

  // Same slot again, and post-flush for the same reason: the tier-2 config
  // cross-check needs `getAllBoardConfigsOrThrow()`, the ~10 s cold GraphQL fetch
  // that caused #4519. Keeping it off the request path is the point of the
  // materialised table (#4583) — it detects a winning-config flip or a group the
  // table has no rows for, and reports through Sentry and the next response's
  // `X-Sitemap-Tier2-Drift` header. It never changes what this response served.
  after(auditTier2ConfigDrift);

  return response;
}
