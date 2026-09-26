// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * A statement budget for the climb front door.
 *
 * The crawl surface W-23 submits is six figures of climb URLs, so the number of
 * Postgres round trips one cold render costs is a load-bearing number, not an
 * implementation detail. Alias resolution is part of the climb-select CTE, so
 * one cold climb read must stay one statement and one connection.
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

  it('getClimb resolves aliases and selects the climb in one statement', async () => {
    await getClimb(params);
    expect(mockSqlTag).toHaveBeenCalledTimes(1);
  });

  it('getClimb holds at most one connection', async () => {
    await getClimb(params);
    expect(inFlight.max).toBe(1);
  });

  it('getClimbStatsForAllAngles costs exactly one statement', async () => {
    await getClimbStatsForAllAngles(params);
    expect(mockSqlTag).toHaveBeenCalledTimes(1);
  });

  // The whole-page budget lives in `climb-request-dedupe.test.ts`, where React's
  // `cache` is a real memo. Asserting 2 here would be arithmetic on the two
  // cases above (1 + 1) and would pin the number while being unable to tell the
  // deduped page pass from the un-deduped one — the regression that matters.
});
