import { describe, it, expect, vi } from 'vitest';
import { EDIT_WINDOW_MS, computeCanUpdate, computeEditLocked, buildInitialHoldsMap } from '../helpers';

vi.mock('@boardsesh/board-constants/hold-states', () => ({
  // Single-frame: `p{id}r{code}`. Multi-frame: comma-separated, later frames win.
  convertLitUpHoldsStringToMap: (frames: string) => {
    const result: Record<number, Record<number, { state: string; color: string; displayColor: string }>> = {};
    frames
      .split(',')
      .filter(Boolean)
      .forEach((frame, index) => {
        const holds: Record<number, { state: string; color: string; displayColor: string }> = {};
        for (const match of frame.matchAll(/p(\d+)r(\d+)/g)) {
          const holdId = Number(match[1]);
          const code = Number(match[2]);
          const state = code === 42 ? 'STARTING' : code === 43 ? 'HAND' : 'FINISH';
          holds[holdId] = { state, color: '#fff', displayColor: '#fff' };
        }
        result[index] = holds;
      });
    return result;
  },
}));

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

describe('buildInitialHoldsMap', () => {
  it('returns empty for empty frames', () => {
    expect(buildInitialHoldsMap('', 'kilter')).toEqual({});
  });

  it('parses a single frame', () => {
    expect(buildInitialHoldsMap('p100r42p200r43', 'kilter')).toEqual({
      100: { state: 'STARTING', color: '#fff', displayColor: '#fff' },
      200: { state: 'HAND', color: '#fff', displayColor: '#fff' },
    });
  });

  it('merges multi-frame with later frames overriding', () => {
    const map = buildInitialHoldsMap('p100r42,p100r43p200r44', 'kilter');
    expect(map[100].state).toBe('HAND'); // later frame wins
    expect(map[200].state).toBe('FINISH');
  });
});
