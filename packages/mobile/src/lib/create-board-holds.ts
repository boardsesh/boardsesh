import type { BoardName } from '@boardsesh/shared-schema';
import type { BoardEdges } from '@boardsesh/climb-filters';
import { WOODS_OCCUPIED_HOLD_IDS } from '@boardsesh/board-constants/woods';
import { woodsSizeIdToDimension } from '@boardsesh/board-config';
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

const woodsOccupiedIdsBySizeId = new Map<number, ReadonlySet<number>>();

/**
 * The mounting slots of a Woods size that actually carry a hold, as a lookup
 * set, or `null` for a size id that is not a Woods board.
 *
 * A Woods hold id is a slot — a T-nut — and roughly a fifth of them carry no
 * hold: 106 of the 485 slots on the 8x10, 169 of the 894 on the 12x12. The
 * geometry tables deliberately keep every slot (a frames string may name any of
 * them, and the renderer falls back to a ring for one it has no silhouette for),
 * so `WOODS_OCCUPIED_HOLD_IDS` is the only thing that separates a hold you can
 * pull on from a bare bolt hole. Aurora and MoonBoard need no equivalent: their
 * placements are holds.
 *
 * Memoized per size id — the tables are static, and this runs on the
 * drawer-open path.
 */
function woodsOccupiedHoldIds(sizeId: number): ReadonlySet<number> | null {
  const cached = woodsOccupiedIdsBySizeId.get(sizeId);
  if (cached) return cached;

  const dimension = woodsSizeIdToDimension(sizeId);
  if (!dimension) return null;

  const occupied = new Set(WOODS_OCCUPIED_HOLD_IDS[dimension]);
  woodsOccupiedIdsBySizeId.set(sizeId, occupied);
  return occupied;
}

type BoardRenderData = NonNullable<ReturnType<typeof getBoardRenderData>>;

/**
 * Narrow a board's render geometry to the holds an editor may make interactive.
 *
 * Only Woods narrows anything: an empty mounting slot must never become a tap
 * target. A dot painted on bare plywood reads as a hold that isn't there
 * (boardsesh/boardsesh#5185), and its hit circle sits in the same nearest-centre
 * partition as the real holds, so it also steals taps aimed at the hold beside
 * it. A size id that is not one of the two Woods boards means the caller
 * resolved this config against some other board: report no holds at all, the way
 * `getWoodsRenderData` rejects a foreign layout id rather than drawing a
 * plausible-looking wall.
 */
function buildCreateBoardHolds(cfg: CreateBoardHoldsConfig, data: BoardRenderData): CreateBoardHolds | null {
  const family = resolveCreateBoardFamily(cfg.boardName);

  let holdsData = data.holdsData;
  if (family === 'woods') {
    const occupiedHoldIds = woodsOccupiedHoldIds(cfg.sizeId);
    if (!occupiedHoldIds) return null;
    holdsData = holdsData.filter((hold) => occupiedHoldIds.has(hold.id));
  }

  return {
    holdTargets: holdsData.map((hold) => ({ id: hold.id, cx: hold.cx, cy: hold.cy, r: hold.r })),
    boardWidth: data.boardWidth,
    boardHeight: data.boardHeight,
    edgeLeft: data.edgeLeft,
    edgeRight: data.edgeRight,
    edgeBottom: data.edgeBottom,
    edgeTop: data.edgeTop,
    family,
  };
}

/**
 * Resolve the set of tappable holds for a board configuration, board-family
 * agnostic. Aurora boards come from the hole-placement pipeline; MoonBoard and
 * Woods come from their code-driven render-data branches. Woods is then narrowed
 * to the slots that actually carry a hold — see {@link buildCreateBoardHolds}.
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
  const result = data ? buildCreateBoardHolds(cfg, data) : null;

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
