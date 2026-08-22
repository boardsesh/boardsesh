import { integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * The materialised tier-2 climb sitemap: one row per URL `/sitemaps/climbs/N.xml`
 * publishes, plus a ≤20-row summary describing the groups those rows came from.
 *
 * Why a table at all (#4583). `/sitemaps/climbs/N.xml` builds the ENTIRE ordered
 * item list before it can slice page N — sixteen sequential `DISTINCT ON` scans,
 * measured at 27.4 s for a genuinely cold production page fetch on 2026-08-21.
 * Page N therefore costs the whole catalogue, and on a cold crawl fanning across
 * Vercel lambdas the cost really is N full builds. A PK-prefix range scan over
 * this table costs a bounded 10,000 rows instead.
 *
 * #4523 already materialised the SUMMARY into `sitemap_shard_refreshes`, which is
 * what stopped `/sitemap.xml` dropping the shard. That table stays: it is
 * shard-generic (playlists is its next consumer) and it remains the fallback for
 * climbs whenever these two tables cannot be trusted. What is new here is that
 * the summary and the items can finally be read from ONE epoch, so they cannot
 * describe different sets.
 *
 * A CACHE, not a source of truth. Truncating it costs nothing permanent — the
 * read path falls back to the live scan, loudly, and the next refresh
 * repopulates. Nothing else in the product reads either table.
 *
 * Plain tables, deliberately not a `MATERIALIZED VIEW`:
 * `packages/db/scripts/migration-runtime-acl.ts` grants the runtime role
 * `SELECT, INSERT, UPDATE, DELETE` only for `relkind IN ('r','p')`; a matview
 * would get `SELECT` and the refresh job could never write it.
 */

/**
 * One row per submitted climb URL, in the order the shard emits them.
 *
 * **The primary key IS the emit order.** `buildTier2ClimbQuery` ends
 * `.orderBy(asc(chosen.uuid))`, so a PK-prefix range scan
 * `WHERE board_type = $1 AND layout_id = $2 ORDER BY climb_uuid OFFSET x LIMIT y`
 * reproduces the live path's within-group order by construction, under the same
 * column collation, rather than by convention. The refresh job inserts in PK
 * order, so the heap is clustered and the scan is near-sequential.
 *
 * No `url`/`path` column on purpose. The set-slug parser is being changed
 * underneath this (#4576), and a stored path would freeze a shape a parser
 * change silently invalidates — the URL is rebuilt at read time from the group's
 * stored config, through the same `climbRowsToItems` the live path uses.
 */
export const sitemapTier2Climbs = pgTable(
  'sitemap_tier2_climbs',
  {
    boardType: text('board_type').notNull(),
    layoutId: integer('layout_id').notNull(),
    climbUuid: text('climb_uuid').notNull(),
    /** The one angle the shard publishes for this climb — the `DISTINCT ON` winner. */
    angle: integer('angle').notNull(),
    /**
     * The raw `board_climbs.name`, nullable exactly as the source column is.
     * `resolveClimbDisplayName` stays at READ time: it is what the climb page's
     * own `<h1>` and canonical run, and baking its output here would freeze a
     * second copy of that rule where nothing would notice it drifting.
     */
    climbName: text('climb_name'),
    /**
     * `max(board_climb_stats.updated_at, board_climbs.updated_at)` — the same
     * value `fetchTier2ClimbRows` computes per row on the live path.
     *
     * `timestamp` without a time zone, matching both source columns, so drizzle's
     * UTC decoder produces byte-identical ISO strings on the table path and the
     * fallback path. A `timestamptz` here would shift every `<lastmod>` by the
     * session offset relative to the live path.
     */
    lastModified: timestamp('last_modified').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.layoutId, table.climbUuid] }),
  }),
);

/**
 * One row per `(board_type, layout_id)` group the last refresh materialised —
 * around twenty rows, one heap page.
 *
 * It is both the SUMMARY (`item_count`, `last_modified`) and the table's
 * SELF-DESCRIPTION, and the second half is the reason this is not a bare
 * `GROUP BY` over the climbs table:
 *
 *  - `size_id` / `set_ids` are the config the rows were actually selected under,
 *    so the read path builds URLs from that rather than from whatever the live
 *    ranking resolves today. A winner flip becomes something detected, not
 *    something silently mixed.
 *  - `predicate_fingerprint` catches "someone edited the tier-2 predicate and
 *    nobody re-ran the job" — the stored rows would be a different set.
 *  - `refreshed_at` catches "the cron died".
 *
 * Each of those is a detector this issue exists because we did not have.
 */
export const sitemapTier2Groups = pgTable(
  'sitemap_tier2_groups',
  {
    boardType: text('board_type').notNull(),
    layoutId: integer('layout_id').notNull(),
    /** The winning config's size id — what the emitted URL's size segment is built from. */
    sizeId: integer('size_id').notNull(),
    /** The winning config's set ids, ascending — the URL's set segment. */
    setIds: integer('set_ids').array().notNull(),
    /** Rows this group holds in `sitemap_tier2_climbs`. Drives the page arithmetic. */
    itemCount: integer('item_count').notNull(),
    /** Max `last_modified` across this group's rows. Null only when the group is empty. */
    lastModified: timestamp('last_modified'),
    /** `tier2PredicateFingerprint()` at the time the rows were selected. */
    predicateFingerprint: text('predicate_fingerprint').notNull(),
    /** When the refresh that wrote this row committed. */
    refreshedAt: timestamp('refreshed_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.layoutId] }),
  }),
);

export type SitemapTier2Climb = typeof sitemapTier2Climbs.$inferSelect;
export type NewSitemapTier2Climb = typeof sitemapTier2Climbs.$inferInsert;
export type SitemapTier2Group = typeof sitemapTier2Groups.$inferSelect;
export type NewSitemapTier2Group = typeof sitemapTier2Groups.$inferInsert;
