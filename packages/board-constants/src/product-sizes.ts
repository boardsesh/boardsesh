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

export const PRODUCT_SIZES: Record<BoardName, Record<number, ProductSizeData>> = {
  ...AURORA_PRODUCT_SIZES,
  moonboard: MOONBOARD_PRODUCT_SIZES,
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
