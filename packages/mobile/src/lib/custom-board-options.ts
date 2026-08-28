import type { BoardName } from '@boardsesh/shared-schema';
import { MOONBOARD_GRID } from '@boardsesh/board-constants/moonboard';
import {
  getAllLayouts,
  getDefaultSizeForLayout,
  getProductSize,
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
  WOODS_LAYOUTS,
  WOODS_SETS,
  WOODS_SIZES,
  type MoonBoardLayoutKey,
} from '@boardsesh/board-config';

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

// Woods, like MoonBoard, is code-driven: it has no `board_product_sizes_layouts_sets`
// rows, so the generated LAYOUTS/SETS tables are empty for it and the cascade has to
// read the static tables in @boardsesh/board-config. The two sizes DO live in
// PRODUCT_SIZES (they carry real edge extents the renderer needs), so those come
// from getProductSize rather than being rebuilt here.
const WOODS_SIZE_IDS = Object.values(WOODS_SIZES).map((size) => size.id);

// 12x12 is the size most Woods owners have and holds all but 430 of the climbs.
const WOODS_DEFAULT_SIZE_ID = WOODS_SIZES['12x12'].id;

function isWoodsLayoutId(layoutId: number): boolean {
  return layoutId === WOODS_LAYOUTS.woods.id;
}

export function getBoardLayouts(boardName: BoardName): LayoutData[] {
  if (boardName === 'moonboard') {
    return Object.values(MOONBOARD_LAYOUTS).map((layout) => ({
      id: layout.id,
      name: layout.name,
      productId: MOONBOARD_PRODUCT_SIZE.productId,
    }));
  }

  if (boardName === 'woods') {
    return [
      {
        id: WOODS_LAYOUTS.woods.id,
        name: WOODS_LAYOUTS.woods.name,
        productId: WOODS_LAYOUTS.woods.id,
      },
    ];
  }

  return getAllLayouts(boardName);
}

export function getBoardSizesForLayoutId(boardName: BoardName, layoutId: number): ProductSizeData[] {
  if (boardName === 'moonboard') {
    return getMoonBoardLayoutKey(layoutId) ? [MOONBOARD_PRODUCT_SIZE] : [];
  }

  if (boardName === 'woods') {
    if (!isWoodsLayoutId(layoutId)) return [];
    return WOODS_SIZE_IDS.map((sizeId) => getProductSize('woods', sizeId)).filter(
      (size): size is ProductSizeData => size !== null,
    );
  }

  return getSizesForLayoutId(boardName, layoutId);
}

export function getBoardSetsForLayoutAndSize(boardName: BoardName, layoutId: number, sizeId: number): SetData[] {
  if (boardName === 'moonboard') {
    const layoutKey = getMoonBoardLayoutKey(layoutId);
    if (!layoutKey || sizeId !== MOONBOARD_SIZE.id) return [];
    return MOONBOARD_SETS[layoutKey].map((set) => ({ id: set.id, name: set.name }));
  }

  if (boardName === 'woods') {
    if (!isWoodsLayoutId(layoutId) || !WOODS_SIZE_IDS.includes(sizeId)) return [];
    return WOODS_SETS.map((set) => ({ id: set.id, name: set.name }));
  }

  return getSetsForLayoutAndSize(boardName, layoutId, sizeId);
}

export function getDefaultBoardSizeForLayout(boardName: BoardName, layoutId: number): number | null {
  if (boardName === 'moonboard') {
    return getMoonBoardLayoutKey(layoutId) ? MOONBOARD_SIZE.id : null;
  }

  if (boardName === 'woods') {
    return isWoodsLayoutId(layoutId) ? WOODS_DEFAULT_SIZE_ID : null;
  }

  return getDefaultSizeForLayout(boardName, layoutId);
}
