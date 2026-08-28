import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Precomputed answers to the one question `/sitemap.xml` asks each paged shard:
 * how many items does it hold, and when did the newest one change.
 *
 * The index is `force-dynamic` and gives every shard 3 s (`SHARD_DEADLINE_MS`).
 * For the climbs shard that answer is two numbers whose COST is the full
 * `DISTINCT ON (climb_uuid)` tier-2 scan, once per `(board_type, layout_id)`
 * group, run sequentially to avoid the #4461 pool starvation — measured at 16.7 s
 * cold and 0.95 s fully warm for the largest of sixteen groups. No amount of
 * caching makes a cold miss meet the deadline, so every miss dropped ~52,000
 * climb URLs out of the index for at least a minute (#4523). Reading one row here
 * takes ~1 ms at every temperature.
 *
 * Deliberately keyed by a free-form `shard_id` rather than modelling climbs: the
 * playlists shard (#4524) has the same shape of problem and is the next consumer.
 *
 * This table is a CACHE, not a source of truth. Truncating it costs nothing
 * permanent — the read path falls back to the live scan it replaced, and the
 * next refresh repopulates it.
 */
export const sitemapShardRefreshes = pgTable('sitemap_shard_refreshes', {
  /** Shard identity, matching `PagedShardId` in the web shard registry (e.g. 'climbs'). */
  shardId: text('shard_id').primaryKey(),
  /** Item count the index divides by `urlsPerShard` to derive the page count. */
  itemCount: integer('item_count').notNull(),
  /** Newest item timestamp, stamped on every page's `<lastmod>`. Null when the shard is empty. */
  lastModified: timestamp('last_modified'),
  /** When the refresh that wrote this row finished. Drives the staleness self-heal. */
  computedAt: timestamp('computed_at').defaultNow().notNull(),
});

export type SitemapShardRefresh = typeof sitemapShardRefreshes.$inferSelect;
export type NewSitemapShardRefresh = typeof sitemapShardRefreshes.$inferInsert;
