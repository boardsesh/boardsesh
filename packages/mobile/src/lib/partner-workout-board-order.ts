/** A workout's preferred board is an ordering hint, never a forced selection or filter. */
export function orderBoardsForPartnerWorkout<Board extends { boardType: string; angle: number }>(
  boards: readonly Board[],
  preferred: { type: string; angle?: number } | undefined,
): Board[] {
  if (!preferred) return [...boards];
  const rank = (board: Board) =>
    board.boardType !== preferred.type ? 2 : preferred.angle === undefined || board.angle === preferred.angle ? 0 : 1;
  return boards
    .map((board, index) => ({ board, index }))
    .sort((left, right) => rank(left.board) - rank(right.board) || left.index - right.index)
    .map(({ board }) => board);
}
