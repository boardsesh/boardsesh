import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

// Stored tick timestamps are naive UTC; parseTickTime recovers the absolute
// moment then renders LOCAL. To pin local-midnight behavior deterministically
// in any test timezone, build fixtures FROM local wall-clock times.
const storedUtcFromLocal = (localWallClock: string) => dayjs(localWallClock).utc().format('YYYY-MM-DDTHH:mm:ss');
import { deriveAngleLifetimeStats, groupEntriesByAngle } from '../angle-lifetime';
import type { LogbookEntry } from '../types';

const entry = (overrides: Partial<LogbookEntry>): LogbookEntry => ({
  climbed_at: '2026-06-01T10:00:00',
  difficulty: null,
  tries: 1,
  angle: 40,
  status: 'attempt',
  ...overrides,
});

describe('deriveAngleLifetimeStats', () => {
  it('splits by angle and sums tries, sessions (distinct days) and sends per angle', () => {
    const stats = deriveAngleLifetimeStats([
      entry({ angle: 40, tries: 4, climbed_at: '2026-06-01T10:00:00' }),
      entry({ angle: 40, tries: 6, climbed_at: '2026-06-08T10:00:00' }),
      entry({ angle: 40, tries: 3, climbed_at: '2026-06-15T10:00:00', status: 'send' }),
      entry({ angle: 45, tries: 2, climbed_at: '2026-06-20T10:00:00' }),
    ]);
    expect(stats).toEqual([
      { angle: 40, totalTries: 13, sessionCount: 3, sendCount: 1 },
      { angle: 45, totalTries: 2, sessionCount: 1, sendCount: 0 },
    ]);
  });

  it('counts one session for multiple same-day entries and floors zero tries', () => {
    const stats = deriveAngleLifetimeStats([
      entry({ tries: 0, climbed_at: '2026-06-01T09:00:00' }), // imported zero → 1
      entry({ tries: 3, climbed_at: '2026-06-01T18:00:00', status: 'send' }),
    ]);
    expect(stats).toEqual([{ angle: 40, totalTries: 4, sessionCount: 1, sendCount: 1 }]);
  });

  it('counts a midnight-spanning session as two distinct local days', () => {
    // Day-scoped convention: sessions = distinct LOCAL calendar days, so a
    // late-night session crossing midnight honestly reads as 2 sessions.
    const stats = deriveAngleLifetimeStats([
      entry({ tries: 2, climbed_at: storedUtcFromLocal('2026-06-01 23:30') }),
      entry({ tries: 1, climbed_at: storedUtcFromLocal('2026-06-02 00:30') }),
    ]);
    expect(stats[0].sessionCount).toBe(2);
  });

  it('counts flashes as sends', () => {
    const stats = deriveAngleLifetimeStats([entry({ status: 'flash', tries: 1 })]);
    expect(stats[0].sendCount).toBe(1);
  });

  it('returns empty for no entries', () => {
    expect(deriveAngleLifetimeStats([])).toEqual([]);
  });
});

describe('groupEntriesByAngle', () => {
  it('sections entries steepest angle first with lifetime stats attached', () => {
    // Newest entry is at the SHALLOWER angle: order must follow steepness
    // (hardest leads), not recency.
    const newestForty = entry({ angle: 40, tries: 3, climbed_at: '2026-06-20T10:00:00', status: 'send' });
    const fortyFiveBurn = entry({ angle: 45, tries: 2, climbed_at: '2026-06-15T10:00:00' });
    const fortyBurn = entry({ angle: 40, tries: 4, climbed_at: '2026-06-01T10:00:00' });
    const sections = groupEntriesByAngle([newestForty, fortyFiveBurn, fortyBurn]);
    expect(sections.map((section) => section.angle)).toEqual([45, 40]);
    expect(sections[0].entries).toEqual([fortyFiveBurn]);
    expect(sections[1].entries).toEqual([newestForty, fortyBurn]);
    expect(sections[1].stats).toEqual({ angle: 40, totalTries: 7, sessionCount: 2, sendCount: 1 });
  });

  it('returns empty for no entries', () => {
    expect(groupEntriesByAngle([])).toEqual([]);
  });
});
