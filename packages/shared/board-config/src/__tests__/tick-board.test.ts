import { describe, expect, it } from 'vitest';
import { canAttributeTickToBoard } from '../tick-board';

const climb = { boardType: 'kilter', layoutId: 8, compatibleSizeIds: [17, 23, 25], requiredSetIds: [26, 27] };
const board = { boardType: 'kilter', layoutId: 8, sizeId: 17, setIds: '27,26' };

describe('physical tick attribution', () => {
  it('accepts compatible sizes and installed set supersets in any order', () => {
    expect(canAttributeTickToBoard(climb, board)).toBe(true);
    expect(canAttributeTickToBoard(climb, { ...board, sizeId: 25, setIds: '29,28,27,26' })).toBe(true);
  });
  it.each([
    { ...board, boardType: 'tension' },
    { ...board, layoutId: 1 },
    { ...board, sizeId: 10 },
    { ...board, setIds: '26' },
  ])('rejects an impossible wall: %j', (candidate) => {
    expect(canAttributeTickToBoard(climb, candidate)).toBe(false);
  });
  it('does not invent an association for an unknown climb', () => {
    expect(canAttributeTickToBoard(null, board)).toBe(false);
    expect(canAttributeTickToBoard({ boardType: 'kilter' }, board)).toBe(false);
  });
  it('allows missing compatibility measurements when identity is known', () => {
    expect(canAttributeTickToBoard({ boardType: 'kilter', layoutId: 8 }, board)).toBe(true);
  });
});
