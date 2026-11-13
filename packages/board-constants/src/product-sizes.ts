// Geometry-free catalog metadata is also available as its own package subpath.
export * from './catalog-metadata';
import { getBoardHolePlacements } from './hole-placements';
import type { BoardName } from '@boardsesh/shared-schema';
import type { HoldTuple } from './types';
export type { HoldTuple } from './types';
export { HOLE_PLACEMENTS, getBoardHolePlacements } from './hole-placements';

export const getHolePlacements = (boardName: BoardName, layoutId: number, setId: number): HoldTuple[] => {
  const key = `${layoutId}-${setId}`;
  // Load only the requested board's shard (lazily, via getBoardHolePlacements) so
  // selecting a board never evaluates every board's holds. On Hermes this is the
  // difference between a ~30–86 KB per-board eval and a ~200 KB all-boards eval.
  return getBoardHolePlacements(boardName)[key] ?? [];
};
