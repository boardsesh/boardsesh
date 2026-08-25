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
    hasLeds: boolean('has_leds').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    serialNumber: text('serial_number'),
    timerName: text('timer_name'),
    gymId: bigint('gym_id', { mode: 'number' }).references(() => gyms.id, { onDelete: 'set null' }),
    // Authoritative board-presence sequence reservation. Redis supplies a fast
    // candidate, but every allocation atomically advances this durable counter.
    // Merge jobs lock these rows and raise the survivor past moved event seqs,
    // so an expired/stale Redis key can never reuse a durable sequence.
    presenceSeq: bigint('presence_seq', { mode: 'number' }).default(0).notNull(),
    deletedAt: timestamp('deleted_at'),
    // Human-curation marker. Non-null means someone with edit access changed this
    // row (edited, claimed, or soft-deleted it), so the location sync must never
    // overwrite its metadata again — the sync engine skips its ON CONFLICT SET
    // when this is set. Sync still keeps the board→gym link current.
    syncFrozenAt: timestamp('sync_frozen_at'),
    // Merge tombstone: when the serial-board dedupe consolidates duplicate
    // rows for the same physical wall, losers are soft-deleted with this set
    // to the canonical board's uuid. Lookups (boardBySlug/boardByUuid, serial
    // pointers) follow it so stale links and bindings land on the survivor.
    // NULL for ordinary soft-deletes — those must NOT redirect.
    // Deliberately NO FK to user_boards.uuid: boards are never hard-deleted
    // (nothing can orphan the pointer through normal operation), the only
    // writer is the dedupe script (which reads the survivor from a locked
    // row), and readers tolerate + log a dangling pointer. A self-referential
    // FK would only add write overhead for a failure mode we already surface.
    mergedIntoBoardUuid: text('merged_into_board_uuid'),
  },
  (table) => ({
    // Gym lookup
    gymIdx: index('user_boards_gym_idx').on(table.gymId),
    // Owner+config lookup for createBoard's duplicate check. Deliberately NOT
    // unique: a config tuple does not identify a physical board. The same
    // layout/size/set combination legitimately exists at two different gyms
    // (see #4166), so uniqueness here made adding the second one impossible.
    // createBoard enforces the real rule instead — same config AND same place,
    // overridable by an explicit user confirmation (`allowDuplicateConfig`).
    ownerConfigIdx: index('user_boards_owner_config_idx')
      .on(table.ownerId, table.boardType, table.layoutId, table.sizeId, table.setIds)
      .where(sql`${table.deletedAt} IS NULL`),
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
    // same serial to two of their own boards OF THE SAME TYPE.
    // `resolveBoardForSerial` returns the candidates and the user picks; the
    // per-owner unique partial index still makes a same-owner bind race
    // fail-safe (the loser re-reads).
    //
    // `boardType` is part of the key because Aurora runs a SEPARATE serial
    // sequence per board app: a Kilter `#12345` and a Tension `#12345` are two
    // different physical controllers, and one owner can legitimately register
    // both. Keyed on the serial alone, the second one was rejected as a
    // duplicate (surfacing as BOARD_SERIAL_EXISTS in the board create/edit
    // form). The BLE advertisement carries the type — `Tension Board#12345@3` —
    // so the pair is always distinguishable.
    //
    // Excludes the system user (seeded public catalog boards): the location
    // sync mirrors the upstream catalog verbatim, so the system owner can
    // legitimately hold the "same serial shipped to two gyms" rows described
    // above. Mirrors the uniqueOwnerConfigIdx exclusion.
    // Partial so serial-less/blank and soft-deleted rows don't collide.
    uniqueOwnerSerialIdx: uniqueIndex('user_boards_unique_owner_serial')
      .on(table.ownerId, table.boardType, table.serialNumber)
      .where(
        sql`${table.serialNumber} IS NOT NULL AND ${table.serialNumber} <> '' AND ${table.deletedAt} IS NULL AND ${table.ownerId} != '00000000-0000-0000-0000-000000000000'`,
      ),
    // Serial lookups now return many rows; keep them indexed.
    serialLookupIdx: index('user_boards_serial_idx')
      .on(table.serialNumber)
      .where(sql`${table.serialNumber} IS NOT NULL AND ${table.serialNumber} <> '' AND ${table.deletedAt} IS NULL`),
    // boardBySlug's merge-tombstone fallback looks up soft-deleted losers by
    // slug — those rows are excluded from the active-only unique slug index,
    // so give the fallback its own small partial index.
    mergedSlugIdx: index('user_boards_merged_slug_idx')
      .on(table.slug)
      .where(sql`${table.mergedIntoBoardUuid} IS NOT NULL`),
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
