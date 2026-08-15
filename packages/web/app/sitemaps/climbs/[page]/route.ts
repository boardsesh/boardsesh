import { pagedShardRouteHandler } from '@/app/lib/seo/sitemap/shard-registry';

/**
 * `/sitemaps/climbs/1.xml … /N.xml`.
 *
 * A dynamic segment rather than one directory per page: Next has no partial
 * dynamic segments, so `climbs-1.xml` would hardcode today's page count in the
 * filesystem. `[page]` captures the literal `"1.xml"`; the handler parses it and
 * derives `N` from the cached tier-2 summary at request time.
 *
 * `force-dynamic` for the same reason as every other shard: the builder reads
 * the database, so the build must not try to prerender it.
 */
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ page: string }> }): Promise<Response> {
  const { page } = await context.params;
  return pagedShardRouteHandler('climbs', page);
}
