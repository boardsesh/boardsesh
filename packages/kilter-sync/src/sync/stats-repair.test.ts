import { beforeEach, describe, expect, it, vi } from 'vitest';
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
        onConflictDoUpdate: vi.fn(async () => undefined),
      };
    }),
  }));

  const db = { select, execute, insert, transaction: vi.fn() };
  db.transaction.mockImplementation(async (cb: (tx: typeof db) => Promise<unknown>) => cb(db));

  return {
    db,
    insertValues,
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
        kilterAscensionistCount: 17,
        ascensionistCount: 17,
      },
    ]);
  });
});
