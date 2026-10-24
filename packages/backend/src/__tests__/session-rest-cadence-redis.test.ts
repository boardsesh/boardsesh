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
