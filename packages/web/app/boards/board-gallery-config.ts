import { getBoardLayouts, getBoardSetsForLayoutAndSize, getBoardSizesForLayoutId } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';

type CatalogBoardName = Exclude<BoardName, 'spray'>;

/** Compare physical catalogue extents, with hold-set coverage breaking equal-area ties. */
export function getLargestGalleryBoardSize(boardName: CatalogBoardName, layoutId: number) {
  const sizes = getBoardSizesForLayoutId(boardName, layoutId);
  const ranked = [...sizes].sort((left, right) => {
    const leftArea = (left.edgeRight - left.edgeLeft) * (left.edgeTop - left.edgeBottom);
    const rightArea = (right.edgeRight - right.edgeLeft) * (right.edgeTop - right.edgeBottom);
    return (
      rightArea - leftArea ||
      getBoardSetsForLayoutAndSize(boardName, layoutId, right.id).length -
        getBoardSetsForLayoutAndSize(boardName, layoutId, left.id).length
    );
  });
  const largest = ranked[0];
  if (!largest) throw new Error(`No gallery board size for ${boardName}/${layoutId}`);
  return largest;
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
