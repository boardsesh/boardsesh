import type { MoonBoardHoldsInput, LitUpHoldsMap } from '@boardsesh/shared-schema';
import { holdIdToCoordinate } from './moonboard-config';

/**
 * Convert an editor `LitUpHoldsMap` (numeric hold ids → role) into the grid
 * coordinate buckets the save mutation expects (`{start, hand, finish}` of
 * "A5"-style coordinates). Shared by the web create form, the web MoonBoard
 * edit modal, and the React Native MoonBoard editor.
 */
export function convertLitUpHoldsMapToMoonBoardHolds(litUpHoldsMap: LitUpHoldsMap): MoonBoardHoldsInput {
  const holds: MoonBoardHoldsInput = {
    start: [],
    hand: [],
    finish: [],
  };

  const sortedEntries = Object.entries(litUpHoldsMap).sort(([a], [b]) => Number(a) - Number(b));

  for (const [holdId, hold] of sortedEntries) {
    const coord = holdIdToCoordinate(Number(holdId));

    if (hold.state === 'STARTING') {
      holds.start.push(coord);
    } else if (hold.state === 'HAND') {
      holds.hand.push(coord);
    } else if (hold.state === 'FINISH') {
      holds.finish.push(coord);
    }
  }

  return holds;
}
