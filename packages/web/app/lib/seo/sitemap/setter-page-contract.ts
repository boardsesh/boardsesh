import 'server-only';

/**
 * The two numbers the setters shard and the setter page must agree on.
 *
 * They live here rather than in either module because a disagreement between
 * them is invisible in both: the shard decides which setters to submit, the
 * page decides whether to let itself be indexed, and each looked correct on its
 * own while together they published URLs that refused indexing.
 *
 * That is exactly what happened. The shard counted linkable climbs across a
 * setter's WHOLE catalogue; the page's `noindex` fires when PAGE ONE — the top
 * `SETTER_PAGE_SIZE` by ascents, with no linkable filter — carries no crawlable
 * link. A setter with fifty high-ascent climbs on unresolvable configurations
 * and three low-ascent linkable ones passed the shard and self-noindexed.
 *
 * `buildSetterSitemapSql` now applies both: the catalogue floor decides whether
 * a setter is worth crawling at all, and a page-one check decides whether the
 * URL it would submit can actually be indexed.
 */

/** Climbs per setter page. The shard's page-one check ranks against this. */
export const SETTER_PAGE_SIZE = 50;

/**
 * Linkable climbs a setter needs across their catalogue before the shard
 * submits them — the "worth a crawl budget" floor, not the indexability one.
 */
export const SETTER_MIN_VISIBLE_CLIMBS = 3;
