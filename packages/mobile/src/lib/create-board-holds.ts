import type { BoardName } from '@boardsesh/shared-schema';
import { getMoonBoardDetails } from '@boardsesh/board-config';
import { getBoardRenderData } from './board-details';

/**
 * The minimal per-hold geometry the interactive editor needs to place a tap
 * target + painted indicator. Both Aurora (`getBoardRenderData`) and MoonBoard
 * (`getMoonBoardDetails`, added in the MoonBoard PR) already produce
 * `{id, cx, cy, r}` in board-space pixels, so one editor renders either family.
 */
export type BoardHoldTarget = { id: number; cx: number; cy: number; r: number };

export type CreateBoardHolds = {
  holdTargets: BoardHoldTarget[];
  boardWidth: number;
  boardHeight: number;
  family: 'aurora' | 'moonboard';
};

/**
 * Resolve the full set of tappable holds for a board configuration, board-family
 * agnostic. Aurora boards come from the hole-placement pipeline; the MoonBoard
 * grid branch is added alongside MoonBoard create support.
 */
export function getCreateBoardHolds(cfg: {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: number[];
}): CreateBoardHolds | null {
  // MoonBoard uses a separate grid source (getMoonBoardDetails) that already
  // produces the 198 grid holds as {id, cx, cy, r} in board-space pixels.
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
      // Unknown MoonBoard layout — render the unavailable state.
      return null;
    }
  }

  const data = getBoardRenderData(cfg);
  if (!data) return null;
  return {
    holdTargets: data.holdsData.map((hold) => ({ id: hold.id, cx: hold.cx, cy: hold.cy, r: hold.r })),
    boardWidth: data.boardWidth,
    boardHeight: data.boardHeight,
    family: 'aurora',
  };
}
