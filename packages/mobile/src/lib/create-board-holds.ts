import type { BoardName } from '@boardsesh/shared-schema';
import type { BoardEdges } from '@boardsesh/climb-filters';
import { getBoardRenderData } from './board-details';

/**
 * The minimal per-hold geometry the interactive editor needs to place a tap
 * target + painted indicator. Aurora (`getBoardRenderData`), MoonBoard
 * (`getMoonBoardDetails`) and Woods (`getWoodsBoardDetails`) all produce
 * `{id, cx, cy, r}` in board-space pixels, so one editor renders any family.
 */
export type BoardHoldTarget = { id: number; cx: number; cy: number; r: number };

/**
 * Which geometry pipeline the hold targets came out of. Aurora holds come from
 * per-set hole placements; MoonBoard and Woods are code-driven, with hold ids
 * numbered from each board's own origin — which is why Woods is its own family
 * rather than another code-driven MoonBoard: an id means a different hold on
 * each of its two sizes (see `canAddClimbToBoard` rule 5).
 */
export type CreateBoardFamily = 'aurora' | 'moonboard' | 'woods';

export type CreateBoardHolds = BoardEdges & {
  holdTargets: BoardHoldTarget[];
  boardWidth: number;
  boardHeight: number;
  family: CreateBoardFamily;
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
 * Mirrors the `split(',').map(Number).filter(Boolean)` pattern the board render
 * pipeline uses (see `use-native-climb-render.ts`): an empty string yields `[]`
 * (not `[0]`), and any `0`/blank token is dropped — set ids are positive.
 */
export function parseSetIdsParam(setIds: string): number[] {
  return setIds.split(',').map(Number).filter(Boolean);
}

function resolveCreateBoardFamily(boardName: BoardName): CreateBoardFamily {
  if (boardName === 'moonboard') return 'moonboard';
  if (boardName === 'woods') return 'woods';
  return 'aurora';
}

/**
 * Resolve the full set of tappable holds for a board configuration, board-family
 * agnostic. Aurora boards come from the hole-placement pipeline; MoonBoard and
 * Woods come from their code-driven render-data branches.
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
        family: resolveCreateBoardFamily(cfg.boardName),
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
