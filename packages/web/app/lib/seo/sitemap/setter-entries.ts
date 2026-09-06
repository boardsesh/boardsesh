import type { SitemapItem } from './entries';

/**
 * Declared-empty shard. The route exists so filling it is one builder away.
 *
 * The two blockers this comment used to name are now closed (#4473):
 * `/setter/[setter_username]` server-renders its `<h1>`, its summary copy and a
 * real anchor per climb, and it answers a real 404 for a username nobody has a
 * publicly visible climb under instead of a 200 shell for any string at all.
 *
 * What is left is the shard itself (#4465): a query over `board_climbs` with a
 * real `max(updated_at)` per setter, the fixed-to-paged move (a setters page
 * under `expandAllLocales` would render far past `MAX_SHARD_BYTES`), and the
 * item predicate that decides which setters are worth a crawl budget.
 */
export function buildSetterEntries(): SitemapItem[] {
  return [];
}
