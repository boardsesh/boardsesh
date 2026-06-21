import {
  pgTable,
  bigserial,
  bigint,
  text,
  boolean,
  timestamp,
  doublePrecision,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../auth/users';
import { gyms } from './gyms';

/**
 * User boards table — represents a named physical board installation
 * (board type + layout + size + hold sets) with metadata.
 */
export const userBoards = pgTable(
  'user_boards',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    uuid: text('uuid').notNull().unique(),
    slug: text('slug').notNull(),
    ownerId: text('owner_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    boardType: text('board_type').notNull(),
    layoutId: bigint('layout_id', { mode: 'number' }).notNull(),
    sizeId: bigint('size_id', { mode: 'number' }).notNull(),
    setIds: text('set_ids').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    locationName: text('location_name'),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    isPublic: boolean('is_public').default(true).notNull(),
    isUnlisted: boolean('is_unlisted').default(false).notNull(),
    hideLocation: boolean('hide_location').default(false).notNull(),
    isOwned: boolean('is_owned').default(true).notNull(),
    angle: bigint('angle', { mode: 'number' }).notNull().default(40),
    isAngleAdjustable: boolean('is_angle_adjustable').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    serialNumber: text('serial_number'),
    gymId: bigint('gym_id', { mode: 'number' }).references(() => gyms.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => ({
    // Gym lookup
    gymIdx: index('user_boards_gym_idx').on(table.gymId),
    // Unique partial: one active board per owner per config.
    // Excludes the system user (seeded public boards) so multiple gyms
    // can have the same board configuration.
    uniqueOwnerConfigIdx: uniqueIndex('user_boards_unique_owner_config')
      .on(table.ownerId, table.boardType, table.layoutId, table.sizeId, table.setIds)
      .where(sql`${table.deletedAt} IS NULL AND ${table.ownerId} != '00000000-0000-0000-0000-000000000000'`),
    // Owner's owned boards
    ownerOwnedIdx: index('user_boards_owner_owned_idx')
      .on(table.ownerId, table.isOwned)
      .where(sql`${table.deletedAt} IS NULL`),
    // Public boards for discovery
    publicBoardsIdx: index('user_boards_public_idx')
      .on(table.boardType, table.layoutId, table.isPublic)
      .where(sql`${table.deletedAt} IS NULL`),
    // Unique slug for URL routing
    uniqueSlugIdx: uniqueIndex('user_boards_unique_slug')
      .on(table.slug)
      .where(sql`${table.deletedAt} IS NULL`),
    // UUID lookup
    uuidIdx: index('user_boards_uuid_idx').on(table.uuid),
    // Board presence: the LED supplier can't be trusted to keep serials
    // unique, so a serial may map to MANY active boards (e.g. the same serial
    // shipped to two gyms). We only forbid a single owner from binding the
    // same serial to two of their own boards. `resolveBoardForSerial` returns
    // the candidates and the user picks; the per-owner unique partial index
    // still makes a same-owner bind race fail-safe (the loser re-reads).
    // Excludes the system user (seeded public catalog boards): the location
    // sync mirrors the upstream catalog verbatim, so the system owner can
    // legitimately hold the "same serial shipped to two gyms" rows described
    // above. Mirrors the uniqueOwnerConfigIdx exclusion.
    // Partial so serial-less/blank and soft-deleted rows don't collide.
    uniqueOwnerSerialIdx: uniqueIndex('user_boards_unique_owner_serial')
      .on(table.ownerId, table.serialNumber)
      .where(
        sql`${table.serialNumber} IS NOT NULL AND ${table.serialNumber} <> '' AND ${table.deletedAt} IS NULL AND ${table.ownerId} != '00000000-0000-0000-0000-000000000000'`,
      ),
    // Serial lookups now return many rows; keep them indexed.
    serialLookupIdx: index('user_boards_serial_idx')
      .on(table.serialNumber)
      .where(sql`${table.serialNumber} IS NOT NULL AND ${table.serialNumber} <> '' AND ${table.deletedAt} IS NULL`),
  }),
);

/**
 * Board follows table — tracks which users follow which boards.
 */
export const boardFollows = pgTable(
  'board_follows',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    boardUuid: text('board_uuid')
      .references(() => userBoards.uuid, { onDelete: 'cascade' })
      .notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    uniqueUserBoard: uniqueIndex('board_follows_unique_user_board').on(table.userId, table.boardUuid),
    userIdx: index('board_follows_user_idx').on(table.userId),
    boardUuidIdx: index('board_follows_board_uuid_idx').on(table.boardUuid),
  }),
);

// Type exports
export type UserBoard = typeof userBoards.$inferSelect;
export type NewUserBoard = typeof userBoards.$inferInsert;
export type BoardFollow = typeof boardFollows.$inferSelect;
export type NewBoardFollow = typeof boardFollows.$inferInsert;
