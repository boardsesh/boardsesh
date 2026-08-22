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

/**
 * The only shard route carrying one, because it is the only one whose fallback
 * is a minute-long scan. Steady state this is an ordinal range read of
 * `sitemap_climb_urls` answering in ~0.1 s. Before the first refresh — the
 * deploy that adds a board, a truncation, local dev — `buildClimbShardPage`
 * falls back to the live grouped build, the 51 s path `docs/sitemap.md`
 * documents, which is the same scan the refresher runs: 64.9 s cold and
 * 20-28 s warm on the dev image with MoonBoard's groups in. Only the first
 * request pays it, because the fallback build is TTL-cached per instance (a
 * measured first hit answered in 22.7 s, dev route compile included; the next
 * two in 0.40 s and 0.48 s).
 *
 * Without this export the platform default cuts that first request off as a
 * 504. With it the crawler gets the slow-but-correct 200 the fallback is
 * designed to be. The `after()` self-heal fires on `/sitemap.xml` only, so a
 * crawler that reaches a page URL first does not get the window closed for it.
 *
 * Same value and the same Vercel-only caveat as `/sitemap.xml` and the cron
 * refresher: inert on self-hosted Node, where there is no per-invocation ceiling.
 */
export const maxDuration = 300;

export async function GET(_request: Request, context: { params: Promise<{ page: string }> }): Promise<Response> {
  const { page } = await context.params;
  return pagedShardRouteHandler('climbs', page);
}
