import { pgTable, bigserial, bigint, integer, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';
import { userBoards } from './boards';

/**
 * Auto-recorded board configurations seen on BLE connect.
 *
 * Captures the (board_name, layout_id, size_id, set_ids) the user was on when
 * their device connected to a controller with a given serial number. Acts as a
 * fallback for serial→board lookups when the user has not deliberately saved a
 * `userBoards` row for the same controller. Angle is intentionally excluded —
 * it's session-state, not part of the board's identity. `boardUuid` links to a
 * deliberately-saved board when the connect happened from a /b/{slug}/... route.
 */
export const userBoardSerials = pgTable(
  'user_board_serials',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    serialNumber: text('serial_number').notNull(),
    boardName: text('board_name').notNull(),
    layoutId: bigint('layout_id', { mode: 'number' }).notNull(),
    sizeId: bigint('size_id', { mode: 'number' }).notNull(),
    setIds: text('set_ids').notNull(),
    // The API/protocol level advertised after the `@` in the BLE device name
    // (`{DisplayName}#{SerialNumber}@{APILevel}`, e.g. `Kilter Board#751737@3`).
    // Nullable: rows recorded before this column existed never observed it, and
    // the parser's default of 2 is a guess we don't want to backfill as fact.
    apiLevel: integer('api_level'),
    // ON DELETE SET NULL: when the linked saved board is removed (or soft-
    // deleted, since the resolver also filters by deletedAt), the link clears
    // but `boardName/layoutId/sizeId/setIds` remain pointing at the old config
    // until the user reconnects. The next BLE connect will refresh the row, so
    // the staleness window is bounded by the user's connection cadence.
    boardUuid: text('board_uuid').references(() => userBoards.uuid, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    // No DB-level ON UPDATE trigger — `defaultNow()` only fires on insert.
    // Writers (the `recordBoardSerial` GraphQL mutation's upsert) must set this
    // explicitly; raw SQL paths will silently leave it stale.
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    uniqueUserSerial: uniqueIndex('user_board_serials_unique_user_serial').on(table.userId, table.serialNumber),
    serialIdx: index('user_board_serials_serial_idx').on(table.serialNumber),
    boardUuidIdx: index('user_board_serials_board_uuid_idx').on(table.boardUuid),
  }),
);

export type UserBoardSerial = typeof userBoardSerials.$inferSelect;
export type NewUserBoardSerial = typeof userBoardSerials.$inferInsert;
