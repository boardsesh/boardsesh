// Exercises the offline write primitives + follow hooks end-to-end against the
// REAL v1 DDL (via node:sqlite) so a column rename in schema.ts that breaks an
// INSERT/DELETE fails here.
//
// Runs in the default node environment (node:sqlite is node-only and can't be
// bundled for jsdom). The tick/favorite primitives are plain async functions (no
// React surface); the follow hooks' only React surface is useCallback (returns
// the callback unchanged) and useQueryClient (returns a query client), both
// mocked so the hook factory can be invoked outside a render tree.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';

// useCallback → identity; useQueryClient → stub. Only the follow hooks use them.
const invalidateQueries = vi.fn();
vi.mock('react', () => ({
  useCallback: <T>(callback: T) => callback,
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }) as unknown as QueryClient,
}));

import {
  writeTickLocal,
  addFavoriteLocal,
  removeFavoriteLocal,
  favoriteAddKey,
  favoriteRemoveKey,
  useOfflineFollowUser,
  useOfflineUnfollowUser,
  type SaveTickInput,
} from '../use-offline-mutations';
import type { GraphQLFetch } from '../../mutation-queue/handlers';
import { __resetDrainerStateForTests } from '../../mutation-queue/drainer';
import { runMigrations } from '../../db/migrations';
import { createTestDatabase, type TestSqliteDb } from '../../db/__tests__/sqlite-test-db';

type Row = Record<string, unknown>;

// Never-resolving fetch: the follow hooks' post-write drain parks at the first
// network call and never mutates the queue, keeping pending-row assertions stable.
const parkedGraphqlFetch = (() => new Promise<never>(() => {})) as unknown as GraphQLFetch;

// A full SaveTickInput as the UI builds it (carries climbedAt + sessionId).
function makeTickInput(overrides: Partial<SaveTickInput> = {}): SaveTickInput {
  return {
    boardType: 'kilter',
    climbUuid: 'climb-1',
    angle: 40,
    isMirror: true,
    status: 'send',
    attemptCount: 2,
    quality: 3,
    difficulty: 20,
    isBenchmark: false,
    comment: 'nice',
    climbedAt: '2024-05-30T10:00:00.000Z',
    ...overrides,
  };
}

let db: TestSqliteDb;

beforeEach(async () => {
  invalidateQueries.mockClear();
  __resetDrainerStateForTests();
  db = createTestDatabase();
  await runMigrations(db);
});

afterEach(() => {
  __resetDrainerStateForTests();
});

describe('writeTickLocal', () => {
  it('inserts a tick row matching the DDL columns and enqueues the FULL input', async () => {
    const input = makeTickInput({ sessionId: 'session-7' });

    await writeTickLocal(db, input, 'tick-uuid-1');

    const tick = await db.getFirstAsync<Row>('SELECT * FROM boardsesh_ticks WHERE uuid = ?', ['tick-uuid-1']);
    expect(tick).not.toBeNull();
    expect(tick?.board_type).toBe('kilter');
    expect(tick?.is_mirror).toBe(1);
    expect(tick?.is_benchmark).toBe(0);
    // climbedAt + sessionId now persist locally (the gap that dead-lettered before).
    expect(tick?.climbed_at).toBe('2024-05-30T10:00:00.000Z');
    expect(tick?.session_id).toBe('session-7');

    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations WHERE idempotency_key = ?', [
      'tick-uuid-1',
    ]);
    expect(queued).toHaveLength(1);
    expect(queued[0].table_name).toBe('boardsesh_ticks');
    expect(queued[0].operation).toBe('create');

    // The enqueued payload carries climbedAt (verbatim full input) — the backend
    // SaveTickInput contract is now satisfied.
    const payload = JSON.parse(queued[0].payload as string) as Record<string, unknown>;
    expect(payload.climbedAt).toBe('2024-05-30T10:00:00.000Z');
    expect(payload.sessionId).toBe('session-7');
  });

  it('persists a null session_id when the input omits sessionId', async () => {
    await writeTickLocal(db, makeTickInput(), 'tick-uuid-2');

    const tick = await db.getFirstAsync<Row>('SELECT session_id FROM boardsesh_ticks WHERE uuid = ?', ['tick-uuid-2']);
    expect(tick?.session_id).toBeNull();
  });
});

describe('addFavoriteLocal', () => {
  it('inserts (board_name, climb_uuid, angle, ...) without a synthetic id and a deterministic key', async () => {
    await addFavoriteLocal(db, { boardName: 'kilter', climbUuid: 'climb-9', angle: 40 });

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
    await addFavoriteLocal(db, { boardName: 'kilter', climbUuid: 'climb-9', angle: 40 });
    await addFavoriteLocal(db, { boardName: 'kilter', climbUuid: 'climb-9', angle: 40 });

    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations WHERE operation = ?', ['create']);
    expect(queued).toHaveLength(1);
  });
});

describe('removeFavoriteLocal', () => {
  it('deletes by natural key and enqueues a deterministic delete key', async () => {
    await db.runAsync(
      "INSERT INTO user_favorites (board_name, climb_uuid, angle, created_at, updated_at) VALUES ('kilter', 'climb-9', 40, 'now', 'now')",
    );

    await removeFavoriteLocal(db, { boardName: 'kilter', climbUuid: 'climb-9', angle: 40 });

    const remaining = await db.getAllAsync<Row>('SELECT * FROM user_favorites');
    expect(remaining).toHaveLength(0);

    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations');
    expect(queued).toHaveLength(1);
    expect(queued[0].idempotency_key).toBe('del:user_favorites:kilter:climb-9:40');
  });

  it('dedupes repeat delete taps into a single queue row (reviewer I4)', async () => {
    await removeFavoriteLocal(db, { boardName: 'kilter', climbUuid: 'climb-9', angle: 40 });
    await removeFavoriteLocal(db, { boardName: 'kilter', climbUuid: 'climb-9', angle: 40 });

    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations WHERE operation = ?', ['delete']);
    expect(queued).toHaveLength(1);
  });
});

describe('favorite idempotency keys', () => {
  it('derive add/del keys from the target so add and remove never collide', () => {
    const target = { boardName: 'tension', climbUuid: 'c', angle: 25 };
    expect(favoriteAddKey(target)).toBe('add:user_favorites:tension:c:25');
    expect(favoriteRemoveKey(target)).toBe('del:user_favorites:tension:c:25');
    expect(favoriteAddKey(target)).not.toBe(favoriteRemoveKey(target));
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
