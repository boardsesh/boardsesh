import type { BoardName } from '@boardsesh/shared-schema';
import type { BoardEdges } from '@boardsesh/climb-filters';
import { getBoardRenderData } from './board-details';

/**
 * The minimal per-hold geometry the interactive editor needs to place a tap
 * target + painted indicator. Both Aurora and MoonBoard render data produce
 * `{id, cx, cy, r}` in board-space pixels, so one editor renders either family.
 */
export type BoardHoldTarget = { id: number; cx: number; cy: number; r: number };

export type CreateBoardHolds = BoardEdges & {
  holdTargets: BoardHoldTarget[];
  boardWidth: number;
  boardHeight: number;
  family: 'aurora' | 'moonboard';
};

type CreateBoardHoldsConfig = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: number[];
};

const CREATE_BOARD_HOLDS_CACHE_LIMIT = 16;
const createBoardHoldsCache = new Map<string, CreateBoardHolds | null>();

function createBoardHoldsCacheKey(cfg: CreateBoardHoldsConfig): string {
  return `${cfg.boardName}-${cfg.layoutId}-${cfg.sizeId}-${cfg.setIds.join(',')}`;
}

/**
 * Parse a comma-separated `setIds` route/param string into numeric set ids.
 * Mirrors the board render pipeline: an empty string yields `[]`, and any
 * `0`/blank token is dropped because set ids are positive.
 */
export function parseSetIdsParam(setIds: string): number[] {
  return setIds.split(',').map(Number).filter(Boolean);
}

/**
 * Resolve the full set of tappable holds for a board configuration,
 * board-family agnostic.
 */
export function getCreateBoardHolds(cfg: CreateBoardHoldsConfig): CreateBoardHolds | null {
  const cacheKey = createBoardHoldsCacheKey(cfg);
  if (createBoardHoldsCache.has(cacheKey)) {
    const cached = createBoardHoldsCache.get(cacheKey) ?? null;
    createBoardHoldsCache.delete(cacheKey);
    createBoardHoldsCache.set(cacheKey, cached);
    return cached;
  }

  const data = getBoardRenderData(cfg);
  const result = data
    ? {
        holdTargets: data.holdsData.map((hold) => ({ id: hold.id, cx: hold.cx, cy: hold.cy, r: hold.r })),
        boardWidth: data.boardWidth,
        boardHeight: data.boardHeight,
        edgeLeft: data.edgeLeft,
        edgeRight: data.edgeRight,
        edgeBottom: data.edgeBottom,
        edgeTop: data.edgeTop,
        family: cfg.boardName === 'moonboard' ? ('moonboard' as const) : ('aurora' as const),
      }
    : null;

  if (createBoardHoldsCache.size >= CREATE_BOARD_HOLDS_CACHE_LIMIT) {
    const oldestKey = createBoardHoldsCache.keys().next().value;
    if (oldestKey !== undefined) createBoardHoldsCache.delete(oldestKey);
  }
  createBoardHoldsCache.set(cacheKey, result);
  return result;
}

export function prewarmCreateBoardHolds(cfg: CreateBoardHoldsConfig): void {
  getCreateBoardHolds(cfg);
}

// @test-only: production code should share the module-level hold geometry cache.
export function clearCreateBoardHoldsCache(): void {
  const isDevRuntime = typeof __DEV__ === 'undefined' || __DEV__;
  if (!isDevRuntime) {
    throw new Error('clearCreateBoardHoldsCache is test-only and cannot run in production.');
  }
  createBoardHoldsCache.clear();
}
