// #5302: a board_data page write that loses the SQLite write lock used to throw
// straight out of `upsertDocuments` → `syncTable` → `pullSync`, aborting the WHOLE
// cycle. Nothing downstream of the losing page ran: no checkpoint advanced, no
// `scope-complete:` marker was written, and the climber's downloaded board stayed
// where the previous cycle left it until the scheduler's next 30s wake — which met
// the same contention and aborted again ("Waiting to download").
//
// The error shape below is the real one, copied from Sentry BOARDSESH-CW: expo's
// `runAsync` finalizes its statement in a `finally`, and `sqlite3_finalize` re-reports
// the step's SQLITE_BUSY, so the throw that escapes names `finalizeAsync` and carries
// `database is locked` only on its `cause`. Using the real shape is load-bearing —
// the ladder's `shouldRetry` is `isDatabaseLockedError`, which has to walk that cause.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OfflineDatabase, QueryInvalidator } from '../../database';

vi.mock('../checkpoints', async () => ({
  ...(await vi.importActual<typeof import('../checkpoints')>('../checkpoints')),
  getCheckpoint: vi.fn().mockResolvedValue(null),
  setCheckpoint: vi.fn().mockResolvedValue(undefined),
  markScopeDownloadComplete: vi.fn().mockResolvedValue(undefined),
  isScopeDownloadComplete: vi.fn().mockResolvedValue(false),
  markScopeDownloadStarted: vi.fn().mockResolvedValue(undefined),
  isScopeDownloadStarted: vi.fn().mockResolvedValue(false),
  ensureScopeDownloadStartedAt: vi.fn(async (_db: unknown, _scopeKey: string, nowMs: number) => nowMs),
  rewindDeletionsCheckpoint: vi.fn().mockResolvedValue(undefined),
}));

import { pullSync } from '../pull-client';
import { markScopeDownloadComplete } from '../checkpoints';
import { setSigningOut, setBackgrounded } from '../../mutation-queue/drainer';
import { TABLE_CONFIGS } from '../table-config';

/**
 * The exact two-level error expo-sqlite raises on iOS when a statement's step
 * returned SQLITE_BUSY (Sentry BOARDSESH-CW, 717 events / 264 users in 30 days on
 * `phase:board_data`). The outer message says nothing about locking; only the cause
 * does.
 */
function busyError(): Error {
  return new Error(
    "FunctionCallException: Calling the 'finalizeAsync' function has failed (at ExpoModulesCore/AsyncFunctionDefinition.swift:123)",
    {
      cause: new Error('SQLiteErrorException: Error code 5: database is locked (at ExpoSQLite/SQLiteModule.swift:471)'),
    },
  );
}

type Write = { sql: string; params: unknown[] };

/**
 * A database whose exclusive transactions lose the write lock the first
 * `lockedAttempts` times a statement touches `lockedTable`, then behave normally.
 *
 * Faithful to expo on the two points the fix depends on: the throw comes from the
 * statement (not from the wrapper), and the wrapper discards everything the failed
 * task staged — `withExclusiveTransactionAsync` rolls the transaction back, so a
 * retry must be able to re-run every statement in it.
 */
function createContendedDatabase(options: { lockedTable: string; lockedAttempts: number }) {
  const committedWrites: Write[] = [];
  // Every statement each transaction issued, in order, so a test can assert WHEN
  // the write lock was taken relative to the task's own first statement.
  const transactionStatements: string[][] = [];
  let remainingLocks = options.lockedAttempts;
  let transactions = 0;

  const db = {
    runAsync: vi.fn(async (sql: string, params: unknown[]) => {
      committedWrites.push({ sql, params });
      return { changes: 0, lastInsertRowId: 0 };
    }),
    execAsync: vi.fn(async () => {}),
    getAllAsync: vi.fn().mockResolvedValue([]),
    getFirstAsync: vi.fn().mockResolvedValue(null),
    withExclusiveTransactionAsync: vi.fn(async (task: (txn: unknown) => Promise<void>) => {
      transactions += 1;
      const staged: Write[] = [];
      const statements: string[] = [];
      transactionStatements.push(statements);
      const txn = {
        execAsync: vi.fn(async (sql: string) => {
          statements.push(sql);
        }),
        runAsync: vi.fn(async (sql: string, params: unknown[]) => {
          statements.push(sql);
          if (remainingLocks > 0 && sql.includes(options.lockedTable)) {
            remainingLocks -= 1;
            throw busyError();
          }
          staged.push({ sql, params });
          return { changes: 0, lastInsertRowId: 0 };
        }),
        getAllAsync: vi.fn(async (sql: string) => {
          statements.push(sql);
          return [];
        }),
        getFirstAsync: vi.fn(async (sql: string) => {
          statements.push(sql);
          return null;
        }),
      };
      await task(txn);
      committedWrites.push(...staged);
    }),
  } as unknown as OfflineDatabase;

  return {
    db,
    committedWrites,
    transactionStatements,
    lockReleased: () => remainingLocks === 0,
    transactionCount: () => transactions,
  };
}

function createQueryClient(): QueryInvalidator {
  return { invalidateQueries: vi.fn().mockResolvedValue(undefined) } as unknown as QueryInvalidator;
}

const SCOPE_KEY = 'kilter:8:25';
const STATS_PAGE = [
  { climb_uuid: 'climb-1', angle: 40, ascensionist_count: 12 },
  { climb_uuid: 'climb-2', angle: 40, ascensionist_count: 3 },
];

/** Every table serves one page except board_climb_stats, which serves STATS_PAGE. */
function createGraphqlFetch() {
  return vi.fn(async (query: string) => {
    if (query.includes('syncDeletions')) {
      return {
        syncDeletions: { deletions: [], cursor: { updatedAt: '2026-09-08T00:00:00Z', syncSeq: '1' }, hasMore: false },
      };
    }
    const statsQuery = TABLE_CONFIGS.board_climb_stats.queryName;
    if (query.includes(statsQuery)) {
      return {
        [statsQuery]: {
          documents: STATS_PAGE,
          cursor: { updatedAt: '2026-09-08T00:00:00Z', syncSeq: '9' },
          hasMore: false,
        },
      };
    }
    for (const config of Object.values(TABLE_CONFIGS)) {
      if (query.includes(config.queryName)) {
        return {
          [config.queryName]: {
            documents: [],
            cursor: { updatedAt: '2026-09-08T00:00:00Z', syncSeq: '1' },
            hasMore: false,
          },
        };
      }
    }
    throw new Error(`Unexpected query: ${query}`);
  }) as unknown as <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
}

describe('board_data pull under write-lock contention (#5302)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSigningOut(false);
    setBackgrounded(false);
  });

  it('finishes the cycle when a board_climb_stats page loses the lock once', async () => {
    const contended = createContendedDatabase({ lockedTable: 'board_climb_stats', lockedAttempts: 1 });
    const graphqlFetch = createGraphqlFetch();

    await pullSync(contended.db, createQueryClient(), graphqlFetch, { enabledBoards: [SCOPE_KEY] });

    // The contention really happened — otherwise this test proves nothing.
    expect(contended.lockReleased()).toBe(true);
    // ...and the page it hit still landed, on the retry.
    const statsWrites = contended.committedWrites.filter((write) => write.sql.includes('board_climb_stats'));
    expect(statsWrites).toHaveLength(1);
    expect(statsWrites[0].params).toEqual(expect.arrayContaining(['climb-1', 'climb-2']));
    // The user-visible consequence: the scope reached its tail, so local-first
    // search may serve this board instead of showing it as still downloading.
    expect(markScopeDownloadComplete).toHaveBeenCalledWith(contended.db, SCOPE_KEY);
  });

  it('takes the write lock before the transaction runs anything of its own', async () => {
    // Why this ordering is the fix and not decoration (#4332, measured against real
    // SQLite): expo opens the wrapper with a DEFERRED `BEGIN`, which picks its lock
    // from whichever statement runs first. The pull's refresh tail starts with a
    // `getCheckpoint` SELECT, so that transaction became a READ transaction and its
    // later write had to UPGRADE — and SQLite does not run the busy handler on an
    // upgrade, so `busy_timeout` was set and then never consulted. `BEGIN IMMEDIATE`
    // as the transaction's first lock-taking statement is what makes the wait real
    // for every one of these tasks, whatever they start with.
    const contended = createContendedDatabase({ lockedTable: 'never-matches', lockedAttempts: 0 });

    await pullSync(contended.db, createQueryClient(), createGraphqlFetch(), { enabledBoards: [SCOPE_KEY] });

    expect(contended.transactionCount()).toBeGreaterThan(0);
    for (const statements of contended.transactionStatements) {
      expect(statements.slice(0, 3)).toEqual(['PRAGMA busy_timeout = 5000', 'COMMIT', 'BEGIN IMMEDIATE']);
    }
  });

  it('gives up and aborts the cycle when the lock never clears', async () => {
    // The ladder is bounded, not infinite: a genuinely wedged database still
    // surfaces as a failed cycle, so `warnCycleError` keeps reporting the case
    // that needs a human. Only the recovered ones go quiet.
    const contended = createContendedDatabase({ lockedTable: 'board_climb_stats', lockedAttempts: 99 });
    const graphqlFetch = createGraphqlFetch();

    await expect(
      pullSync(contended.db, createQueryClient(), graphqlFetch, { enabledBoards: [SCOPE_KEY] }),
    ).rejects.toThrow(/finalizeAsync/);

    expect(markScopeDownloadComplete).not.toHaveBeenCalled();
  });
});
