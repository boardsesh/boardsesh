import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import type { KilterCatalogStat } from '../api/kilter-rest';
import type { KilterStatsUpsertRow } from './stats-upsert';

const { upsert } = vi.hoisted(() => ({ upsert: vi.fn() }));
vi.mock('./stats-upsert', () => ({ upsertKilterStats: upsert }));
import {
  aggregateCatalogSourceStats,
  applyCatalogSourceStats,
  dedupeCatalogSourceStats,
  replayCachedCatalogStats,
  finalizeCatalogSourceBaseline,
  type CatalogSourceStat,
} from './catalog-source-stats';

type CacheRow = {
  sourceUuid: string;
  canonicalUuid: string;
  angle: number;
  payload: KilterCatalogStat;
  scopeKey: string;
  generation: string;
};
function source(
  climbUuid: string,
  ascentCount: number,
  overrides: Partial<KilterCatalogStat> = {},
  canonicalUuid = 'Canonical',
): CatalogSourceStat {
  return {
    canonicalUuid,
    stat: {
      climbUuid,
      angle: 40,
      ascentCount,
      currentDifficultyId: null,
      difficultyAverage: null,
      qualityAverage: null,
      faUsername: null,
      faAt: null,
      ...overrides,
    },
  };
}

function database(
  initial: CatalogSourceStat[] = [],
  existing: Array<{ canonicalUuid: string; angle: number }> = [],
  generation = 'new-baseline',
  deferred: string[] = [],
  protectedCanonicals: string[] = [],
) {
  let cache = new Map<string, CacheRow>(
    dedupeCatalogSourceStats(initial).map((entry) => [
      `${entry.stat.climbUuid}|${entry.stat.angle}`,
      {
        sourceUuid: entry.stat.climbUuid,
        angle: entry.stat.angle,
        canonicalUuid: entry.canonicalUuid,
        payload: entry.stat,
        scopeKey: '',
        generation: '',
      },
    ]),
  );
  const db = {
    select: (columns?: Record<string, unknown>) => ({
      from: (table: Parameters<typeof getTableName>[0]) => ({
        where: () => {
          const tableName = getTableName(table);
          const selected =
            tableName === 'board_climb_aliases'
              ? protectedCanonicals.map((canonicalUuid) => ({ canonicalUuid }))
              : tableName === 'board_climb_stats'
                ? existing
                : tableName === 'kilter_catalog_source_stats'
                  ? columns && Object.keys(columns).length === 1 && 'canonicalUuid' in columns
                    ? [...cache.values()]
                        .filter((entry) => deferred.includes(entry.sourceUuid))
                        .map((entry) => ({ canonicalUuid: entry.canonicalUuid }))
                    : [...cache.values()].map((entry) => ({ ...entry, stat: entry.payload }))
                  : [];
          return Object.assign(Promise.resolve(selected), {
            limit: async (count: number) =>
              [...cache.values()]
                .filter((entry) => entry.generation !== generation && !deferred.includes(entry.sourceUuid))
                .slice(0, count),
          });
        },
      }),
    }),
    selectDistinct: () => ({
      from: () =>
        Object.assign(
          Promise.resolve(
            [...new Set([...cache.values()].map((entry) => entry.canonicalUuid))].map((canonicalUuid) => ({
              canonicalUuid,
            })),
          ),
          {
            where: async () => existing,
          },
        ),
    }),
    insert: () => ({
      values: (rows: CacheRow[]) => ({
        onConflictDoUpdate: async () => {
          for (const entry of rows) cache.set(`${entry.sourceUuid}|${entry.angle}`, entry);
        },
      }),
    }),
  };
  const write = async <Result>(callback: (transaction: typeof db) => Promise<Result>): Promise<Result> => {
    const before = new Map(cache);
    try {
      return await callback(db);
    } catch (error) {
      cache = before;
      throw error;
    }
  };
  return { db, write, cache: () => [...cache.values()] };
}

describe('catalog source statistics', () => {
  beforeEach(() => {
    upsert.mockReset();
    upsert.mockImplementation(async (_transaction: unknown, rows: KilterStatsUpsertRow[]) => rows.length);
  });

  it('replaces mixed-case duplicate layouts once and retains other cached contributors', async () => {
    const { db } = database([source('Canonical', 10, { currentDifficultyId: 20 }), source('alias', 7)]);
    await applyCatalogSourceStats(db as never, [source('ALIAS', 3), source('alias', 3)], {
      completeCoverage: true,
      confirmedAt: '2026-11-08T11:00:00Z',
    });
    expect(upsert.mock.calls[0][1]).toMatchObject([
      { climbUuid: 'Canonical', upstreamAscensionistCount: 13, displayDifficulty: 20 },
    ]);
    expect(upsert.mock.calls[0][2]).toEqual({ policy: 'authoritative', syncedAt: '2026-11-08T11:00:00Z' });
  });

  it('replays overlap without adding counts and permits alias increases and decreases', async () => {
    const { db } = database([source('Canonical', 10)]);
    for (const count of [7, 7, 2, 5]) {
      await applyCatalogSourceStats(db as never, [source('alias', count)], { completeCoverage: true });
    }
    expect(upsert.mock.calls.map((call) => (call[1] as KilterStatsUpsertRow[])[0].upstreamAscensionistCount)).toEqual([
      17, 17, 12, 15,
    ]);
  });

  it('never authorizes a decrease or certifies freshness from incomplete coverage', async () => {
    const { db } = database([source('Canonical', 10)]);
    await applyCatalogSourceStats(db as never, [source('Canonical', 1)], { completeCoverage: false });
    expect(upsert.mock.calls[0][2]).toEqual({ policy: 'raise-only', syncedAt: null });
  });

  it('retains canonical grade precedence regardless of source ordering', () => {
    const entries = [
      source('ZZ-alias', 4, { currentDifficultyId: 26, qualityAverage: 5 }),
      source('Canonical', 3, { currentDifficultyId: 20, qualityAverage: 3 }),
    ];
    for (const ordered of [entries, [...entries].reverse()]) {
      expect([...aggregateCatalogSourceStats(ordered).values()]).toMatchObject([
        { kilterCount: 7, displayDifficulty: 20, qualityAverage: 3, hasOwnRowStats: true },
      ]);
    }
  });

  it('updates existing empty zero rows but does not create an empty angle', async () => {
    const { db } = database([], [{ canonicalUuid: 'Canonical', angle: 40 }]);
    await applyCatalogSourceStats(db as never, [source('Canonical', 0), source('other', 0, { angle: 50 })], {
      completeCoverage: true,
    });
    expect(upsert.mock.calls[0][1]).toMatchObject([
      { climbUuid: 'Canonical', angle: 40, upstreamAscensionistCount: 0 },
    ]);
  });

  it('does not let mixed canonical casing create an absent empty row', async () => {
    const { db } = database([], [{ canonicalUuid: 'Canonical', angle: 40 }]);
    await applyCatalogSourceStats(db as never, [source('source', 0, {}, 'canonical')], { completeCoverage: true });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rolls back cache replacements when their aggregate batch fails', async () => {
    const { write, cache } = database([source('Canonical', 10)]);
    upsert.mockRejectedValue(new Error('aggregate failed'));
    await expect(
      write((transaction) =>
        applyCatalogSourceStats(transaction as never, [source('Canonical', 1)], { completeCoverage: true }),
      ),
    ).rejects.toThrow('aggregate failed');
    expect(cache()[0].payload.ascentCount).toBe(10);
  });

  it('replays cached contributors without fetching provider statistics', async () => {
    const { db, write } = database([source('Canonical', 10), source('alias', 2)]);
    const result = await replayCachedCatalogStats(db as never, write as never, { completeCoverage: true });
    expect(result).toEqual({ sent: 1, written: 1 });
    expect(upsert.mock.calls[0][1]).toMatchObject([{ upstreamAscensionistCount: 12 }]);
  });

  it('zeros stale full-baseline contributors only after coverage, preserving deferred sources', async () => {
    const { db, write, cache } = database([source('missing', 9), source('deferred', 7)], [], 'new-baseline', [
      'deferred',
    ]);
    await finalizeCatalogSourceBaseline(db as never, write as never, 'new-baseline');
    expect(cache().find((entry) => entry.sourceUuid === 'missing')?.payload.ascentCount).toBe(0);
    expect(cache().find((entry) => entry.sourceUuid === 'deferred')?.payload.ascentCount).toBe(7);
    expect(upsert.mock.calls[0][2]).toEqual({ policy: 'raise-only', syncedAt: null });
  });

  it('does not replay freshness when no complete coverage watermark exists', async () => {
    const { db, write } = database([source('Canonical', 10)]);
    expect(
      await replayCachedCatalogStats(db as never, write as never, { completeCoverage: true, freshnessOnly: true }),
    ).toEqual({ sent: 0, written: 0 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('keeps a deferred alias from authorizing decreases or tick absorption on old geometry', async () => {
    const { db } = database(
      [source('Canonical', 10), source('alias', 7)],
      [],
      'new-baseline',
      ['alias'],
      ['Canonical'],
    );
    await applyCatalogSourceStats(db as never, [source('Canonical', 3)], {
      completeCoverage: true,
      confirmedAt: '2026-11-08T12:00:00Z',
    });
    expect(upsert.mock.calls[0][2]).toEqual({ policy: 'raise-only', syncedAt: null });
  });

  it('protects the old cached canonical after a deferred source alias points elsewhere', async () => {
    const { db } = database(
      [source('Canonical', 10), source('alias', 7)],
      [],
      'new-baseline',
      ['alias'],
      ['new-canonical'],
    );
    await applyCatalogSourceStats(db as never, [source('Canonical', 3)], {
      completeCoverage: true,
      confirmedAt: '2026-11-08T12:00:00Z',
    });
    expect(upsert.mock.calls[0][1]).toMatchObject([{ climbUuid: 'Canonical', upstreamAscensionistCount: 10 }]);
    expect(upsert.mock.calls[0][2]).toEqual({ policy: 'raise-only', syncedAt: null });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    'rejects malformed ascent counts before changing the cache: %s',
    async (ascentCount) => {
      const { db, cache } = database([source('Canonical', 10)]);
      await expect(
        applyCatalogSourceStats(db as never, [source('Canonical', ascentCount)], { completeCoverage: true }),
      ).rejects.toThrow('Malformed Kilter source statistic');
      expect(cache()[0].payload.ascentCount).toBe(10);
      expect(upsert).not.toHaveBeenCalled();
    },
  );

  it('rejects conflicting aliases before replacing source statistics', async () => {
    const { db, cache } = database();
    await expect(
      applyCatalogSourceStats(db as never, [source('alias', 1), source('ALIAS', 1, {}, 'other')], {
        completeCoverage: true,
      }),
    ).rejects.toThrow('Conflicting Kilter source mapping');
    expect(cache()).toEqual([]);
  });

  it('rejects a persisted source canonical remap before changing any cache or aggregates', async () => {
    const { db, cache } = database([source('alias', 7), source('Canonical', 10)]);
    await expect(
      applyCatalogSourceStats(db as never, [source('Canonical', 15), source('ALIAS', 2, {}, 'other-canonical')], {
        completeCoverage: true,
      }),
    ).rejects.toThrow('Kilter source canonical mapping conflict: alias|40');
    expect(cache().find((entry) => entry.sourceUuid === 'alias')).toMatchObject({
      canonicalUuid: 'Canonical',
      payload: { ascentCount: 7 },
    });
    expect(cache().find((entry) => entry.sourceUuid === 'canonical')?.payload.ascentCount).toBe(10);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects a new angle that would change the source UUID canonical ownership', async () => {
    const { db, cache } = database([source('alias', 7, { angle: 40 })]);
    await expect(
      applyCatalogSourceStats(db as never, [source('ALIAS', 2, { angle: 45 }, 'other-canonical')], {
        completeCoverage: true,
      }),
    ).rejects.toThrow('Kilter source canonical mapping conflict: alias|40');
    expect(cache()).toHaveLength(1);
    expect(cache()[0]).toMatchObject({ canonicalUuid: 'Canonical', angle: 40, payload: { ascentCount: 7 } });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects conflicting canonical ownership across new source angles within one batch', async () => {
    const { db, cache } = database();
    await expect(
      applyCatalogSourceStats(
        db as never,
        [source('alias', 7, { angle: 40 }), source('ALIAS', 2, { angle: 45 }, 'other-canonical')],
        { completeCoverage: true },
      ),
    ).rejects.toThrow('Conflicting Kilter source mapping');
    expect(cache()).toEqual([]);
    expect(upsert).not.toHaveBeenCalled();
  });
});
