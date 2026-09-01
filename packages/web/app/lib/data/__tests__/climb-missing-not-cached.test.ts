// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * A missing climb must not be negatively cached.
 *
 * `getClimb` answers `null` for a row that is not there, and the page turns that
 * into a 404. If that `null` were returned from *inside* `unstable_cache` it
 * would be stored for the full hour, so a climb a crawler reached minutes before
 * its import landed would keep 404-ing until the entry expired. The executor
 * throws instead, and `unstable_cache` does not store rejections.
 *
 * The mock therefore has to behave like the real thing on both paths: memoise a
 * resolved value, store nothing for a rejection.
 */
const { mockSqlTag, cacheStore, rows } = vi.hoisted(() => ({
  mockSqlTag: vi.fn(),
  cacheStore: new Map<string, unknown>(),
  rows: { climbRow: null as unknown },
}));

vi.mock('server-only', () => ({}));

vi.mock('next/cache', () => ({
  unstable_cache:
    <T extends (...args: unknown[]) => Promise<unknown>>(fn: T, keyParts: string[]) =>
    async (...args: Parameters<T>) => {
      const key = `${keyParts.join('|')}::${JSON.stringify(args)}`;
      if (cacheStore.has(key)) return cacheStore.get(key);
      const value = await fn(...args);
      cacheStore.set(key, value);
      return value;
    },
}));

vi.mock('@/app/lib/db/db', () => ({
  sql: mockSqlTag,
  rowsFromResult: <T>(result: unknown): T[] => (Array.isArray(result) ? (result as T[]) : []),
}));

import { getClimb } from '../queries';

const params = {
  board_name: 'kilter' as const,
  layout_id: 8,
  size_id: 10,
  set_ids: [1, 2],
  angle: 40,
  climb_uuid: 'climb-uuid-cache',
};

function queueReads(): void {
  mockSqlTag.mockResolvedValueOnce(rows.climbRow ? [rows.climbRow] : []);
}

describe('missing climbs are not negatively cached', () => {
  beforeEach(() => {
    mockSqlTag.mockReset();
    cacheStore.clear();
    rows.climbRow = null;
  });

  it('re-reads the database on the next request for a climb that was not there', async () => {
    queueReads();
    await expect(getClimb(params)).resolves.toBeNull();

    queueReads();
    await expect(getClimb(params)).resolves.toBeNull();

    // Two statements: two reads, neither of them cached.
    expect(mockSqlTag).toHaveBeenCalledTimes(2);
  });

  it('recovers as soon as the row lands', async () => {
    queueReads();
    await expect(getClimb(params)).resolves.toBeNull();

    rows.climbRow = { uuid: params.climb_uuid, name: 'Freshly Imported', characteristics: null, description: '' };
    queueReads();

    const climb = await getClimb(params);
    expect(climb?.name).toBe('Freshly Imported');
  });

  it('still caches a climb that exists', async () => {
    rows.climbRow = { uuid: params.climb_uuid, name: 'Cached Climb', characteristics: null, description: '' };
    queueReads();
    await getClimb(params);
    await getClimb(params);

    expect(mockSqlTag).toHaveBeenCalledTimes(1);
  });
});
