// Exercises the offline write hooks end-to-end against the REAL v1 DDL (via
// node:sqlite) so a column rename in schema.ts that breaks a hook's INSERT/DELETE
// fails here.
//
// Runs in the default node environment (node:sqlite is node-only and can't be
// bundled for jsdom). The hooks' only React surface is useCallback (returns the
// callback unchanged) and useQueryClient (returns a query client); both are mocked
// so the hook factory can be invoked outside a render tree. expo-crypto is mocked
// because it can't load in node.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';

let uuidCounter = 0;
vi.mock('expo-crypto', () => ({
  randomUUID: () => `mock-uuid-${++uuidCounter}`,
}));

// useCallback → identity (return the function as-is); useQueryClient → stub.
const invalidateQueries = vi.fn();
vi.mock('react', () => ({
  useCallback: <T>(callback: T) => callback,
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }) as unknown as QueryClient,
}));

import {
  useOfflineSaveTick,
  useOfflineAddFavorite,
  useOfflineRemoveFavorite,
  useOfflineFollowUser,
  useOfflineUnfollowUser,
} from '../use-offline-mutations';
import type { GraphQLFetch } from '../../mutation-queue/handlers';
import { __resetDrainerStateForTests } from '../../mutation-queue/drainer';
import { runMigrations } from '../../db/migrations';
import { createTestDatabase, type TestSqliteDb } from '../../db/__tests__/sqlite-test-db';

type Row = Record<string, unknown>;

// Never-resolving fetch: the post-write drain parks at the first network call and
// never mutates the queue, keeping assertions about pending rows deterministic.
const parkedGraphqlFetch = (() => new Promise<never>(() => {})) as unknown as GraphQLFetch;

let db: TestSqliteDb;

beforeEach(async () => {
  uuidCounter = 0;
  invalidateQueries.mockClear();
  __resetDrainerStateForTests();
  db = createTestDatabase();
  await runMigrations(db);
});

afterEach(() => {
  __resetDrainerStateForTests();
});

describe('useOfflineSaveTick', () => {
  it('inserts a tick row matching the DDL columns and enqueues it', async () => {
    const saveTick = useOfflineSaveTick(db, parkedGraphqlFetch);

    const returnedUuid = await saveTick({
      boardType: 'kilter',
      climbUuid: 'climb-1',
      angle: 40,
      status: 'sent',
      attemptCount: 2,
      quality: 3,
      difficulty: 20,
      comment: 'nice',
      isMirror: true,
      isBenchmark: false,
    });

    const tick = await db.getFirstAsync<Row>('SELECT * FROM boardsesh_ticks WHERE uuid = ?', [returnedUuid]);
    expect(tick).not.toBeNull();
    expect(tick?.board_type).toBe('kilter');
    expect(tick?.is_mirror).toBe(1);
    expect(tick?.is_benchmark).toBe(0);

    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations WHERE idempotency_key = ?', [
      returnedUuid,
    ]);
    expect(queued).toHaveLength(1);
    expect(queued[0].table_name).toBe('boardsesh_ticks');
    expect(queued[0].operation).toBe('create');
  });
});

describe('useOfflineAddFavorite', () => {
  it('inserts (board_name, climb_uuid, angle, ...) without a synthetic id', async () => {
    const addFavorite = useOfflineAddFavorite(db, parkedGraphqlFetch);

    await addFavorite({ boardName: 'kilter', climbUuid: 'climb-9', angle: 40 });

    const favorite = await db.getFirstAsync<Row>(
      'SELECT * FROM user_favorites WHERE board_name = ? AND climb_uuid = ? AND angle = ?',
      ['kilter', 'climb-9', 40],
    );
    expect(favorite).not.toBeNull();
    expect(favorite?.user_id).toBeNull();

    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations');
    expect(queued).toHaveLength(1);
    expect(queued[0].idempotency_key).toBe('add:user_favorites:kilter:climb-9:40');
  });

  it('dedupes a double-tap add into a single queue row', async () => {
    const addFavorite = useOfflineAddFavorite(db, parkedGraphqlFetch);

    await addFavorite({ boardName: 'kilter', climbUuid: 'climb-9', angle: 40 });
    await addFavorite({ boardName: 'kilter', climbUuid: 'climb-9', angle: 40 });

    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations WHERE operation = ?', ['create']);
    expect(queued).toHaveLength(1);
  });
});

describe('useOfflineRemoveFavorite', () => {
  it('deletes by natural key and enqueues a deterministic delete key', async () => {
    await db.runAsync(
      "INSERT INTO user_favorites (board_name, climb_uuid, angle, created_at, updated_at) VALUES ('kilter', 'climb-9', 40, 'now', 'now')",
    );

    const removeFavorite = useOfflineRemoveFavorite(db, parkedGraphqlFetch);

    await removeFavorite({ boardName: 'kilter', climbUuid: 'climb-9', angle: 40 });

    const remaining = await db.getAllAsync<Row>('SELECT * FROM user_favorites');
    expect(remaining).toHaveLength(0);

    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations');
    expect(queued).toHaveLength(1);
    expect(queued[0].idempotency_key).toBe('del:user_favorites:kilter:climb-9:40');
  });

  it('dedupes repeat delete taps into a single queue row (reviewer I4)', async () => {
    const removeFavorite = useOfflineRemoveFavorite(db, parkedGraphqlFetch);

    await removeFavorite({ boardName: 'kilter', climbUuid: 'climb-9', angle: 40 });
    await removeFavorite({ boardName: 'kilter', climbUuid: 'climb-9', angle: 40 });

    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations WHERE operation = ?', ['delete']);
    expect(queued).toHaveLength(1);
  });
});

describe('useOfflineFollowUser', () => {
  it('inserts (following_id, ...) without a synthetic id or follower_id', async () => {
    const followUser = useOfflineFollowUser(db, parkedGraphqlFetch);

    await followUser('user-42');

    const follow = await db.getFirstAsync<Row>('SELECT * FROM user_follows WHERE following_id = ?', ['user-42']);
    expect(follow).not.toBeNull();
    expect(follow?.follower_id).toBeNull();

    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations');
    expect(queued).toHaveLength(1);
    expect(queued[0].idempotency_key).toBe('add:user_follows:user-42');
  });
});

describe('useOfflineUnfollowUser', () => {
  it('deletes by following_id and dedupes repeat taps (reviewer I4)', async () => {
    await db.runAsync(
      "INSERT INTO user_follows (following_id, created_at, updated_at) VALUES ('user-42', 'now', 'now')",
    );

    const unfollowUser = useOfflineUnfollowUser(db, parkedGraphqlFetch);

    await unfollowUser('user-42');
    await unfollowUser('user-42');

    const remaining = await db.getAllAsync<Row>('SELECT * FROM user_follows');
    expect(remaining).toHaveLength(0);

    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations WHERE operation = ?', ['delete']);
    expect(queued).toHaveLength(1);
    expect(queued[0].idempotency_key).toBe('del:user_follows:user-42');
  });
});
