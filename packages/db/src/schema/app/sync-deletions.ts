import { pgTable, bigserial, text, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Sync deletions — append-only log of hard deletes for the mobile offline sync
 * pull (Phase 2). Existing queries stay untouched: instead of soft-deleting rows
 * across the schema, each syncable table gets a delete trigger in the
 * offline-sync migration that inserts one row here. The mobile client polls
 * `syncDeletions` and removes the matching local SQLite rows.
 *
 * `record_id` holds the row's NATURAL key (not the server bigserial id), encoded
 * exactly as the mobile local PK so the client can split it back into columns —
 * see docs/sync-table-manifest.md "Del:" lines per table. Examples:
 *   boardsesh_ticks  -> OLD.uuid
 *   user_favorites   -> board_name:climb_uuid:angle
 *   board_climb_stats-> board_type:climb_uuid:angle
 *
 * `user_id` scopes user-owned deletions for privacy; it is NULL for reference
 * data (board_climbs / board_climb_stats), which every client may consume.
 *
 * Retention: prune with `DELETE FROM sync_deletions WHERE deleted_at < NOW() - INTERVAL '90 days'`.
 */
export const syncDeletions = pgTable(
  'sync_deletions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey().notNull(),
    tableName: text('table_name').notNull(),
    recordId: text('record_id').notNull(),
    // Nullable: NULL means reference-data deletion visible to all clients.
    userId: text('user_id'),
    deletedAt: timestamp('deleted_at').defaultNow().notNull(),
  },
  (table) => ({
    // Composite-cursor scan for syncDeletions: filter by user scope, then walk
    // (deleted_at, id) row-value pairs. Leading user_id keeps each user's pull
    // index-only.
    userSinceIdx: index('sync_deletions_user_since_idx').on(table.userId, table.deletedAt, table.id),
    // The resolver's `user_id = $x OR user_id IS NULL` can't ride the composite
    // index's leading user_id column as ONE range scan; this partial index gives
    // the reference-data (NULL-scoped) branch its own narrow scan.
    nullScopeIdx: index('sync_deletions_null_scope_idx')
      .on(table.deletedAt, table.id)
      .where(sql`${table.userId} IS NULL`),
    // Prune path (sync-deletions-prune.ts): DELETE WHERE deleted_at < cutoff
    // can't use the user-scoped composite or the NULL-scope partial index.
    pruneIdx: index('sync_deletions_deleted_at_idx').on(table.deletedAt),
  }),
);

export type SyncDeletion = typeof syncDeletions.$inferSelect;
export type NewSyncDeletion = typeof syncDeletions.$inferInsert;
