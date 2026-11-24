import { and, eq, inArray } from 'drizzle-orm';
import { normaliseSetIds } from '@boardsesh/board-config';
import * as dbSchema from '@boardsesh/db/schema';
import type { BoardSetupSnapshot } from '@boardsesh/db/schema';
import type { BoardSetup, BoardSetupChangeState } from '@boardsesh/shared-schema';
import { db } from '../../../../db/client';
import type { DirectoryExecutor } from './core';

// ============================================
// Board setups: snapshots and where a change stands
// ============================================
//
// A board's setup is its layout, size, hold sets and, on a board that doesn't
// tilt, its angle (docs/product/directory-reports.md, "Suggested setup"). A
// climber's change records the setup on either side of it; an undo is a
// compare-and-set against the change's `after`, and a change's state (LIVE,
// UNDONE, CHANGED_SINCE) is read the same way.

/** The board columns a setup is read from. */
export type BoardSetupColumns = {
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  isAngleAdjustable: boolean;
};

export const BOARD_SETUP_COLUMNS = {
  layoutId: dbSchema.userBoards.layoutId,
  sizeId: dbSchema.userBoards.sizeId,
  setIds: dbSchema.userBoards.setIds,
  angle: dbSchema.userBoards.angle,
  isAngleAdjustable: dbSchema.userBoards.isAngleAdjustable,
};

/** The board's setup as a change records it: sets in canonical order, the angle only on a board that doesn't tilt. */
export function boardSetupSnapshot(board: BoardSetupColumns): BoardSetupSnapshot {
  return {
    layoutId: Number(board.layoutId),
    sizeId: Number(board.sizeId),
    setIds: normaliseSetIds(board.setIds),
    angle: board.isAngleAdjustable ? null : Number(board.angle),
  };
}

/**
 * Whether the board has this setup: the same layout, size and sets (in any
 * order), and the same angle when the setup names one. A setup without an
 * angle leaves the angle out of the comparison.
 */
export function boardHasSetup(board: BoardSetupColumns, setup: BoardSetupSnapshot): boolean {
  return (
    Number(board.layoutId) === setup.layoutId &&
    Number(board.sizeId) === setup.sizeId &&
    normaliseSetIds(board.setIds) === normaliseSetIds(setup.setIds) &&
    (setup.angle === null || Number(board.angle) === setup.angle)
  );
}

/** The `updateBoard` fields a change from `before` to `after` touches, for `onBoardEdited`. */
export function changedSetupFields(before: BoardSetupSnapshot, after: BoardSetupSnapshot): string[] {
  const fields: string[] = [];
  if (before.layoutId !== after.layoutId) fields.push('layoutId');
  if (before.sizeId !== after.sizeId) fields.push('sizeId');
  if (normaliseSetIds(before.setIds) !== normaliseSetIds(after.setIds)) fields.push('setIds');
  if (after.angle !== null && before.angle !== after.angle) fields.push('angle');
  return fields;
}

/** The GraphQL `BoardSetup` for a stored snapshot. */
export function toBoardSetup(setup: BoardSetupSnapshot): BoardSetup {
  return { layoutId: setup.layoutId, sizeId: setup.sizeId, setIds: setup.setIds, angle: setup.angle };
}

/** The snapshot a jsonb column holds, or null when it holds none (or not a setup). */
export function readSetupSnapshot(value: unknown): BoardSetupSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const { layoutId, sizeId, setIds, angle } = value as Record<string, unknown>;
  if (typeof layoutId !== 'number' || typeof sizeId !== 'number' || typeof setIds !== 'string') return null;
  return { layoutId, sizeId, setIds, angle: typeof angle === 'number' ? angle : null };
}

export type RecordedSetupChange = {
  /** The `setup_changed_by_climber` event's id. */
  id: number;
  boardId: number;
  after: BoardSetupSnapshot;
};

/**
 * Where each of these climber changes stands, in two reads whatever the count:
 * UNDONE once a `setup_change_undone` names it; otherwise LIVE while its board
 * is live and still has the change's `after`; otherwise CHANGED_SINCE (the
 * board changed again, or was deleted or merged), which can't be undone.
 */
export async function setupChangeStates(
  changes: readonly RecordedSetupChange[],
  executor: DirectoryExecutor = db,
): Promise<Map<number, BoardSetupChangeState>> {
  const states = new Map<number, BoardSetupChangeState>();
  if (changes.length === 0) return states;
  const boardIds = [...new Set(changes.map((change) => change.boardId))];
  const [boards, undos] = await Promise.all([
    executor
      .select({
        id: dbSchema.userBoards.id,
        deletedAt: dbSchema.userBoards.deletedAt,
        mergedIntoBoardUuid: dbSchema.userBoards.mergedIntoBoardUuid,
        ...BOARD_SETUP_COLUMNS,
      })
      .from(dbSchema.userBoards)
      .where(inArray(dbSchema.userBoards.id, boardIds)),
    // A board's undos are few; matched to their change in JS, by `undoesEventId`.
    executor
      .select({ details: dbSchema.boardModerationEvents.details })
      .from(dbSchema.boardModerationEvents)
      .where(
        and(
          inArray(dbSchema.boardModerationEvents.boardId, boardIds),
          eq(dbSchema.boardModerationEvents.action, 'setup_change_undone'),
        ),
      ),
  ]);
  const boardById = new Map(boards.map((board) => [board.id, board]));
  const undoneEventIds = new Set(
    undos.flatMap((undo) => (undo.details?.undoesEventId ? [undo.details.undoesEventId] : [])),
  );
  for (const change of changes) {
    const board = boardById.get(change.boardId);
    if (undoneEventIds.has(change.id)) states.set(change.id, 'UNDONE');
    else if (
      board &&
      board.deletedAt === null &&
      board.mergedIntoBoardUuid === null &&
      boardHasSetup(board, change.after)
    ) {
      states.set(change.id, 'LIVE');
    } else states.set(change.id, 'CHANGED_SINCE');
  }
  return states;
}
