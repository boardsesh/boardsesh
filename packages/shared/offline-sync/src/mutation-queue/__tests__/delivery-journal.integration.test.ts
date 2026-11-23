import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { OfflineWriteEnqueueContext } from '@boardsesh/shared-schema';
import type { OfflineDatabase, SqlValue } from '../../database';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import { runMigrations, ARTIFACT_SCHEMA_VERSION, MIGRATIONS } from '../../db/migrations';
import {
  enqueue,
  markCompleted,
  markDeadLetter,
  peekPending,
  retryDeadLetter,
  supersedePendingSessionWorkouts,
} from '../queue';
import { ensureMutationQueueTable } from '../schema';
import { processMutation, type GraphQLFetch } from '../handlers';
import { drainMutationQueue, __resetDrainerStateForTests } from '../drainer';
import {
  acknowledgeOfflineWriteObservations,
  markOfflineWritesSuperseded,
  observeOfflineWriteServerResponse,
  readOfflineWriteObservations,
  readOfflineWriteReconciliationCandidates,
  reconcileOfflineWrite,
  touchOfflineWriteObservations,
} from '../delivery-journal';

const originRelease: OfflineWriteEnqueueContext['originRelease'] = {
  platform: 'android',
  applicationId: 'com.boardsesh.app',
  appVersion: '2.8.0',
  runtimeVersion: 'native-runtime',
  updateId: 'running-ota',
  isEmbedded: false,
  branch: 'production',
};
function context(deliveryId = 'opaque-measurement-id'): OfflineWriteEnqueueContext {
  return { deliveryId, queuedAt: '2026-11-21T12:00:00.000Z', connectivityReason: 'device_offline', originRelease };
}
let database: TestSqliteDb;
const scratchDirectories: string[] = [];
beforeEach(async () => {
  database = createTestDatabase();
  await ensureMutationQueueTable(database);
  __resetDrainerStateForTests();
});
afterEach(() => {
  database.close();
  __resetDrainerStateForTests();
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function queueTick(delivery = context()): Promise<number> {
  await enqueue(
    database,
    'boardsesh_ticks',
    'create',
    {
      climbUuid: 'private-climb-uuid',
      boardType: 'kilter',
      comment: 'private tick comment',
    },
    'private-tick-uuid',
    { delivery },
  );
  return (await peekPending(database))[0]!.id;
}

describe('durable offline write denominator', () => {
  it('rolls back enqueue evidence with the write, and never counts a suppressed insert', async () => {
    await expect(
      database.withExclusiveTransactionAsync(async (transaction) => {
        await enqueue(transaction, 'boardsesh_ticks', 'create', {}, 'rollback-key', {
          delivery: context('rolled-back'),
        });
        throw new Error('commit interrupted');
      }),
    ).rejects.toThrow('commit interrupted');
    expect(await readOfflineWriteObservations(database)).toEqual([]);
    await queueTick();
    await queueTick(context('duplicate-must-not-count'));
    const observations = await readOfflineWriteObservations(database);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ deliveryId: 'opaque-measurement-id', state: 'pending', revision: 1 });
    expect(JSON.stringify(observations)).not.toMatch(/private-climb-uuid|private-tick-uuid|private tick comment/);
  });

  it('rolls back outbox removal when the finalization journal cannot commit', async () => {
    const mutationId = await queueTick();
    await database.execAsync(`CREATE TRIGGER reject_journal_finalization
      BEFORE UPDATE ON offline_write_delivery_journal WHEN NEW.state = 'finalized'
      BEGIN SELECT RAISE(ABORT, 'injected journal commit failure'); END;`);
    await expect(markCompleted(database, mutationId)).rejects.toThrow('injected journal commit failure');
    expect(await peekPending(database)).toHaveLength(1);
    expect((await readOfflineWriteObservations(database))[0]!.state).toBe('pending');
    await database.execAsync('DROP TRIGGER reject_journal_finalization');
    await markCompleted(database, mutationId);
    expect((await readOfflineWriteObservations(database))[0]!.state).toBe('finalized');
  });

  it('keeps legacy writes outside the denominator, including after migration and recovery', async () => {
    await enqueue(database, 'boardsesh_ticks', 'create', {}, 'legacy-key');
    const [legacy] = await peekPending(database);
    await markDeadLetter(database, legacy!.id, 'legacy failure');
    await retryDeadLetter(database, legacy!.id);
    await markCompleted(database, legacy!.id);
    expect(await readOfflineWriteObservations(database)).toEqual([]);
  });

  it('keeps one identity and failure history through dead letter, revive, and finalization', async () => {
    const mutationId = await queueTick();
    await markDeadLetter(database, mutationId, 'server rejection');
    const [rejected] = await readOfflineWriteObservations(database);
    expect(rejected).toMatchObject({ state: 'dead_letter', recovered: false });
    expect(rejected!.firstDeadLetterAt).not.toBeNull();
    await retryDeadLetter(database, mutationId);
    await observeOfflineWriteServerResponse(database, mutationId);
    await markCompleted(database, mutationId);
    const [finalized] = await readOfflineWriteObservations(database);
    expect(finalized).toMatchObject({ deliveryId: rejected!.deliveryId, state: 'finalized', recovered: true });
    expect(finalized!.firstDeadLetterAt).toBe(rejected!.firstDeadLetterAt);
    expect(finalized!.serverResponseAt).not.toBeNull();
    expect(finalized!.reconciledAt).toBeNull();
    expect(await readOfflineWriteReconciliationCandidates(database)).toEqual([
      {
        deliveryId: rejected!.deliveryId,
        tableName: 'boardsesh_ticks',
        operation: 'create',
        target: { uuid: 'private-tick-uuid', boardType: 'kilter', climbUuid: 'private-climb-uuid' },
      },
    ]);
    await reconcileOfflineWrite(database, rejected!.deliveryId);
    const [reconciled] = await readOfflineWriteObservations(database);
    expect(reconciled!.state).toBe('reconciled');
    expect(reconciled!.reconciledAt).not.toBeNull();
    expect(await readOfflineWriteReconciliationCandidates(database)).toEqual([]);
  });

  it('does not let a late upload acknowledgement consume a newer observation', async () => {
    const mutationId = await queueTick();
    const [original] = await readOfflineWriteObservations(database);
    await markDeadLetter(database, mutationId, 'rejected');
    await acknowledgeOfflineWriteObservations(database, [original!]);
    const [updated] = await readOfflineWriteObservations(database);
    expect(updated!.revision).toBeGreaterThan(original!.revision);
    await acknowledgeOfflineWriteObservations(database, [updated!]);
    expect(await readOfflineWriteObservations(database)).toEqual([]);
    await touchOfflineWriteObservations(database);
    expect((await readOfflineWriteObservations(database))[0]!.state).toBe('dead_letter');
  });

  it('records cancellation and workout supersession rather than successful delivery', async () => {
    await queueTick();
    await markOfflineWritesSuperseded(database, ['private-tick-uuid']);
    await database.runAsync('DELETE FROM pending_mutations WHERE idempotency_key = ?', ['private-tick-uuid']);
    expect((await readOfflineWriteObservations(database))[0]!.state).toBe('superseded');
    await enqueue(database, 'session_workouts', 'create', { sessionId: 'session', revision: 1 }, 'workout:1', {
      delivery: context('workout-delivery'),
    });
    await database.withExclusiveTransactionAsync((transaction) =>
      supersedePendingSessionWorkouts(transaction, 'session', 2).then(() => {}),
    );
    expect(
      (await readOfflineWriteObservations(database)).find(
        (observation) => observation.deliveryId === 'workout-delivery',
      )!.state,
    ).toBe('superseded');
  });

  it('survives database close/reopen without inventing a reconciliation result', async () => {
    // Each test owns and removes its small fixture directory.
    const scratchParent = join(process.cwd(), '.boardsesh/scratch-7988');
    mkdirSync(scratchParent, { recursive: true });
    const directory = mkdtempSync(join(scratchParent, 'delivery-fixture-'));
    scratchDirectories.push(directory);
    database.close();
    const filename = join(directory, 'offline.sqlite');
    database = createTestDatabase(filename);
    // This fixture checks process restart, not power loss; avoid host fsync stalls.
    await database.execAsync('PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF;');
    await ensureMutationQueueTable(database);
    await queueTick();
    database.close();
    database = createTestDatabase(filename);
    await ensureMutationQueueTable(database);
    expect(await readOfflineWriteObservations(database)).toEqual([
      expect.objectContaining({
        deliveryId: 'opaque-measurement-id',
        state: 'pending',
        originRelease,
        reconciledAt: null,
      }),
    ]);
  });

  it('expands a v14 database without enrolling old rows or changing artifact compatibility', async () => {
    database.close();
    database = createTestDatabase();
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 14)) {
      for (const statement of migration.statements) await database.execAsync(statement);
      await migration.run?.(database);
    }
    await database.execAsync(`CREATE TABLE schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (1, 14);
      INSERT INTO pending_mutations (table_name, operation, payload, idempotency_key)
      VALUES ('boardsesh_ticks', 'create', '{}', 'old-before-migration');`);
    await runMigrations(database);
    await runMigrations(database);
    expect(await readOfflineWriteObservations(database)).toEqual([]);
    expect(await peekPending(database)).toHaveLength(1);
    expect(ARTIFACT_SCHEMA_VERSION).toBe(12);
  });
});

describe('replay correlation', () => {
  it('preserves request-specific metadata through dispatch, without changing mutation identity', async () => {
    await queueTick();
    const [mutation] = await peekPending(database);
    const fetch = vi.fn().mockResolvedValue({ saveTick: { uuid: 'private-tick-uuid' } });
    await processMutation(mutation!, fetch as GraphQLFetch);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('saveTick'),
      {
        input: expect.objectContaining({ uuid: 'private-tick-uuid' }),
      },
      { offlineWriteDeliveryId: 'opaque-measurement-id' },
    );
  });

  it.each([1, 10])('records recovery after %i failed local finalization attempts', async (failedLocalAttempts) => {
    await database.execAsync(
      "CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO sync_meta VALUES ('local_user_id', 'owner');",
    );
    await queueTick();
    let failingDeletes = failedLocalAttempts;
    const lockedDatabase = {
      execAsync: database.execAsync.bind(database),
      getFirstAsync: database.getFirstAsync.bind(database),
      getAllAsync: database.getAllAsync.bind(database),
      withExclusiveTransactionAsync: database.withExclusiveTransactionAsync.bind(database),
      runAsync: async (source: string, ...parameters: SqlValue[]) => {
        if (failingDeletes > 0 && source.startsWith('DELETE FROM pending_mutations')) {
          failingDeletes -= 1;
          throw new Error('database is locked');
        }
        return database.runAsync(source, ...parameters);
      },
    } as unknown as OfflineDatabase;
    const fetch = vi.fn().mockResolvedValue({ saveTick: { uuid: 'private-tick-uuid' } });
    await drainMutationQueue(lockedDatabase, { invalidateQueries: vi.fn() }, fetch, {
      isOnline: () => true,
      getSignedInUserId: async () => 'owner',
      sleep: async () => {},
    });
    const [observation] = await readOfflineWriteObservations(database);
    expect(observation).toMatchObject({ state: 'finalized', recovered: true });
    expect(observation!.serverResponseAt).not.toBeNull();
    expect(observation!.firstDeadLetterAt).toBeNull();
    expect(await peekPending(database)).toEqual([]);
  });

  it('retries an ambiguous response and finalizes once under the same delivery identity', async () => {
    await database.execAsync(
      "CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO sync_meta VALUES ('local_user_id', 'owner');",
    );
    await queueTick();
    let serverRows = 0;
    let sends = 0;
    const identities = new Set<string>();
    const fetch: GraphQLFetch = async (_query, variables, options) => {
      sends += 1;
      if (!variables || typeof variables.input !== 'object') throw new Error('Missing tick input');
      const uuid = (variables.input as { uuid: string }).uuid;
      if (!identities.has(uuid)) {
        identities.add(uuid);
        serverRows += 1;
      }
      expect(options?.offlineWriteDeliveryId).toBe('opaque-measurement-id');
      if (sends === 1) throw new Error('Network request failed');
      return { saveTick: { uuid } } as never;
    };
    await drainMutationQueue(database, { invalidateQueries: vi.fn() }, fetch, {
      isOnline: () => true,
      getSignedInUserId: async () => 'owner',
      sleep: async () => {},
    });
    expect((await readOfflineWriteObservations(database))[0]!.state).toBe('pending');
    await drainMutationQueue(database, { invalidateQueries: vi.fn() }, fetch, {
      isOnline: () => true,
      getSignedInUserId: async () => 'owner',
      sleep: async () => {},
    });
    expect(serverRows).toBe(1);
    expect(sends).toBe(2);
    expect(await peekPending(database)).toEqual([]);
    expect(await readOfflineWriteObservations(database)).toEqual([
      expect.objectContaining({ state: 'finalized', recovered: true }),
    ]);
  });
});
