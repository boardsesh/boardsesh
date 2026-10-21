import { describe, expect, it } from 'vitest';
import { canAdjustBoardAngle } from '../can-adjust-board-angle';

describe('canAdjustBoardAngle', () => {
  it.each([
    ['an adjustable board with an angle', { isAngleAdjustable: true, angle: 40 }, true],
    ['a board that does not say (adjustable by default)', { angle: 40 }, true],
    ['a board whose flag is null (adjustable by default)', { isAngleAdjustable: null, angle: 40 }, true],
    ['a zero-degree board', { isAngleAdjustable: true, angle: 0 }, true],
    ['a fixed-angle wall', { isAngleAdjustable: false, angle: 40 }, false],
    ['a board with no angle yet', { isAngleAdjustable: true, angle: null }, false],
    ['no board', null, false],
    ['a board still loading', undefined, false],
  ] as const)('%s', (_label, board, expected) => {
    expect(canAdjustBoardAngle(board)).toBe(expected);
  });
});
