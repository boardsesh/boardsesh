// The drainer's owner check (#6824), against the real schema over node:sqlite.
//
// The outbox records no owner, and the server files a replayed write under the
// token that sends it. So a drain sends only when the database's owner stamp
// names the signed-in account, and a drain that declines must leave every row
// exactly as it found it: no retry charged, no failure recorded, nothing
// dead-lettered. The write is the climber's; it just is not sendable yet.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QueryInvalidator } from '../../database';
import { drainMutationQueue, beginGlobalPurge, __resetDrainerStateForTests, type OutboxOwnerRefusal } from '../drainer';
import type { GraphQLFetch } from '../handlers';
import { enqueue } from '../queue';
import { runMigrations } from '../../db/migrations';
import { stampLocalUserId } from '../../sync/local-user-owner';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';

type OutboxRow = { idempotency_key: string; status: string; retry_count: number; last_error: string | null };

const A_TICK = '00000000-0000-4000-8000-00000000000a';
const B_TICK = '00000000-0000-4000-8000-00000000000b';

const tickInput = (comment: string) => ({
  boardType: 'kilter',
  climbUuid: 'climb-1',
  angle: 40,
  isMirror: false,
  status: 'send',
  attemptCount: 1,
  isBenchmark: false,
  comment,
  climbedAt: '2026-10-20T18:00:00.000Z',
});

let db: TestSqliteDb;
let sentTicks: string[];
let refusals: OutboxOwnerRefusal[];
const queryClient: QueryInvalidator = { invalidateQueries: vi.fn() };

const graphqlFetch = (async (_query: string, variables?: Record<string, unknown>) => {
  const input = variables?.input as { uuid?: string } | undefined;
  if (input?.uuid) sentTicks.push(input.uuid);
  return { saveTick: { uuid: input?.uuid } };
}) as GraphQLFetch;

function drainAs(signedInUserId: string | undefined, getSignedInUserId = async () => signedInUserId) {
  return drainMutationQueue(db, queryClient, graphqlFetch, {
    isOnline: () => true,
    getSignedInUserId,
    onOutboxOwnerRefused: (reason) => refusals.push(reason),
  });
}

function outbox(): Promise<OutboxRow[]> {
  return db.getAllAsync<OutboxRow>(
    'SELECT idempotency_key, status, retry_count, last_error FROM pending_mutations ORDER BY id',
  );
}

const untouched = (key: string): OutboxRow => ({
  idempotency_key: key,
  status: 'pending',
  retry_count: 0,
  last_error: null,
});

beforeEach(async () => {
  __resetDrainerStateForTests();
  db = createTestDatabase();
  await runMigrations(db);
  sentTicks = [];
  refusals = [];
});

afterEach(() => {
  db.close();
});

describe('drainMutationQueue: whose outbox is this?', () => {
  it("sends nothing while the stamp names another account, and leaves A's write untouched", async () => {
    await stampLocalUserId(db, 'user-a');
    await enqueue(db, 'boardsesh_ticks', 'create', tickInput("A's send"), A_TICK);

    await drainAs('user-b');

    expect(sentTicks).toEqual([]);
    expect(refusals).toEqual(['other-account']);
    expect(await outbox()).toEqual([untouched(A_TICK)]);
  });

  it('holds a write queued before the stamp without charging it, then sends it once the account claims the device', async () => {
    // A fresh sign-in: B logged a send before the owner check stamped the database.
    await enqueue(db, 'boardsesh_ticks', 'create', tickInput("B's send"), B_TICK);

    await drainAs('user-b');
    await drainAs('user-b');

    expect(sentTicks).toEqual([]);
    expect(refusals).toEqual(['unstamped', 'unstamped']);
    expect(await outbox()).toEqual([untouched(B_TICK)]);

    await stampLocalUserId(db, 'user-b');
    await drainAs('user-b');

    expect(sentTicks).toEqual([B_TICK]);
    expect(await outbox()).toEqual([]);
  });

  it('sends nothing when no account is signed in', async () => {
    await stampLocalUserId(db, 'user-a');
    await enqueue(db, 'boardsesh_ticks', 'create', tickInput("A's send"), A_TICK);

    await drainAs(undefined);

    expect(sentTicks).toEqual([]);
    expect(refusals).toEqual(['no-signed-in-user']);
    expect(await outbox()).toEqual([untouched(A_TICK)]);
  });

  it('delivers to the account the stamp names', async () => {
    await stampLocalUserId(db, 'user-a');
    await enqueue(db, 'boardsesh_ticks', 'create', tickInput("A's send"), A_TICK);

    await drainAs('user-a');

    expect(sentTicks).toEqual([A_TICK]);
    expect(refusals).toEqual([]);
    expect(await outbox()).toEqual([]);
  });

  it('stops before its first send when a wipe lands while the owner is being read', async () => {
    await stampLocalUserId(db, 'user-a');
    await enqueue(db, 'boardsesh_ticks', 'create', tickInput("A's send"), A_TICK);

    // The owner check passes for the stamp it read, but the account boundary's
    // wipe started while the token was being read: its epoch must still win.
    await drainAs('user-a', async () => {
      beginGlobalPurge();
      return 'user-a';
    });

    expect(sentTicks).toEqual([]);
    expect(await outbox()).toEqual([untouched(A_TICK)]);
  });

  it('keeps refusing when the refusal reporter throws', async () => {
    await stampLocalUserId(db, 'user-a');
    await enqueue(db, 'boardsesh_ticks', 'create', tickInput("A's send"), A_TICK);

    await drainMutationQueue(db, queryClient, graphqlFetch, {
      isOnline: () => true,
      getSignedInUserId: async () => 'user-b',
      onOutboxOwnerRefused: () => {
        throw new Error('reporter broke');
      },
    });

    expect(sentTicks).toEqual([]);
    expect(await outbox()).toEqual([untouched(A_TICK)]);
  });
});
