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

describe('spray walls have no edit window (#5955)', () => {
  const published = { uuid: 'a', boardType: 'spray', createdAt: null, publishedAt: expired, isDraft: false };

  it('still updates a spray climb in place long after publishing', () => {
    expect(computeCanUpdate(published, 'spray', NOW)).toBe(true);
  });

  it('never locks a spray climb', () => {
    expect(computeEditLocked(published, NOW)).toBe(false);
    expect(computeEditLocked({ ...published, publishedAt: within }, NOW)).toBe(false);
  });

  it('updates a published spray climb even when its publish date is missing', () => {
    expect(computeCanUpdate({ ...published, publishedAt: null }, 'spray', NOW)).toBe(true);
  });

  it('still refuses to update a spray row from another board', () => {
    expect(computeCanUpdate(published, 'kilter', NOW)).toBe(false);
  });
});

describe('canEditClimb', () => {
  const SETTER = 'setter-1';
  const OTHER = 'someone-else';
  const draft = { uuid: 'c', userId: SETTER, is_draft: true, published_at: null };
  const fresh = { uuid: 'c', userId: SETTER, is_draft: false, published_at: within };
  const old = { uuid: 'c', userId: SETTER, is_draft: false, published_at: expired };

  type Case = {
    label: string;
    climb: { uuid: string; userId?: string | null; is_draft?: boolean | null; published_at?: string | null };
    boardType: string;
    currentUserId: string | null;
    viewerCanEditWall?: boolean | null;
    expected: boolean;
  };

  const cases: Case[] = [
    // Catalogue boards: the setter, 24 hours, nobody else.
    { label: 'kilter draft, setter', climb: draft, boardType: 'kilter', currentUserId: SETTER, expected: true },
    { label: 'kilter fresh, setter', climb: fresh, boardType: 'kilter', currentUserId: SETTER, expected: true },
    { label: 'kilter after 24h, setter', climb: old, boardType: 'kilter', currentUserId: SETTER, expected: false },
    { label: 'kilter fresh, stranger', climb: fresh, boardType: 'kilter', currentUserId: OTHER, expected: false },
    {
      label: 'kilter fresh, stranger carrying a wall-editor flag',
      climb: fresh,
      boardType: 'kilter',
      currentUserId: OTHER,
      viewerCanEditWall: true,
      expected: false,
    },
    {
      label: 'kilter after 24h, setter carrying a wall-editor flag',
      climb: old,
      boardType: 'kilter',
      currentUserId: SETTER,
      viewerCanEditWall: true,
      expected: false,
    },
    // Spray: no window, and wall editors on published climbs.
    { label: 'spray draft, setter', climb: draft, boardType: 'spray', currentUserId: SETTER, expected: true },
    { label: 'spray after 24h, setter', climb: old, boardType: 'spray', currentUserId: SETTER, expected: true },
    {
      label: 'spray after 24h, wall editor',
      climb: old,
      boardType: 'spray',
      currentUserId: OTHER,
      viewerCanEditWall: true,
      expected: true,
    },
    {
      label: 'spray draft, wall editor',
      climb: draft,
      boardType: 'spray',
      currentUserId: OTHER,
      viewerCanEditWall: true,
      expected: false,
    },
    { label: 'spray published, stranger', climb: old, boardType: 'spray', currentUserId: OTHER, expected: false },
    {
      label: 'spray published, wall access unknown',
      climb: old,
      boardType: 'spray',
      currentUserId: OTHER,
      viewerCanEditWall: null,
      expected: false,
    },
    // Signed out, and climbs with no setter on record.
    {
      label: 'spray published, signed out',
      climb: old,
      boardType: 'spray',
      currentUserId: null,
      viewerCanEditWall: true,
      expected: false,
    },
    {
      label: 'kilter with no setter on record',
      climb: { ...fresh, userId: null },
      boardType: 'kilter',
      currentUserId: SETTER,
      expected: false,
    },
    {
      label: 'spray with no setter on record, stranger',
      climb: { ...old, userId: null },
      boardType: 'spray',
      currentUserId: OTHER,
      expected: false,
    },
    {
      label: 'spray published with no setter on record, wall editor',
      climb: { ...old, userId: null },
      boardType: 'spray',
      currentUserId: OTHER,
      viewerCanEditWall: true,
      expected: true,
    },
    {
      label: 'spray draft with no setter on record, wall editor',
      climb: { ...draft, userId: null },
      boardType: 'spray',
      currentUserId: OTHER,
      viewerCanEditWall: true,
      expected: false,
    },
  ];

  it.each(cases)('$label -> $expected', ({ climb, boardType, currentUserId, viewerCanEditWall, expected }) => {
    expect(canEditClimb({ climb, boardType, currentUserId, viewerCanEditWall, now: NOW })).toBe(expected);
  });

  describe('a wall editor and a climb from somewhere else', () => {
    // A wall owner standing at their own wall, with a queue item left over from
    // another board. The viewing board is spray and they can edit it; the climb
    // is not theirs and not on it.
    const asWallEditor = (climb: Record<string, unknown>) =>
      canEditClimb({
        climb: { ...old, ...climb },
        boardType: 'spray',
        currentUserId: OTHER,
        viewerCanEditWall: true,
        wallLayoutId: 4200,
        now: NOW,
      });

    it('is offered a published climb on that wall', () => {
      expect(asWallEditor({ boardType: 'spray', layoutId: 4200 })).toBe(true);
    });

    it('is not offered a Kilter climb sitting in the queue', () => {
      expect(asWallEditor({ boardType: 'kilter', layoutId: 1 })).toBe(false);
      // Even one whose layout id happens to equal the wall's.
      expect(asWallEditor({ boardType: 'kilter', layoutId: 4200 })).toBe(false);
    });

    it('is not offered a climb from another spray wall', () => {
      expect(asWallEditor({ boardType: 'spray', layoutId: 4201 })).toBe(false);
    });

    it('is offered a row that does not say which board it is on', () => {
      expect(asWallEditor({})).toBe(true);
      expect(asWallEditor({ boardType: null, layoutId: null })).toBe(true);
    });

    it('does not let the setter lose Edit over a board field', () => {
      const own = { ...old, boardType: 'spray', layoutId: 4201 };
      expect(
        canEditClimb({ climb: own, boardType: 'spray', currentUserId: SETTER, wallLayoutId: 4200, now: NOW }),
      ).toBe(true);
    });
  });

  it('is false with no climb', () => {
    expect(canEditClimb({ climb: null, boardType: 'spray', currentUserId: SETTER, viewerCanEditWall: true })).toBe(
      false,
    );
  });

  it('treats a climb with no draft flag as published', () => {
    const climb = { uuid: 'c', userId: SETTER, published_at: expired };
    expect(canEditClimb({ climb, boardType: 'kilter', currentUserId: SETTER, now: NOW })).toBe(false);
    expect(canEditClimb({ climb, boardType: 'spray', currentUserId: SETTER, now: NOW })).toBe(true);
  });

  it('prefers viewerCanEditClimbs over viewerCanEditWall (#6025)', () => {
    // Wall cannot be edited by viewer (viewerCanEditWall: false), but climbs CAN be edited (viewerCanEditClimbs: true)
    expect(
      canEditClimb({
        climb: old,
        boardType: 'spray',
        currentUserId: OTHER,
        viewerCanEditWall: false,
        viewerCanEditClimbs: true,
        now: NOW,
      }),
    ).toBe(true);

    // Wall CAN be edited (viewerCanEditWall: true), but viewerCanEditClimbs is explicitly false
    expect(
      canEditClimb({
        climb: old,
        boardType: 'spray',
        currentUserId: OTHER,
        viewerCanEditWall: true,
        viewerCanEditClimbs: false,
        now: NOW,
      }),
    ).toBe(false);
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
