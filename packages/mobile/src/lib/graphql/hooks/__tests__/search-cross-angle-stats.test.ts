import { describe, expect, it } from 'vitest';
import { resolveSearchCrossAngleStats } from '../search-cross-angle-stats';

describe('resolveSearchCrossAngleStats', () => {
  it('lets the flag turn it on for a board that is not angle-bound', () => {
    expect(resolveSearchCrossAngleStats({ boardName: 'kilter' }, false)).toBe(false);
    expect(resolveSearchCrossAngleStats({ boardName: 'kilter' }, true)).toBe(true);
    expect(resolveSearchCrossAngleStats({ boardName: 'kilter', crossAngleStats: true }, false)).toBe(true);
  });

  it('leaves an angle-bound board (Woods) to the switch the climber can see', () => {
    expect(resolveSearchCrossAngleStats({ boardName: 'woods' }, true)).toBe(false);
    expect(resolveSearchCrossAngleStats({ boardName: 'woods', crossAngleStats: true }, false)).toBe(true);
  });
});
