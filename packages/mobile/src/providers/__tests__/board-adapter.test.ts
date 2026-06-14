import { describe, expect, it } from 'vitest';
import { getLatestUserSessionTickAt, getNewerTickAt, mergeSavedSessionTick } from '../board-adapter-rep-timer';

describe('board adapter rep timer helpers', () => {
  it('selects the latest tick for the current user', () => {
    const ticks = [
      { userId: 'other-user', climbedAt: '2026-06-12 07:20:00' },
      { userId: 'user-1', climbedAt: '2026-06-12 07:15:00' },
      { userId: 'user-1', climbedAt: '2026-06-12 07:45:00' },
      { userId: 'user-1', climbedAt: 'not-a-date' },
    ];

    expect(getLatestUserSessionTickAt(ticks, 'user-1')).toBe('2026-06-12 07:45:00');
  });

  it('returns null when there is no current user tick', () => {
    expect(getLatestUserSessionTickAt([{ userId: 'other-user', climbedAt: '2026-06-12 07:20:00' }], 'user-1')).toBe(
      null,
    );
    expect(getLatestUserSessionTickAt(undefined, 'user-1')).toBeNull();
    expect(getLatestUserSessionTickAt([], null)).toBeNull();
  });

  it('keeps whichever timestamp is newer using backend UTC parsing', () => {
    expect(getNewerTickAt('2026-06-12 07:45:00', '2026-06-12 07:15:00')).toBe('2026-06-12 07:45:00');
    expect(getNewerTickAt('2026-06-12 07:15:00', '2026-06-12 07:45:00')).toBe('2026-06-12 07:45:00');
    expect(getNewerTickAt('not-a-date', '2026-06-12 07:45:00')).toBe('2026-06-12 07:45:00');
  });

  it('keeps the newest local tick when save responses resolve out of order', () => {
    const newerTick = mergeSavedSessionTick(null, 'session-1', '2026-06-12 07:45:00');

    expect(mergeSavedSessionTick(newerTick, 'session-1', '2026-06-12 07:15:00')).toEqual(newerTick);
    expect(mergeSavedSessionTick(newerTick, 'session-1', '2026-06-12 07:50:00')).toEqual({
      sessionId: 'session-1',
      climbedAt: '2026-06-12 07:50:00',
    });
  });
});
