// `requireOwnedDatabase` (#6824): a pull for an account lands only in a
// database stamped for that account. Real schema over node:sqlite.
//
// Without it, a pull for account B on a database still stamped for A (an owner
// wipe that failed, a claim not made yet) writes B's rows beside A's. A later
// sign-in of A would then pass its own owner check and read B's playlists, which
// carry no user column to filter on.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QueryInvalidator } from '../../database';
import { pullSync } from '../pull-client';
import type { SyncProgress } from '../pull-client';
import { stampLocalUserId } from '../local-user-owner';
import { runMigrations } from '../../db/migrations';
import { __resetDrainerStateForTests } from '../../mutation-queue/drainer';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';

let db: TestSqliteDb;
const queryClient: QueryInvalidator = { invalidateQueries: vi.fn() };
const graphqlFetch = vi.fn(async (): Promise<never> => {
  throw new Error('network stand-in: the pull reached the server');
});

function pullAs(viewerUserId: string | undefined, onProgress?: (progress: SyncProgress) => void) {
  return pullSync(db, queryClient, graphqlFetch, {
    viewerUserId,
    enabledBoards: [],
    requireOwnedDatabase: true,
    onProgress,
  }).catch(() => undefined);
}

beforeEach(async () => {
  __resetDrainerStateForTests();
  graphqlFetch.mockClear();
  db = createTestDatabase();
  await runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('pullSync: requireOwnedDatabase', () => {
  it("does not pull B's rows into a database stamped for A, and reports the cycle as interrupted", async () => {
    await stampLocalUserId(db, 'user-a');
    const frames: SyncProgress[] = [];

    await pullAs('user-b', (progress) => frames.push(progress));

    expect(graphqlFetch).not.toHaveBeenCalled();
    expect(frames).toEqual([{ phase: 'idle', currentTable: null, documentsProcessed: 0, interrupted: true }]);
  });

  it('does not pull into a database no account has claimed yet', async () => {
    await pullAs('user-b');
    expect(graphqlFetch).not.toHaveBeenCalled();
  });

  it('does not pull without a signed-in account', async () => {
    await stampLocalUserId(db, 'user-a');
    await pullAs(undefined);
    expect(graphqlFetch).not.toHaveBeenCalled();
  });

  it('pulls once the database is stamped for the viewer', async () => {
    await stampLocalUserId(db, 'user-b');
    await pullAs('user-b');
    expect(graphqlFetch).toHaveBeenCalled();
  });

  it('leaves callers that do not ask for the check pulling as before', async () => {
    await stampLocalUserId(db, 'user-a');
    await pullSync(db, queryClient, graphqlFetch, { viewerUserId: 'user-b', enabledBoards: [] }).catch(() => undefined);
    expect(graphqlFetch).toHaveBeenCalled();
  });
});
