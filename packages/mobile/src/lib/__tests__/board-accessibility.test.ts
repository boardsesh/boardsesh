import { describe, expect, it } from 'vitest';
import { boardRoleCounts } from '../board-accessibility';
describe('board screen-reader summary', () => {
  it('counts each painted role using the board-specific role map', () => {
    expect(boardRoleCounts('kilter', 'p10r12p20r13p30r14p40r15')).toEqual({ starting: 1, hand: 1, finish: 1, foot: 1 });
    expect(boardRoleCounts('tension', 'p10r1p20r2p30r3p40r4')).toEqual({ starting: 1, hand: 1, finish: 1, foot: 1 });
  });
  it('describes the displayed snapshot, excluding later route changes', () => {
    expect(boardRoleCounts('kilter', 'p10r12,"x10p20r14')).toEqual({ starting: 1, hand: 0, finish: 0, foot: 0 });
  });
  it('does not announce off or unknown roles as usable holds', () => {
    expect(boardRoleCounts('kilter', '')).toEqual({ starting: 0, hand: 0, finish: 0, foot: 0 });
  });
});
