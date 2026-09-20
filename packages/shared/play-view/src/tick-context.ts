import { canAttributeTickToBoard, type TickClimbIdentity } from '@boardsesh/board-config';

export type TickContextBoard = {
  uuid?: string;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
};

/** A render fallback is not evidence of which physical wall was climbed.
 * Omit size/sets on a mismatch so legacy server resolution cannot guess one. */
export function resolveTickBoardContext(
  climb: TickClimbIdentity | undefined,
  formBoard: { boardName: string; layoutId?: number; sizeId?: number; setIds?: string },
  activeBoard: TickContextBoard | null,
  presenceBoardId: number | null,
) {
  const boardName = climb?.boardType ?? formBoard.boardName;
  const layoutId = climb?.layoutId ?? formBoard.layoutId;
  const identity = { ...climb, boardType: boardName, layoutId };
  const compatible =
    activeBoard &&
    canAttributeTickToBoard(identity, {
      ...activeBoard,
      boardType: activeBoard.boardName,
    });
  if (!compatible) return { boardName, layoutId };
  return {
    boardName,
    layoutId,
    sizeId: activeBoard.sizeId,
    setIds: activeBoard.setIds,
    // A selected wall takes precedence over a shared configuration feed.
    ...(activeBoard.uuid ? { boardUuid: activeBoard.uuid } : {}),
    ...(presenceBoardId != null ? { boardId: presenceBoardId } : {}),
  };
}
