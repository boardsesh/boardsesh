import { describe, it, expect } from 'vitest';
import { toAscentFeedInput } from '../to-ascent-feed-input';
import { sanitizeLogbookFilters, sanitizeLogbookSort } from '../sanitize';
import { DEFAULT_LOGBOOK_FILTERS, DEFAULT_LOGBOOK_SORT } from '../defaults';
import type { LogbookFilterState, LogbookSortState } from '../types';

describe('toAscentFeedInput', () => {
  it('Latest preset -> recent desc, with default filters omitted', () => {
    const input = toAscentFeedInput({ filters: DEFAULT_LOGBOOK_FILTERS, sort: DEFAULT_LOGBOOK_SORT });
    expect(input.sortBy).toBe('recent');
    expect(input.sortOrder).toBe('desc');
    expect(input.statusMode).toBe('both');
    expect(input.flashOnly).toBe(false);
    expect(input.minDifficulty).toBeUndefined();
    expect(input.maxDifficulty).toBeUndefined();
    expect(input.minAngle).toBeUndefined();
    expect(input.maxAngle).toBeUndefined();
    expect(input.climbName).toBeUndefined();
    expect(input.benchmarkOnly).toBeUndefined();
  });

  it('Hardest preset -> sortBy hardest (resolver expands to consensus -> effective -> date)', () => {
    const input = toAscentFeedInput({
      filters: DEFAULT_LOGBOOK_FILTERS,
      sort: { ...DEFAULT_LOGBOOK_SORT, preset: 'hardest' },
    });
    expect(input.sortBy).toBe('hardest');
    expect(input.sortOrder).toBe('desc');
    expect(input.secondarySortBy).toBeUndefined();
  });

  it('maps status, flash, grade range, angle, dates, benchmark, and trims name', () => {
    const filters: LogbookFilterState = {
      includeSends: true,
      includeAttempts: false,
      flashOnly: true,
      minGrade: 12,
      maxGrade: 20,
      fromDate: '2026-01-01',
      toDate: '2026-02-01',
      angleRange: [20, 50],
      benchmarkOnly: true,
    };
    const input = toAscentFeedInput({ filters, sort: DEFAULT_LOGBOOK_SORT, name: '  crimp  ' });
    expect(input.statusMode).toBe('send');
    expect(input.flashOnly).toBe(true);
    expect(input.minDifficulty).toBe(12);
    expect(input.maxDifficulty).toBe(20);
    expect(input.fromDate).toBe('2026-01-01');
    expect(input.toDate).toBe('2026-02-01');
    expect(input.minAngle).toBe(20);
    expect(input.maxAngle).toBe(50);
    expect(input.benchmarkOnly).toBe(true);
    expect(input.climbName).toBe('crimp');
  });

  it('forces flashOnly off when sends are excluded (attempts only)', () => {
    const filters: LogbookFilterState = {
      ...DEFAULT_LOGBOOK_FILTERS,
      includeSends: false,
      includeAttempts: true,
      flashOnly: true,
    };
    const input = toAscentFeedInput({ filters, sort: DEFAULT_LOGBOOK_SORT });
    expect(input.statusMode).toBe('attempt');
    expect(input.flashOnly).toBe(false);
  });

  it('custom sort passes primary + secondary through verbatim', () => {
    const sort: LogbookSortState = {
      mode: 'custom',
      preset: 'recent',
      primaryField: 'loggedGrade',
      primaryDirection: 'desc',
      secondaryField: 'consensusGrade',
      secondaryDirection: 'asc',
    };
    const input = toAscentFeedInput({ filters: DEFAULT_LOGBOOK_FILTERS, sort });
    expect(input.sortBy).toBe('loggedGrade');
    expect(input.sortOrder).toBe('desc');
    expect(input.secondarySortBy).toBe('consensusGrade');
    expect(input.secondarySortOrder).toBe('asc');
  });

  it('single board -> boardType; multiple -> boardTypes; layoutIds pass through', () => {
    const single = toAscentFeedInput({
      filters: DEFAULT_LOGBOOK_FILTERS,
      sort: DEFAULT_LOGBOOK_SORT,
      boardTypes: ['kilter'],
    });
    expect(single.boardType).toBe('kilter');
    expect(single.boardTypes).toBeUndefined();

    const multi = toAscentFeedInput({
      filters: DEFAULT_LOGBOOK_FILTERS,
      sort: DEFAULT_LOGBOOK_SORT,
      boardTypes: ['kilter', 'tension'],
      layoutIds: [1, 8],
    });
    expect(multi.boardTypes).toEqual(['kilter', 'tension']);
    expect(multi.boardType).toBeUndefined();
    expect(multi.layoutIds).toEqual([1, 8]);
  });
});

describe('sanitizeLogbookFilters', () => {
  it('returns defaults for non-object input', () => {
    expect(sanitizeLogbookFilters(null)).toEqual(DEFAULT_LOGBOOK_FILTERS);
    expect(sanitizeLogbookFilters('nope')).toEqual(DEFAULT_LOGBOOK_FILTERS);
  });

  it('clamps the angle range to 0..70 and keeps min <= max', () => {
    expect(sanitizeLogbookFilters({ angleRange: [-10, 200] }).angleRange).toEqual([0, 70]);
    expect(sanitizeLogbookFilters({ angleRange: [50, 20] }).angleRange).toEqual([50, 50]);
  });

  it('keeps at least one status on and clears flashOnly without sends', () => {
    const both = sanitizeLogbookFilters({ includeSends: false, includeAttempts: false });
    expect(both.includeSends).toBe(true);
    const attemptsOnly = sanitizeLogbookFilters({ includeSends: false, includeAttempts: true, flashOnly: true });
    expect(attemptsOnly.flashOnly).toBe(false);
  });

  it('drops non-numeric grades to unset', () => {
    expect(sanitizeLogbookFilters({ minGrade: 'x' }).minGrade).toBe('');
    expect(sanitizeLogbookFilters({ minGrade: 12 }).minGrade).toBe(12);
  });

  it('heals an inverted grade range by swapping min and max', () => {
    const healed = sanitizeLogbookFilters({ minGrade: 20, maxGrade: 12 });
    expect(healed.minGrade).toBe(12);
    expect(healed.maxGrade).toBe(20);
  });

  it('keeps valid ISO dates but rejects malformed or impossible ones', () => {
    expect(sanitizeLogbookFilters({ fromDate: '2026-01-15' }).fromDate).toBe('2026-01-15');
    expect(sanitizeLogbookFilters({ fromDate: 'not-a-date' }).fromDate).toBe('');
    expect(sanitizeLogbookFilters({ fromDate: '01/15/2026' }).fromDate).toBe('');
    expect(sanitizeLogbookFilters({ toDate: '2026-13-40' }).toDate).toBe('');
  });
});

describe('sanitizeLogbookSort', () => {
  it('falls back to the recent preset for invalid input', () => {
    expect(sanitizeLogbookSort(undefined)).toEqual(DEFAULT_LOGBOOK_SORT);
    expect(sanitizeLogbookSort({ preset: 'bogus' }).preset).toBe('recent');
  });

  it('preserves a valid custom sort', () => {
    const sort = sanitizeLogbookSort({
      mode: 'custom',
      primaryField: 'attemptCount',
      primaryDirection: 'asc',
      secondaryField: 'date',
    });
    expect(sort.mode).toBe('custom');
    expect(sort.primaryField).toBe('attemptCount');
    expect(sort.primaryDirection).toBe('asc');
    expect(sort.secondaryField).toBe('date');
  });
});
