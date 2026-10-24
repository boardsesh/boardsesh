// #5851: the sync cycle's marker writes against a main connection that behaves
// like the phone's — real SQLite over one file, a 5 s busy timeout, and local
// reads that are often mid-step when the engine writes (see
// testing/shared-main-connection.ts for why that state is the normal one).
//
// BOARDSESH-QS is this failure: `NativeStatement.runAsync` → "Error code 5:
// database is locked" in phase `deletions` with nothing processed, i.e. the
// deletions-coverage stamp, an autocommit write on the main connection. SQLite
// fails such a write at once when it has to upgrade a read transaction, so the
// 5 s busy timeout never helps, and one loss ended the whole cycle.
//
// FILE-backed throughout. The in-memory adapter runs its "exclusive"
// transactions on the same connection, which would hide both the upgrade and
// the teardown race below.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueryInvalidator } from '../../database';
import { pullSync } from '../pull-client';
import { isScopeDownloadComplete } from '../checkpoints';
import { getDeletionsCoverageAt } from '../deletions-coverage';
import { isUserDataComplete, USER_DATA_COMPLETE_KEY } from '../local-user-owner';
import { removeBoardScopeData } from '../scope-teardown';
import { BOARD_DATA_TABLES, TABLE_CONFIGS } from '../table-config';
import { runMigrations } from '../../db/migrations';
import { ensureMutationQueueTable } from '../../mutation-queue/schema';
import { beginScopePurge, setSigningOut, __resetDrainerStateForTests } from '../../mutation-queue/drainer';
import { purgeNamespaceKey, type OfflineBoardScope } from '../../offline-board-key';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import { openSharedMainConnection, type SharedMainConnection } from '../../testing/shared-main-connection';
import type { SyncProgress } from '../pull-client';

const SCOPE: OfflineBoardScope = { boardType: 'kilter', layoutId: 8, sizeId: 25 };
const SCOPE_KEY = 'kilter:8:25';
const TAIL_CURSOR = { updatedAt: '2026-09-08T00:00:00Z', syncSeq: '1' };

/** Every resolver at its tail: no deletions, no rows, nothing more to page. */
const graphqlFetch = vi.fn(async (query: string) => {
  if (query.includes('syncDeletions')) {
    return { syncDeletions: { deletions: [], cursor: TAIL_CURSOR, hasMore: false } };
  }
  // Keyed by every query name at once, so a name that is a prefix of another
  // can never hand a table the wrong page.
  return Object.fromEntries(
    Object.values(TABLE_CONFIGS).map((config) => [
      config.queryName,
      { documents: [], cursor: TAIL_CURSOR, hasMore: false },
    ]),
  );
}) as unknown as <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

function queryClient(): QueryInvalidator {
  return { invalidateQueries: vi.fn() } as unknown as QueryInvalidator;
}

let workDir: string;
let transactions: TestSqliteDb;
let shared: SharedMainConnection;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'pull-main-connection-'));
  const filePath = join(workDir, 'client.db');
  transactions = createTestDatabase(filePath);
  await transactions.execAsync('PRAGMA journal_mode = WAL');
  await runMigrations(transactions);
  await ensureMutationQueueTable(transactions);
  shared = openSharedMainConnection(filePath, transactions);
  __resetDrainerStateForTests();
});

afterEach(() => {
  shared.close();
  transactions.close();
  __resetDrainerStateForTests();
  rmSync(workDir, { recursive: true, force: true });
});

describe('sync markers while local reads hold the main connection (#5851)', () => {
  it('finishes the cycle and writes every marker, none of them through the main connection', async () => {
    shared.setReadsInFlight(true);

    await pullSync(shared.db, queryClient(), graphqlFetch, { enabledBoards: [SCOPE_KEY] });

    expect(await getDeletionsCoverageAt(transactions)).not.toBeNull();
    expect(await isUserDataComplete(transactions)).toBe(true);
    expect(await isScopeDownloadComplete(transactions, SCOPE_KEY)).toBe(true);
    // The net for the next bare write anyone adds: the main connection stays
    // read-only for the whole cycle.
    expect(shared.mainWrites).toEqual([]);
  });
});

describe('sync markers racing a teardown for the write lock (#5851)', () => {
  it('leaves scope-complete deleted when a board removal lands while the completion waits', async () => {
    const lastBoardTable = BOARD_DATA_TABLES[BOARD_DATA_TABLES.length - 1];
    let boardTablesDone = false;
    let teardownRan = false;
    shared.armTeardown(
      (_sql, params) => boardTablesDone && params.includes(`scope-complete:${SCOPE_KEY}`),
      async () => {
        // What remove-offline-board does: latch the namespace, delete the
        // board's rows and markers in one transaction, release.
        const release = beginScopePurge(purgeNamespaceKey(SCOPE));
        try {
          await removeBoardScopeData({ db: transactions, scope: SCOPE, scopeKey: SCOPE_KEY, retainedScopes: [] });
        } finally {
          release();
        }
        teardownRan = true;
      },
    );

    await pullSync(shared.db, queryClient(), graphqlFetch, {
      enabledBoards: [SCOPE_KEY],
      onProgress: (progress: SyncProgress) => {
        if (progress.phase === 'board_data' && progress.currentTable === `${lastBoardTable}:${SCOPE_KEY}`) {
          boardTablesDone = true;
        }
      },
    });

    expect(teardownRan).toBe(true);
    // A `scope-complete:` with no rows behind it is the marker scope-teardown.ts
    // calls unrecoverable: local reads would serve an empty board as complete.
    expect(await isScopeDownloadComplete(transactions, SCOPE_KEY)).toBe(false);
  });

  it('leaves user_data_complete deleted when a sign-out wipe lands while the marker waits', async () => {
    let teardownRan = false;
    shared.armTeardown(
      (_sql, params) => params.includes(USER_DATA_COMPLETE_KEY),
      async () => {
        setSigningOut(true);
        try {
          await transactions.withExclusiveTransactionAsync(async (transaction) => {
            await transaction.runAsync('DELETE FROM sync_meta WHERE key = ?', [USER_DATA_COMPLETE_KEY]);
          });
        } finally {
          setSigningOut(false);
        }
        teardownRan = true;
      },
    );

    await pullSync(shared.db, queryClient(), graphqlFetch, { enabledBoards: [SCOPE_KEY] });

    expect(teardownRan).toBe(true);
    // Written back over the wipe, it would vouch for a logbook that is gone, and
    // the next account's logbook would read local-first from empty tables.
    expect(await isUserDataComplete(transactions)).toBe(false);
  });
});
