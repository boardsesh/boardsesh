import { getBoardLayouts, getBoardSetsForLayoutAndSize, getBoardSizesForLayoutId } from '../board-catalogue-cascade';
import { describe, expect, it } from 'vitest';
import { QUANTUM_BOARD_FLAG } from '../board-capabilities';
import { getBoardLaunchFlags, isBoardConfigVisible, isBoardTypeVisible } from '../board-visibility';

describe('board launch visibility', () => {
  it.each([undefined, false, 'true', 1])('requires an explicit boolean opt-in (%s)', (enabled) => {
    expect(isBoardTypeVisible('quantum', { [QUANTUM_BOARD_FLAG]: enabled })).toBe(false);
    expect(isBoardTypeVisible('kilter', { [QUANTUM_BOARD_FLAG]: enabled })).toBe(true);
  });
  it('opens Quantum without changing the other board families', () => {
    expect(isBoardTypeVisible('quantum', { [QUANTUM_BOARD_FLAG]: true })).toBe(true);
    expect(isBoardTypeVisible('quantum')).toBe(false);
    expect(isBoardTypeVisible('spray')).toBe(true);
  });
  it.each([undefined, null, '', ' ', 1])('declines a malformed cached board type (%j)', (boardType) => {
    expect(isBoardTypeVisible(boardType, { [QUANTUM_BOARD_FLAG]: true })).toBe(false);
  });
  it('fits the mobile launch-flag bitmask', () => {
    // packages/mobile/src/hooks/use-board-visibility.ts packs one bit per launch
    // flag into a 32-bit integer (`1 << 32 === 1`), so too many flags would alias.
    expect(
      getBoardLaunchFlags().length,
      'Over 31 launch flags: launch a board, or replace the bitmask in mobile use-board-visibility.ts',
    ).toBeLessThanOrEqual(31);
  });
});

describe('Quantum board configurations', () => {
  const enabled = { [QUANTUM_BOARD_FLAG]: true };
  it.each([
    [9101, 9201],
    [9101, 9202],
    [9101, 9203],
    [9104, 9204],
  ])('recognizes released layout %s and size %s', (layoutId, sizeId) => {
    const board = { boardName: 'quantum', layoutId, sizeId, setIds: '1' };
    expect(isBoardConfigVisible(board, enabled)).toBe(true);
    expect(isBoardConfigVisible(board)).toBe(false);
    expect(isBoardConfigVisible(board, { [QUANTUM_BOARD_FLAG]: 'tester' })).toBe(false);
    expect(isBoardConfigVisible({ ...board, setIds: [1] }, enabled)).toBe(true);
  });

  it.each([
    [9105, 9205, '1'],
    [9101, 9204, '1'],
    [9104, 9203, '1'],
    [9101, 9201, '1,2'],
  ] as const)('rejects unavailable configuration %s/%s/%s even with the flag enabled', (layoutId, sizeId, setIds) => {
    expect(isBoardConfigVisible({ boardType: 'quantum', layoutId, sizeId, setIds }, enabled)).toBe(false);
  });

  it('offers Standard and S Fitness in the setup cascade', () => {
    expect(getBoardLayouts('quantum').map((layout) => layout.id)).toEqual([9101, 9104]);
    expect(getBoardSizesForLayoutId('quantum', 9101).map((size) => size.id)).toEqual([9201, 9202, 9203]);
    expect(getBoardSizesForLayoutId('quantum', 9104).map((size) => size.id)).toEqual([9204]);
    expect(getBoardSizesForLayoutId('quantum', 9105)).toEqual([]);
    expect(getBoardSetsForLayoutAndSize('quantum', 9105, 9205)).toEqual([]);
  });
});
