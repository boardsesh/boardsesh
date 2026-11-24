import { describe, expect, it } from 'vitest';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { BOARD_HISTORY_WINDOW_MS, boardHistoryExpiresAt, filterRecentBoardHistory } from '../history';

const now = Date.parse('2026-11-24T12:00:00.123Z');
const climb = (sentAt: string, seq = 1): BoardPresenceClimb => ({ climbUuid: 'climb', sentAt, seq });

describe('rolling board-history window', () => {
  it('keeps the inclusive cutoff and microseconds after it, excluding one microsecond before', () => {
    const expired = climb('2026-11-17T12:00:00.122999Z', 1);
    const boundary = climb('2026-11-17T12:00:00.123000Z', 2);
    const newer = climb('2026-11-17T12:00:00.123001Z', 3);
    expect(filterRecentBoardHistory([newer, expired, boundary], now)).toEqual([newer, boundary]);
    expect(filterRecentBoardHistory([boundary, newer], now + 1)).toEqual([]);
  });

  it('treats legacy naive timestamps as UTC and excludes malformed timestamps', () => {
    const boundary = climb('2026-11-17 12:00:00.123000');
    expect(filterRecentBoardHistory([climb('invalid'), climb('2026-99-01'), boundary], now)).toEqual([boundary]);
    expect(boardHistoryExpiresAt(boundary.sentAt)).toBe(now + 1);
    expect(boardHistoryExpiresAt('invalid')).toBeNull();
  });

  it('preserves source, ordering, object identity and array identity when nothing expires', () => {
    const entries = [
      climb(new Date(now).toISOString(), 3),
      { ...climb('2026-11-23T12:00:00Z'), source: 'kilter' as const },
    ];
    expect(filterRecentBoardHistory(entries, now)).toBe(entries);
    expect(boardHistoryExpiresAt(entries[0].sentAt)).toBe(now + BOARD_HISTORY_WINDOW_MS + 1);
    expect(filterRecentBoardHistory(entries, now + BOARD_HISTORY_WINDOW_MS + 1)).toEqual([]);
  });
});
