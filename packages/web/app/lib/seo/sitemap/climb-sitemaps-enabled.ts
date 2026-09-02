import 'server-only';

/**
 * The kill switch for climb sitemap publication — roughly 53,000 URLs, and the
 * crawler-driven render and transfer spike that paused them in the first place.
 *
 * The surface is published again (#4648): www serves from a Railway container
 * rather than Vercel, so the per-request ceilings that made the crawl expensive
 * to absorb are gone. `Dockerfile.web` bakes `CLIMB_SITEMAPS_ENABLED=true` into
 * the runner stage, which is what makes the deployed image publish by default.
 *
 * The gate itself deliberately stays. A Railway service variable overrides the
 * image's `ENV`, so setting `CLIMB_SITEMAPS_ENABLED` to anything but `true` on
 * the web service and redeploying pulls the whole surface back to its withdrawn
 * state — 410 on the shard pages, no climb entries in the index — with no code
 * change and no image rebuild. Flipping the default in this function instead
 * would have thrown that lever away.
 *
 * The check stays strict for the same reason it always was: `1`, `TRUE` and a
 * typo must all read as "not enabled" rather than as an accidental republish.
 */
export function climbSitemapsEnabled(): boolean {
  return process.env.CLIMB_SITEMAPS_ENABLED === 'true';
}
