import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import { getBoardCapabilities } from '@boardsesh/board-config';

import { collectionChipLabel } from '../../components/search/FilterChipRow.logic';
import { describeClimbAttributes } from '../../components/climb-attribute-labels';
import { benchmarkAttributeLabel, benchmarkFilterLabel, isVerifiedBoard } from '../benchmark-term';

const echoKey = ((key: string) => key) as unknown as TFunction<'climbs'>;

describe('isVerifiedBoard', () => {
  it.each(['kilter', 'KILTER'])('is true for %s', (boardName) => {
    expect(isVerifiedBoard(boardName)).toBe(true);
  });

  it.each(['tension', 'moonboard', 'decoy', 'grasshopper', 'soill', 'touchstone', 'woods', 'spray', 'nonsense'])(
    'is false for %s',
    (boardName) => {
      expect(isVerifiedBoard(boardName)).toBe(false);
    },
  );

  it.each([[''], [null], [undefined]])('keeps Benchmarks when no single board is known: %j', (boardName) => {
    expect(isVerifiedBoard(boardName)).toBe(false);
  });
});

describe('benchmarkTerm capability', () => {
  it('changes only the word on Kilter, not its other switches', () => {
    expect({ ...getBoardCapabilities('kilter'), benchmarkTerm: 'benchmark' }).toEqual(getBoardCapabilities('tension'));
  });
});

describe('benchmark labels', () => {
  it('names the filter per board', () => {
    expect(benchmarkFilterLabel('kilter', echoKey)).toBe('mobile.filter.verified');
    expect(benchmarkFilterLabel('tension', echoKey)).toBe('mobile.filter.benchmark');
  });

  it('names the mark for screen readers per board', () => {
    expect(benchmarkAttributeLabel('kilter', echoKey)).toBe('mobile.climbRow.verified');
    expect(benchmarkAttributeLabel('tension', echoKey)).toBe('mobile.climbRow.benchmark');
  });

  it('reaches the Collection chip', () => {
    expect(collectionChipLabel('benchmarks', echoKey, false, 'kilter')).toBe('mobile.filter.verified');
    expect(collectionChipLabel('benchmarks', echoKey, false, 'moonboard')).toBe('mobile.filter.benchmark');
    expect(collectionChipLabel('benchmarks', echoKey)).toBe('mobile.filter.benchmark');
  });

  it('reaches the words the player speaks for the row', () => {
    const attributes = { benchmarkDifficulty: '22', characteristics: [] as string[] };
    expect(describeClimbAttributes({ ...attributes, boardName: 'kilter' }, echoKey)).toEqual([
      'mobile.climbRow.verified',
    ]);
    expect(describeClimbAttributes({ ...attributes, boardName: 'tension' }, echoKey)).toEqual([
      'mobile.climbRow.benchmark',
    ]);
  });
});
