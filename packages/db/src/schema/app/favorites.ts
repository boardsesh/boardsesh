import { pgTable, bigserial, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';

// User favorites for saved/hearted climbs.
//
// Keyed by (user_id, climb_uuid): a climb is the same climb whichever board
// config or angle you were looking at when you hearted it.
//
// `board_name` and `angle` are VESTIGIAL — nothing reads them any more. They
// stay for one release because `syncFavorites` still emits them to offline
// clients whose local SQLite table declares them NOT NULL; a pre-OTA device
// would otherwise fail its whole pull cycle. Defaults let new rows omit them.
// Dropped in the follow-up release once the fleet has rolled.
export const userFavorites = pgTable(
  'user_favorites',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    boardName: text('board_name').notNull().default(''), // vestigial
    climbUuid: text('climb_uuid').notNull(),
    angle: integer('angle').notNull().default(0), // vestigial
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    // One favorite per user per climb, board- and angle-independent.
    uniqueFavorite: uniqueIndex('unique_user_favorite').on(table.userId, table.climbUuid),
    // Index for efficient lookup by user
    userFavoritesIdx: index('user_favorites_user_idx').on(table.userId),
    // Index for checking if a climb is favorited
    climbFavoriteIdx: index('user_favorites_climb_idx').on(table.climbUuid),
    syncCursorIdx: index('user_favorites_sync_cursor_idx').on(table.userId, table.updatedAt, table.id),
  }),
);
