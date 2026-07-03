import { describe, expect, it } from 'vitest';
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

  it('counts flashes as sends', () => {
    const stats = deriveAngleLifetimeStats([entry({ status: 'flash', tries: 1 })]);
    expect(stats[0].sendCount).toBe(1);
  });

  it('returns empty for no entries', () => {
    expect(deriveAngleLifetimeStats([])).toEqual([]);
  });
});

describe('groupEntriesByAngle', () => {
  it('sections entries by angle in encounter order with lifetime stats attached', () => {
    const newestFortyFive = entry({ angle: 45, tries: 2, climbed_at: '2026-06-20T10:00:00' });
    const fortySend = entry({ angle: 40, tries: 3, climbed_at: '2026-06-15T10:00:00', status: 'send' });
    const fortyBurn = entry({ angle: 40, tries: 4, climbed_at: '2026-06-01T10:00:00' });
    // Newest-first input: the most recently climbed angle leads the sections.
    const sections = groupEntriesByAngle([newestFortyFive, fortySend, fortyBurn]);
    expect(sections.map((section) => section.angle)).toEqual([45, 40]);
    expect(sections[0].entries).toEqual([newestFortyFive]);
    expect(sections[1].entries).toEqual([fortySend, fortyBurn]);
    expect(sections[1].stats).toEqual({ angle: 40, totalTries: 7, sessionCount: 2, sendCount: 1 });
  });

  it('returns empty for no entries', () => {
    expect(groupEntriesByAngle([])).toEqual([]);
  });
});
