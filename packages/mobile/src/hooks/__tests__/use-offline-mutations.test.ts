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
// The adapter reads the persisted download-trigger attribution (issue #4316),
// which pulls the settings store — and its native MMKV entry breaks the test
// bundler's scan. Same in-memory stand-in as remove-offline-board.test.ts.
const mockSettingsStorage = new Map<string, string>();
vi.mock('react-native-mmkv', () => {
  const createMockInstance = () => ({
    getString: (key: string) => mockSettingsStorage.get(key),
    set: (key: string, value: string) => void mockSettingsStorage.set(key, value),
    remove: (key: string) => void mockSettingsStorage.delete(key),
    clearAll: () => mockSettingsStorage.clear(),
  });
  return { createMMKV: vi.fn(() => createMockInstance()) };
});

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

// The retry ladder emits one analytics event per contended write; the event's
// own shape is covered in offline/__tests__/local-write-telemetry.test.ts.
const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/analytics', () => ({ track: trackMock }));

import {
  writeTickLocal,
  addFavoriteLocal,
  addClimbToPlaylistLocal,
  createPlaylistLocal,
  deletePlaylistLocal,
  deleteTickLocal,
  getFavoriteClimbUuidsLocal,
  getPlaylistMembershipsLocal,
  getPlaylistClimbsLocal,
  getPlaylistLocal,
  getPlaylistsLocal,
  removeClimbFromPlaylistLocal,
  reorderPlaylistClimbLocal,
  removeFavoriteLocal,
  enqueueTickOutboxOnly,
  favoriteAddKey,
  favoriteRemoveKey,
  useOfflineFollowUser,
  useOfflineUnfollowUser,
  type SaveTickInput,
  updatePlaylistLocal,
  updateTickLocal,
} from '../use-offline-mutations';
import { runMigrations, stampLocalUserId, type GraphQLFetch } from '@boardsesh/offline-sync';
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

// node:sqlite serializes, so genuine SQLITE_BUSY is unreachable in this suite.
// Wrapping the handle so the first N transactions throw the real driver message
// is what lets the ladder's behaviour be asserted against the REAL DDL: the
// recovering attempt still runs the actual SQL.
function withFailingTransactions(base: TestSqliteDb, failures: number, message: string): TestSqliteDb {
  let remaining = failures;
  return new Proxy(base, {
    get(target, property) {
      if (property === 'withExclusiveTransactionAsync') {
        return async (task: (txn: unknown) => Promise<void>) => {
          if (remaining > 0) {
            remaining -= 1;
            throw new Error(message);
          }
          return target.withExclusiveTransactionAsync(task as never);
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const LOCK_MESSAGE = 'Error code 5: database is locked';
const DISK_MESSAGE = 'database or disk is full';

let db: TestSqliteDb;

beforeEach(async () => {
  invalidateQueries.mockClear();
  reportEnqueueSuppressedMock.mockClear();
  trackMock.mockClear();
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

  // Issue #4315. The transaction is atomic, so losing the lock used to roll back
  // the tick row AND the outbox row — the send vanished. One retry is what makes
  // an ordinary contended save land.
  it('recovers a lock-contended write on the retry and lands exactly one tick and one queue row', async () => {
    await writeTickLocal(withFailingTransactions(db, 1, LOCK_MESSAGE), makeTickInput(), 'tick-retry-1');

    const ticks = await db.getAllAsync<Row>('SELECT * FROM boardsesh_ticks WHERE uuid = ?', ['tick-retry-1']);
    expect(ticks).toHaveLength(1);
    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations WHERE idempotency_key = ?', [
      'tick-retry-1',
    ]);
    expect(queued).toHaveLength(1);
  });

  // A SQLITE_BUSY can surface at COMMIT, so a retry can follow an attempt that
  // actually landed. The tick INSERT is OR IGNORE precisely so that re-run is a
  // no-op rather than a UNIQUE violation.
  it('is idempotent when the same uuid is written twice (commit-then-throw safety)', async () => {
    const input = makeTickInput();
    await writeTickLocal(db, input, 'tick-twice');
    await writeTickLocal(db, input, 'tick-twice');

    const ticks = await db.getAllAsync<Row>('SELECT * FROM boardsesh_ticks WHERE uuid = ?', ['tick-twice']);
    expect(ticks).toHaveLength(1);
    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations WHERE idempotency_key = ?', [
      'tick-twice',
    ]);
    expect(queued).toHaveLength(1);
  });

  it('rethrows a non-lock error without a second attempt', async () => {
    const flaky = withFailingTransactions(db, 1, DISK_MESSAGE);

    await expect(writeTickLocal(flaky, makeTickInput(), 'tick-disk')).rejects.toThrow(DISK_MESSAGE);

    const ticks = await db.getAllAsync<Row>('SELECT * FROM boardsesh_ticks');
    expect(ticks).toHaveLength(0);
  });

  // The adapter stamps input.uuid before the first write so the queued replay and
  // any network fall-through name the same server row. If the payload ever lost
  // it, the fall-through would log a second send.
  it('carries a caller-stamped input.uuid into the enqueued payload, matching the key', async () => {
    const input = makeTickInput({ uuid: 'tick-stamped' });

    await writeTickLocal(db, input, 'tick-stamped');

    const queued = await db.getFirstAsync<Row>('SELECT * FROM pending_mutations WHERE idempotency_key = ?', [
      'tick-stamped',
    ]);
    const payload = JSON.parse(queued?.payload as string) as Record<string, unknown>;
    expect(payload.uuid).toBe('tick-stamped');
    expect(payload.uuid).toBe(queued?.idempotency_key);
  });
});

// Issue #4315. The tick can survive on its outbox row alone: the drainer replays
// a queued mutation from its payload, so the local boardsesh_ticks row only ever
// served LOCAL reads (the "waiting to sync" badge, the offline logbook).
describe('enqueueTickOutboxOnly', () => {
  it('writes the queue row and NO tick row, with the payload the full write would have queued', async () => {
    const input = makeTickInput({ uuid: 'degraded-1', sessionId: 'session-7' });

    await enqueueTickOutboxOnly(db, input, 'degraded-1', 5000);

    const ticks = await db.getAllAsync<Row>('SELECT * FROM boardsesh_ticks');
    expect(ticks).toHaveLength(0);

    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations');
    expect(queued).toHaveLength(1);
    expect(queued[0].table_name).toBe('boardsesh_ticks');
    expect(queued[0].operation).toBe('create');
    expect(queued[0].idempotency_key).toBe('degraded-1');
    expect(JSON.parse(queued[0].payload as string)).toEqual(input);
  });

  it('is a no-throw no-op when the key is already queued', async () => {
    const input = makeTickInput({ uuid: 'degraded-2' });
    await enqueueTickOutboxOnly(db, input, 'degraded-2', 5000);

    await expect(enqueueTickOutboxOnly(db, input, 'degraded-2', 5000)).resolves.toBeUndefined();

    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations');
    expect(queued).toHaveLength(1);
  });

  it('retries once on a lock error', async () => {
    const flaky = withFailingTransactions(db, 1, LOCK_MESSAGE);

    await enqueueTickOutboxOnly(flaky, makeTickInput({ uuid: 'degraded-3' }), 'degraded-3', 5000);

    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations');
    expect(queued).toHaveLength(1);
  });
});

// The ladder is a class fix, not a tick fix: favorites and follows lost writes
// the same way and reported nothing at all. They keep today's reject-and-revert
// behaviour on a hard failure — only the retry (and the new event) are new.
describe('retry ladder across every local write', () => {
  const favorite = { boardName: 'kilter', climbUuid: 'climb-9', angle: 40 };

  it('addFavoriteLocal recovers and lands the same state as an uncontended run', async () => {
    await addFavoriteLocal(withFailingTransactions(db, 1, LOCK_MESSAGE), favorite);

    const rows = await db.getAllAsync<Row>('SELECT * FROM user_favorites');
    expect(rows).toHaveLength(1);
    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations');
    expect(queued).toHaveLength(1);
    expect(queued[0].idempotency_key).toBe(favoriteAddKey(favorite));
  });

  it('removeFavoriteLocal recovers', async () => {
    await db.runAsync(
      "INSERT INTO user_favorites (board_name, climb_uuid, angle, created_at, updated_at) VALUES ('kilter', 'climb-9', 40, 'now', 'now')",
    );

    await removeFavoriteLocal(withFailingTransactions(db, 1, LOCK_MESSAGE), favorite);

    expect(await db.getAllAsync<Row>('SELECT * FROM user_favorites')).toHaveLength(0);
    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations');
    expect(queued).toHaveLength(1);
    expect(queued[0].idempotency_key).toBe(favoriteRemoveKey(favorite));
  });

  it('the follow hooks recover', async () => {
    const followUser = useOfflineFollowUser(withFailingTransactions(db, 1, LOCK_MESSAGE), parkedGraphqlFetch);

    await followUser('user-42');

    expect(await db.getAllAsync<Row>('SELECT * FROM user_follows')).toHaveLength(1);
    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations');
    expect(queued).toHaveLength(1);
    expect(queued[0].idempotency_key).toBe('add:user_follows:user-42');
  });

  it('the unfollow hook recovers', async () => {
    await db.runAsync(
      "INSERT INTO user_follows (following_id, created_at, updated_at) VALUES ('user-42', 'now', 'now')",
    );
    const unfollowUser = useOfflineUnfollowUser(withFailingTransactions(db, 1, LOCK_MESSAGE), parkedGraphqlFetch);

    await unfollowUser('user-42');

    expect(await db.getAllAsync<Row>('SELECT * FROM user_follows')).toHaveLength(0);
    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations');
    expect(queued).toHaveLength(1);
    expect(queued[0].idempotency_key).toBe('del:user_follows:user-42');
  });

  it('rethrows a non-lock favorite failure untouched (favorites are NOT degraded)', async () => {
    await expect(addFavoriteLocal(withFailingTransactions(db, 1, DISK_MESSAGE), favorite)).rejects.toThrow(
      DISK_MESSAGE,
    );
    expect(await db.getAllAsync<Row>('SELECT * FROM user_favorites')).toHaveLength(0);
  });

  // A retried write re-runs `enqueue`, which can now see a row a previous attempt
  // committed. That is only safe because reportEnqueueSuppressed early-returns
  // unless the existing row is a dead letter — pinned here rather than left as an
  // accident of the reporter's filter.
  it('never reports a suppressed enqueue just because the write was retried', async () => {
    await addFavoriteLocal(withFailingTransactions(db, 1, LOCK_MESSAGE), favorite);

    expect(reportEnqueueSuppressedMock).not.toHaveBeenCalled();
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

describe('local-only favorites', () => {
  const favorite = { boardName: 'kilter', climbUuid: 'climb-local', angle: 40 };

  it('stores the stamped owner without an outbox row or retry telemetry', async () => {
    await stampLocalUserId(db, 'local:profile-1');

    await addFavoriteLocal(withFailingTransactions(db, 1, LOCK_MESSAGE), favorite, 'local-only');

    const row = await db.getFirstAsync<Row>('SELECT * FROM user_favorites WHERE climb_uuid = ?', [favorite.climbUuid]);
    expect(row?.user_id).toBe('local:profile-1');
    expect(await db.getAllAsync<Row>('SELECT * FROM pending_mutations')).toHaveLength(0);
    expect(reportEnqueueSuppressedMock).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('reads only favorites owned by the stamped local profile', async () => {
    await db.runAsync(
      `INSERT INTO user_favorites (board_name, climb_uuid, angle, user_id, created_at)
       VALUES ('kilter', 'mine', 40, 'local:profile-1', '2026-01-02'),
              ('kilter', 'theirs', 40, 'local:profile-2', '2026-01-01'),
              ('kilter', 'wrong-angle', 50, 'local:profile-1', '2026-01-03')`,
    );
    await stampLocalUserId(db, 'local:profile-1');

    await expect(getFavoriteClimbUuidsLocal(db, 'kilter', 40)).resolves.toEqual(['mine']);
  });

  it("does not remove another local profile owner's favorite", async () => {
    await db.runAsync(
      `INSERT INTO user_favorites (board_name, climb_uuid, angle, user_id, created_at)
       VALUES ('kilter', 'climb-local', 40, 'local:profile-2', '2026-01-01')`,
    );
    await stampLocalUserId(db, 'local:profile-1');

    await removeFavoriteLocal(db, favorite, 'local-only');

    expect(await db.getAllAsync<Row>('SELECT * FROM user_favorites')).toHaveLength(1);
    expect(await db.getAllAsync<Row>('SELECT * FROM pending_mutations')).toHaveLength(0);
    expect(reportEnqueueSuppressedMock).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('rejects local reads and writes until the owner stamp exists', async () => {
    await expect(getFavoriteClimbUuidsLocal(db, 'kilter', 40)).rejects.toThrow('owner is not initialized');
    await expect(addFavoriteLocal(db, favorite, 'local-only')).rejects.toThrow('owner is not initialized');
    await expect(removeFavoriteLocal(db, favorite, 'local-only')).rejects.toThrow('owner is not initialized');
    expect(await db.getAllAsync<Row>('SELECT * FROM user_favorites')).toHaveLength(0);
    expect(await db.getAllAsync<Row>('SELECT * FROM pending_mutations')).toHaveLength(0);
  });
});

describe('local-only playlists', () => {
  beforeEach(async () => {
    await stampLocalUserId(db, 'local:profile-1');
  });

  it('creates and lists a private owner-scoped playlist without queue or telemetry', async () => {
    const playlist = await createPlaylistLocal(
      withFailingTransactions(db, 1, LOCK_MESSAGE),
      { boardType: 'kilter', layoutId: 1, name: 'Projects', description: 'Private' },
      'playlist-local-1',
    );

    expect(playlist).toMatchObject({
      uuid: 'playlist-local-1',
      name: 'Projects',
      description: 'Private',
      isPublic: false,
      userRole: 'owner',
      climbCount: 0,
    });
    await expect(getPlaylistsLocal(db)).resolves.toEqual([playlist]);
    expect(await db.getAllAsync<Row>('SELECT * FROM pending_mutations')).toHaveLength(0);
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('adds and removes membership locally without queue or telemetry', async () => {
    await createPlaylistLocal(db, { boardType: 'kilter', layoutId: 1, name: 'Projects' }, 'playlist-local-1');

    await expect(
      addClimbToPlaylistLocal(db, { playlistId: 'playlist-local-1', climbUuid: 'climb-1', angle: 40 }),
    ).resolves.toBe(false);
    await expect(getPlaylistMembershipsLocal(db)).resolves.toEqual(
      new Map([['climb-1', new Set(['playlist-local-1'])]]),
    );
    expect((await getPlaylistsLocal(db))[0]?.climbCount).toBe(1);

    await expect(
      removeClimbFromPlaylistLocal(db, { playlistId: 'playlist-local-1', climbUuid: 'climb-1' }),
    ).resolves.toBe(true);
    await expect(getPlaylistMembershipsLocal(db)).resolves.toEqual(new Map());
    expect(await db.getAllAsync<Row>('SELECT * FROM pending_mutations')).toHaveLength(0);
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('reads and reorders playlist climbs from the downloaded catalog without network work', async () => {
    await db.runAsync(
      `INSERT INTO board_climbs
         (uuid, board_type, layout_id, setter_username, name, description, frames, is_draft, compatible_size_ids)
       VALUES ('climb-1', 'kilter', 1, 'setter', 'First', 'One', 'frames-1', 0, '[1]'),
              ('climb-2', 'kilter', 1, 'setter', 'Second', 'Two', 'frames-2', 0, '[1]')`,
    );
    await createPlaylistLocal(db, { boardType: 'kilter', layoutId: 1, name: 'Projects' }, 'playlist-local-1');
    await addClimbToPlaylistLocal(db, { playlistId: 'playlist-local-1', climbUuid: 'climb-1', angle: 40 });
    await addClimbToPlaylistLocal(db, { playlistId: 'playlist-local-1', climbUuid: 'climb-2', angle: 45 });

    await expect(getPlaylistLocal(db, 'playlist-local-1')).resolves.toMatchObject({ climbCount: 2 });
    await expect(getPlaylistClimbsLocal(db, { playlistId: 'playlist-local-1', pageSize: 1 })).resolves.toMatchObject({
      climbs: [{ uuid: 'climb-1', angle: 40 }],
      totalCount: 2,
      hasMore: true,
    });
    await expect(
      reorderPlaylistClimbLocal(db, { playlistId: 'playlist-local-1', climbUuid: 'climb-2', newIndex: 0 }),
    ).resolves.toBe(true);
    await expect(getPlaylistClimbsLocal(db, { playlistId: 'playlist-local-1' })).resolves.toMatchObject({
      climbs: [
        { uuid: 'climb-2', angle: 45 },
        { uuid: 'climb-1', angle: 40 },
      ],
      totalCount: 2,
      hasMore: false,
    });
    expect(await db.getAllAsync<Row>('SELECT * FROM pending_mutations')).toHaveLength(0);
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('reorders a 500-climb playlist without exceeding SQLite bind limits', async () => {
    await createPlaylistLocal(db, { boardType: 'kilter', layoutId: 1, name: 'Circuit' }, 'playlist-large');
    await db.runAsync(
      `WITH RECURSIVE climb_numbers(position) AS (
         SELECT 0
         UNION ALL
         SELECT position + 1 FROM climb_numbers WHERE position < 499
       )
       INSERT INTO playlist_climbs (playlist_uuid, climb_uuid, position)
       SELECT 'playlist-large', printf('climb-%03d', position), position FROM climb_numbers`,
    );

    await expect(
      reorderPlaylistClimbLocal(db, { playlistId: 'playlist-large', climbUuid: 'climb-499', newIndex: 0 }),
    ).resolves.toBe(true);

    expect(
      await db.getAllAsync<Row>(
        `SELECT climb_uuid, position FROM playlist_climbs
         WHERE playlist_uuid = ? ORDER BY position ASC LIMIT 2`,
        ['playlist-large'],
      ),
    ).toEqual([
      expect.objectContaining({ climb_uuid: 'climb-499', position: 0 }),
      expect.objectContaining({ climb_uuid: 'climb-000', position: 1 }),
    ]);
  });

  it('deletes the playlist and its membership locally', async () => {
    await createPlaylistLocal(db, { boardType: 'kilter', layoutId: 1, name: 'Projects' }, 'playlist-local-1');
    await addClimbToPlaylistLocal(db, { playlistId: 'playlist-local-1', climbUuid: 'climb-1', angle: 40 });

    await expect(deletePlaylistLocal(db, 'playlist-local-1')).resolves.toBe(true);

    expect(await db.getAllAsync<Row>('SELECT * FROM playlists')).toHaveLength(0);
    expect(await db.getAllAsync<Row>('SELECT * FROM playlist_climbs')).toHaveLength(0);
    expect(await db.getAllAsync<Row>('SELECT * FROM pending_mutations')).toHaveLength(0);
  });

  it('rejects every playlist operation when the database has no local owner', async () => {
    const unstampedDb = createTestDatabase();
    await runMigrations(unstampedDb);

    await expect(getPlaylistsLocal(unstampedDb)).rejects.toThrow('owner is not initialized');
    await expect(getPlaylistLocal(unstampedDb, 'playlist-local-1')).rejects.toThrow('owner is not initialized');
    await expect(getPlaylistClimbsLocal(unstampedDb, { playlistId: 'playlist-local-1' })).rejects.toThrow(
      'owner is not initialized',
    );
    await expect(
      createPlaylistLocal(unstampedDb, { boardType: 'kilter', layoutId: 1, name: 'Projects' }, 'playlist-local-1'),
    ).rejects.toThrow('owner is not initialized');
    await expect(deletePlaylistLocal(unstampedDb, 'playlist-local-1')).rejects.toThrow('owner is not initialized');
    expect(await unstampedDb.getAllAsync<Row>('SELECT * FROM playlists')).toHaveLength(0);
  });
});

describe('account Work Offline tick edits', () => {
  beforeEach(async () => {
    await stampLocalUserId(db, 'account-user-1');
    await db.runAsync(
      `INSERT INTO boardsesh_ticks
         (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, comment, climbed_at, created_at, updated_at)
       VALUES ('account-tick-1', 'account-user-1', 'kilter', 'climb-1', 40, 'attempt', 1, '',
               '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')`,
    );
  });

  it('updates SQLite and queues account delivery without performing network work', async () => {
    await expect(
      updateTickLocal(db, 'account-tick-1', { status: 'send', comment: 'done' }, 'account', 'update-key'),
    ).resolves.toMatchObject({ uuid: 'account-tick-1', status: 'send', comment: 'done' });

    expect(
      await db.getFirstAsync<Row>('SELECT status, comment FROM boardsesh_ticks WHERE uuid = ?', ['account-tick-1']),
    ).toMatchObject({ status: 'send', comment: 'done' });
    expect(await db.getFirstAsync<Row>('SELECT operation, idempotency_key FROM pending_mutations')).toMatchObject({
      operation: 'update',
      idempotency_key: 'update-key',
    });
  });

  it('deletes SQLite and queues account delivery without performing network work', async () => {
    await expect(deleteTickLocal(db, 'account-tick-1', 'account', 'delete-key')).resolves.toBe(true);

    expect(
      await db.getFirstAsync<Row>('SELECT uuid FROM boardsesh_ticks WHERE uuid = ?', ['account-tick-1']),
    ).toBeNull();
    expect(await db.getFirstAsync<Row>('SELECT operation, idempotency_key FROM pending_mutations')).toMatchObject({
      operation: 'delete',
      idempotency_key: 'delete-key',
    });
  });
});

describe('account Work Offline playlists', () => {
  beforeEach(async () => {
    await stampLocalUserId(db, 'account-user-1');
  });

  it('queues private playlist CRUD and membership changes for account delivery', async () => {
    await createPlaylistLocal(
      db,
      { boardType: 'kilter', layoutId: 1, name: 'Projects' },
      'playlist-account-1',
      'account',
    );
    await addClimbToPlaylistLocal(db, { playlistId: 'playlist-account-1', climbUuid: 'climb-1', angle: 40 }, 'account');
    await reorderPlaylistClimbLocal(
      db,
      { playlistId: 'playlist-account-1', climbUuid: 'climb-1', newIndex: 0 },
      'account',
    );

    expect(await db.getAllAsync<Row>('SELECT table_name, operation FROM pending_mutations ORDER BY id')).toEqual([
      expect.objectContaining({ table_name: 'playlists', operation: 'create' }),
      expect.objectContaining({ table_name: 'playlist_climbs', operation: 'create' }),
      expect.objectContaining({ table_name: 'playlist_climbs', operation: 'update' }),
    ]);

    await removeClimbFromPlaylistLocal(db, { playlistId: 'playlist-account-1', climbUuid: 'climb-1' }, 'account');
    await deletePlaylistLocal(db, 'playlist-account-1', 'account');

    expect(await db.getAllAsync<Row>('SELECT * FROM playlists')).toHaveLength(0);
    expect(
      await db.getAllAsync<Row>(
        `SELECT table_name, operation FROM pending_mutations
         WHERE operation = 'delete' ORDER BY id`,
      ),
    ).toEqual([
      expect.objectContaining({ table_name: 'playlist_climbs', operation: 'delete' }),
      expect.objectContaining({ table_name: 'playlists', operation: 'delete' }),
    ]);
  });

  it('requires going online before publishing a playlist', async () => {
    await createPlaylistLocal(
      db,
      { boardType: 'kilter', layoutId: 1, name: 'Projects' },
      'playlist-account-1',
      'account',
    );

    await expect(
      updatePlaylistLocal(db, { playlistId: 'playlist-account-1', isPublic: true }, 'account'),
    ).rejects.toThrow('Go online to publish a playlist');

    await expect(getPlaylistLocal(db, 'playlist-account-1')).resolves.toMatchObject({ isPublic: false });
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
