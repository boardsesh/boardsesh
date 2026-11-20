import { describe, expect, it } from 'vitest';
import { isBoardTypeVisible, QUANTUM_BOARD_FLAG } from '../board-visibility';

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
});
