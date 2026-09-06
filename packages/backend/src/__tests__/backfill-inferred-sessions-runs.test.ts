import { describe, it, expect } from 'vite-plus/test';
import { SESSION_GAP_MS } from '@boardsesh/session-inference';
import { runStartTimestamps } from '../scripts/backfill-inferred-sessions';

/**
 * The backfill reconciles once per run rather than once per tick — 435k calls would be
 * 435k redundant passes over windows already reconciled, since one call covers the whole
 * run around the timestamp it is given.
 *
 * That makes the run-splitting the one rule this script owns: pick too few timestamps
 * and whole sessions go unbackfilled; pick too many and it is merely slow. Everything
 * else it does is the shared package's job.
 */

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const BASE = Date.UTC(2026, 4, 10, 9, 0, 0);

describe('runStartTimestamps', () => {
  it('returns nothing for a climber with no ticks', () => {
    expect(runStartTimestamps([])).toEqual([]);
  });

  it('returns one timestamp for a single run', () => {
    const ticks = [BASE, BASE + 10 * MINUTE, BASE + 25 * MINUTE];

    expect(runStartTimestamps(ticks)).toEqual([BASE]);
  });

  it('picks the first climb of each run', () => {
    const ticks = [BASE, BASE + 20 * MINUTE, BASE + 10 * HOUR, BASE + 10 * HOUR + 15 * MINUTE];

    expect(runStartTimestamps(ticks)).toEqual([BASE, BASE + 10 * HOUR]);
  });

  it('does not split exactly at the threshold', () => {
    const ticks = [BASE, BASE + SESSION_GAP_MS];

    expect(runStartTimestamps(ticks)).toEqual([BASE]);
  });

  it('splits one millisecond past the threshold', () => {
    const ticks = [BASE, BASE + SESSION_GAP_MS + 1];

    expect(runStartTimestamps(ticks)).toEqual([BASE, BASE + SESSION_GAP_MS + 1]);
  });

  // Years of imported logbook history is the normal shape here, not the exception.
  it('handles a long sparse history without collapsing it', () => {
    const days = Array.from({ length: 200 }, (_, i) => BASE + i * 24 * HOUR);

    expect(runStartTimestamps(days)).toHaveLength(200);
  });

  it('keeps a run that crosses midnight as one', () => {
    const ticks = [Date.UTC(2026, 4, 10, 22, 0), Date.UTC(2026, 4, 10, 23, 30), Date.UTC(2026, 4, 11, 0, 45)];

    expect(runStartTimestamps(ticks)).toEqual([ticks[0]]);
  });

  // Every tick must fall inside some reconciled window, or the backfill silently skips
  // climbs. Each start covers ticks up to the next start.
  it('covers every tick — no climb falls between two runs', () => {
    const ticks = [
      BASE,
      BASE + 30 * MINUTE,
      BASE + 9 * HOUR,
      BASE + 9 * HOUR + 5 * MINUTE,
      BASE + 40 * HOUR,
      BASE + 40 * HOUR + 90 * MINUTE,
    ];

    const starts = runStartTimestamps(ticks);

    for (const tick of ticks) {
      const owning = [...starts].reverse().find((start) => start <= tick);
      expect(owning).toBeDefined();
      // and the tick is within one gap of its run's previous tick, by construction
      expect(tick - owning!).toBeGreaterThanOrEqual(0);
    }
    expect(starts).toEqual([BASE, BASE + 9 * HOUR, BASE + 40 * HOUR]);
  });
});
