// A board setup in words, for the done step, the review sheet's suggestions and
// the climber-change notice: "Original · 12×12 · Bolt Ons, Screw Ons".
//
// The words are board-config's setup labels (`boardSetupSummary`), the same
// ones www shows, so a setup reads alike on both. This file only adds the two
// rules the app's callers need: no line at all when the catalogue knows none
// of the setup, and a board's own angle only when the board doesn't tilt.

import { boardSetupLabelParts, boardSetupSummary, type BoardSetupLabelInput } from '@boardsesh/board-config';

/**
 * The setup on one line, its known parts joined with " · ". Null when the
 * catalogue knows none of it (a board type this build doesn't know, ids it
 * doesn't list), so a caller can leave the line out rather than print the
 * board type's name in its place.
 */
export function formatSetupSummary(boardType: string, setup: BoardSetupLabelInput): string | null {
  const parts = boardSetupLabelParts(boardType, setup);
  const known = parts.layout !== null || parts.size !== null || parts.sets.length > 0 || parts.angle !== null;
  return known ? boardSetupSummary(boardType, setup) : null;
}

/**
 * A board's own setup on one line. Its angle is part of the setup only when the
 * board doesn't tilt; on one that does, the angle is whatever the wall is at.
 */
export function formatBoardSetupSummary(board: {
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  isAngleAdjustable: boolean;
}): string | null {
  return formatSetupSummary(board.boardType, { ...board, angle: board.isAngleAdjustable ? null : board.angle });
}
