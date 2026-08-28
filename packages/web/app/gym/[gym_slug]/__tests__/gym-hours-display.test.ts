import { describe, it, expect } from 'vite-plus/test';
import { formatHoursConfirmedDate } from '../gym-hours-display';

describe('formatHoursConfirmedDate', () => {
  it('formats an ISO timestamp as a plain date', () => {
    expect(formatHoursConfirmedDate('2026-03-14T10:15:00.000Z', 'en-US')).toBe('Mar 14, 2026');
  });

  it('follows the viewer locale', () => {
    expect(formatHoursConfirmedDate('2026-03-14T10:15:00.000Z', 'de')).toContain('2026');
    expect(formatHoursConfirmedDate('2026-03-14T10:15:00.000Z', 'de')).toContain('14');
  });

  it('reads a late-evening stamp in UTC, so it never rolls into the next day', () => {
    const lateEvening = '2026-03-14T23:30:00.000Z';

    // Berlin is already on the 15th at that instant — proof the assertion below
    // is discriminating no matter which zone the test host runs in.
    expect(
      new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        timeZone: 'Europe/Berlin',
      }).format(new Date(lateEvening)),
    ).toBe('Mar 15, 2026');

    expect(formatHoursConfirmedDate(lateEvening, 'en-US')).toBe('Mar 14, 2026');
  });

  it('reads an early-morning stamp in UTC, so it never rolls back a day', () => {
    // 00:30 UTC is still the previous evening in Denver.
    expect(formatHoursConfirmedDate('2026-03-15T00:30:00.000Z', 'en-US')).toBe('Mar 15, 2026');
  });

  it('returns null when there is no stamp', () => {
    expect(formatHoursConfirmedDate(null, 'en-US')).toBeNull();
    expect(formatHoursConfirmedDate(undefined, 'en-US')).toBeNull();
    expect(formatHoursConfirmedDate('', 'en-US')).toBeNull();
  });

  it('returns null for an unparseable value instead of "Invalid Date"', () => {
    expect(formatHoursConfirmedDate('not-a-timestamp', 'en-US')).toBeNull();
  });
});
