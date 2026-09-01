/// <reference types="node" />

import { describe, expect, it } from 'vitest';

import {
  baselineTag,
  computeWeekBoundaries,
  latestHistoryTag,
  nextHistoryLayer,
  packObjectsRevListInput,
  parseDateOnlyUTC,
  planCompletedWeeks,
  TOOLCHAIN_STAGE,
  toDateOnlyUTC,
  weekTag,
} from '../ci-image/weekly-packs';

/**
 * scripts/ci-image/weekly-packs.ts is the pure math behind the prebaked CI
 * image's git-history layering (issue #5008). It decides which week a commit
 * falls into, what tag that week gets, and what `git pack-objects --revs`
 * receives on stdin -- get any of these wrong and either a "weekly" pack
 * quietly repacks the whole 340+ MB history, or the freeze chain builds FROM
 * the wrong base image and corrupts the seeded git store.
 *
 * The measured boundaries below (baseline 2026-07-28 -> 2026-08-04,
 * 2026-08-11, 2026-08-18, 2026-08-25, 2026-09-01) are the exact table from
 * the issue, reproduced here as a fixture so this test also documents where
 * those numbers came from.
 */

const MEASURED_BASELINE = '2026-07-28';
const MEASURED_WEEK_ENDS = ['2026-08-04', '2026-08-11', '2026-08-18', '2026-08-25', '2026-09-01'];

describe('parseDateOnlyUTC / toDateOnlyUTC', () => {
  it('round-trips a valid date', () => {
    expect(toDateOnlyUTC(parseDateOnlyUTC('2026-07-28'))).toBe('2026-07-28');
  });

  it('parses as UTC midnight, not local midnight', () => {
    expect(parseDateOnlyUTC('2026-07-28').toISOString()).toBe('2026-07-28T00:00:00.000Z');
  });

  it.each(['2026-7-28', '07-28-2026', '2026/07/28', '2026-07-28T00:00:00Z', 'not-a-date', ''])(
    'rejects %s',
    (input) => {
      expect(() => parseDateOnlyUTC(input)).toThrow();
    },
  );

  it('rejects a calendar date that does not exist', () => {
    // Date() silently rolls Feb 30 forward into March; parseDateOnlyUTC must not.
    expect(() => parseDateOnlyUTC('2026-02-30')).toThrow();
  });
});

describe('computeWeekBoundaries', () => {
  it('reproduces the exact boundaries measured in issue #5008', () => {
    const boundaries = computeWeekBoundaries(parseDateOnlyUTC(MEASURED_BASELINE), parseDateOnlyUTC('2026-09-01'));
    expect(boundaries.map(toDateOnlyUTC)).toEqual(MEASURED_WEEK_ENDS);
  });

  it('is exactly 7 days between consecutive boundaries', () => {
    const boundaries = computeWeekBoundaries(parseDateOnlyUTC('2026-01-01'), parseDateOnlyUTC('2026-03-01'));
    for (let index = 1; index < boundaries.length; index += 1) {
      expect(boundaries[index].getTime() - boundaries[index - 1].getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    }
  });

  it('excludes the baseline date itself (boundaries are strictly after it)', () => {
    const boundaries = computeWeekBoundaries(parseDateOnlyUTC('2026-07-28'), parseDateOnlyUTC('2026-07-28'));
    expect(boundaries).toEqual([]);
  });

  it('includes an asOf that lands exactly on a boundary', () => {
    const boundaries = computeWeekBoundaries(parseDateOnlyUTC('2026-07-28'), parseDateOnlyUTC('2026-08-04'));
    expect(boundaries.map(toDateOnlyUTC)).toEqual(['2026-08-04']);
  });

  it('rejects asOf before baselineDate', () => {
    expect(() => computeWeekBoundaries(parseDateOnlyUTC('2026-08-01'), parseDateOnlyUTC('2026-07-01'))).toThrow();
  });

  it('is NOT calendar weeks -- a re-baselined anchor keeps its own weekday, not Monday', () => {
    // 2026-07-29 is a Wednesday. If this were calendar weeks the first
    // boundary would land on the following Sunday/Monday instead of exactly
    // 7 days later.
    const boundaries = computeWeekBoundaries(parseDateOnlyUTC('2026-07-29'), parseDateOnlyUTC('2026-08-05'));
    expect(boundaries.map(toDateOnlyUTC)).toEqual(['2026-08-05']);
  });
});

describe('baselineTag / weekTag', () => {
  it('formats the baseline tag', () => {
    expect(baselineTag(parseDateOnlyUTC('2026-07-28'))).toBe('baseline-2026-07-28');
  });

  it('formats a week tag', () => {
    expect(weekTag(parseDateOnlyUTC('2026-08-04'))).toBe('week-2026-08-04');
  });
});

describe('planCompletedWeeks', () => {
  it('chains each week to the previous week, and the first week to baseline', () => {
    const plan = planCompletedWeeks(parseDateOnlyUTC(MEASURED_BASELINE), parseDateOnlyUTC('2026-09-01'));
    expect(plan.map((week) => week.tag)).toEqual(MEASURED_WEEK_ENDS.map((date) => `week-${date}`));
    expect(plan[0].historyBaseTag).toBe('baseline-2026-07-28');
    for (let index = 1; index < plan.length; index += 1) {
      expect(plan[index].historyBaseTag).toBe(plan[index - 1].tag);
    }
  });
});

describe('nextHistoryLayer', () => {
  const baselineDate = parseDateOnlyUTC(MEASURED_BASELINE);
  const asOf = parseDateOnlyUTC('2026-09-01');

  it('bootstraps the baseline first when nothing exists yet', () => {
    const layer = nextHistoryLayer(baselineDate, asOf, new Set());
    expect(layer).toEqual({ tag: 'baseline-2026-07-28', historyBaseTag: TOOLCHAIN_STAGE });
  });

  it('does not consider ANY week until the baseline itself exists', () => {
    // Even if every week tag happens to already be present (e.g. stale
    // entries from an abandoned baseline), a missing baseline must still be
    // the very next thing built -- every week ultimately chains back to it.
    const allWeekTags = new Set(MEASURED_WEEK_ENDS.map((date) => `week-${date}`));
    const layer = nextHistoryLayer(baselineDate, asOf, allWeekTags);
    expect(layer?.tag).toBe('baseline-2026-07-28');
  });

  it('finds the earliest missing week once the baseline exists', () => {
    const existing = new Set(['baseline-2026-07-28', 'week-2026-08-04']);
    const layer = nextHistoryLayer(baselineDate, asOf, existing);
    expect(layer).toEqual({ tag: 'week-2026-08-11', historyBaseTag: 'week-2026-08-04' });
  });

  it('returns null once baseline and every completed week exist', () => {
    const existing = new Set(['baseline-2026-07-28', ...MEASURED_WEEK_ENDS.map((date) => `week-${date}`)]);
    expect(nextHistoryLayer(baselineDate, asOf, existing)).toBeNull();
  });

  it('catches up one step at a time after downtime (not a batch)', () => {
    // Simulates the scheduled job having missed several rollovers: only the
    // FIRST missing week should be reported, since freezing must happen in
    // order (later weeks depend on the immediately preceding tag existing).
    const existing = new Set(['baseline-2026-07-28']);
    const layer = nextHistoryLayer(baselineDate, asOf, existing);
    expect(layer?.tag).toBe('week-2026-08-04');
  });
});

describe('latestHistoryTag', () => {
  const baselineDate = parseDateOnlyUTC(MEASURED_BASELINE);
  const asOf = parseDateOnlyUTC('2026-09-01');

  it('falls back to the baseline tag when no week has been frozen yet', () => {
    expect(latestHistoryTag(baselineDate, asOf, new Set(['baseline-2026-07-28']))).toBe('baseline-2026-07-28');
  });

  it('picks the most recently frozen week, not just any frozen week', () => {
    const existing = new Set(['baseline-2026-07-28', 'week-2026-08-04', 'week-2026-08-11']);
    expect(latestHistoryTag(baselineDate, asOf, existing)).toBe('week-2026-08-11');
  });

  it('matches nextHistoryLayer returning null once fully caught up', () => {
    const existing = new Set(['baseline-2026-07-28', ...MEASURED_WEEK_ENDS.map((date) => `week-${date}`)]);
    expect(nextHistoryLayer(baselineDate, asOf, existing)).toBeNull();
    expect(latestHistoryTag(baselineDate, asOf, existing)).toBe('week-2026-09-01');
  });
});

describe('packObjectsRevListInput', () => {
  it('is just the tip, newline-terminated, when nothing is excluded', () => {
    expect(packObjectsRevListInput('abc123', null)).toBe('abc123\n');
  });

  it('prefixes the exclude line with ^, matching git rev-list syntax', () => {
    expect(packObjectsRevListInput('abc123', 'def456')).toBe('abc123\n^def456\n');
  });

  it('rejects an empty tip', () => {
    expect(() => packObjectsRevListInput('', null)).toThrow();
  });

  it('rejects an empty exclude when one was explicitly requested', () => {
    expect(() => packObjectsRevListInput('abc123', '')).toThrow();
  });

  it('matches the exact form issue #5008 specifies: printf "%s\\n^%s\\n"', () => {
    const tip = 'a'.repeat(40);
    const exclude = 'b'.repeat(40);
    expect(packObjectsRevListInput(tip, exclude)).toBe(`${tip}\n^${exclude}\n`);
  });
});
