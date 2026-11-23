import { pgTable, bigserial, bigint, text, jsonb, timestamp, index, pgEnum } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';
import { gyms } from './gyms';
import { userBoards } from './boards';

/**
 * What happened to a board at someone else's hand, plus the creator's own gym
 * link changes.
 *
 * - `removed_from_gym`: the board was taken off a gym's listing. The board stays
 *   with its creator. By `board_owner`, the creator unlinked it themselves.
 * - `deleted`: the board was soft-deleted by someone other than its creator.
 * - `edited_by_staff`: someone other than the creator changed the board.
 * - `relinked`: gym staff put a board they had removed back on their listing,
 *   which lifts the hold a staff removal places on the creator's own re-link.
 *   By `board_owner`, the creator linked it to a gym themselves.
 */
export const boardModerationActionEnum = pgEnum('board_moderation_action', [
  'removed_from_gym',
  'deleted',
  'edited_by_staff',
  'relinked',
]);

/**
 * The authority the actor used. `board_owner` marks the creator acting on their
 * own board (a gym editor taking their own wall off the gym, say); every other
 * value is staff. Snapshotted, so a later role change or account deletion does
 * not rewrite who did it in what capacity.
 */
export const boardModerationActorRoleEnum = pgEnum('board_moderation_actor_role', [
  'board_owner',
  'gym_owner',
  'gym_admin',
  'gym_editor',
  'community_leader',
  'community_admin',
  'global_admin',
]);

/** Structured context for an event: which fields an edit changed, which mutation wrote it. */
export type BoardModerationEventDetails = {
  fields?: string[];
  mutation?: string;
};

/**
 * Append-only record of staff and admin actions on boards
 * (docs/product/gym-board-governance.md, decision 1), and of the creator's own
 * gym link changes (`board_owner`).
 *
 * Read by these rules:
 * - A creator may not self-link a board back to a gym whose staff removed it.
 *   The latest `removed_from_gym` / `relinked` row for the (board, gym) pair,
 *   by `id`, decides: a staff removal holds the board off that gym until staff
 *   relink it.
 * - The gym's "boards near your gym" list skips boards held off the same way.
 * - Staff may re-list a board they removed only while its creator has written
 *   no `removed_from_gym` / `relinked` row for it since.
 * - An admin may not clear the sync freeze on a board whose latest such row is a
 *   staff removal.
 *
 * Rows are written in the same transaction as the change they describe and are
 * never updated. Account deletion soft-deletes a user's boards and hands them to
 * SYSTEM, so their events stay; only a hard delete of the board row cascades.
 * A hard-deleted gym or actor leaves the row with a null pointer.
 */
export const boardModerationEvents = pgTable(
  'board_moderation_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: bigint('board_id', { mode: 'number' })
      .notNull()
      .references(() => userBoards.id, { onDelete: 'cascade' }),
    // The gym the action concerns: the listing removed from or relinked to, or
    // the board's gym at the time of an edit or delete. Null for an unlinked board.
    gymId: bigint('gym_id', { mode: 'number' }).references(() => gyms.id, { onDelete: 'set null' }),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorRole: boardModerationActorRoleEnum('actor_role').notNull(),
    action: boardModerationActionEnum('action').notNull(),
    // Free text a person gave for the action. Null when none was asked for.
    reason: text('reason'),
    details: jsonb('details').$type<BoardModerationEventDetails>(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    // Serves "latest event for this board at this gym" (the re-link hold and the
    // stray filter) and a board's history.
    boardGymHistoryIdx: index('board_moderation_events_board_gym_created_idx').on(
      table.boardId,
      table.gymId,
      table.createdAt.desc(),
    ),
  }),
);

export type BoardModerationEvent = typeof boardModerationEvents.$inferSelect;
export type NewBoardModerationEvent = typeof boardModerationEvents.$inferInsert;
export type BoardModerationAction = (typeof boardModerationActionEnum.enumValues)[number];
export type BoardModerationActorRole = (typeof boardModerationActorRoleEnum.enumValues)[number];
