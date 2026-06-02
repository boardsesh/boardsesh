import { pgTable, bigserial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';

export const userFavorites = pgTable(
  'user_favorites',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    climbUuid: text('climb_uuid').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    uniqueFavorite: uniqueIndex('unique_user_favorite').on(table.userId, table.climbUuid),
  }),
);
