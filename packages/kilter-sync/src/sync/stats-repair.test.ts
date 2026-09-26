import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KilterCatalogStat } from '../api/kilter-rest';
import type { KilterReferencePull } from './reference-pull';
import type { KilterStatsUpsertRow, KilterUpstreamCountPolicy } from './stats-upsert';

const { mockFetchLayoutClimbStats, mockBuildLayoutResolver, mockUpsertKilterStats } = vi.hoisted(() => ({
  mockFetchLayoutClimbStats: vi.fn(),
  mockBuildLayoutResolver: vi.fn(),
  mockUpsertKilterStats: vi.fn(),
}));

// The statement itself is covered by stats-upsert.test.ts (render) and
// stats-upsert.integration.test.ts (real Postgres); here we check what the
// repair hands it.
vi.mock('./stats-upsert', () => ({
  upsertKilterStats: mockUpsertKilterStats,
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
  // Every chunk list handed to upsertKilterStats, with the count policy it asked for.
  const insertValues: KilterStatsUpsertRow[][] = [];
  const policies: KilterUpstreamCountPolicy[] = [];
  mockUpsertKilterStats.mockImplementation(
    async (_db: unknown, rows: KilterStatsUpsertRow[], options: { policy: KilterUpstreamCountPolicy }) => {
      insertValues.push(rows);
      policies.push(options.policy);
      return rows.length;
    },
  );
  const execute = vi.fn(async () => args.executeResults.shift() ?? []);
  const select = vi.fn(() => ({
    from: () => ({
      where: () => Promise.resolve(args.selectResults.shift() ?? []),
      innerJoin: () => ({
        where: () => Promise.resolve(args.selectResults.shift() ?? []),
      }),
    }),
  }));
  const db = { select, execute, transaction: vi.fn() };
  db.transaction.mockImplementation(async (cb: (tx: typeof db) => Promise<unknown>) => cb(db));

  return {
    db,
    insertValues,
    policies,
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
    const { db, insertValues, policies } = createDbShim({
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
        climbUuid: 'canon',
        angle: 40,
        upstreamAscensionistCount: 17,
      },
    ]);
    // The repair may lower a count, so it must not use the catalog's GREATEST.
    expect(policies).toEqual(['authoritative']);
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
    const { db, insertValues } = createDbShim({
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
