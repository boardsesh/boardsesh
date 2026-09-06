import { describe, it, expect, vi } from 'vite-plus/test';
import { SESSION_GAP_MS, expandReconciliationWindow } from '@boardsesh/session-inference';
import { reconciliationStartTimestamps, parseArgs, runBackfill } from '../scripts/backfill-inferred-sessions';
import { db } from '../db/client';
import { logger } from '../utils/logger';
import { parseClimbedAt } from '../services/inferred-sessions/timestamps';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const BASE = Date.UTC(2026, 4, 10, 9, 0, 0);

describe('reconciliationStartTimestamps', () => {
  it('returns nothing for a climber with no ticks', () => {
    expect(reconciliationStartTimestamps([])).toEqual([]);
  });

  it('returns one timestamp for a single run', () => {
    const ticks = [BASE, BASE + 10 * MINUTE, BASE + 25 * MINUTE];

    expect(reconciliationStartTimestamps(ticks)).toEqual([BASE]);
  });

  it('keeps separated runs on the same UTC day together', () => {
    const ticks = [BASE, BASE + 20 * MINUTE, BASE + 10 * HOUR, BASE + 10 * HOUR + 15 * MINUTE];

    expect(reconciliationStartTimestamps(ticks)).toEqual([BASE]);
  });

  it('does not split exactly at the threshold', () => {
    const ticks = [BASE + 12 * HOUR, BASE + 12 * HOUR + SESSION_GAP_MS];

    expect(reconciliationStartTimestamps(ticks)).toEqual([ticks[0]]);
  });

  it('splits one millisecond past the threshold', () => {
    const ticks = [BASE + 12 * HOUR, BASE + 12 * HOUR + SESSION_GAP_MS + 1];

    expect(reconciliationStartTimestamps(ticks)).toEqual(ticks);
  });

  // Years of imported logbook history is the normal shape here, not the exception.
  it('handles a long sparse history without collapsing it', () => {
    const days = Array.from({ length: 200 }, (_, i) => BASE + i * 24 * HOUR);

    expect(reconciliationStartTimestamps(days)).toHaveLength(200);
  });

  it('keeps a run that crosses midnight as one', () => {
    const ticks = [Date.UTC(2026, 4, 10, 22, 0), Date.UTC(2026, 4, 10, 23, 30), Date.UTC(2026, 4, 11, 0, 45)];

    expect(reconciliationStartTimestamps(ticks)).toEqual([ticks[0]]);
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

    const starts = reconciliationStartTimestamps(ticks);
    const inferenceTicks = ticks.map((climbedAt, index) => ({ id: index, climbedAt, sessionId: null }));
    const coveredIds = starts.flatMap((start) =>
      expandReconciliationWindow(inferenceTicks, start, start).map((tick) => tick.id),
    );
    expect(coveredIds).toEqual(inferenceTicks.map((tick) => tick.id));

    expect(starts).toEqual([BASE, BASE + 40 * HOUR]);
  });
});

describe('backfill safety', () => {
  it('rejects invalid or unordered timestamps', () => {
    expect(() => reconciliationStartTimestamps([BASE + HOUR, BASE])).toThrow('ascending');
    expect(() => reconciliationStartTimestamps([NaN])).toThrow('finite');
  });

  it.each([
    ['--user'],
    ['--user', '--apply'],
    ['--limt', '1'],
    ['--limit', '1.5'],
    ['--limit', '-1'],
    ['--progress-every', '0'],
    ['--delay-ms', '2147483648'],
    ['--apply', '--simulate'],
    ['--apply', '--apply'],
    ['--user', 'u', '--limit', '1'],
    ['--user', 'u', '--resume-from', 'v'],
  ])('rejects unsafe arguments %j', (...args: string[]) => {
    expect(() => parseArgs(args)).toThrow();
  });

  it('defaults to dry run and accepts bounded execution', () => {
    expect(parseArgs([]).apply).toBe(false);
    expect(parseArgs(['--limit', '0']).limit).toBe(0);
    expect(parseArgs(['--user', 'u', '--simulate', '--delay-ms', '50'])).toMatchObject({
      userId: 'u',
      simulate: true,
      apply: false,
      delayMs: 50,
    });
  });

  it('parses database timestamps as UTC regardless of the host timezone', () => {
    expect(parseClimbedAt('2026-05-10 09:00:00').getTime()).toBe(BASE);
    expect(parseClimbedAt('2026-05-10T19:00:00+10:00').getTime()).toBe(BASE);
    expect(parseClimbedAt('2026-05-10T09:00:00Z').getTime()).toBe(BASE);
    expect(() => parseClimbedAt('invalid')).toThrow();
  });

  it('returns failure and resumes at the first failed user after later users succeed', async () => {
    const selection = vi.spyOn(db, 'selectDistinct').mockReturnValue({
      from: () => ({ where: () => ({ orderBy: async () => [{ userId: 'a' }, { userId: 'b' }] }) }),
    } as unknown as ReturnType<typeof db.selectDistinct>);
    const ticks = vi
      .spyOn(db, 'select')
      .mockImplementationOnce(() => {
        throw new Error('failed first user');
      })
      .mockReturnValue({
        from: () => ({ where: () => ({ orderBy: async () => [] }) }),
      } as unknown as ReturnType<typeof db.select>);
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    try {
      expect(await runBackfill(parseArgs([]))).toBe(1);
      expect(ticks).toHaveBeenCalledTimes(2);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('--resume-from a'));
    } finally {
      selection.mockRestore();
      ticks.mockRestore();
      warning.mockRestore();
      error.mockRestore();
    }
  });
});
