import { pgTable, bigserial, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';

// User favorites for saved/hearted climbs
export const userFavorites = pgTable(
  'user_favorites',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    boardName: text('board_name').notNull(), // 'kilter', 'tension'
    climbUuid: text('climb_uuid').notNull(),
    angle: integer('angle').notNull(), // The angle at which the climb was favorited
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    // Ensure unique favorite per user per climb per angle
    uniqueFavorite: uniqueIndex('unique_user_favorite').on(table.userId, table.boardName, table.climbUuid, table.angle),
    // Index for efficient lookup by user
    userFavoritesIdx: index('user_favorites_user_idx').on(table.userId),
    // Index for checking if a climb is favorited
    climbFavoriteIdx: index('user_favorites_climb_idx').on(table.boardName, table.climbUuid, table.angle),
    syncCursorIdx: index('user_favorites_sync_cursor_idx').on(table.userId, table.updatedAt, table.id),
  }),
);
