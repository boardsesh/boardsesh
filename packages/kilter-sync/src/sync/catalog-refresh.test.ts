import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boardClimbs,
  boardClimbAliases,
  boardPlacements,
  kilterCatalogSourceStats,
  kilterCatalogDeferred,
} from '@boardsesh/db/schema';
import fixture from '../api/__fixtures__/catalog-delta.json';
import type { KilterCatalogClimb, KilterCatalogDeltaRecord } from '../api/kilter-rest';
import { KilterApiError } from '../api/errors';
import type { SyncKilterCatalogArgs, KilterCatalogSummary } from './catalog-sync';
import { buildCatalogScopes, catalogRefreshMode, refreshKilterCatalog } from './catalog-refresh';

const mocks = vi.hoisted(() => ({
  delta: vi.fn(),
  climbs: vi.fn(),
  stats: vi.fn(),
  engine: vi.fn(),
  checkpoint: vi.fn(),
  start: vi.fn(),
  complete: vi.fn(),
  apply: vi.fn(),
  replay: vi.fn(),
  finalize: vi.fn(),
}));
vi.mock('../api/kilter-rest', () => ({
  fetchCatalogDelta: mocks.delta,
  fetchLayoutClimbs: mocks.climbs,
  fetchLayoutClimbStats: mocks.stats,
}));
vi.mock('./catalog-sync', () => ({ syncFullKilterCatalog: mocks.engine }));
vi.mock('./layout-resolver', () => ({ buildLayoutResolver: async () => ({ resolve: () => 1 }) }));
vi.mock('./catalog-source-stats', () => ({
  applyCatalogSourceStats: mocks.apply,
  replayCachedCatalogStats: mocks.replay,
  finalizeCatalogSourceBaseline: mocks.finalize,
}));
vi.mock('./catalog-control', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./catalog-control')>()),
  readCatalogCheckpoint: mocks.checkpoint,
  startCatalogBaseline: mocks.start,
  completeCatalogCheckpoint: mocks.complete,
  withCatalogWriterLease: async (
    args: SyncKilterCatalogArgs,
    callback: (lease: {
      write: <Result>(work: (database: SyncKilterCatalogArgs['db']) => Promise<Result>) => Promise<Result>;
      ownerId: string;
      signal: AbortSignal;
    }) => Promise<unknown>,
  ) =>
    callback({
      write: (work) => work(args.db),
      ownerId: 'writer',
      signal: args.signal ?? new AbortController().signal,
    }),
}));

const layout = {
  productLayoutUuid: '27',
  productName: 'Kilter Board Original',
  edgeLeft: 0,
  edgeRight: 10000,
  edgeBottom: 0,
  edgeTop: 10000,
  isListed: true,
};
const reference = { products: [], productLayouts: [layout], holds: [], difficultyGrades: [], gyms: [], walls: [] };
const now = new Date('2026-11-08T10:00:00.000Z');
const complete = {
  baselineCompletedAt: new Date('2026-11-07T00:00:00Z'),
  confirmedThrough: new Date('2026-11-08T09:30:00Z'),
};
function climb(): KilterCatalogClimb {
  return { ...fixture.bootstrapRows[0], productLayoutUuid: '27', isListed: true, isDeleted: false, origin: null };
}
function summary(): KilterCatalogSummary {
  return {
    gripsLayoutsProcessed: 1,
    layoutsUnmapped: 0,
    climbsSeen: 0,
    climbsUnmapped: 0,
    canonicalsInserted: 0,
    aliasesUpserted: 0,
    statsUpserted: 0,
    statsWritten: 0,
    selfAliasesBackfilled: 0,
    canonicalsRelisted: 0,
    relistsBlockedByDeletionHistory: 0,
    climbsRerouted: 0,
    skipsRecorded: 0,
    skipsResolved: 0,
    skipsWriteFailed: false,
    locations: null,
    deletions: {
      reported: 0,
      aliasDeletes: 0,
      softDeletes: 0,
      protectedUserAuthored: 0,
      skippedForeignSource: 0,
      skippedCanonicalWithAliases: 0,
      alreadyUnlisted: 0,
      directUuidSoftDeletes: 0,
      unknown: 0,
      applied: false,
      appliedThisRun: 0,
      remaining: 0,
      refused: false,
    },
  };
}

function harness(
  deferred: unknown[] = [],
  identities: unknown[] = [],
  aliases: unknown[] = [],
  sourceStats: unknown[] = [],
) {
  const writes: Array<{ table: unknown; rows: unknown }> = [];
  function selection(rows: unknown[]) {
    return Object.assign(Promise.resolve(rows), {
      where: () => selection(rows),
      orderBy: () => Promise.resolve(rows),
    });
  }
  const database = {
    select: () => ({
      from: (table: unknown) =>
        selection(
          table === kilterCatalogDeferred
            ? deferred
            : table === boardClimbs
              ? identities
              : table === boardClimbAliases
                ? aliases
                : table === kilterCatalogSourceStats
                  ? sourceStats
                  : table === boardPlacements
                    ? []
                    : [],
        ),
    }),
    insert: (table: unknown) => ({
      values: (rows: unknown) => {
        writes.push({ table, rows });
        return { onConflictDoUpdate: async () => {} };
      },
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  };
  return {
    args: {
      db: database as unknown as SyncKilterCatalogArgs['db'],
      tokenProvider: async () => 'token',
      reference,
      mode: 'auto' as const,
    },
    writes,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.checkpoint.mockResolvedValue(complete);
  mocks.delta.mockResolvedValue([]);
  mocks.climbs.mockResolvedValue([]);
  mocks.stats.mockResolvedValue([]);
  mocks.apply.mockResolvedValue({ sent: 0, written: 0 });
  mocks.replay.mockResolvedValue({ sent: 0, written: 0 });
  mocks.engine.mockImplementation(async (args: SyncKilterCatalogArgs) => {
    args.signal?.throwIfAborted();
    for (const productLayout of args.reference!.productLayouts) {
      const climbs = await args.catalogIO!.climbs(productLayout.productLayoutUuid);
      const stats = await args.catalogIO!.stats(productLayout.productLayoutUuid);
      await args.catalogIO!.applyStats(stats.map((stat) => ({ stat, canonicalUuid: stat.climbUuid })));
      args.catalogIO!.acceptedClimbs?.(climbs.map((row) => row.climbUuid.toLowerCase()));
    }
    return summary();
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('catalog refresh orchestration', () => {
  it('consumes an empty overlapping delta without a full catalog download', async () => {
    const { args } = harness();
    await refreshKilterCatalog(args);
    expect(mocks.climbs).not.toHaveBeenCalled();
    expect(mocks.stats).not.toHaveBeenCalled();
    expect(mocks.delta).toHaveBeenCalledWith(
      'token',
      expect.objectContaining({ lastUpdatedAt: '2026-11-08T09:25:00.000Z' }),
      expect.any(AbortSignal),
    );
    expect(mocks.complete).toHaveBeenCalledWith(expect.any(Function), expect.any(Object), now, { baseline: false });
    expect(mocks.complete.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.replay.mock.invocationCallOrder[0]);
  });

  it('uses full baseline start plus overlap, then certifies delta request start', async () => {
    mocks.checkpoint.mockResolvedValue(null);
    mocks.climbs.mockImplementation(async () => {
      vi.setSystemTime(new Date(now.getTime() + 60_000));
      return [];
    });
    mocks.stats.mockImplementation(async () => {
      vi.setSystemTime(new Date(now.getTime() + 120_000));
      return [];
    });
    mocks.delta.mockImplementation(async () => {
      vi.setSystemTime(new Date(now.getTime() + 180_000));
      return [];
    });
    const { args } = harness();
    await refreshKilterCatalog(args);
    expect(mocks.start).toHaveBeenCalledWith(expect.any(Function), expect.any(Object), now);
    expect(mocks.delta).toHaveBeenCalledWith(
      'token',
      expect.objectContaining({ lastUpdatedAt: '2026-11-08T09:55:00.000Z' }),
      expect.any(AbortSignal),
    );
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Object),
      new Date(now.getTime() + 120_000),
      { baseline: true },
    );
  });

  it.each(['delta', 'engine', 'replay'] as const)('does not advance checkpoints after %s failure', async (phase) => {
    mocks[phase].mockRejectedValue(new Error(`failed ${phase}`));
    const { args } = harness();
    await expect(refreshKilterCatalog(args)).rejects.toThrow(`failed ${phase}`);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.climbs).not.toHaveBeenCalled();
  });

  it('failed source-stat batches leave every checkpoint unchanged', async () => {
    const source = climb();
    mocks.delta.mockResolvedValue([
      {
        climb: source,
        raw: source,
        stat: {
          climbUuid: source.climbUuid,
          angle: 40,
          ascentCount: 12,
          currentDifficultyId: 20,
          difficultyAverage: 20,
          qualityAverage: 3,
          faUsername: null,
          faAt: null,
        },
      },
    ]);
    mocks.apply.mockRejectedValue(new Error('source transaction rolled back'));
    await expect(refreshKilterCatalog(harness().args)).rejects.toThrow('source transaction rolled back');
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('quarantines cached canonical conflicts even on a newly introduced angle', async () => {
    const source = climb();
    const statistic = {
      climbUuid: source.climbUuid,
      angle: 45,
      ascentCount: 99,
      currentDifficultyId: 20,
      difficultyAverage: 20,
      qualityAverage: 3,
      faUsername: null,
      faAt: null,
    };
    mocks.delta.mockResolvedValue([{ climb: source, stat: statistic, raw: { ...source, derivativeAngle: 45 } }]);
    const { args, writes } = harness(
      [],
      [],
      [],
      [{ sourceUuid: source.climbUuid.toLowerCase(), angle: 40, canonicalUuid: 'another-canonical' }],
    );
    await refreshKilterCatalog(args);
    expect(mocks.apply.mock.calls.every(([, entries]) => entries.length === 0)).toBe(true);
    const deferredWrite = writes.find((write) => write.table === kilterCatalogDeferred);
    expect(deferredWrite?.rows).toMatchObject([
      {
        sourceUuid: source.climbUuid.toLowerCase(),
        payload: {
          climb: source,
          stats: [statistic],
          conflicts: [{ cachedCanonicals: ['another-canonical'] }],
        },
      },
    ]);
    expect(mocks.climbs).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalled();
  });

  it('counts preflight time against the ten-minute incremental execution cap', async () => {
    mocks.checkpoint.mockImplementation(async () => {
      vi.setSystemTime(new Date(now.getTime() + 10 * 60_000));
      return complete;
    });
    await expect(refreshKilterCatalog(harness().args)).rejects.toThrow('Catalog execution budget exhausted');
    expect(mocks.delta).not.toHaveBeenCalled();
    expect(mocks.climbs).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('refreshes a rejected token once without changing incremental transport', async () => {
    mocks.delta.mockRejectedValueOnce(new KilterApiError('unauthorized', 'expired', 401)).mockResolvedValueOnce([]);
    const tokenProvider = vi.fn().mockResolvedValueOnce('expired').mockResolvedValueOnce('refreshed');
    await refreshKilterCatalog({ ...harness().args, tokenProvider });
    expect(tokenProvider).toHaveBeenCalledTimes(2);
    expect(mocks.delta.mock.calls.map(([token]) => token)).toEqual(['expired', 'refreshed']);
    expect(mocks.climbs).not.toHaveBeenCalled();
  });

  it('does not certify a baseline whose backlog write failed', async () => {
    mocks.checkpoint.mockResolvedValue(null);
    mocks.engine.mockResolvedValue({ ...summary(), skipsWriteFailed: true });
    await expect(refreshKilterCatalog(harness().args)).rejects.toThrow('backlog did not persist');
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('keeps partial full imports outside checkpoint certification', async () => {
    await refreshKilterCatalog({ ...harness().args, layoutUuids: ['27'] });
    expect(mocks.climbs).toHaveBeenCalled();
    expect(mocks.delta).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('preserves complete raw unknown-layout records before checkpoint publication', async () => {
    const source = { ...climb(), productLayoutUuid: 'unmapped' };
    const raw = { ...source, officialKilterDifficulty: 22 };
    mocks.delta.mockResolvedValue([{ climb: source, raw, stat: null } satisfies KilterCatalogDeltaRecord]);
    const { args, writes } = harness();
    await refreshKilterCatalog(args);
    expect(writes).toContainEqual({
      table: kilterCatalogDeferred,
      rows: [
        expect.objectContaining({
          sourceUuid: source.climbUuid.toLowerCase(),
          payload: expect.objectContaining({ climb: source, raw }),
        }),
      ],
    });
    expect(mocks.complete).toHaveBeenCalled();
  });

  it('replays deferred metadata-only climbs even after an empty delta', async () => {
    const source = climb();
    const { args } = harness([{ sourceUuid: source.climbUuid.toLowerCase(), payload: { climb: source, stats: [] } }]);
    await refreshKilterCatalog(args);
    const engineArgs = mocks.engine.mock.calls[0][0] as SyncKilterCatalogArgs;
    await expect(engineArgs.catalogIO!.climbs('27')).resolves.toEqual([source]);
  });

  it('cancellation never falls back to a full download or advances progress', async () => {
    const controller = new AbortController();
    const reason = new Error('attempt lost');
    mocks.delta.mockImplementation(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(refreshKilterCatalog({ ...harness().args, signal: controller.signal })).rejects.toBe(reason);
    expect(mocks.climbs).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('defers cross-layout aliases rather than applying their source statistics', async () => {
    const source = climb();
    mocks.delta.mockResolvedValue([{ climb: source, raw: source, stat: null }]);
    const { args, writes } = harness(
      [],
      [{ uuid: 'canonical', layoutId: 2 }],
      [{ aliasUuid: source.climbUuid, canonicalUuid: 'canonical' }],
    );
    await refreshKilterCatalog(args);
    const engineArgs = mocks.engine.mock.calls[0][0] as SyncKilterCatalogArgs;
    await expect(engineArgs.catalogIO!.climbs('27')).resolves.toEqual([]);
    expect(writes).toHaveLength(1);
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});

describe('catalog scope and mode selection', () => {
  it('deduplicates identical edges and invalidates changed mappings or placements', () => {
    const initial = buildCatalogScopes([{ ...layout, layoutId: 1 }]);
    const duplicates = buildCatalogScopes([
      { ...layout, layoutId: 1 },
      { ...layout, productLayoutUuid: '28', layoutId: 1 },
    ]);
    expect(duplicates).toHaveLength(1);
    expect(buildCatalogScopes([{ ...layout, layoutId: 2 }])[0].mappingVersion).not.toBe(initial[0].mappingVersion);
    expect(buildCatalogScopes([{ ...layout, layoutId: 1 }], [42])[0].mappingVersion).not.toBe(
      initial[0].mappingVersion,
    );
  });

  it('requires complete baselines, chooses weekly full and never silently falls back explicit incremental', () => {
    expect(catalogRefreshMode('auto', [null], now.getTime())).toBe('full');
    expect(catalogRefreshMode('auto', [complete], now.getTime())).toBe('incremental');
    expect(
      catalogRefreshMode('auto', [{ ...complete, baselineCompletedAt: new Date('2026-10-01') }], now.getTime()),
    ).toBe('full');
    expect(() => catalogRefreshMode('incremental', [null], now.getTime())).toThrow('complete baseline');
  });
});
