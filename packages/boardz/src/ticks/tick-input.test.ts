import { describe, expect, it } from 'vitest';
import type { ActiveBoard } from '../board/active-board';
import { buildTickInput, sendStatus } from './tick-input';

const board: ActiveBoard = {
  boardName: 'moonboard',
  layoutId: 2,
  sizeId: 1,
  setIds: [2, 3],
  angle: 40,
  name: 'Home MoonBoard',
  boardUuid: 'board-uuid',
};
const now = new Date('2026-09-29T18:30:00Z');

describe('buildTickInput', () => {
  it('fills a send the way Boardsesh does', () => {
    const input = buildTickInput(
      board,
      { uuid: 'climb-1', benchmark_difficulty: '6B+' },
      { status: 'send', attempts: 3, quality: 4, difficulty: 19, comment: ' heel hook ' },
      now,
    );
    expect(input).toEqual({
      boardType: 'moonboard',
      climbUuid: 'climb-1',
      angle: 40,
      isMirror: false,
      status: 'send',
      attemptCount: 3,
      quality: 4,
      difficulty: 19,
      isBenchmark: true,
      comment: 'heel hook',
      climbedAt: '2026-09-29T18:30:00.000Z',
      layoutId: 2,
      sizeId: 1,
      setIds: '2,3',
      boardUuid: 'board-uuid',
    });
  });

  it('records a flash as one try and leaves unrated fields empty', () => {
    const input = buildTickInput(
      { ...board, boardUuid: undefined },
      { uuid: 'climb-2', benchmark_difficulty: null },
      { status: 'flash', attempts: 4, quality: 0, difficulty: null, comment: '' },
      now,
    );
    expect(input.attemptCount).toBe(1);
    expect(input.quality).toBeNull();
    expect(input.isBenchmark).toBe(false);
    expect('boardUuid' in input).toBe(false);
  });
});

describe('sendStatus', () => {
  it('calls a first-go send a flash only on a new climb', () => {
    expect(sendStatus(false, 1)).toBe('flash');
    expect(sendStatus(true, 1)).toBe('send');
    expect(sendStatus(false, 2)).toBe('send');
  });
});
