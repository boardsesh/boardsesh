import { describe, it, expect } from 'vitest';
import { countActiveFilters, countActiveFiltersBeyondGrade, isGradeFilterActive } from '../active-filter-count';
import { DEFAULT_CLIMB_FILTER_STATE } from '../filter-state';

describe('isGradeFilterActive', () => {
  it('is false for the default state', () => {
    expect(isGradeFilterActive(DEFAULT_CLIMB_FILTER_STATE)).toBe(false);
  });

  it('is true when either grade endpoint is set', () => {
    expect(isGradeFilterActive({ ...DEFAULT_CLIMB_FILTER_STATE, minGrade: 10 })).toBe(true);
    expect(isGradeFilterActive({ ...DEFAULT_CLIMB_FILTER_STATE, maxGrade: 20 })).toBe(true);
  });
});

describe('countActiveFilters', () => {
  it('is 0 for the default state with no grade', () => {
    expect(countActiveFilters(DEFAULT_CLIMB_FILTER_STATE)).toBe(0);
  });

  it('counts an active grade bound as exactly one (single, min-only, max-only, range)', () => {
    expect(countActiveFilters({ ...DEFAULT_CLIMB_FILTER_STATE, minGrade: 10 })).toBe(1);
    expect(countActiveFilters({ ...DEFAULT_CLIMB_FILTER_STATE, maxGrade: 20 })).toBe(1);
    expect(countActiveFilters({ ...DEFAULT_CLIMB_FILTER_STATE, minGrade: 10, maxGrade: 20 })).toBe(1);
  });

  it('adds grade on top of beyond-grade filters', () => {
    const filters = { ...DEFAULT_CLIMB_FILTER_STATE, minGrade: 10, minAscents: 5 };
    expect(countActiveFiltersBeyondGrade(filters)).toBe(1);
    expect(countActiveFilters(filters)).toBe(2);
  });

  it('equals the beyond-grade count when no grade is set', () => {
    const filters = { ...DEFAULT_CLIMB_FILTER_STATE, onlyTallClimbs: true };
    expect(countActiveFilters(filters)).toBe(countActiveFiltersBeyondGrade(filters));
  });

  it('includes board filters alongside grade', () => {
    const filters = { ...DEFAULT_CLIMB_FILTER_STATE, minGrade: 10 };
    expect(countActiveFilters(filters, { onlyBenchmarks: true })).toBe(2);
  });

  it('counts an explicit climb type as one filter', () => {
    expect(countActiveFilters({ ...DEFAULT_CLIMB_FILTER_STATE, boulders: true, routes: false })).toBe(1);
    expect(countActiveFilters({ ...DEFAULT_CLIMB_FILTER_STATE, boulders: false, routes: true })).toBe(1);
  });
});
