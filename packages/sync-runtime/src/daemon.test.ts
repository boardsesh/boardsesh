import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DAEMON_OPTIONS,
  getRandomDaemonDelayMs,
  isWithinQuietHours,
  resolveDaemonOptions,
  runDaemonLoop,
} from './daemon';

describe('daemon scheduling', () => {
  it('respects Sydney quiet-hour boundaries', () => {
    const options = resolveDaemonOptions();

    expect(isWithinQuietHours(new Date('2026-06-01T11:59:00.000Z'), options)).toBe(false); // 21:59 AEST
    expect(isWithinQuietHours(new Date('2026-06-01T12:00:00.000Z'), options)).toBe(true); // 22:00 AEST
    expect(isWithinQuietHours(new Date('2026-05-31T20:59:00.000Z'), options)).toBe(true); // 06:59 AEST
    expect(isWithinQuietHours(new Date('2026-05-31T21:00:00.000Z'), options)).toBe(false); // 07:00 AEST
  });

  it('keeps random delay within the configured range inclusive', () => {
    expect(getRandomDaemonDelayMs(1, 15, () => 0)).toBe(60_000);
    expect(getRandomDaemonDelayMs(1, 15, () => 0.999999)).toBe(900_000);
  });

  it('defaults to a 1-15 minute random delay range', () => {
    expect(DEFAULT_DAEMON_OPTIONS.minDelayMinutes).toBe(1);
    expect(DEFAULT_DAEMON_OPTIONS.maxDelayMinutes).toBe(15);
  });

  it('runs a cycle immediately during active hours and then waits before retrying', async () => {
    const controller = new AbortController();
    const cycle = vi.fn(async () => {
      controller.abort();
    });
    const sleeps: number[] = [];

    await runDaemonLoop(cycle, undefined, {
      signal: controller.signal,
      now: () => new Date('2026-06-01T09:00:00.000Z'), // 19:00 AEST
      random: () => 0,
      sleep: async (ms, signal) => {
        sleeps.push(ms);
        if (signal?.aborted) {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        }
      },
    });

    expect(cycle).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([60_000]);
  });

  it('stays alive during quiet hours and rechecks before syncing', async () => {
    const controller = new AbortController();
    const nowValues = [
      new Date('2026-06-01T12:30:00.000Z'), // 22:30 AEST
      new Date('2026-05-31T21:00:00.000Z'), // 07:00 AEST
    ];
    const cycle = vi.fn(async () => {
      controller.abort();
    });
    const sleeps: number[] = [];

    await runDaemonLoop(cycle, undefined, {
      signal: controller.signal,
      now: () => nowValues.shift() ?? new Date('2026-05-31T21:00:00.000Z'),
      random: () => 0,
      sleep: async (ms, signal) => {
        sleeps.push(ms);
        if (signal?.aborted) {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        }
      },
    });

    expect(cycle).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([DEFAULT_DAEMON_OPTIONS.quietPollMs, 60_000]);
  });
});
