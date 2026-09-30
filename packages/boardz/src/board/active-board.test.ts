import { describe, expect, it } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import {
  boardFromAccount,
  createBoard,
  defaultAngle,
  describeBoard,
  isActiveBoard,
  toSearchConfig,
  type ActiveBoard,
} from './active-board';

// MoonBoard 2016 (layout 2) with Hold Set A (2) and Hold Set B (3), per
// @boardsesh/board-config's MOONBOARD_LAYOUTS / MOONBOARD_SETS.
const moonboard2016: ActiveBoard = {
  boardName: 'moonboard',
  layoutId: 2,
  sizeId: 1,
  setIds: [2, 3],
  angle: 40,
  name: 'Home MoonBoard',
};

function userBoard(overrides: Partial<UserBoard>): UserBoard {
  return {
    uuid: 'board-uuid',
    slug: 'home',
    ownerId: 'user-1',
    boardType: 'moonboard',
    layoutId: 2,
    sizeId: 1,
    setIds: '3,2',
    name: 'Home MoonBoard',
    isPublic: false,
    isUnlisted: false,
    hideLocation: true,
    isOwned: true,
    angle: 25,
    isAngleAdjustable: false,
    createdAt: '2026-01-01T00:00:00Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    ...overrides,
  };
}

describe('active board', () => {
  it('describes a MoonBoard by version and hold sets', () => {
    expect(describeBoard({ ...moonboard2016, name: 'Home wall' })).toBe('MoonBoard 2016 · Hold Set A, Hold Set B');
  });

  it("doesn't repeat the version when the board is named after it", () => {
    expect(describeBoard({ ...moonboard2016, name: 'MoonBoard 2016' })).toBe('Hold Set A, Hold Set B');
  });

  it('names a new MoonBoard after its version without repeating the brand', () => {
    const board = createBoard({ boardName: 'moonboard', layoutId: 2, sizeId: 1, setIds: [3, 2], angle: 40 });
    expect(board.name).toBe('MoonBoard 2016');
    expect(board.setIds).toEqual([2, 3]);
  });

  it('starts MoonBoard at 40 degrees, one of its two catalogue angles', () => {
    expect(defaultAngle('moonboard')).toBe(40);
  });

  it('turns an account board into an active board with sorted sets', () => {
    expect(boardFromAccount(userBoard({}))).toEqual({
      boardName: 'moonboard',
      layoutId: 2,
      sizeId: 1,
      setIds: [2, 3],
      angle: 25,
      name: 'Home MoonBoard',
      boardUuid: 'board-uuid',
    });
  });

  it('skips account boards it cannot use', () => {
    expect(boardFromAccount(userBoard({ boardType: 'spray' }))).toBeNull();
    expect(boardFromAccount(userBoard({ boardType: 'not-a-board' }))).toBeNull();
    expect(boardFromAccount(userBoard({ setIds: '' }))).toBeNull();
  });

  it('builds the climb search config with comma-joined sets', () => {
    expect(toSearchConfig(moonboard2016)).toEqual({
      boardName: 'moonboard',
      layoutId: 2,
      sizeId: 1,
      setIds: '2,3',
      angle: 40,
    });
  });

  it('only accepts well-formed stored boards', () => {
    expect(isActiveBoard(moonboard2016)).toBe(true);
    expect(isActiveBoard({ ...moonboard2016, boardName: 'unknown' })).toBe(false);
    expect(isActiveBoard({ ...moonboard2016, setIds: ['2'] })).toBe(false);
    expect(isActiveBoard(null)).toBe(false);
  });
});
