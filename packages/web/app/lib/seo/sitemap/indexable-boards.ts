/**
 * Board types that never appear in a sitemap.
 *
 * Only `spray` so far, and it is a privacy rule rather than an SEO one. A spray
 * wall is one climber's own wall: private by default, its photo behind a
 * presigned URL, and its climbs visible to whoever the owner shared the wall
 * with. A sitemap is the opposite of that — it hands Google a list of every URL
 * we want crawled, and a crawled URL is a public one.
 *
 * Excluding the board TYPE, not the private walls, is the point. Per-wall
 * visibility (`is_public` / `is_unlisted`) governs who may open a wall in the
 * app; it is not consent to have the wall's climbs indexed. SW-16 (#5449) is
 * where public walls get an indexing decision of their own, and it can narrow
 * this set when it makes one.
 */
const NON_INDEXABLE_BOARD_TYPES: ReadonlySet<string> = new Set(['spray']);

/** Whether a board type's pages and climbs may be submitted for crawling. */
export function isIndexableBoardType(boardType: string): boolean {
  return !NON_INDEXABLE_BOARD_TYPES.has(boardType);
}
