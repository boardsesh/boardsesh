/** Screenshot-only board identity shared with the capture orchestrator. */
export interface ScreenshotCppBoardIdentity {
  uuid?: string;
  boardType: string;
  layoutId?: number;
  sizeId?: number;
  setIds?: readonly number[];
  angle?: number;
}

export interface ScreenshotCppSelectableBoard {
  uuid?: string;
  name: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds?: string | null;
  angle: number;
}

export function screenshotCppBoardMatches(
  board: ScreenshotCppSelectableBoard,
  selector: string,
  identity: ScreenshotCppBoardIdentity,
): boolean {
  if (
    board.name !== selector ||
    board.boardType !== identity.boardType ||
    (identity.uuid && board.uuid !== identity.uuid)
  )
    return false;
  if (identity.boardType === 'spray') return true;
  const sortedSets = (sets: readonly number[]) => [...sets].sort((first, second) => first - second).join(',');
  return (
    board.layoutId === identity.layoutId &&
    board.sizeId === identity.sizeId &&
    board.angle === identity.angle &&
    Array.isArray(identity.setIds) &&
    sortedSets((board.setIds ?? '').split(',').filter(Boolean).map(Number)) === sortedSets(identity.setIds)
  );
}

export function resolveScreenshotCppBoard<Board extends ScreenshotCppSelectableBoard>(
  boards: readonly Board[],
  selector: string,
  identity: ScreenshotCppBoardIdentity,
): Board | null {
  const matches = boards.filter((board) => screenshotCppBoardMatches(board, selector, identity));
  return matches.length === 1 ? matches[0] : null;
}
