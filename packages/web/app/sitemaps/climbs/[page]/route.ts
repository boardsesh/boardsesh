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

// There is deliberately no `maxDuration` export here, for the same reason
// `/sitemap.xml` dropped its own (#4648). 300 was Vercel's Pro ceiling, bought
// for the one request that pays the fallback: before the first refresh — the
// deploy that adds a board, a truncation, local dev — `buildClimbShardPage`
// falls back to the live grouped build, the 51 s path `docs/sitemap.md`
// documents (64.9 s cold and 20-28 s warm on the dev image with MoonBoard's
// groups in; only the first request pays it, because the fallback is TTL-cached
// per instance). www serves from a Railway container now, where there is no
// per-invocation ceiling to raise, so the export would describe a platform this
// route no longer runs on. The Vercel deployment kept for the rollback window
// is not a reason to keep it: `/sitemap.xml` dropped its own under exactly that
// condition, and that deployment already serves the withdrawn climb contract
// (410 from these pages) until `CLIMB_SITEMAPS_ENABLED` is set there.

export async function GET(_request: Request, context: { params: Promise<{ page: string }> }): Promise<Response> {
  const { page } = await context.params;
  return pagedShardRouteHandler('climbs', page);
}
