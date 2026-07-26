import { describe, expect, it } from 'vitest';

import { shouldNotifyForNewCanonical } from './catalog-sync';

const NOW = new Date('2026-07-26T12:00:00Z');

void describe('shouldNotifyForNewCanonical', () => {
  it('notifies for a climb published upstream today', () => {
    expect(shouldNotifyForNewCanonical('2026-07-26T09:00:00Z', NOW)).toBe(true);
  });

  it('notifies for a climb published just inside the recency window', () => {
    expect(shouldNotifyForNewCanonical('2026-06-27T12:00:00Z', NOW)).toBe(true);
  });

  it('notifies at exactly the 30-day boundary, and stops one millisecond past it', () => {
    // The window is inclusive; pinning both sides so an off-by-one can't slip
    // through between the 29-day and 31-day cases either side of it.
    expect(shouldNotifyForNewCanonical('2026-06-26T12:00:00.000Z', NOW)).toBe(true);
    expect(shouldNotifyForNewCanonical('2026-06-26T11:59:59.999Z', NOW)).toBe(false);
  });

  it('stays quiet for a climb published years ago', () => {
    // The multi-frame decoder recovers animated climbs first published as far
    // back as 2021. Presenting those to followers as "new" would be a worse
    // regression than the bug that hid them.
    expect(shouldNotifyForNewCanonical('2021-03-13T19:21:57.981623Z', NOW)).toBe(false);
  });

  it('stays quiet just outside the recency window', () => {
    expect(shouldNotifyForNewCanonical('2026-06-25T12:00:00Z', NOW)).toBe(false);
  });

  it('notifies when upstream gives no createdAt, matching the previous behaviour', () => {
    expect(shouldNotifyForNewCanonical(null, NOW)).toBe(true);
    expect(shouldNotifyForNewCanonical(undefined, NOW)).toBe(true);
    expect(shouldNotifyForNewCanonical('', NOW)).toBe(true);
  });

  it('notifies when createdAt is unparseable rather than silently dropping it', () => {
    expect(shouldNotifyForNewCanonical('not a date', NOW)).toBe(true);
  });

  it('notifies for a createdAt in the future (upstream clock skew)', () => {
    expect(shouldNotifyForNewCanonical('2026-08-01T00:00:00Z', NOW)).toBe(true);
  });
});
