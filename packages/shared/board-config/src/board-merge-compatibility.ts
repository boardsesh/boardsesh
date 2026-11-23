import { normaliseSetIds } from './set-ids';
export type MergeBoardConfig = { boardType: string; layoutId: number; sizeId: number; setIds: string };
/** Angle is mutable session configuration, never physical-board identity. */
export function boardMergeConfigsCompatible(first: MergeBoardConfig, second: MergeBoardConfig): boolean {
  return (
    first.boardType !== 'spray' &&
    first.boardType === second.boardType &&
    first.sizeId === second.sizeId &&
    normaliseSetIds(first.setIds) === normaliseSetIds(second.setIds) &&
    (first.layoutId === second.layoutId ||
      (first.boardType === 'tension' && [10, 11].includes(first.layoutId) && [10, 11].includes(second.layoutId)))
  );
}
