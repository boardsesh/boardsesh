import type { BoardName } from '@boardsesh/shared-schema';
import { getMoonBoardDetails } from '@boardsesh/board-config';
import { getBoardRenderData } from './board-details';

export type BoardHoldTarget = { id: number; cx: number; cy: number; r: number };

export type CreateBoardHolds = {
  holdTargets: BoardHoldTarget[];
  boardWidth: number;
  boardHeight: number;
  family: 'aurora' | 'moonboard';
};

/**
 * Resolve tappable holds for a create editor board configuration. Aurora boards
 * use the hole-placement renderer; MoonBoard uses its grid-backed board config.
 */
export function getCreateBoardHolds(cfg: {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: number[];
}): CreateBoardHolds | null {
  if (cfg.boardName === 'moonboard') {
    try {
      const moonBoard = getMoonBoardDetails({ layout_id: cfg.layoutId, set_ids: cfg.setIds });
      return {
        holdTargets: moonBoard.holdsData.map((hold) => ({ id: hold.id, cx: hold.cx, cy: hold.cy, r: hold.r })),
        boardWidth: moonBoard.boardWidth,
        boardHeight: moonBoard.boardHeight,
        family: 'moonboard',
      };
    } catch {
      return null;
    }
  }

  const renderData = getBoardRenderData(cfg);
  if (!renderData) return null;
  return {
    holdTargets: renderData.holdsData.map((hold) => ({ id: hold.id, cx: hold.cx, cy: hold.cy, r: hold.r })),
    boardWidth: renderData.boardWidth,
    boardHeight: renderData.boardHeight,
    family: 'aurora',
  };
}
