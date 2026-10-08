import { accumulateFramesToMaps, parseFramesSegments } from '@boardsesh/board-constants/hold-states';
import type { BoardName } from '@boardsesh/shared-schema';
export type BoardRoleCounts = { starting: number; hand: number; finish: number; foot: number };
/** Describe exactly the painted first snapshot, without counting delta-route ghosts. */
export function boardRoleCounts(board: BoardName, frames: string): BoardRoleCounts {
  const counts: BoardRoleCounts = { starting: 0, hand: 0, finish: 0, foot: 0 };
  const firstSnapshot = parseFramesSegments(frames)[0]?.body ?? '';
  const holds = accumulateFramesToMaps(firstSnapshot, board)[0] ?? {};
  for (const hold of Object.values(holds)) {
    if (hold.state === 'STARTING') counts.starting++;
    else if (hold.state === 'HAND') counts.hand++;
    else if (hold.state === 'FINISH') counts.finish++;
    else if (hold.state === 'FOOT') counts.foot++;
  }
  return counts;
}
