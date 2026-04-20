/**
 * Round-trip tests for multi-board queue items — `boardConfig` and `boardId`
 * must survive going through the session store, and the `computeStateHash`
 * helper must produce the same hash on two separate writers with identical
 * logical queues.
 *
 * These tests use the in-memory mock Redis helper (`createMockRedis`) and
 * bypass the `roomManager` singleton entirely, so they do NOT need the
 * Postgres test container running.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import { RedisSessionStore } from '../../redis-session-store';
import { computeQueueStateHash } from '../../../utils/hash';
import { createMockRedis, type MockRedis } from '../../../__tests__/helpers/mock-redis';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueueItem(
  overrides: Partial<ClimbQueueItem> = {},
): ClimbQueueItem {
  return {
    uuid: 'qi-1',
    climb: {
      uuid: 'climb-1',
      setter_username: 'setter',
      name: 'Test Climb',
      description: '',
      frames: 'p12r12',
      angle: 40,
      ascensionist_count: 0,
      difficulty: '6A',
      quality_average: '3',
      stars: 3,
      difficulty_error: '',
      mirrored: false,
      benchmark_difficulty: null,
    },
    addedBy: 'user-1',
    tickedBy: [],
    suggested: false,
    boardConfig: {
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: [1, 2],
      angle: 40,
    },
    boardId: 'user-board-uuid-1',
    ...overrides,
  };
}

async function seedSession(
  store: RedisSessionStore,
  sessionId: string,
  queue: ClimbQueueItem[],
  current: ClimbQueueItem | null,
) {
  const stateHash = computeQueueStateHash(queue, current?.uuid ?? null);
  await store.saveSession({
    sessionId,
    boardPath: '/kilter/1/10/1,2/40',
    queue,
    currentClimbQueueItem: current,
    version: 1,
    sequence: 1,
    stateHash,
    lastActivity: new Date(),
    discoverable: false,
    latitude: null,
    longitude: null,
    name: null,
    createdByUserId: null,
    createdAt: new Date(),
  });
  return { stateHash };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('queue-state boardConfig round-trip', () => {
  let redis: MockRedis;
  let store: RedisSessionStore;

  beforeEach(() => {
    redis = createMockRedis();
    store = new RedisSessionStore(redis);
  });

  it('a ClimbQueueItem with boardConfig + boardId round-trips through save → get unchanged', async () => {
    const sessionId = 'session-1';
    const item = makeQueueItem();
    await seedSession(store, sessionId, [item], item);

    const got = await store.getSession(sessionId);

    expect(got).not.toBeNull();
    expect(got!.queue).toHaveLength(1);
    const gotItem = got!.queue[0];
    // Full boardConfig preserved
    expect(gotItem.boardConfig).toEqual({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: [1, 2],
      angle: 40,
    });
    expect(gotItem.boardId).toBe('user-board-uuid-1');
    // currentClimbQueueItem equally preserved
    expect(got!.currentClimbQueueItem).not.toBeNull();
    expect(got!.currentClimbQueueItem!.boardConfig).toEqual(item.boardConfig);
    expect(got!.currentClimbQueueItem!.boardId).toBe('user-board-uuid-1');
  });

  it('multiple queue items with different boardConfigs (multi-board queue) survive round-trip', async () => {
    const sessionId = 'session-multi';
    const kilter = makeQueueItem({
      uuid: 'qi-kilter',
      boardConfig: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: [1, 2], angle: 40 },
      boardId: 'ub-kilter',
    });
    const tension = makeQueueItem({
      uuid: 'qi-tension',
      boardConfig: { boardName: 'tension', layoutId: 2, sizeId: 15, setIds: [3, 4], angle: 35 },
      boardId: 'ub-tension',
    });
    await seedSession(store, sessionId, [kilter, tension], tension);

    const got = await store.getSession(sessionId);

    expect(got!.queue).toHaveLength(2);
    expect(got!.queue[0].boardConfig?.boardName).toBe('kilter');
    expect(got!.queue[0].boardId).toBe('ub-kilter');
    expect(got!.queue[1].boardConfig?.boardName).toBe('tension');
    expect(got!.queue[1].boardConfig?.setIds).toEqual([3, 4]);
    expect(got!.queue[1].boardId).toBe('ub-tension');
  });

  it('updateQueueState preserves boardConfig / boardId after a state update', async () => {
    const sessionId = 'session-update';
    const initial = makeQueueItem({ uuid: 'qi-init', boardId: 'ub-a' });
    await seedSession(store, sessionId, [initial], initial);

    const replacement = makeQueueItem({
      uuid: 'qi-new',
      boardConfig: { boardName: 'tension', layoutId: 9, sizeId: 99, setIds: [7], angle: 25 },
      boardId: 'ub-b',
    });
    const newHash = computeQueueStateHash([replacement], replacement.uuid);
    await store.updateQueueState(sessionId, [replacement], replacement, 2, 2, newHash);

    const got = await store.getSession(sessionId);
    expect(got!.queue).toHaveLength(1);
    expect(got!.queue[0].uuid).toBe('qi-new');
    expect(got!.queue[0].boardConfig).toEqual({
      boardName: 'tension',
      layoutId: 9,
      sizeId: 99,
      setIds: [7],
      angle: 25,
    });
    expect(got!.queue[0].boardId).toBe('ub-b');
    expect(got!.currentClimbQueueItem!.boardConfig!.boardName).toBe('tension');
  });
});

describe('computeQueueStateHash — cross-writer determinism', () => {
  it('produces the same hash for the same logical queue from two separate writers', () => {
    // Two completely independent constructions of a logically-identical queue.
    // Items differ only in object identity, not value.
    const writerA: ClimbQueueItem[] = [
      makeQueueItem({ uuid: 'q-a' }),
      makeQueueItem({ uuid: 'q-b' }),
    ];
    const writerB: ClimbQueueItem[] = [
      makeQueueItem({ uuid: 'q-a' }),
      makeQueueItem({ uuid: 'q-b' }),
    ];

    const hashA = computeQueueStateHash(writerA, 'q-b');
    const hashB = computeQueueStateHash(writerB, 'q-b');

    expect(hashA).toBe(hashB);
  });

  it('is order-independent (queue is sorted canonically before hashing)', () => {
    const forward = [makeQueueItem({ uuid: 'q-1' }), makeQueueItem({ uuid: 'q-2' })];
    const reversed = [makeQueueItem({ uuid: 'q-2' }), makeQueueItem({ uuid: 'q-1' })];
    expect(computeQueueStateHash(forward, 'q-1')).toBe(computeQueueStateHash(reversed, 'q-1'));
  });

  it('changes when the current item UUID changes', () => {
    const queue = [makeQueueItem({ uuid: 'q-1' }), makeQueueItem({ uuid: 'q-2' })];
    const h1 = computeQueueStateHash(queue, 'q-1');
    const h2 = computeQueueStateHash(queue, 'q-2');
    const hNull = computeQueueStateHash(queue, null);
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(hNull);
    expect(h2).not.toBe(hNull);
  });

  it('changes when the queue membership changes', () => {
    const a = [makeQueueItem({ uuid: 'q-1' })];
    const b = [makeQueueItem({ uuid: 'q-1' }), makeQueueItem({ uuid: 'q-2' })];
    expect(computeQueueStateHash(a, 'q-1')).not.toBe(computeQueueStateHash(b, 'q-1'));
  });
});
