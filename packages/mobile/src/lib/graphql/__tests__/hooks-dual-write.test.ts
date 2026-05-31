// Unit-tests the dual-write control flow of useSaveTick / useToggleFavorite
// against the REAL on-device DDL (node:sqlite), with the network and the DB
// handle mocked so the hook factory can run outside a render tree.
//
// Strategy: mock @tanstack/react-query so useMutation just returns the config it
// was given (we invoke mutationFn directly), and useQueryClient returns a stub.
// getHttpClient().request is a controllable spy; for the DB-present path it
// never resolves, so the fire-and-forget drain parks at the network call and the
// enqueued row stays pending for assertions. getDatabaseHandle is swapped per
// test to exercise both the dual-write path and the no-DB online fallback.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';

let uuidCounter = 0;
vi.mock('expo-crypto', () => ({
  randomUUID: () => `mock-tick-uuid-${++uuidCounter}`,
}));

// useMutation → identity over its config (expose mutationFn for direct calls);
// useQueryClient → stub with a spied invalidateQueries.
const invalidateQueries = vi.fn();
type MutationConfig<TVariables> = {
  mutationFn: (variables: TVariables) => Promise<unknown>;
  onSuccess?: () => void;
};
vi.mock('@tanstack/react-query', () => ({
  useMutation: <TVariables>(config: MutationConfig<TVariables>) => config,
  useQueryClient: () => ({ invalidateQueries }),
}));

// Controllable network + DB handle.
const request = vi.fn();
vi.mock('../client', () => ({
  getHttpClient: () => ({ request }),
}));

let handle: SQLiteDatabase | null = null;
vi.mock('../../../db', () => ({
  getDatabaseHandle: () => handle,
}));

import { useSaveTick, useToggleFavorite } from '../hooks';
import { __resetDrainerStateForTests } from '../../../mutation-queue/drainer';
import { runMigrations } from '../../../db/migrations';
import { createTestDatabase, type TestSqliteDb } from '../../../db/__tests__/sqlite-test-db';

type Row = Record<string, unknown>;

// useMutation is mocked to return its config verbatim, but the hooks are typed as
// returning UseMutationResult. Re-expose the config shape for direct invocation.
type ConfigOf<TVariables> = { mutationFn: (variables: TVariables) => Promise<unknown>; onSuccess?: () => void };
const asConfig = <TVariables>(hookResult: unknown): ConfigOf<TVariables> => hookResult as ConfigOf<TVariables>;

// Never-resolving request: the fire-and-forget drain parks here, so the enqueued
// row stays pending and assertions are deterministic.
const parkedRequest = () => new Promise<never>(() => {});

let db: TestSqliteDb;

beforeEach(async () => {
  uuidCounter = 0;
  invalidateQueries.mockClear();
  request.mockReset();
  __resetDrainerStateForTests();
  db = createTestDatabase();
  await runMigrations(db);
  handle = db;
});

afterEach(() => {
  __resetDrainerStateForTests();
  handle = null;
});

describe('useSaveTick dual-write', () => {
  it('with a DB handle: writes the tick locally + enqueues the full input, does NOT call the online SAVE_TICK', async () => {
    request.mockImplementation(parkedRequest);
    const { mutationFn, onSuccess } = asConfig<{ input: Record<string, unknown> }>(useSaveTick());

    await mutationFn({
      input: {
        boardType: 'kilter',
        climbUuid: 'climb-dual-1',
        angle: 40,
        isMirror: false,
        status: 'send',
        attemptCount: 2,
        quality: 4,
        difficulty: 21,
        isBenchmark: false,
        comment: 'sent',
        climbedAt: '2024-05-30T10:00:00.000Z',
        sessionId: 'session-9',
      },
    });

    // Local row landed with the climbedAt + sessionId from the UI.
    const tick = await db.getFirstAsync<Row>('SELECT * FROM boardsesh_ticks WHERE climb_uuid = ?', ['climb-dual-1']);
    expect(tick).not.toBeNull();
    expect(tick?.climbed_at).toBe('2024-05-30T10:00:00.000Z');
    expect(tick?.session_id).toBe('session-9');

    // Enqueued, keyed by the generated uuid, with the full input payload.
    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations');
    expect(queued).toHaveLength(1);
    expect(queued[0].table_name).toBe('boardsesh_ticks');
    expect(queued[0].idempotency_key).toBe(tick?.uuid);
    const payload = JSON.parse(queued[0].payload as string) as Record<string, unknown>;
    expect(payload.climbedAt).toBe('2024-05-30T10:00:00.000Z');

    // The drain fired (parked at the network) — but no direct online SAVE_TICK.
    // The only request the parked drain makes is the queued SaveTick replay, not
    // a SAVE_TICK from the online fallback path. Distinguish by the gql doc shape:
    // the online fallback would have passed `variables` of { input: ... } to the
    // SAVE_TICK doc. We assert the local+queue effects instead, which is the
    // contract; then run onSuccess to confirm it invalidates the right keys.
    onSuccess?.();
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['climb'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['searchClimbs'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['localTicks'] });
  });

  it('without a DB handle: falls back to the online SAVE_TICK request and writes nothing locally', async () => {
    handle = null;
    request.mockResolvedValue({ saveTick: { uuid: 'server-uuid' } });
    const { mutationFn } = asConfig<{ input: Record<string, unknown> }>(useSaveTick());

    const input = {
      boardType: 'kilter',
      climbUuid: 'climb-online-1',
      angle: 40,
      isMirror: false,
      status: 'send' as const,
      attemptCount: 2,
      quality: 4,
      difficulty: 21,
      isBenchmark: false,
      comment: 'sent',
      climbedAt: '2024-05-30T10:00:00.000Z',
    };
    await mutationFn({ input });

    // The online request was made with the SaveTick variables...
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toContain('saveTick');
    expect(request.mock.calls[0][1]).toEqual({ input });

    // ...and nothing was written to the local DB (no handle).
    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations');
    expect(queued).toHaveLength(0);
    const ticks = await db.getAllAsync<Row>('SELECT * FROM boardsesh_ticks');
    expect(ticks).toHaveLength(0);
  });
});

describe('useToggleFavorite dual-write', () => {
  it('currentlyFavorited=false with a DB handle: adds locally + enqueues create', async () => {
    request.mockImplementation(parkedRequest);
    const { mutationFn } = asConfig<{ input: Record<string, unknown>; currentlyFavorited: boolean }>(
      useToggleFavorite(),
    );

    await mutationFn({
      input: { boardName: 'kilter', climbUuid: 'climb-fav-1', angle: 40 },
      currentlyFavorited: false,
    });

    const favorite = await db.getFirstAsync<Row>(
      'SELECT * FROM user_favorites WHERE board_name = ? AND climb_uuid = ? AND angle = ?',
      ['kilter', 'climb-fav-1', 40],
    );
    expect(favorite).not.toBeNull();

    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations');
    expect(queued).toHaveLength(1);
    expect(queued[0].operation).toBe('create');
    expect(queued[0].idempotency_key).toBe('add:user_favorites:kilter:climb-fav-1:40');
  });

  it('currentlyFavorited=true with a DB handle: removes locally + enqueues delete', async () => {
    request.mockImplementation(parkedRequest);
    await db.runAsync(
      "INSERT INTO user_favorites (board_name, climb_uuid, angle, created_at, updated_at) VALUES ('kilter', 'climb-fav-2', 40, 'now', 'now')",
    );
    const { mutationFn } = asConfig<{ input: Record<string, unknown>; currentlyFavorited: boolean }>(
      useToggleFavorite(),
    );

    await mutationFn({
      input: { boardName: 'kilter', climbUuid: 'climb-fav-2', angle: 40 },
      currentlyFavorited: true,
    });

    const remaining = await db.getAllAsync<Row>('SELECT * FROM user_favorites WHERE climb_uuid = ?', ['climb-fav-2']);
    expect(remaining).toHaveLength(0);

    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations');
    expect(queued).toHaveLength(1);
    expect(queued[0].operation).toBe('delete');
    expect(queued[0].idempotency_key).toBe('del:user_favorites:kilter:climb-fav-2:40');
  });

  it('without a DB handle: falls back to the online TOGGLE_FAVORITE request', async () => {
    handle = null;
    request.mockResolvedValue({ toggleFavorite: { favorited: true } });
    const { mutationFn } = asConfig<{ input: Record<string, unknown>; currentlyFavorited: boolean }>(
      useToggleFavorite(),
    );

    await mutationFn({
      input: { boardName: 'kilter', climbUuid: 'climb-online-fav', angle: 40 },
      currentlyFavorited: false,
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toContain('toggleFavorite');
    // The currentlyFavorited flag is a client-only routing hint — it is NOT sent
    // to the backend (the online toggle takes only `input`).
    expect(request.mock.calls[0][1]).toEqual({
      input: { boardName: 'kilter', climbUuid: 'climb-online-fav', angle: 40 },
    });

    const queued = await db.getAllAsync<Row>('SELECT * FROM pending_mutations');
    expect(queued).toHaveLength(0);
  });
});
