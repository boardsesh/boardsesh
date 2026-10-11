/**
 * The statements a per-board pull sends when the request carries no `audience`,
 * compared as text against the statements `origin/main` sent before the
 * audience split (#6306) touched the resolvers.
 *
 * The response pins in privacy-backwards-compatibility.test.ts prove the shipped
 * fleet gets the same rows. This proves the stronger thing behind it: the query
 * itself is unchanged, so its plan and its cost are too. The split refactored
 * the helpers every stream shares, and a refactor that reorders a conjunct or
 * drops a qualifier would still return the same rows from a small fixture.
 *
 * ## The fixture
 *
 * `fixtures/sync-no-audience-statements.json` was captured from `origin/main` at
 * 044146ce6e by running the matrix below against that commit's
 * `resolvers/sync/queries.ts`, with the database stubbed exactly as it is here.
 * Regenerate it the same way, and only for a change that is MEANT to alter what
 * an installed client's request runs: check out the old `queries.ts` beside the
 * new one, point this file's import at it, and write `captureStatements()` out.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { ConnectionContext, SyncCursorInput } from '@boardsesh/shared-schema';
import { syncQueries } from '../graphql/resolvers/sync/queries';

type Handle = 'database' | 'transaction';

const { database, sent } = vi.hoisted(() => {
  const sent: Array<{ handle: string; statement: unknown }> = [];
  const recordOn = (handle: string) =>
    vi.fn((statement: unknown): Promise<Array<Record<string, unknown>>> => {
      sent.push({ handle, statement });
      return Promise.resolve([]);
    });
  const transactionDatabase = { execute: recordOn('transaction') };
  const database = {
    execute: recordOn('database'),
    transaction: vi.fn((callback: (transactionDb: typeof transactionDatabase) => unknown) =>
      callback(transactionDatabase),
    ),
  };
  return { database, sent };
});

vi.mock('../db/client', () => ({ db: database }));
// A spray pull first asks whether the caller may read the wall. That probe
// lives in another module, which the test setup has already loaded against the
// real database, so stubbing the client above does not reach it. Answer it
// here instead: "readable" lets a spray request go on to its page statement.
vi.mock('../graphql/resolvers/climbs/spray-read-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../graphql/resolvers/climbs/spray-read-access')>()),
  sprayLayoutIsReadable: () => Promise.resolve(true),
}));

const dialect = new PgDialect();

type Scope = { boardType: string; layoutId?: number; sizeId?: number };

const RESOLVERS = ['syncClimbs', 'syncClimbStats', 'syncClimbGrades'] as const;
// Every shape the scope takes: board-wide, one layout, one layout and size, a
// board whose size is ignored, and a spray wall the caller may read.
const SCOPES: Scope[] = [
  { boardType: 'kilter' },
  { boardType: 'kilter', layoutId: 1 },
  { boardType: 'kilter', layoutId: 1, sizeId: 10 },
  { boardType: 'tension', layoutId: 10, sizeId: 6 },
  { boardType: 'moonboard', layoutId: 2, sizeId: 9 },
  { boardType: 'spray', layoutId: 9001, sizeId: 9001 },
];
// No cursor, a cursor the server issued, and the legacy timestamp shape old
// checkpoints still replay.
const CURSORS: Array<SyncCursorInput | null> = [
  null,
  { updatedAt: '2026-05-01T00:00:00.000Z', syncSeq: '910004' },
  { updatedAt: '2026-05-01 00:00:00.25', syncSeq: '7' },
];
const LIMITS = [1, 500];

type SentStatement = { handle: Handle; sql: string; params: unknown[] };
type CapturedCase = {
  resolver: (typeof RESOLVERS)[number];
  scope: Scope;
  cursor: SyncCursorInput | null;
  limit: number;
  sent: SentStatement[];
};
type StoredCase = Omit<CapturedCase, 'sent'> & {
  sent: Array<{ handle: Handle; statement: number; params: unknown[] }>;
};
type Fixture = { capturedFrom: string; statements: string[]; cases: StoredCase[] };

function connectionContext(): ConnectionContext {
  return {
    connectionId: 'sync-no-audience-statements',
    isAuthenticated: true,
    userId: 'user-1',
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
  } as unknown as ConnectionContext;
}

/** Run the whole matrix with no `audience` key and return what each request sent, in order. */
async function captureStatements(): Promise<CapturedCase[]> {
  const captured: CapturedCase[] = [];
  for (const resolver of RESOLVERS) {
    for (const scope of SCOPES) {
      for (const cursor of CURSORS) {
        for (const limit of LIMITS) {
          sent.length = 0;
          await syncQueries[resolver](
            undefined,
            { layoutId: null, sizeId: null, ...scope, cursor, limit },
            connectionContext(),
          );
          captured.push({
            resolver,
            scope,
            cursor,
            limit,
            sent: sent.map(({ handle, statement }) => {
              const rendered = dialect.sqlToQuery(statement as SQL);
              return { handle: handle as Handle, sql: rendered.sql, params: rendered.params };
            }),
          });
        }
      }
    }
  }
  return captured;
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/sync-no-audience-statements.json', import.meta.url), 'utf8'),
) as Fixture;

beforeEach(() => {
  vi.clearAllMocks();
  sent.length = 0;
});

describe('per-board pulls with no audience send the statements origin/main sent', () => {
  it('covers the same matrix the fixture was captured over', () => {
    expect(fixture.cases).toHaveLength(RESOLVERS.length * SCOPES.length * CURSORS.length * LIMITS.length);
    for (const stored of fixture.cases) {
      // Climbs send one page statement on the pool. Stats and grades send the
      // serial-plan guard and then the page, both on the transaction.
      expect(stored.sent.map((statement) => statement.handle)).toEqual(
        stored.resolver === 'syncClimbs' ? ['database'] : ['transaction', 'transaction'],
      );
    }
  });

  it('sends the same statement text and parameters, on the same handles, in the same order', async () => {
    const captured = await captureStatements();

    expect(captured).toHaveLength(fixture.cases.length);
    for (const [caseIndex, stored] of fixture.cases.entries()) {
      const expected: CapturedCase = {
        resolver: stored.resolver,
        scope: stored.scope,
        cursor: stored.cursor,
        limit: stored.limit,
        sent: stored.sent.map(({ handle, statement, params }) => ({
          handle,
          sql: fixture.statements[statement],
          params,
        })),
      };
      // Whole-case equality, text included: a failure prints the request that
      // drifted beside the statement main sent for it.
      expect(captured[caseIndex]).toEqual(expected);
    }
  });
});
