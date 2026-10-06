import { describe, it, expect } from 'vitest';
import { EDIT_WINDOW_MS, computeCanUpdate, computeEditLocked, canEditClimb, buildInitialFrames } from '../helpers';

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

// A spray climb follows the same rule as Kilter and Tension: its setter edits
// it, in place, for 24 hours after first publish.
describe('a spray climb has the same 24-hour window', () => {
  const sprayRow = (publishedAt: string | null, isDraft = false) => ({
    uuid: 'a',
    boardType: 'spray',
    createdAt: null,
    publishedAt,
    isDraft,
  });

  it('updates in place within the window and not after it', () => {
    expect(computeCanUpdate(sprayRow(within), 'spray', NOW)).toBe(true);
    expect(computeCanUpdate(sprayRow(expired), 'spray', NOW)).toBe(false);
  });

  it('locks after the window and not before it', () => {
    expect(computeEditLocked(sprayRow(within), NOW)).toBe(false);
    expect(computeEditLocked(sprayRow(expired), NOW)).toBe(true);
  });

  it('keeps a draft open for good', () => {
    expect(computeCanUpdate(sprayRow(null, true), 'spray', NOW)).toBe(true);
    expect(computeEditLocked(sprayRow(null, true), NOW)).toBe(false);
  });

  it('does not update a published climb whose publish date is missing', () => {
    expect(computeCanUpdate(sprayRow(null), 'spray', NOW)).toBe(false);
  });

  it('still refuses to update a spray row from another board', () => {
    expect(computeCanUpdate(sprayRow(within), 'kilter', NOW)).toBe(false);
  });
});

describe('canEditClimb', () => {
  const SETTER = 'setter-1';
  const OTHER = 'someone-else';
  const draft = { uuid: 'c', userId: SETTER, is_draft: true, published_at: null };
  const fresh = { uuid: 'c', userId: SETTER, is_draft: false, published_at: within };
  const old = { uuid: 'c', userId: SETTER, is_draft: false, published_at: expired };
  const othersDraft = { ...draft, userId: OTHER };

  type Case = {
    label: string;
    climb: { uuid: string; userId?: string | null; is_draft?: boolean | null; published_at?: string | null };
    boardType: string;
    currentUserId: string | null;
    expected: boolean;
  };

  // The same matrix on every board: the setter, a draft for good, a published
  // climb for 24 hours, nobody else. The wall's owner is "nobody else" on a
  // climb somebody else set.
  const cases: Case[] = ['kilter', 'spray'].flatMap((boardType) => [
    { label: `${boardType} draft, setter`, climb: draft, boardType, currentUserId: SETTER, expected: true },
    { label: `${boardType} within 24h, setter`, climb: fresh, boardType, currentUserId: SETTER, expected: true },
    { label: `${boardType} after 24h, setter`, climb: old, boardType, currentUserId: SETTER, expected: false },
    {
      label: `${boardType} within 24h, not the setter`,
      climb: fresh,
      boardType,
      currentUserId: OTHER,
      expected: false,
    },
    { label: `${boardType} after 24h, not the setter`, climb: old, boardType, currentUserId: OTHER, expected: false },
    {
      label: `${boardType} draft, not the setter`,
      climb: othersDraft,
      boardType,
      currentUserId: SETTER,
      expected: false,
    },
    { label: `${boardType} within 24h, signed out`, climb: fresh, boardType, currentUserId: null, expected: false },
    {
      label: `${boardType} with no setter on record`,
      climb: { ...fresh, userId: null },
      boardType,
      currentUserId: OTHER,
      expected: false,
    },
  ]);

  it.each(cases)('$label -> $expected', ({ climb, boardType, currentUserId, expected }) => {
    expect(canEditClimb({ climb, boardType, currentUserId, now: NOW })).toBe(expected);
  });

  it('is false with no climb', () => {
    expect(canEditClimb({ climb: null, boardType: 'spray', currentUserId: SETTER })).toBe(false);
  });

  it('treats a climb with no draft flag as published', () => {
    const climb = { uuid: 'c', userId: SETTER, published_at: expired };
    expect(canEditClimb({ climb, boardType: 'kilter', currentUserId: SETTER, now: NOW })).toBe(false);
    expect(canEditClimb({ climb, boardType: 'spray', currentUserId: SETTER, now: NOW })).toBe(false);
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
