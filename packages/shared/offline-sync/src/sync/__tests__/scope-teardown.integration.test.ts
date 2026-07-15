// The hazard proofs for scope teardown, driven through the REAL pullSync against the
// REAL on-device DDL.
//
// scope-teardown.test.ts asserts the teardown's own SQL. This file asserts the thing
// that actually matters to a user: that a board removed to free space comes BACK
// whole when they download it again. Those are different claims — the rows can be
// deleted perfectly and the catalog still be permanently ruined by one surviving
// sync_meta row, because the delta pull is a strict `>` keyset and never looks back.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QueryInvalidator } from '../../database';
import { pullSync } from '../pull-client';
import { removeBoardScopeData } from '../scope-teardown';
import { getCheckpoint, setCheckpoint, markScopeDownloadComplete } from '../checkpoints';
import { getBootstrapAttempts } from '../snapshot-bootstrap';
import { runMigrations } from '../../db/migrations';
import { ensureMutationQueueTable } from '../../mutation-queue/schema';
import { beginLocalPurge, __resetDrainerStateForTests } from '../../mutation-queue/drainer';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import { TABLE_CONFIGS } from '../table-config';
import type { OfflineBoardScope } from '../../offline-board-key';

const SCOPE: OfflineBoardScope = { boardType: 'kilter', layoutId: 1, sizeId: 5 };
const SCOPE_KEY = 'kilter:1:5';

let db: TestSqliteDb;
let queryClient: QueryInvalidator;

function createQueryClient(): QueryInvalidator {
  return { invalidateQueries: vi.fn() };
}

const CLIMB_DOC = {
  uuid: 'climb-1',
  board_type: 'kilter',
  layout_id: 1,
  name: 'Original catalog climb',
  is_draft: false,
  is_listed: true,
  compatible_size_ids: [5],
  updated_at: '2026-05-01T00:00:00Z',
  sync_seq: '10',
};

// Mirrors pull-client.test.ts: pullSync's GraphQLFetch is generic in its return, which
// a concrete vi.fn() can't satisfy structurally, so the mock is cast to the seam.
type GraphqlFetchMock = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

/**
 * Serves one page of board_climbs and empty pages for everything else, recording the
 * cursor each syncClimbs call was made with — the cursor is the whole point: an
 * `undefined` first cursor means the scope pulls from epoch (a full re-download),
 * anything else means it resumed past rows that no longer exist.
 */
function createFetch(climbsCursors: unknown[]): GraphqlFetchMock {
  const fetchMock = vi.fn(async (query: string, variables?: Record<string, unknown>) => {
    if (query.includes('syncDeletions')) {
      return { syncDeletions: { deletions: [], cursor: null, hasMore: false } };
    }
    if (query.includes('syncClimbs')) {
      climbsCursors.push(variables?.cursor);
      return {
        syncClimbs: {
          documents: [CLIMB_DOC],
          cursor: { updatedAt: CLIMB_DOC.updated_at, syncSeq: '10' },
          hasMore: false,
        },
      };
    }
    for (const config of Object.values(TABLE_CONFIGS)) {
      if (query.includes(config.queryName)) {
        return { [config.queryName]: { documents: [], cursor: null, hasMore: false } };
      }
    }
    throw new Error(`Unexpected query: ${query}`);
  });
  return fetchMock as unknown as GraphqlFetchMock;
}

async function climbCount(): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM board_climbs');
  return row?.n ?? 0;
}

beforeEach(async () => {
  __resetDrainerStateForTests();
  db = createTestDatabase();
  await ensureMutationQueueTable(db);
  await runMigrations(db);
  queryClient = createQueryClient();
});

afterEach(() => {
  db.close();
  __resetDrainerStateForTests();
});

describe('re-downloading a removed board', () => {
  it('pulls the catalog from epoch, not from a stale checkpoint', async () => {
    // Download it once.
    await pullSync(db, queryClient, createFetch([]), { enabledBoards: [SCOPE_KEY] });
    await markScopeDownloadComplete(db, SCOPE_KEY);
    expect(await climbCount()).toBe(1);
    expect(await getCheckpoint(db, `checkpoint:board_climbs:${SCOPE_KEY}`)).not.toBeNull();

    await removeBoardScopeData({ db, scope: SCOPE, scopeKey: SCOPE_KEY, retainedScopes: [] });
    expect(await climbCount()).toBe(0);

    // Re-enable and sync again.
    const cursors: unknown[] = [];
    await pullSync(db, queryClient, createFetch(cursors), { enabledBoards: [SCOPE_KEY] });

    // Undefined = "start from the beginning". Any other value means the pull resumed
    // past the deleted rows, which the strict `>` delta would never have revisited.
    expect(cursors[0]).toBeUndefined();
    expect(await climbCount()).toBe(1);
  });

  // The executable statement of the hazard: this is what deleting rows WITHOUT
  // clearing the checkpoint would do. If someone ever splits the teardown transaction
  // so markers can survive the rows, the test above starts failing and this one
  // explains why.
  it('would resume past the deleted rows if a checkpoint survived', async () => {
    await pullSync(db, queryClient, createFetch([]), { enabledBoards: [SCOPE_KEY] });
    const survivingCheckpoint = await getCheckpoint(db, `checkpoint:board_climbs:${SCOPE_KEY}`);

    // Rows deleted, checkpoint deliberately left behind.
    await db.runAsync('DELETE FROM board_climbs');
    await setCheckpoint(db, `checkpoint:board_climbs:${SCOPE_KEY}`, survivingCheckpoint!);

    const cursors: unknown[] = [];
    await pullSync(db, queryClient, createFetch(cursors), { enabledBoards: [SCOPE_KEY] });

    expect(cursors[0]).toEqual(survivingCheckpoint);
  });

  it('restores snapshot-bootstrap eligibility after attempts were exhausted', async () => {
    await pullSync(db, queryClient, createFetch([]), { enabledBoards: [SCOPE_KEY] });
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      `bootstrap-attempts:${SCOPE_KEY}`,
      '2',
    ]);
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      `bootstrap-done:${SCOPE_KEY}`,
      '1',
    ]);

    await removeBoardScopeData({ db, scope: SCOPE, scopeKey: SCOPE_KEY, retainedScopes: [] });

    // Attempts reset and both board checkpoints gone — the two conditions
    // runBootstrapPhase requires before it will warm a scope from a snapshot.
    expect(await getBootstrapAttempts(db, SCOPE_KEY)).toBe(0);
    expect(await getCheckpoint(db, `checkpoint:board_climbs:${SCOPE_KEY}`)).toBeNull();
    expect(await getCheckpoint(db, `checkpoint:board_climb_stats:${SCOPE_KEY}`)).toBeNull();
  });
});

describe('beginLocalPurge', () => {
  // The resurrection window: a page already on the wire when the delete runs would
  // otherwise land afterwards, restoring rows AND stamping a checkpoint past them.
  it('makes an in-flight pull discard the page it was fetching', async () => {
    const graphqlFetch = vi.fn(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return { syncDeletions: { deletions: [], cursor: null, hasMore: false } };
      }
      if (query.includes('syncClimbs')) {
        // A purge starts while this page is in flight.
        beginLocalPurge();
        return {
          syncClimbs: {
            documents: [CLIMB_DOC],
            cursor: { updatedAt: CLIMB_DOC.updated_at, syncSeq: '10' },
            hasMore: false,
          },
        };
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return { [config.queryName]: { documents: [], cursor: null, hasMore: false } };
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch as unknown as GraphqlFetchMock, { enabledBoards: [SCOPE_KEY] });

    expect(await climbCount()).toBe(0);
    expect(await getCheckpoint(db, `checkpoint:board_climbs:${SCOPE_KEY}`)).toBeNull();
  });
});
