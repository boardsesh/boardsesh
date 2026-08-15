// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * A statement budget for the climb front door.
 *
 * The crawl surface W-23 submits is six figures of climb URLs, so the number of
 * Postgres round trips one cold render costs is a load-bearing number, not an
 * implementation detail. This counts them and asserts the alias lookup and the
 * climb select stay strictly sequential (one connection at a time), so nobody
 * re-inflates the fan-out without the budget going red.
 */
const { mockSqlTag, rowsFromResultMock, inFlight } = vi.hoisted(() => {
  const inFlight = { current: 0, max: 0 };
  const mockSqlTag = vi.fn(() => {
    inFlight.current += 1;
    inFlight.max = Math.max(inFlight.max, inFlight.current);
    return new Promise((resolve) => {
      setTimeout(() => {
        inFlight.current -= 1;
        resolve([]);
      }, 0);
    });
  });
  const rowsFromResultMock = <T>(result: unknown): T[] => {
    if (Array.isArray(result)) return result as T[];
    throw new TypeError('Expected postgres-js query result to be a row array');
  };
  return { mockSqlTag, rowsFromResultMock, inFlight };
});

vi.mock('server-only', () => ({}));

vi.mock('next/cache', () => ({
  unstable_cache:
    <T extends (...args: unknown[]) => unknown>(fn: T) =>
    (...args: Parameters<T>) =>
      fn(...args),
}));

vi.mock('@/app/lib/db/db', () => ({
  sql: mockSqlTag,
  rowsFromResult: rowsFromResultMock,
}));

import { getClimb, getClimbStatsForAllAngles } from '../queries';

const params = {
  board_name: 'kilter' as const,
  layout_id: 8,
  size_id: 10,
  set_ids: [1, 2],
  angle: 40,
  climb_uuid: 'climb-uuid-budget',
};

describe('climb front door statement budget', () => {
  beforeEach(() => {
    mockSqlTag.mockClear();
    inFlight.current = 0;
    inFlight.max = 0;
  });

  it('getClimb costs exactly two statements', async () => {
    await getClimb(params);
    expect(mockSqlTag).toHaveBeenCalledTimes(2);
  });

  it('getClimb runs its alias lookup and climb select sequentially', async () => {
    await getClimb(params);
    // The climb select needs the alias result, so max concurrency is 1. If this
    // ever becomes 2 the two statements were fired together against different
    // uuids — the alias resolution would be silently dropped.
    expect(inFlight.max).toBe(1);
  });

  it('getClimbStatsForAllAngles costs exactly one statement', async () => {
    await getClimbStatsForAllAngles(params);
    expect(mockSqlTag).toHaveBeenCalledTimes(1);
  });

  it('a full climb-page data pass costs exactly three statements', async () => {
    // Mirrors the page: the climb first (the redirect branch needs its name),
    // then the angle table alongside the two backend calls.
    await getClimb(params);
    await getClimbStatsForAllAngles(params);

    expect(mockSqlTag).toHaveBeenCalledTimes(3);
  });
});
