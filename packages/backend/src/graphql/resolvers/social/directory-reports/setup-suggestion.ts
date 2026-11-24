import { and, count, desc, eq, gt } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { isOfferedSetupAngle, normaliseSetIds } from '@boardsesh/board-config';
import * as dbSchema from '@boardsesh/db/schema';
import type { BoardModerationActorRole, BoardSetupSnapshot, DirectoryReport } from '@boardsesh/db/schema';
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
import {
  gymManagerIds,
  isSystemOwner,
  loadGymFacts,
  type BoardFacts,
  type DirectoryExecutor,
  type GymFacts,
} from './core';
import { onBoardEdited } from './lifecycle';
import { sendDirectoryNotices } from './notices';
import {
  BOARD_SETUP_COLUMNS,
  boardHasSetup,
  boardSetupSnapshot,
  changedSetupFields,
  readSetupSnapshot,
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
//    the board's setup. `suggestionMayChangeBoard` then says, from the flag
//    and the board's gym, whether the filing transaction locks the board row
//    to change it (`FOR NO KEY UPDATE`) or only to read it (`FOR SHARE`).
// 2. `assertSuggestionDiffersNow`, under the board's row lock: it still differs.
// 3. `settleSetupSuggestion`, once the report is filed: the gym and the limits
//    (`setupSuggestionDecision`), read again under the lock, then a clash with
//    another board, decide whether it applies. Applying changes the board,
//    closes its waiting "Set up wrong" reports as fixed by `climber`, records
//    the change and tells the people who can undo it: the board's creator and
//    the owner and admins of its gym.

type UserBoardRow = typeof dbSchema.userBoards.$inferSelect;

/** The board's gym as the rule reads it: its listing state, or `NO_GYM`. Also the analytics `gymState`. */
export type SuggestionGymState = GymListingState | 'NO_GYM';

export type SettledSuggestion =
  | { outcome: 'APPLIED'; reviewReason: null; gymState: SuggestionGymState; board: UserBoardRow }
  | { outcome: 'SENT_FOR_REVIEW'; reviewReason: SetupSuggestionReviewReason | null; gymState: SuggestionGymState };

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

/**
 * The suggestion is the board's setup already: BAD_USER_INPUT with
 * `extensions.reason` `SETUP_UNCHANGED`, so a client can tell it from an
 * invalid setup (`isBoardSetupUnchangedError` in `@boardsesh/graphql/errors`).
 * A page read before someone else's change gets it: the board may be fixed.
 */
function setupUnchanged(): GraphQLError {
  return new GraphQLError("That's the setup this board has now.", {
    extensions: { code: 'BAD_USER_INPUT', reason: 'SETUP_UNCHANGED' },
  });
}

/**
 * Thrown inside the filing transaction when the board row was locked to read
 * (`FOR SHARE`) but the decision, read under that lock, says the suggestion
 * applies: the gym changed after the pre-check. `fileReport` rolls the
 * transaction back and files again with the row locked to change it, rather
 * than upgrading the lock, which could deadlock with another filer.
 */
export class SuggestionNeedsChangeLock extends Error {
  constructor() {
    super('A suggested setup may apply now; file again with the board row locked to change it.');
    this.name = 'SuggestionNeedsChangeLock';
  }
}

/** Whether a gym lets a climber's suggestion change its boards straight away: live, and not run by the gym. */
function gymAllowsClimberChange(gym: GymFacts | undefined): gym is GymFacts {
  return gym !== undefined && gym.deletedAt === null && gym.listingState !== 'RUN_BY_GYM';
}

/**
 * The cheap pre-check, before the filing transaction: whether this suggestion
 * may change the board, so the transaction locks the board row to change it.
 * The flag is on and the board's gym lets a climber change it. The limits are
 * left to the decision under the lock; a pre-check that turns out stale there
 * makes `fileReport` file again (`SuggestionNeedsChangeLock`).
 */
export async function suggestionMayChangeBoard(
  board: Pick<BoardFacts, 'gymId'>,
  flagOn: boolean,
  executor: DirectoryExecutor = db,
): Promise<boolean> {
  if (!flagOn || board.gymId == null) return false;
  return gymAllowsClimberChange((await loadGymFacts([board.gymId], executor)).get(board.gymId));
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
  if (boardHasSetup(board, suggestion)) throw setupUnchanged();
}

/**
 * The suggestion `reportBoard` will store, or the refusal the reporter reads
 * (BAD_USER_INPUT, nothing filed): a reason other than "Set up wrong" or a
 * spray wall, a layout, size or sets the board's type doesn't have, an angle it
 * doesn't support, or the setup the board has now (`reason: SETUP_UNCHANGED`).
 * An angle other than the board's own must be one an Angle row offers
 * (`isOfferedSetupAngle`); the board's own angle always passes, so a climber
 * who only changed the layout of a board at an odd angle isn't refused. The
 * sets are stored in canonical order. The angle is kept only on a board that
 * doesn't tilt; on one that does, the climber picks the angle on the wall, so
 * it is not part of the setup. Left out on a board that doesn't tilt, it means
 * "keep the angle".
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
  if (
    suggestion.angle != null &&
    suggestion.angle !== Number(current.angle) &&
    !isOfferedSetupAngle(board.boardType, suggestion.angle)
  ) {
    throw badInput("That angle isn't one this board can be set to.");
  }
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

/** The board's latest event of this kind: when, and its details. Null when it has none. */
async function latestEvent(
  executor: DirectoryExecutor,
  boardId: number,
  action: 'setup_changed_by_climber' | 'setup_change_undone',
): Promise<{ createdAt: Date; after: BoardSetupSnapshot | null } | null> {
  const [latest] = await executor
    .select({ createdAt: dbSchema.boardModerationEvents.createdAt, details: dbSchema.boardModerationEvents.details })
    .from(dbSchema.boardModerationEvents)
    .where(and(eq(dbSchema.boardModerationEvents.boardId, boardId), eq(dbSchema.boardModerationEvents.action, action)))
    .orderBy(desc(dbSchema.boardModerationEvents.createdAt))
    .limit(1);
  return latest ? { createdAt: latest.createdAt, after: readSetupSnapshot(latest.details?.after) } : null;
}

/**
 * Climber changes this climber made, on any board, since `since`. Served by
 * `board_moderation_events_actor_created_idx`.
 */
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
 * Who hears about a climber's change: the people who can undo it
 * (`undoActorRole` in setup-changes.ts). The board's creator, unless it is a
 * synced board, and the owner and admins of the gym the board is at
 * (`gymManagerIds`, the same set `viewerGymManagerRole` admits, minus the
 * SYSTEM import account). Each once, and never the climber who made it.
 * `sendDirectoryNotices` still drops anyone who can't read the board.
 */
async function setupChangeRecipients(
  executor: DirectoryExecutor,
  board: Pick<UserBoardRow, 'ownerId' | 'gymId'>,
  actorId: string,
): Promise<string[]> {
  const recipients = new Set<string>();
  if (!isSystemOwner(board.ownerId)) recipients.add(board.ownerId);
  if (board.gymId != null)
    for (const managerId of await gymManagerIds(board.gymId, executor)) recipients.add(managerId);
  recipients.delete(actorId);
  return [...recipients];
}

/**
 * Change the board to the climber's setup, in the filing transaction, and do
 * what any edit does: freeze it against the location sync (the freeze staff
 * edits set), close its waiting "Set up wrong" reports as fixed (resolver role
 * `climber`; the climber who made the change hears nothing, as the one who
 * closed them), record `setup_changed_by_climber` with the setups on either
 * side and the freeze it replaced, and tell the people who can undo it, with a
 * push.
 *
 * A creator suggesting a setup on their own board acts as `board_owner`, as the
 * report closes (`creator`), not as a climber with no say over the board.
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
  const actorRole: BoardModerationActorRole = board.ownerId === actorId ? 'board_owner' : 'climber';
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
    actorRole,
  });
  const eventId = await recordBoardModerationEvent(executor, {
    boardId: board.id,
    gymId: board.gymId,
    actorUserId: actorId,
    actorRole,
    action: 'setup_changed_by_climber',
    details: {
      before,
      after,
      reportUuid: report.uuid,
      syncFrozenAtBefore: board.syncFrozenAt?.toISOString() ?? null,
      syncFrozenAtSet: now.toISOString(),
    },
  });
  const recipients = await setupChangeRecipients(executor, board, actorId);
  await sendDirectoryNotices(
    executor,
    recipients.map((recipientId) => ({
      recipientId,
      type: 'board_setup_changed_by_climber',
      target: { kind: 'board', boardId: board.id, boardUuid: board.uuid, ownerId: board.ownerId },
      reportId: report.id,
      gymId: board.gymId,
      boardModerationEventId: eventId,
      push: true,
    })),
  );
  return updated;
}

/**
 * What a filed suggestion does, in the filing transaction, with the board's
 * row locked. The report is already written and carries the suggestion on the
 * reporter's row.
 *
 * `mayApply` is the `directory-setup-suggestions` flag: off, every suggestion
 * waits for review with no reason. On, `setupSuggestionDecision` decides from
 * the board's gym and the limits, all read here under the lock, and an
 * `apply` that would clash with another board goes to review as `CLASHES`.
 * The limits come from `board_moderation_events`: the latest climber change
 * and undo on the board, whether the board still has that change's setup (one
 * it no longer has was overridden by hand, which counts as an undo), and the
 * climber's changes in the last 24 hours.
 *
 * `holdsChangeLock` says the row is locked `FOR NO KEY UPDATE`, so of two
 * suggestions on one board the second reads the first's change and goes to
 * review as `RECENT_CHANGE`. A decision to apply under a `FOR SHARE` lock
 * throws `SuggestionNeedsChangeLock`, and `fileReport` files again.
 */
export async function settleSetupSuggestion(
  executor: DirectoryExecutor,
  input: {
    actorId: string;
    board: BoardFacts;
    suggestion: BoardSetupSnapshot;
    mayApply: boolean;
    holdsChangeLock: boolean;
    report: DirectoryReport;
  },
): Promise<SettledSuggestion> {
  const { actorId, board, suggestion } = input;
  const gym = board.gymId != null ? (await loadGymFacts([board.gymId], executor)).get(board.gymId) : undefined;
  const liveGym = gym && gym.deletedAt === null ? gym : null;
  const gymState: SuggestionGymState = liveGym?.listingState ?? 'NO_GYM';
  if (!input.mayApply) return { outcome: 'SENT_FOR_REVIEW', reviewReason: null, gymState };

  const now = new Date();
  const [current, lastClimberChange, lastUndo, climberChangesInWindow] = await Promise.all([
    executor
      .select()
      .from(dbSchema.userBoards)
      .where(eq(dbSchema.userBoards.id, board.id))
      .limit(1)
      .then(([row]) => row),
    latestEvent(executor, board.id, 'setup_changed_by_climber'),
    latestEvent(executor, board.id, 'setup_change_undone'),
    climberChangesSince(executor, actorId, setupSuggestionWindowStarts(now).climberChangesSince),
  ]);
  if (!current) throw new GraphQLError('Board not found', { extensions: { code: 'NOT_FOUND' } });
  const overridden =
    lastClimberChange !== null && lastClimberChange.after !== null && !boardHasSetup(current, lastClimberChange.after);
  const decision = setupSuggestionDecision({
    hasGym: liveGym !== null,
    gymListingState: liveGym?.listingState ?? null,
    lastClimberChangeAt: lastClimberChange?.createdAt ?? null,
    lastUndoAt: lastUndo?.createdAt ?? null,
    lastClimberChangeOverriddenAt: overridden ? lastClimberChange.createdAt : null,
    climberChangesInWindow,
    now,
  });
  if (decision.outcome === 'review') return { outcome: 'SENT_FOR_REVIEW', reviewReason: decision.reason, gymState };
  if (!input.holdsChangeLock) throw new SuggestionNeedsChangeLock();

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
