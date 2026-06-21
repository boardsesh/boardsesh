import { describe, it, expect } from 'vitest';
import { formatTickAbsoluteTime } from '@boardsesh/profile-stats';
import { formatSessionWhen } from '../format-session-when';

// Echo the key's final segment so 'detail.weekday.sunday' -> 'sunday'.
const t = (key: string) => key.split('.').pop() as string;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const PARTS = ['morning', 'afternoon', 'evening', 'night'];

// Mirror the helper's bucketing off the LOCAL hour so the assertion is
// timezone-independent (both read local time via formatTickAbsoluteTime).
function expected(ts: string): string {
  const day = Number(formatTickAbsoluteTime(ts, 'd'));
  const h = Number(formatTickAbsoluteTime(ts, 'H'));
  const part = h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : h >= 17 && h < 21 ? 'evening' : 'night';
  return `${WEEKDAYS[day]} ${part}`;
}

describe('formatSessionWhen', () => {
  it('composes localized weekday + part-of-day', () => {
    const ts = '2026-06-14T15:30:00.000Z';
    expect(formatSessionWhen(ts, t)).toBe(expected(ts));
  });

  it('always returns a known weekday and a known part-of-day', () => {
    for (const ts of [
      '2026-01-01T06:00:00.000Z',
      '2026-03-15T13:00:00.000Z',
      '2026-07-04T19:30:00.000Z',
      '2026-12-31T23:59:00.000Z',
    ]) {
      const [day, part] = formatSessionWhen(ts, t).split(' ');
      expect(WEEKDAYS).toContain(day);
      expect(PARTS).toContain(part);
      expect(formatSessionWhen(ts, t)).toBe(expected(ts));
    }
  });
});
