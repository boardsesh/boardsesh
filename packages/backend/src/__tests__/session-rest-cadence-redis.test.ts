/**
 * The crew rest clock's Redis storage (#5382) against a real Redis (6380 in the
 * backend test compose). Two connections, each behind its own
 * DistributedStateManager, stand in for two backend instances racing on one
 * session. The connections select their own logical database, because other
 * Redis suites wipe every `boardsesh:*` key in database 0 between their tests;
 * each test here also uses its own session id and deletes only its own keys.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { DistributedStateManager } from '../services/distributed-state';
import { KEYS, TTL } from '../services/distributed-state/constants';
import { RedisSessionStore } from '../services/redis-session-store';
import { RoomManager } from '../services/room-manager';
import {
  REST_CADENCE_FIRE_EARLY_TOLERANCE_MS,
  REST_CADENCE_FIRE_LATE_TOLERANCE_MS,
  commitRestCadenceAction,
  restCadenceRevisionFloor,
  serializeRestCadence,
  type RestCadenceInput,
  type RestCadenceState,
  type RestCadenceStore,
} from '../services/rest-cadence';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';
const REST_CADENCE_TEST_DB = 9;

async function isRedisAvailable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, { connectTimeout: 1000, maxRetriesPerRequest: 0, lazyConnect: true });
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const redisAvailable = await isRedisAvailable();

const NOW = 1_800_000_000_000;
// The revision a write at NOW takes on a session whose revision is below it.
const FLOOR = restCadenceRevisionFloor(NOW);
// The storage tests below drive the CAS directly with no floor, so revisions count 1, 2, 3.
const NO_FLOOR = 0;
const CLOCK: RestCadenceState = {
  mode: 'afterTick',
  targetSeconds: 60,
  autoAdvance: true,
  advanceOn: 'deadline',
  source: 'settings',
  isRunning: true,
  anchorMs: NOW - 61_000,
  pausedElapsedSeconds: 0,
  lastFiredBeatMs: null,
  lastTick: null,
  setByParticipantId: 'participant-a',
};

/** The store RoomManager builds over distributed state, for one session. */
function storeFor(manager: DistributedStateManager, sessionId: string): RestCadenceStore {
  return {
    read: () => manager.getSessionRestCadence(sessionId),
    compareAndSet: (expectedRevision, nextDoc, minimumRevision) =>
      manager.casSessionRestCadence(sessionId, expectedRevision, nextDoc, minimumRevision),
  };
}

describe.skipIf(!redisAvailable)('crew rest clock storage on Redis', () => {
  let instanceOneRedis: Redis;
  let instanceTwoRedis: Redis;
  let instanceOne: DistributedStateManager;
  let instanceTwo: DistributedStateManager;
  const sessionIds: string[] = [];

  const newSessionId = () => {
    const sessionId = `rest-cadence-${randomUUID().slice(0, 8)}`;
    sessionIds.push(sessionId);
    return sessionId;
  };

  beforeAll(() => {
    instanceOneRedis = new Redis(REDIS_URL, { db: REST_CADENCE_TEST_DB });
    instanceTwoRedis = new Redis(REDIS_URL, { db: REST_CADENCE_TEST_DB });
    instanceOne = new DistributedStateManager(instanceOneRedis, 'rest-cadence-instance-1');
    instanceTwo = new DistributedStateManager(instanceTwoRedis, 'rest-cadence-instance-2');
  });

  afterEach(async () => {
    if (sessionIds.length > 0) {
      await instanceOneRedis.del(...sessionIds.map((id) => KEYS.sessionRestCadence(id)));
      // refreshTTL also stamps the session in the recent-sessions index.
      await instanceOneRedis.zrem('boardsesh:session:recent', ...sessionIds);
    }
    sessionIds.length = 0;
  });

  afterAll(async () => {
    await Promise.all([instanceOneRedis.quit(), instanceTwoRedis.quit()]);
  });

  it('reads a session that never had a clock as revision 0, off', async () => {
    expect(await instanceOne.getSessionRestCadence(newSessionId())).toEqual({ revision: 0, cadence: null });
  });

  it('writes the next revision with the session TTL, and another instance reads it back', async () => {
    const sessionId = newSessionId();
    const result = await instanceOne.casSessionRestCadence(sessionId, 0, serializeRestCadence(CLOCK), NO_FLOOR);
    expect(result).toEqual({ ok: true, revision: 1, doc: serializeRestCadence(CLOCK) });
    expect(await instanceTwo.getSessionRestCadence(sessionId)).toEqual({ revision: 1, cadence: CLOCK });
    const ttl = await instanceOneRedis.ttl(KEYS.sessionRestCadence(sessionId));
    expect(ttl).toBeGreaterThan(TTL.sessionMembership - 10);
    expect(ttl).toBeLessThanOrEqual(TTL.sessionMembership);
  });

  it('refuses a stale revision and hands back what is stored', async () => {
    const sessionId = newSessionId();
    await instanceOne.casSessionRestCadence(sessionId, 0, serializeRestCadence(CLOCK), NO_FLOOR);
    await instanceOne.casSessionRestCadence(sessionId, 1, '', NO_FLOOR);
    const stale = await instanceTwo.casSessionRestCadence(sessionId, 1, serializeRestCadence(CLOCK), NO_FLOOR);
    expect(stale).toEqual({ ok: false, revision: 2, doc: '' });
    expect(await instanceOne.getSessionRestCadence(sessionId)).toEqual({ revision: 2, cadence: null });
  });

  it('refreshes the TTL on a write that loses too, so a session whose writes keep losing keeps its clock', async () => {
    const sessionId = newSessionId();
    const key = KEYS.sessionRestCadence(sessionId);
    await instanceOne.casSessionRestCadence(sessionId, 0, serializeRestCadence(CLOCK), NO_FLOOR);
    await instanceOneRedis.expire(key, 30);

    const lost = await instanceTwo.casSessionRestCadence(sessionId, 7, '', NO_FLOOR);

    expect(lost).toEqual({ ok: false, revision: 1, doc: serializeRestCadence(CLOCK) });
    const ttl = await instanceOneRedis.ttl(key);
    expect(ttl).toBeGreaterThan(TTL.sessionMembership - 10);
    expect(ttl).toBeLessThanOrEqual(TTL.sessionMembership);
  });

  it('a losing write on a hash that is gone leaves it gone', async () => {
    const sessionId = newSessionId();
    expect(await instanceOne.casSessionRestCadence(sessionId, 3, '', NO_FLOOR)).toEqual({
      ok: false,
      revision: 0,
      doc: '',
    });
    expect(await instanceOneRedis.exists(KEYS.sessionRestCadence(sessionId))).toBe(0);
  });

  it('lets exactly one of many racing FIREs from two instances claim the beat', async () => {
    const sessionId = newSessionId();
    await instanceOne.casSessionRestCadence(sessionId, 0, serializeRestCadence(CLOCK), NO_FLOOR);
    const fire: RestCadenceInput = { action: 'FIRE', expectedRevision: 1, firedBeatAgoMs: 0 };

    const commits = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        commitRestCadenceAction(
          storeFor(index % 2 === 0 ? instanceOne : instanceTwo, sessionId),
          fire,
          NOW + index,
          `phone-${index}`,
        ),
      ),
    );

    const winners = commits.filter((commit) => commit.applied);
    expect(winners).toHaveLength(1);
    expect(winners[0].stored.revision).toBe(FLOOR);
    expect((await instanceOne.getSessionRestCadence(sessionId)).revision).toBe(FLOOR);
    for (const loser of commits.filter((commit) => !commit.applied)) {
      expect(loser.stored.revision).toBe(FLOOR);
      expect(loser.rewound).toBe(false);
    }
  });

  it('refuses a second FIRE on the same beat from another instance, on the revision the first returned (#6724 review)', async () => {
    const sessionId = newSessionId();
    // A 60 s beat armed a minute ago: the first beat falls due at NOW.
    const beat: RestCadenceState = { ...CLOCK, mode: 'onTheMinute', anchorMs: NOW - 60_000 };
    await instanceOne.casSessionRestCadence(sessionId, 0, serializeRestCadence(beat), NO_FLOOR);

    const first = await commitRestCadenceAction(
      storeFor(instanceOne, sessionId),
      { action: 'FIRE', expectedRevision: 1, firedBeatAgoMs: 0 },
      NOW,
      'holder',
    );
    const second = await commitRestCadenceAction(
      storeFor(instanceTwo, sessionId),
      { action: 'FIRE', expectedRevision: first.stored.revision, firedBeatAgoMs: 90 },
      NOW + 100,
      'other-phone',
    );

    expect(first.applied).toBe(true);
    expect(second).toEqual({ applied: false, rewound: false, stored: first.stored });
    expect(await instanceOne.getSessionRestCadence(sessionId)).toEqual(first.stored);
  });

  it('lets one FIRE per beat apply across two instances, even when every phone re-reads the latest revision', async () => {
    const sessionId = newSessionId();
    const beat: RestCadenceState = { ...CLOCK, mode: 'onTheMinute', anchorMs: NOW - 60_000 };
    await instanceOne.casSessionRestCadence(sessionId, 0, serializeRestCadence(beat), NO_FLOOR);
    /** A phone that adopted every event: it FIREs on the revision stored right now. */
    const fireOnLatest = async (manager: DistributedStateManager, nowMs: number, firedBeatAgoMs: number) =>
      commitRestCadenceAction(
        storeFor(manager, sessionId),
        { action: 'FIRE', expectedRevision: (await manager.getSessionRestCadence(sessionId)).revision, firedBeatAgoMs },
        nowMs,
        'phone',
      );

    // Twelve FIREs inside the first beat, alternating instances, each with a different reported beat age.
    const onFirstBeat = [];
    for (let index = 0; index < 12; index++) {
      onFirstBeat.push(await fireOnLatest(index % 2 === 0 ? instanceOne : instanceTwo, NOW + index * 50, index * 7));
    }
    expect(onFirstBeat.filter((commit) => commit.applied)).toHaveLength(1);
    expect(onFirstBeat[0].applied).toBe(true);

    // The next beat applies once, from whichever instance gets there first.
    const nextBeat = NOW + 60_000;
    const [fromTwo, fromOne] = [
      await fireOnLatest(instanceTwo, nextBeat - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS, 0),
      await fireOnLatest(instanceOne, nextBeat + 40, 0),
    ];
    expect(fromTwo.applied).toBe(true);
    expect(fromOne.applied).toBe(false);
    expect(await instanceOne.getSessionRestCadence(sessionId)).toEqual(fromTwo.stored);
    expect(fromTwo.stored.cadence?.lastFiredBeatMs).toBe(nextBeat);
  });

  it('lets one FIRE per beat apply across two instances when every phone reads and commits at the same time', async () => {
    const sessionId = newSessionId();
    const beat: RestCadenceState = { ...CLOCK, mode: 'onTheMinute', anchorMs: NOW - 60_000 };
    await instanceOne.casSessionRestCadence(sessionId, 0, serializeRestCadence(beat), NO_FLOOR);
    /** A phone that adopted every event: it reads the stored revision, then FIREs on it. */
    const fireOnLatest = async (manager: DistributedStateManager, nowMs: number, firedBeatAgoMs: number) =>
      commitRestCadenceAction(
        storeFor(manager, sessionId),
        { action: 'FIRE', expectedRevision: (await manager.getSessionRestCadence(sessionId)).revision, firedBeatAgoMs },
        nowMs,
        'phone',
      );
    /** Twelve phones, alternating instances, each reading and committing at once: the reads and compare-and-sets interleave. */
    const burst = (nowMs: number) =>
      Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          fireOnLatest(index % 2 === 0 ? instanceOne : instanceTwo, nowMs + index * 50, index * 7),
        ),
      );

    const onFirstBeat = await burst(NOW);
    expect(onFirstBeat.filter((commit) => commit.applied)).toHaveLength(1);
    const afterFirst = await instanceTwo.getSessionRestCadence(sessionId);
    expect(afterFirst.cadence?.lastFiredBeatMs).toBe(NOW);
    for (const commit of onFirstBeat) expect(commit.stored).toEqual(afterFirst);

    const onNextBeat = await burst(NOW + 60_000 - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS);
    expect(onNextBeat.filter((commit) => commit.applied)).toHaveLength(1);
    const afterNext = await instanceOne.getSessionRestCadence(sessionId);
    expect(afterNext.cadence?.lastFiredBeatMs).toBe(NOW + 60_000);
    expect(afterNext.revision).toBeGreaterThan(afterFirst.revision);
    for (const commit of onNextBeat) expect(commit.stored).toEqual(afterNext);
  });

  it('fences FIREs the same way on Redis and on the in-memory fallback', async () => {
    const sessionId = newSessionId();
    const onRedis = new RoomManager();
    await onRedis.initialize(instanceOneRedis);
    const inMemory = new RoomManager();
    const onTheMinute = {
      mode: 'onTheMinute',
      targetSeconds: 60,
      autoAdvance: true,
      advanceOn: 'deadline',
      source: 'settings',
    } as const;
    const steps: Array<{ nowMs: number; input: RestCadenceInput }> = [
      { nowMs: NOW, input: { action: 'ARM', config: onTheMinute, elapsedMs: 60_000 } },
      { nowMs: NOW, input: { action: 'FIRE', firedBeatAgoMs: 0 } },
      { nowMs: NOW + 100, input: { action: 'FIRE', firedBeatAgoMs: 90 } },
      { nowMs: NOW + 60_000 - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS - 1, input: { action: 'FIRE' } },
      { nowMs: NOW + 60_000 - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS, input: { action: 'FIRE' } },
      {
        nowMs: NOW + 61_000,
        input: {
          action: 'CONFIGURE',
          config: { ...onTheMinute, mode: 'afterTick', targetSeconds: 90 },
          anchor: 'NOW',
          elapsedMs: 90_000,
        },
      },
      { nowMs: NOW + 61_000, input: { action: 'FIRE' } },
      { nowMs: NOW + 61_100, input: { action: 'FIRE' } },
      // #6724 review. The beat ran out more than the late tolerance ago: refused, until a RESET re-anchors.
      { nowMs: NOW + 151_000 + REST_CADENCE_FIRE_LATE_TOLERANCE_MS + 1, input: { action: 'FIRE' } },
      { nowMs: NOW + 160_000, input: { action: 'RESET' } },
      // An early FIRE restarts the rest from its deadline (NOW + 250 s), so the next one opens at NOW + 338 s.
      { nowMs: NOW + 250_000 - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS, input: { action: 'FIRE' } },
      { nowMs: NOW + 340_000 - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS - 1, input: { action: 'FIRE' } },
      { nowMs: NOW + 340_000 - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS, input: { action: 'FIRE' } },
      // A missed onTheMinute beat: the late claim is refused, the next beat applies.
      { nowMs: NOW + 400_000, input: { action: 'ARM', config: onTheMinute, elapsedMs: 0 } },
      { nowMs: NOW + 517_500, input: { action: 'FIRE' } },
      { nowMs: NOW + 518_500, input: { action: 'FIRE' } },
      // PAUSE just after a beat fired, RESUME later: the fired beat moves with the grid.
      { nowMs: NOW + 520_500, input: { action: 'PAUSE' } },
      { nowMs: NOW + 550_000, input: { action: 'RESUME' } },
      { nowMs: NOW + 550_000, input: { action: 'FIRE' } },
      { nowMs: NOW + 608_000, input: { action: 'FIRE' } },
      // RESET drops a stale tick: a send-gated FIRE needs a new one.
      {
        nowMs: NOW + 700_000,
        input: { action: 'ARM', config: { ...onTheMinute, mode: 'afterTick', advanceOn: 'send' } },
      },
      { nowMs: NOW + 700_000, input: { action: 'TICK', tickQueueItemUuid: 'item-1', tickStatus: 'send' } },
      { nowMs: NOW + 701_000, input: { action: 'RESET' } },
      { nowMs: NOW + 761_000, input: { action: 'FIRE' } },
      { nowMs: NOW + 762_000, input: { action: 'TICK', tickQueueItemUuid: 'item-2', tickStatus: 'flash' } },
      { nowMs: NOW + 822_000, input: { action: 'FIRE' } },
      // #6724 review. A 60 s rest due at NOW + 900 s; an early FIRE claims it, a RESET follows, then a
      // tick dated 59 s back: RESET keeps the fired beat, and the tick anchors no later than now.
      {
        nowMs: NOW + 900_000,
        input: { action: 'ARM', config: { ...onTheMinute, mode: 'afterTick' }, elapsedMs: 60_000 },
      },
      { nowMs: NOW + 900_000 - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS, input: { action: 'FIRE' } },
      { nowMs: NOW + 898_500, input: { action: 'RESET' } },
      { nowMs: NOW + 899_000, input: { action: 'TICK', tickStatus: 'send', elapsedMs: 59_000 } },
      { nowMs: NOW + 900_000, input: { action: 'FIRE' } },
      // An on-time FIRE, then a tick dated 55 s back 2 s later: it waits a full rest from the advance.
      { nowMs: NOW + 959_000, input: { action: 'FIRE' } },
      {
        nowMs: NOW + 961_000,
        input: { action: 'TICK', tickQueueItemUuid: 'item-3', tickStatus: 'send', elapsedMs: 55_000 },
      },
      { nowMs: NOW + 966_000, input: { action: 'FIRE' } },
      { nowMs: NOW + 1_019_000, input: { action: 'FIRE' } },
    ];
    /** Run every step, fencing each FIRE on the revision the manager holds at that moment. */
    const run = async (manager: RoomManager) => {
      const outcomes = [];
      for (const { nowMs, input } of steps) {
        const fenced =
          input.action === 'FIRE'
            ? { ...input, expectedRevision: (await manager.getSessionRestCadence(sessionId)).revision }
            : input;
        outcomes.push(await manager.updateSessionRestCadence(sessionId, fenced, 'phone', nowMs));
      }
      return outcomes;
    };
    try {
      const redisOutcomes = await run(onRedis);
      const memoryOutcomes = await run(inMemory);
      expect(redisOutcomes.map((commit) => commit.applied)).toEqual([
        true,
        true,
        false,
        false,
        true,
        true,
        true,
        false,
        // #6724 review: late, RESET, early, too early, on time.
        false,
        true,
        true,
        false,
        true,
        // ARM, missed beat late, next beat early.
        true,
        false,
        true,
        // PAUSE, RESUME, the fired beat again, the next beat.
        true,
        true,
        false,
        true,
        // ARM, TICK, RESET, FIRE on the stale tick, a new TICK, FIRE.
        true,
        true,
        true,
        false,
        true,
        true,
        // ARM, early FIRE, RESET, backdated TICK, FIRE on the beat already claimed.
        true,
        true,
        true,
        true,
        false,
        // On-time FIRE, backdated TICK, FIRE where that tick would have put the deadline, the full rest.
        true,
        true,
        false,
        true,
      ]);
      expect(redisOutcomes.slice(-9).map((commit) => commit.stored.cadence?.anchorMs ?? null)).toEqual([
        NOW + 840_000,
        NOW + 900_000,
        NOW + 898_500,
        NOW + 899_000,
        NOW + 899_000,
        NOW + 959_000,
        NOW + 959_000,
        NOW + 959_000,
        NOW + 1_019_000,
      ]);
      expect(redisOutcomes.slice(-9).map((commit) => commit.stored.cadence?.lastFiredBeatMs ?? null)).toEqual([
        null,
        NOW + 900_000,
        NOW + 900_000,
        NOW + 900_000,
        NOW + 900_000,
        NOW + 959_000,
        NOW + 959_000,
        NOW + 959_000,
        NOW + 1_019_000,
      ]);
      expect(redisOutcomes.map((commit) => commit.stored.cadence?.lastFiredBeatMs ?? null)).toContain(NOW + 250_000);
      expect(memoryOutcomes).toEqual(redisOutcomes);
    } finally {
      await onRedis.shutdown();
      onRedis.reset();
      inMemory.reset();
    }
  });

  it('gives racing un-fenced writes from two instances distinct, increasing revisions', async () => {
    const sessionId = newSessionId();
    await instanceOne.casSessionRestCadence(sessionId, 0, serializeRestCadence(CLOCK), NO_FLOOR);

    const [fromOne, fromTwo] = await Promise.all([
      commitRestCadenceAction(
        storeFor(instanceOne, sessionId),
        { action: 'TICK', tickQueueItemUuid: 'item-a', tickStatus: 'send' },
        NOW,
        'phone-a',
      ),
      commitRestCadenceAction(
        storeFor(instanceTwo, sessionId),
        { action: 'TICK', tickQueueItemUuid: 'item-b', tickStatus: 'attempt' },
        NOW + 1,
        'phone-b',
      ),
    ]);

    expect(fromOne.applied && fromTwo.applied).toBe(true);
    expect([fromOne.stored.revision, fromTwo.stored.revision].sort((left, right) => left - right)).toEqual([
      FLOOR,
      FLOOR + 1,
    ]);
    const stored = await instanceOne.getSessionRestCadence(sessionId);
    const last = fromOne.stored.revision === FLOOR + 1 ? fromOne : fromTwo;
    expect(stored).toEqual(last.stored);
  });

  it('routes RoomManager reads and writes through Redis once distributed state is on', async () => {
    const sessionId = newSessionId();
    const manager = new RoomManager();
    await manager.initialize(instanceOneRedis);
    try {
      const commit = await manager.updateSessionRestCadence(
        sessionId,
        {
          action: 'ARM',
          config: {
            mode: 'afterTick',
            targetSeconds: 120,
            autoAdvance: true,
            advanceOn: 'deadline',
            source: 'settings',
          },
          elapsedMs: 0,
        },
        'phone-a',
        NOW,
      );
      expect(commit.applied).toBe(true);
      expect(commit.stored.revision).toBe(FLOOR);
      // Another instance sees the write: it went to Redis, not the local fallback.
      expect(await instanceTwo.getSessionRestCadence(sessionId)).toEqual(commit.stored);
      expect(await manager.getSessionRestCadence(sessionId)).toEqual(commit.stored);
    } finally {
      await manager.shutdown();
      manager.reset();
    }
  });

  it('never writes below the floor it is given, so a lost hash cannot rewind the revision', async () => {
    const sessionId = newSessionId();
    const key = KEYS.sessionRestCadence(sessionId);
    expect(await instanceOne.casSessionRestCadence(sessionId, 0, serializeRestCadence(CLOCK), FLOOR)).toMatchObject({
      ok: true,
      revision: FLOOR,
    });
    // Above the floor, the revision counts up by one.
    expect(await instanceTwo.casSessionRestCadence(sessionId, FLOOR, '', FLOOR)).toMatchObject({
      ok: true,
      revision: FLOOR + 1,
    });

    // Redis restarts from an older snapshot: the hash is back at revision 3.
    await instanceOneRedis.hset(key, 'rev', '3');
    const afterRestart = await instanceOne.casSessionRestCadence(sessionId, 3, serializeRestCadence(CLOCK), FLOOR + 4);
    expect(afterRestart).toMatchObject({ ok: true, revision: FLOOR + 4 });

    // The hash expires or is evicted outright.
    await instanceOneRedis.del(key);
    const afterLoss = await instanceTwo.casSessionRestCadence(sessionId, 0, '', FLOOR + 6);
    expect(afterLoss).toMatchObject({ ok: true, revision: FLOOR + 6 });
    expect(await instanceOne.getSessionRestCadence(sessionId)).toEqual({ revision: FLOOR + 6, cadence: null });
  });

  it('flags a FIRE from a phone that holds more than a rewound hash, without writing', async () => {
    const sessionId = newSessionId();
    await instanceOne.casSessionRestCadence(sessionId, 0, serializeRestCadence(CLOCK), FLOOR);
    await instanceOneRedis.hset(KEYS.sessionRestCadence(sessionId), 'rev', '3');

    const commit = await commitRestCadenceAction(
      storeFor(instanceTwo, sessionId),
      { action: 'FIRE', expectedRevision: FLOOR, firedBeatAgoMs: 0 },
      NOW,
      'holder',
    );

    expect(commit).toEqual({ applied: false, rewound: true, stored: { revision: 3, cadence: CLOCK } });
    expect((await instanceOne.getSessionRestCadence(sessionId)).revision).toBe(3);
  });

  it('is cleared with the rest of the session in cleanupEmptySession and deleteSession', async () => {
    const emptied = newSessionId();
    const ended = newSessionId();
    await instanceOne.casSessionRestCadence(emptied, 0, serializeRestCadence(CLOCK), NO_FLOOR);
    await instanceOne.casSessionRestCadence(ended, 0, serializeRestCadence(CLOCK), NO_FLOOR);

    await instanceOne.cleanupEmptySession(emptied);
    await new RedisSessionStore(instanceOneRedis).deleteSession(ended);

    expect(await instanceOneRedis.exists(KEYS.sessionRestCadence(emptied))).toBe(0);
    expect(await instanceOneRedis.exists(KEYS.sessionRestCadence(ended))).toBe(0);
  });

  it('stays alive while the session is active, so its revision never restarts mid-session', async () => {
    const sessionId = newSessionId();
    await instanceOne.casSessionRestCadence(sessionId, 0, serializeRestCadence(CLOCK), NO_FLOOR);
    await instanceOneRedis.expire(KEYS.sessionRestCadence(sessionId), 30);

    await new RedisSessionStore(instanceOneRedis).refreshTTL(sessionId);

    expect(await instanceOneRedis.ttl(KEYS.sessionRestCadence(sessionId))).toBeGreaterThan(TTL.sessionMembership - 10);
  });
});
