import { summarizeActiveHolds, type ActiveHoldRole } from '@boardsesh/play-view';
import type { BoardName } from '@boardsesh/shared-schema';
export type BoardRoleCounts = { starting: number; hand: number; finish: number; foot: number };
const COUNT_KEY_BY_ROLE: Record<ActiveHoldRole, keyof BoardRoleCounts> = {
  STARTING: 'starting',
  HAND: 'hand',
  FINISH: 'finish',
  FOOT: 'foot',
};
/** Describe exactly the painted first snapshot, without counting delta-route ghosts. */
export function boardRoleCounts(board: BoardName, frames: string): BoardRoleCounts {
  const counts: BoardRoleCounts = { starting: 0, hand: 0, finish: 0, foot: 0 };
  for (const group of summarizeActiveHolds(board, frames).groups) counts[COUNT_KEY_BY_ROLE[group.role]] = group.count;
  return counts;
}
