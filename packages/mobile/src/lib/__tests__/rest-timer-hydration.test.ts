import { describe, expect, it } from 'vitest';
import { getLatestUserSessionTickAt, getNewerTickAt } from '../rest-timer-hydration';

describe('getLatestUserSessionTickAt', () => {
  const ticks = [
    { userId: 'me', climbedAt: '2026-09-11T10:00:00.000Z' },
    { userId: 'crew-mate', climbedAt: '2026-09-11T10:05:00.000Z' },
    { userId: 'me', climbedAt: '2026-09-11T10:02:00.000Z' },
  ];

  it('picks the climber own latest tick', () => {
    expect(getLatestUserSessionTickAt(ticks, 'me')).toBe('2026-09-11T10:02:00.000Z');
  });

  it('ignores a crew-mate send, so their tick cannot restart your rest', () => {
    expect(getLatestUserSessionTickAt(ticks, 'me')).not.toBe('2026-09-11T10:05:00.000Z');
  });

  it('returns null with no ticks or no user', () => {
    expect(getLatestUserSessionTickAt(undefined, 'me')).toBeNull();
    expect(getLatestUserSessionTickAt(ticks, null)).toBeNull();
    expect(getLatestUserSessionTickAt([], 'me')).toBeNull();
  });

  it('skips unparseable timestamps', () => {
    expect(getLatestUserSessionTickAt([{ userId: 'me', climbedAt: 'not-a-date' }], 'me')).toBeNull();
  });
});

describe('getNewerTickAt', () => {
  it('never lets a stale server read rewind a live local anchor', () => {
    expect(getNewerTickAt('2026-09-11T10:05:00.000Z', '2026-09-11T10:00:00.000Z')).toBe('2026-09-11T10:05:00.000Z');
  });

  it('adopts the server read when it is newer', () => {
    expect(getNewerTickAt('2026-09-11T10:00:00.000Z', '2026-09-11T10:05:00.000Z')).toBe('2026-09-11T10:05:00.000Z');
  });

  it('tolerates nulls on either side', () => {
    expect(getNewerTickAt(null, '2026-09-11T10:00:00.000Z')).toBe('2026-09-11T10:00:00.000Z');
    expect(getNewerTickAt('2026-09-11T10:00:00.000Z', null)).toBe('2026-09-11T10:00:00.000Z');
    expect(getNewerTickAt(null, null)).toBeNull();
  });

  it('prefers the parseable side', () => {
    expect(getNewerTickAt('not-a-date', '2026-09-11T10:00:00.000Z')).toBe('2026-09-11T10:00:00.000Z');
    expect(getNewerTickAt('2026-09-11T10:00:00.000Z', 'not-a-date')).toBe('2026-09-11T10:00:00.000Z');
    expect(getNewerTickAt('not-a-date', 'also-not-a-date')).toBeNull();
  });
});
