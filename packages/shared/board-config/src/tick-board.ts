import { classifyClimbBoardCompatibility, type ClimbBoardIdentity } from './board-compatibility';
import { toBoardName } from './board-name';
import { parseSetIds } from './set-ids';

export type TickClimbIdentity = ClimbBoardIdentity & { requiredSetIds?: readonly number[] | null };
export type TickBoardConfig = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
};

/** Attribution requires a known climb identity. Missing size/set measurements
 * impose no extra restriction, but a known incompatibility always wins. */
export function canAttributeTickToBoard(climb: TickClimbIdentity | null, board: TickBoardConfig): boolean {
  const boardName = toBoardName(board.boardType);
  if (!boardName || !climb?.boardType || climb.layoutId == null) return false;
  if (classifyClimbBoardCompatibility({ ...board, boardName }, climb) !== 'compatible') return false;
  const installedSets = new Set(parseSetIds(board.setIds));
  return (climb.requiredSetIds ?? []).every((setId) => installedSets.has(setId));
}
