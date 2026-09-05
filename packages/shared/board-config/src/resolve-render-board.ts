// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Which board configuration should a logged climb be *drawn* on?
 *
 * A tick carries a board type, the climb's layout and an angle — never a size or
 * a hold-set list. Every surface that renders a logged climb (logbook rows, the
 * play drawer, session recaps, profile climb tiles) therefore has to resolve one,
 * and the historical answer on both platforms was "the biggest size this layout
 * comes in". A climber on a 10x12 home wall saw every one of their ascents drawn
 * on a 12x14 commercial board (issue #4221).
 *
 * The ladder below prefers real information over guesses, in order:
 *
 *   1. The board the tick is associated with (`boardsesh_ticks.board_id`). This is
 *      the board it was climbed on — no inference needed.
 *   2. The smallest of the climber's own boards the climb actually fits on. A
 *      climb that fits a small wall fits every bigger one, so the smallest fitting
 *      board is the tightest — and for home-wall climbers, usually the real one.
 *   3. No board of theirs fits: the size closest to their biggest board of that
 *      type, out of the sizes the climb does fit.
 *   4. They have no boards of that type: the layout's biggest size, which is the
 *      pre-#4221 behaviour and the only sensible answer with nothing to go on.
 *
 * Pure and synchronous — the backend resolves it per feed row against the ascent
 * owner's boards (so it is correct for every viewer, not just for yourself), and
 * the clients call the rung-4 wrapper when a payload carries no resolved config.
 */
import {
  getSizesForLayoutId,
  getSetsForLayoutAndSize,
  getAllLayouts,
  getLayout,
  getProductSize,
  ORPHANED_KILTER_LAYOUT_DEFAULTS,
} from '@boardsesh/board-constants/product-sizes';
import { getSizeRank } from '@boardsesh/board-constants/size-comparison';
import type { ProductSizeData } from '@boardsesh/board-constants';
import type { BoardName, RenderBoardConfig } from '@boardsesh/shared-schema';

import { toBoardName } from './board-name';
import { MOONBOARD_LAYOUTS, MOONBOARD_SETS, MOONBOARD_SIZE, type MoonBoardLayoutKey } from './moonboard-config';
import { WOODS_LAYOUTS, WOODS_SETS, WOODS_SIZES } from './woods-config';

/** Woods' one synthetic hold set — every Woods board and climb carries it. */
const WOODS_SET_IDS: number[] = WOODS_SETS.map((woodsSet) => woodsSet.id);
const WOODS_SIZE_IDS = new Set(Object.values(WOODS_SIZES).map((woodsSize) => woodsSize.id));
/** The bigger of the two Woods boards, and the one most of the catalog is set on. */
const WOODS_DEFAULT_SIZE_ID = WOODS_SIZES['12x12'].id;

/**
 * The layout / size / hold sets a climb should be rendered with — the GraphQL
 * `RenderBoardConfig`, owned by `@boardsesh/shared-schema` so the wire type and
 * the resolver's return type can't drift. Re-exported here because this is where
 * callers reach for it. (The dependency only runs this way: `shared-schema` is
 * the base package and must not import back into `board-config`.)
 */
export type { RenderBoardConfig };

/** One of the climber's boards, or the board a tick is associated with. */
export type RenderBoardCandidate = RenderBoardConfig & {
  boardType: string;
  /** Owned boards beat followed ones when several fit equally well. */
  isOwned: boolean;
};

export type ResolveRenderBoardArgs = {
  boardType: string;
  /** The layout the climb was set on (`board_climbs.layout_id`). */
  climbLayoutId: number | null | undefined;
  /**
   * `board_climbs.compatible_size_ids` — every size whose edge box encloses the
   * climb. Null/undefined means "unknown" (MoonBoard, or a climb whose
   * denormalised columns haven't been populated), which imposes no constraint.
   */
  compatibleSizeIds?: readonly number[] | null;
  /** `board_climbs.required_set_ids`; null/undefined imposes no constraint. */
  requiredSetIds?: readonly number[] | null;
  /** The board this tick was logged against, when it has one. */
  tickBoard?: RenderBoardCandidate | null;
  /** Every board the climb's owner has — owned and followed, any type or layout. */
  ownerBoards?: readonly RenderBoardCandidate[];
};

/** Whether a climb fits a board, given whatever denormalised columns we have. */
function climbFitsBoard(
  board: RenderBoardConfig,
  compatibleSizeIds: readonly number[] | null | undefined,
  requiredSetIds: readonly number[] | null | undefined,
): boolean {
  if (compatibleSizeIds != null && !compatibleSizeIds.includes(board.sizeId)) return false;
  if (requiredSetIds != null && requiredSetIds.length > 0) {
    const installed = new Set(board.setIds);
    if (!requiredSetIds.every((setId) => installed.has(setId))) return false;
  }
  return true;
}

/**
 * The sizes of `layoutId` the climb can be drawn on. `compatible_size_ids` is
 * computed across a whole board type, so it can name sizes from another product
 * family (home vs commercial coordinate frames) — intersecting with the layout's
 * own sizes is what keeps a Homewall size out of a Commercial layout's answer.
 * Falls back to every size of the layout when nothing matches, so an unpopulated
 * or cross-frame `compatible_size_ids` degrades to the old guess rather than to
 * no thumbnail at all.
 */
function candidateSizesForLayout(
  boardName: BoardName,
  layoutId: number,
  compatibleSizeIds: readonly number[] | null | undefined,
): ProductSizeData[] {
  const sizes = getSizesForLayoutId(boardName, layoutId);
  if (sizes.length === 0 || compatibleSizeIds == null) return sizes;
  const fitting = sizes.filter((size) => compatibleSizeIds.includes(size.id));
  return fitting.length > 0 ? fitting : sizes;
}

function configForSize(boardName: BoardName, layoutId: number, sizeId: number): RenderBoardConfig | null {
  const sets = getSetsForLayoutAndSize(boardName, layoutId, sizeId);
  if (sets.length === 0) return null;
  return { layoutId, sizeId, setIds: sets.map((set) => set.id) };
}

/**
 * Rung 4 — the no-information default: the layout's biggest size with every set
 * installed. Covers MoonBoard (one fixed size, sets per layout) and the orphaned
 * Kilter layouts 2-7, which have real product-size associations but aren't in the
 * layout tables, so `getSizesForLayoutId` returns nothing for them.
 */
export function getDefaultRenderBoard(
  boardType: string,
  climbLayoutId: number | null | undefined,
): RenderBoardConfig | null {
  const boardName = toBoardName(boardType);
  if (!boardName) return null;

  if (boardName === 'moonboard') {
    const layoutId = climbLayoutId ?? MOONBOARD_LAYOUTS['moonboard-2024'].id;
    const layoutKey = (Object.keys(MOONBOARD_LAYOUTS) as MoonBoardLayoutKey[]).find(
      (key) => MOONBOARD_LAYOUTS[key].id === layoutId,
    );
    if (!layoutKey) return null;
    const sets = MOONBOARD_SETS[layoutKey] ?? [];
    if (sets.length === 0) return null;
    return { layoutId, sizeId: MOONBOARD_SIZE.id, setIds: sets.map((set) => set.id) };
  }

  if (boardName === 'woods') {
    // Woods has one layout, one synthetic hold set, and two sizes that carry no
    // rows in the Aurora product-size tables — so the "biggest size on the
    // layout" walk below has nothing to read. The 12x12 is the no-information
    // default: it is the board the bulk of the catalog is set on.
    return {
      layoutId: climbLayoutId ?? WOODS_LAYOUTS.woods.id,
      sizeId: WOODS_DEFAULT_SIZE_ID,
      setIds: [...WOODS_SET_IDS],
    };
  }

  const layoutId = climbLayoutId ?? getAllLayouts(boardName)[0]?.id;
  if (!layoutId) return null;

  const sizes = getSizesForLayoutId(boardName, layoutId);
  if (sizes.length === 0) {
    // Layouts that no longer appear in the product-size tables but still show up
    // in historical ticks — the reason web used to render no thumbnail at all.
    const orphaned = boardName === 'kilter' ? ORPHANED_KILTER_LAYOUT_DEFAULTS[layoutId] : undefined;
    if (!orphaned) return null;
    const setIds = orphaned.setIds
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((setId) => Number.isInteger(setId));
    return setIds.length > 0 ? { layoutId, sizeId: orphaned.sizeId, setIds } : null;
  }

  const biggest = sizes.reduce((best, size) =>
    getSizeRank(boardName, size.id) > getSizeRank(boardName, best.id) ? size : best,
  );
  return configForSize(boardName, layoutId, biggest.id);
}

/**
 * The Woods rung of the ladder. Woods needs its own because the generic path
 * reads the Aurora product-size tables, which carry no Woods rows: rung 3 can't
 * find a product family to compare sizes in, and rung 4's "biggest size on the
 * layout" walk finds nothing to walk.
 *
 * Size is the whole game here. The two Woods boards number their holds from
 * their own origins — the 8x10 runs 0-484 and the 12x12 runs 0-893 — so an 8x10
 * climb's hold ids all exist on the 12x12 as completely different holds. Drawing
 * one on the other doesn't fail; it silently draws the wrong climb. So every
 * rung that can consult `compatible_size_ids` does, including the tick board:
 * the generic ladder trusts a tick board outright, but a Woods tick board whose
 * size the climb doesn't fit is exactly the case that renders wrong.
 */
function resolveWoodsRenderBoard({
  climbLayoutId,
  compatibleSizeIds,
  tickBoard,
  ownerBoards,
}: Pick<
  ResolveRenderBoardArgs,
  'climbLayoutId' | 'compatibleSizeIds' | 'tickBoard' | 'ownerBoards'
>): RenderBoardConfig | null {
  // Woods has exactly one layout, so an unknown or stale climb/tick layout id
  // resolves to it rather than being echoed back to the caller.
  const layoutId = climbLayoutId ?? WOODS_LAYOUTS.woods.id;
  // An empty `compatible_size_ids` means the same thing as a null one — no
  // compatibility data for this climb (a legacy row, or denormalised columns
  // that haven't been populated yet) — so it imposes no constraint, matching
  // how `candidateSizesForLayout` degrades rather than returning nothing.
  const fitsClimb = (sizeId: number): boolean =>
    WOODS_SIZE_IDS.has(sizeId) &&
    (compatibleSizeIds == null || compatibleSizeIds.length === 0 || compatibleSizeIds.includes(sizeId));

  // 1. The board it was logged on, when the climb actually fits that size.
  if (
    tickBoard &&
    tickBoard.boardType === 'woods' &&
    (climbLayoutId == null || tickBoard.layoutId === climbLayoutId) &&
    fitsClimb(tickBoard.sizeId)
  ) {
    return { layoutId, sizeId: tickBoard.sizeId, setIds: [...WOODS_SET_IDS] };
  }

  // 2. The smallest of their own Woods boards the climb fits on. Owned beats
  //    followed, matching the generic rung 2.
  const fitting = (ownerBoards ?? []).filter(
    (board) => board.boardType === 'woods' && board.layoutId === layoutId && fitsClimb(board.sizeId),
  );
  if (fitting.length > 0) {
    const best = fitting.reduce((smallest, board) => {
      if (board.isOwned !== smallest.isOwned) return board.isOwned ? board : smallest;
      // `getSizeRank` warns it is only meaningful within one `productId`, and the
      // two Woods sizes deliberately carry different ones (D2: distinct product
      // ids stop `size-comparison` treating the 8x10 as a crop of the 12x12).
      // The rank itself is still a pure height/width ordering, so comparing them
      // orders 8x10 (25 rows) below 12x12 (31 rows) — which is all rung 2 needs.
      return getSizeRank('woods', board.sizeId) < getSizeRank('woods', smallest.sizeId) ? board : smallest;
    });
    return { layoutId, sizeId: best.sizeId, setIds: [...WOODS_SET_IDS] };
  }

  // 3. None of theirs fits: draw it on a size the climb is known to fit.
  const firstCompatibleSizeId = compatibleSizeIds?.find((sizeId) => WOODS_SIZE_IDS.has(sizeId));
  if (firstCompatibleSizeId != null) {
    return { layoutId, sizeId: firstCompatibleSizeId, setIds: [...WOODS_SET_IDS] };
  }

  // 4. Nothing known about the climb's size either — the 12x12 default.
  return getDefaultRenderBoard('woods', climbLayoutId);
}

/**
 * Resolve the board configuration a logged climb should be drawn on. See the
 * module comment for the ladder. Returns null only when the board type or layout
 * can't be resolved at all, which callers render as a plain tile.
 */
export function resolveRenderBoard(args: ResolveRenderBoardArgs): RenderBoardConfig | null {
  const { boardType, climbLayoutId, compatibleSizeIds, requiredSetIds, tickBoard, ownerBoards } = args;
  const boardName = toBoardName(boardType);
  if (!boardName) return null;

  if (boardName === 'woods') {
    return resolveWoodsRenderBoard({ climbLayoutId, compatibleSizeIds, tickBoard, ownerBoards });
  }

  // 1. The board it was actually climbed on. A layout mismatch means the tick's
  //    board association is stale or cross-layout, and drawing the climb on it
  //    would place holds that don't exist — fall through instead.
  if (tickBoard && tickBoard.boardType === boardType && tickBoard.setIds.length > 0) {
    if (climbLayoutId == null || tickBoard.layoutId === climbLayoutId) {
      return { layoutId: tickBoard.layoutId, sizeId: tickBoard.sizeId, setIds: tickBoard.setIds };
    }
  }

  const sameLayoutBoards =
    climbLayoutId == null
      ? []
      : (ownerBoards ?? []).filter(
          (board) => board.boardType === boardType && board.layoutId === climbLayoutId && board.setIds.length > 0,
        );

  // 2. The smallest of their own boards the climb fits on. Owned beats followed;
  //    the caller's order (lowest user_boards.id first) breaks remaining ties.
  const fitting = sameLayoutBoards.filter((board) => climbFitsBoard(board, compatibleSizeIds, requiredSetIds));
  if (fitting.length > 0) {
    const best = fitting.reduce((smallest, board) => {
      if (board.isOwned !== smallest.isOwned) return board.isOwned ? board : smallest;
      return getSizeRank(boardName, board.sizeId) < getSizeRank(boardName, smallest.sizeId) ? board : smallest;
    });
    return { layoutId: best.layoutId, sizeId: best.sizeId, setIds: best.setIds };
  }

  // 3. Nothing of theirs fits, but they do climb on this board type: draw it at
  //    the size closest to their biggest board, out of the sizes it fits.
  //    Scoped to the climb layout's product family — home and commercial walls
  //    use different coordinate origins, so their size ranks aren't comparable.
  const climbProductId = climbLayoutId == null ? undefined : getLayout(boardName, climbLayoutId)?.productId;
  const boardsOfType = (ownerBoards ?? []).filter(
    (board) => board.boardType === boardType && getProductSize(boardName, board.sizeId)?.productId === climbProductId,
  );
  if (climbLayoutId != null && climbProductId != null && boardsOfType.length > 0) {
    const biggestOwnedRank = boardsOfType.reduce(
      (rank, board) => Math.max(rank, getSizeRank(boardName, board.sizeId)),
      -1,
    );
    const candidates = candidateSizesForLayout(boardName, climbLayoutId, compatibleSizeIds);
    if (biggestOwnedRank >= 0 && candidates.length > 0) {
      const closest = candidates.reduce((best, size) => {
        const rank = getSizeRank(boardName, size.id);
        const bestRank = getSizeRank(boardName, best.id);
        const delta = Math.abs(rank - biggestOwnedRank);
        const bestDelta = Math.abs(bestRank - biggestOwnedRank);
        // Equally close above and below their biggest — take the bigger size, so
        // the climb is never cropped by a wall it demonstrably doesn't fit.
        if (delta !== bestDelta) return delta < bestDelta ? size : best;
        return rank > bestRank ? size : best;
      });
      const config = configForSize(boardName, climbLayoutId, closest.id);
      if (config) return config;
    }
  }

  // 4. No boards to reason from.
  return getDefaultRenderBoard(boardType, climbLayoutId);
}
