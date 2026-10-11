/**
 * Serial-plan guard coverage for BOTH per-board reference pulls — board_climb_stats
 * and board_climb_grades. They share one helper (`runScopedBoardRefSyncPage`)
 * precisely because syncClimbGrades once built the same correlated-EXISTS scope
 * and ran it on the bare pool with no `SET LOCAL` (#4528), so pin both here.
 *
 * The audience split (#6306) gave that helper more statements to run: a
 * candidate count and a second page shape for the PROTECTED stream. Every one of
 * them has to stay on the guarded transaction handle, so each is pinned too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { ConnectionContext, SyncResult } from '@boardsesh/shared-schema';
import { syncQueries } from '../graphql/resolvers/sync/queries';

const { database, transactionDatabase, recordedHandles } = vi.hoisted(() => {
  const recordedHandles: string[] = [];
  const transactionDatabase = {
    execute: vi.fn((_statement: unknown): Promise<Array<Record<string, unknown>>> => {
      recordedHandles.push('transaction');
      return Promise.resolve([]);
    }),
  };
  const database = {
    execute: vi.fn((_statement: unknown): Promise<Array<Record<string, unknown>>> => {
      recordedHandles.push('database');
      return Promise.resolve([]);
    }),
    transaction: vi.fn((callback: (transactionDb: typeof transactionDatabase) => unknown) =>
      callback(transactionDatabase),
    ),
  };
  return { database, transactionDatabase, recordedHandles };
});

vi.mock('../db/client', () => ({ db: database }));

const dialect = new PgDialect();
const SERIAL_PLAN_GUARD = /SET LOCAL max_parallel_workers_per_gather\s*=\s*0/i;

function connectionContext(): ConnectionContext {
  return {
    connectionId: 'sync-stats-serial-plan',
    isAuthenticated: true,
    userId: 'user-1',
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
  } as unknown as ConnectionContext;
}

function renderStatement(statement: unknown): string {
  return dialect.sqlToQuery(statement as SQL).sql;
}

function statementParams(statement: unknown): unknown[] {
  return dialect.sqlToQuery(statement as SQL).params;
}

beforeEach(() => {
  vi.clearAllMocks();
  recordedHandles.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('syncClimbStats serial-plan guard', () => {
  it('runs SET LOCAL before the scoped page query on the same transaction', async () => {
    const result = (await syncQueries.syncClimbStats(
      undefined,
      { boardType: 'tension', layoutId: 10, sizeId: 6, cursor: null, limit: 500 },
      connectionContext(),
    )) as SyncResult;

    expect(result).toEqual({
      documents: [],
      cursor: { updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' },
      hasMore: false,
    });
    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(database.execute).not.toHaveBeenCalled();
    expect(transactionDatabase.execute).toHaveBeenCalledTimes(2);
    expect(recordedHandles).toEqual(['transaction', 'transaction']);
    expect(renderStatement(transactionDatabase.execute.mock.calls[0][0])).toMatch(SERIAL_PLAN_GUARD);
    const pageStatement = renderStatement(transactionDatabase.execute.mock.calls[1][0]);
    expect(pageStatement).toContain('FROM board_climb_stats');
    expect(pageStatement).toContain(
      'EXISTS (SELECT 1 FROM board_climbs bc WHERE bc.uuid = board_climb_stats.climb_uuid',
    );
  });
});

describe('syncClimbGrades serial-plan guard', () => {
  it('runs SET LOCAL before the scoped page query on the same transaction', async () => {
    const result = (await syncQueries.syncClimbGrades(
      undefined,
      { boardType: 'tension', layoutId: 10, sizeId: 6, cursor: null, limit: 500 },
      connectionContext(),
    )) as SyncResult;

    expect(result).toEqual({
      documents: [],
      cursor: { updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' },
      hasMore: false,
    });
    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(database.execute).not.toHaveBeenCalled();
    expect(transactionDatabase.execute).toHaveBeenCalledTimes(2);
    expect(recordedHandles).toEqual(['transaction', 'transaction']);
    expect(renderStatement(transactionDatabase.execute.mock.calls[0][0])).toMatch(SERIAL_PLAN_GUARD);

    const pageStatement = renderStatement(transactionDatabase.execute.mock.calls[1][0]);
    expect(pageStatement).toContain('FROM board_climb_grades');
    expect(pageStatement).toContain(
      'EXISTS (SELECT 1 FROM board_climbs bc WHERE bc.uuid = board_climb_grades.climb_uuid',
    );
  });

  // The guard is deliberately unconditional: a full-table walk of
  // board_climb_grades can pick a parallel plan too, so don't let a future
  // refactor make it depend on the layout/size scope being present.
  it('guards the unscoped board_type-only pull as well', async () => {
    await syncQueries.syncClimbGrades(
      undefined,
      { boardType: 'tension', layoutId: null, sizeId: null, cursor: null, limit: 500 },
      connectionContext(),
    );

    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(database.execute).not.toHaveBeenCalled();
    expect(recordedHandles).toEqual(['transaction', 'transaction']);
    expect(renderStatement(transactionDatabase.execute.mock.calls[0][0])).toMatch(SERIAL_PLAN_GUARD);

    const pageStatement = renderStatement(transactionDatabase.execute.mock.calls[1][0]);
    expect(pageStatement).toContain('FROM board_climb_grades');
    // Omitting layout/size does not omit the climb's current visibility gate.
    expect(pageStatement).toContain('content_privacy');
    expect(pageStatement).toContain('FROM board_climbs bc');
    expect(pageStatement).not.toMatch(/\bbc\.layout_id\s*=/);
  });
});

// The PROTECTED stream runs up to three statements — the guard, a capped
// candidate count, and one of two page shapes — and all of them must land on
// the transaction handle. `runSyncPage` defaults to the bare pool, so a shape
// added without its executor would run unguarded and raise nothing.
describe.each([
  { resolver: 'syncClimbStats', table: 'board_climb_stats' },
  { resolver: 'syncClimbGrades', table: 'board_climb_grades' },
] as const)('$resolver PROTECTED serial-plan guard', ({ resolver, table }) => {
  const CANDIDATE_PREDICATE = '(bc.user_id IS NOT NULL OR bc.is_boardsesh_authored)';
  const protectedArgs = {
    boardType: 'tension',
    layoutId: 10,
    sizeId: 6,
    audience: 'PROTECTED',
    cursor: null,
    limit: 500,
  } as const;

  /** Answer the candidate count with `candidateCount`; the guard before it and the page after it stay empty. */
  function answerCandidateCount(candidateCount: number): void {
    transactionDatabase.execute
      .mockImplementationOnce(() => {
        recordedHandles.push('transaction');
        return Promise.resolve([]);
      })
      .mockImplementationOnce(() => {
        recordedHandles.push('transaction');
        return Promise.resolve([{ candidate_count: candidateCount }]);
      });
  }

  it('counts candidates and drives the page from the protected climbs, all on the guarded transaction', async () => {
    const result = (await syncQueries[resolver](undefined, protectedArgs, connectionContext())) as SyncResult;

    expect(result).toEqual({
      documents: [],
      cursor: { updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' },
      hasMore: false,
    });
    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(database.execute).not.toHaveBeenCalled();
    expect(recordedHandles).toEqual(['transaction', 'transaction', 'transaction']);
    expect(renderStatement(transactionDatabase.execute.mock.calls[0][0])).toMatch(SERIAL_PLAN_GUARD);

    const countStatement = renderStatement(transactionDatabase.execute.mock.calls[1][0]);
    expect(countStatement).toContain('candidate_count');
    expect(countStatement).toContain(CANDIDATE_PREDICATE);
    // Capped one past the default limit, so the count cannot outgrow the page.
    expect(statementParams(transactionDatabase.execute.mock.calls[1][0])).toContain(10_001);

    const pageStatement = renderStatement(transactionDatabase.execute.mock.calls[2][0]);
    // Climbs first, then one primary-key probe per climb: both subqueries are
    // fenced with OFFSET 0 and the second is LATERAL to the first.
    expect(pageStatement).toMatch(/FROM \(SELECT bc\.uuid FROM board_climbs bc WHERE .* OFFSET 0\) protected_climbs/s);
    expect(pageStatement).toMatch(
      new RegExp(
        `CROSS JOIN LATERAL \\(\\s*SELECT protected_ref\\.\\* FROM ${table} protected_ref\\s+WHERE protected_ref\\.board_type = \\$\\d+ AND protected_ref\\.climb_uuid = protected_climbs\\.uuid\\s+OFFSET 0\\s*\\) ${table}`,
      ),
    );
    expect(pageStatement).toContain(CANDIDATE_PREDICATE);
    expect(pageStatement).toContain('NOT (bc.user_id IS NULL AND NOT bc.is_boardsesh_authored AND NOT EXISTS');
    expect(pageStatement).toContain('privacy_owner');
    expect(pageStatement).not.toContain(`EXISTS (SELECT 1 FROM board_climbs bc WHERE bc.uuid = ${table}.climb_uuid`);
  });

  it('walks the reference table in cursor order above the candidate limit, still on the guarded transaction', async () => {
    vi.stubEnv('SYNC_PROTECTED_JOIN_MAX_CLIMBS', '3');
    answerCandidateCount(4);

    await syncQueries[resolver](undefined, protectedArgs, connectionContext());

    expect(database.execute).not.toHaveBeenCalled();
    expect(recordedHandles).toEqual(['transaction', 'transaction', 'transaction']);
    expect(statementParams(transactionDatabase.execute.mock.calls[1][0])).toContain(4);

    const pageStatement = renderStatement(transactionDatabase.execute.mock.calls[2][0]);
    expect(pageStatement).toContain(`FROM ${table}`);
    expect(pageStatement).toContain(`EXISTS (SELECT 1 FROM board_climbs bc WHERE bc.uuid = ${table}.climb_uuid`);
    expect(pageStatement).toContain(CANDIDATE_PREDICATE);
    expect(pageStatement).toContain('NOT (bc.user_id IS NULL AND NOT bc.is_boardsesh_authored AND NOT EXISTS');
    expect(pageStatement).toContain('privacy_owner');
    expect(pageStatement).not.toContain('LATERAL');
  });

  it('drives the page from the climbs at exactly the candidate limit', async () => {
    vi.stubEnv('SYNC_PROTECTED_JOIN_MAX_CLIMBS', '3');
    answerCandidateCount(3);

    await syncQueries[resolver](undefined, protectedArgs, connectionContext());

    expect(renderStatement(transactionDatabase.execute.mock.calls[2][0])).toContain('CROSS JOIN LATERAL');
  });

  it('skips the count and walks when the limit is zero', async () => {
    vi.stubEnv('SYNC_PROTECTED_JOIN_MAX_CLIMBS', '0');

    await syncQueries[resolver](undefined, protectedArgs, connectionContext());

    expect(database.execute).not.toHaveBeenCalled();
    expect(recordedHandles).toEqual(['transaction', 'transaction']);
    expect(renderStatement(transactionDatabase.execute.mock.calls[0][0])).toMatch(SERIAL_PLAN_GUARD);
    expect(renderStatement(transactionDatabase.execute.mock.calls[1][0])).not.toContain('LATERAL');
  });

  it.each(['not-a-number', '-1', '2.5', ''])('falls back to the default limit for %j', async (configured) => {
    vi.stubEnv('SYNC_PROTECTED_JOIN_MAX_CLIMBS', configured);

    await syncQueries[resolver](undefined, protectedArgs, connectionContext());

    expect(statementParams(transactionDatabase.execute.mock.calls[1][0])).toContain(10_001);
  });
});

describe('PROTECTED stats carry no first-ascent projection', () => {
  it.each(['10000', '0'])('with the candidate limit at %s', async (candidateLimit) => {
    vi.stubEnv('SYNC_PROTECTED_JOIN_MAX_CLIMBS', candidateLimit);

    await syncQueries.syncClimbStats(
      undefined,
      { boardType: 'tension', layoutId: 10, sizeId: 6, audience: 'PROTECTED', cursor: null, limit: 500 },
      connectionContext(),
    );

    const pageStatement = renderStatement(transactionDatabase.execute.mock.calls.at(-1)?.[0]);
    expect(pageStatement).toContain('NULL AS fa_username, NULL AS fa_at');
    // The per-row tick lookup the single stream pays for is gone with the name.
    expect(pageStatement).not.toContain('privacy_fa_tick');
  });
});

// REFERENCE is the same for every viewer, so no part of the caller may reach
// the SQL: not the id, and not the follow/profile lookups a viewer check needs.
describe('REFERENCE pulls keep the viewer out of the query', () => {
  const referenceArgs = {
    boardType: 'tension',
    layoutId: 10,
    sizeId: 6,
    audience: 'REFERENCE',
    cursor: null,
    limit: 500,
  } as const;
  const REFERENCE_PREDICATE = 'user_id IS NULL AND NOT';

  function expectNoViewer(statement: unknown): void {
    expect(statementParams(statement)).not.toContain('user-1');
    const rendered = renderStatement(statement);
    expect(rendered).not.toContain('privacy_owner');
    expect(rendered).not.toContain('user_follows');
    expect(rendered).not.toContain('privacy_fa_tick');
  }

  it('syncClimbs filters on the reference predicate alone', async () => {
    await syncQueries.syncClimbs(undefined, referenceArgs, connectionContext());

    expect(database.execute).toHaveBeenCalledTimes(1);
    const pageStatement = database.execute.mock.calls[0][0];
    expect(renderStatement(pageStatement)).toContain(
      `board_climbs.${REFERENCE_PREDICATE} board_climbs.is_boardsesh_authored`,
    );
    expectNoViewer(pageStatement);
  });

  it.each([
    { resolver: 'syncClimbStats', table: 'board_climb_stats' },
    { resolver: 'syncClimbGrades', table: 'board_climb_grades' },
  ] as const)('$resolver walks under the guard with the reference predicate alone', async ({ resolver, table }) => {
    await syncQueries[resolver](undefined, referenceArgs, connectionContext());

    expect(database.execute).not.toHaveBeenCalled();
    expect(recordedHandles).toEqual(['transaction', 'transaction']);
    expect(renderStatement(transactionDatabase.execute.mock.calls[0][0])).toMatch(SERIAL_PLAN_GUARD);
    const pageStatement = transactionDatabase.execute.mock.calls[1][0];
    expect(renderStatement(pageStatement)).toContain(
      `EXISTS (SELECT 1 FROM board_climbs bc WHERE bc.uuid = ${table}.climb_uuid`,
    );
    expect(renderStatement(pageStatement)).toContain(`bc.${REFERENCE_PREDICATE} bc.is_boardsesh_authored`);
    expectNoViewer(pageStatement);
  });

  it('answers a spray wall without a single query, readable or not', async () => {
    for (const resolver of ['syncClimbs', 'syncClimbStats', 'syncClimbGrades'] as const) {
      const cursor = { updatedAt: '2026-01-01T00:00:00.000Z', syncSeq: '7' };
      const page = await syncQueries[resolver](
        undefined,
        { ...referenceArgs, boardType: 'spray', cursor },
        connectionContext(),
      );
      expect(page).toEqual({ documents: [], cursor: { updatedAt: cursor.updatedAt, syncSeq: '7' }, hasMore: false });
    }
    expect(database.execute).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
