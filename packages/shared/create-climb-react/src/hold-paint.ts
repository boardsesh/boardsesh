import { HOLD_STATE_MAP, STATE_TO_PRIMARY_CODE } from '@boardsesh/board-constants/hold-states';
import type { BoardName, HoldState, LitUpHoldsMap } from '@boardsesh/shared-schema';

/** Most holds one frame may carry in a capped role (two starts, two finishes). */
export const MAX_HOLDS_PER_CAPPED_ROLE = 2;

/**
 * Paint one hold in one frame, or take it off with `'OFF'`.
 *
 * Returns `frame` itself whenever nothing changes, so a caller (the editor's
 * history) can tell a real edit from a no-op by reference:
 *  - clearing a hold that is not painted;
 *  - repainting a hold the role it already has;
 *  - a third start or a third finish in the same frame;
 *  - a role this board cannot paint, or a board this table does not know.
 *
 * The lookups are optional-chained because this runs inside a reducer, during
 * render, where a throw is unrecoverable (#3804).
 */
export function applyHoldState(
  frame: LitUpHoldsMap,
  boardName: BoardName,
  holdId: number,
  nextState: HoldState | 'OFF',
): LitUpHoldsMap {
  if (nextState === 'OFF') {
    if (!(holdId in frame)) return frame;
    const { [holdId]: _removed, ...rest } = frame;
    void _removed;
    return rest;
  }

  if (frame[holdId]?.state === nextState) return frame;

  if (nextState === 'STARTING' || nextState === 'FINISH') {
    const sameRoleCount = Object.values(frame).filter((hold) => hold.state === nextState).length;
    if (sameRoleCount >= MAX_HOLDS_PER_CAPPED_ROLE) return frame;
  }

  const stateCode = STATE_TO_PRIMARY_CODE[boardName]?.[nextState];
  if (stateCode === undefined) return frame;
  const holdInfo = HOLD_STATE_MAP[boardName]?.[stateCode];
  if (!holdInfo) return frame;

  return {
    ...frame,
    [holdId]: {
      state: nextState,
      color: holdInfo.color,
      displayColor: holdInfo.displayColor || holdInfo.color,
    },
  };
}
