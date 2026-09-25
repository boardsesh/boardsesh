/**
 * Board types that never appear in a sitemap, and the one exception SW-16 made.
 *
 * Only `spray` is withheld by TYPE, and it is a privacy rule rather than an SEO
 * one. A spray wall is one climber's own wall: private by default, its photo
 * behind a presigned URL, and its climbs visible to whoever the owner shared the
 * wall with. A sitemap is the opposite of that — it hands Google a list of every
 * URL we want crawled, and a crawled URL is a public one.
 *
 * SW-16 (#5449) made the indexing decision the SW-03 comment left open, and it
 * narrowed the rule in one place only:
 *
 *  - The board TYPE stays non-indexable. A wall gets no `/list` entry in
 *    `/sitemaps/boards.xml` and no `/spray/...` config-tuple URL anywhere.
 *    `boardHasDeepConfigRoute` does not route that tree on www, so those URLs
 *    404 and there is nothing to submit. `isIndexableBoardType` is unchanged and
 *    is what the boards shard still asks.
 *  - The CLIMBS of a wall whose owner marked it `is_public` are indexable,
 *    through the `/b/{slug}` front door they already self-canonicalise to.
 *
 * The two questions therefore get two functions. Per-wall visibility is not a
 * property of the board type, so it cannot live in the set below: it travels on
 * the config as `sprayWallSlug`, which only `getPublicSprayWallConfigs()` sets,
 * and only for a public, published, undeleted, slugged wall. A spray config that
 * reached the sitemap any other way carries no slug and stays out.
 */
const NON_INDEXABLE_BOARD_TYPES: ReadonlySet<string> = new Set(['spray']);

/** Whether a board type's own pages may be submitted for crawling. */
export function isIndexableBoardType(boardType: string): boolean {
  return !NON_INDEXABLE_BOARD_TYPES.has(boardType);
}

/**
 * Whether the CLIMBS of a configuration may be submitted for crawling.
 *
 * The slug is the consent token, not a convenience. `getPublicSprayWallConfigs()`
 * is its only writer, so a spray config arriving from anywhere else — a
 * hand-built one in a test, a future caller that concatenates the listed configs
 * differently — is refused here rather than trusted.
 *
 * Every other board type falls through to `isIndexableBoardType`, so this stays
 * one rule with one exception rather than two lists that can drift apart.
 */
export function isIndexableClimbConfig(config: { boardType: string; sprayWallSlug?: string }): boolean {
  if (config.boardType === 'spray') {
    return Boolean(config.sprayWallSlug);
  }
  return isIndexableBoardType(config.boardType);
}
