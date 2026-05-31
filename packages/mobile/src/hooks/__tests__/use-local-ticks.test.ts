// Verifies useLocalPendingTicks counts only this-device ticks that are still
// queued (unsynced) for a given climb, against the REAL v1 DDL via node:sqlite.
//
// React surface is stubbed: useQuery is replaced with a shim that runs the
// queryFn immediately and exposes its result as `data`, so the hook's SQL can be
// exercised outside a render tree. getDatabaseHandle is pointed at the test db.

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { runMigrations } from '../../db/migrations';
import { enqueue } from '../../mutation-queue/queue';
import { createTestDatabase, type TestSqliteDb } from '../../db/__tests__/sqlite-test-db';

let db: TestSqliteDb;

vi.mock('../../db', () => ({
  getDatabaseHandle: () => db,
}));

// useQuery shim: invoke queryFn synchronously-ish and surface the resolved value.
// Returns a thenable-free object with `data` once the promise settles; tests await
// the call result explicitly via the exposed runner.
type QueryArgs<T> = { queryFn: () => Promise<T>; enabled?: boolean };
const lastResult: { value: unknown } = { value: undefined };
vi.mock('@tanstack/react-query', () => ({
  useQuery: <T>({ queryFn, enabled }: QueryArgs<T>) => {
    if (enabled === false) {
      lastResult.value = Promise.resolve(undefined);
      return { data: undefined };
    }
    lastResult.value = queryFn();
    return { data: undefined };
  },
}));

import { useLocalPendingTicks } from '../use-local-ticks';

async function runHook(climbUuid: string, boardType: string): Promise<number | undefined> {
  useLocalPendingTicks(climbUuid, boardType);
  return (await lastResult.value) as number | undefined;
}

beforeEach(async () => {
  db = createTestDatabase();
  await runMigrations(db);
  lastResult.value = undefined;
});

async function insertTick(uuid: string, climbUuid: string, boardType: string): Promise<void> {
  await db.runAsync(`INSERT INTO boardsesh_ticks (uuid, board_type, climb_uuid, angle) VALUES (?, ?, ?, ?)`, [
    uuid,
    boardType,
    climbUuid,
    40,
  ]);
}

describe('useLocalPendingTicks', () => {
  it('counts ticks whose uuid is still in the mutation queue for the climb', async () => {
    await insertTick('tick-1', 'climb-1', 'kilter');
    await enqueue(db, 'boardsesh_ticks', 'create', { climbUuid: 'climb-1' }, 'tick-1');
    await insertTick('tick-2', 'climb-1', 'kilter');
    await enqueue(db, 'boardsesh_ticks', 'create', { climbUuid: 'climb-1' }, 'tick-2');

    expect(await runHook('climb-1', 'kilter')).toBe(2);
  });

  it('ignores ticks that have already synced (no queue row)', async () => {
    // Synced tick: row exists but its queue entry was deleted on completion.
    await insertTick('tick-synced', 'climb-1', 'kilter');
    // Pending tick on the same climb.
    await insertTick('tick-pending', 'climb-1', 'kilter');
    await enqueue(db, 'boardsesh_ticks', 'create', { climbUuid: 'climb-1' }, 'tick-pending');

    expect(await runHook('climb-1', 'kilter')).toBe(1);
  });

  it('scopes the count to the requested climb and board', async () => {
    await insertTick('tick-1', 'climb-1', 'kilter');
    await enqueue(db, 'boardsesh_ticks', 'create', {}, 'tick-1');
    await insertTick('tick-2', 'climb-2', 'kilter');
    await enqueue(db, 'boardsesh_ticks', 'create', {}, 'tick-2');
    await insertTick('tick-3', 'climb-1', 'tension');
    await enqueue(db, 'boardsesh_ticks', 'create', {}, 'tick-3');

    expect(await runHook('climb-1', 'kilter')).toBe(1);
  });

  it('does not count non-tick mutations that happen to share an idempotency key shape', async () => {
    await insertTick('tick-1', 'climb-1', 'kilter');
    // A favorite mutation keyed on the same string must not be miscounted.
    await enqueue(db, 'user_favorites', 'create', {}, 'tick-1');

    expect(await runHook('climb-1', 'kilter')).toBe(0);
  });

  it('returns 0 when there is no database handle', async () => {
    const original = db;
    // Simulate no handle by pointing the mock at undefined for this call.
    db = undefined as unknown as TestSqliteDb;
    const result = await runHook('climb-1', 'kilter');
    db = original;
    expect(result).toBe(0);
  });
});
