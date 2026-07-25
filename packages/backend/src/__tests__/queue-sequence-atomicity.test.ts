/**
 * Queue-state atomicity (issue #3906).
 *
 * Sequence assignment used to be a read-modify-write: HGETALL the session hash,
 * compute `version + 1` in Node, HMSET the whole hash back. Two overlapping
 * mutations both read the same version, both wrote `+1`, and the second HMSET
 * overwrote the entire `queue` array — a climb a party member had just added
 * silently vanished. Worse, `updateQueueState` accepted an `expectedVersion`
 * and never compared it to anything, so every `VersionConflictError` retry loop
 * aimed at it was dead code.
 *
 * The tests below are deliberately not timing-dependent. Layers 1 and 2 pin the
 * exact interleaving through a gate on the mock's `eval`, so they fail
 * reproducibly on the old code rather than flaking. Layer 3 runs the real Lua
 * script against a real Redis, where atomicity holds for *any* interleaving, so
 * hammering it concurrently can't be flaky either.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { roomManager, VersionConflictError } from '../services/room-manager';
import { UPDATE_QUEUE_STATE_CAS_SCRIPT, CAS_ANY_VERSION, RedisSessionStore } from '../services/redis-session-store';
import { queueMutations } from '../graphql/resolvers/queue/mutations';
import { controllerMutations } from '../graphql/resolvers/controller/mutations';
import { pubsub } from '../pubsub';
import { WriteScheduler, writeQueueStateToPostgres } from '../services/room-manager/write-scheduler';
import { db } from '../db/client';
import { sessionQueues } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import { createMockRedis, type MockRedis } from './helpers/mock-redis';

const createTestClimb = (name = 'Test Climb'): ClimbQueueItem => ({
  uuid: uuidv4(),
  climb: {
    uuid: uuidv4(),
    setter_username: 'TestSetter',
    name,
    description: 'A test climb',
    frames: '{}',
    angle: 40,
    ascensionist_count: 10,
    difficulty: '6A',
    quality_average: '3.5',
    stars: 3.5,
    difficulty_error: '0.5',
    mirrored: false,
    benchmark_difficulty: null,
  },
  addedBy: 'test-user',
  tickedBy: [],
  suggested: false,
});

type Deferred = { promise: Promise<void>; resolve: () => void };
const defer = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolveFn) => {
    resolve = resolveFn;
  });
  return { promise, resolve };
};

/**
 * Pause individual compare-and-swap calls so a test can pin the exact order of
 * two concurrent mutations. Only the queue CAS script is gated; every other
 * `eval` (distributed-state join/leave scripts) passes straight through.
 *
 * Gate indices count CAS calls, and a mutation only issues one of those when
 * the session already has a Redis hash — otherwise the script bails out with
 * NEEDS_FLOOR first and the same mutation burns two indices. Gated tests must
 * therefore use `createDurableSession`, which seeds the hash the way a live
 * party session always has one.
 */
/** How many not-yet-created release slots `releaseFrom` pre-resolves. */
const GATE_LOOKAHEAD = 12;

function gateCasEval(mockRedis: MockRedis) {
  const original = mockRedis.eval.bind(mockRedis) as (...args: unknown[]) => Promise<unknown>;
  const arrivals: Deferred[] = [];
  const releases: Deferred[] = [];
  const slot = (list: Deferred[], index: number): Deferred => (list[index] ??= defer());
  let seen = 0;

  mockRedis.eval = vi.fn(async (...args: unknown[]) => {
    if (args[0] !== UPDATE_QUEUE_STATE_CAS_SCRIPT) {
      return original(...args);
    }
    const index = seen++;
    slot(arrivals, index).resolve();
    await slot(releases, index).promise;
    return original(...args);
  }) as unknown as MockRedis['eval'];

  return {
    /** Resolves once the Nth (0-based) CAS call has reached the gate. */
    whenArrived: (index: number) => slot(arrivals, index).promise,
    /** Let exactly the Nth CAS call proceed, leaving every other one parked. */
    release: (index: number) => slot(releases, index).resolve(),
    /**
     * Let the Nth CAS call, and every later one, proceed.
     *
     * `releases` is sparse — a slot only exists once someone has asked for it —
     * so "every later one" has to be a finite pre-resolve of slots that don't
     * exist yet. `GATE_LOOKAHEAD` bounds that. It only has to cover the CAS
     * calls a single test can still issue after this point: at most one per
     * parked mutation plus its retries (`MAX_RETRIES` is 3), so 12 is a wide
     * margin over the 2-3 these tests actually reach. A test that exceeded it
     * would hang rather than pass wrongly.
     */
    releaseFrom: (index: number) => {
      for (let cursor = index; cursor < index + GATE_LOOKAHEAD; cursor++) {
        slot(releases, cursor).resolve();
      }
    },
  };
}

const registerAndJoinSession = async (clientId: string, sessionId: string, boardPath: string, username: string) => {
  await roomManager.registerClient(clientId);
  return roomManager.joinSession(clientId, sessionId, boardPath, username);
};

/**
 * Join a session AND give it a durable `board_sessions` row. Plain
 * `joinSession` only materialises the session in Redis/local state, but
 * `board_session_queues` has an FK to `board_sessions` and
 * `writeQueueStateToPostgres` skips sessions it can't find — so any test that
 * touches the durable row needs this.
 */
const createDurableSession = async (clientId: string, sessionId: string, boardPath: string) => {
  await roomManager.createDiscoverableSession(sessionId, boardPath, 'user-123', 37.7749, -122.4194, 'Test Session');
  await registerAndJoinSession(clientId, sessionId, boardPath, 'User1');
};

const mockCtx = (connectionId: string, sessionId: string) => ({
  connectionId,
  sessionId,
  rateLimitTokens: 60,
  rateLimitLastReset: Date.now(),
});

/** Most recent event of a given `__typename` handed to `publishQueueEvent`. */
const lastPublishedEvent = (
  publishSpy: { mock: { calls: unknown[][] } },
  typename: string,
): { __typename: string; sequence: number } | undefined => {
  const matching = publishSpy.mock.calls
    .map((call) => call[1] as { __typename: string; sequence: number })
    .filter((event) => event.__typename === typename);
  return matching[matching.length - 1];
};

const CONTROLLER_TEST_USER_ID = 'test-user-queue-atomicity';

/**
 * Register an ESP32 controller and authorize it for `sessionId`, returning a
 * connection context that passes `requireControllerAuthorizedForSession`.
 * `navigateQueue` verifies the controller row really exists, so this has to be
 * a genuine DB row rather than a hand-built context.
 */
const registerControllerFor = async (sessionId: string) => {
  await db.execute(sql`
    INSERT INTO users (id, email, name, created_at, updated_at)
    VALUES (${CONTROLLER_TEST_USER_ID}, 'test@queue-atomicity.test', 'Test User', now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

  const ownerCtx = {
    connectionId: `owner-${Date.now()}`,
    isAuthenticated: true,
    userId: CONTROLLER_TEST_USER_ID,
  } as unknown as Parameters<typeof controllerMutations.registerController>[2];

  const registered = await controllerMutations.registerController(
    undefined,
    { input: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2,3', name: 'Atomicity Controller' } },
    ownerCtx,
  );

  await controllerMutations.authorizeControllerForSession(
    undefined,
    { controllerId: registered.controllerId, sessionId },
    ownerCtx,
  );

  return {
    connectionId: `controller-${Date.now()}`,
    isAuthenticated: false,
    controllerId: registered.controllerId,
    controllerApiKey: registered.apiKey,
    rateLimitTokens: 60,
    rateLimitLastReset: Date.now(),
  } as unknown as Parameters<typeof controllerMutations.navigateQueue>[2];
};

describe('queue state atomicity (#3906)', () => {
  let mockRedis: MockRedis;

  beforeEach(async () => {
    mockRedis = createMockRedis();
    roomManager.reset();
    await roomManager.initialize(mockRedis);
  });

  afterEach(async () => {
    // Restores the `pubsub.publishQueueEvent` spies the interleaving tests
    // install, so a later test can't inherit a silenced publisher.
    vi.restoreAllMocks();
    vi.clearAllTimers();
    await db.execute(sql`DELETE FROM esp32_controllers WHERE user_id = ${CONTROLLER_TEST_USER_ID}`);
  });

  describe('expectedVersion is actually enforced', () => {
    // The single most valuable assertion in this file: it fails on the code
    // this issue was filed against, where `expectedVersion` was read into
    // `currentVersion` and used to compute `newVersion` without ever being
    // compared to the stored value.
    it('rejects updateQueueState when the stored version has moved on', async () => {
      const sessionId = uuidv4();
      await registerAndJoinSession('client-1', sessionId, '/kilter/1/2/3/40', 'User1');

      const initial = await roomManager.getQueueState(sessionId);
      await roomManager.updateQueueState(sessionId, [createTestClimb('first')], null, initial.version);

      // `initial.version` is now stale by one.
      await expect(
        roomManager.updateQueueState(sessionId, [createTestClimb('second')], null, initial.version),
      ).rejects.toThrow(VersionConflictError);
    });

    it('rejects updateQueueOnly when the stored version has moved on', async () => {
      const sessionId = uuidv4();
      await registerAndJoinSession('client-1', sessionId, '/kilter/1/2/3/40', 'User1');

      const initial = await roomManager.getQueueState(sessionId);
      await roomManager.updateQueueOnly(sessionId, [createTestClimb('first')], initial.version);

      await expect(
        roomManager.updateQueueOnly(sessionId, [createTestClimb('second')], initial.version),
      ).rejects.toThrow(VersionConflictError);
    });

    it('accepts a write whose expectedVersion is current', async () => {
      const sessionId = uuidv4();
      await registerAndJoinSession('client-1', sessionId, '/kilter/1/2/3/40', 'User1');

      const initial = await roomManager.getQueueState(sessionId);
      const first = await roomManager.updateQueueState(sessionId, [createTestClimb()], null, initial.version);
      const second = await roomManager.updateQueueState(sessionId, [createTestClimb()], null, first.version);

      expect(second.version).toBe(first.version + 1);
      expect(second.sequence).toBe(first.sequence + 1);
    });
  });

  describe('deterministic interleavings', () => {
    // Interleaving A: A reads, B completes entirely, A then writes with a
    // baseline that predates B. This is the variant that leaves a permanent
    // `sequence > version` gap on the Postgres row — the fingerprint that
    // proved 23 production sessions had hit this.
    it('A.read -> B.read/write -> A.write: A retries instead of clobbering B', async () => {
      const sessionId = uuidv4();
      await createDurableSession('client-1', sessionId, '/kilter/1/2/3/40');

      const climbA = createTestClimb('climb-A');
      const climbB = createTestClimb('climb-B');
      const gate = gateCasEval(mockRedis);

      // A gets as far as its CAS and parks there.
      const mutationA = queueMutations.addQueueItem({}, { item: climbA }, mockCtx('client-1', sessionId));
      await gate.whenArrived(0);

      // B runs start to finish while A is parked.
      gate.releaseFrom(1);
      await queueMutations.addQueueItem({}, { item: climbB }, mockCtx('client-1', sessionId));

      // Now let A's stale write land. It must be rejected and retried.
      gate.releaseFrom(0);
      await mutationA;

      const finalState = await roomManager.getQueueState(sessionId);
      const uuids = finalState.queue.map((item) => item.uuid);
      expect(uuids).toContain(climbA.uuid);
      expect(uuids).toContain(climbB.uuid);
      expect(finalState.queue).toHaveLength(2);
      // Both counters advance in lockstep — a divergence here is exactly the
      // production fingerprint this issue was diagnosed from.
      expect(finalState.sequence).toBe(finalState.version);
    });

    // Interleaving B: both read before either writes. This is the variant the
    // issue described — it produced two events carrying the SAME sequence
    // number, which the client silently drops as a stale duplicate, and it
    // leaves no trace in Postgres at all.
    it('A.read -> B.read -> B.write -> A.write: no duplicate sequence, no lost climb', async () => {
      const sessionId = uuidv4();
      await createDurableSession('client-1', sessionId, '/kilter/1/2/3/40');

      const climbA = createTestClimb('climb-A');
      const climbB = createTestClimb('climb-B');
      const gate = gateCasEval(mockRedis);

      // Both mutations reach their CAS before either is allowed through — this
      // is the ordering that used to hand two writers the SAME sequence number.
      const mutationA = queueMutations.addQueueItem({}, { item: climbA }, mockCtx('client-1', sessionId));
      await gate.whenArrived(0);
      const mutationB = queueMutations.addQueueItem({}, { item: climbB }, mockCtx('client-1', sessionId));
      await gate.whenArrived(1);

      // Release B's write alone and let it finish, so the ordering is actually
      // pinned rather than left to microtask scheduling.
      gate.release(1);
      await mutationB;

      // Only now does A's write — computed from a pre-B snapshot — get to run.
      // It must lose the CAS and retry rather than overwrite B.
      gate.releaseFrom(0);
      await mutationA;

      const finalState = await roomManager.getQueueState(sessionId);
      const uuids = finalState.queue.map((item) => item.uuid);
      expect(uuids).toContain(climbA.uuid);
      expect(uuids).toContain(climbB.uuid);
      expect(finalState.queue).toHaveLength(2);
      expect(finalState.sequence).toBe(finalState.version);
    });

    it('concurrent removes do not resurrect each other', async () => {
      const sessionId = uuidv4();
      await createDurableSession('client-1', sessionId, '/kilter/1/2/3/40');

      const climbA = createTestClimb('climb-A');
      const climbB = createTestClimb('climb-B');
      const climbC = createTestClimb('climb-C');
      const seeded = await roomManager.getQueueState(sessionId);
      await roomManager.updateQueueState(sessionId, [climbA, climbB, climbC], null, seeded.version);

      const gate = gateCasEval(mockRedis);

      const removeA = queueMutations.removeQueueItem({}, { uuid: climbA.uuid }, mockCtx('client-1', sessionId));
      await gate.whenArrived(0);
      const removeB = queueMutations.removeQueueItem({}, { uuid: climbB.uuid }, mockCtx('client-1', sessionId));
      await gate.whenArrived(1);

      // Same pinned ordering as above: B commits, then A's stale removal runs.
      gate.release(1);
      await removeB;
      gate.releaseFrom(0);
      await removeA;

      const finalState = await roomManager.getQueueState(sessionId);
      expect(finalState.queue.map((item) => item.uuid)).toEqual([climbC.uuid]);
    });

    // The three mutations below are wrapped in `withQueueVersionRetry` too, but
    // each plumbs the retried result back to its published event differently —
    // `reorderQueueItem` through mutable `result*` locals, `mirrorCurrentClimb`
    // through a spread return, `navigateQueue` through an `{ item, update }`
    // pair. A retry that recomputes the queue correctly but publishes the FIRST
    // attempt's sequence is still broken, and only a pinned interleaving with a
    // concurrent writer catches that.
    it('reorderQueueItem: retried reorder applies to the post-add queue and publishes the retry sequence', async () => {
      const sessionId = uuidv4();
      await createDurableSession('client-1', sessionId, '/kilter/1/2/3/40');

      const climbA = createTestClimb('climb-A');
      const climbB = createTestClimb('climb-B');
      const climbC = createTestClimb('climb-C');
      const seeded = await roomManager.getQueueState(sessionId);
      await roomManager.updateQueueState(sessionId, [climbA, climbB], null, seeded.version);

      const publishSpy = vi.spyOn(pubsub, 'publishQueueEvent').mockImplementation(() => {});
      const gate = gateCasEval(mockRedis);

      // Reorder parks at its CAS holding a two-item snapshot.
      const reorder = queueMutations.reorderQueueItem(
        {},
        { uuid: climbA.uuid, oldIndex: 0, newIndex: 1 },
        mockCtx('client-1', sessionId),
      );
      await gate.whenArrived(0);

      // An add lands underneath it, making the queue three items long.
      const add = queueMutations.addQueueItem({}, { item: climbC }, mockCtx('client-1', sessionId));
      await gate.whenArrived(1);
      gate.release(1);
      await add;

      // The parked reorder now loses its CAS and recomputes against 3 items.
      gate.releaseFrom(0);
      await reorder;

      const finalState = await roomManager.getQueueState(sessionId);
      // The add is not lost, and the reorder still moved A behind B.
      expect(finalState.queue.map((item) => item.uuid)).toEqual([climbB.uuid, climbA.uuid, climbC.uuid]);

      const reorderEvent = lastPublishedEvent(publishSpy, 'QueueReordered');
      // Fails if the retry published the pre-retry locals.
      expect(reorderEvent?.sequence).toBe(finalState.sequence);
    });

    it('mirrorCurrentClimb: retried mirror survives a concurrent add and publishes the retry sequence', async () => {
      const sessionId = uuidv4();
      await createDurableSession('client-1', sessionId, '/kilter/1/2/3/40');

      const climbA = createTestClimb('climb-A');
      const climbB = createTestClimb('climb-B');
      const seeded = await roomManager.getQueueState(sessionId);
      await roomManager.updateQueueState(sessionId, [climbA], climbA, seeded.version);

      const publishSpy = vi.spyOn(pubsub, 'publishQueueEvent').mockImplementation(() => {});
      const gate = gateCasEval(mockRedis);

      const mirror = queueMutations.mirrorCurrentClimb({}, { mirrored: true }, mockCtx('client-1', sessionId));
      await gate.whenArrived(0);

      const add = queueMutations.addQueueItem({}, { item: climbB }, mockCtx('client-1', sessionId));
      await gate.whenArrived(1);
      gate.release(1);
      await add;

      gate.releaseFrom(0);
      const mirrored = await mirror;

      const finalState = await roomManager.getQueueState(sessionId);
      // Mirror stuck, and the concurrently-added climb was not clobbered.
      expect(finalState.currentClimbQueueItem?.climb.mirrored).toBe(true);
      expect(finalState.queue.map((item) => item.uuid)).toContain(climbB.uuid);
      expect(finalState.queue).toHaveLength(2);
      expect(mirrored?.climb.mirrored).toBe(true);

      const mirrorEvent = lastPublishedEvent(publishSpy, 'ClimbMirrored');
      expect(mirrorEvent?.sequence).toBe(finalState.sequence);
    });

    it('navigateQueue: retried navigation targets the post-add queue', async () => {
      const sessionId = uuidv4();
      await createDurableSession('client-1', sessionId, '/kilter/1/2/3/40');
      const controllerCtx = await registerControllerFor(sessionId);

      const climbA = createTestClimb('climb-A');
      const climbB = createTestClimb('climb-B');
      const climbC = createTestClimb('climb-C');
      const seeded = await roomManager.getQueueState(sessionId);
      await roomManager.updateQueueState(sessionId, [climbA, climbB], climbA, seeded.version);

      vi.spyOn(pubsub, 'publishQueueEvent').mockImplementation(() => {});
      const gate = gateCasEval(mockRedis);

      // Controller navigates "next" from A, parking at its CAS.
      const navigate = controllerMutations.navigateQueue({}, { sessionId, direction: 'next' }, controllerCtx);
      await gate.whenArrived(0);

      const add = queueMutations.addQueueItem({}, { item: climbC }, mockCtx('client-1', sessionId));
      await gate.whenArrived(1);
      gate.release(1);
      await add;

      gate.releaseFrom(0);
      const landedOn = await navigate;

      const finalState = await roomManager.getQueueState(sessionId);
      // Navigation still lands on B, and the add survives.
      expect(landedOn?.uuid).toBe(climbB.uuid);
      expect(finalState.currentClimbQueueItem?.uuid).toBe(climbB.uuid);
      expect(finalState.queue.map((item) => item.uuid)).toEqual([climbA.uuid, climbB.uuid, climbC.uuid]);
    });
  });

  describe('sequence numbers stay unique and gapless under load', () => {
    it('assigns every concurrent mutation a distinct, contiguous sequence', async () => {
      const sessionId = uuidv4();
      await registerAndJoinSession('client-1', sessionId, '/kilter/1/2/3/40', 'User1');

      const start = await roomManager.getQueueState(sessionId);
      const climbs = Array.from({ length: 12 }, (_, index) => createTestClimb(`climb-${index}`));

      await Promise.all(
        climbs.map((climb) => queueMutations.addQueueItem({}, { item: climb }, mockCtx('client-1', sessionId))),
      );

      const finalState = await roomManager.getQueueState(sessionId);
      expect(finalState.queue).toHaveLength(climbs.length);
      // Every mutation consumed exactly one sequence number, so the counter
      // advanced by exactly the number of writes. Clients gap-check on
      // `seq === last + 1`, so a skipped or reused number is a protocol break.
      expect(finalState.sequence).toBe(start.sequence + climbs.length);
      expect(finalState.version).toBe(start.version + climbs.length);
    });
  });

  describe('dormant sessions keep their durable counters', () => {
    it('does not rewind the sequence when Redis has no hash but Postgres does', async () => {
      const sessionId = uuidv4();
      await createDurableSession('client-1', sessionId, '/kilter/1/2/3/40');

      // Advance the durable counters. `updateQueueStateImmediate` writes
      // straight through to Postgres, unlike the 30s-debounced normal path —
      // which is what a long-running session would have flushed by the time
      // its Redis hash aged out.
      for (let write = 0; write < 4; write++) {
        await roomManager.updateQueueStateImmediate(sessionId, [createTestClimb()], null, undefined);
      }

      const beforeEviction = await roomManager.getQueueState(sessionId);
      expect(beforeEviction.sequence).toBeGreaterThan(1);

      // Simulate the 4h Redis TTL expiring while the durable row survives.
      await mockRedis.del(`boardsesh:session:${sessionId}`);

      const revived = await roomManager.updateQueueState(sessionId, [createTestClimb()], null, undefined);
      // Restarting at 1 here would rewind the sequence clients gap-check on.
      expect(revived.sequence).toBe(beforeEviction.sequence + 1);
      expect(revived.version).toBe(beforeEviction.version + 1);
    });

    // Three-party race: reviving a dormant session takes TWO CAS calls
    // (NEEDS_FLOOR, then the floored write), and a third process can seed the
    // Redis hash in the gap between them. The floored attempt must then lose
    // its CAS rather than write over the newcomer, and the retry must pick up
    // the seeded state.
    it('a write landing between NEEDS_FLOOR and the floored retry still wins', async () => {
      const sessionId = uuidv4();
      await createDurableSession('client-1', sessionId, '/kilter/1/2/3/40');

      const existing = createTestClimb('already-there');
      await roomManager.updateQueueStateImmediate(sessionId, [existing], null, undefined);
      const durable = await roomManager.getQueueState(sessionId);

      // The 4h TTL expires; Postgres keeps the counters.
      await mockRedis.del(`boardsesh:session:${sessionId}`);

      const gate = gateCasEval(mockRedis);
      const newClimb = createTestClimb('revives-the-session');
      const reviving = queueMutations.addQueueItem({}, { item: newClimb }, mockCtx('client-1', sessionId));

      // CAS #0 is the probe that returns NEEDS_FLOOR.
      await gate.whenArrived(0);
      gate.release(0);

      // CAS #1 is the floored write. Park it, and let a third party seed the
      // hash underneath — writing the fields directly rather than through a
      // mutation so it doesn't consume a gate index.
      await gate.whenArrived(1);
      const intruderClimb = createTestClimb('intruder');
      await mockRedis.hset(
        `boardsesh:session:${sessionId}`,
        'sessionId',
        sessionId,
        'queue',
        JSON.stringify([existing, intruderClimb]),
        'currentClimbQueueItem',
        'null',
        'version',
        String(durable.version + 7),
        'sequence',
        String(durable.sequence + 7),
        'stateHash',
        'seeded',
        'stateHashOrdered',
        'seeded-ordered',
        'lastActivity',
        String(Date.now()),
      );

      gate.releaseFrom(1);
      await reviving;

      const finalState = await roomManager.getQueueState(sessionId);
      const uuids = finalState.queue.map((item) => item.uuid);
      // Neither write is lost: the intruder's climb survives and the reviving
      // mutation's climb was re-applied on top of it.
      expect(uuids).toContain(intruderClimb.uuid);
      expect(uuids).toContain(newClimb.uuid);
      expect(uuids).toContain(existing.uuid);
      // The retry built on the seeded version rather than the stale floor.
      expect(finalState.version).toBe(durable.version + 8);
    });
  });
});

// ---------------------------------------------------------------------------
// Layer 3: the real Lua script against a real Redis. Skips cleanly when Redis
// isn't reachable, same pattern as session-reconnect-atomicity.test.ts.
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';

async function isRedisAvailable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, { connectTimeout: 1000, maxRetriesPerRequest: 0, lazyConnect: true });
  try {
    await probe.connect();
    await probe.ping();
    await probe.quit();
    return true;
  } catch {
    try {
      await probe.quit();
    } catch {
      // ignore
    }
    return false;
  }
}

const redisAvailable = await isRedisAvailable();

describe.skipIf(!redisAvailable)('queue CAS Lua script against real Redis (#3906)', () => {
  let redis: Redis;
  let store: RedisSessionStore;

  beforeEach(async () => {
    redis = new Redis(REDIS_URL);
    await new Promise<void>((resolve) => redis.once('ready', resolve));
    const keys = await redis.keys('boardsesh:session:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    store = new RedisSessionStore(redis);
  });

  afterEach(async () => {
    await redis.quit();
  });

  const cas = (sessionId: string, expectedVersion: number | typeof CAS_ANY_VERSION, queue: ClimbQueueItem[]) =>
    store.casUpdateQueueState({
      sessionId,
      queue,
      currentClimbQueueItem: null,
      expectedVersion,
      stateHash: 'hash',
      stateHashOrdered: 'ordered',
      versionFloor: 0,
      sequenceFloor: 0,
      floorsKnown: true,
    });

  it('asks for the durable floor before writing into an empty hash', async () => {
    const sessionId = uuidv4();
    const result = await store.casUpdateQueueState({
      sessionId,
      queue: [],
      currentClimbQueueItem: null,
      expectedVersion: CAS_ANY_VERSION,
      stateHash: 'hash',
      stateHashOrdered: 'ordered',
      versionFloor: 0,
      sequenceFloor: 0,
      floorsKnown: false,
    });
    expect(result.status).toBe('NEEDS_FLOOR');
    // Nothing must have been written on the bail-out path.
    expect(await redis.exists(`boardsesh:session:${sessionId}`)).toBe(0);
  });

  it('starts a dormant session past its durable floor rather than at 1', async () => {
    const sessionId = uuidv4();
    const result = await store.casUpdateQueueState({
      sessionId,
      queue: [],
      currentClimbQueueItem: null,
      expectedVersion: CAS_ANY_VERSION,
      stateHash: 'hash',
      stateHashOrdered: 'ordered',
      versionFloor: 311,
      sequenceFloor: 319,
      floorsKnown: true,
    });
    expect(result).toMatchObject({ status: 'OK', version: 312, sequence: 320 });
  });

  it('rejects a stale expectedVersion', async () => {
    const sessionId = uuidv4();
    await cas(sessionId, CAS_ANY_VERSION, []);
    await cas(sessionId, 1, []);

    const stale = await cas(sessionId, 1, []);
    expect(stale.status).toBe('CONFLICT');
  });

  it('serialises 50 racing writers into unique, contiguous sequences', async () => {
    const sessionId = uuidv4();
    const writers = 50;

    const results = await Promise.all(
      Array.from({ length: writers }, () => cas(sessionId, CAS_ANY_VERSION, [createTestClimb()])),
    );

    const sequences = results.map((result) => (result.status === 'OK' ? result.sequence : -1));
    expect(new Set(sequences).size).toBe(writers);
    expect([...sequences].sort((a, b) => a - b)).toEqual(Array.from({ length: writers }, (_, index) => index + 1));
  });

  it('lets exactly one guarded writer win a contended version', async () => {
    const sessionId = uuidv4();
    await cas(sessionId, CAS_ANY_VERSION, []);

    // Every writer believes the version is 1. Exactly one can be right.
    const results = await Promise.all(Array.from({ length: 20 }, () => cas(sessionId, 1, [createTestClimb()])));

    expect(results.filter((result) => result.status === 'OK')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'CONFLICT')).toHaveLength(19);
  });

  it('returns the prior hash pair so setQueue can still spot a no-op resync', async () => {
    const sessionId = uuidv4();
    await store.casUpdateQueueState({
      sessionId,
      queue: [],
      currentClimbQueueItem: null,
      expectedVersion: CAS_ANY_VERSION,
      stateHash: 'hash-one',
      stateHashOrdered: 'ordered-one',
      versionFloor: 0,
      sequenceFloor: 0,
      floorsKnown: true,
    });

    const second = await store.casUpdateQueueState({
      sessionId,
      queue: [],
      currentClimbQueueItem: null,
      expectedVersion: CAS_ANY_VERSION,
      stateHash: 'hash-two',
      stateHashOrdered: 'ordered-two',
      versionFloor: 0,
      sequenceFloor: 0,
      floorsKnown: true,
    });

    expect(second).toMatchObject({
      status: 'OK',
      previousStateHash: 'hash-one',
      previousStateHashOrdered: 'ordered-one',
    });
  });
});

// ---------------------------------------------------------------------------
// Postgres snapshot monotonicity. Each backend instance debounces its own
// pending-write map, so two instances flushing the same session race — the
// durable row must keep the newer snapshot regardless of arrival order.
// ---------------------------------------------------------------------------

describe('debounced Postgres writes never rewind the durable snapshot (#3906)', () => {
  let mockRedis: MockRedis;

  beforeEach(async () => {
    mockRedis = createMockRedis();
    roomManager.reset();
    await roomManager.initialize(mockRedis);
  });

  it('keeps the newer snapshot when an older flush lands last', async () => {
    const sessionId = uuidv4();
    await createDurableSession('client-1', sessionId, '/kilter/1/2/3/40');

    const scheduler = new WriteScheduler();
    const newer = [createTestClimb('newer-a'), createTestClimb('newer-b')];
    const older = [createTestClimb('older')];

    await writeQueueStateToPostgres(
      sessionId,
      { queue: newer, currentClimbQueueItem: null, version: 9, sequence: 9 },
      scheduler,
    );

    // A straggler flush from another instance, carrying an older sequence.
    await writeQueueStateToPostgres(
      sessionId,
      { queue: older, currentClimbQueueItem: null, version: 4, sequence: 4 },
      scheduler,
    );

    const rows = await db.select().from(sessionQueues).where(eq(sessionQueues.sessionId, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0].sequence).toBe(9);
    expect(rows[0].queue).toHaveLength(2);
  });
});
