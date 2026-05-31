import { pgTable, bigserial, bigint, text, integer, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';

/**
 * Playlists - User-created collections of climbs
 * Scoped to boardType, optionally to layoutId (can contain climbs from different sizes/layouts)
 * Can be synced from Aurora circuits via user sync
 */
export const playlists = pgTable(
  'playlists',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    uuid: text('uuid').notNull().unique(),
    boardType: text('board_type').notNull(), // 'kilter' | 'tension'
    layoutId: integer('layout_id'), // Nullable for Aurora-synced circuits

    // Metadata
    name: text('name').notNull(),
    description: text('description'),
    isPublic: boolean('is_public').default(false).notNull(),
    color: text('color'), // Hex color (e.g., '#06B6D4')
    icon: text('icon'), // MUI icon name (e.g., 'StarOutlined')

    // Aurora sync tracking (for circuits synced from Aurora)
    auroraType: text('aurora_type'), // 'circuits' when synced from Aurora
    auroraId: text('aurora_id'), // The circuit UUID from Aurora
    auroraSyncedAt: timestamp('aurora_synced_at'), // Last sync timestamp

    // Kilter sync tracking (for circuits synced from / pushed to Kilter)
    kilterType: text('kilter_type'), // 'circuits' when synced from Kilter
    kilterId: text('kilter_id'), // The circuit UUID from Kilter
    kilterSyncedAt: timestamp('kilter_synced_at'),

    // Timestamps
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    lastAccessedAt: timestamp('last_accessed_at'),
  },
  (table) => ({
    // Index for efficient lookup by board + layout
    boardLayoutIdx: index('playlists_board_layout_idx').on(table.boardType, table.layoutId),
    // Index for UUID lookups
    uuidIdx: index('playlists_uuid_idx').on(table.uuid),
    // Index for ordering by updatedAt (used in userPlaylists query)
    updatedAtIdx: index('playlists_updated_at_idx').on(table.updatedAt),
    // Composite-cursor index for syncPlaylists (offline sync pull). The resolver
    // drives off playlist_ownership (po.user_id = $userId, served by
    // unique_playlist_ownership) and joins to playlists, then walks
    // (playlists.updated_at, playlists.id) row-value pairs. This (updated_at, id)
    // index lets the planner satisfy the cursor comparison + ORDER BY without a
    // separate sort over the owned-playlist set.
    syncCursorIdx: index('playlists_sync_cursor_idx').on(table.updatedAt, table.id),
    // Index for ordering by lastAccessedAt (used in library view)
    lastAccessedAtIdx: index('playlists_last_accessed_at_idx').on(table.lastAccessedAt),
    // Index for Aurora sync conflict resolution
    auroraIdIdx: uniqueIndex('playlists_aurora_id_idx').on(table.auroraId),
    // Index for Kilter sync conflict resolution
    kilterIdIdx: uniqueIndex('playlists_kilter_id_idx').on(table.kilterId),
  }),
);

/**
 * Playlist Climbs - Junction table for climbs in playlists
 */
export const playlistClimbs = pgTable(
  'playlist_climbs',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    playlistId: bigint('playlist_id', { mode: 'bigint' })
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    climbUuid: text('climb_uuid').notNull(), // Aurora climb UUID
    angle: integer('angle'), // Nullable for Aurora-synced circuits

    // Position for manual ordering within playlist
    position: integer('position').notNull().default(0),

    // Timestamps
    addedAt: timestamp('added_at').defaultNow().notNull(),
    // Phase 2 sync: maintained by a BEFORE UPDATE trigger (migration 0109).
    // Cursor component for syncPlaylistClimbs (backfilled from added_at).
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    // Ensure unique climb per playlist
    uniquePlaylistClimb: uniqueIndex('unique_playlist_climb').on(table.playlistId, table.climbUuid),
    // Index for efficient lookup of playlists containing a climb
    climbIdx: index('playlist_climbs_climb_idx').on(table.climbUuid),
    // Index for ordered retrieval
    playlistPositionIdx: index('playlist_climbs_position_idx').on(table.playlistId, table.position),
    // Composite-cursor index for syncPlaylistClimbs (offline sync pull). The
    // resolver joins playlist_climbs → playlists → playlist_ownership (owner =
    // $userId) and orders (pc.updated_at, pc.id). This (updated_at, id) index
    // serves the cursor comparison + ORDER BY; the ownership scope is satisfied by
    // the playlist_ownership / playlists join indexes.
    syncCursorIdx: index('playlist_climbs_sync_cursor_idx').on(table.updatedAt, table.id),
  }),
);

/**
 * Playlist Ownership - Separate ownership for future collaboration
 */
export const playlistOwnership = pgTable(
  'playlist_ownership',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    playlistId: bigint('playlist_id', { mode: 'bigint' })
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Role for future collaboration features
    role: text('role').notNull().default('owner'), // 'owner' | 'editor' | 'viewer'

    // Timestamps
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    // Ensure unique user-playlist ownership
    uniqueOwnership: uniqueIndex('unique_playlist_ownership').on(table.playlistId, table.userId),
    // Index for efficient user playlist queries
    userIdx: index('playlist_ownership_user_idx').on(table.userId),
  }),
);

/**
 * User Playlist Pins - Per-user pin relationships to playlists.
 * Datamodel mirrors user_follows: a row is the user-saves-thing edge.
 * Used to populate the small "Pinned" grid on /playlists. The grid falls
 * back to a per-device IndexedDB recents list when this table is empty for
 * a given user.
 */
export const userPlaylistPins = pgTable(
  'user_playlist_pins',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    playlistId: bigint('playlist_id', { mode: 'bigint' })
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    // Phase 2 sync: maintained by a BEFORE UPDATE trigger (migration 0109).
    // Not currently synced — added for consistency with the other user tables.
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    uniquePin: uniqueIndex('unique_user_playlist_pin').on(table.userId, table.playlistId),
    userIdx: index('user_playlist_pins_user_idx').on(table.userId),
    playlistIdx: index('user_playlist_pins_playlist_idx').on(table.playlistId),
  }),
);

// Type exports for use in application code
export type Playlist = typeof playlists.$inferSelect;
export type NewPlaylist = typeof playlists.$inferInsert;
export type PlaylistClimb = typeof playlistClimbs.$inferSelect;
export type NewPlaylistClimb = typeof playlistClimbs.$inferInsert;
export type PlaylistOwnership = typeof playlistOwnership.$inferSelect;
export type NewPlaylistOwnership = typeof playlistOwnership.$inferInsert;
export type UserPlaylistPin = typeof userPlaylistPins.$inferSelect;
export type NewUserPlaylistPin = typeof userPlaylistPins.$inferInsert;
