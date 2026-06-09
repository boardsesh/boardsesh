import type { BoardName } from '@boardsesh/shared-schema';
import type { BoardEdges } from '@boardsesh/climb-filters';
import { getBoardRenderData } from './board-details';

/**
 * The minimal per-hold geometry the interactive editor needs to place a tap
 * target + painted indicator. Both Aurora (`getBoardRenderData`) and MoonBoard
 * (`getMoonBoardDetails`, added in the MoonBoard PR) already produce
 * `{id, cx, cy, r}` in board-space pixels, so one editor renders either family.
 */
export type BoardHoldTarget = { id: number; cx: number; cy: number; r: number };

export type CreateBoardHolds = BoardEdges & {
  holdTargets: BoardHoldTarget[];
  boardWidth: number;
  boardHeight: number;
  family: 'aurora' | 'moonboard';
};

/**
 * Parse a comma-separated `setIds` route/param string into numeric set ids.
 * Mirrors the `split(',').map(Number).filter(Boolean)` pattern the board render
 * pipeline uses (see `use-native-climb-render.ts`): an empty string yields `[]`
 * (not `[0]`), and any `0`/blank token is dropped — set ids are positive.
 */
export function parseSetIdsParam(setIds: string): number[] {
  return setIds.split(',').map(Number).filter(Boolean);
}

/**
 * Resolve the full set of tappable holds for a board configuration, board-family
 * agnostic. Aurora boards come from the hole-placement pipeline; MoonBoard comes
 * from the grid-backed render data branch.
 */
export function getCreateBoardHolds(cfg: {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: number[];
}): CreateBoardHolds | null {
  const data = getBoardRenderData(cfg);
  if (!data) return null;
  return {
    holdTargets: data.holdsData.map((hold) => ({ id: hold.id, cx: hold.cx, cy: hold.cy, r: hold.r })),
    boardWidth: data.boardWidth,
    boardHeight: data.boardHeight,
    edgeLeft: data.edgeLeft,
    edgeRight: data.edgeRight,
    edgeBottom: data.edgeBottom,
    edgeTop: data.edgeTop,
    family: cfg.boardName === 'moonboard' ? 'moonboard' : 'aurora',
  };
}
