import { describe, expect, it } from 'vitest';
import { resolveTickBoardContext } from '../tick-context';

const original = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' };
const homewall = { boardType: 'kilter', layoutId: 8, compatibleSizeIds: [17, 25] };

describe('resolveTickBoardContext', () => {
  it('uses the climb identity even when a queue button passes the active board', () => {
    expect(resolveTickBoardContext(homewall, original, original, 942)).toEqual({ boardName: 'kilter', layoutId: 8 });
  });
  it('does not turn a render fallback into a physical board', () => {
    expect(resolveTickBoardContext(homewall, { ...original, layoutId: 8, sizeId: 17 }, original, 942)).toEqual({
      boardName: 'kilter',
      layoutId: 8,
    });
  });
  it('keeps a compatible wall and rejects same-layout size mismatches', () => {
    const climb = { boardType: 'kilter', layoutId: 1, compatibleSizeIds: [10] };
    expect(resolveTickBoardContext(climb, original, original, 942)).toEqual({ ...original, boardId: 942 });
    expect(resolveTickBoardContext({ ...climb, compatibleSizeIds: [7] }, original, original, 942)).toEqual({
      boardName: 'kilter',
      layoutId: 1,
    });
  });
});
