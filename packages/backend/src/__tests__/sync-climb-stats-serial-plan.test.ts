/**
 * Serial-plan guard coverage for BOTH per-board reference pulls — board_climb_stats
 * and board_climb_grades. They share one helper (`runScopedBoardRefSyncPage`)
 * precisely because syncClimbGrades once built the same correlated-EXISTS scope
 * and ran it on the bare pool with no `SET LOCAL` (#4528), so pin both here.
 *
 * The audience split (#6306) gave that helper a second page shape, for the
 * PROTECTED stream. It has to stay on the guarded transaction handle like the
 * walk, so it is pinned too.
 */
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { publicReferenceClimbSql, referenceFirstAscentSql } from '@boardsesh/db/queries';
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * No sync page decides a climb by an account's privacy settings, an item
 * audience, a follow or a tick: the publication rule reads the row alone.
 */
function expectNoPrivacyLookup(renderedStatement: string): void {
  for (const lookup of ['content_privacy', 'privacy_owner', 'privacy_profile', 'user_follows', 'privacy_fa_tick']) {
    expect(renderedStatement).not.toContain(lookup);
  }
}

function statementParams(statement: unknown): unknown[] {
  return dialect.sqlToQuery(statement as SQL).params;
}

beforeEach(() => {
  vi.clearAllMocks();
  recordedHandles.length = 0;
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
    // Omitting layout/size does not omit the publication rule.
    expect(pageStatement).toContain(`(${publicReferenceClimbSql('bc')} OR bc.user_id = $3)`);
    expectNoPrivacyLookup(pageStatement);
    expect(pageStatement).toContain('FROM board_climbs bc');
    expect(pageStatement).not.toMatch(/\bbc\.layout_id\s*=/);
  });
});

// The PROTECTED stream runs two statements, the guard and a page driven from
// the caller's own climbs, and both must land on the transaction handle.
// `runSyncPage` defaults to the bare pool, so the page is pinned by handle as
// well as by text.
describe.each([
  { resolver: 'syncClimbStats', table: 'board_climb_stats' },
  { resolver: 'syncClimbGrades', table: 'board_climb_grades' },
] as const)('$resolver PROTECTED serial-plan guard', ({ resolver, table }) => {
  const protectedArgs = {
    boardType: 'tension',
    layoutId: 10,
    sizeId: 6,
    audience: 'PROTECTED',
    cursor: null,
    limit: 500,
  } as const;

  it('drives the page from the caller’s own climbs, on the guarded transaction, with nothing counted first', async () => {
    const result = (await syncQueries[resolver](undefined, protectedArgs, connectionContext())) as SyncResult;

    expect(result).toEqual({
      documents: [],
      cursor: { updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' },
      hasMore: false,
    });
    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(database.execute).not.toHaveBeenCalled();
    // The guard, then the page. No threshold decides the shape, so there is no
    // count in between.
    expect(recordedHandles).toEqual(['transaction', 'transaction']);
    expect(renderStatement(transactionDatabase.execute.mock.calls[0][0])).toMatch(SERIAL_PLAN_GUARD);

    const pageStatement = renderStatement(transactionDatabase.execute.mock.calls[1][0]);
    // Climbs first, then one primary-key probe per climb: both subqueries are
    // fenced with OFFSET 0 and the second is LATERAL to the first.
    expect(pageStatement).toMatch(/FROM \(SELECT bc\.uuid FROM board_climbs bc WHERE .* OFFSET 0\) own_climbs/s);
    expect(pageStatement).toMatch(
      new RegExp(
        `CROSS JOIN LATERAL \\(\\s*SELECT own_ref\\.\\* FROM ${table} own_ref\\s+WHERE own_ref\\.board_type = \\$\\d+ AND own_ref\\.climb_uuid = own_climbs\\.uuid\\s+OFFSET 0\\s*\\) ${table}`,
      ),
    );
    // The caller's own climbs that are not public. The whole reference
    // predicate is negated: it arrives parenthesized, so there is exactly one
    // pair around it and none added here.
    expect(pageStatement).toMatch(
      new RegExp(`\\(bc\\.user_id = \\$\\d+ AND NOT ${escapeRegExp(publicReferenceClimbSql('bc'))}\\)`),
    );
    expect(pageStatement).not.toContain('NOT ((');
    expect(statementParams(transactionDatabase.execute.mock.calls[1][0])).toContain('user-1');
    expect(pageStatement).not.toContain(`EXISTS (SELECT 1 FROM board_climbs bc WHERE bc.uuid = ${table}.climb_uuid`);
    expectNoPrivacyLookup(pageStatement);
  });
});

describe('first-ascent columns on a stats page', () => {
  const statsArgs = { boardType: 'tension', layoutId: 10, sizeId: 6, cursor: null, limit: 500 } as const;

  it('are NULL on PROTECTED', async () => {
    await syncQueries.syncClimbStats(undefined, { ...statsArgs, audience: 'PROTECTED' }, connectionContext());

    const pageStatement = renderStatement(transactionDatabase.execute.mock.calls.at(-1)?.[0]);
    expect(pageStatement).toContain('NULL AS fa_username, NULL AS fa_at');
    expectNoPrivacyLookup(pageStatement);
  });

  it.each([undefined, 'REFERENCE'] as const)(
    'follow the one viewer-independent rule the artifact follows (audience: %s)',
    async (audience) => {
      await syncQueries.syncClimbStats(
        undefined,
        audience === undefined ? statsArgs : { ...statsArgs, audience },
        connectionContext(),
      );

      const pageStatement = renderStatement(transactionDatabase.execute.mock.calls.at(-1)?.[0]);
      expect(pageStatement).toContain(referenceFirstAscentSql('board_climb_stats', 'fa_username'));
      expect(pageStatement).toContain(referenceFirstAscentSql('board_climb_stats', 'fa_at'));
      // No name is projected from a tick any more, for any caller.
      expectNoPrivacyLookup(pageStatement);
    },
  );
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

  function expectNoViewer(statement: unknown): void {
    expect(statementParams(statement)).not.toContain('user-1');
    expectNoPrivacyLookup(renderStatement(statement));
  }

  it('syncClimbs filters on the reference predicate alone', async () => {
    await syncQueries.syncClimbs(undefined, referenceArgs, connectionContext());

    expect(database.execute).toHaveBeenCalledTimes(1);
    const pageStatement = database.execute.mock.calls[0][0];
    expect(renderStatement(pageStatement)).toContain(publicReferenceClimbSql('board_climbs'));
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
    expect(renderStatement(pageStatement)).toContain(publicReferenceClimbSql('bc'));
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
