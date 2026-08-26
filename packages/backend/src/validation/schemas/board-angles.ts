import { getRoutableBoardAngles, toBoardName } from '@boardsesh/board-config';

export const BOARD_ANGLE_VALIDATION_MESSAGE = 'Negative angle is not supported for this board';

/**
 * Preserve the historically permissive non-negative write ranges while
 * restricting negative catalogue angles to values explicitly supported by
 * that board. The numeric schemas at each call site retain their existing
 * upper bounds.
 */
export function isBoardAngleSupported(boardType: string, angle: number | null | undefined): boolean {
  if (angle == null || angle >= 0) return true;

  const boardName = toBoardName(boardType);
  return boardName !== null && getRoutableBoardAngles(boardName).includes(angle);
}
