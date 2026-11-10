import { bigint, bigserial, customType, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Postgres `xid8`: a 64-bit transaction id that never wraps. Read and written
 * as a decimal string because it can exceed `Number.MAX_SAFE_INTEGER`.
 */
export const xid8 = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'xid8';
  },
});

/**
 * Change log behind the public logbook feed (docs/integration-platform.md,
 * "Incremental sync"). One narrow row per public tick change, written only by
 * triggers in the same transaction as the tick write. A row
 * says "this tick changed"; the payload is always read from the tick at read
 * time, so this table holds no tick data.
 *
 * `txid` is the writing transaction's id and is what makes the feed safe to
 * resume: only rows below the transaction horizon are served, so a transaction
 * still in flight can never be skipped. See `services/logbook-feed.ts`.
 *
 * No foreign keys, on purpose: deleting an account cascades into
 * `boardsesh_ticks`, whose delete trigger writes rows for that same user, and
 * those inserts must not depend on cascade ordering. A row outliving its user
 * or tick is what `tick.deleted` is for.
 */
export const logbookChanges = pgTable(
  'logbook_changes',
  {
    seq: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    txid: xid8('txid')
      .notNull()
      .default(sql`pg_current_xact_id()`),
    userId: text('user_id').notNull(),
    tickUuid: text('tick_uuid').notNull(),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => ({
    // The feed read: a range scan on (user, position).
    userPositionIdx: index('logbook_changes_user_position_idx').on(table.userId, table.txid, table.seq),
    // For the 90-day retention job. BRIN because the table is append-only and
    // created_at follows insertion order, so it stays tiny.
    createdAtBrinIdx: index('logbook_changes_created_at_brin_idx').using('brin', table.createdAt),
  }),
);

export const LOGBOOK_CHANGE_WATERMARK_SINGLETON_ID = 1;

/**
 * The feed's persistent state, one row (`id = 1`).
 *
 * `feedGeneration` is a random id written into every cursor. Rotating it (see
 * the "moving the database" runbook in docs/integration-platform.md) makes
 * every outstanding cursor answer `410`, even when transaction ids overlap
 * after a restore. `prunedThrough*` is the retention watermark: a cursor below
 * it answers `410`, a cursor at or above it is valid however old it is.
 *
 * Seeded by the migration that adds the triggers; L5's prune job advances the
 * watermark.
 */
export const logbookChangeWatermark = pgTable('logbook_change_watermark', {
  id: integer('id').primaryKey().notNull().default(LOGBOOK_CHANGE_WATERMARK_SINGLETON_ID),
  feedGeneration: uuid('feed_generation').notNull().defaultRandom(),
  prunedThroughTxid: xid8('pruned_through_txid')
    .notNull()
    .default(sql`'0'::xid8`),
  prunedThroughSeq: bigint('pruned_through_seq', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow().notNull(),
});

export type LogbookChange = typeof logbookChanges.$inferSelect;
export type LogbookChangeWatermark = typeof logbookChangeWatermark.$inferSelect;
