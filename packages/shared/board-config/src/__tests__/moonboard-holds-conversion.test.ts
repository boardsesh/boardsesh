import { describe, expect, it } from 'vitest';
import type { LitUpHoldsMap } from '@boardsesh/shared-schema';
import {
  convertLitUpHoldsMapToMoonBoardHolds,
  coordinateToHoldId,
  encodeMoonBoardHoldsToFrames,
  type MoonBoardCoordinate,
} from '../moonboard-config';

const START = { state: 'STARTING', color: '#00FF00', displayColor: '#44FF44' } as const;
const HAND = { state: 'HAND', color: '#0000FF', displayColor: '#4444FF' } as const;
const FINISH = { state: 'FINISH', color: '#FF0000', displayColor: '#FF3333' } as const;
const FOOT = { state: 'FOOT', color: '#FFAA00', displayColor: '#FFBB44' } as const;
const AUX = { state: 'AUX', color: '#FFE066', displayColor: '#FFE066' } as const;

function holdId(coordinate: MoonBoardCoordinate): number {
  return coordinateToHoldId(coordinate);
}

describe('convertLitUpHoldsMapToMoonBoardHolds', () => {
  it('lists each role bottom row first, then left to right, whatever order the map holds', () => {
    const holdsMap: LitUpHoldsMap = {
      [holdId('J18')]: FINISH,
      [holdId('I14')]: HAND,
      [holdId('H13')]: HAND,
      [holdId('K8')]: HAND,
      [holdId('F10')]: HAND,
      [holdId('F8')]: HAND,
      [holdId('B5')]: START,
    };
    expect(convertLitUpHoldsMapToMoonBoardHolds(holdsMap)).toEqual({
      start: ['B5'],
      hand: ['F8', 'K8', 'F10', 'H13', 'I14'],
      finish: ['J18'],
    });
  });

  it('leaves out foot, AUX and empty roles', () => {
    const holdsMap: LitUpHoldsMap = {
      [holdId('A1')]: FOOT,
      [holdId('C3')]: AUX,
      [holdId('D4')]: HAND,
    };
    expect(convertLitUpHoldsMapToMoonBoardHolds(holdsMap)).toEqual({ start: [], hand: ['D4'], finish: [] });
    expect(convertLitUpHoldsMapToMoonBoardHolds({})).toEqual({ start: [], hand: [], finish: [] });
  });

  it('inverts encodeMoonBoardHoldsToFrames', () => {
    const holds = { start: ['A5', 'C5'], hand: ['E9', 'G12'], finish: ['K18'] };
    const frames = encodeMoonBoardHoldsToFrames(holds);
    const holdsMap: LitUpHoldsMap = {};
    for (const match of frames.matchAll(/p(\d+)r(\d+)/g)) {
      const roleCode = Number(match[2]);
      holdsMap[Number(match[1])] = roleCode === 42 ? START : roleCode === 43 ? HAND : FINISH;
    }
    expect(convertLitUpHoldsMapToMoonBoardHolds(holdsMap)).toEqual(holds);
  });
});
