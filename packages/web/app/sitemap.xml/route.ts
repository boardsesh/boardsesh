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

export async function GET(): Promise<Response> {
  return sitemapIndexRouteHandler();
}
