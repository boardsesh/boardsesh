import { and, count, desc, eq, gt } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { normaliseSetIds } from '@boardsesh/board-config';
import * as dbSchema from '@boardsesh/db/schema';
import type { BoardModerationAction, BoardSetupSnapshot, DirectoryReport } from '@boardsesh/db/schema';
import {
  isSetupSuggestionAllowed,
  setupSuggestionDecision,
  setupSuggestionWindowStarts,
  type GymListingState,
  type SetupSuggestionReviewReason,
} from '@boardsesh/directory-moderation';
import type { BoardSetupInput } from '@boardsesh/shared-schema';
import { db } from '../../../../db/client';
import { BOARD_ANGLE_VALIDATION_MESSAGE, isBoardAngleSupported } from '../../../../validation/schemas';
import { assertKnownBoardConfig } from '../../board-presence/board-catalog';
import { lockAndAssertBoardSerialAvailable } from '../../board-serial-write-lock';
import { findOwnedBlockingDuplicate } from '../boards';
import { recordBoardModerationEvent } from '../board-moderation-events';
import { isSystemOwner, loadGymFacts, type BoardFacts, type DirectoryExecutor } from './core';
import { onBoardEdited } from './lifecycle';
import { sendDirectoryNotices } from './notices';
import {
  BOARD_SETUP_COLUMNS,
  boardHasSetup,
  boardSetupSnapshot,
  changedSetupFields,
  type BoardSetupColumns,
} from './setup-snapshot';

// ============================================
// Directory reports: a suggested setup
// ============================================
//
// "Set up wrong" on a board that isn't a spray wall can carry the setup the
// climber says is right (docs/product/directory-reports.md, "Suggested
// setup"). At a gym nobody runs, and with no limit hit, it changes the board
// for everyone in the filing transaction; everywhere else it waits on the
// report for the people who can change the board.
//
// 1. `checkedSuggestedSetup`, before the transaction: the reason and board type
//    allow one, it is a real setup of the board's type, and it differs from
//    the board's setup.
// 2. `assertSuggestionDiffersNow`, under the board's row lock: it still differs.
// 3. `settleSetupSuggestion`, once the report is filed: the gym and the limits
//    (`setupSuggestionDecision`), then a clash with another board, decide
//    whether it applies. Applying changes the board, closes its waiting "Set up
//    wrong" reports as fixed by `climber`, records the change and tells the
//    board's creator.

type UserBoardRow = typeof dbSchema.userBoards.$inferSelect;

/** The board's gym as the rule reads it: its listing state, or `NO_GYM`. Also the analytics `gymState`. */
export type SuggestionGymState = GymListingState | 'NO_GYM';

export type SettledSuggestion =
  | { outcome: 'APPLIED'; reviewReason: null; gymState: SuggestionGymState; board: UserBoardRow }
  | { outcome: 'SENT_FOR_REVIEW'; reviewReason: SetupSuggestionReviewReason | null; gymState: SuggestionGymState };

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

async function readBoardSetup(boardId: number, executor: DirectoryExecutor): Promise<BoardSetupColumns> {
  const [setup] = await executor
    .select(BOARD_SETUP_COLUMNS)
    .from(dbSchema.userBoards)
    .where(eq(dbSchema.userBoards.id, boardId))
    .limit(1);
  if (!setup) throw new GraphQLError('Board not found', { extensions: { code: 'NOT_FOUND' } });
  return setup;
}

function assertDiffers(board: BoardSetupColumns, suggestion: BoardSetupSnapshot): void {
  if (boardHasSetup(board, suggestion)) throw badInput("That's the setup this board has now.");
}

/**
 * The suggestion `reportBoard` will store, or the refusal the reporter reads
 * (BAD_USER_INPUT, nothing filed): a reason other than "Set up wrong" or a
 * spray wall, a layout, size or sets the board's type doesn't have, an angle it
 * doesn't support, or the setup the board has now. The sets are stored in
 * canonical order. The angle is kept only on a board that doesn't tilt; on one
 * that does, the climber picks the angle on the wall, so it is not part of the
 * setup. Left out on a board that doesn't tilt, it means "keep the angle".
 */
export async function checkedSuggestedSetup(
  board: Pick<BoardFacts, 'id' | 'boardType'>,
  reason: string,
  suggestion: BoardSetupInput,
): Promise<BoardSetupSnapshot> {
  if (!isSetupSuggestionAllowed(reason, board.boardType)) {
    throw badInput('Only a "set up wrong" report on a board with a layout can suggest a setup.');
  }
  try {
    await assertKnownBoardConfig(board.boardType, suggestion.layoutId, suggestion.sizeId, suggestion.setIds);
  } catch (error) {
    if (error instanceof GraphQLError && error.extensions.code === 'UNKNOWN_BOARD_CONFIG') {
      throw badInput("That layout, size and holds don't go together on this board.");
    }
    throw error;
  }
  if (!isBoardAngleSupported(board.boardType, suggestion.angle)) throw badInput(BOARD_ANGLE_VALIDATION_MESSAGE);
  const current = await readBoardSetup(board.id, db);
  const setup: BoardSetupSnapshot = {
    layoutId: suggestion.layoutId,
    sizeId: suggestion.sizeId,
    setIds: normaliseSetIds(suggestion.setIds),
    angle: current.isAngleAdjustable ? null : (suggestion.angle ?? null),
  };
  assertDiffers(current, setup);
  return setup;
}

/**
 * The same refusal under the board's row lock, in the filing transaction: a
 * change that committed since the first check (another climber's suggestion
 * of the same setup, an edit) may have made the board what this suggests.
 */
export async function assertSuggestionDiffersNow(
  executor: DirectoryExecutor,
  boardId: number,
  suggestion: BoardSetupSnapshot,
): Promise<void> {
  assertDiffers(await readBoardSetup(boardId, executor), suggestion);
}

/** When this board's latest event of this kind was recorded, or null. */
async function latestEventAt(
  executor: DirectoryExecutor,
  boardId: number,
  action: BoardModerationAction,
): Promise<Date | null> {
  const [latest] = await executor
    .select({ createdAt: dbSchema.boardModerationEvents.createdAt })
    .from(dbSchema.boardModerationEvents)
    .where(and(eq(dbSchema.boardModerationEvents.boardId, boardId), eq(dbSchema.boardModerationEvents.action, action)))
    .orderBy(desc(dbSchema.boardModerationEvents.createdAt))
    .limit(1);
  return latest?.createdAt ?? null;
}

/** Climber changes this climber made, on any board, since `since`. */
async function climberChangesSince(executor: DirectoryExecutor, actorId: string, since: Date): Promise<number> {
  const [row] = await executor
    .select({ changes: count() })
    .from(dbSchema.boardModerationEvents)
    .where(
      and(
        eq(dbSchema.boardModerationEvents.actorUserId, actorId),
        eq(dbSchema.boardModerationEvents.action, 'setup_changed_by_climber'),
        gt(dbSchema.boardModerationEvents.createdAt, since),
      ),
    );
  return Number(row?.changes ?? 0);
}

/**
 * Whether the new setup would clash with another board: a copy of another live
 * board the same (non-SYSTEM) owner has at the same place
 * (`findOwnedBlockingDuplicate`, the guard `updateBoard` asks the owner to
 * confirm), or another owner's board with the same serial and setup
 * (`lockAndAssertBoardSerialAvailable`). Both only read, so a clash sends the
 * suggestion to review without spoiling the transaction.
 */
async function setupClashes(
  executor: DirectoryExecutor,
  board: UserBoardRow,
  setup: BoardSetupSnapshot,
  actorId: string,
): Promise<boolean> {
  if (!isSystemOwner(board.ownerId)) {
    const duplicate = await findOwnedBlockingDuplicate(
      {
        ownerId: board.ownerId,
        boardType: board.boardType,
        layoutId: setup.layoutId,
        sizeId: setup.sizeId,
        excludeBoardId: board.id,
        incoming: {
          setIds: setup.setIds,
          locationName: board.locationName,
          latitude: board.latitude,
          longitude: board.longitude,
        },
      },
      executor,
    );
    if (duplicate) return true;
  }
  if (board.serialNumber) {
    try {
      await lockAndAssertBoardSerialAvailable(
        executor,
        {
          serialNumber: board.serialNumber,
          boardType: board.boardType,
          layoutId: setup.layoutId,
          sizeId: setup.sizeId,
          setIds: setup.setIds,
        },
        board.ownerId,
        board.id,
        actorId,
      );
    } catch (error) {
      if (error instanceof GraphQLError && error.extensions.code === 'BOARD_SERIAL_EXISTS') return true;
      throw error;
    }
  }
  return false;
}

/**
 * Change the board to the climber's setup, in the filing transaction, and do
 * what any edit does: freeze it against the location sync (the freeze staff
 * edits set), close its waiting "Set up wrong" reports as fixed (resolver role
 * `climber`; the climber who made the change hears nothing, as the one who
 * closed them), record `setup_changed_by_climber` with the setups on either
 * side, and tell a creator who isn't SYSTEM or the climber.
 */
async function applySuggestion(
  executor: DirectoryExecutor,
  input: {
    actorId: string;
    board: UserBoardRow;
    before: BoardSetupSnapshot;
    after: BoardSetupSnapshot;
    report: DirectoryReport;
  },
): Promise<UserBoardRow> {
  const { actorId, board, before, after, report } = input;
  const now = new Date();
  const [updated] = await executor
    .update(dbSchema.userBoards)
    .set({
      layoutId: after.layoutId,
      sizeId: after.sizeId,
      setIds: after.setIds,
      ...(after.angle !== null ? { angle: after.angle } : {}),
      updatedAt: now,
      syncFrozenAt: now,
    })
    .where(eq(dbSchema.userBoards.id, board.id))
    .returning();
  const boardFacts = { id: board.id, ownerId: board.ownerId, gymId: board.gymId, boardType: board.boardType };
  await onBoardEdited(executor, {
    actorUserId: actorId,
    board: boardFacts,
    mutation: 'reportBoard',
    fields: changedSetupFields(before, after),
    actorRole: 'climber',
  });
  const eventId = await recordBoardModerationEvent(executor, {
    boardId: board.id,
    gymId: board.gymId,
    actorUserId: actorId,
    actorRole: 'climber',
    action: 'setup_changed_by_climber',
    details: { before, after, reportUuid: report.uuid },
  });
  if (!isSystemOwner(board.ownerId) && board.ownerId !== actorId) {
    await sendDirectoryNotices(executor, [
      {
        recipientId: board.ownerId,
        type: 'board_setup_changed_by_climber',
        target: { kind: 'board', boardId: board.id, boardUuid: board.uuid, ownerId: board.ownerId },
        reportId: report.id,
        gymId: board.gymId,
        boardModerationEventId: eventId,
      },
    ]);
  }
  return updated;
}

/**
 * What a filed suggestion does, in the filing transaction, with the board's
 * row locked `FOR UPDATE` (so of two suggestions on one board, the second reads
 * the first's change and goes to review as `RECENT_CHANGE`). The report is
 * already written and carries the suggestion on the reporter's row.
 *
 * `mayApply` is the `directory-setup-suggestions` flag: off, every suggestion
 * waits for review with no reason. On, `setupSuggestionDecision` decides from
 * the board's gym and the limits read from `board_moderation_events`, and an
 * `apply` that would clash with another board goes to review as `CLASHES`.
 */
export async function settleSetupSuggestion(
  executor: DirectoryExecutor,
  input: {
    actorId: string;
    board: BoardFacts;
    suggestion: BoardSetupSnapshot;
    mayApply: boolean;
    report: DirectoryReport;
  },
): Promise<SettledSuggestion> {
  const { actorId, board, suggestion } = input;
  const gym = board.gymId != null ? (await loadGymFacts([board.gymId], executor)).get(board.gymId) : undefined;
  const liveGym = gym && gym.deletedAt === null ? gym : null;
  const gymState: SuggestionGymState = liveGym?.listingState ?? 'NO_GYM';
  if (!input.mayApply) return { outcome: 'SENT_FOR_REVIEW', reviewReason: null, gymState };

  const now = new Date();
  const [lastClimberChangeAt, lastUndoAt, climberChangesInWindow] = await Promise.all([
    latestEventAt(executor, board.id, 'setup_changed_by_climber'),
    latestEventAt(executor, board.id, 'setup_change_undone'),
    climberChangesSince(executor, actorId, setupSuggestionWindowStarts(now).climberChangesSince),
  ]);
  const decision = setupSuggestionDecision({
    hasGym: liveGym !== null,
    gymListingState: liveGym?.listingState ?? null,
    lastClimberChangeAt,
    lastUndoAt,
    climberChangesInWindow,
    now,
  });
  if (decision.outcome === 'review') return { outcome: 'SENT_FOR_REVIEW', reviewReason: decision.reason, gymState };

  const [current] = await executor
    .select()
    .from(dbSchema.userBoards)
    .where(eq(dbSchema.userBoards.id, board.id))
    .limit(1);
  if (!current) throw new GraphQLError('Board not found', { extensions: { code: 'NOT_FOUND' } });
  const before = boardSetupSnapshot(current);
  // The board's angle stays part of the setup on a board that doesn't tilt,
  // so `after` is the setup the board is left with, angle included.
  const after: BoardSetupSnapshot = {
    ...suggestion,
    angle: current.isAngleAdjustable ? null : (suggestion.angle ?? Number(current.angle)),
  };
  if (await setupClashes(executor, current, after, actorId)) {
    return { outcome: 'SENT_FOR_REVIEW', reviewReason: 'CLASHES', gymState };
  }
  const updated = await applySuggestion(executor, { actorId, board: current, before, after, report: input.report });
  return { outcome: 'APPLIED', reviewReason: null, gymState, board: updated };
}
