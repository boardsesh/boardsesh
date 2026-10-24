/**
 * F3 Redis fields (#6666, docs/current-climb-outside-queue.md, sections 2 and 9):
 * `historyCount`, `historyCountVersion`, `currentUuid` and `currentChangedAt`,
 * against a real Redis running the real CAS script.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import { roomManager, VersionConflictError } from '../services/room-manager';
import { getQueueState } from '../services/room-manager/queue-state';
import { queueMutations } from '../graphql/resolvers/queue/mutations';
import { mirrorSessionClimb } from '../services/queue-mirror';
import { pubsub } from '../pubsub/index';
import { db } from '../db/client';
import { sessionQueues } from '../db/schema';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';
const BOARD_PATH = '/kilter/1/2/3/40';

async function isRedisAvailable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, { connectTimeout: 1000, maxRetriesPerRequest: 0, lazyConnect: true });
  try {
    await probe.connect();
    await probe.ping();
    await probe.quit();
    return true;
  } catch {
    probe.disconnect();
    return false;
  }
}

const redisAvailable = await isRedisAvailable();

function wallItem(uuid: string): ClimbQueueItem {
  return {
    uuid,
    climb: {
      uuid: `climb-${uuid}`,
      setter_username: 'setter',
      name: `Climb ${uuid}`,
      description: '',
      frames: 'p1r12',
      angle: 40,
      ascensionist_count: 1,
      difficulty: '6A',
      quality_average: '3',
      stars: 3,
      difficulty_error: '0',
      mirrored: false,
      benchmark_difficulty: null,
    },
    addedBy: 'tester',
    tickedBy: [],
    suggested: false,
  };
}

const uuidsOf = (queue: readonly { uuid: string }[]) => queue.map(({ uuid }) => uuid);
const sessionKey = (sessionId: string) => `boardsesh:session:${sessionId}`;
// Fresh per test: the distributed state's startup cleanup reaps the previous
// test's (dead) instance, and a reused id would lose this test's connection hash.
let connectionId = 'conn-redis';
const ctxFor = (sessionId: string) => ({
  connectionId,
  sessionId,
  rateLimitTokens: 1000,
  rateLimitLastReset: Date.now(),
});

describe.skipIf(!redisAvailable)('F3 Redis fields against real Redis', () => {
  let redis: Redis;

  beforeEach(async () => {
    redis = new Redis(REDIS_URL);
    roomManager.reset();
    await roomManager.initialize(redis);
    vi.spyOn(pubsub, 'publishQueueEvent').mockImplementation(() => {});
    connectionId = `conn-redis-${uuidv4().slice(0, 8)}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    roomManager.reset();
    await redis.quit();
  });

  async function freshSession() {
    const sessionId = uuidv4();
    await roomManager.registerClient(connectionId);
    await roomManager.joinSession(connectionId, sessionId, BOARD_PATH, 'Tester');
    return sessionId;
  }

  it('rolling deploy: a pre-F3 write leaves the fields stale, so the reader derives the line and falls back to lastActivity', async () => {
    const sessionId = await freshSession();
    const history = [wallItem('h1'), wallItem('h2')];
    const upNext = [wallItem('c')];
    await roomManager.updateQueueState(sessionId, [...history, ...upNext], null, undefined, 2);
    expect((await roomManager.getQueueState(sessionId)).historyCount).toBe(2);

    // What the pre-F3 script does: bump version and sequence, write queue and
    // lastActivity, and know nothing of the F3 fields.
    const stored = await redis.hgetall(sessionKey(sessionId));
    const oldScriptStamp = Date.now() - 60_000;
    await redis.hset(sessionKey(sessionId), {
      version: String(Number(stored.version) + 1),
      sequence: String(Number(stored.sequence) + 1),
      lastActivity: String(oldScriptStamp),
    });

    const read = await roomManager.getQueueState(sessionId);
    expect(read.historyCount).toBe(0);
    expect(read.currentChangedAt).toBe(new Date(oldScriptStamp).toISOString());

    // The next new-script write stamps the clock fresh (the stored uuid can't be trusted).
    await roomManager.updateQueueState(sessionId, read.queue, null, read.version, 2);
    const healed = await roomManager.getQueueState(sessionId);
    expect(healed.historyCount).toBe(2);
    expect(Date.parse(healed.currentChangedAt ?? '')).toBeGreaterThan(oldScriptStamp);
  });

  it('addQueueItem and reorderQueueItem through updateQueueOnly keep the line valid with nothing current', async () => {
    const sessionId = await freshSession();
    await roomManager.updateQueueState(
      sessionId,
      [wallItem('h1'), wallItem('h2'), wallItem('c'), wallItem('d')],
      null,
      undefined,
      2,
    );

    await queueMutations.addQueueItem({}, { item: wallItem('e') }, ctxFor(sessionId));
    let hash = await redis.hgetall(sessionKey(sessionId));
    expect(hash.historyCountVersion).toBe(hash.version);
    expect((await roomManager.getQueueState(sessionId)).historyCount).toBe(2);

    // A History entry dragged below the line joins Up next.
    await queueMutations.reorderQueueItem({}, { uuid: 'h1', oldIndex: 0, newIndex: 3 }, ctxFor(sessionId));
    hash = await redis.hgetall(sessionKey(sessionId));
    expect(hash.historyCountVersion).toBe(hash.version);
    const state = await roomManager.getQueueState(sessionId);
    expect(uuidsOf(state.queue)).toEqual(['h2', 'c', 'd', 'h1', 'e']);
    expect(state.historyCount).toBe(1);
  });

  it('currentChangedAt moves only when the current uuid changes', async () => {
    const sessionId = await freshSession();
    const itemA = wallItem('a');
    const itemB = wallItem('b');
    await roomManager.updateQueueState(sessionId, [itemA, itemB], itemA, undefined, 0);
    const first = (await roomManager.getQueueState(sessionId)).currentChangedAt;
    // Rewind the stored clock so a stamp is visible.
    const rewound = String(Date.now() - 5 * 60 * 60 * 1000);
    await redis.hset(sessionKey(sessionId), 'currentChangedAt', rewound);
    const rewoundIso = new Date(Number(rewound)).toISOString();
    expect(first).not.toBe(rewoundIso);

    await queueMutations.addQueueItem({}, { item: wallItem('c') }, ctxFor(sessionId));
    expect((await roomManager.getQueueState(sessionId)).currentChangedAt).toBe(rewoundIso);

    await queueMutations.reorderQueueItem({}, { uuid: 'c', oldIndex: 2, newIndex: 1 }, ctxFor(sessionId));
    expect((await roomManager.getQueueState(sessionId)).currentChangedAt).toBe(rewoundIso);

    await mirrorSessionClimb(sessionId, true, 'a');
    expect((await roomManager.getQueueState(sessionId)).currentChangedAt).toBe(rewoundIso);

    // A no-op write-back whose items were rebuilt the way mobile rebuilds them:
    // different key order, slim fields.
    const stored = await roomManager.getQueueState(sessionId);
    const rebuilt = stored.queue.map((queueItem) => ({
      suggested: queueItem.suggested,
      climb: { ...queueItem.climb, description: undefined },
      uuid: queueItem.uuid,
    })) as ClimbQueueItem[];
    const rebuiltCurrent = rebuilt.find(({ uuid }) => uuid === stored.currentClimbQueueItem?.uuid);
    await queueMutations.setQueue({}, { queue: rebuilt, currentClimbQueueItem: rebuiltCurrent }, ctxFor(sessionId));
    expect((await roomManager.getQueueState(sessionId)).currentChangedAt).toBe(rewoundIso);

    // A different current climb stamps it.
    await queueMutations.setCurrentClimb({}, { item: itemB, shouldAddToQueue: false }, ctxFor(sessionId));
    expect((await roomManager.getQueueState(sessionId)).currentChangedAt).not.toBe(rewoundIso);
  });

  it('a nothing-current setQueue raced by a removal between read and write conflicts and retries', async () => {
    const sessionId = await freshSession();
    const itemA = wallItem('a');
    const itemB = wallItem('b');
    const itemC = wallItem('c');
    const itemD = wallItem('d');
    // Stored [A B | C D].
    await roomManager.updateQueueState(sessionId, [itemA, itemB, itemC, itemD], null, undefined, 2);

    const realUpdate = roomManager.updateQueueState.bind(roomManager);
    let raced = false;
    const updateSpy = vi
      .spyOn(roomManager, 'updateQueueState')
      .mockImplementation(async (id, queue, current, expectedVersion, historyCount) => {
        if (!raced && expectedVersion !== undefined) {
          raced = true;
          // A crewmate removes A between the setQueue's read and its write.
          await realUpdate(id, [itemB, itemC, itemD], null, expectedVersion, 1);
        }
        return realUpdate(id, queue, current, expectedVersion, historyCount);
      });

    // An old phone's playlist append: no historyCount, nothing current.
    const appended = wallItem('e');
    await queueMutations.setQueue({}, { queue: [itemB, itemC, itemD, appended] }, ctxFor(sessionId));

    const versionedCalls = updateSpy.mock.calls.filter(([, , , expectedVersion]) => expectedVersion !== undefined);
    expect(versionedCalls.length).toBeGreaterThanOrEqual(2);
    const state = await roomManager.getQueueState(sessionId);
    // Derived from the History the write actually raced against ([B]), not the stale [A B].
    expect(uuidsOf(state.queue)).toEqual(['b', 'c', 'd', 'e']);
    expect(state.historyCount).toBe(1);
  });

  it('dormant restore derives the line and takes the hold clock from board_session_queues.updated_at', async () => {
    const sessionId = await freshSession();
    const history = [wallItem('h1')];
    const upNext = [wallItem('c')];
    await roomManager.updateQueueStateImmediate(sessionId, [...history, ...upNext], null, undefined, 1);
    const updatedAt = new Date(Date.now() - 6 * 60 * 60 * 1000);
    await db.update(sessionQueues).set({ updatedAt }).where(eq(sessionQueues.sessionId, sessionId));

    // Past the 4 h TTL: Redis holds nothing.
    await redis.del(sessionKey(sessionId));
    const dormant = await getQueueState(sessionId, null);
    expect(dormant.historyCount).toBe(0);
    expect(dormant.currentChangedAt).toBe(updatedAt.toISOString());

    // A join after the gap restores the room into Redis with the same values, written as fresh.
    roomManager.reset();
    await roomManager.initialize(redis);
    const rejoinId = `${connectionId}-rejoin`;
    await roomManager.registerClient(rejoinId);
    await roomManager.joinSession(rejoinId, sessionId, BOARD_PATH, 'Tester');
    const restored = await roomManager.getQueueState(sessionId);
    expect(restored.currentChangedAt).toBe(updatedAt.toISOString());
    const hash = await redis.hgetall(sessionKey(sessionId));
    expect(hash.historyCountVersion).toBe(hash.version);
  });

  it('a version conflict is still a conflict with the F3 fields in the script', async () => {
    const sessionId = await freshSession();
    const state = await roomManager.getQueueState(sessionId);
    await roomManager.updateQueueState(sessionId, [wallItem('a')], null, state.version, 0);
    await expect(
      roomManager.updateQueueState(sessionId, [wallItem('b')], null, state.version, 0),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });
});
