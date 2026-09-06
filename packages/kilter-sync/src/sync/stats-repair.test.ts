import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { KilterCatalogStat } from '../api/kilter-rest';
import type { KilterReferencePull } from './reference-pull';

const { mockFetchLayoutClimbStats, mockBuildLayoutResolver } = vi.hoisted(() => ({
  mockFetchLayoutClimbStats: vi.fn(),
  mockBuildLayoutResolver: vi.fn(),
}));

vi.mock('../api/kilter-rest', async () => {
  const actual = await vi.importActual<typeof import('../api/kilter-rest')>('../api/kilter-rest');
  return {
    ...actual,
    fetchLayoutClimbStats: mockFetchLayoutClimbStats,
  };
});

vi.mock('./layout-resolver', () => ({
  buildLayoutResolver: mockBuildLayoutResolver,
}));

import { repairKilterCatalogStats } from './stats-repair';

type SelectResult = Array<Record<string, unknown>>;
type ExecuteResult = unknown;

function stat(overrides: Partial<KilterCatalogStat> & { climbUuid: string; angle: number; ascentCount: number }) {
  return {
    currentDifficultyId: null,
    difficultyAverage: null,
    qualityAverage: null,
    faUsername: null,
    faAt: null,
    ...overrides,
  };
}

function reference(): KilterReferencePull {
  return {
    products: [],
    holds: [],
    difficultyGrades: [],
    gyms: [],
    walls: [],
    productLayouts: [
      {
        productLayoutUuid: 'layout-a',
        productName: 'Kilter Board Original',
        isListed: true,
        edgeLeft: 0,
        edgeRight: 0,
        edgeBottom: 0,
        edgeTop: 0,
      },
      {
        productLayoutUuid: 'layout-b',
        productName: 'Kilter Board Original',
        isListed: true,
        edgeLeft: 0,
        edgeRight: 0,
        edgeBottom: 0,
        edgeTop: 0,
      },
    ],
  };
}

function createDbShim(args: { selectResults: SelectResult[]; executeResults: ExecuteResult[] }) {
  const insertValues: unknown[] = [];
  // Every `set` object handed to onConflictDoUpdate, so a test can assert on
  // the conflict clause the write actually shipped rather than rebuilding it.
  const conflictSets: Array<Record<string, unknown>> = [];
  const execute = vi.fn(async () => args.executeResults.shift() ?? []);
  const select = vi.fn(() => ({
    from: () => ({
      where: () => Promise.resolve(args.selectResults.shift() ?? []),
      innerJoin: () => ({
        where: () => Promise.resolve(args.selectResults.shift() ?? []),
      }),
    }),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn((values: unknown) => {
      insertValues.push(values);
      return {
        onConflictDoUpdate: vi.fn(async (config: { set?: Record<string, unknown> } | undefined) => {
          if (config?.set != null) conflictSets.push(config.set);
          return undefined;
        }),
      };
    }),
  }));

  const db = { select, execute, insert, transaction: vi.fn() };
  db.transaction.mockImplementation(async (cb: (tx: typeof db) => Promise<unknown>) => cb(db));

  return {
    db,
    insertValues,
    conflictSets,
  };
}

describe('repairKilterCatalogStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildLayoutResolver.mockResolvedValue({
      resolve: vi.fn(() => 1),
    });
    mockFetchLayoutClimbStats.mockImplementation((_token: string, layoutUuid: string) => {
      if (layoutUuid === 'layout-a') {
        return Promise.resolve([
          stat({ climbUuid: 'canon', angle: 40, ascentCount: 12, currentDifficultyId: 20 }),
          stat({ climbUuid: 'alias-b', angle: 40, ascentCount: 5, currentDifficultyId: 20 }),
        ]);
      }
      return Promise.resolve([stat({ climbUuid: 'canon', angle: 40, ascentCount: 12, currentDifficultyId: 20 })]);
    });
  });

  it('dry-runs deduped Kilter counts without writing', async () => {
    const { db, insertValues } = createDbShim({
      selectResults: [[{ uuid: 'canon' }], [{ aliasUuid: 'alias-b', canonicalUuid: 'canon' }]],
      executeResults: [[], [{ changed_rows: '1', max_drop: '12', max_rise: '4' }], [{ rows_to_recompute: '2' }]],
    });

    const summary = await repairKilterCatalogStats({
      db: db as never,
      tokenProvider: async () => 'token',
      reference: reference(),
    });

    expect(summary.applied).toBe(false);
    expect(summary.statsSeen).toBe(3);
    expect(summary.statsDeduped).toBe(1);
    expect(summary.statsUnresolved).toBe(0);
    expect(summary.canonicalStatsComputed).toBe(1);
    expect(summary.changedKilterRows).toBe(1);
    expect(summary.formulaRowsRecomputed).toBe(2);
    expect(summary.maxKilterDrop).toBe(12);
    expect(summary.maxKilterRise).toBe(4);
    expect(insertValues).toHaveLength(0);
  });

  it('applies repaired counts and recomputes materialized totals', async () => {
    const { db, insertValues } = createDbShim({
      selectResults: [[{ uuid: 'canon' }], [{ aliasUuid: 'alias-b', canonicalUuid: 'canon' }]],
      executeResults: [[], [{ changed_rows: '1', max_drop: '12' }], [{ rows_to_recompute: '2' }], { count: 2 }, []],
    });

    const summary = await repairKilterCatalogStats({
      db: db as never,
      tokenProvider: async () => 'token',
      reference: reference(),
      apply: true,
    });

    expect(summary.applied).toBe(true);
    expect(summary.formulaRowsRecomputed).toBe(2);
    expect(insertValues).toHaveLength(1);
    expect(insertValues[0]).toMatchObject([
      {
        boardType: 'kilter',
        climbUuid: 'canon',
        angle: 40,
        upstreamAscensionistCount: 17,
        ascensionistCount: 17,
      },
    ]);
  });

  it('skips an empty Grips angle but preserves a zero-ascent stat with a grade', async () => {
    mockFetchLayoutClimbStats.mockImplementation((_token: string, layoutUuid: string) => {
      if (layoutUuid === 'layout-a') {
        return Promise.resolve([
          stat({
            climbUuid: 'canon',
            angle: 50,
            ascentCount: 0,
            currentDifficultyId: 0,
            difficultyAverage: 0,
            qualityAverage: 0,
          }),
          stat({ climbUuid: 'canon', angle: 40, ascentCount: 0, currentDifficultyId: 20 }),
        ]);
      }
      return Promise.resolve([]);
    });
    const { db, insertValues } = createDbShim({
      selectResults: [[{ uuid: 'canon' }], []],
      executeResults: [[], [], [{ changed_rows: '0' }], [{ rows_to_recompute: '0' }], { count: 0 }, []],
    });

    const summary = await repairKilterCatalogStats({
      db: db as never,
      tokenProvider: async () => 'token',
      reference: reference(),
      apply: true,
    });

    expect(summary.canonicalStatsComputed).toBe(1);
    expect(insertValues).toHaveLength(1);
    expect(insertValues[0]).toMatchObject([
      {
        climbUuid: 'canon',
        angle: 40,
        displayDifficulty: 20,
        upstreamAscensionistCount: 0,
      },
    ]);
  });

  it('reconciles an empty Grips angle to zero when its stats row already exists', async () => {
    mockFetchLayoutClimbStats.mockImplementation((_token: string, layoutUuid: string) => {
      if (layoutUuid !== 'layout-a') return Promise.resolve([]);
      return Promise.resolve([
        stat({
          climbUuid: 'canon',
          angle: 50,
          ascentCount: 0,
          currentDifficultyId: 0,
          difficultyAverage: 0,
          qualityAverage: 0,
        }),
      ]);
    });
    const { db, insertValues, conflictSets } = createDbShim({
      selectResults: [[{ uuid: 'canon' }], []],
      executeResults: [
        [],
        [{ climb_uuid: 'canon', angle: 50 }],
        [{ changed_rows: '1', max_drop: '7' }],
        [{ rows_to_recompute: '0' }],
        { count: 1 },
        [],
      ],
    });

    const summary = await repairKilterCatalogStats({
      db: db as never,
      tokenProvider: async () => 'token',
      reference: reference(),
      apply: true,
    });

    expect(summary.canonicalStatsComputed).toBe(1);
    expect(summary.changedKilterRows).toBe(1);
    expect(summary.maxKilterDrop).toBe(7);
    expect(insertValues).toHaveLength(1);
    expect(insertValues[0]).toMatchObject([
      {
        climbUuid: 'canon',
        angle: 50,
        displayDifficulty: null,
        upstreamAscensionistCount: 0,
      },
    ]);

    // #4798. tick_graded_at means "the stored display_difficulty came from
    // Boardsesh ticks", so it must survive exactly as long as that grade does.
    // This repair COALESCEs display_difficulty, so the marker mirrors it: an
    // incoming NULL (this fixture — Grips shipped no grade) keeps ours AND
    // keeps the marker, so a later tick can still refresh it and a delete can
    // still clear it; a non-NULL grade takes over and clears the marker.
    //
    // A timestamp comparison would be wrong here: this repair stamps
    // upstream_synced_at on every pass, so a gradeless pass would look newer
    // than the marker and freeze a grade we own.
    const [conflictSet] = conflictSets as Array<Record<string, SQL>>;
    expect(conflictSet).toBeDefined();
    const dialect = new PgDialect();
    const render = (fragment: SQL) => dialect.sqlToQuery(fragment).sql.toLowerCase().replace(/\s+/g, ' ').trim();
    expect(render(conflictSet.displayDifficulty)).toBe(
      'coalesce(excluded.display_difficulty, "board_climb_stats"."display_difficulty")',
    );
    expect(render(conflictSet.tickGradedAt)).toBe(
      'case when excluded.display_difficulty is null then "board_climb_stats"."tick_graded_at" else null end',
    );
  });

  it('does not let an existing mixed-case key authorize an absent casing variant', async () => {
    mockBuildLayoutResolver.mockResolvedValue({
      resolve: vi.fn((layoutUuid: string) => (layoutUuid === 'layout-a' ? 1 : 2)),
    });
    mockFetchLayoutClimbStats.mockImplementation((_token: string, layoutUuid: string) =>
      Promise.resolve([
        stat({
          climbUuid: layoutUuid === 'layout-a' ? 'source-a' : 'source-b',
          angle: 50,
          ascentCount: 0,
          currentDifficultyId: 0,
          difficultyAverage: 0,
          qualityAverage: 0,
        }),
      ]),
    );
    const { db, insertValues } = createDbShim({
      selectResults: [
        [{ uuid: 'Canon' }],
        [{ aliasUuid: 'source-a', canonicalUuid: 'Canon' }],
        [{ uuid: 'canon' }],
        [{ aliasUuid: 'source-b', canonicalUuid: 'canon' }],
      ],
      executeResults: [
        [],
        [{ climb_uuid: 'Canon', angle: 50 }],
        [{ changed_rows: '1', max_drop: '7' }],
        [{ rows_to_recompute: '0' }],
        { count: 1 },
        [],
      ],
    });

    const summary = await repairKilterCatalogStats({
      db: db as never,
      tokenProvider: async () => 'token',
      reference: reference(),
      apply: true,
    });

    expect(summary.canonicalStatsComputed).toBe(1);
    expect(insertValues).toHaveLength(1);
    expect(insertValues[0]).toMatchObject([
      {
        climbUuid: 'Canon',
        angle: 50,
        upstreamAscensionistCount: 0,
      },
    ]);
  });
});
