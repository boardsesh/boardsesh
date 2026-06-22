import { describe, it, expect } from 'vitest';
import { boardAppCount, isAscentCountSource, selectSourceCount, type AscentCountFields } from '../ascent-count-source';

function fields(overrides: Partial<AscentCountFields> = {}): AscentCountFields {
  return { total: 100, kilter: 60, aurora: 40, boardsesh: 30, ...overrides };
}

describe('selectSourceCount', () => {
  it('returns the combined total for "all"', () => {
    expect(selectSourceCount(fields(), 'all')).toBe(100);
  });

  it('returns max(kilter, aurora) for "boardApp"', () => {
    expect(selectSourceCount(fields({ kilter: 60, aurora: 40 }), 'boardApp')).toBe(60);
    expect(selectSourceCount(fields({ kilter: 12, aurora: 80 }), 'boardApp')).toBe(80);
  });

  it('falls back to the total for "boardApp" when both board counts are null', () => {
    expect(selectSourceCount(fields({ kilter: null, aurora: null, total: 55 }), 'boardApp')).toBe(55);
  });

  it('treats a single null board count as 0, not a fallback', () => {
    // Only one source missing — the other is real signal, so don't fall back.
    expect(selectSourceCount(fields({ kilter: null, aurora: 7 }), 'boardApp')).toBe(7);
    expect(selectSourceCount(fields({ kilter: 9, aurora: null }), 'boardApp')).toBe(9);
  });

  it('returns the Boardsesh count for "boardsesh"', () => {
    expect(selectSourceCount(fields({ boardsesh: 30 }), 'boardsesh')).toBe(30);
  });

  it('falls back to the total for "boardsesh" when the count is null', () => {
    expect(selectSourceCount(fields({ boardsesh: null, total: 42 }), 'boardsesh')).toBe(42);
  });

  it('keeps a real Boardsesh 0 as 0 (no fallback)', () => {
    expect(selectSourceCount(fields({ boardsesh: 0, total: 42 }), 'boardsesh')).toBe(0);
  });
});

describe('boardAppCount', () => {
  it('takes the larger of the two board counts', () => {
    expect(boardAppCount(fields({ kilter: 3, aurora: 8 }))).toBe(8);
  });

  it('falls back to the total only when both are null', () => {
    expect(boardAppCount(fields({ kilter: null, aurora: null, total: 12 }))).toBe(12);
    expect(boardAppCount(fields({ kilter: 0, aurora: null, total: 12 }))).toBe(0);
  });
});

describe('isAscentCountSource', () => {
  it('accepts the three valid sources', () => {
    expect(isAscentCountSource('all')).toBe(true);
    expect(isAscentCountSource('boardApp')).toBe(true);
    expect(isAscentCountSource('boardsesh')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isAscentCountSource('kilter')).toBe(false);
    expect(isAscentCountSource(null)).toBe(false);
    expect(isAscentCountSource(4)).toBe(false);
  });
});
