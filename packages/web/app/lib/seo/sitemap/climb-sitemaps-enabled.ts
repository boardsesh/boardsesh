import 'server-only';

/**
 * Climb sitemaps are paused by default because publishing roughly 53,000 climb
 * URLs created the crawler-driven render and transfer spike. Keep the check
 * strict so values such as `1`, `TRUE`, or an unset variable cannot enable the
 * surface accidentally.
 */
export function climbSitemapsEnabled(): boolean {
  return process.env.CLIMB_SITEMAPS_ENABLED === 'true';
}
