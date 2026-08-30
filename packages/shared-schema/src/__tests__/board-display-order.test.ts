import { describe, expect, it } from 'vitest';
import { AURORA_BOARDS, BOARD_DISPLAY_ORDER, SUPPORTED_BOARDS } from '../types/board-config';

describe('BOARD_DISPLAY_ORDER', () => {
  it('lists every supported board exactly once', () => {
    // A board added to SUPPORTED_BOARDS but not here would sort behind every
    // named board and land wherever the natural compare put it.
    expect([...BOARD_DISPLAY_ORDER].sort()).toEqual([...SUPPORTED_BOARDS].sort());
    expect(new Set(BOARD_DISPLAY_ORDER).size).toBe(BOARD_DISPLAY_ORDER.length);
  });

  it('leads with the Aurora boards in their own order', () => {
    expect(BOARD_DISPLAY_ORDER.slice(0, AURORA_BOARDS.length)).toEqual([...AURORA_BOARDS]);
  });

  it('supports Quantum without treating it as an Aurora API board', () => {
    expect(SUPPORTED_BOARDS).toContain('quantum');
    expect(BOARD_DISPLAY_ORDER).toContain('quantum');
    expect(AURORA_BOARDS).not.toContain('quantum');
  });

  it('is a different order from SUPPORTED_BOARDS, on purpose', () => {
    // SUPPORTED_BOARDS interleaves moonboard after tension. Deriving the sort
    // order from it would silently move moonboard four places up in every
    // serialised all-boards map.
    expect([...BOARD_DISPLAY_ORDER]).not.toEqual([...SUPPORTED_BOARDS]);
  });
});
