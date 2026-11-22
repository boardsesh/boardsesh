import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '@boardsesh/offline-sync/testing';
import {
  beginImmediateWrite,
  configureMainConnection,
  enqueue,
  ensureMutationQueueTable,
  runMigrations,
  stampLocalUserId,
} from '@boardsesh/offline-sync';
import {
  parseQaRequest,
  qaDatabaseName,
  QA_USER_ID,
  runQaPhase,
  tickPair,
  verifyNonTickPairs,
  type QaDatabase,
  type QaDependencies,
  type QaReceipt,
} from '../cases';

const failingImport = vi.hoisted(() => ({ enabled: false }));
vi.mock('@boardsesh/offline-sync', async (importOriginal) => {
  const engine = await importOriginal<typeof import('@boardsesh/offline-sync')>();
  return {
    ...engine,
    bootstrapScopeFromSnapshot: async (params: Parameters<typeof engine.bootstrapScopeFromSnapshot>[0]) => {
      if (!failingImport.enabled) return engine.bootstrapScopeFromSnapshot(params);
      await params.db.withExclusiveTransactionAsync(async (transaction) => {
        await engine.beginImmediateWrite(transaction, 0);
        throw new Error('deliberate import failure');
      });
      throw new Error('The deliberately failing import returned');
    },
  };
});

let directory: string;
const receipts: QaReceipt[] = [];
function open(name: string): Promise<QaDatabase> {
  const database = createTestDatabase(join(directory, name));
  return Promise.resolve(
    new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'databasePath') return join(directory, name);
        if (property === 'closeAsync') return async () => target.close();
        const member: unknown = Reflect.get(target, property, receiver);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    }) as unknown as QaDatabase,
  );
}

const writeTick: QaDependencies['writeTick'] = async (database, input, uuid) => {
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await beginImmediateWrite(transaction, 5000);
    await transaction.runAsync(
      `INSERT OR IGNORE INTO boardsesh_ticks
      (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, climbed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid,
        QA_USER_ID,
        input.boardType,
        input.climbUuid,
        input.angle,
        input.status,
        input.attemptCount,
        input.climbedAt,
      ],
    );
    await enqueue(transaction, 'boardsesh_ticks', 'create', input, uuid);
  });
};

function dependencies(): QaDependencies {
  return {
    open,
    writeTick,
    addFavorite: vi.fn(),
    favoriteKey: (input) => `add:user_favorites:${input.boardName}:${input.climbUuid}:${input.angle}`,
    follow: vi.fn(),
    runtimeId: 'replacement-runtime',
    emit: async (receipt) => {
      receipts.push(receipt);
    },
  };
}

async function preparedDatabase(): Promise<QaDatabase> {
  const database = await open(qaDatabaseName('sample'));
  await configureMainConnection(database);
  await ensureMutationQueueTable(database);
  await runMigrations(database);
  await stampLocalUserId(database, QA_USER_ID);
  await database.runAsync("INSERT INTO sync_meta (key, value) VALUES ('qa:prepared-runtime', 'old-runtime')");
  await writeTick(
    database,
    {
      boardType: 'kilter',
      climbUuid: 'qa-climb-1',
      angle: 40,
      isMirror: false,
      isBenchmark: false,
      status: 'send',
      attemptCount: 1,
      comment: '',
      climbedAt: '2026-01-01T00:00:00.000Z',
    },
    'qa-committed',
  );
  return database;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'offline-write-qa-test-'));
  receipts.length = 0;
  failingImport.enabled = false;
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('isolated native write QA command', () => {
  it.each(['../boardsesh', 'x/y', '', 'x'.repeat(65), 'hello.db'])('rejects unsafe database identity %j', (runId) => {
    expect(() => parseQaRequest({ runId, phase: 'contention' })).toThrow();
    expect(() => qaDatabaseName(runId)).toThrow();
  });

  it('accepts a bounded heavy fixture and loopback receipt port', () => {
    expect(parseQaRequest({ runId: 'qa-7985', phase: 'contention', receiptPort: '12345' })).toEqual({
      runId: 'qa-7985',
      phase: 'contention',
      rows: 369000,
      receiptPort: 12345,
    });
  });

  it.each([
    { rows: '0' },
    { rows: '500001' },
    { rows: '1e100' },
    { receiptPort: '123.4' },
    { receiptPort: '0' },
    { phase: 'wipe' },
  ])('rejects invalid command %j', (invalid) => {
    expect(() => parseQaRequest({ runId: 'safe', phase: 'contention', ...invalid })).toThrow();
  });

  it('verifies both durable sides and a new write in a different runtime', async () => {
    await (await preparedDatabase()).closeAsync();
    await runQaPhase(parseQaRequest({ runId: 'sample', phase: 'verify-reload' }), dependencies());
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      status: 'passed',
      details: {
        previousRuntimeId: 'old-runtime',
        committed: { ticks: 1, mutations: 1 },
        interrupted: { ticks: 0, mutations: 0 },
        newWrite: { ticks: 1, mutations: 1 },
      },
    });
    const reopened = await open(qaDatabaseName('sample'));
    try {
      expect(await tickPair(reopened, 'qa-after-reload')).toEqual({ ticks: 1, mutations: 1 });
    } finally {
      await reopened.closeAsync();
    }
  }, 20000);

  it.each(['user_favorites', 'user_follows'] as const)(
    'rejects a reopened %s row missing despite an intact outbox',
    async (table) => {
      const database = await preparedDatabase();
      const favoriteKey = dependencies().favoriteKey;
      try {
        for (const group of ['reconcile', 'batch']) {
          const climbUuid = group === 'reconcile' ? 'qa-climb-1' : 'qa-climb-2';
          const followingId = `qa-followed-${group}`;
          await database.runAsync(
            `INSERT INTO user_favorites (board_name, climb_uuid, angle, user_id, created_at, updated_at) VALUES ('kilter', ?, 40, ?, '2026-01-01', '2026-01-01')`,
            [climbUuid, QA_USER_ID],
          );
          await database.runAsync(
            `INSERT INTO user_follows (following_id, follower_id, created_at, updated_at) VALUES (?, ?, '2026-01-01', '2026-01-01')`,
            [followingId, QA_USER_ID],
          );
          await enqueue(
            database,
            'user_favorites',
            'create',
            {},
            favoriteKey({ boardName: 'kilter', climbUuid, angle: 40 }),
          );
          await enqueue(database, 'user_follows', 'create', {}, `add:user_follows:${followingId}`);
        }
        await verifyNonTickPairs(database, favoriteKey);
        await database.runAsync(`DELETE FROM ${table}`);
        await expect(verifyNonTickPairs(database, favoriteKey)).rejects.toThrow(table);
      } finally {
        await database.closeAsync();
      }
    },
  );

  it('cannot pass when the committed outbox row is missing', async () => {
    const database = await preparedDatabase();
    await database.runAsync('DELETE FROM pending_mutations WHERE idempotency_key = ?', ['qa-committed']);
    await database.closeAsync();
    await runQaPhase(parseQaRequest({ runId: 'sample', phase: 'verify-reload' }), dependencies());
    expect(receipts[0]).toMatchObject({
      status: 'failed',
      details: { error: expect.stringContaining('Committed pair after reload') },
    });
  });

  it('cannot pass when the interrupted pair was committed', async () => {
    const database = await preparedDatabase();
    await database.runAsync(
      "INSERT INTO boardsesh_ticks (uuid, board_type, climb_uuid, angle, status, attempt_count, climbed_at) VALUES ('qa-interrupted', 'kilter', 'qa-climb-1', 40, 'send', 1, '2026-01-01')",
    );
    await database.closeAsync();
    await runQaPhase(parseQaRequest({ runId: 'sample', phase: 'verify-reload' }), dependencies());
    expect(receipts[0]).toMatchObject({
      status: 'failed',
      details: { error: expect.stringContaining('Interrupted pair after reload') },
    });
  });

  it('rejects verification within the original JS runtime', async () => {
    await (await preparedDatabase()).closeAsync();
    const supplied = dependencies();
    supplied.runtimeId = 'old-runtime';
    await runQaPhase(parseQaRequest({ runId: 'sample', phase: 'verify-reload' }), supplied);
    expect(receipts[0]).toMatchObject({
      status: 'failed',
      details: { error: expect.stringContaining('different prepared JS runtime') },
    });
  });

  it('does not reacquire a holder when reload restores the prepare URL', async () => {
    await (await preparedDatabase()).closeAsync();
    await runQaPhase(parseQaRequest({ runId: 'sample', phase: 'prepare-reload' }), dependencies());
    expect(receipts[0]).toMatchObject({ status: 'reloaded', details: { previousRuntimeId: 'old-runtime' } });
  });

  it.each(['verify-reload', 'prepare-reload'] as const)(
    'cannot acknowledge %s before close succeeds',
    async (phase) => {
      await (await preparedDatabase()).closeAsync();
      const supplied = dependencies();
      supplied.open = async (name) => {
        const database = await open(name);
        return new Proxy(database, {
          get(target, property, receiver) {
            if (property === 'closeAsync')
              return async () => {
                await target.closeAsync();
                throw new Error('deliberate close failure');
              };
            const member: unknown = Reflect.get(target, property, receiver);
            return typeof member === 'function' ? member.bind(target) : member;
          },
        });
      };
      await runQaPhase(parseQaRequest({ runId: 'sample', phase }), supplied);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ status: 'failed', details: { error: 'deliberate close failure' } });
    },
  );

  it('retains lock-holder evidence when import and close both fail', async () => {
    failingImport.enabled = true;
    const supplied = dependencies();
    supplied.writeTick = async () => {};
    supplied.open = async (name) => {
      const database = await open(name);
      if (!name.endsWith('-fresh.db')) return database;
      return new Proxy(database, {
        get(target, property, receiver) {
          if (property === 'closeAsync')
            return async () => {
              await target.closeAsync();
              throw new Error('deliberate close failure');
            };
          const member: unknown = Reflect.get(target, property, receiver);
          return typeof member === 'function' ? member.bind(target) : member;
        },
      });
    };
    await runQaPhase(parseQaRequest({ runId: 'failure', phase: 'contention', rows: '1000' }), supplied);
    expect(receipts[0]).toMatchObject({
      status: 'failed',
      details: {
        error: 'deliberate import failure',
        cleanupError: 'deliberate close failure',
        trace: expect.arrayContaining([
          expect.objectContaining({ site: 'snapshot', stage: 'acquired' }),
          expect.objectContaining({ site: 'snapshot', stage: 'transaction-settled' }),
        ]),
      },
    });
  }, 20000);
});
