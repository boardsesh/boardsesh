import { pgTable, pgEnum, bigserial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';

/**
 * Which upstream id column a deleted playlist carried: `kilter` for
 * `playlists.kilter_id` (Kilter Grips circuits), `aurora` for
 * `playlists.aurora_id` (Aurora circuits: Tension and the other Aurora boards,
 * pre-split Kilter, and the JSON import's synthetic `json-import-…` ids).
 *
 * An enum rather than free text because the circuit writers look rows up by
 * it: a caller inserting `'Kilter'` or `'kilter_id'` would record a deletion no
 * writer ever reads, and the playlist would come back exactly as in #7240.
 */
export const upstreamPlaylistSourceEnum = pgEnum('upstream_playlist_source', ['kilter', 'aurora']);

export const UPSTREAM_PLAYLIST_SOURCES = upstreamPlaylistSourceEnum.enumValues;

export type UpstreamPlaylistSource = (typeof UPSTREAM_PLAYLIST_SOURCES)[number];

/**
 * Upstream circuits a climber deleted in Boardsesh, so the circuit sync stops
 * importing them again (#7240).
 *
 * ## Why this table exists
 *
 * `deletePlaylist` hard-deletes the playlist row. The Kilter PowerSync stream
 * re-sends every circuit on every routine cycle (every 5 minutes), and
 * `applyCircuits` inserts a fresh playlist whenever no row carries that
 * `kilter_id` — so a deleted Kilter playlist came back within minutes, with a
 * new uuid. Aurora circuits come back the same way the next time the circuit
 * changes upstream, or on any full re-sync. The circuit itself stays on Kilter
 * or Aurora; Boardsesh only stops mirroring it.
 *
 * ## The rule
 *
 * A row here means: do not create, adopt or update a playlist for this
 * upstream id for this user. Every circuit writer (kilter-sync
 * `applyCircuits`, aurora-sync `upsertTableData`) reads it, under the per-user
 * lock in `queries/sync/deleted-upstream-playlists.ts`, before it writes a
 * playlist.
 *
 * A row is removed only by a deliberate account-level action:
 *
 * - unlinking the board account (`deleteAuroraCredential`) clears every row
 *   for that user and board, so a later re-link starts fresh;
 * - deleting the Boardsesh account cascades.
 *
 * A circuit edited upstream stays skipped. The JSON import never reads this
 * table: importing a file is an explicit request for what is in it, and it
 * keys its playlists on its own `json-import-…` ids anyway.
 *
 * Scoped per user, not globally per upstream id: one Kilter account can be
 * linked to two Boardsesh accounts (#3526), and one climber deleting their
 * copy says nothing about the other's.
 *
 * See docs/kilter-sync.md and docs/aurora-sync.md, "Deleted circuits".
 */
export const userDeletedUpstreamPlaylists = pgTable(
  'user_deleted_upstream_playlists',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The deleted playlist's board. Unlinking that board's account clears its rows. */
    boardType: text('board_type').notNull(),
    upstreamSource: upstreamPlaylistSourceEnum('upstream_source').notNull(),
    /** The circuit uuid: the deleted playlist's `kilter_id` or `aurora_id`. */
    upstreamId: text('upstream_id').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // The writers' lookup (user, source, id IN …) and the conflict target for
    // a repeat delete. Its user_id prefix also serves the unlink delete by
    // (user_id, board_type): a user has a handful of rows, not thousands.
    userSourceIdUnique: uniqueIndex('user_deleted_upstream_playlists_unique').on(
      table.userId,
      table.upstreamSource,
      table.upstreamId,
    ),
  }),
);

export type UserDeletedUpstreamPlaylist = typeof userDeletedUpstreamPlaylists.$inferSelect;
export type NewUserDeletedUpstreamPlaylist = typeof userDeletedUpstreamPlaylists.$inferInsert;
