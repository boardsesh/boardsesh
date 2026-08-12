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
  onlineManager: { isOnline: () => true },
}));

// The drain now routes through the mobile adapter, which binds AppState/NetInfo
// at module load — stub both so this suite keeps running in the node env.
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock('@react-native-community/netinfo', () => ({
  default: { addEventListener: () => () => {} },
}));

// The reporter itself is unit-tested in offline/__tests__/outbox-telemetry.test.ts;
// here we prove the write primitives feed it the right enqueue outcome.
const reportEnqueueSuppressedMock = vi.hoisted(() => vi.fn());
vi.mock('../../offline/outbox-telemetry', () => ({
  reportEnqueueSuppressed: reportEnqueueSuppressedMock,
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
import { runMigrations, type GraphQLFetch } from '@boardsesh/offline-sync';
import { createTestDatabase, __resetDrainerStateForTests, type TestSqliteDb } from '@boardsesh/offline-sync/testing';

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
  reportEnqueueSuppressedMock.mockClear();
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

describe('favorite queue coalescing', () => {
  it('add -> remove cancels the pending add but still enqueues the remove (in-flight-add race guard)', async () => {
    await addFavoriteLocal(db, { boardName: 'kilter', climbUuid: 'climb-9', angle: 40 });
    await removeFavoriteLocal(db, { boardName: 'kilter', climbUuid: 'climb-9', angle: 40 });

    // The drainer doesn't mark rows in-flight, so the cancel can hit a row whose
    // mutation was already sent. The remove is enqueued unconditionally — the
    // server treats removing a nonexistent favorite as an idempotent no-op, so
    // this is free when the cancel was real and corrective when it raced.
    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations');
    expect(queued).toHaveLength(1);
    expect(queued[0].operation).toBe('delete');
    expect(queued[0].idempotency_key).toBe('del:user_favorites:kilter:climb-9:40');
  });

  it('collapses add -> remove -> add into one final add mutation', async () => {
    await addFavoriteLocal(db, { boardName: 'kilter', climbUuid: 'climb-9', angle: 40 });
    await removeFavoriteLocal(db, { boardName: 'kilter', climbUuid: 'climb-9', angle: 40 });
    await addFavoriteLocal(db, { boardName: 'kilter', climbUuid: 'climb-9', angle: 40 });

    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations');
    expect(queued).toHaveLength(1);
    expect(queued[0].operation).toBe('create');
    expect(queued[0].idempotency_key).toBe('add:user_favorites:kilter:climb-9:40');
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

// Issue #4315. `enqueue` is INSERT OR IGNORE against a UNIQUE idempotency key,
// and the cancel DELETEs in these primitives match only status = 'pending'. So
// once a favorite/follow key dead-letters it owns that key forever: every later
// tap writes the local row, gets silently dropped at enqueue time, and produces
// no queue row to drain and therefore no dead-letter event anywhere. Making the
// swallow countable is the point; reviving the row is a separate behaviour
// change with its own issue.
describe('enqueue suppressed by a dead-lettered key', () => {
  const favorite = { boardName: 'kilter', climbUuid: 'climb-9', angle: 40 };

  async function deadLetterExistingRow(idempotencyKey: string) {
    await db.runAsync("UPDATE pending_mutations SET status = 'dead_letter' WHERE idempotency_key = ?", [
      idempotencyKey,
    ]);
  }

  it('reports when a favorite add is swallowed by a dead-lettered row', async () => {
    await addFavoriteLocal(db, favorite);
    await deadLetterExistingRow(favoriteAddKey(favorite));
    reportEnqueueSuppressedMock.mockClear();

    await addFavoriteLocal(db, favorite);

    expect(reportEnqueueSuppressedMock).toHaveBeenCalledWith('user_favorites', 'create', 'dead_letter');
    // The local row still exists, so the UI shows a favorite that will never sync.
    const rows = await db.getAllAsync<Row>('SELECT * FROM user_favorites');
    expect(rows).toHaveLength(1);
  });

  it('reports when a favorite remove is swallowed', async () => {
    await removeFavoriteLocal(db, favorite);
    await deadLetterExistingRow(favoriteRemoveKey(favorite));
    reportEnqueueSuppressedMock.mockClear();

    await removeFavoriteLocal(db, favorite);

    expect(reportEnqueueSuppressedMock).toHaveBeenCalledWith('user_favorites', 'delete', 'dead_letter');
  });

  it('reports when a follow is swallowed', async () => {
    const followUser = useOfflineFollowUser(db, parkedGraphqlFetch);
    await followUser('user-42');
    await deadLetterExistingRow('add:user_follows:user-42');
    reportEnqueueSuppressedMock.mockClear();

    await followUser('user-42');

    expect(reportEnqueueSuppressedMock).toHaveBeenCalledWith('user_follows', 'create', 'dead_letter');
  });

  it('reports a live pending duplicate as pending, not as a loss', async () => {
    await addFavoriteLocal(db, favorite);
    reportEnqueueSuppressedMock.mockClear();

    await addFavoriteLocal(db, favorite);

    expect(reportEnqueueSuppressedMock).toHaveBeenCalledWith('user_favorites', 'create', 'pending');
  });

  it('never fires on a fresh insert', async () => {
    await addFavoriteLocal(db, favorite);
    expect(reportEnqueueSuppressedMock).not.toHaveBeenCalled();
  });
});
