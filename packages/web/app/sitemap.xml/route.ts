import { after } from 'next/server';
import { refreshClimbSummaryIfStale } from '@/app/lib/seo/sitemap/climb-store';
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

  return response;
}
