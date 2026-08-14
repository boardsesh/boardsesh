import { describe, it, expect } from 'vitest';
import { EDIT_WINDOW_MS, computeCanUpdate, computeEditLocked, buildInitialFrames } from '../helpers';

const NOW = Date.parse('2026-06-03T12:00:00.000Z');
const within = new Date(NOW - 60 * 60 * 1000).toISOString(); // 1h ago
const expired = new Date(NOW - 48 * 60 * 60 * 1000).toISOString(); // 48h ago

describe('computeCanUpdate', () => {
  it('returns false with no saved climb', () => {
    expect(computeCanUpdate(null, 'kilter', NOW)).toBe(false);
  });

  it('returns false on board mismatch', () => {
    const saved = { uuid: 'a', boardType: 'tension', createdAt: null, publishedAt: within, isDraft: false };
    expect(computeCanUpdate(saved, 'kilter', NOW)).toBe(false);
  });

  it('returns true for a draft regardless of age', () => {
    const saved = { uuid: 'a', boardType: 'kilter', createdAt: null, publishedAt: null, isDraft: true };
    expect(computeCanUpdate(saved, 'kilter', NOW)).toBe(true);
  });

  it('returns true for a climb published within the window', () => {
    const saved = { uuid: 'a', boardType: 'kilter', createdAt: null, publishedAt: within, isDraft: false };
    expect(computeCanUpdate(saved, 'kilter', NOW)).toBe(true);
  });

  it('returns false for a climb published past the window', () => {
    const saved = { uuid: 'a', boardType: 'kilter', createdAt: null, publishedAt: expired, isDraft: false };
    expect(computeCanUpdate(saved, 'kilter', NOW)).toBe(false);
  });
});

describe('computeEditLocked', () => {
  it('is false for drafts', () => {
    const saved = { uuid: 'a', boardType: 'kilter', createdAt: null, publishedAt: null, isDraft: true };
    expect(computeEditLocked(saved, NOW)).toBe(false);
  });

  it('is false within the window', () => {
    const saved = { uuid: 'a', boardType: 'kilter', createdAt: null, publishedAt: within, isDraft: false };
    expect(computeEditLocked(saved, NOW)).toBe(false);
  });

  it('is true past the window', () => {
    const saved = { uuid: 'a', boardType: 'kilter', createdAt: null, publishedAt: expired, isDraft: false };
    expect(computeEditLocked(saved, NOW)).toBe(true);
  });

  it('EDIT_WINDOW_MS is 24h', () => {
    expect(EDIT_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('buildInitialFrames', () => {
  it('returns a single empty frame for an empty frames string', () => {
    expect(buildInitialFrames('', 'kilter')).toEqual([{}]);
  });

  it('parses a single frame', () => {
    const frames = buildInitialFrames('p100r42p200r43', 'kilter');
    expect(frames).toHaveLength(1);
    expect(frames[0][100].state).toBe('STARTING');
    expect(frames[0][200].state).toBe('HAND');
  });

  it('preserves frame separation instead of flattening to one map', () => {
    // Frame 0 lights hold 100; frame 1 is a delta that re-roles it and adds 200.
    const frames = buildInitialFrames('p100r42,"p100r43p200r44', 'kilter');
    expect(frames).toHaveLength(2);
    expect(frames[0][100].state).toBe('STARTING');
    expect(frames[0][200]).toBeUndefined();
    expect(frames[1][100].state).toBe('HAND');
    expect(frames[1][200].state).toBe('FINISH');
  });
});
