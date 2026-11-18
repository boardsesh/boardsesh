import { describe, expect, it } from 'vite-plus/test';
import { orderBoardsForPartnerWorkout } from '../partner-workout-board-order';

describe('partner board preference', () => {
  const boards = [
    { uuid: 'tension', boardType: 'tension', angle: 40 },
    { uuid: 'kilter-steep', boardType: 'kilter', angle: 50 },
    { uuid: 'kilter-matching', boardType: 'kilter', angle: 40 },
    { uuid: 'moon', boardType: 'moonboard', angle: 40 },
  ];
  it('ranks matching type and angle first without filtering or mutating server order', () => {
    expect(orderBoardsForPartnerWorkout(boards, { type: 'kilter', angle: 40 }).map((board) => board.uuid)).toEqual([
      'kilter-matching',
      'kilter-steep',
      'tension',
      'moon',
    ]);
    expect(boards[0].uuid).toBe('tension');
  });
  it('preserves existing order with no preference and within equally matching boards', () => {
    expect(orderBoardsForPartnerWorkout(boards, undefined)).toEqual(boards);
    expect(orderBoardsForPartnerWorkout(boards, { type: 'kilter' }).map((board) => board.uuid)).toEqual([
      'kilter-steep',
      'kilter-matching',
      'tension',
      'moon',
    ]);
  });
});
