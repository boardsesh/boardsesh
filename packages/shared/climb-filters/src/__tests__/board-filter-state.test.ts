import { describe, expect, it } from 'vitest';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { hasActiveBoardFilters, mergeBoardFilters, type ClimbBoardFilterState } from '../board-filter-state';
import { countActiveFiltersBeyondGrade } from '../active-filter-count';
import { DEFAULT_CLIMB_FILTER_STATE, normalizeRetiredStatus, type ClimbFilterState } from '../filter-state';

const baseInput: ClimbSearchInput = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 7,
  setIds: '1,20',
  angle: 40,
  page: 0,
  pageSize: 30,
  sortBy: 'ascents',
  sortOrder: 'desc',
};

describe('hasActiveBoardFilters', () => {
  it('is false for the empty default', () => {
    expect(hasActiveBoardFilters({})).toBe(false);
  });

  it('is true for benchmark, holds, zone, or setterId', () => {
    expect(hasActiveBoardFilters({ onlyBenchmarks: true })).toBe(true);
    expect(hasActiveBoardFilters({ holdsFilter: { hold_5: { HAND: 'include' } } })).toBe(true);
    expect(hasActiveBoardFilters({ zoneBox: { edgeLeft: 0, edgeRight: 1, edgeBottom: 0, edgeTop: 1 } })).toBe(true);
    expect(hasActiveBoardFilters({ setterId: 42 })).toBe(true);
  });

  it('ignores an empty holdsFilter object', () => {
    expect(hasActiveBoardFilters({ holdsFilter: {} })).toBe(false);
  });
});

describe('mergeBoardFilters', () => {
  it('returns an unchanged copy when no board filters are active', () => {
    const merged = mergeBoardFilters(baseInput, {});
    expect(merged).toEqual(baseInput);
    expect(merged).not.toBe(baseInput);
  });

  it('folds benchmark / holds / zone+mode / setterId into the input', () => {
    const state: ClimbBoardFilterState = {
      onlyBenchmarks: true,
      holdsFilter: { hold_5: { HAND: 'include' } },
      zoneBox: { edgeLeft: 0, edgeRight: 10, edgeBottom: 0, edgeTop: 10 },
      zoneMode: 'anyHold',
      setterId: 7,
    };
    const merged = mergeBoardFilters(baseInput, state);
    expect(merged.onlyBenchmarks).toBe(true);
    expect(merged.holdsFilter).toEqual(state.holdsFilter);
    expect(merged.zoneBox).toEqual(state.zoneBox);
    expect(merged.zoneMode).toBe('anyHold');
    expect(merged.setterId).toBe(7);
  });

  it('does not set zoneMode when there is no zoneBox', () => {
    const merged = mergeBoardFilters(baseInput, { zoneMode: 'anyHold' });
    expect(merged.zoneBox).toBeUndefined();
    expect(merged.zoneMode).toBeUndefined();
  });
});

describe('countActiveFiltersBeyondGrade', () => {
  const active: ClimbFilterState = { ...DEFAULT_CLIMB_FILTER_STATE };

  it('is zero for the default state and ignores grade', () => {
    expect(countActiveFiltersBeyondGrade(active)).toBe(0);
    expect(countActiveFiltersBeyondGrade({ ...active, minGrade: 18, maxGrade: 20 })).toBe(0);
  });

  it('counts each non-grade climb filter once', () => {
    expect(countActiveFiltersBeyondGrade({ ...active, hideCompleted: true, minRating: 3 })).toBe(2);
    expect(countActiveFiltersBeyondGrade({ ...active, sortBy: 'quality' })).toBe(1);
  });

  it('counts active board filters', () => {
    expect(countActiveFiltersBeyondGrade(active, { onlyBenchmarks: true })).toBe(1);
    expect(countActiveFiltersBeyondGrade({ ...active, minAscents: 10 }, { onlyBenchmarks: true })).toBe(2);
  });

  it('does not double-count a legacy established+minAscents as two', () => {
    // Pre-normalization a legacy state could carry both; after normalization it
    // is a single Popularity lever (minAscents) → count 1, not 2.
    const legacy: ClimbFilterState = { ...active, status: 'established', minAscents: 2 };
    expect(countActiveFiltersBeyondGrade(normalizeRetiredStatus(legacy))).toBe(1);
  });
});

describe('normalizeRetiredStatus', () => {
  it('maps established → any while keeping minAscents', () => {
    const out = normalizeRetiredStatus({ ...DEFAULT_CLIMB_FILTER_STATE, status: 'established', minAscents: 2 });
    expect(out.status).toBe('any');
    expect(out.minAscents).toBe(2);
  });

  it('leaves non-established statuses untouched', () => {
    expect(normalizeRetiredStatus({ ...DEFAULT_CLIMB_FILTER_STATE, status: 'projects' }).status).toBe('projects');
    expect(normalizeRetiredStatus(DEFAULT_CLIMB_FILTER_STATE).status).toBe('any');
  });
});
