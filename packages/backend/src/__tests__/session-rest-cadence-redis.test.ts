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
      // #6754 review: that CONFIGURE reached 90 s back, so its deadline (NOW + 61 s) is 1 s after the beat
      // claimed at NOW + 58 s. The afterTick spacing fence refuses it, and the retry on it too.
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
        // The fence: before #6754's review, the first of these applied.
        false,
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

  it('keeps a historical or off-the-wall tick from moving the wall, the same on Redis and on the in-memory fallback (#6729 twin)', async () => {
    const sessionId = newSessionId();
    const onRedis = new RoomManager();
    await onRedis.initialize(instanceOneRedis);
    const inMemory = new RoomManager();
    const sendRule = {
      mode: 'afterTick',
      targetSeconds: 60,
      autoAdvance: true,
      advanceOn: 'send',
      source: 'stage',
    } as const;
    const deadlineRule = { ...sendRule, advanceOn: 'deadline', source: 'settings' } as const;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const tick = (queueItemUuid: string | null, status: 'send' | 'attempt', elapsedMs: number): RestCadenceInput => ({
      action: 'TICK',
      tickQueueItemUuid: queueItemUuid,
      tickStatus: status,
      elapsedMs,
    });
    // The beats that fire: B, then C, D, E, F, F + 93 s (G) and G + 90 s.
    const B = NOW + 61_000;
    const C = B + 129_000;
    const D = C + 61_000;
    const E = D + 130_000;
    const F = E + 200_000;
    const G = F + 93_000;
    const steps: Array<{ nowMs: number; input: RestCadenceInput }> = [
      { nowMs: NOW, input: { action: 'ARM', config: sendRule, elapsedMs: 0 } },
      { nowMs: NOW + 1_000, input: tick('item-1', 'send', 0) },
      { nowMs: B, input: { action: 'FIRE' } },
      // Yesterday's send on the climb just lit changes nothing: the clock keeps waiting for a tick. Before,
      // it anchored at B with lastTick item-2, and this FIRE at B + 60 s applied.
      { nowMs: B + 2_000, input: tick('item-2', 'send', DAY_MS) },
      { nowMs: B + 60_000, input: { action: 'FIRE' } },
      // A send logged now authorizes the advance, which applies once.
      { nowMs: B + 70_000, input: tick('item-2', 'send', 1_000) },
      { nowMs: C, input: { action: 'FIRE' } },
      { nowMs: C + 500, input: { action: 'FIRE' } },
      // The boundary: a send a millisecond over a minute old earns nothing; one exactly a minute old does,
      // and its rest (from C + 1 s) runs out at D, a second before the FIRE.
      { nowMs: C + 2_000, input: tick('item-3', 'send', 60_001) },
      { nowMs: C + 60_000, input: { action: 'FIRE' } },
      { nowMs: C + 61_000, input: tick('item-3', 'send', 60_000) },
      { nowMs: D + 1_000, input: { action: 'FIRE' } },
      // A send naming no queue item (another climb, another angle) restarts the rest and earns nothing.
      { nowMs: D + 5_000, input: tick(null, 'send', 0) },
      { nowMs: D + 65_000, input: { action: 'FIRE' } },
      // Nor does an attempt naming none take the place of the send that did.
      { nowMs: D + 66_000, input: tick('item-4', 'send', 0) },
      { nowMs: D + 70_000, input: tick(null, 'attempt', 0) },
      { nowMs: E, input: { action: 'FIRE' } },
      // On a running rest a historical tick changes nothing, so nothing is written.
      { nowMs: E + 1_000, input: tick('item-5', 'attempt', 0) },
      { nowMs: E + 30_000, input: tick('item-5', 'send', DAY_MS) },
      { nowMs: E + 61_000, input: { action: 'FIRE' } },
      // #6754 review. A paused clock stays paused for a tick 70 s old, so a longer rest set after it
      // waits a full rest from the resume (before: the tick resumed it at F - 68 s, due at F + 22 s).
      { nowMs: F, input: { action: 'ARM', config: deadlineRule, elapsedMs: 60_000 } },
      { nowMs: F, input: { action: 'FIRE' } },
      { nowMs: F + 1_000, input: { action: 'PAUSE' } },
      { nowMs: F + 2_000, input: tick('item-6', 'send', 70_000) },
      { nowMs: F + 3_000, input: { action: 'CONFIGURE', config: { ...deadlineRule, targetSeconds: 90 } } },
      { nowMs: F + 4_000, input: { action: 'RESUME' } },
      { nowMs: F + 22_000, input: { action: 'FIRE' } },
      { nowMs: G, input: { action: 'FIRE' } },
      // The same through a waiting clock: the tick floors at the advance, so the rest runs from G.
      { nowMs: G + 500, input: { action: 'CONFIGURE', config: deadlineRule, anchor: 'CLEAR' } },
      { nowMs: G + 2_000, input: tick('item-6', 'send', 70_000) },
      { nowMs: G + 3_000, input: { action: 'CONFIGURE', config: { ...deadlineRule, targetSeconds: 90 } } },
      { nowMs: G + 22_000, input: { action: 'FIRE' } },
      { nowMs: G + 90_000, input: { action: 'FIRE' } },
    ];
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
        // ARM, TICK, FIRE.
        true,
        true,
        true,
        // Yesterday's send changes nothing, and the FIRE it would have earned is refused.
        false,
        false,
        // A send now, its FIRE, the same beat again.
        true,
        true,
        false,
        // 60 001 ms: refused FIRE. 60 000 ms: FIRE.
        true,
        false,
        true,
        true,
        // No queue item: refused FIRE.
        true,
        false,
        // A send, an attempt naming none, FIRE.
        true,
        true,
        true,
        // An attempt, a historical send that changes nothing, FIRE refused under send.
        true,
        false,
        false,
        // ARM, FIRE, PAUSE, the historical tick (nothing), CONFIGURE, RESUME, FIRE at F + 22 s, FIRE at G.
        true,
        true,
        true,
        false,
        true,
        true,
        false,
        true,
        // CLEAR, the historical tick (floored), CONFIGURE, FIRE at G + 22 s, FIRE at G + 90 s.
        true,
        true,
        true,
        false,
        true,
      ]);
      const lastTicks = redisOutcomes.map((commit) => commit.stored.cadence?.lastTick ?? null);
      expect(lastTicks[3]).toBeNull();
      expect(lastTicks[8]).toBeNull();
      expect(lastTicks[10]).toEqual({ queueItemUuid: 'item-3', status: 'send' });
      expect(lastTicks[12]).toBeNull();
      expect(lastTicks[15]).toEqual({ queueItemUuid: 'item-4', status: 'send' });
      expect(lastTicks[18]).toEqual({ queueItemUuid: 'item-5', status: 'attempt' });
      expect(redisOutcomes[3].stored.cadence?.anchorMs).toBeNull();
      expect(redisOutcomes[23].stored.cadence).toMatchObject({ isRunning: false, anchorMs: F });
      expect(redisOutcomes[29].stored.cadence?.anchorMs).toBe(G);
      expect(redisOutcomes[18].stored.cadence?.anchorMs).toBe(E + 1_000);
      expect(redisOutcomes.map((commit) => commit.stored.cadence?.lastFiredBeatMs ?? null)).toEqual(
        expect.arrayContaining([B, C, D, E, F, G, G + 90_000]),
      );
      expect(memoryOutcomes).toEqual(redisOutcomes);
    } finally {
      await onRedis.shutdown();
      onRedis.reset();
      inMemory.reset();
    }
  });

  it('bounds a PAUSE, spaces onTheMinute beats and re-anchors a KEEP onto afterTick, the same on Redis and in memory (#6754 review)', async () => {
    const sessionId = newSessionId();
    const onRedis = new RoomManager();
    await onRedis.initialize(instanceOneRedis);
    const inMemory = new RoomManager();
    const afterTick60 = {
      mode: 'afterTick',
      targetSeconds: 60,
      autoAdvance: true,
      advanceOn: 'deadline',
      source: 'settings',
    } as const;
    const onTheMinute60 = { ...afterTick60, mode: 'onTheMinute' } as const;
    const H = NOW;
    const J = NOW + 200_000;
    const steps: Array<{ nowMs: number; input: RestCadenceInput }> = [
      // A crewmate pauses on its pre-advance 60 s: the server freezes the 0 s its clock ran since the FIRE.
      { nowMs: H, input: { action: 'ARM', config: afterTick60, elapsedMs: 60_000 } },
      { nowMs: H, input: { action: 'FIRE' } },
      { nowMs: H + 500, input: { action: 'PAUSE', pausedElapsedSeconds: 60 } },
      { nowMs: H + 5_000, input: { action: 'RESUME' } },
      { nowMs: H + 5_000, input: { action: 'FIRE' } },
      { nowMs: H + 65_000, input: { action: 'FIRE' } },
      // onTheMinute: a PAUSE sent with 118 s on a grid that ran 61 s freezes 61.
      { nowMs: J, input: { action: 'ARM', config: onTheMinute60, elapsedMs: 60_000 } },
      { nowMs: J, input: { action: 'FIRE' } },
      { nowMs: J + 1_000, input: { action: 'PAUSE', pausedElapsedSeconds: 118 } },
      { nowMs: J + 3_000, input: { action: 'RESUME' } },
      { nowMs: J + 5_000, input: { action: 'FIRE' } },
      { nowMs: J + 60_000, input: { action: 'FIRE' } },
      // A CONFIGURE NOW dated 58 s back beats 3 s after the last: refused; the next beat applies.
      { nowMs: J + 63_000, input: { action: 'CONFIGURE', config: onTheMinute60, anchor: 'NOW', elapsedMs: 58_000 } },
      { nowMs: J + 65_000, input: { action: 'FIRE' } },
      { nowMs: J + 125_000, input: { action: 'FIRE' } },
      // A KEEP onto a 90 s afterTick rest counts from that beat, not from the grid's origin.
      { nowMs: J + 126_000, input: { action: 'CONFIGURE', config: { ...afterTick60, targetSeconds: 90 } } },
      { nowMs: J + 155_000, input: { action: 'FIRE' } },
      { nowMs: J + 215_000, input: { action: 'FIRE' } },
    ];
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
        // ARM, FIRE, PAUSE, RESUME, FIRE 5 s after the last (before: applied), FIRE a rest later.
        true,
        true,
        true,
        true,
        false,
        true,
        // ARM, FIRE, PAUSE, RESUME, FIRE at J + 5 s (before: applied), the next beat.
        true,
        true,
        true,
        true,
        false,
        true,
        // CONFIGURE NOW, FIRE 3 s after the last (before: applied), the next beat.
        true,
        false,
        true,
        // CONFIGURE KEEP onto afterTick, FIRE before the rest ran (before: the clock was stranded), FIRE.
        true,
        false,
        true,
      ]);
      const stored = redisOutcomes.map((commit) => commit.stored.cadence);
      expect(stored[2]?.pausedElapsedSeconds).toBe(0);
      expect(stored[3]).toMatchObject({ anchorMs: H + 5_000, lastFiredBeatMs: H + 5_000 });
      expect(stored[8]?.pausedElapsedSeconds).toBe(61);
      expect(stored[9]).toMatchObject({ anchorMs: J - 58_000, lastFiredBeatMs: J + 2_000 });
      expect(stored[15]?.anchorMs).toBe(J + 125_000);
      expect(stored.map((cadence) => cadence?.lastFiredBeatMs ?? null)).toEqual(
        expect.arrayContaining([H + 65_000, J + 62_000, J + 125_000, J + 215_000]),
      );
      expect(memoryOutcomes).toEqual(redisOutcomes);
    } finally {
      await onRedis.shutdown();
      onRedis.reset();
      inMemory.reset();
    }
  });

  it('spends a once-only advance in the FIRE’s own write, the same on Redis and in memory', async () => {
    const sessionId = newSessionId();
    const onRedis = new RoomManager();
    await onRedis.initialize(instanceOneRedis);
    const inMemory = new RoomManager();
    // A 4x4 set rest: afterTick + tick, 90 s; the builder's phone counts the reps.
    const setRest = {
      mode: 'afterTick',
      targetSeconds: 90,
      autoAdvance: true,
      autoAdvanceOnce: true,
      advanceOn: 'tick',
      source: 'stage',
    } as const;
    const midSet = { ...setRest, autoAdvance: false, autoAdvanceOnce: undefined } as const;
    const steps: Array<{ nowMs: number; input: RestCadenceInput }> = [
      // Mid-set: auto-advance off. The last rep's send, then the set rest after it.
      { nowMs: NOW, input: { action: 'ARM', config: midSet } },
      { nowMs: NOW, input: { action: 'TICK', tickQueueItemUuid: 'rep-4', tickStatus: 'send' } },
      { nowMs: NOW, input: { action: 'CONFIGURE', config: setRest } },
      // Too early: refused, and the flag stays.
      { nowMs: NOW + 60_000, input: { action: 'FIRE' } },
      // The rest runs out: the advance applies and turns auto-advance off in the same write.
      { nowMs: NOW + 90_000, input: { action: 'FIRE' } },
      // The builder's phone sleeps: a crewmate's rep starts the next rest, which runs out unclaimed.
      { nowMs: NOW + 100_000, input: { action: 'TICK', tickQueueItemUuid: 'rep-1', tickStatus: 'send' } },
      { nowMs: NOW + 190_000, input: { action: 'FIRE' } },
      // PAUSE, RESUME and RESET leave auto-advance where it is.
      { nowMs: NOW + 191_000, input: { action: 'PAUSE' } },
      { nowMs: NOW + 192_000, input: { action: 'RESUME' } },
      { nowMs: NOW + 193_000, input: { action: 'RESET' } },
      { nowMs: NOW + 194_000, input: { action: 'TICK', tickQueueItemUuid: 'rep-2', tickStatus: 'send' } },
      { nowMs: NOW + 284_000, input: { action: 'FIRE' } },
      // The builder's phone wakes and sends the set rest again: the next rest that runs out advances, once.
      { nowMs: NOW + 285_000, input: { action: 'CONFIGURE', config: setRest } },
      { nowMs: NOW + 286_000, input: { action: 'FIRE' } },
      { nowMs: NOW + 290_000, input: { action: 'TICK', tickQueueItemUuid: 'rep-3', tickStatus: 'send' } },
      { nowMs: NOW + 380_000, input: { action: 'FIRE' } },
      // Without the flag auto-advance stays on, as before.
      { nowMs: NOW + 381_000, input: { action: 'CONFIGURE', config: { ...setRest, autoAdvanceOnce: false } } },
      { nowMs: NOW + 382_000, input: { action: 'FIRE' } },
      { nowMs: NOW + 390_000, input: { action: 'TICK', tickQueueItemUuid: 'rep-4', tickStatus: 'send' } },
      { nowMs: NOW + 480_000, input: { action: 'FIRE' } },
    ];
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
        // ARM, TICK, CONFIGURE, FIRE too early, FIRE on time.
        true,
        true,
        true,
        false,
        true,
        // TICK, FIRE with auto-advance off.
        true,
        false,
        // PAUSE, RESUME, RESET, TICK, FIRE with auto-advance still off.
        true,
        true,
        true,
        true,
        false,
        // CONFIGURE, FIRE (applies, 2 s late), TICK, the next rest's FIRE refused.
        true,
        true,
        true,
        false,
        // CONFIGURE without the flag, FIRE, TICK, the next rest's FIRE applies.
        true,
        true,
        true,
        true,
      ]);
      const stored = redisOutcomes.map((commit) => commit.stored.cadence);
      expect(stored.map((cadence) => cadence?.autoAdvance)).toEqual([
        false,
        false,
        true,
        true,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        true,
        false,
        false,
        false,
        true,
        true,
        true,
        true,
      ]);
      expect(stored.map((cadence) => cadence?.autoAdvanceOnce === true)).toEqual([
        false,
        false,
        true,
        true,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        true,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
      ]);
      expect(stored[4]).toMatchObject({ lastFiredBeatMs: NOW + 90_000, anchorMs: null, lastTick: null });
      expect(stored[13]?.lastFiredBeatMs).toBe(NOW + 284_000);
      expect(stored[19]?.lastFiredBeatMs).toBe(NOW + 480_000);
      // The doc on Redis holds the flag only while it is true.
      const raw = await instanceOneRedis.hget(KEYS.sessionRestCadence(sessionId), 'doc');
      expect(raw).not.toContain('autoAdvanceOnce');
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
