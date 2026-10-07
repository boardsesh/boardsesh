import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPRAY_WALL_PREVIEW_HOLD_COUNT,
  previewRolesBottomToTop,
  samplePreviewHolds,
} from '../sample-preview-holds';

function range(length: number, start = 1): number[] {
  return Array.from({ length }, (_, index) => start + index);
}

describe('samplePreviewHolds', () => {
  it('returns exactly the count asked for', () => {
    expect(samplePreviewHolds(range(100), 12)).toHaveLength(12);
    expect(samplePreviewHolds(range(13), 12)).toHaveLength(12);
    expect(samplePreviewHolds(range(40), DEFAULT_SPRAY_WALL_PREVIEW_HOLD_COUNT)).toHaveLength(
      DEFAULT_SPRAY_WALL_PREVIEW_HOLD_COUNT,
    );
  });

  it('spaces the picks evenly through the sorted ids', () => {
    const ids = range(120);
    const sampled = samplePreviewHolds(ids, 12);
    const positions = sampled.map((id) => ids.indexOf(id));
    const gaps = positions.slice(1).map((position, index) => position - positions[index]);
    // 120 ids in 12 slices: every gap is the slice width, give or take the
    // rounding of one slice's midpoint.
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(9);
      expect(gap).toBeLessThanOrEqual(11);
    }
    // And it is not first-N: the picks span the whole wall.
    expect(positions[0]).toBeLessThan(10);
    expect(positions.at(-1)).toBeGreaterThan(109);
  });

  it('keeps the spacing even on an uneven count', () => {
    const ids = range(37);
    const positions = samplePreviewHolds(ids, 10).map((id) => ids.indexOf(id));
    const gaps = positions.slice(1).map((position, index) => position - positions[index]);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  });

  it('never takes the same id twice, even from an input with duplicates', () => {
    const sampled = samplePreviewHolds([5, 5, 3, 9, 9, 1, 7, 2, 8, 4, 6, 10, 11, 12, 13], 12);
    expect(new Set(sampled).size).toBe(sampled.length);
    expect(sampled).toHaveLength(12);
  });

  it('sorts the ids itself, so the order they arrive in does not matter', () => {
    const shuffled = [40, 3, 17, 29, 1, 12, 35, 8, 22, 5, 31, 14, 26, 38, 10, 19];
    const sampled = samplePreviewHolds(shuffled, 6);
    expect(sampled).toEqual([...sampled].sort((left, right) => left - right));
    expect(samplePreviewHolds(shuffled, 6)).toEqual(samplePreviewHolds([...shuffled].reverse(), 6));
  });

  it('is deterministic across calls', () => {
    const ids = range(57, 300);
    expect(samplePreviewHolds(ids, 12)).toEqual(samplePreviewHolds(ids, 12));
  });

  it('lights every hold of a wall smaller than the target, without padding', () => {
    expect(samplePreviewHolds([7, 3, 5], 12)).toEqual([3, 5, 7]);
    expect(samplePreviewHolds(range(12), 12)).toEqual(range(12));
  });

  it('answers nothing for an empty wall or a non-positive target', () => {
    expect(samplePreviewHolds([], 12)).toEqual([]);
    expect(samplePreviewHolds(range(10), 0)).toEqual([]);
    expect(samplePreviewHolds(range(10), -3)).toEqual([]);
  });

  it('keeps the default in the 10–14 band a real problem lights', () => {
    expect(DEFAULT_SPRAY_WALL_PREVIEW_HOLD_COUNT).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_SPRAY_WALL_PREVIEW_HOLD_COUNT).toBeLessThanOrEqual(14);
  });
});

describe('previewRolesBottomToTop', () => {
  it('gives a full-size preview every role, feet lowest and one finish on top', () => {
    const roles = previewRolesBottomToTop(12);
    expect(roles).toHaveLength(12);
    expect(roles.slice(0, 2)).toEqual(['FOOT', 'FOOT']);
    expect(roles.slice(2, 4)).toEqual(['STARTING', 'STARTING']);
    expect(roles.at(-1)).toBe('FINISH');
    expect(roles.filter((role) => role === 'FINISH')).toHaveLength(1);
    expect(roles.filter((role) => role === 'HAND')).toHaveLength(7);
  });

  it('adds the feet and the second start at their own thresholds', () => {
    expect(previewRolesBottomToTop(4)).toEqual(['FOOT', 'STARTING', 'HAND', 'FINISH']);
    expect(previewRolesBottomToTop(5)).toEqual(['FOOT', 'STARTING', 'HAND', 'HAND', 'FINISH']);
    expect(previewRolesBottomToTop(6)).toEqual(['FOOT', 'STARTING', 'STARTING', 'HAND', 'HAND', 'FINISH']);
    expect(previewRolesBottomToTop(8).slice(0, 4)).toEqual(['FOOT', 'FOOT', 'STARTING', 'STARTING']);
  });

  it('drops feet before a start or the finish on a small wall', () => {
    expect(previewRolesBottomToTop(3)).toEqual(['STARTING', 'HAND', 'FINISH']);
    expect(previewRolesBottomToTop(2)).toEqual(['STARTING', 'FINISH']);
    expect(previewRolesBottomToTop(1)).toEqual(['HAND']);
    expect(previewRolesBottomToTop(0)).toEqual([]);
  });

  it('always answers one role per hold', () => {
    for (let count = 0; count <= 20; count += 1) {
      expect(previewRolesBottomToTop(count)).toHaveLength(count);
    }
  });
});
