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

  it('treats both board counts present-but-null as 0 for "boardApp" (no total fallback)', () => {
    // Present NULL is a real zero (the climb has no board-app sync data), not
    // "unknown" — matches the search sort, which never falls back to the total.
    expect(selectSourceCount(fields({ kilter: null, aurora: null, total: 55 }), 'boardApp')).toBe(0);
  });

  it('falls back to the total for "boardApp" only when both board fields are absent', () => {
    expect(selectSourceCount(fields({ kilter: undefined, aurora: undefined, total: 55 }), 'boardApp')).toBe(55);
  });

  it('treats a single null board count as 0, not a fallback', () => {
    // Only one source missing — the other is real signal, so don't fall back.
    expect(selectSourceCount(fields({ kilter: null, aurora: 7 }), 'boardApp')).toBe(7);
    expect(selectSourceCount(fields({ kilter: 9, aurora: null }), 'boardApp')).toBe(9);
  });

  it('returns the Boardsesh count for "boardsesh"', () => {
    expect(selectSourceCount(fields({ boardsesh: 30 }), 'boardsesh')).toBe(30);
  });

  it('treats a present-but-null Boardsesh count as 0 (no total fallback)', () => {
    // NULL means "no Boardsesh senders" (migration 0099 leaves it NULL for
    // climbs with no ticks), so we show 0, never the Aurora-derived total.
    expect(selectSourceCount(fields({ boardsesh: null, total: 42 }), 'boardsesh')).toBe(0);
  });

  it('falls back to the total for "boardsesh" only when the field is absent', () => {
    expect(selectSourceCount(fields({ boardsesh: undefined, total: 42 }), 'boardsesh')).toBe(42);
  });

  it('keeps a real Boardsesh 0 as 0 (no fallback)', () => {
    expect(selectSourceCount(fields({ boardsesh: 0, total: 42 }), 'boardsesh')).toBe(0);
  });
});

describe('boardAppCount', () => {
  it('takes the larger of the two board counts', () => {
    expect(boardAppCount(fields({ kilter: 3, aurora: 8 }))).toBe(8);
  });

  it('treats present-but-null board counts as 0 (no total fallback)', () => {
    expect(boardAppCount(fields({ kilter: null, aurora: null, total: 12 }))).toBe(0);
    expect(boardAppCount(fields({ kilter: 0, aurora: null, total: 12 }))).toBe(0);
  });

  it('falls back to the total only when both fields are absent (undefined)', () => {
    expect(boardAppCount(fields({ kilter: undefined, aurora: undefined, total: 12 }))).toBe(12);
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
