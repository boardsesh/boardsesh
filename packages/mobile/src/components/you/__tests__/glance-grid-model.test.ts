import { describe, it, expect } from 'vitest';
import type { RawProjectingStats } from '@boardsesh/profile-stats';
import { resolveBiggestFightTile, deltaKind } from '../glance-grid-model';

function projecting(overrides: Partial<RawProjectingStats> = {}): RawProjectingStats {
  return {
    buckets: [
      { key: '1', label: '1', value: 0 },
      { key: '2-5', label: '2–5', value: 0 },
      { key: '6-20', label: '6–20', value: 0 },
      { key: '20+', label: '20+', value: 0 },
    ],
    biggestProject: null,
    unlocked: false,
    ...overrides,
  };
}

describe('resolveBiggestFightTile', () => {
  it('shows the biggest project when unlocked', () => {
    const tile = resolveBiggestFightTile(
      projecting({ unlocked: true, biggestProject: { climbUuid: 'c1', tries: 27, difficulty: 22, label: 'V6' } }),
      300,
    );
    expect(tile).toEqual({ kind: 'fight', tries: 27, grade: 'V6' });
  });

  it('falls back to total sends when locked (or no project)', () => {
    expect(resolveBiggestFightTile(projecting({ unlocked: false }), 300)).toEqual({ kind: 'sends', total: 300 });
  });

  it('falls back when unlocked is true but project is somehow null', () => {
    expect(resolveBiggestFightTile(projecting({ unlocked: true, biggestProject: null }), 42)).toEqual({
      kind: 'sends',
      total: 42,
    });
  });
});

describe('deltaKind', () => {
  it('classifies up / down / same', () => {
    expect(deltaKind(3)).toBe('up');
    expect(deltaKind(-2)).toBe('down');
    expect(deltaKind(0)).toBe('same');
  });
});
