import { describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';

vi.mock('../../graphql/use-active-board', () => ({ useActiveBoard: vi.fn(), useSetActiveBoard: vi.fn() }));

import { boardKeepingLocalAngle } from '../use-apply-changed-board';

const changed = { uuid: 'board-1', layoutId: 8, sizeId: 17, setIds: '26,27', angle: 30 } as UserBoard;

describe('boardKeepingLocalAngle', () => {
  it("keeps the climber's angle on the tilting board they are on", () => {
    const active = { ...changed, layoutId: 1, angle: 50 };
    expect(boardKeepingLocalAngle({ ...changed, isAngleAdjustable: true }, active)).toEqual({
      ...changed,
      isAngleAdjustable: true,
      angle: 50,
    });
  });

  it("takes the new angle on a board that doesn't tilt, where it is part of the setup", () => {
    const board = { ...changed, isAngleAdjustable: false };
    expect(boardKeepingLocalAngle(board, { ...board, angle: 50 })).toBe(board);
  });

  it('takes the board as it is when it is not the active one', () => {
    const board = { ...changed, isAngleAdjustable: true };
    expect(boardKeepingLocalAngle(board, null)).toBe(board);
    expect(boardKeepingLocalAngle(board, { ...board, uuid: 'other', angle: 50 })).toBe(board);
  });
});
