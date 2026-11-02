import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import { runMigrations } from '../../db/migrations';
import { stampLocalUserId } from '../../sync/local-user-owner';
import { markScopeDownloadComplete } from '../../sync/checkpoints';
import { writePullDocuments } from '../../sync/document-writer';
import { TABLE_CONFIGS } from '../../sync/table-config';
import { mirrorSavedClimb } from '../../sync/saved-climb-mirror';
import { __resetDrainerStateForTests, drainMutationQueue } from '../drainer';
import {
  climbMutationEntityKey,
  discardDeadLetter,
  enqueue,
  getLatestClimbMutationKey,
  markCompleted,
  markDeadLetter,
  peekPending,
  retryDeadLetter,
} from '../queue';

let db: TestSqliteDb;
const scope = { boardType: 'spray', layoutId: 7, sizeId: 7 };
const entityKey = climbMutationEntityKey('spray', 'climb');
const options = { isOnline: () => true, getSignedInUserId: async () => 'setter' };

beforeEach(async () => {
  __resetDrainerStateForTests();
  db = createTestDatabase();
  await runMigrations(db);
  await stampLocalUserId(db, 'setter');
});
afterEach(() => {
  db.close();
  __resetDrainerStateForTests();
});

async function queueClimbAndTick(): Promise<void> {
  await enqueue(db, 'board_climbs', 'create', { uuid: 'climb', boardType: 'spray' }, 'create', { entityKey });
  await enqueue(db, 'board_climbs', 'update', { uuid: 'climb', boardType: 'spray' }, 'edit', {
    entityKey,
    dependsOnKey: (await getLatestClimbMutationKey(db, 'spray', 'climb')) ?? undefined,
  });
  await enqueue(db, 'boardsesh_ticks', 'create', { climbUuid: 'climb' }, 'tick', {
    dependsOnKey: (await getLatestClimbMutationKey(db, 'spray', 'climb')) ?? undefined,
  });
}

describe('durable climb write dependencies', () => {
  it('replays create, edit, then tick and reconciles each write before releasing dependents', async () => {
    await queueClimbAndTick();
    const deliveries: string[] = [];
    const graphqlFetch = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      if (query.includes('saveClimb') || query.includes('updateClimb')) {
        expect(variables?.input).toEqual({
          uuid: 'climb',
          boardType: 'spray',
          ...(query.includes('updateClimb') ? { clientMutationId: 'edit' } : {}),
        });
      }
      deliveries.push(query.includes('saveClimb') ? 'create' : query.includes('updateClimb') ? 'edit' : 'tick');
      return {} as T;
    };
    await drainMutationQueue(db, { invalidateQueries: vi.fn() }, graphqlFetch, {
      ...options,
      beforeMutationAcknowledged: async (mutation) => {
        expect(await db.getFirstAsync('SELECT 1 FROM pending_mutations WHERE id = ?', [mutation.id])).not.toBeNull();
        deliveries.push(`ack:${mutation.idempotency_key}`);
      },
    });
    expect(deliveries).toEqual(['create', 'ack:create', 'edit', 'ack:edit', 'tick', 'ack:tick']);
    expect(await peekPending(db)).toEqual([]);
  });

  it('retains a remotely accepted parent when canonical reconciliation loses its connection', async () => {
    await queueClimbAndTick();
    const sent: string[] = [];
    const graphqlFetch = async <T>(query: string): Promise<T> => {
      sent.push(query.includes('saveClimb') ? 'create' : 'dependent');
      return {} as T;
    };
    await drainMutationQueue(db, { invalidateQueries: vi.fn() }, graphqlFetch, {
      ...options,
      beforeMutationAcknowledged: async () => {
        throw new TypeError('Network request failed');
      },
    });
    expect(sent).toEqual(['create']);
    expect(
      await db.getFirstAsync("SELECT status, retry_count FROM pending_mutations WHERE idempotency_key = 'create'"),
    ).toEqual({ status: 'pending', retry_count: 0 });
    expect((await peekPending(db)).map((mutation) => mutation.idempotency_key)).toEqual(['create']);
  });

  it('keeps a failed parent and its dependents while delivering unrelated writes', async () => {
    await queueClimbAndTick();
    await enqueue(db, 'boardsesh_ticks', 'create', { climbUuid: 'existing-climb' }, 'unrelated');
    const sentClimbs: unknown[] = [];
    const graphqlFetch = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      if (query.includes('saveClimb')) throw new Response(null, { status: 400 });
      sentClimbs.push((variables?.input as Record<string, unknown>)?.climbUuid);
      return {} as T;
    };
    await drainMutationQueue(db, { invalidateQueries: vi.fn() }, graphqlFetch, options);
    expect(sentClimbs).toEqual(['existing-climb']);
    expect(
      await db.getFirstAsync('SELECT status FROM pending_mutations WHERE idempotency_key = ?', ['create']),
    ).toEqual({ status: 'dead_letter' });
    expect(await peekPending(db)).toEqual([]);
    expect(
      await db.getFirstAsync('SELECT retry_count FROM pending_mutations WHERE idempotency_key = ?', ['tick']),
    ).toEqual({ retry_count: 0 });
    const parent = await db.getFirstAsync<{ id: number }>(
      'SELECT id FROM pending_mutations WHERE idempotency_key = ?',
      ['create'],
    );
    await expect(discardDeadLetter(db, parent!.id)).rejects.toThrow('depend');
    await retryDeadLetter(db, parent!.id);
    expect((await peekPending(db)).map((mutation) => mutation.idempotency_key)).toEqual(['create']);
  });

  it('does not let more than one batch of blocked writes starve an unrelated write', async () => {
    await enqueue(db, 'board_climbs', 'create', { uuid: 'climb' }, 'create', { entityKey });
    const parent = (await peekPending(db))[0];
    await markDeadLetter(db, parent.id, 'Needs repair');
    for (let index = 0; index < 15; index += 1) {
      await enqueue(db, 'boardsesh_ticks', 'create', { climbUuid: 'climb' }, `tick-${index}`, {
        dependsOnKey: 'create',
      });
    }
    await enqueue(db, 'boardsesh_ticks', 'create', { climbUuid: 'elsewhere' }, 'unrelated');
    expect((await peekPending(db, 1)).map((mutation) => mutation.idempotency_key)).toEqual(['unrelated']);
    await expect(enqueue(db, 'board_climbs', 'update', {}, 'self', { dependsOnKey: 'self' })).rejects.toThrow('itself');
  });

  it.each(['user_favorites', 'playlist_climbs'])(
    'retains %s additions until a rejected offline climb is repaired',
    async (tableName) => {
      await enqueue(db, 'board_climbs', 'create', { uuid: 'climb', boardType: 'spray' }, 'create', { entityKey });
      await enqueue(db, tableName, 'create', { boardName: 'spray', climbUuid: 'climb' }, 'reference');
      let rejectCreate = true;
      let climbExists = false;
      const sentReferences: string[] = [];
      const graphqlFetch = async <T>(query: string): Promise<T> => {
        if (query.includes('saveClimb')) {
          if (rejectCreate) throw new Response(null, { status: 400 });
          climbExists = true;
        } else {
          if (!climbExists) {
            throw { response: { status: 200, errors: [{ extensions: { code: 'CLIMB_NOT_FOUND' } }] } };
          }
          sentReferences.push(tableName);
        }
        return {} as T;
      };
      await drainMutationQueue(db, { invalidateQueries: vi.fn() }, graphqlFetch, options);
      expect(sentReferences).toEqual([]);
      expect(
        await db.getFirstAsync(
          "SELECT status, depends_on_key FROM pending_mutations WHERE idempotency_key = 'reference'",
        ),
      ).toEqual({ status: 'pending', depends_on_key: 'create' });
      rejectCreate = false;
      await enqueue(db, 'board_climbs', 'create', { uuid: 'climb', boardType: 'spray' }, 'create', {
        entityKey,
        reviveDeadLetter: true,
      });
      await drainMutationQueue(db, { invalidateQueries: vi.fn() }, graphqlFetch, options);
      expect(sentReferences).toEqual([tableName]);
      expect(await db.getAllAsync('SELECT * FROM pending_mutations')).toEqual([]);
    },
  );

  it('restores reference dependencies when a deterministic add is revived', async () => {
    await enqueue(db, 'user_favorites', 'create', { climbUuid: 'climb' }, 'favorite');
    const favorite = (await peekPending(db))[0];
    await markDeadLetter(db, favorite.id, 'Needs repair');
    await enqueue(db, 'board_climbs', 'create', { uuid: 'climb', boardType: 'spray' }, 'create', { entityKey });
    await enqueue(db, 'user_favorites', 'create', { climbUuid: 'climb' }, 'favorite', { reviveDeadLetter: true });
    expect((await peekPending(db)).map((mutation) => mutation.idempotency_key)).toEqual(['create']);
  });
});

describe('pending climb protection during pulls and canonical acknowledgements', () => {
  const canonical = {
    uuid: 'climb',
    board_type: 'spray',
    layout_id: 7,
    user_id: 'setter',
    name: 'Canonical',
    updated_at: '2026-10-01T12:00:00.000Z',
    sync_seq: '10',
  };

  it('keeps pending and dead-letter edits until their own canonical acknowledgement', async () => {
    await markScopeDownloadComplete(db, 'spray:7:7');
    await db.runAsync(
      "INSERT INTO board_climbs (uuid, board_type, layout_id, name) VALUES ('climb', 'spray', 7, 'Local edit')",
    );
    await queueClimbAndTick();
    const config = TABLE_CONFIGS.board_climbs;
    await writePullDocuments(db, 'board_climbs', [canonical], config.localColumns, [], false);
    expect(await db.getFirstAsync('SELECT name FROM board_climbs')).toEqual({ name: 'Local edit' });
    await mirrorSavedClimb(
      db,
      scope,
      'climb',
      { viewerId: 'setter', climb: canonical, stats: [] },
      () => true,
      'create',
    );
    expect(await db.getFirstAsync('SELECT name FROM board_climbs')).toEqual({ name: 'Local edit' });
    const parent = (await peekPending(db))[0];
    await markCompleted(db, parent.id);
    const edit = (await peekPending(db))[0];
    await markDeadLetter(db, edit.id, 'Needs repair');
    await writePullDocuments(db, 'board_climbs', [canonical], config.localColumns, [], true);
    expect(await db.getFirstAsync('SELECT name FROM board_climbs')).toEqual({ name: 'Local edit' });
    await retryDeadLetter(db, edit.id);
    await mirrorSavedClimb(db, scope, 'climb', { viewerId: 'setter', climb: canonical, stats: [] }, () => true, 'edit');
    expect(await db.getFirstAsync('SELECT name FROM board_climbs')).toEqual({ name: 'Canonical' });
  });
});
