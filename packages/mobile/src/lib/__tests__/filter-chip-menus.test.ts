import { describe, expect, it } from 'vitest';
import {
  POPULARITY_BUCKETS,
  RATING_BUCKETS,
  applyPopularityBucket,
  popularityFromTag,
  popularityTag,
  ratingFromTag,
  ratingTag,
} from '../filter-chip-menus';

describe('popularity tag round-trip', () => {
  it('maps every bucket to a tag and back', () => {
    for (const bucket of POPULARITY_BUCKETS) {
      expect(popularityFromTag(popularityTag(bucket))).toBe(bucket);
    }
  });

  it('uses "any" for the undefined bucket', () => {
    expect(popularityTag(undefined)).toBe('any');
    expect(popularityFromTag('any')).toBeUndefined();
  });
});

describe('applyPopularityBucket conflict-clear', () => {
  it('sets minAscents without touching a non-conflicting status', () => {
    expect(applyPopularityBucket({ status: 'any' }, 100)).toEqual({ minAscents: 100 });
    expect(applyPopularityBucket({ status: 'established' }, 10)).toEqual({ minAscents: 10 });
  });

  it('resets projects/drafts status to any when a bucket is set', () => {
    expect(applyPopularityBucket({ status: 'projects' }, 100)).toEqual({ minAscents: 100, status: 'any' });
    expect(applyPopularityBucket({ status: 'drafts' }, 2)).toEqual({ minAscents: 2, status: 'any' });
  });

  it('does not reset status when clearing the bucket (Any)', () => {
    expect(applyPopularityBucket({ status: 'projects' }, undefined)).toEqual({ minAscents: undefined });
  });
});

describe('rating tag round-trip', () => {
  it('maps every bucket to a tag and back', () => {
    for (const bucket of RATING_BUCKETS) {
      expect(ratingFromTag(ratingTag(bucket))).toBe(bucket);
    }
  });

  it('uses "any" for the undefined bucket', () => {
    expect(ratingTag(undefined)).toBe('any');
    expect(ratingFromTag('any')).toBeUndefined();
  });

  it('offers the 2–5 star buckets', () => {
    expect(RATING_BUCKETS).toEqual([undefined, 2, 3, 4, 5]);
  });
});
