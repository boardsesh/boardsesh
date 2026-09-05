// Issue #4331. The drainer's per-mutation `try` wraps the send AND the outbox
// DELETE that follows it — and `processMutation` is the only network call in
// there, so a SQLite `database is locked` thrown inside that try can only have
// come from `markCompleted`, i.e. AFTER the server accepted the write. The old
// classification resolved no HTTP status for it, called it non-retryable, and
// force-dead-lettered the row with retry_count 0. For a favorite or a follow,
// whose idempotency key is deterministic, that dead row then owned the key
// forever.
//
// These run the REAL drainer, the REAL queue SQL and the REAL DDL through
// node:sqlite; only the network handler is mocked, and the lock is injected by
// making the outbox DELETE throw the production driver message.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OfflineDatabase, QueryInvalidator, SqlRunResult, SqlValue } from '../../database';

vi.mock('../handlers', () => ({
  processMutation: vi.fn().mockResolvedValue(undefined),
}));

import { drainMutationQueue, __resetDrainerStateForTests } from '../drainer';
import { processMutation } from '../handlers';
import { enqueue } from '../queue';
import { ensureMutationQueueTable } from '../schema';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';

const mockProcessMutation = processMutation as ReturnType<typeof vi.fn>;

// The two shapes production actually reports. Android prints the SQLite result
// code as a raw U+0005 control byte, which is built here rather than written as
// a literal so no control byte lands in a source file (see db/lock-errors.ts).
const ANDROID_LOCK_MESSAGE = `Call to function 'NativeStatement.finalizeAsync' has been rejected. → Caused by: Error code ${String.fromCharCode(5)}: database is locked`;
const IOS_LOCK_MESSAGE = 'SQLiteErrorException: Error code 5: database is locked';

type QueueRow = { id: number; status: string; retry_count: number; last_error: string | null };

// Delegates every method rather than spreading the adapter: its methods live on
// the prototype, so a spread would produce an object with no `runAsync` at all.
function withFailingOutboxDelete(base: TestSqliteDb, failures: number, message: string): OfflineDatabase {
  let remaining = failures;
  return {
    execAsync: (source: string) => base.execAsync(source),
    runAsync: (source: string, ...params: SqlValue[]): Promise<SqlRunResult> => {
      if (remaining > 0 && source.includes('DELETE FROM pending_mutations')) {
        remaining -= 1;
        return Promise.reject(new Error(message));
      }
      return base.runAsync(source, ...params);
    },
    getFirstAsync: <T>(source: string, ...params: SqlValue[]) => base.getFirstAsync<T>(source, ...params),
    getAllAsync: <T>(source: string, ...params: SqlValue[]) => base.getAllAsync<T>(source, ...params),
    withExclusiveTransactionAsync: (task) => base.withExclusiveTransactionAsync(task),
  } as OfflineDatabase;
}

function createRecordingQueryClient(): QueryInvalidator {
  return { invalidateQueries: vi.fn() };
}

const graphqlFetch = vi.fn().mockResolvedValue({});

let db: TestSqliteDb;

async function readQueue(): Promise<QueueRow[]> {
  return db.getAllAsync<QueueRow>('SELECT id, status, retry_count, last_error FROM pending_mutations');
}

beforeEach(async () => {
  vi.clearAllMocks();
  __resetDrainerStateForTests();
  mockProcessMutation.mockResolvedValue(undefined);
  db = createTestDatabase();
  await ensureMutationQueueTable(db);
  await enqueue(db, 'user_favorites', 'create', { boardName: 'kilter', climbUuid: 'c1', angle: 40 }, 'add:fav:c1:40');
});

afterEach(() => {
  __resetDrainerStateForTests();
});

describe('a local write lock lost while clearing the outbox', () => {
  it.each([
    ['the Android shape', ANDROID_LOCK_MESSAGE],
    ['the iOS shape', IOS_LOCK_MESSAGE],
  ])('leaves the row pending and never dead-letters it — %s', async (_label, message) => {
    const onMutationDeadLettered = vi.fn();
    // Enough failures to outlast the local retry ladder, so the lock reaches
    // the drainer's own classification.
    const lockedDb = withFailingOutboxDelete(db, 10, message);

    await drainMutationQueue(lockedDb, createRecordingQueryClient(), graphqlFetch, {
      isOnline: () => true,
      maxCycleAttempts: 0,
      sleep: async () => {},
      onMutationDeadLettered,
    });

    // The server has the write; the row survives to be re-sent, unmarked.
    expect(mockProcessMutation).toHaveBeenCalledTimes(1);
    expect(await readQueue()).toEqual([{ id: 1, status: 'pending', retry_count: 0, last_error: null }]);
    expect(onMutationDeadLettered).not.toHaveBeenCalled();
  });

  it('completes normally when the lock clears on the retry', async () => {
    const onMutationDeadLettered = vi.fn();
    const lockedDb = withFailingOutboxDelete(db, 1, ANDROID_LOCK_MESSAGE);

    await drainMutationQueue(lockedDb, createRecordingQueryClient(), graphqlFetch, {
      isOnline: () => true,
      sleep: async () => {},
      onMutationDeadLettered,
    });

    // One send, one row cleared: the lost lock never became a queue-lifecycle
    // decision at all.
    expect(mockProcessMutation).toHaveBeenCalledTimes(1);
    expect(await readQueue()).toEqual([]);
    expect(onMutationDeadLettered).not.toHaveBeenCalled();
  });

  it('re-sends the still-pending row on the next drain', async () => {
    const lockedDb = withFailingOutboxDelete(db, 10, ANDROID_LOCK_MESSAGE);
    const drainOptions = { isOnline: () => true, maxCycleAttempts: 0, sleep: async () => {} };

    await drainMutationQueue(lockedDb, createRecordingQueryClient(), graphqlFetch, drainOptions);
    // The lock has cleared by the time the scheduler fires again.
    await drainMutationQueue(db, createRecordingQueryClient(), graphqlFetch, drainOptions);

    expect(mockProcessMutation).toHaveBeenCalledTimes(2);
    expect(await readQueue()).toEqual([]);
  });
});

describe('a genuine non-retryable failure', () => {
  it('still dead-letters immediately, so the lock branch swallowed nothing', async () => {
    const onMutationDeadLettered = vi.fn();
    mockProcessMutation.mockRejectedValue(new Error('Cannot read property "climbUuid" of undefined'));

    await drainMutationQueue(db, createRecordingQueryClient(), graphqlFetch, {
      isOnline: () => true,
      sleep: async () => {},
      onMutationDeadLettered,
    });

    const rows = await readQueue();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('dead_letter');
    expect(onMutationDeadLettered).toHaveBeenCalledWith(expect.objectContaining({ reason: 'non_retryable' }));
  });
});
