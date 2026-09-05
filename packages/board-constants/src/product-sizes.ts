// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { AURORA_BOARDS, type BoardName } from '@boardsesh/shared-schema';
import { AURORA_PRODUCT_SIZES, IMAGE_FILENAMES, LAYOUTS, SETS } from './generated/product-sizes-data';
import { HOLE_PLACEMENTS, getBoardHolePlacements } from './hole-placements';
import type { HoldTuple, LayoutData, ProductSizeData, SetData, SizeEdges } from './types';

export type { HoldTuple, LayoutData, ProductSizeData, SetData, SizeEdges } from './types';

const MOONBOARD_PRODUCT_SIZES: Record<number, ProductSizeData> = {
  1: {
    id: 1,
    name: 'Standard',
    description: '11x18 Grid',
    edgeLeft: 0,
    edgeRight: 11,
    edgeBottom: 0,
    edgeTop: 18,
    productId: 1,
  },
};

// The two Woods board sizes. Edges are the hold-grid extents: 8x10 is 25 rows of
// at most 21 holds, 12x12 is 31 rows of at most 33. They get distinct product ids
// so size-comparison never treats the smaller board as a crop of the larger one —
// the two sizes number their holds differently and share no hold ids.
const WOODS_PRODUCT_SIZES: Record<number, ProductSizeData> = {
  1: {
    id: 1,
    name: '8 x 10',
    description: '',
    edgeLeft: 0,
    edgeRight: 21,
    edgeBottom: 0,
    edgeTop: 25,
    productId: 1,
  },
  2: {
    id: 2,
    name: '12 x 12',
    description: '',
    edgeLeft: 0,
    edgeRight: 33,
    edgeBottom: 0,
    edgeTop: 31,
    productId: 2,
  },
};

export const PRODUCT_SIZES: Record<BoardName, Record<number, ProductSizeData>> = {
  ...AURORA_PRODUCT_SIZES,
  moonboard: MOONBOARD_PRODUCT_SIZES,
  woods: WOODS_PRODUCT_SIZES,
};

export { LAYOUTS, SETS, IMAGE_FILENAMES, HOLE_PLACEMENTS, getBoardHolePlacements };

// The Kilter Homewall is layout 8 / product 7 in Aurora's data. These gate the
// tall/wide climb filters and the expansion-aware hold filtering, so web,
// mobile, and the db query layer all read the same value from here rather than
// each redefining the magic number.
export const KILTER_HOMEWALL_LAYOUT_ID = 8;
export const KILTER_HOMEWALL_PRODUCT_ID = 7;

// 23/24 are 8x12 Full Ride/Mainline, 25/26 are 10x12 Full Ride/Mainline.
const KILTER_HOMEWALL_TALL_SIZE_ID_SET: ReadonlySet<number> = new Set([23, 24, 25, 26]);

// 21/22 are 10x10 Full Ride/Mainline, 25/26 are 10x12 Full Ride/Mainline,
// and 29 is the 10x10 Auxiliary LED Kit.
const KILTER_HOMEWALL_WIDE_SIZE_ID_SET: ReadonlySet<number> = new Set([21, 22, 25, 26, 29]);

export const isKilterHomewallTallSizeId = (sizeId: number): boolean => KILTER_HOMEWALL_TALL_SIZE_ID_SET.has(sizeId);

export const isKilterHomewallWideSizeId = (sizeId: number): boolean => KILTER_HOMEWALL_WIDE_SIZE_ID_SET.has(sizeId);

export const getSizeEdges = (boardName: BoardName, sizeId: number): SizeEdges | null => {
  const size = PRODUCT_SIZES[boardName]?.[sizeId];
  if (!size) return null;

  return {
    edgeLeft: size.edgeLeft,
    edgeRight: size.edgeRight,
    edgeBottom: size.edgeBottom,
    edgeTop: size.edgeTop,
  };
};

export const getProductSize = (boardName: BoardName, sizeId: number): ProductSizeData | null => {
  return PRODUCT_SIZES[boardName]?.[sizeId] ?? null;
};

export const getLayout = (boardName: BoardName, layoutId: number): LayoutData | null => {
  return LAYOUTS[boardName]?.[layoutId] ?? null;
};

/**
 * Resolve a layout id to its human-readable name (e.g. `1` → "Kilter Board
 * Original"). Returns `''` for an unknown layout, matching web's
 * `boardDetails.layout_name || ''` fallback so analytics `boardLayout`
 * properties carry the same string value on web and mobile.
 *
 * Shared by every call site that reports `boardLayout` to analytics
 * (create-climb events, and the hold/zone filter events) so a numeric layout
 * id is never sent where web sends a name.
 */
export const getLayoutName = (boardName: BoardName, layoutId: number): string => {
  return LAYOUTS[boardName]?.[layoutId]?.name ?? '';
};

export const getAllLayouts = (boardName: BoardName): LayoutData[] => {
  const layouts = LAYOUTS[boardName];
  return layouts ? Object.values(layouts) : [];
};

export const getSizesForLayoutId = (boardName: BoardName, layoutId: number): ProductSizeData[] => {
  const layout = LAYOUTS[boardName]?.[layoutId];
  if (!layout) return [];

  const sizes = PRODUCT_SIZES[boardName];
  return Object.values(sizes).filter((size) => {
    // Basic product ID check
    if (size.productId !== layout.productId) return false;

    // Special filtering for Grasshopper:
    // Hide 'GrandMaster' (id: 1) in favor of 'GrandMaster with Tweeners' (id: 4)
    if (boardName === 'grasshopper' && size.id === 1) return false;

    return true;
  });
};

export const getSizesForProduct = (boardName: BoardName, productId: number): ProductSizeData[] => {
  const sizes = PRODUCT_SIZES[boardName];
  return Object.values(sizes).filter((size) => {
    if (size.productId !== productId) return false;

    // Special filtering for Grasshopper:
    // Hide 'GrandMaster' (id: 1) in favor of 'GrandMaster with Tweeners' (id: 4)
    if (boardName === 'grasshopper' && size.id === 1) return false;

    return true;
  });
};

export type TallWideScope = {
  /** Family size ids strictly narrower than the active size (width axis). */
  narrowerSizeIds: number[];
  /** Family size ids strictly shorter than the active size (height axis). */
  shorterSizeIds: number[];
  /** A narrower family size exists — gates the "wide" filter/chip. */
  hasNarrower: boolean;
  /** A shorter family size exists — gates the "tall" filter/chip. */
  hasShorter: boolean;
};

const EMPTY_TALL_WIDE_SCOPE: TallWideScope = {
  narrowerSizeIds: [],
  shorterSizeIds: [],
  hasNarrower: false,
  hasShorter: false,
};

/**
 * Size-relative "tall"/"wide" scope for a board's active (layout, size), the
 * single source of truth for both filters on every board.
 *
 * A climb is **wide** when it can't be done on any size in the active layout's
 * product family that is narrower than the active size, and **tall** when it
 * can't be done on any shorter one — a caller expresses that as: the climb's
 * `compatible_size_ids` overlaps NONE of the returned `narrowerSizeIds` /
 * `shorterSizeIds`. Both axes are scoped to the active size's product family: a
 * board type can mix products whose coordinate systems differ (so a climb's
 * `compatible_size_ids` may list cross-product sizes that must not leak into the
 * reference set), and every family size class counts — duplicate LED-kit variants
 * (e.g. Kilter Homewall 17/18/19, all 7x10) are all "narrower".
 *
 * `hasNarrower` / `hasShorter` are false when the active size is the
 * narrowest / shortest in its axis — how callers hide the Wide / Tall option so
 * the smallest size never offers a filter that would match nothing. A board with
 * a single size (MoonBoard, Touchstone) yields empty sets on both axes.
 *
 * Width = `edgeRight - edgeLeft`, height = `edgeTop - edgeBottom`.
 */
export const getTallWideScope = (boardName: BoardName, layoutId: number, sizeId: number): TallWideScope => {
  const activeSize = getProductSize(boardName, sizeId);
  const layout = getLayout(boardName, layoutId);
  // A mismatched (layout, size) — a stale/crafted combo whose size belongs to a
  // different product than the layout — has no coherent family; fail closed.
  if (!activeSize || !layout || activeSize.productId !== layout.productId) return EMPTY_TALL_WIDE_SCOPE;

  const activeWidth = activeSize.edgeRight - activeSize.edgeLeft;
  const activeHeight = activeSize.edgeTop - activeSize.edgeBottom;

  // Whole product family (not getSizesForProduct, which drops a Grasshopper
  // duplicate for the picker) — the reference set needs every size class.
  const family = Object.values(PRODUCT_SIZES[boardName] ?? {}).filter((size) => size.productId === layout.productId);

  const narrowerSizeIds = family.filter((size) => size.edgeRight - size.edgeLeft < activeWidth).map((size) => size.id);
  const shorterSizeIds = family.filter((size) => size.edgeTop - size.edgeBottom < activeHeight).map((size) => size.id);

  return {
    narrowerSizeIds,
    shorterSizeIds,
    hasNarrower: narrowerSizeIds.length > 0,
    hasShorter: shorterSizeIds.length > 0,
  };
};

export const getSetsForLayoutAndSize = (boardName: BoardName, layoutId: number, sizeId: number): SetData[] => {
  const key = `${layoutId}-${sizeId}`;
  return SETS[boardName]?.[key] ?? [];
};

export const getDefaultSizeForLayout = (boardName: BoardName, layoutId: number): number | null => {
  const sizes = getSizesForLayoutId(boardName, layoutId);
  return sizes.length > 0 ? sizes[0].id : null;
};

/**
 * Fallback size/set data for orphaned Kilter layouts that are not in the main
 * LAYOUTS config but still have valid product-size associations. These layouts
 * appear in historical user data (logbook ticks, stats) even though they are
 * no longer sold or listed in the Aurora API product-sizes endpoint.
 *
 * Layouts 6 and 7 both correspond to "Orbit" in Aurora's data with identical
 * product-size and set associations. The real distinction between them has
 * not been confirmed (possibly mirror vs spray, or a legacy duplicate); the
 * suffixes exist only to avoid a duplicate label in the UI.
 */
export const ORPHANED_KILTER_LAYOUT_DEFAULTS: Record<number, { name: string; sizeId: number; setIds: string }> = {
  2: { name: 'Kilter JUUL', sizeId: 11, setIds: '21' },
  3: { name: 'Kilter Demo', sizeId: 12, setIds: '22' },
  4: { name: 'Kilter BKB', sizeId: 13, setIds: '23' },
  5: { name: 'Kilter Spire', sizeId: 15, setIds: '24' },
  6: { name: 'Kilter Orbit (v1)', sizeId: 16, setIds: '25' },
  7: { name: 'Kilter Orbit (v2)', sizeId: 16, setIds: '25' },
};

export const getBoardSelectorOptions = () => {
  const layouts: Record<BoardName, { id: number; name: string }[]> = {
    kilter: [],
    tension: [],
    moonboard: [],
    decoy: [],
    touchstone: [],
    grasshopper: [],
    soill: [],
    woods: [],
  };
  const sizes: Record<string, { id: number; name: string; description: string }[]> = {};
  const sets: Record<string, { id: number; name: string }[]> = {};

  for (const boardName of AURORA_BOARDS) {
    layouts[boardName] = getAllLayouts(boardName).map((layout) => ({
      id: layout.id,
      name: layout.name,
    }));

    for (const layout of layouts[boardName]) {
      const layoutSizes = getSizesForLayoutId(boardName, layout.id);
      const sizeKey = `${boardName}-${layout.id}`;
      sizes[sizeKey] = layoutSizes.map((size) => ({
        id: size.id,
        name: size.name,
        description: size.description,
      }));

      for (const size of layoutSizes) {
        const setKey = `${boardName}-${layout.id}-${size.id}`;
        sets[setKey] = getSetsForLayoutAndSize(boardName, layout.id, size.id);
      }
    }
  }

  return { layouts, sizes, sets };
};

export const getImageFilename = (
  boardName: BoardName,
  layoutId: number,
  sizeId: number,
  setId: number,
): string | null => {
  const key = `${layoutId}-${sizeId}-${setId}`;
  return IMAGE_FILENAMES[boardName]?.[key] ?? null;
};

export const getHolePlacements = (boardName: BoardName, layoutId: number, setId: number): HoldTuple[] => {
  const key = `${layoutId}-${setId}`;
  // Load only the requested board's shard (lazily, via getBoardHolePlacements) so
  // selecting a board never evaluates every board's holds. On Hermes this is the
  // difference between a ~30–86 KB per-board eval and a ~200 KB all-boards eval.
  return getBoardHolePlacements(boardName)[key] ?? [];
};
