// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { getClimbStatsForAllAngles } from '../queries';
import { selectCanonicalClimbAngle } from '../../seo/canonical-climb-angle';
import { buildOgClimbCardIdentity } from '../../seo/og-climb-identity';

const { cacheState, unsafeQuery } = vi.hoisted(() => ({
  cacheState: { serialized: undefined as string | undefined },
  unsafeQuery: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({
  unstable_cache:
    <Arguments extends unknown[], Result>(execute: (...args: Arguments) => Promise<Result>) =>
    async (...args: Arguments): Promise<Result> => {
      if (cacheState.serialized !== undefined) return JSON.parse(cacheState.serialized) as Result;
      const result = await execute(...args);
      // Match Next: a fresh sparse array reaches the caller, but its persisted
      // JSON representation returns null entries on the next request.
      cacheState.serialized = JSON.stringify(result);
      return result;
    },
}));
vi.mock('@/app/lib/db/db', () => ({
  sql: Object.assign(vi.fn(), { unsafe: unsafeQuery }),
  rowsFromResult: <Row>(result: unknown): Row[] => {
    if (!Array.isArray(result)) throw new TypeError('Expected row array');
    return result as Row[];
  },
}));

const validStats = {
  angle: 40,
  ascensionist_count: '12',
  display_difficulty: 20,
  difficulty_id: 20,
};

beforeEach(() => {
  cacheState.serialized = undefined;
  unsafeQuery.mockReset();
});

describe('climb stats cache boundary', () => {
  it('densifies a sparse result on both the fresh and JSON-cached read', async () => {
    const sparseRows: unknown[] = [];
    sparseRows.length = 1;
    sparseRows.push(validStats);
    unsafeQuery.mockResolvedValueOnce(sparseRows);

    for (let request = 0; request < 2; request++) {
      const angleStats = await getClimbStatsForAllAngles('kilter', 'sparse-climb');
      expect(angleStats).toEqual([{ ...validStats, difficulty: '6c/V5' }]);
      const canonicalAngle = selectCanonicalClimbAngle({ boardName: 'kilter', angleStats });
      expect(canonicalAngle).toBe(40);
      expect(buildOgClimbCardIdentity({ name: 'A climb' }, 'kilter', canonicalAngle, angleStats).grade).toBe('6c/V5');
    }
    expect(unsafeQuery).toHaveBeenCalledTimes(1);
    expect(sparseRows.length).toBe(2);
    expect(0 in sparseRows).toBe(false);
  });

  it('drops null and undefined cached entries while retaining valid stats', async () => {
    cacheState.serialized = JSON.stringify([null, undefined, { ...validStats, difficulty: '6c/V5' }]);
    const angleStats = await getClimbStatsForAllAngles('kilter', 'old-cache');
    expect(angleStats).toEqual([{ ...validStats, difficulty: '6c/V5' }]);
    expect(unsafeQuery).not.toHaveBeenCalled();
  });

  it('preserves database failures rather than caching an empty stats list', async () => {
    unsafeQuery.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(getClimbStatsForAllAngles('kilter', 'failed-climb')).rejects.toThrow('database unavailable');
    expect(cacheState.serialized).toBeUndefined();
  });
});
