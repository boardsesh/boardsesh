// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { DEFAULT_LOGBOOK_FILTERS, type LogbookFilterState } from '@boardsesh/logbook';
import { countActiveLogbookFilters } from '../use-logbook-search';

const withFilters = (overrides: Partial<LogbookFilterState>): LogbookFilterState => ({
  ...DEFAULT_LOGBOOK_FILTERS,
  ...overrides,
});

describe('countActiveLogbookFilters', () => {
  it('is 0 for the default filters', () => {
    expect(countActiveLogbookFilters(DEFAULT_LOGBOOK_FILTERS)).toBe(0);
  });

  it('counts a narrowed status (sends-only or attempts-only) as one', () => {
    expect(countActiveLogbookFilters(withFilters({ includeAttempts: false }))).toBe(1);
    expect(countActiveLogbookFilters(withFilters({ includeSends: false }))).toBe(1);
  });

  it('counts flash-only as one (the flash+no-sends edge still counts via status)', () => {
    expect(countActiveLogbookFilters(withFilters({ flashOnly: true }))).toBe(1);
    // Sends excluded + flashOnly: status narrowed (1) + flash (1).
    expect(countActiveLogbookFilters(withFilters({ includeSends: false, flashOnly: true }))).toBe(2);
  });

  it('counts a grade bound (min and/or max) as one', () => {
    expect(countActiveLogbookFilters(withFilters({ minGrade: 12 }))).toBe(1);
    expect(countActiveLogbookFilters(withFilters({ minGrade: 12, maxGrade: 20 }))).toBe(1);
  });

  it('counts a date bound as one', () => {
    expect(countActiveLogbookFilters(withFilters({ fromDate: '2026-01-01' }))).toBe(1);
  });

  it('counts the angle range as ONE even when both bounds are narrowed', () => {
    expect(countActiveLogbookFilters(withFilters({ angleRange: [20, 50] }))).toBe(1);
    expect(countActiveLogbookFilters(withFilters({ angleRange: [20, 70] }))).toBe(1);
  });

  it('counts benchmarks-only as one', () => {
    expect(countActiveLogbookFilters(withFilters({ benchmarkOnly: true }))).toBe(1);
  });

  it('sums independent active filters', () => {
    // status (attempts-only) + flash + grade + angle = 4
    expect(
      countActiveLogbookFilters(
        withFilters({ includeAttempts: false, flashOnly: true, minGrade: 12, angleRange: [20, 50] }),
      ),
    ).toBe(4);
  });
});
