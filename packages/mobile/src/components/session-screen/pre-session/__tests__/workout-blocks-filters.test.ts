import { describe, expect, it } from 'vitest';
import { DEFAULT_VOLUME_OPTIONS } from '@boardsesh/playlist-generator';
import {
  DEFAULT_WORKOUT_FILTERS,
  addBlock,
  filtersOf,
  sameFilters,
  singleBlockSelection,
  updateBlockFilters,
} from '../workout-blocks';

describe('Skip what I have sent and Benchmarks only in block filters', () => {
  it('leaves both off the defaults, so stored default filters are unchanged', () => {
    expect(DEFAULT_WORKOUT_FILTERS).toEqual({
      climbBias: 'unfamiliar',
      minAscents: 5,
      minRating: 2,
      onlyTallClimbs: false,
      onlyWideClimbs: false,
    });
    expect(DEFAULT_WORKOUT_FILTERS).not.toHaveProperty('skipSent');
    expect(DEFAULT_WORKOUT_FILTERS).not.toHaveProperty('onlyBenchmarks');
  });

  it('copies a switch that is on and leaves one that is off', () => {
    const options = { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 18, skipSent: true, onlyBenchmarks: false };
    expect(filtersOf(options)).toEqual({ ...DEFAULT_WORKOUT_FILTERS, skipSent: true });
    expect(singleBlockSelection(options, 'block-0').blocks[0].filters.skipSent).toBe(true);
  });

  it('treats a switch that is absent as off', () => {
    expect(sameFilters(DEFAULT_WORKOUT_FILTERS, { ...DEFAULT_WORKOUT_FILTERS, skipSent: false })).toBe(true);
    expect(sameFilters(DEFAULT_WORKOUT_FILTERS, { ...DEFAULT_WORKOUT_FILTERS, onlyBenchmarks: false })).toBe(true);
    expect(sameFilters(DEFAULT_WORKOUT_FILTERS, { ...DEFAULT_WORKOUT_FILTERS, skipSent: true })).toBe(false);
    expect(sameFilters(DEFAULT_WORKOUT_FILTERS, { ...DEFAULT_WORKOUT_FILTERS, onlyBenchmarks: true })).toBe(false);
  });

  it('changes a block only when a switch really flips', () => {
    const selection = singleBlockSelection({ ...DEFAULT_VOLUME_OPTIONS, targetGrade: 18 }, 'block-0');
    expect(updateBlockFilters(selection, 'block-0', { skipSent: false })).toBe(selection);
    const skipping = updateBlockFilters(selection, 'block-0', { skipSent: true });
    expect(skipping.blocks[0].filters.skipSent).toBe(true);
    expect(updateBlockFilters(skipping, 'block-0', { onlyBenchmarks: true }).blocks[0].filters).toMatchObject({
      skipSent: true,
      onlyBenchmarks: true,
    });
  });

  it('hands both switches on to the next block', () => {
    const selection = updateBlockFilters(
      singleBlockSelection({ ...DEFAULT_VOLUME_OPTIONS, targetGrade: 18 }, 'block-0'),
      'block-0',
      { skipSent: true, onlyBenchmarks: true },
    );
    const added = addBlock(selection, () => 'block-1', 18);
    expect(added.blocks[1].filters).toMatchObject({ skipSent: true, onlyBenchmarks: true });
  });
});
