import type { ProductSizeData } from '@boardsesh/board-constants/product-sizes';
import { getBoardLayouts, getBoardSetsForLayoutAndSize, getBoardSizesForLayoutId } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';

type CatalogBoardName = Exclude<BoardName, 'spray'>;

export function getGalleryBoardMeasurements(size: ProductSizeData) {
  const { edgeLeft, edgeRight, edgeBottom, edgeTop } = size;
  if (edgeLeft == null || edgeRight == null || edgeBottom == null || edgeTop == null) return null;
  return { physicalWidth: edgeRight - edgeLeft, physicalHeight: edgeTop - edgeBottom };
}

/** Compare physical catalogue extents, with hold-set coverage breaking equal-area ties. */
export function getLargestGalleryBoardSize(boardName: CatalogBoardName, layoutId: number) {
  const sizes = getBoardSizesForLayoutId(boardName, layoutId).flatMap((size) => {
    const measurements = getGalleryBoardMeasurements(size);
    return measurements ? [{ size, area: measurements.physicalWidth * measurements.physicalHeight }] : [];
  });
  const ranked = sizes.sort((left, right) => {
    return (
      right.area - left.area ||
      getBoardSetsForLayoutAndSize(boardName, layoutId, right.size.id).length -
        getBoardSetsForLayoutAndSize(boardName, layoutId, left.size.id).length
    );
  });
  const largest = ranked[0];
  if (!largest) throw new Error(`No gallery board size for ${boardName}/${layoutId}`);
  return largest.size;
}

export function getOrderedGalleryLayouts(boardName: CatalogBoardName) {
  const layouts = getBoardLayouts(boardName);
  if (boardName === 'tension') {
    const generation = (name: string) => Number(name.match(/Board (\d+)/)?.[1] ?? 1);
    return [...layouts].sort((left, right) => generation(right.name) - generation(left.name));
  }
  if (boardName === 'moonboard') {
    const year = (name: string) => Number(name.match(/\b(?:19|20)\d{2}\b/)?.[0] ?? 0);
    return [...layouts].sort((left, right) => year(right.name) - year(left.name));
  }
  return layouts;
}
