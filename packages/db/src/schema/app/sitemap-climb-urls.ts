import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * The rendered tier-2 climb sitemap, one row per submitted URL, in emission
 * order.
 *
 * `sitemap_shard_refreshes` fixed the INDEX: two numbers answer "how many climb
 * pages exist" in a millisecond. The shard pages themselves stayed slow, because
 * page N was a JS slice of the whole ordered list — the same sixteen sequential
 * `DISTINCT ON` scans plus URL rendering over ~52,000 rows, measured at 51 s cold
 * in production, once per page on a genuinely cold crawl (#4552). This table
 * stores that list, so a page read is an `ordinal` range scan measured in
 * milliseconds.
 *
 * `ordinal` is the 0-based emission order the pages slice on, assigned at refresh
 * time in exactly the order the live build emits: groups in
 * `resolveClimbSitemapGroups` order, then `uuid ASC` within a group. Page
 * boundaries therefore never move for a reason unrelated to the catalogue.
 *
 * `path` is RENDERED at refresh time. A deploy that changes climb URL shape
 * serves the old shape for up to six hours unless someone runs the manual
 * refresh — docs/sitemap.md flags this.
 *
 * Refreshed wholesale — `DELETE` then re-insert inside the same transaction that
 * writes the summary row, so the count the index advertises and the rows the
 * pages serve share one epoch. Like the summary, this is a CACHE, not a source
 * of truth: truncating it costs nothing permanent, the page route falls back to
 * the live build and the next refresh repopulates it.
 */
export const sitemapClimbUrls = pgTable('sitemap_climb_urls', {
  /** 0-based emission order; pages read `ordinal >= start AND ordinal < start + perPage`. */
  ordinal: integer('ordinal').primaryKey(),
  /** Root-relative rendered path, e.g. `/kilter/original/…/view/…`. */
  path: text('path').notNull(),
  /** The row's `<lastmod>`; `max()` over a page's range is the page's `<lastmod>`. */
  lastModified: timestamp('last_modified'),
  /** Which `(board_type, layout_id)` group emitted the row — for operators, not the read path. */
  boardType: text('board_type').notNull(),
  layoutId: integer('layout_id').notNull(),
});

export type SitemapClimbUrl = typeof sitemapClimbUrls.$inferSelect;
export type NewSitemapClimbUrl = typeof sitemapClimbUrls.$inferInsert;
