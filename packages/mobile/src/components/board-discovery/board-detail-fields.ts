import type { UserBoard } from '@boardsesh/shared-schema';
import { toBoardName } from '@boardsesh/board-config';
import { getProductSize } from '@boardsesh/board-constants';
import { boardPlaceLabel } from './board-labels';

export type BoardDetailFields = {
  /** Gym name if linked, else the free-text location, else undefined. */
  subLocation: string | undefined;
  /** Hold sets joined for display, '' when none. */
  setNames: string;
  /** "<size> · <description>", or just the size, or undefined. */
  sizeText: string | undefined;
};

/** Derive the display strings shown in the board-detail sheet. Pure. */
export function getBoardDetailFields(board: UserBoard): BoardDetailFields {
  const subLocation = boardPlaceLabel(board) ?? undefined;
  const setNames = (board.setNames ?? []).join(' · ');
  // The server sends sizeName/sizeDescription as null on every board, which left
  // the Size row permanently hidden — fall back to the bundled size table.
  const boardName = toBoardName(board.boardType);
  const bundledSize = boardName === null ? null : getProductSize(boardName, board.sizeId);
  const sizeText =
    [board.sizeName ?? bundledSize?.name, board.sizeDescription ?? bundledSize?.description]
      .filter(Boolean)
      .join(' · ') || undefined;
  return { subLocation, setNames, sizeText };
}

/** Whether `board` is the user's currently-active board. */
export function isActiveBoard(board: UserBoard, activeUuid: string | null | undefined): boolean {
  return board.uuid === activeUuid;
}
