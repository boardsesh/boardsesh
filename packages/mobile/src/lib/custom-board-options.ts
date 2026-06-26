import type { BoardName } from '@boardsesh/shared-schema';
import { MOONBOARD_GRID } from '@boardsesh/board-constants/moonboard';
import {
  getAllLayouts,
  getDefaultSizeForLayout,
  getSetsForLayoutAndSize,
  getSizesForLayoutId,
  type LayoutData,
  type ProductSizeData,
  type SetData,
} from '@boardsesh/board-constants/product-sizes';
import {
  getLayoutById,
  MOONBOARD_LAYOUTS,
  MOONBOARD_SETS,
  MOONBOARD_SIZE,
  type MoonBoardLayoutKey,
} from '@boardsesh/board-config';

// Mini boards are hidden from the custom-board picker until their board art exists.
const HIDDEN_CUSTOM_MOONBOARD_LAYOUT_IDS = new Set<number>([
  MOONBOARD_LAYOUTS['mini-moonboard-2020'].id,
  MOONBOARD_LAYOUTS['mini-moonboard-2025'].id,
]);

const MOONBOARD_PRODUCT_SIZE: ProductSizeData = {
  id: MOONBOARD_SIZE.id,
  name: MOONBOARD_SIZE.name,
  description: MOONBOARD_SIZE.description,
  edgeLeft: 0,
  edgeRight: MOONBOARD_GRID.numColumns,
  edgeBottom: 0,
  edgeTop: MOONBOARD_GRID.numRows,
  productId: MOONBOARD_SIZE.id,
};

function getMoonBoardLayoutKey(layoutId: number): MoonBoardLayoutKey | null {
  return (getLayoutById(layoutId)?.[0] as MoonBoardLayoutKey | undefined) ?? null;
}

export function getBoardLayouts(boardName: BoardName): LayoutData[] {
  if (boardName === 'moonboard') {
    return Object.values(MOONBOARD_LAYOUTS)
      .filter((layout) => !HIDDEN_CUSTOM_MOONBOARD_LAYOUT_IDS.has(layout.id))
      .map((layout) => ({
        id: layout.id,
        name: layout.name,
        productId: MOONBOARD_PRODUCT_SIZE.productId,
      }));
  }

  return getAllLayouts(boardName);
}

export function getBoardSizesForLayoutId(boardName: BoardName, layoutId: number): ProductSizeData[] {
  if (boardName === 'moonboard') {
    return getMoonBoardLayoutKey(layoutId) ? [MOONBOARD_PRODUCT_SIZE] : [];
  }

  return getSizesForLayoutId(boardName, layoutId);
}

export function getBoardSetsForLayoutAndSize(boardName: BoardName, layoutId: number, sizeId: number): SetData[] {
  if (boardName === 'moonboard') {
    const layoutKey = getMoonBoardLayoutKey(layoutId);
    if (!layoutKey || sizeId !== MOONBOARD_SIZE.id) return [];
    return MOONBOARD_SETS[layoutKey].map((set) => ({ id: set.id, name: set.name }));
  }

  return getSetsForLayoutAndSize(boardName, layoutId, sizeId);
}

export function getDefaultBoardSizeForLayout(boardName: BoardName, layoutId: number): number | null {
  if (boardName === 'moonboard') {
    return getMoonBoardLayoutKey(layoutId) ? MOONBOARD_SIZE.id : null;
  }

  return getDefaultSizeForLayout(boardName, layoutId);
}
