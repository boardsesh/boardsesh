// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, expect, it } from 'vitest';
import {
  buildLogbookListRows,
  dedupeLogbookItems,
  describeLogbookDay,
  logbookDayKey,
  shouldShowLogbookDividers,
  type LogbookDayItem,
} from '../day-rows';
import { toAscentFeedInput } from '../to-ascent-feed-input';
import { DEFAULT_LOGBOOK_FILTERS, DEFAULT_LOGBOOK_SORT } from '../defaults';
import type { LogbookSortState } from '../types';

// Naive-UTC timestamps, the shape `climbed_at` arrives in (no Z suffix). Tests
// run in whatever TZ the runner uses; assertions that depend on the local day
// derive the expected key via logbookDayKey rather than hardcoding it.
function tick(overrides: Partial<LogbookDayItem> & { uuid: string; climbedAt: string }): LogbookDayItem {
  return { status: 'send', difficulty: 10, difficultyName: 'V4', ...overrides };
}

const NOON = 'T12:00:00';

describe('shouldShowLogbookDividers', () => {
  it('shows dividers for the recent preset and custom date sorts only', () => {
    expect(shouldShowLogbookDividers({ sortBy: 'recent' })).toBe(true);
    expect(shouldShowLogbookDividers({ sortBy: 'date' })).toBe(true);
    expect(shouldShowLogbookDividers({ sortBy: 'hardest' })).toBe(false);
    expect(shouldShowLogbookDividers({ sortBy: 'climbName' })).toBe(false);
    expect(shouldShowLogbookDividers({ sortBy: 'attemptCount' })).toBe(false);
  });

  // Roundtrip through the real feed-input builder so a rename of the sortBy
  // value the backend expects can't silently kill dividers for one sort mode
  // while the direct-string assertions above stay green.
  it('agrees with toAscentFeedInput for every logbook sort mode', () => {
    const customDateSort: LogbookSortState = {
      mode: 'custom',
      preset: 'recent',
      primaryField: 'date',
      primaryDirection: 'desc',
      secondaryField: '',
      secondaryDirection: 'desc',
    };
    const inputFor = (sort: LogbookSortState) =>
      toAscentFeedInput({ filters: DEFAULT_LOGBOOK_FILTERS, sort, name: '' });

    expect(shouldShowLogbookDividers(inputFor(DEFAULT_LOGBOOK_SORT))).toBe(true);
    expect(shouldShowLogbookDividers(inputFor(customDateSort))).toBe(true);
    expect(shouldShowLogbookDividers(inputFor({ ...DEFAULT_LOGBOOK_SORT, preset: 'hardest' }))).toBe(false);
    expect(shouldShowLogbookDividers(inputFor({ ...customDateSort, primaryField: 'loggedGrade' }))).toBe(false);
    // A climb-name search filters without re-sorting — dividers stay.
    expect(
      shouldShowLogbookDividers(
        toAscentFeedInput({ filters: DEFAULT_LOGBOOK_FILTERS, sort: DEFAULT_LOGBOOK_SORT, name: 'purple' }),
      ),
    ).toBe(true);
  });
});

describe('buildLogbookListRows', () => {
  it('groups consecutive same-day items under one divider', () => {
    const rows = buildLogbookListRows(
      [
        tick({ uuid: 'a', climbedAt: `2026-06-30${NOON}` }),
        tick({ uuid: 'b', climbedAt: `2026-06-30${NOON}` }),
        tick({ uuid: 'c', climbedAt: `2026-06-29${NOON}` }),
      ],
      { hasMore: false },
    );
    expect(rows.map((row) => row.type)).toEqual(['divider', 'entry', 'entry', 'divider', 'entry']);
    expect(rows[0].key).toBe(`day-${logbookDayKey(`2026-06-30${NOON}`)}`);
  });

  it('dedupes duplicate uuids across page boundaries before grouping', () => {
    const rows = buildLogbookListRows(
      [
        tick({ uuid: 'a', climbedAt: `2026-06-30${NOON}` }),
        tick({ uuid: 'a', climbedAt: `2026-06-30${NOON}` }),
        tick({ uuid: 'b', climbedAt: `2026-06-30${NOON}` }),
      ],
      { hasMore: false },
    );
    const entryKeys = rows.filter((row) => row.type === 'entry').map((row) => row.key);
    expect(entryKeys).toEqual(['a', 'b']);
  });

  it('withholds stats from the oldest loaded day while more pages remain', () => {
    const rows = buildLogbookListRows(
      [tick({ uuid: 'a', climbedAt: `2026-06-30${NOON}` }), tick({ uuid: 'b', climbedAt: `2026-06-29${NOON}` })],
      { hasMore: true },
    );
    const dividers = rows.filter((row) => row.type === 'divider');
    expect(dividers[0].stats).not.toBeNull(); // bounded by the day change below it
    expect(dividers[1].stats).toBeNull(); // could straddle the next page
  });

  it('completes the last day when the feed is exhausted', () => {
    const rows = buildLogbookListRows([tick({ uuid: 'a', climbedAt: `2026-06-30${NOON}` })], { hasMore: false });
    const [divider] = rows;
    if (divider.type !== 'divider') throw new Error('expected divider first');
    expect(divider.stats).toEqual({ climbCount: 1, sendCount: 1, topDifficulty: 10, topDifficultyName: 'V4' });
  });

  it('counts flashes as sends and picks the hardest send for the rollup', () => {
    const rows = buildLogbookListRows(
      [
        tick({ uuid: 'a', climbedAt: `2026-06-30${NOON}`, status: 'flash', difficulty: 12, difficultyName: 'V5' }),
        tick({ uuid: 'b', climbedAt: `2026-06-30${NOON}`, status: 'send', difficulty: 18, difficultyName: 'V8' }),
        // Hard PROJECT must not win the "top send" slot.
        tick({ uuid: 'c', climbedAt: `2026-06-30${NOON}`, status: 'attempt', difficulty: 25, difficultyName: 'V11' }),
      ],
      { hasMore: false },
    );
    const [divider] = rows;
    if (divider.type !== 'divider') throw new Error('expected divider first');
    expect(divider.stats).toEqual({ climbCount: 3, sendCount: 2, topDifficulty: 18, topDifficultyName: 'V8' });
  });

  it('falls back to the consensus grade for ungraded sends in the rollup', () => {
    const rows = buildLogbookListRows(
      [
        tick({
          uuid: 'a',
          climbedAt: `2026-06-30${NOON}`,
          difficulty: null,
          difficultyName: null,
          consensusDifficulty: 15,
          consensusDifficultyName: 'V6',
        }),
      ],
      { hasMore: false },
    );
    const [divider] = rows;
    if (divider.type !== 'divider') throw new Error('expected divider first');
    expect(divider.stats?.topDifficultyName).toBe('V6');
  });

  it('keeps divider keys unique if a day recurs non-contiguously (defensive)', () => {
    const rows = buildLogbookListRows(
      [
        tick({ uuid: 'a', climbedAt: `2026-06-30${NOON}` }),
        tick({ uuid: 'b', climbedAt: `2026-06-29${NOON}` }),
        tick({ uuid: 'c', climbedAt: `2026-06-30${NOON}` }),
      ],
      { hasMore: false },
    );
    const dividerKeys = rows.filter((row) => row.type === 'divider').map((row) => row.key);
    expect(new Set(dividerKeys).size).toBe(dividerKeys.length);
  });

  it('groups ascending (date-asc custom sort) input the same way — direction-agnostic', () => {
    const rows = buildLogbookListRows(
      [
        tick({ uuid: 'a', climbedAt: `2026-06-29${NOON}` }),
        tick({ uuid: 'b', climbedAt: `2026-06-30${NOON}` }),
        tick({ uuid: 'c', climbedAt: `2026-06-30${NOON}` }),
      ],
      { hasMore: true },
    );
    expect(rows.map((row) => row.type)).toEqual(['divider', 'entry', 'divider', 'entry', 'entry']);
    const dividers = rows.filter((row) => row.type === 'divider');
    // The LAST loaded run may straddle the next page regardless of direction.
    expect(dividers[0].stats).not.toBeNull();
    expect(dividers[1].stats).toBeNull();
  });

  it('returns no rows for an empty list', () => {
    expect(buildLogbookListRows([], { hasMore: false })).toEqual([]);
  });
});

describe('buildLogbookListRows — wall context', () => {
  const at = (uuid: string, wall?: string) => tick({ uuid, climbedAt: `2026-06-30${NOON}`, wall });

  it("puts a uniform COMPLETE day's wall on the divider and covers its rows", () => {
    const rows = buildLogbookListRows([at('a', 'Kilter 40°'), at('b', 'Kilter 40°')], { hasMore: false });
    const [divider, ...entries] = rows;
    if (divider.type !== 'divider') throw new Error('expected divider');
    expect(divider.wallLabel).toBe('Kilter 40°');
    expect(entries.every((row) => row.type === 'entry' && row.wallCovered)).toBe(true);
  });

  it('withholds the wall from an incomplete uniform day and leaves rows uncovered', () => {
    const rows = buildLogbookListRows([at('a', 'Kilter 40°')], { hasMore: true });
    const [divider, entry] = rows;
    if (divider.type !== 'divider' || entry.type !== 'entry') throw new Error('unexpected shape');
    expect(divider.wallLabel).toBeNull();
    expect(entry.wallCovered).toBe(false);
  });

  it('splits a mixed day with subdividers at wall changes, covering labelled rows', () => {
    const rows = buildLogbookListRows([at('a', 'Kilter 40°'), at('b', 'Kilter 40°'), at('c', 'Tension 45°')], {
      hasMore: false,
    });
    expect(rows.map((row) => row.type)).toEqual(['divider', 'subdivider', 'entry', 'entry', 'subdivider', 'entry']);
    const divider = rows[0];
    if (divider.type !== 'divider') throw new Error('expected divider');
    expect(divider.wallLabel).toBeNull();
    const subLabels = rows.filter((row) => row.type === 'subdivider').map((row) => row.wallLabel);
    expect(subLabels).toEqual(['Kilter 40°', 'Tension 45°']);
  });

  it('gives unlabelled segments in a mixed day no anchor and no coverage', () => {
    const rows = buildLogbookListRows([at('a', 'Kilter 40°'), at('b')], { hasMore: false });
    expect(rows.map((row) => row.type)).toEqual(['divider', 'subdivider', 'entry', 'entry']);
    const uncovered = rows.find((row) => row.type === 'entry' && row.item.uuid === 'b');
    if (uncovered?.type !== 'entry') throw new Error('expected entry');
    expect(uncovered.wallCovered).toBe(false);
  });

  it('keeps wall-less days exactly as before (no subdividers, no coverage)', () => {
    const rows = buildLogbookListRows([at('a'), at('b')], { hasMore: false });
    expect(rows.map((row) => row.type)).toEqual(['divider', 'entry', 'entry']);
    const [divider] = rows;
    if (divider.type !== 'divider') throw new Error('expected divider');
    expect(divider.wallLabel).toBeNull();
  });
});

describe('describeLogbookDay', () => {
  const now = new Date(2026, 5, 30, 15, 0, 0).getTime(); // local Jun 30 2026, 3pm

  it('classifies today / yesterday / this-year / older against the injected now', () => {
    const dayMs = (year: number, monthIndex: number, day: number) => new Date(year, monthIndex, day).getTime();
    expect(describeLogbookDay(dayMs(2026, 5, 30), now).kind).toBe('today');
    expect(describeLogbookDay(dayMs(2026, 5, 29), now).kind).toBe('yesterday');
    expect(describeLogbookDay(dayMs(2026, 2, 14), now).kind).toBe('thisYear');
    expect(describeLogbookDay(dayMs(2025, 11, 31), now).kind).toBe('older');
  });
});

describe('parseTickTimeLocal parity', () => {
  // day-rows deliberately inlines the naive-UTC parse instead of depending on
  // @boardsesh/profile-stats (dep-weight); this pins the two implementations
  // together so a change to the canonical helper can't silently diverge the
  // logbook's day buckets.
  // Covers the naive shape climbed_at normally arrives in AND a Z-suffixed
  // string, so the two parsers can't diverge on either form.
  it('cuts the same local day as profile-stats parseTickTime', async () => {
    const { parseTickTime } = await import('@boardsesh/profile-stats');
    for (const climbedAt of ['2026-06-30T23:30:00', '2026-06-30T00:15:00', '2026-01-01T12:00:00.000Z']) {
      expect(logbookDayKey(climbedAt)).toBe(parseTickTime(climbedAt).format('YYYY-MM-DD'));
    }
  });
});

describe('dedupeLogbookItems', () => {
  it('keeps first occurrence order', () => {
    const items = [
      tick({ uuid: 'a', climbedAt: `2026-06-30${NOON}` }),
      tick({ uuid: 'b', climbedAt: `2026-06-30${NOON}` }),
      tick({ uuid: 'a', climbedAt: `2026-06-29${NOON}` }),
    ];
    expect(dedupeLogbookItems(items).map((item) => item.uuid)).toEqual(['a', 'b']);
  });
});
