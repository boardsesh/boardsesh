export type BoardAngleFields = { isAngleAdjustable?: boolean | null; angle?: number | null };

/**
 * Whether the climber can change this board's angle from the app: a board is
 * set, it isn't a fixed-angle wall, and it has an angle to start from. The
 * toolbar angle button renders on exactly this, and the climb-list toolbar
 * counts its slot on it, so the two can't disagree.
 */
export function canAdjustBoardAngle<Board extends BoardAngleFields>(
  board: Board | null | undefined,
): board is Board & { angle: number } {
  return board != null && board.isAngleAdjustable !== false && board.angle != null;
}
