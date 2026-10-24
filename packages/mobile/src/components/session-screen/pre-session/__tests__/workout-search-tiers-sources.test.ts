import { describe, expect, it, vi } from 'vitest';
import { CLIMB_BIAS_OPTIONS, type ClimbBias } from '@boardsesh/playlist-generator';

vi.mock('expo-crypto', () => ({ randomUUID: () => 'qi-0' }));

import { DEFAULT_WORKOUT_FILTERS } from '../workout-blocks';
import { fetchFilters, filtersSignature, type PreviewFilters } from '../workout-preview-pool';
import {
  biasCanSkipSent,
  biasCanSkipTried,
  biasDropsFloors,
  biasNeedsSignIn,
  searchTiers,
  tierAscentStatus,
} from '../workout-search-tiers';

const filtersFor = (climbBias: ClimbBias, extra: Partial<PreviewFilters> = {}): PreviewFilters => ({
  ...DEFAULT_WORKOUT_FILTERS,
  climbBias,
  ...extra,
});

const BOTH_SKIPS = { skipSent: true, skipTried: true } as const;

describe('Sent: climbs you have sent at this angle', () => {
  it('is one search, whatever the skip switches say', () => {
    for (const extra of [{}, { skipSent: true }, { skipTried: true }, BOTH_SKIPS]) {
      expect(searchTiers(filtersFor('sent', extra), true)).toEqual([{ showOnlyCompleted: true }]);
    }
  });

  it('marks every climb it finds sent, before the logbook loads', () => {
    expect(tierAscentStatus(filtersFor('sent'), 0)).toBe('send');
  });

  it('takes neither skip switch', () => {
    expect(biasCanSkipSent('sent')).toBe(false);
    expect(biasCanSkipTried('sent')).toBe(false);
  });
});

describe('Liked: climbs you have hearted', () => {
  it('is one search, narrowed by each skip switch', () => {
    expect(searchTiers(filtersFor('liked'), true)).toEqual([{ onlyFavorited: true }]);
    expect(searchTiers(filtersFor('liked', { skipSent: true }), true)).toEqual([
      { onlyFavorited: true, hideCompleted: true },
    ]);
    // Skip what I've tried wins: it leaves out sent climbs too.
    expect(searchTiers(filtersFor('liked', BOTH_SKIPS), true)).toEqual([
      { onlyFavorited: true, hideAttempted: true, hideCompleted: true },
    ]);
  });

  it('marks nothing: a liked climb may be new, tried or sent', () => {
    expect(tierAscentStatus(filtersFor('liked'), 0)).toBeNull();
    expect(tierAscentStatus(filtersFor('liked', { skipSent: true }), 0)).toBeNull();
  });

  it('takes both skip switches', () => {
    expect(biasCanSkipSent('liked')).toBe(true);
    expect(biasCanSkipTried('liked')).toBe(true);
  });
});

describe('which biases drop the crowd floors', () => {
  it('is Sent and Liked; Attempted keeps them, as it always did', () => {
    expect(CLIMB_BIAS_OPTIONS.filter(biasDropsFloors)).toEqual(['sent', 'liked']);
  });

  it('needs an account for every bias but Any, which reads no logbook or hearts', () => {
    expect(CLIMB_BIAS_OPTIONS.filter(biasNeedsSignIn)).toEqual(['unfamiliar', 'attempted', 'sent', 'liked']);
  });

  it('offers every bias on the picker, Sent and Liked between Attempted and Any', () => {
    expect(CLIMB_BIAS_OPTIONS).toEqual(['unfamiliar', 'attempted', 'sent', 'liked', 'any']);
  });
});

describe('fetchFilters for your own climbs', () => {
  it('drops min ascents and min rating, so a climb you liked counts whatever the crowd made of it', () => {
    expect(fetchFilters(filtersFor('liked'), true)).toEqual(filtersFor('liked', { minAscents: 0, minRating: 0 }));
    expect(fetchFilters(filtersFor('sent', { minAscents: 100, minRating: 4 }), true)).toEqual(
      filtersFor('sent', { minAscents: 0, minRating: 0 }),
    );
  });

  it('keeps the filters that are not crowd floors', () => {
    const liked = filtersFor('liked', { onlyBenchmarks: true, onlyTallClimbs: true, skipSent: true });
    expect(fetchFilters(liked, true)).toEqual({ ...liked, minAscents: 0, minRating: 0 });
  });

  it('drops the skip switches Sent cannot take', () => {
    expect(fetchFilters(filtersFor('sent', BOTH_SKIPS), true)).toEqual(
      filtersFor('sent', { minAscents: 0, minRating: 0 }),
    );
  });

  it("keeps Attempted's request the one it always sent: the block's floors, then Skip what I've sent", () => {
    const attempted = filtersFor('attempted', { minAscents: 50, minRating: 3 });
    expect(fetchFilters(attempted, true)).toBe(attempted);
    // Tried but not sent is Attempted with Skip what I've sent, floors and all.
    const triedNotSent = filtersFor('attempted', { minAscents: 50, minRating: 3, skipSent: true });
    expect(fetchFilters(triedNotSent, true)).toBe(triedNotSent);
    expect(searchTiers(triedNotSent, true)).toEqual([{ showOnlyAttempted: true, hideCompleted: true }]);
    expect(tierAscentStatus(triedNotSent, 0)).toBe('attempt');
  });

  it('hands back the same filters when there is nothing to drop', () => {
    const liked = filtersFor('liked', { minAscents: 0, minRating: 0, skipTried: true });
    expect(fetchFilters(liked, true)).toBe(liked);
    const unfamiliar = filtersFor('unfamiliar', { skipSent: true });
    expect(fetchFilters(unfamiliar, true)).toBe(unfamiliar);
  });

  it('shares one pool between two liked blocks that differ only in the floors they do not apply', () => {
    const strict = fetchFilters(filtersFor('liked', { minAscents: 100, minRating: 3 }), true);
    const loose = fetchFilters(filtersFor('liked', { minAscents: 1 }), true);
    expect(filtersSignature(strict)).toBe(filtersSignature(loose));
    expect(filtersSignature(strict)).not.toBe(filtersSignature(fetchFilters(filtersFor('sent'), true)));
  });

  it('falls back to any climb signed out, floors and all, with no logbook or likes to read', () => {
    for (const climbBias of ['sent', 'liked'] as const) {
      const signedOut = fetchFilters(filtersFor(climbBias, BOTH_SKIPS), false);
      expect(signedOut).toEqual(filtersFor('any'));
      expect(searchTiers(signedOut, false)).toEqual([{}]);
      expect(searchTiers(filtersFor(climbBias), false)).toEqual([{}]);
    }
  });
});
