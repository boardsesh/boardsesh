import { describe, it, expect } from 'vite-plus/test';
import { createOrderDateFormatter } from '../format-date';

describe('createOrderDateFormatter', () => {
  it('formats in UTC regardless of the environment time zone', () => {
    // 2026-09-01T23:30:00Z is 2026-09-02 in any zone ahead of UTC and
    // 2026-09-01 behind it. Pinning the zone means the server render (any
    // machine) and the client render (any browser) always agree.
    const formatter = createOrderDateFormatter('en-US', { dateStyle: 'medium' });
    expect(formatter.format(new Date('2026-09-01T23:30:00.000Z'))).toBe('Sep 1, 2026');
  });

  it('keeps every option it is given, adding only the time zone', () => {
    const formatter = createOrderDateFormatter('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    expect(formatter.format(new Date('2026-09-01T02:14:11.402Z'))).toBe('Sep 1, 2026, 2:14 AM');
  });
});
