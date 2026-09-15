import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { ParsedBoardRouteParameters, SearchRequestPagination } from '@/app/lib/types';

// Shared mock state for the fake read-DB. Hoisted so the vi.mock factory below can
// reference it (vi.mock is hoisted above the imports).
const dbMock = vi.hoisted(() => {
  const callOrder: string[] = [];
  const executed: unknown[] = [];
  const selectedFields: Record<string, unknown>[] = [];

  // Stand-in for a drizzle query builder: every chain method returns the same
  // object, and awaiting it records that the aggregate ran — so a test can assert
  // the aggregate executed AFTER the SET LOCAL guard, not before or instead of it.
  const makeBuilder = () => {
    const builder: Record<string, unknown> = {};
    for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'groupBy']) {
      builder[method] = () => builder;
    }
    // A real, spec-compliant thenable: accepts both settle callbacks and returns a
    // genuine Promise, so drizzle's internal `await` can't swallow a rejection.
    builder.then = (
      onFulfilled?: ((value: unknown) => unknown) | null,
      onRejected?: ((reason: unknown) => unknown) | null,
    ) => {
      callOrder.push('aggregate');
      return Promise.resolve([]).then(onFulfilled, onRejected);
    };
    return builder;
  };

  const tx = {
    execute: (statement: unknown) => {
      callOrder.push('execute');
      executed.push(statement);
      return Promise.resolve([]);
    },
    select: (fields: Record<string, unknown>) => {
      selectedFields.push(fields);
      return makeBuilder();
    },
  };

  return {
    callOrder,
    executed,
    selectedFields,
    reset: () => {
      callOrder.length = 0;
      executed.length = 0;
      selectedFields.length = 0;
    },
    dbzRead: {
      transaction: (callback: (transactionDb: typeof tx) => unknown) => callback(tx),
    },
  };
});

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/db/db', () => ({
  dbzRead: dbMock.dbzRead,
  executeRows: vi.fn(() => Promise.resolve([])),
}));

vi.mock('@boardsesh/db/queries', () => ({
  createClimbFilters: () => ({
    getClimbHoldsJoinConditions: () => [],
    getHoldHeatmapClimbStatsConditions: () => [],
    getClimbWhereConditions: () => [],
    getSizeConditions: () => [],
    getClimbStatsConditions: () => [],
    getClimbGradesJoinConditions: () => [],
  }),
}));

vi.mock('@/lib/db/queries/util/table-select', () => ({
  UNIFIED_TABLES: {
    climbs: {},
    climbStats: { ascensionistCount: {}, displayDifficulty: {} },
    climbHolds: { holdId: {}, climbUuid: {}, holdState: {} },
  },
}));

vi.mock('@/app/lib/db/schema', () => ({ boardseshTicks: {} }));

import { getHoldHeatmapData } from '../holds-heatmap';

const PARAMS: ParsedBoardRouteParameters = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 20],
  angle: 40,
};

function makeSearch(overrides: Partial<SearchRequestPagination> = {}): SearchRequestPagination {
  return {
    page: 0,
    pageSize: 20,
    sortBy: 'ascents',
    sortOrder: 'desc',
    settername: [],
    holdsFilter: {},
    zoneBox: null,
    zoneMode: 'allHolds',
    ...overrides,
  } as SearchRequestPagination;
}

const dialect = new PgDialect();
function renderedGuards(): string[] {
  return dbMock.executed.map((statement) => dialect.sqlToQuery(statement as SQL).sql);
}
function renderedTotalAscents(): string {
  const fields = dbMock.selectedFields[0];
  return dialect.sqlToQuery(fields.totalAscents as SQL).sql.toLowerCase();
}
const GUARD_PATTERN = /SET LOCAL max_parallel_workers_per_gather\s*=\s*0/i;

describe('getHoldHeatmapData — DSM parallelism guard (#2378)', () => {
  beforeEach(() => {
    dbMock.reset();
  });

  it('runs the community aggregate inside a transaction that disables per-gather parallelism first', async () => {
    await getHoldHeatmapData(PARAMS, makeSearch(), undefined);

    // The heavy GROUP BY runs inside a transaction, and the very first statement is
    // the parallelism guard — before the aggregate, so no parallel worker can spawn.
    expect(dbMock.callOrder).toEqual(['execute', 'aggregate']);
    expect(renderedGuards().some((statement) => GUARD_PATTERN.test(statement))).toBe(true);
    // Community branch: totalAscents sums ascents, not a per-user distinct climb count.
    expect(renderedTotalAscents()).toContain('sum');
    expect(renderedTotalAscents()).not.toContain('distinct');
  });

  it('runs the personal-progress aggregate inside the same guarded transaction', async () => {
    await getHoldHeatmapData(PARAMS, makeSearch({ hideCompleted: true }), 'user-1');

    expect(dbMock.callOrder).toEqual(['execute', 'aggregate']);
    expect(renderedGuards().some((statement) => GUARD_PATTERN.test(statement))).toBe(true);
    // Personal branch: totalAscents counts the user's distinct climbs per hold.
    expect(renderedTotalAscents()).toContain('count(distinct');
  });
});
