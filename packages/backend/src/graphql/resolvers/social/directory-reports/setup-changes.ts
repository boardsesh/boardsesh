import { and, desc, eq, lt } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { rolesGrantAdmin } from '@boardsesh/community-roles';
import * as dbSchema from '@boardsesh/db/schema';
import type { BoardModerationActorRole } from '@boardsesh/db/schema';
import type { BoardSetupChange } from '@boardsesh/shared-schema';
import { db } from '../../../../db/client';
import { afterCommit, transactionWithAfterCommit } from '../../../../db/after-commit';
import { captureBackendEvent } from '../../../../services/analytics/posthog';
import { canAccessResource } from '../../../../services/privacy';
import { lockAndAssertBoardSerialAvailable } from '../../board-serial-write-lock';
import { recordBoardModerationEvent, viewerGymManagerRole } from '../board-moderation-events';
import { getUserCommunityRoles } from '../roles';
import { analyticsActorFor, isSystemOwner, type DirectoryExecutor } from './core';
import { onBoardEdited } from './lifecycle';
import { changedSetupFields, readSetupSnapshot, setupChangeStates, toBoardSetup } from './setup-snapshot';

// ============================================
// Climbers' setup changes: undo and the admin list
// ============================================
//
// (docs/product/directory-reports.md, "Undo")
//
// A climber's suggested setup that changed a board is recorded as a
// `setup_changed_by_climber` event (setup-suggestion.ts). Its undo puts the
// `before` back, as a compare-and-set under the board's row lock, and the
// admin list shows every change with where it stands.

type UserBoardRow = typeof dbSchema.userBoards.$inferSelect;

function setupChangeNotFound(): GraphQLError {
  return new GraphQLError('Setup change not found', { extensions: { code: 'NOT_FOUND' } });
}

function setupChangedSince(): GraphQLError {
  return new GraphQLError("This board's setup has changed since, so this change can't be undone.", {
    extensions: { code: 'BOARD_SETUP_CHANGED_SINCE' },
  });
}

function setupAlreadyUndone(): GraphQLError {
  return new GraphQLError('This change has been undone already.', {
    extensions: { code: 'BOARD_SETUP_ALREADY_UNDONE' },
  });
}

/** A stored ISO time as a Date, or null for none (or not a time). */
function readStoredTime(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time;
}

/**
 * The `sync_frozen_at` an undo leaves the board with, or undefined to leave it
 * as it is. The change froze the board against the location sync; the undo
 * puts back the freeze it replaced (often none) only while the board still has
 * the change's own freeze. A freeze written since (an edit) stays, and so
 * does the freeze of a change recorded without it.
 */
function freezeAfterUndo(
  board: Pick<UserBoardRow, 'syncFrozenAt'>,
  details: { syncFrozenAtBefore?: string | null; syncFrozenAtSet?: string } | null,
): Date | null | undefined {
  const setByChange = readStoredTime(details?.syncFrozenAtSet);
  if (!setByChange || board.syncFrozenAt?.getTime() !== setByChange.getTime()) return undefined;
  return readStoredTime(details?.syncFrozenAtBefore);
}

/**
 * The role this person may undo a climber's change to this board in, or null:
 * its creator (a synced board has none), the owner or an admin of the gym the
 * board is at now, or a global admin. Gym staff are `viewerGymManagerRole`, the
 * gym authority behind board edits (`canEditBoard`), so whoever may undo a
 * change could also have edited the setup back by hand; gym editors may do
 * neither. The gym relationship wins over a global admin role, as in
 * `resolveBoardEditActorRole`, so the record says the gym put it back.
 */
async function undoActorRole(
  executor: DirectoryExecutor,
  userId: string,
  board: UserBoardRow,
): Promise<BoardModerationActorRole | null> {
  if (board.ownerId === userId && !isSystemOwner(board.ownerId)) return 'board_owner';
  if (board.gymId != null) {
    const gymRole = await viewerGymManagerRole(board.gymId, userId, executor);
    // Staff act on a board only while they can read it, as `updateBoard` asks.
    if (gymRole && (await canAccessResource('board', board.uuid, userId, executor))) return gymRole;
  }
  return rolesGrantAdmin(await getUserCommunityRoles(userId, executor), null) ? 'global_admin' : null;
}

/**
 * `undoBoardSetupChange`: put back the setup a climber's change replaced. Under
 * the board's row lock (`FOR NO KEY UPDATE`), the change must still be LIVE:
 * `BOARD_SETUP_ALREADY_UNDONE` once someone undid it, `BOARD_SETUP_CHANGED_SINCE`
 * once the board's setup changed again. The sync freeze the change replaced
 * comes back while the board still has the change's own freeze
 * (`freezeAfterUndo`); one written since stays. Anyone who may not undo it
 * reads "not found", so the call is never an oracle for which changes exist.
 *
 * Like any setup edit, the undo closes the board's waiting "Set up wrong"
 * reports as fixed (`onBoardEdited`); the report the change closed stays closed.
 * The undo is recorded as `setup_change_undone` (`before` the climber's setup,
 * `after` the one put back, `undoesEventId`), which sends the board's
 * suggestions to review for 90 days and lets its reporters file again.
 *
 * The serial guard `updateBoard` runs still applies: putting the old setup back
 * must not make the board a copy of another owner's board with the same serial
 * (BOARD_SERIAL_EXISTS). The owner-duplicate prompt does not: this is the
 * board's own earlier setup, not a new one.
 */
export async function undoClimberSetupChange(userId: string, eventId: number): Promise<UserBoardRow> {
  return transactionWithAfterCommit(async (tx) => {
    const [event] = await tx
      .select()
      .from(dbSchema.boardModerationEvents)
      .where(eq(dbSchema.boardModerationEvents.id, eventId))
      .limit(1);
    const climberSetup = readSetupSnapshot(event?.details?.after);
    const earlierSetup = readSetupSnapshot(event?.details?.before);
    if (!event || event.action !== 'setup_changed_by_climber' || !climberSetup || !earlierSetup) {
      throw setupChangeNotFound();
    }
    const [board] = await tx
      .select()
      .from(dbSchema.userBoards)
      .where(eq(dbSchema.userBoards.id, event.boardId))
      .limit(1)
      .for('no key update');
    if (!board || board.deletedAt !== null || board.mergedIntoBoardUuid !== null) throw setupChangeNotFound();
    const actorRole = await undoActorRole(tx, userId, board);
    if (!actorRole) throw setupChangeNotFound();

    const states = await setupChangeStates([{ id: event.id, boardId: board.id, after: climberSetup }], tx);
    const state = states.get(event.id);
    if (state === 'UNDONE') throw setupAlreadyUndone();
    if (state !== 'LIVE') throw setupChangedSince();

    if (board.serialNumber) {
      await lockAndAssertBoardSerialAvailable(
        tx,
        {
          serialNumber: board.serialNumber,
          boardType: board.boardType,
          layoutId: earlierSetup.layoutId,
          sizeId: earlierSetup.sizeId,
          setIds: earlierSetup.setIds,
        },
        board.ownerId,
        board.id,
        userId,
      );
    }
    const freeze = freezeAfterUndo(board, event.details);
    const [restored] = await tx
      .update(dbSchema.userBoards)
      .set({
        layoutId: earlierSetup.layoutId,
        sizeId: earlierSetup.sizeId,
        setIds: earlierSetup.setIds,
        ...(earlierSetup.angle !== null ? { angle: earlierSetup.angle } : {}),
        updatedAt: new Date(),
        ...(freeze !== undefined ? { syncFrozenAt: freeze } : {}),
      })
      .where(eq(dbSchema.userBoards.id, board.id))
      .returning();
    await onBoardEdited(tx, {
      actorUserId: userId,
      board: { id: board.id, ownerId: board.ownerId, gymId: board.gymId, boardType: board.boardType },
      mutation: 'undoBoardSetupChange',
      fields: changedSetupFields(climberSetup, earlierSetup),
      actorRole,
    });
    await recordBoardModerationEvent(tx, {
      boardId: board.id,
      gymId: board.gymId,
      actorUserId: userId,
      actorRole,
      action: 'setup_change_undone',
      details: { before: climberSetup, after: earlierSetup, undoesEventId: event.id },
    });
    afterCommit(tx, () =>
      captureBackendEvent('Board Setup Change Undone', { properties: { by: analyticsActorFor(actorRole) } }),
    );
    return restored;
  });
}

/**
 * `adminBoardSetupChanges`: every climber setup change, newest first, with the
 * board, the gym it was at (null once that gym is deleted), the setups on
 * either side, the climber's name and where it stands. Three reads a page.
 *
 * Newest first is by event id, which only grows: every change takes its
 * board's row lock before it inserts, so ids follow the order the changes were
 * made. The cursor is the page's last id. (`created_at` is the transaction's
 * start and carries microseconds a millisecond cursor would cut, so paging on
 * it could skip a row.)
 */
export async function adminSetupChangesPage(options: {
  first: number;
  after: string | null;
}): Promise<{ changes: BoardSetupChange[]; nextCursor: string | null }> {
  const events = dbSchema.boardModerationEvents;
  const rows = await db
    .select({
      id: events.id,
      boardId: events.boardId,
      details: events.details,
      createdAt: events.createdAt,
      boardUuid: dbSchema.userBoards.uuid,
      boardName: dbSchema.userBoards.name,
      boardSlug: dbSchema.userBoards.slug,
      boardType: dbSchema.userBoards.boardType,
      gymUuid: dbSchema.gyms.uuid,
      gymName: dbSchema.gyms.name,
      gymSlug: dbSchema.gyms.slug,
      gymDeletedAt: dbSchema.gyms.deletedAt,
      climberDisplayName: dbSchema.userProfiles.displayName,
      climberName: dbSchema.users.name,
    })
    .from(events)
    .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.id, events.boardId))
    .leftJoin(dbSchema.gyms, eq(dbSchema.gyms.id, events.gymId))
    .leftJoin(dbSchema.users, eq(dbSchema.users.id, events.actorUserId))
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, events.actorUserId))
    .where(
      and(
        eq(events.action, 'setup_changed_by_climber'),
        options.after ? lt(events.id, Number(options.after)) : undefined,
      ),
    )
    .orderBy(desc(events.id))
    .limit(options.first + 1);
  const page = rows.slice(0, options.first);
  const recorded = page.flatMap((row) => {
    const before = readSetupSnapshot(row.details?.before);
    const after = readSetupSnapshot(row.details?.after);
    return before && after ? [{ row, before, after }] : [];
  });
  const states = await setupChangeStates(
    recorded.map(({ row, after }) => ({ id: row.id, boardId: row.boardId, after })),
  );
  return {
    changes: recorded.map(({ row, before, after }) => ({
      eventId: String(row.id),
      board: { uuid: row.boardUuid, name: row.boardName, slug: row.boardSlug, boardType: row.boardType },
      gym:
        row.gymUuid !== null && row.gymName !== null && row.gymDeletedAt === null
          ? { uuid: row.gymUuid, name: row.gymName, slug: row.gymSlug }
          : null,
      before: toBoardSetup(before),
      after: toBoardSetup(after),
      climberDisplayName: row.climberDisplayName ?? row.climberName ?? null,
      createdAt: row.createdAt.toISOString(),
      state: states.get(row.id) ?? 'CHANGED_SINCE',
    })),
    nextCursor: rows.length > options.first ? String(page[page.length - 1].id) : null,
  };
}
