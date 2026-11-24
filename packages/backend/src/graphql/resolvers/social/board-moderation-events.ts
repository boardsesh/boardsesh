import { and, desc, eq, gt, inArray, isNull, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { rolesGrantAdmin, rolesGrantAdminOrLeader, type CommunityRoleScope } from '@boardsesh/community-roles';
import * as dbSchema from '@boardsesh/db/schema';
import type {
  BoardModerationActorRole,
  BoardModerationEvent,
  BoardModerationEventDetails,
  NewBoardModerationEvent,
} from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { getUserCommunityRoles } from './roles';
import { onBoardEdited, onBoardModerationEvent } from './directory-reports/lifecycle';

// ============================================
// Board moderation events
// ============================================
//
// One append-only row per staff action on a board: removed from a gym, deleted,
// edited, relinked (docs/product/gym-board-governance.md, decision 1). The
// creator's own gym link changes are recorded too, as `board_owner`, so a staff
// re-list can tell whether the creator moved the board after it was removed.
// Every writer records its event in the same transaction as the change.
//
// A staff removal also places a HOLD: the board's creator cannot self-link it
// back to that gym until gym staff relink it. "Staff" means any actor role but
// `board_owner`, so a gym editor taking their own wall off the gym places no hold.

/** Anything that can run drizzle queries: `db`, or a transaction's `tx`. */
export type ModerationExecutor = NonNullable<Parameters<typeof getUserCommunityRoles>[1]>;

/** What a creator reads when a self-link back to a gym that removed their board is refused. */
export const BOARD_HELD_OFF_GYM_MESSAGE = "This gym's staff took this board off their listing. Ask them to re-list it.";
export const BOARD_HELD_OFF_GYM_CODE = 'BOARD_REMOVED_BY_GYM';

export function boardHeldOffGymError(): GraphQLError {
  return new GraphQLError(BOARD_HELD_OFF_GYM_MESSAGE, { extensions: { code: BOARD_HELD_OFF_GYM_CODE } });
}

/** Record one event in the caller's transaction, and return its id. */
export async function recordBoardModerationEvent(
  executor: ModerationExecutor,
  event: NewBoardModerationEvent,
): Promise<number> {
  const [recorded] = await executor
    .insert(dbSchema.boardModerationEvents)
    .values(event)
    .returning({ id: dbSchema.boardModerationEvents.id });
  // Reports about the board close with the action, and its creator hears about
  // it (docs/product/directory-reports.md), in this same transaction.
  await onBoardModerationEvent(executor, event);
  return recorded.id;
}

/**
 * Which community role an actor holds over boards of these types, strongest
 * first: a global admin, then an admin scoped to one of the types, then a
 * leader (global or scoped). Null when no role reaches.
 */
export function communityActorRole(
  roles: readonly CommunityRoleScope[],
  boardTypes: readonly string[],
): BoardModerationActorRole | null {
  if (rolesGrantAdmin(roles, null)) return 'global_admin';
  if (boardTypes.some((boardType) => rolesGrantAdmin(roles, boardType))) return 'community_admin';
  if (
    rolesGrantAdminOrLeader(roles, null) ||
    boardTypes.some((boardType) => rolesGrantAdminOrLeader(roles, boardType))
  ) {
    return 'community_leader';
  }
  return null;
}

/**
 * The viewer's management role at a live gym: its owner, or an admin member.
 * Null otherwise. This is the gym authority behind board edits and, on SYSTEM
 * boards, board deletes. Gym editors are deliberately not managers.
 */
export async function viewerGymManagerRole(
  gymId: number,
  userId: string,
  executor: ModerationExecutor = db,
): Promise<'gym_owner' | 'gym_admin' | null> {
  const [ownedGym] = await executor
    .select({ id: dbSchema.gyms.id })
    .from(dbSchema.gyms)
    .where(and(eq(dbSchema.gyms.id, gymId), eq(dbSchema.gyms.ownerId, userId), isNull(dbSchema.gyms.deletedAt)))
    .limit(1);
  if (ownedGym) return 'gym_owner';

  const [adminMembership] = await executor
    .select({ role: dbSchema.gymMembers.role })
    .from(dbSchema.gymMembers)
    .innerJoin(dbSchema.gyms, eq(dbSchema.gyms.id, dbSchema.gymMembers.gymId))
    .where(
      and(
        eq(dbSchema.gymMembers.gymId, gymId),
        eq(dbSchema.gymMembers.userId, userId),
        eq(dbSchema.gymMembers.role, 'admin'),
        isNull(dbSchema.gyms.deletedAt),
      ),
    )
    .limit(1);
  return adminMembership ? 'gym_admin' : null;
}

/**
 * The role a caller who passed `requireGymEditAccess` used: gym owner, gym
 * admin or editor member, or a community role covering one of the gym's board
 * types. Resolve it BEFORE changing the gym's boards, because the covering rule
 * reads the boards linked to the gym.
 */
export async function resolveGymEditActorRole(
  gym: { id: number; ownerId: string },
  userId: string,
  executor: ModerationExecutor = db,
): Promise<BoardModerationActorRole | null> {
  if (gym.ownerId === userId) return 'gym_owner';
  const [membership] = await executor
    .select({ role: dbSchema.gymMembers.role })
    .from(dbSchema.gymMembers)
    .where(and(eq(dbSchema.gymMembers.gymId, gym.id), eq(dbSchema.gymMembers.userId, userId)))
    .limit(1);
  if (membership?.role === 'admin') return 'gym_admin';
  if (membership?.role === 'editor') return 'gym_editor';

  const [roles, boardTypeRows] = await Promise.all([
    getUserCommunityRoles(userId, executor),
    executor
      .selectDistinct({ boardType: dbSchema.userBoards.boardType })
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.gymId, gym.id), isNull(dbSchema.userBoards.deletedAt))),
  ]);
  return communityActorRole(
    roles,
    boardTypeRows.map((row) => row.boardType),
  );
}

/**
 * The role a non-owner who passed `canEditBoard` used. The gym relationship is
 * preferred, because that is what a creator needs to hear: "the gym's staff
 * edited your board". Throws when no role reaches any more, which can only
 * happen when a role was revoked between the edit gate and the write; the edit
 * is then refused with it.
 */
export async function resolveBoardEditActorRole(
  userId: string,
  board: { ownerId: string; gymId: number | null; boardType: string },
  executor: ModerationExecutor = db,
): Promise<BoardModerationActorRole> {
  if (board.ownerId === userId) return 'board_owner';
  if (board.gymId != null) {
    const gymRole = await viewerGymManagerRole(board.gymId, userId, executor);
    if (gymRole) return gymRole;
  }
  const communityRole = communityActorRole(await getUserCommunityRoles(userId, executor), [board.boardType]);
  if (communityRole) return communityRole;
  throw new Error('Not authorized to update this board');
}

/**
 * Record an edit made by someone other than the board's creator. Does nothing
 * for the creator, or when no field actually changed.
 */
export async function recordStaffBoardEdit(
  executor: ModerationExecutor,
  input: {
    actorUserId: string;
    board: { id: number; ownerId: string; gymId: number | null; boardType: string };
    mutation: string;
    /** Changed fields. Omit for a mutation that is itself the change (publishing a version, say). */
    fields?: string[];
    /** Already known by the caller (the admin path). Resolved from the board otherwise. */
    actorRole?: BoardModerationActorRole;
    reason?: string;
    details?: BoardModerationEventDetails;
  },
): Promise<void> {
  const { actorUserId, board, mutation, fields } = input;
  // Any edit, the creator's included, may fix a "set up wrong" report.
  if ((board.ownerId === actorUserId && input.reason === undefined) || (fields !== undefined && fields.length === 0)) {
    await onBoardEdited(executor, { actorUserId, board, mutation, fields, actorRole: input.actorRole });
    return;
  }
  // The role first, before anything is written: one revoked since the edit gate
  // refuses the edit here, and no report closes on it.
  const actorRole = input.actorRole ?? (await resolveBoardEditActorRole(actorUserId, board, executor));
  await onBoardEdited(executor, { actorUserId, board, mutation, fields, actorRole });
  const details: BoardModerationEventDetails = {
    ...input.details,
    mutation,
    ...(fields === undefined ? {} : { fields }),
  };
  await recordBoardModerationEvent(executor, {
    boardId: board.id,
    gymId: board.gymId,
    actorUserId,
    actorRole,
    action: 'edited_by_staff',
    reason: input.reason,
    details,
  });
}

// ============================================
// The re-link hold
// ============================================
//
// The latest `removed_from_gym` or `relinked` event for a (board, gym) pair
// decides. A removal by anyone but the creator holds the board off that gym; a
// later relink by staff lifts the hold. `isBoardHeldOffGym` (one board) and
// `boardHeldOffGymCondition` (SQL, for lists) are the same rule; change both.
//
// "Latest" is by `id`, never `created_at`: `created_at` is the transaction's
// start, so a removal whose transaction began first but committed last would
// sort before the relink it actually followed. Every writer of these two
// actions inserts while it holds the board's row lock, so `id` order is the
// order the changes happened in.

const HOLD_ACTIONS = ['removed_from_gym', 'relinked'] as const;

type HoldEvent = Pick<BoardModerationEvent, 'id' | 'action' | 'actorRole'>;

const holdEventColumns = {
  id: dbSchema.boardModerationEvents.id,
  action: dbSchema.boardModerationEvents.action,
  actorRole: dbSchema.boardModerationEvents.actorRole,
};

/** A removal that holds the creator off: by anyone but the creator. */
function isStaffRemoval(event: HoldEvent | undefined): boolean {
  return event?.action === 'removed_from_gym' && event.actorRole !== 'board_owner';
}

/** The latest removal or relink of this board, at one gym or (no gym given) at any. */
async function latestHoldEvent(
  boardId: number,
  gymId: number | null,
  executor: ModerationExecutor,
): Promise<HoldEvent | undefined> {
  const [latest] = await executor
    .select(holdEventColumns)
    .from(dbSchema.boardModerationEvents)
    .where(
      and(
        eq(dbSchema.boardModerationEvents.boardId, boardId),
        gymId == null ? undefined : eq(dbSchema.boardModerationEvents.gymId, gymId),
        inArray(dbSchema.boardModerationEvents.action, [...HOLD_ACTIONS]),
      ),
    )
    .orderBy(desc(dbSchema.boardModerationEvents.id))
    .limit(1);
  return latest;
}

/** Whether this board's creator is held off self-linking it to this gym. */
export async function isBoardHeldOffGym(
  boardId: number,
  gymId: number,
  executor: ModerationExecutor = db,
): Promise<boolean> {
  return isStaffRemoval(await latestHoldEvent(boardId, gymId, executor));
}

/**
 * Whether the board's most recent removal or relink, at any gym, is a staff
 * removal. `clearLocationSyncFreeze` refuses such a board: the freeze is what
 * keeps the location sync from writing the removed link back.
 */
export async function isLatestHoldEventStaffRemoval(
  boardId: number,
  executor: ModerationExecutor = db,
): Promise<boolean> {
  return isStaffRemoval(await latestHoldEvent(boardId, null, executor));
}

/**
 * Whether this gym's staff may put a board they removed back on their listing
 * (`attachBoardToGym`'s re-list path): it is held off this gym, and its creator
 * has not linked or unlinked it anywhere since that removal. Every link change
 * a creator makes is on the record (`recordOwnerGymLinkChange`), so a later
 * event by the creator is that move. The caller checks the rest of the rule:
 * the board is live, unlinked, and its location is not hidden.
 */
export async function isHeldBoardRelistable(
  board: { id: number; ownerId: string },
  gymId: number,
  executor: ModerationExecutor = db,
): Promise<boolean> {
  const removal = await latestHoldEvent(board.id, gymId, executor);
  if (!removal || !isStaffRemoval(removal)) return false;
  const [creatorMovedSince] = await executor
    .select({ id: dbSchema.boardModerationEvents.id })
    .from(dbSchema.boardModerationEvents)
    .where(
      and(
        eq(dbSchema.boardModerationEvents.boardId, board.id),
        eq(dbSchema.boardModerationEvents.actorUserId, board.ownerId),
        inArray(dbSchema.boardModerationEvents.action, [...HOLD_ACTIONS]),
        gt(dbSchema.boardModerationEvents.id, removal.id),
      ),
    )
    .limit(1);
  return !creatorMovedSince;
}

/**
 * Record a creator moving their own board between gyms (`linkBoardToGym`, an
 * owner's `updateSprayWall`, an own-board stray attach, `createGym`): off the old
 * gym as `removed_from_gym` and onto the new one as `relinked`, both by the
 * creator. Neither places a hold. They are what lets a staff re-list see that
 * the creator moved the board after staff removed it (`isHeldBoardRelistable`).
 *
 * `linkActorRole` is for a link that lifted a hold: the creator is that gym's
 * owner or admin, and the relink is recorded in that role. Nothing is recorded
 * when the gym does not change.
 */
export async function recordOwnerGymLinkChange(
  executor: ModerationExecutor,
  input: {
    boardId: number;
    actorUserId: string;
    fromGymId: number | null;
    toGymId: number | null;
    mutation: string;
    linkActorRole?: BoardModerationActorRole;
  },
): Promise<void> {
  const { boardId, actorUserId, fromGymId, toGymId, mutation } = input;
  if (fromGymId === toGymId) return;
  if (fromGymId != null) {
    await recordBoardModerationEvent(executor, {
      boardId,
      gymId: fromGymId,
      actorUserId,
      actorRole: 'board_owner',
      action: 'removed_from_gym',
      details: { mutation },
    });
  }
  if (toGymId != null) {
    await recordBoardModerationEvent(executor, {
      boardId,
      gymId: toGymId,
      actorUserId,
      actorRole: input.linkActorRole ?? 'board_owner',
      action: 'relinked',
      details: { mutation },
    });
  }
}

/**
 * SQL twin of `isBoardHeldOffGym`, correlated on a board id column, for list
 * queries that must skip held boards without a query per row.
 */
export function boardHeldOffGymCondition(boardIdColumn: SQLWrapper, gymId: number): SQL<boolean> {
  const latestHoldEvent = db
    .select({
      held: sql<boolean>`${dbSchema.boardModerationEvents.action} = 'removed_from_gym' AND ${dbSchema.boardModerationEvents.actorRole} <> 'board_owner'`,
    })
    .from(dbSchema.boardModerationEvents)
    .where(
      and(
        sql`${dbSchema.boardModerationEvents.boardId} = ${boardIdColumn}`,
        eq(dbSchema.boardModerationEvents.gymId, gymId),
        inArray(dbSchema.boardModerationEvents.action, [...HOLD_ACTIONS]),
      ),
    )
    .orderBy(desc(dbSchema.boardModerationEvents.id))
    .limit(1);
  return sql<boolean>`COALESCE((${latestHoldEvent}), false)`;
}
