// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * The caller-side half of the read deadline.
 *
 * `read-deadline.test.ts` proves the helper bounds a wait and
 * `db-pool-exhaustion.test.ts` proves it against a live Postgres — but both
 * would stay green if a refactor (or a merge that resolved a conflict by keeping
 * the old `await sql\`…\`` form) dropped the wrapper from the front-door reads.
 * This pins the three call sites by name.
 */
const { recordedReads, mockSqlTag } = vi.hoisted(() => ({
  recordedReads: [] as { label: string; ms: number | undefined }[],
  mockSqlTag: vi.fn(async () => []),
}));

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/db/read-deadline', () => ({
  FRONT_DOOR_READ_DEADLINE_MS: 6000,
  DEFAULT_READ_DEADLINE_MS: 6000,
  parseReadDeadlineMs: () => 6000,
  DbReadTimeoutError: class DbReadTimeoutError extends Error {},
  withReadDeadline: async <T>(label: string, pending: PromiseLike<T>, ms?: number) => {
    recordedReads.push({ label, ms });
    return pending;
  },
}));

vi.mock('next/cache', () => ({
  unstable_cache:
    <T extends (...args: unknown[]) => unknown>(fn: T) =>
    (...args: Parameters<T>) =>
      fn(...args),
}));

vi.mock('@/app/lib/db/db', () => ({
  sql: mockSqlTag,
  rowsFromResult: <T>(result: unknown): T[] => (Array.isArray(result) ? (result as T[]) : []),
  getReadDb: vi.fn(() => ({})),
}));

vi.mock('@boardsesh/db/queries', () => ({
  getGradeLabel: vi.fn(() => '6c/V5'),
  searchClimbs: vi.fn(async () => ({ climbs: [], hasMore: false })),
  mapSearchInputToParams: vi.fn((input: unknown) => input),
}));

import { getClimb, getClimbStatsForAllAngles } from '@/app/lib/data/queries';
import { cachedSearchClimbs } from '@/app/lib/db/queries/climbs/search-climbs';
import type { ParsedBoardRouteParameters, SearchRequestPagination } from '@/app/lib/types';

const params = {
  board_name: 'kilter' as const,
  layout_id: 8,
  size_id: 10,
  set_ids: [1, 2],
  angle: 40,
  climb_uuid: 'climb-uuid-wiring',
};

const labels = () => recordedReads.map((read) => read.label);

describe('front-door reads run under a deadline', () => {
  beforeEach(() => {
    recordedReads.length = 0;
    mockSqlTag.mockClear();
  });

  it('bounds the climb select that resolves aliases in its CTE', async () => {
    await getClimb(params);

    expect(labels()).toEqual(['climb-select']);
  });

  it('bounds the all-angles stats read', async () => {
    await getClimbStatsForAllAngles(params);

    expect(labels()).toEqual(['climb-stats-all-angles']);
  });

  it('bounds the list front door search', async () => {
    const listParams: ParsedBoardRouteParameters = {
      board_name: 'kilter',
      layout_id: 8,
      size_id: 10,
      set_ids: [1, 2],
      angle: 40,
    };

    await cachedSearchClimbs(listParams, { page: 0, pageSize: 50 } as SearchRequestPagination, true, undefined, {
      cacheable: true,
    });

    expect(labels()).toEqual(['climb-search']);
  });

  it('gives every climb-page read a budget inside the 6 s ceiling', async () => {
    await getClimb(params);
    await getClimbStatsForAllAngles(params);

    for (const read of recordedReads) {
      expect(read.ms).toBeGreaterThan(0);
      expect(read.ms).toBeLessThanOrEqual(6000);
    }
  });
});
