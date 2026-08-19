import { pagedShardRouteHandler } from '@/app/lib/seo/sitemap/shard-registry';

/**
 * `/sitemaps/setters/1.xml … /N.xml`.
 *
 * A dynamic segment rather than one directory per page: Next has no partial
 * dynamic segments, so a `setters-1.xml` shape would hardcode today's page
 * count in the filesystem. `[page]` captures the literal `"1.xml"`; the handler
 * parses it and derives `N` from the cached setter summary at request time.
 *
 * `force-dynamic` for the same reason as every other shard: the builder reads
 * the database, so the build must not try to prerender it.
 */
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ page: string }> }): Promise<Response> {
  const { page } = await context.params;
  return pagedShardRouteHandler('setters', page);
}
