import { describe, it, expect } from 'vitest';
import type { LogbookEntry } from '@boardsesh/board-react';
import { deriveClimbLedger } from '@boardsesh/profile-stats';
import { buildLedgerListItems } from '../ledger-list-items';

function makeEntry(uuid: string, angle: number, climbedAt: string): LogbookEntry {
  return {
    uuid,
    climb_uuid: 'climb-1',
    angle,
    is_mirror: false,
    tries: 1,
    quality: null,
    difficulty: null,
    comment: '',
    climbed_at: climbedAt,
    is_ascent: false,
    status: 'attempt',
    upvotes: 0,
    downvotes: 0,
    commentCount: 0,
  };
}

describe('buildLedgerListItems', () => {
  it('returns nothing for an empty ledger', () => {
    expect(buildLedgerListItems(deriveClimbLedger<LogbookEntry>([], { currentAngle: 40 }))).toEqual([]);
  });

  it('lists each angle heading followed by all of its sessions, uncapped', () => {
    // 12 days at 40 (past the card's inline cap of 6) and 2 days at 45.
    const entries = [
      ...Array.from({ length: 12 }, (_, day) =>
        makeEntry(`forty-${day}`, 40, `2026-06-${String(day + 1).padStart(2, '0')}T12:00:00`),
      ),
      makeEntry('fortyfive-a', 45, '2026-06-01T12:00:00'),
      makeEntry('fortyfive-b', 45, '2026-06-02T12:00:00'),
    ];
    const items = buildLedgerListItems(deriveClimbLedger(entries, { currentAngle: 40 }));

    expect(items.map((item) => item.kind)).toEqual([
      'angle',
      ...Array.from({ length: 12 }, () => 'session'),
      'angle',
      'session',
      'session',
    ]);
    expect(items[0]).toMatchObject({ kind: 'angle', key: 'angle:40' });
    expect(items[13]).toMatchObject({ kind: 'angle', key: 'angle:45' });
    expect(items[14]).toMatchObject({ kind: 'session', angle: 45 });
    // The same day at two angles must not collide.
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
  });
});
