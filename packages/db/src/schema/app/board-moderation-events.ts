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
 * - `setup_changed_by_climber`: a climber's suggested setup on a "Set up wrong"
 *   report changed the board's layout, size, sets or angle, straight away,
 *   because nobody runs its gym (docs/product/directory-reports.md, "Suggested
 *   setup"). By `climber`, or `board_owner` when the creator suggested it.
 *   `details` holds `before`, `after`, `reportUuid` and the sync freeze on
 *   either side (`syncFrozenAtBefore`, `syncFrozenAtSet`).
 * - `setup_change_undone`: the creator, the gym's staff or an admin put a
 *   climber's setup change back. `details` holds `before` (the climber's setup),
 *   `after` (the restored one) and `undoesEventId`.
 */
export const boardModerationActionEnum = pgEnum('board_moderation_action', [
  'removed_from_gym',
  'deleted',
  'edited_by_staff',
  'relinked',
  'setup_changed_by_climber',
  'setup_change_undone',
]);

/**
 * The authority the actor used. `board_owner` marks the creator acting on their
 * own board (a gym editor taking their own wall off the gym, say); `climber`
 * marks any signed-in climber whose suggested setup changed a board at a gym
 * nobody runs, with no other authority over it; every other value is staff.
 * Snapshotted, so a later role change or account deletion does not rewrite who
 * did it in what capacity.
 */
export const boardModerationActorRoleEnum = pgEnum('board_moderation_actor_role', [
  'board_owner',
  'gym_owner',
  'gym_admin',
  'gym_editor',
  'community_leader',
  'community_admin',
  'global_admin',
  'climber',
]);

/**
 * A board's setup within its board type, as a setup change records it and a
 * report's suggestion stores it. `setIds` is in canonical order
 * (`normaliseSetIds`). `angle` is null when the angle is not part of the setup
 * (a board that tilts).
 */
export type BoardSetupSnapshot = {
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number | null;
};

/**
 * Structured context for an event: which fields an edit changed, which mutation
 * wrote it, and for the two setup-change actions the setups on either side.
 */
export type BoardModerationEventDetails = {
  adminRepair?: {
    previousHideLocation: boolean;
    hideLocation: boolean;
    previousLocationAudience: string | null;
    locationAudience: string | null;
    reason: string;
  };
  merge?: {
    canonicalBoardUuid: string;
    duplicateBoardUuids: string[];
    allowOwnershipChange?: boolean;
    before: Array<{
      uuid: string;
      ownerId: string;
      name: string;
      layoutId: number;
      sizeId: number;
      setIds: string;
      hideLocation: boolean;
      isUnlisted: boolean;
    }>;
    counts: Record<string, number>;
  };
  fields?: string[];
  mutation?: string;
  /** Setup changes: the setup before this event. */
  before?: BoardSetupSnapshot;
  /** Setup changes: the setup this event left the board with. */
  after?: BoardSetupSnapshot;
  /** `setup_changed_by_climber`: the "Set up wrong" report that carried the suggestion. */
  reportUuid?: string;
  /** `setup_change_undone`: the `setup_changed_by_climber` event it undid. */
  undoesEventId?: number;
  /**
   * `setup_changed_by_climber`: the board's `sync_frozen_at` before the change,
   * as an ISO string, or null when it wasn't frozen. An undo puts it back.
   */
  syncFrozenAtBefore?: string | null;
  /**
   * `setup_changed_by_climber`: the `sync_frozen_at` the change set, as an ISO
   * string. An undo puts `syncFrozenAtBefore` back only while the board still
   * has this one; a freeze written since (an edit) stays.
   */
  syncFrozenAtSet?: string;
};

/**
 * Append-only record of staff and admin actions on boards
 * (docs/product/gym-board-governance.md, decision 1), of the creator's own
 * gym link changes (`board_owner`), and of climbers' setup changes and their
 * undos (docs/product/directory-reports.md, "Suggested setup").
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
 * - A climber's suggested setup goes to review instead of applying while the
 *   board has a `setup_changed_by_climber` row from the last 24 hours or a
 *   `setup_change_undone` row from the last 90 days, or the climber has 3
 *   `setup_changed_by_climber` rows from the last 24 hours
 *   (`@boardsesh/directory-moderation`'s `setupSuggestionDecision`).
 * - An undo is a compare-and-set: it restores `before` only while the board
 *   still has the change's `after`.
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
    // Serves a climber's setup changes in the last 24 hours (the per-climber
    // limit on suggested setups). Not partial on the action: Postgres refuses
    // an enum value in the transaction that added it, and the migration adds it.
    actorCreatedIdx: index('board_moderation_events_actor_created_idx').on(table.actorUserId, table.createdAt),
  }),
);

export type BoardModerationEvent = typeof boardModerationEvents.$inferSelect;
export type NewBoardModerationEvent = typeof boardModerationEvents.$inferInsert;
export type BoardModerationAction = (typeof boardModerationActionEnum.enumValues)[number];
export type BoardModerationActorRole = (typeof boardModerationActorRoleEnum.enumValues)[number];
