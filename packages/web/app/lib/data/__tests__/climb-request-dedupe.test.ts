// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * `generateMetadata` and the page body both read the climb, and Next renders
 * them concurrently. `unstable_cache` has no in-flight single-flight, so on a
 * cold key both used to miss and duplicate the climb select on the six-figure
 * crawl surface W-23 submits.
 *
 * React's `cache` is a per-render memo in a Server Component but a plain
 * passthrough in the client build vitest resolves, so this file substitutes a
 * real memo for it. That is what makes the dedupe — and the per-request read
 * budget that rides the same scope — assertable at all.
 */
const { mockSqlTag, rowsFromResultMock, deadlineBudgets, clock, requestScopes } = vi.hoisted(() => ({
  mockSqlTag: vi.fn(async () => []),
  rowsFromResultMock: <T>(result: unknown): T[] => (Array.isArray(result) ? (result as T[]) : []),
  deadlineBudgets: [] as number[],
  clock: { now: 1_000_000 },
  /** Every memo the mocked `cache` handed out, so a test can start a fresh request. */
  requestScopes: [] as Map<string, unknown>[],
}));

vi.mock('server-only', () => ({}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    cache: <Args extends unknown[], Result>(fn: (...args: Args) => Result) => {
      const memo = new Map<string, unknown>();
      requestScopes.push(memo);
      return (...args: Args): Result => {
        const key = JSON.stringify(args);
        if (!memo.has(key)) memo.set(key, fn(...args));
        return memo.get(key) as Result;
      };
    },
  };
});

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

vi.mock('@/app/lib/db/read-deadline', () => ({
  FRONT_DOOR_READ_DEADLINE_MS: 6000,
  DEFAULT_READ_DEADLINE_MS: 6000,
  parseReadDeadlineMs: () => 6000,
  DbReadTimeoutError: class DbReadTimeoutError extends Error {},
  withReadDeadline: async <T>(_label: string, pending: PromiseLike<T>, ms: number) => {
    deadlineBudgets.push(ms);
    // Each read costs a second of wall clock, so a shared budget visibly shrinks.
    clock.now += 1000;
    return pending;
  },
}));

import { getClimb, getClimbStatsForAllAngles } from '../queries';

const params = {
  board_name: 'kilter' as const,
  layout_id: 8,
  size_id: 10,
  set_ids: [1, 2],
  angle: 40,
  climb_uuid: 'climb-uuid-dedupe',
};

/** The `/b` tree builds its own params object at each entry point. */
const equivalentParams = { ...params };

function startNewRequest(): void {
  for (const memo of requestScopes) memo.clear();
  deadlineBudgets.length = 0;
}

describe('climb front door per-request dedupe', () => {
  beforeEach(() => {
    mockSqlTag.mockClear();
    clock.now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    startNewRequest();
  });

  it('reads the climb once for two calls with equal primitives', async () => {
    // The two entry points of the `/b` tree build separate objects — the reason
    // the memo keys on primitives rather than on the params object.
    await Promise.all([getClimb(params), getClimb(equivalentParams)]);

    expect(mockSqlTag).toHaveBeenCalledTimes(1);
  });

  it('a full climb-page data pass costs exactly two statements', async () => {
    // Models the route: metadata's read, the body's read, then the angle table.
    await getClimb(params);
    await getClimb(equivalentParams);
    await getClimbStatsForAllAngles(params);

    expect(mockSqlTag).toHaveBeenCalledTimes(2);
  });

  it('still reads a different climb separately', async () => {
    await getClimb(params);
    await getClimb({ ...params, climb_uuid: 'another-climb' });

    expect(mockSqlTag).toHaveBeenCalledTimes(2);
  });

  it('shares one read budget across the request instead of restarting it per statement', async () => {
    await getClimb(params);
    await getClimbStatsForAllAngles(params);

    // Two reads, one budget: the climb gets the full 6 s and the angle table
    // gets what remains. Independent deadlines would make the request ceiling
    // roughly 12 s.
    expect(deadlineBudgets).toEqual([6000, 5000]);
  });

  it('starts a fresh budget on the next request', async () => {
    await getClimb(params);
    expect(deadlineBudgets).toEqual([6000]);

    startNewRequest();

    await getClimb(params);
    expect(deadlineBudgets).toEqual([6000]);
  });
});
