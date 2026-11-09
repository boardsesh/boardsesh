import { describe, expect, it } from 'vite-plus/test';
import { MAX_SWEEP_BATCHES_PER_ROUND, selectSweepBatches } from '../websocket/admission-sweep-batches';

describe('selectSweepBatches', () => {
  it('returns nothing for no batches', () => {
    expect(selectSweepBatches([], 3)).toEqual({ roundBatches: [], nextOffset: 0 });
  });

  it('checks every batch in one round when they fit', () => {
    const { roundBatches } = selectSweepBatches(['a', 'b', 'c'], 0);
    expect(roundBatches).toEqual(['a', 'b', 'c']);
  });

  it('never starts more than the round limit', () => {
    const batches = Array.from({ length: MAX_SWEEP_BATCHES_PER_ROUND + 3 }, (_unused, index) => index);
    expect(selectSweepBatches(batches, 0).roundBatches).toHaveLength(MAX_SWEEP_BATCHES_PER_ROUND);
  });

  it('reaches every batch across rounds instead of starving the later ones', () => {
    const batches = Array.from({ length: 10 }, (_unused, index) => index);
    const seen = new Set<number>();
    let offset = 0;
    for (let round = 0; round < 3; round += 1) {
      const { roundBatches, nextOffset } = selectSweepBatches(batches, offset);
      for (const batch of roundBatches) seen.add(batch);
      offset = nextOffset;
    }
    expect([...seen].sort((first, second) => first - second)).toEqual(batches);
  });
});
