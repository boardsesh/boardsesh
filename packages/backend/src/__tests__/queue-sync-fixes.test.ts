/**
 * Tests for queue sync fixes:
 * 1. updateQueueOnly - Redis-first approach (fixes version desync)
 * 2. addQueueItem - event publishing fix (only publish when item added)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { roomManager, VersionConflictError } from '../services/room-manager';
import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import { GraphQLError } from 'graphql';
import { queueMutations } from '../graphql/resolvers/queue/mutations';
import { sessionMutations } from '../graphql/resolvers/sessions/mutations';
import { pubsub } from '../pubsub/index';
import { logger } from '../utils/logger';
import { createMockRedis, type MockRedis } from './helpers/mock-redis';

const createTestClimb = (uuid?: string): ClimbQueueItem => ({
  uuid: uuid || uuidv4(),
  climb: {
    uuid: uuidv4(),
    setter_username: 'TestSetter',
    name: 'Test Climb',
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

// Helper function to register a client before joining
const registerAndJoinSession = async (clientId: string, sessionId: string, boardPath: string, username: string) => {
  await roomManager.registerClient(clientId);
  return roomManager.joinSession(clientId, sessionId, boardPath, username);
};

describe('updateQueueOnly - Redis-first approach', () => {
  let mockRedis: MockRedis;

  beforeEach(async () => {
    // Create fresh mock Redis for each test
    mockRedis = createMockRedis();

    // Reset room manager and initialize with mock Redis
    roomManager.reset();
    await roomManager.initialize(mockRedis);
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  describe('Reading from Redis', () => {
    it('should read current version and sequence from Redis', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Create session
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

      // Update state to get a known version/sequence
      const initialState = await roomManager.getQueueState(sessionId);
      await roomManager.updateQueueState(sessionId, [createTestClimb()], null, initialState.version, 0);

      // Get state after update
      const state = await roomManager.getQueueState(sessionId);
      const previousVersion = state.version;
      const previousSequence = state.sequence;

      // Call updateQueueOnly
      const result = await roomManager.updateQueueOnly(
        sessionId,
        [createTestClimb(), createTestClimb()],
        undefined,
        undefined,
        0,
      );

      // Should have incremented version and sequence
      expect(result.version).toBe(previousVersion + 1);
      expect(result.sequence).toBe(previousSequence + 1);
    });

    it('should fall back to Postgres when Redis is empty', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Create session and update queue to write to Postgres
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');
      const climb = createTestClimb();
      const initialState = await roomManager.getQueueState(sessionId);
      await roomManager.updateQueueState(sessionId, [climb], null, initialState.version, 0);

      // Flush to ensure Postgres has the data
      await roomManager.flushPendingWrites();

      // Clear Redis to simulate empty Redis
      mockRedis._hashes.clear();

      // Reset and reinitialize room manager
      roomManager.reset();
      await roomManager.initialize(mockRedis);

      // updateQueueOnly should still work by falling back to Postgres
      const result = await roomManager.updateQueueOnly(sessionId, [climb, createTestClimb()], undefined, undefined, 0);

      // Should have a valid result (incremented from Postgres values)
      expect(result.version).toBeGreaterThan(0);
      expect(result.sequence).toBeGreaterThan(0);
      expect(result.stateHash).toBeDefined();
    });
  });

  describe('Writing to Redis', () => {
    it('should write updated queue state to Redis immediately', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Create session
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

      const climb1 = createTestClimb();
      const climb2 = createTestClimb();

      // Call updateQueueOnly
      await roomManager.updateQueueOnly(sessionId, [climb1, climb2], undefined, undefined, 0);

      // Verify Redis was updated
      const redisSession = mockRedis._hashes.get(`boardsesh:session:${sessionId}`);
      expect(redisSession).toBeDefined();

      // Parse the queue from Redis
      const redisQueue = JSON.parse(redisSession?.queue || '[]');
      expect(redisQueue).toHaveLength(2);
      expect(redisQueue[0].uuid).toBe(climb1.uuid);
      expect(redisQueue[1].uuid).toBe(climb2.uuid);
    });

    it('should increment version and sequence on update', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Create session
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

      const climb1 = createTestClimb();
      const climb2 = createTestClimb();

      // Get initial state
      const initialState = await roomManager.getQueueState(sessionId);

      // Call updateQueueOnly
      const result = await roomManager.updateQueueOnly(sessionId, [climb1, climb2], undefined, undefined, 0);

      // Verify version and sequence incremented
      expect(result.version).toBe(initialState.version + 1);
      expect(result.sequence).toBe(initialState.sequence + 1);
      // Verify stateHash is returned
      expect(result.stateHash).toBeDefined();
      expect(result.stateHash.length).toBeGreaterThan(0);
    });
  });

  describe('Version checking (optimistic locking)', () => {
    it('should throw VersionConflictError when expectedVersion does not match', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Create session
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

      // Get current state
      const state = await roomManager.getQueueState(sessionId);
      const currentVersion = state.version;

      // Try to update with wrong version
      await expect(
        roomManager.updateQueueOnly(sessionId, [createTestClimb()], currentVersion + 100, undefined, 0),
      ).rejects.toThrow(VersionConflictError);
    });

    it('should succeed when expectedVersion matches current version', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Create session
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

      // Get current state
      const state = await roomManager.getQueueState(sessionId);
      const currentVersion = state.version;

      // Update with correct version
      const result = await roomManager.updateQueueOnly(sessionId, [createTestClimb()], currentVersion, undefined, 0);

      expect(result.version).toBe(currentVersion + 1);
    });

    it('should increment version on each call', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Create session
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

      // Get initial state
      const initialState = await roomManager.getQueueState(sessionId);

      // First update
      const result1 = await roomManager.updateQueueOnly(sessionId, [createTestClimb()], undefined, undefined, 0);
      expect(result1.version).toBe(initialState.version + 1);

      // Second update
      const result2 = await roomManager.updateQueueOnly(sessionId, [createTestClimb()], undefined, undefined, 0);
      expect(result2.version).toBe(result1.version + 1);
    });
  });

  describe('Return value', () => {
    it('should return version, sequence, and stateHash', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Create session
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

      const result = await roomManager.updateQueueOnly(sessionId, [createTestClimb()], undefined, undefined, 0);

      expect(typeof result.version).toBe('number');
      expect(typeof result.sequence).toBe('number');
      expect(typeof result.stateHash).toBe('string');
      expect(result.stateHash.length).toBeGreaterThan(0);
    });

    it('should compute correct stateHash based on queue content', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Create session
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

      const climb1 = createTestClimb();
      const climb2 = createTestClimb();

      // Update with first set of climbs
      const result1 = await roomManager.updateQueueOnly(sessionId, [climb1], undefined, undefined, 0);

      // Update with different set
      const result2 = await roomManager.updateQueueOnly(sessionId, [climb1, climb2], undefined, undefined, 0);

      // Hashes should be different
      expect(result1.stateHash).not.toBe(result2.stateHash);
    });
  });

  describe('Concurrent updates', () => {
    it('should handle rapid sequential updates without version conflicts', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Create session
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

      const initialState = await roomManager.getQueueState(sessionId);
      const initialSequence = initialState.sequence;

      // Make 5 sequential updates without version checking
      for (let i = 0; i < 5; i++) {
        await roomManager.updateQueueOnly(sessionId, [createTestClimb()], undefined, undefined, 0);
      }

      // Final state should reflect all updates
      const finalState = await roomManager.getQueueState(sessionId);
      expect(finalState.sequence).toBe(initialSequence + 5);
    });
  });
});

describe('addQueueItem - Event publishing fix', () => {
  let mockRedis: MockRedis;
  let publishSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // Create fresh mock Redis for each test
    mockRedis = createMockRedis();

    // Reset room manager and initialize with mock Redis
    roomManager.reset();
    await roomManager.initialize(mockRedis);

    // Spy on pubsub.publishQueueEvent
    publishSpy = vi.spyOn(pubsub, 'publishQueueEvent').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should publish QueueItemAdded event when item is successfully added', async () => {
    const sessionId = uuidv4();
    const boardPath = '/kilter/1/2/3/40';

    // Create session
    await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

    const climb = createTestClimb();

    // Create mock context
    const ctx = {
      connectionId: 'client-1',
      sessionId,
      rateLimitTokens: 60,
      rateLimitLastReset: Date.now(),
    };

    // Add item
    await queueMutations.addQueueItem({}, { item: climb }, ctx);

    // Verify event was published
    expect(publishSpy).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        __typename: 'QueueItemAdded',
        item: climb,
      }),
    );
  });

  it('should NOT publish event when item already exists in queue', async () => {
    const sessionId = uuidv4();
    const boardPath = '/kilter/1/2/3/40';

    // Create session
    await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

    const climb = createTestClimb();

    // Pre-populate the queue with the item using updateQueueState
    const state = await roomManager.getQueueState(sessionId);
    await roomManager.updateQueueState(sessionId, [climb], null, state.version, 0);

    // Clear spy
    publishSpy.mockClear();

    // Create mock context
    const ctx = {
      connectionId: 'client-1',
      sessionId,
      rateLimitTokens: 60,
      rateLimitLastReset: Date.now(),
    };

    // Try to add the same item that's already in queue
    await queueMutations.addQueueItem({}, { item: climb }, ctx);

    // Verify event was NOT published for duplicate
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('should return the item even when it already exists (idempotent)', async () => {
    const sessionId = uuidv4();
    const boardPath = '/kilter/1/2/3/40';

    // Create session
    await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

    const climb = createTestClimb();

    // Create mock context
    const ctx = {
      connectionId: 'client-1',
      sessionId,
      rateLimitTokens: 60,
      rateLimitLastReset: Date.now(),
    };

    // Add item first time
    const result1 = await queueMutations.addQueueItem({}, { item: climb }, ctx);

    // Add same item again
    const result2 = await queueMutations.addQueueItem({}, { item: climb }, ctx);

    // Both should return the item
    expect(result1.uuid).toBe(climb.uuid);
    expect(result2.uuid).toBe(climb.uuid);
  });

  it('should include correct position in published event', async () => {
    const sessionId = uuidv4();
    const boardPath = '/kilter/1/2/3/40';

    // Create session
    await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

    const climb1 = createTestClimb();
    const climb2 = createTestClimb();

    // Create mock context
    const ctx = {
      connectionId: 'client-1',
      sessionId,
      rateLimitTokens: 60,
      rateLimitLastReset: Date.now(),
    };

    // Add first item at position 0
    await queueMutations.addQueueItem({}, { item: climb1, position: 0 }, ctx);

    expect(publishSpy).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        __typename: 'QueueItemAdded',
        position: 0,
      }),
    );

    publishSpy.mockClear();

    // Add second item at position 0 (should push first item to position 1)
    await queueMutations.addQueueItem({}, { item: climb2, position: 0 }, ctx);

    expect(publishSpy).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        __typename: 'QueueItemAdded',
        position: 0,
      }),
    );
  });

  it('should append to end when no position specified', async () => {
    const sessionId = uuidv4();
    const boardPath = '/kilter/1/2/3/40';

    // Create session
    await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

    const climb1 = createTestClimb();
    const climb2 = createTestClimb();

    // Pre-populate the queue with first item
    const state = await roomManager.getQueueState(sessionId);
    await roomManager.updateQueueState(sessionId, [climb1], null, state.version, 0);

    publishSpy.mockClear();

    // Create mock context
    const ctx = {
      connectionId: 'client-1',
      sessionId,
      rateLimitTokens: 60,
      rateLimitLastReset: Date.now(),
    };

    // Add second item without position - should append
    await queueMutations.addQueueItem({}, { item: climb2 }, ctx);

    expect(publishSpy).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        __typename: 'QueueItemAdded',
        position: 1, // Appended at end
      }),
    );
  });
});

describe('reorderQueueItem - Return type handling', () => {
  let mockRedis: MockRedis;
  let publishSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    mockRedis = createMockRedis();
    roomManager.reset();
    await roomManager.initialize(mockRedis);
    publishSpy = vi.spyOn(pubsub, 'publishQueueEvent').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should use sequence from updateQueueOnly result', async () => {
    const sessionId = uuidv4();
    const boardPath = '/kilter/1/2/3/40';

    // Create session and add items to queue
    await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

    const climb1 = createTestClimb();
    const climb2 = createTestClimb();

    // Add items to queue using updateQueueState
    const state = await roomManager.getQueueState(sessionId);
    await roomManager.updateQueueState(sessionId, [climb1, climb2], null, state.version, 0);

    // Clear any previous publish calls
    publishSpy.mockClear();

    // Create mock context
    const ctx = {
      connectionId: 'client-1',
      sessionId,
      rateLimitTokens: 60,
      rateLimitLastReset: Date.now(),
    };

    // Reorder
    await queueMutations.reorderQueueItem({}, { uuid: climb1.uuid, oldIndex: 0, newIndex: 1 }, ctx);

    // Verify event includes a sequence number (should be incremented from the updateQueueOnly call)
    expect(publishSpy).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        __typename: 'QueueReordered',
        sequence: expect.any(Number),
        uuid: climb1.uuid,
        oldIndex: 0,
        newIndex: 1,
      }),
    );
  });
});

describe('order-sensitive dual-hash (stateHashOrdered)', () => {
  let mockRedis: MockRedis;
  let publishSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    mockRedis = createMockRedis();
    roomManager.reset();
    await roomManager.initialize(mockRedis);
    publishSpy = vi.spyOn(pubsub, 'publishQueueEvent').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ctxFor = (sessionId: string) => ({
    connectionId: 'client-1',
    sessionId,
    rateLimitTokens: 60,
    rateLimitLastReset: Date.now(),
  });

  it('updateQueueState / updateQueueOnly / getQueueState all return both hashes', async () => {
    const sessionId = uuidv4();
    await registerAndJoinSession('client-1', sessionId, '/kilter/1/2/3/40', 'User1');

    const climbs = [createTestClimb(), createTestClimb()];
    const updateResult = await roomManager.updateQueueState(sessionId, climbs, null, undefined, 0);
    expect(typeof updateResult.stateHash).toBe('string');
    expect(updateResult.stateHash.length).toBeGreaterThan(0);
    expect(typeof updateResult.stateHashOrdered).toBe('string');
    expect(updateResult.stateHashOrdered.length).toBeGreaterThan(0);

    const onlyResult = await roomManager.updateQueueOnly(sessionId, climbs, undefined, undefined, 0);
    expect(typeof onlyResult.stateHashOrdered).toBe('string');
    expect(onlyResult.stateHashOrdered.length).toBeGreaterThan(0);

    const state = await roomManager.getQueueState(sessionId);
    expect(typeof state.stateHash).toBe('string');
    expect(typeof state.stateHashOrdered).toBe('string');
    expect(state.stateHashOrdered.length).toBeGreaterThan(0);
  });

  it('a reorder changes stateHashOrdered but NOT stateHash (the whole point of v2)', async () => {
    const sessionId = uuidv4();
    await registerAndJoinSession('client-1', sessionId, '/kilter/1/2/3/40', 'User1');

    const climb1 = createTestClimb();
    const climb2 = createTestClimb();
    const initial = await roomManager.getQueueState(sessionId);
    await roomManager.updateQueueState(sessionId, [climb1, climb2], null, initial.version, 0);
    const before = await roomManager.getQueueState(sessionId);
    publishSpy.mockClear();

    // Move climb1 from index 0 to index 1 — same members, different order.
    await queueMutations.reorderQueueItem({}, { uuid: climb1.uuid, oldIndex: 0, newIndex: 1 }, ctxFor(sessionId));

    const reorderedCall = publishSpy.mock.calls.find(
      (call: unknown[]) => (call[1] as { __typename: string }).__typename === 'QueueReordered',
    );
    expect(reorderedCall).toBeDefined();
    const event = reorderedCall![1] as { stateHash: string; stateHashOrdered: string };

    // v1 is order-insensitive → unchanged by the reorder.
    expect(event.stateHash).toBe(before.stateHash);
    // v2 is order-sensitive → it moves. This is the drift the watchdog now sees.
    expect(typeof event.stateHashOrdered).toBe('string');
    expect(event.stateHashOrdered.length).toBeGreaterThan(0);
    expect(event.stateHashOrdered).not.toBe(before.stateHashOrdered);
  });

  it('QueueItemAdded and QueueItemRemoved deltas carry both hashes (and both change)', async () => {
    const sessionId = uuidv4();
    await registerAndJoinSession('client-1', sessionId, '/kilter/1/2/3/40', 'User1');

    const climb1 = createTestClimb();
    const before = await roomManager.getQueueState(sessionId);
    publishSpy.mockClear();

    await queueMutations.addQueueItem({}, { item: climb1 }, ctxFor(sessionId));
    const addedCall = publishSpy.mock.calls.find(
      (call: unknown[]) => (call[1] as { __typename: string }).__typename === 'QueueItemAdded',
    );
    expect(addedCall).toBeDefined();
    const added = addedCall![1] as { stateHash: string; stateHashOrdered: string };
    expect(added.stateHashOrdered.length).toBeGreaterThan(0);
    // An add changes BOTH hashes.
    expect(added.stateHash).not.toBe(before.stateHash);
    expect(added.stateHashOrdered).not.toBe(before.stateHashOrdered);

    publishSpy.mockClear();
    await queueMutations.removeQueueItem({}, { uuid: climb1.uuid }, ctxFor(sessionId));
    const removedCall = publishSpy.mock.calls.find(
      (call: unknown[]) => (call[1] as { __typename: string }).__typename === 'QueueItemRemoved',
    );
    expect(removedCall).toBeDefined();
    const removed = removedCall![1] as { stateHash: string; stateHashOrdered: string };
    expect(removed.stateHashOrdered.length).toBeGreaterThan(0);
    // Removing the just-added climb returns to the empty-queue hashes.
    expect(removed.stateHash).toBe(before.stateHash);
    expect(removed.stateHashOrdered).toBe(before.stateHashOrdered);
  });

  it('setQueue publishes a FullSync whose state carries both hashes', async () => {
    const sessionId = uuidv4();
    await registerAndJoinSession('client-1', sessionId, '/kilter/1/2/3/40', 'User1');
    publishSpy.mockClear();

    await queueMutations.setQueue({}, { queue: [createTestClimb(), createTestClimb()] }, ctxFor(sessionId));

    expect(publishSpy).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        __typename: 'FullSync',
        state: expect.objectContaining({
          stateHash: expect.any(String),
          stateHashOrdered: expect.any(String),
        }),
      }),
    );
  });

  // Issue #3382 — QueueItemRemoved must carry the removing connection's id so
  // subscribers can drop echoes of their own removes instead of tagging them
  // `removedBy: 'peer'` (a double count, since the local remove already
  // tracked itself as 'self').
  it('publishes the removing connection id on QueueItemRemoved', async () => {
    const sessionId = uuidv4();
    await registerAndJoinSession('client-1', sessionId, '/kilter/1/2/3/40', 'User1');

    const climb = createTestClimb();
    await queueMutations.addQueueItem({}, { item: climb }, ctxFor(sessionId));
    publishSpy.mockClear();

    await queueMutations.removeQueueItem({}, { uuid: climb.uuid }, ctxFor(sessionId));
    const removedCall = publishSpy.mock.calls.find(
      (call: unknown[]) => (call[1] as { __typename: string }).__typename === 'QueueItemRemoved',
    );
    expect(removedCall).toBeDefined();
    expect((removedCall![1] as { clientId: string | null }).clientId).toBe('client-1');
  });

  // An anonymous publisher must send null, NOT '': peers compare defensively,
  // and two empty-string clients would echo-suppress each other's removes.
  it('coerces a missing connection id to null on QueueItemRemoved', async () => {
    const sessionId = uuidv4();
    await registerAndJoinSession('client-1', sessionId, '/kilter/1/2/3/40', 'User1');

    const climb = createTestClimb();
    await queueMutations.addQueueItem({}, { item: climb }, ctxFor(sessionId));
    publishSpy.mockClear();

    await queueMutations.removeQueueItem({}, { uuid: climb.uuid }, { ...ctxFor(sessionId), connectionId: '' });
    const removedCall = publishSpy.mock.calls.find(
      (call: unknown[]) => (call[1] as { __typename: string }).__typename === 'QueueItemRemoved',
    );
    expect(removedCall).toBeDefined();
    expect((removedCall![1] as { clientId: string | null }).clientId).toBeNull();
  });

  // Issue #4042 — the add side of the same bug: QueueItemAdded must carry the
  // adding connection's id so subscribers can drop echoes of their own adds
  // instead of tagging them `addedFromTab: 'peer_broadcast'` (a double count,
  // since the local add already tracked itself with its real source tab).
  it('publishes the adding connection id on QueueItemAdded', async () => {
    const sessionId = uuidv4();
    await registerAndJoinSession('client-1', sessionId, '/kilter/1/2/3/40', 'User1');
    publishSpy.mockClear();

    await queueMutations.addQueueItem({}, { item: createTestClimb() }, ctxFor(sessionId));
    const addedCall = publishSpy.mock.calls.find(
      (call: unknown[]) => (call[1] as { __typename: string }).__typename === 'QueueItemAdded',
    );
    expect(addedCall).toBeDefined();
    expect((addedCall![1] as { clientId: string | null }).clientId).toBe('client-1');
  });

  // An anonymous publisher must send null, NOT '': peers compare defensively,
  // and two empty-string clients would echo-suppress each other's adds.
  it('coerces a missing connection id to null on QueueItemAdded', async () => {
    const sessionId = uuidv4();
    await registerAndJoinSession('client-1', sessionId, '/kilter/1/2/3/40', 'User1');
    publishSpy.mockClear();

    await queueMutations.addQueueItem({}, { item: createTestClimb() }, { ...ctxFor(sessionId), connectionId: '' });
    const addedCall = publishSpy.mock.calls.find(
      (call: unknown[]) => (call[1] as { __typename: string }).__typename === 'QueueItemAdded',
    );
    expect(addedCall).toBeDefined();
    expect((addedCall![1] as { clientId: string | null }).clientId).toBeNull();
  });
});

// Issue #2387 — the setQueue "redundant resync" warning must be order-aware.
// A pure reorder (same members, different order) is a legitimate state change
// that leaves the order-insensitive v1 hash unchanged; comparing v1 alone
// misreported it as a no-op and blamed "hash-drift on the publisher". The check
// now requires BOTH v1 and v2 to match, so a reorder passes silently while a
// genuinely redundant setQueue (nothing changed at all) still warns.
describe('setQueue - order-aware no-op resync warning (issue #2387)', () => {
  let mockRedis: MockRedis;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const NOOP_MESSAGE = 'Redundant full-queue resync';

  beforeEach(async () => {
    mockRedis = createMockRedis();
    roomManager.reset();
    await roomManager.initialize(mockRedis);
    vi.spyOn(pubsub, 'publishQueueEvent').mockImplementation(() => {});
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation((() => logger) as unknown as typeof logger.warn);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ctxFor = (sessionId: string) => ({
    connectionId: 'client-1',
    sessionId,
    rateLimitTokens: 60,
    rateLimitLastReset: Date.now(),
  });

  it('does NOT warn when a setQueue only reorders the queue (v1 equal, v2 moved)', async () => {
    const sessionId = uuidv4();
    await registerAndJoinSession('client-1', sessionId, '/kilter/1/2/3/40', 'User1');

    const climb1 = createTestClimb();
    const climb2 = createTestClimb();

    // Seed the queue (previous = empty, so this first call legitimately differs).
    await queueMutations.setQueue({}, { queue: [climb1, climb2] }, ctxFor(sessionId));
    warnSpy.mockClear();

    // Same members, reversed order — a real reorder, not a no-op.
    await queueMutations.setQueue({}, { queue: [climb2, climb1] }, ctxFor(sessionId));

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining(NOOP_MESSAGE));
  });

  it('warns when a setQueue re-pushes an identical queue (v1 and v2 both equal)', async () => {
    const sessionId = uuidv4();
    await registerAndJoinSession('client-1', sessionId, '/kilter/1/2/3/40', 'User1');

    const climb1 = createTestClimb();
    const climb2 = createTestClimb();

    await queueMutations.setQueue({}, { queue: [climb1, climb2] }, ctxFor(sessionId));
    warnSpy.mockClear();

    // Identical membership AND order AND current climb — a genuine no-op.
    await queueMutations.setQueue({}, { queue: [climb1, climb2] }, ctxFor(sessionId));

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(NOOP_MESSAGE));
  });
});

describe('setCurrentClimb - combined queue/current state publishing', () => {
  let mockRedis: MockRedis;
  let publishSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    mockRedis = createMockRedis();
    roomManager.reset();
    await roomManager.initialize(mockRedis);
    publishSpy = vi.spyOn(pubsub, 'publishQueueEvent').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes FullSync when shouldAddToQueue adds and activates in one mutation', async () => {
    const sessionId = uuidv4();
    const boardPath = '/kilter/1/2/3/40';
    await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

    const climb = createTestClimb();
    const ctx = {
      connectionId: 'client-1',
      sessionId,
      rateLimitTokens: 60,
      rateLimitLastReset: Date.now(),
    };

    await queueMutations.setCurrentClimb({}, { item: climb, shouldAddToQueue: true }, ctx);

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        __typename: 'FullSync',
        state: expect.objectContaining({
          stateHash: expect.any(String),
          queue: [climb],
          currentClimbQueueItem: climb,
        }),
      }),
    );
  });

  it('publishes CurrentClimbChanged with stateHash when activating an existing queue item', async () => {
    const sessionId = uuidv4();
    const boardPath = '/kilter/1/2/3/40';
    await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

    const climb = createTestClimb();
    const state = await roomManager.getQueueState(sessionId);
    await roomManager.updateQueueState(sessionId, [climb], null, state.version, 0);
    publishSpy.mockClear();

    const ctx = {
      connectionId: 'client-1',
      sessionId,
      rateLimitTokens: 60,
      rateLimitLastReset: Date.now(),
    };

    await queueMutations.setCurrentClimb({}, { item: climb, shouldAddToQueue: true }, ctx);

    expect(publishSpy).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        __typename: 'CurrentClimbChanged',
        stateHash: expect.any(String),
        item: climb,
      }),
    );
  });

  it('round-trips boardType/layoutId through setCurrentClimb storage (party spill metadata)', async () => {
    const sessionId = uuidv4();
    const boardPath = '/tension/8/2/3/40';
    await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

    // A peer on tension / layout 8 sends a climb carrying its own board metadata.
    const climb = createTestClimb();
    climb.climb.boardType = 'tension';
    climb.climb.layoutId = 8;

    const ctx = {
      connectionId: 'client-1',
      sessionId,
      rateLimitTokens: 60,
      rateLimitLastReset: Date.now(),
    };

    await queueMutations.setCurrentClimb({}, { item: climb, shouldAddToQueue: true }, ctx);

    // The stored state — what a FullSync / subscription serializes back to peers —
    // must keep the metadata, so a peer on another board can skip the spill climb.
    const state = await roomManager.getQueueState(sessionId);
    expect(state.currentClimbQueueItem?.climb.boardType).toBe('tension');
    expect(state.currentClimbQueueItem?.climb.layoutId).toBe(8);
    expect(state.queue[0]?.climb.boardType).toBe('tension');
    expect(state.queue[0]?.climb.layoutId).toBe(8);
  });
});

// Issue #3857 — a single malformed/legacy queue item (historically: a
// non-RFC-4122 wrapper `uuid`) used to fail Zod's `z.array(...).safeParse`
// for the ENTIRE queue, rejecting the whole `setQueue`/`joinSession` call and
// wedging sync indefinitely. `parseArrayTolerant` (validation/schemas/
// primitives.ts) validates each item independently and drops only the bad
// one, so the rest of a user's queue keeps syncing.
describe('setQueue - tolerant per-item validation (issue #3857)', () => {
  let mockRedis: MockRedis;
  let publishSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    mockRedis = createMockRedis();
    roomManager.reset();
    await roomManager.initialize(mockRedis);
    publishSpy = vi.spyOn(pubsub, 'publishQueueEvent').mockImplementation(() => {});
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation((() => logger) as unknown as typeof logger.warn);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ctxFor = (sessionId: string) => ({
    connectionId: 'client-1',
    sessionId,
    rateLimitTokens: 60,
    rateLimitLastReset: Date.now(),
  });

  // A queue item whose wrapper `uuid` fails ExternalUUIDSchema's min(1) bound
  // — same class of malformed item as issue #3857's historical/peer-synced
  // ids, just past the lenient schema's own boundary. Still a valid TS shape:
  // the whole point of the server-side Zod check is catching what TS can't
  // (the payload arrives over the wire as untyped JSON).
  const createEmptyUuidQueueItem = (): ClimbQueueItem => ({ ...createTestClimb(), uuid: '' });

  // A queue item with a VALID uuid but a structurally invalid `climb` payload
  // (angle must be a number) — fails ClimbQueueItemSchema as a whole despite
  // the uuid itself being fine. Models "this exact slot's data is corrupt",
  // as opposed to "this slot's id is malformed".
  const createStructurallyInvalidQueueItem = (uuid: string): ClimbQueueItem => ({
    ...createTestClimb(uuid),
    climb: { ...createTestClimb().climb, angle: 'not-a-number' as unknown as number },
  });

  it('drops a malformed item and keeps syncing the rest of the queue instead of rejecting the whole setQueue call', async () => {
    const sessionId = uuidv4();
    await registerAndJoinSession('client-1', sessionId, '/kilter/1/2/3/40', 'User1');

    const validItem1 = createTestClimb();
    const validItem2 = createTestClimb();
    const malformedItem = createEmptyUuidQueueItem();

    const state = await queueMutations.setQueue(
      {},
      { queue: [validItem1, malformedItem, validItem2], currentClimbQueueItem: validItem1 },
      ctxFor(sessionId),
    );

    expect(state.queue).toHaveLength(2);
    expect(state.queue.map((item: ClimbQueueItem) => item.uuid).sort()).toEqual(
      [validItem1.uuid, validItem2.uuid].sort(),
    );
    // Current wasn't the dropped item, so it survives untouched.
    expect(state.currentClimbQueueItem?.uuid).toBe(validItem1.uuid);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Dropped 1/3 invalid queue item'));
    expect(publishSpy).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        __typename: 'FullSync',
        state: expect.objectContaining({
          queue: expect.arrayContaining([expect.objectContaining({ uuid: validItem1.uuid })]),
        }),
      }),
    );
  });

  it('inserts currentClimbQueueItem at the History / Up next line when its own queue slot is the dropped item (F3 invariant 1), instead of clearing it', async () => {
    const sessionId = uuidv4();
    await registerAndJoinSession('client-1', sessionId, '/kilter/1/2/3/40', 'User1');

    const currentUuid = uuidv4();
    // The array's copy of "current" is corrupt and gets dropped by tolerant
    // parsing...
    const danglingQueueEntry = createStructurallyInvalidQueueItem(currentUuid);
    const validItem = createTestClimb();
    // ...but the caller ALSO independently sends a structurally valid
    // currentClimbQueueItem pointing at that same uuid — a slot that no
    // longer exists in `queue` once the array is filtered.
    const currentClimbQueueItem = createTestClimb(currentUuid);

    const state = await queueMutations.setQueue(
      {},
      { queue: [danglingQueueEntry, validItem], currentClimbQueueItem },
      ctxFor(sessionId),
    );

    // Nothing in the payload is in the (empty) stored History, so the line is
    // 0: the current climb takes the Now slot at the head and the valid item
    // stays Up next.
    expect(state.queue.map((item: ClimbQueueItem) => item.uuid)).toEqual([currentUuid, validItem.uuid]);
    expect(state.currentClimbQueueItem?.uuid).toBe(currentUuid);
    expect(state.historyCount).toBe(0);
  });

  it('still rejects the whole setQueue call when the queue array itself exceeds the 500-item size cap', async () => {
    const sessionId = uuidv4();
    await registerAndJoinSession('client-1', sessionId, '/kilter/1/2/3/40', 'User1');

    const oversizedQueue = Array.from({ length: 501 }, () => createTestClimb());

    await expect(queueMutations.setQueue({}, { queue: oversizedQueue }, ctxFor(sessionId))).rejects.toThrow(
      /Invalid queue/,
    );
  });

  it('joinSession drops a malformed initialQueue item and still seeds the rest, instead of rejecting the whole join', async () => {
    const sessionId = uuidv4();
    const connectionId = 'client-join-3857';
    await roomManager.registerClient(connectionId);

    const validItem1 = createTestClimb();
    const malformedItem = createEmptyUuidQueueItem();
    const joinCtx = { connectionId, rateLimitTokens: 60, rateLimitLastReset: Date.now() };

    const result = await sessionMutations.joinSession(
      {},
      {
        sessionId,
        boardPath: '/kilter/1/2/3/40',
        username: 'User1',
        initialQueue: [validItem1, malformedItem],
      },
      joinCtx,
    );

    expect(result.queueState).not.toBeNull();
    expect(result.queueState?.queue).toHaveLength(1);
    expect(result.queueState?.queue[0]?.uuid).toBe(validItem1.uuid);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Dropped 1/2 invalid initialQueue item'));
  });

  it('joinSession inserts initialCurrentClimb at the line when its own initialQueue slot is the dropped item (F3 invariant 1)', async () => {
    const sessionId = uuidv4();
    const connectionId = 'client-join-3857-dangling';
    await roomManager.registerClient(connectionId);

    const currentUuid = uuidv4();
    // The initialQueue's copy of "current" is corrupt and gets dropped by
    // tolerant parsing...
    const danglingQueueEntry = createStructurallyInvalidQueueItem(currentUuid);
    const validItem = createTestClimb();
    // ...but the caller ALSO independently sends a structurally valid
    // initialCurrentClimb pointing at that same uuid — a slot that no longer
    // exists in the seeded queue once the array is filtered.
    const initialCurrentClimb = createTestClimb(currentUuid);
    const joinCtx = { connectionId, rateLimitTokens: 60, rateLimitLastReset: Date.now() };

    const result = await sessionMutations.joinSession(
      {},
      {
        sessionId,
        boardPath: '/kilter/1/2/3/40',
        username: 'User1',
        initialQueue: [danglingQueueEntry, validItem],
        initialCurrentClimb,
      },
      joinCtx,
    );

    expect(result.queueState).not.toBeNull();
    expect(result.queueState?.queue.map((item: ClimbQueueItem) => item.uuid)).toEqual([currentUuid, validItem.uuid]);
    expect(result.queueState?.currentClimbQueueItem?.uuid).toBe(currentUuid);
    expect(result.queueState?.historyCount).toBe(0);
  });
});

describe('F3: setQueue, joinSession and addQueueItem around the History / Up next line (#6666)', () => {
  let mockRedis: MockRedis;
  let publishSpy: ReturnType<typeof vi.spyOn>;
  const previousPercent = process.env.QUEUE_NOW_SLOT_PERCENT;

  beforeEach(async () => {
    mockRedis = createMockRedis();
    roomManager.reset();
    await roomManager.initialize(mockRedis);
    publishSpy = vi.spyOn(pubsub, 'publishQueueEvent').mockImplementation(() => {});
    delete process.env.QUEUE_NOW_SLOT_PERCENT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousPercent === undefined) delete process.env.QUEUE_NOW_SLOT_PERCENT;
    else process.env.QUEUE_NOW_SLOT_PERCENT = previousPercent;
  });

  const ctxFor = (sessionId: string, connectionId = 'client-1') => ({
    connectionId,
    sessionId,
    rateLimitTokens: 1000,
    rateLimitLastReset: Date.now(),
  });
  const uuidsOf = (queue: ClimbQueueItem[]) => queue.map((item) => item.uuid);

  async function roomWith(queue: ClimbQueueItem[], current: ClimbQueueItem | null, historyCount: number) {
    const sessionId = uuidv4();
    await registerAndJoinSession('client-1', sessionId, '/kilter/1/2/3/40', 'User1');
    await roomManager.updateQueueState(sessionId, queue, current, undefined, historyCount);
    return sessionId;
  }

  describe('setQueue historyCount input', () => {
    it('rejects -1 through QueueIndexSchema', async () => {
      const sessionId = await roomWith([], null, 0);
      await expect(
        queueMutations.setQueue({}, { queue: [createTestClimb()], historyCount: -1 }, ctxFor(sessionId)),
      ).rejects.toThrow();
    });

    it('clamps 9999 to the queue length', async () => {
      const sessionId = await roomWith([], null, 0);
      const queue = [createTestClimb(), createTestClimb()];
      const state = await queueMutations.setQueue({}, { queue, historyCount: 9999 }, ctxFor(sessionId));
      expect(state.historyCount).toBe(2);
    });

    it('ignores a value sent with a current climb that is in the queue', async () => {
      const sessionId = await roomWith([], null, 0);
      const queue = [createTestClimb(), createTestClimb(), createTestClimb()];
      const state = await queueMutations.setQueue(
        {},
        { queue, currentClimbQueueItem: queue[1], historyCount: 0 },
        ctxFor(sessionId),
      );
      expect(state.historyCount).toBe(1);
    });
  });

  describe('setQueue without historyCount and nothing current', () => {
    it("derives the line from the stored History: an old phone's Undo of a History removal puts it back", async () => {
      const [itemA, itemB, itemC, itemD] = [createTestClimb(), createTestClimb(), createTestClimb(), createTestClimb()];
      // Stored [B | C D] after A was removed.
      const sessionId = await roomWith([itemB, itemC, itemD], null, 1);
      const state = await queueMutations.setQueue({}, { queue: [itemA, itemB, itemC, itemD] }, ctxFor(sessionId));
      expect(state.historyCount).toBe(2);
    });

    it('gives 0 for a playlist clear', async () => {
      const sessionId = await roomWith([createTestClimb(), createTestClimb()], null, 2);
      const state = await queueMutations.setQueue({}, { queue: [] }, ctxFor(sessionId));
      expect(state.historyCount).toBe(0);
    });
  });

  describe('the 500 cap', () => {
    it('trims a 600-item payload from History instead of throwing, with a climb current (inside the percent)', async () => {
      process.env.QUEUE_NOW_SLOT_PERCENT = '100';
      const sessionId = await roomWith([], null, 0);
      const queue = Array.from({ length: 600 }, () => createTestClimb());
      const current = queue[550];
      const state = await queueMutations.setQueue({}, { queue, currentClimbQueueItem: current }, ctxFor(sessionId));
      // History 550 -> 100 (the History cap), Now + Up next 50 kept.
      expect(state.queue).toHaveLength(150);
      expect(state.historyCount).toBe(100);
      expect(state.currentClimbQueueItem?.uuid).toBe(current.uuid);
    });

    it('rejects a 600-climb Up next with nothing current with QUEUE_FULL, never dropping its first climbs', async () => {
      const sessionId = await roomWith([], null, 0);
      const queue = Array.from({ length: 600 }, () => createTestClimb());
      const error = await queueMutations.setQueue({}, { queue, historyCount: 0 }, ctxFor(sessionId)).then(
        () => null,
        (rejection: unknown) => rejection,
      );
      expect(error).toBeInstanceOf(GraphQLError);
      expect((error as GraphQLError).extensions.code).toBe('QUEUE_FULL');
      expect((error as GraphQLError).message).toMatch(/Up next holds 600/);
    });

    it('trims History, not Up next, from a 600-item payload with nothing current', async () => {
      const sessionId = await roomWith([], null, 0);
      const queue = Array.from({ length: 600 }, () => createTestClimb());
      const state = await queueMutations.setQueue({}, { queue, historyCount: 200 }, ctxFor(sessionId));
      // History 200 -> 100 (the History cap); the 400 Up next climbs are kept.
      expect(state.queue).toHaveLength(500);
      expect(state.historyCount).toBe(100);
      expect(uuidsOf(state.queue)[100]).toBe(queue[200].uuid);
    });

    it('outside the percent, an orphan in a 500-item payload becomes the extra Now entry: 501 stored, nothing trimmed', async () => {
      process.env.QUEUE_NOW_SLOT_PERCENT = '0';
      const queue = Array.from({ length: 500 }, () => createTestClimb());
      const sessionId = await roomWith(queue, null, 10);
      const orphan = createTestClimb();
      const state = await queueMutations.setQueue({}, { queue, currentClimbQueueItem: orphan }, ctxFor(sessionId));
      expect(state.queue).toHaveLength(501);
      expect(uuidsOf(state.queue)[0]).toBe(queue[0].uuid);
      expect(uuidsOf(state.queue)[10]).toBe(orphan.uuid);
      expect(state.currentClimbQueueItem?.uuid).toBe(orphan.uuid);
      expect(state.historyCount).toBe(10);
    });

    it('outside the percent, stores a 501-item payload whose current climb is in it (the climb on the wall is extra)', async () => {
      process.env.QUEUE_NOW_SLOT_PERCENT = '0';
      const sessionId = await roomWith([], null, 0);
      const queue = Array.from({ length: 501 }, () => createTestClimb());
      const state = await queueMutations.setQueue({}, { queue, currentClimbQueueItem: queue[0] }, ctxFor(sessionId));
      expect(state.queue).toHaveLength(501);
      expect(state.currentClimbQueueItem?.uuid).toBe(queue[0].uuid);
      expect(state.historyCount).toBe(0);
    });

    it('outside the percent, still refuses 501 items with nothing current or a current climb not in the payload', async () => {
      process.env.QUEUE_NOW_SLOT_PERCENT = '0';
      const sessionId = await roomWith([], null, 0);
      const queue = Array.from({ length: 501 }, () => createTestClimb());
      await expect(queueMutations.setQueue({}, { queue }, ctxFor(sessionId))).rejects.toThrow(/Invalid queue/);
      await expect(
        queueMutations.setQueue({}, { queue, currentClimbQueueItem: createTestClimb() }, ctxFor(sessionId)),
      ).rejects.toThrow(/Invalid queue/);
      await expect(
        queueMutations.setQueue(
          {},
          { queue: [...queue, createTestClimb()], currentClimbQueueItem: queue[0] },
          ctxFor(sessionId),
        ),
      ).rejects.toThrow(/Invalid queue/);
    });

    it('inside the percent, a 501-item payload with its current climb in it is stored as is', async () => {
      process.env.QUEUE_NOW_SLOT_PERCENT = '100';
      const sessionId = await roomWith([], null, 0);
      const queue = Array.from({ length: 501 }, () => createTestClimb());
      const state = await queueMutations.setQueue({}, { queue, currentClimbQueueItem: queue[0] }, ctxFor(sessionId));
      expect(state.queue).toHaveLength(501);
      expect(uuidsOf(state.queue)).toEqual(uuidsOf(queue));
    });

    it('inside the percent, a 501-item payload with nothing current loses its History entry, or is refused with none', async () => {
      process.env.QUEUE_NOW_SLOT_PERCENT = '100';
      const sessionId = await roomWith([], null, 0);
      const queue = Array.from({ length: 501 }, () => createTestClimb());
      const trimmed = await queueMutations.setQueue({}, { queue, historyCount: 1 }, ctxFor(sessionId));
      expect(trimmed.queue).toHaveLength(500);
      expect(trimmed.historyCount).toBe(0);
      expect(uuidsOf(trimmed.queue)[0]).toBe(queue[1].uuid);

      await expect(queueMutations.setQueue({}, { queue, historyCount: 0 }, ctxFor(sessionId))).rejects.toMatchObject({
        extensions: { code: 'QUEUE_FULL' },
      });
    });

    it('still throws a 600-item placement-less payload outside the percent', async () => {
      const sessionId = await roomWith([], null, 0);
      const queue = Array.from({ length: 600 }, () => createTestClimb());
      await expect(queueMutations.setQueue({}, { queue }, ctxFor(sessionId))).rejects.toThrow(/Invalid queue/);
    });

    it('throws when Up next alone exceeds 500 with a climb current', async () => {
      const sessionId = await roomWith([], null, 0);
      const queue = Array.from({ length: 600 }, () => createTestClimb());
      await expect(
        queueMutations.setQueue({}, { queue, currentClimbQueueItem: queue[10], historyCount: 0 }, ctxFor(sessionId)),
      ).rejects.toThrow(/Up next holds 589/);
    });

    it('joinSession outside the percent seeds 501 items when the seed current climb is in them, and refuses 501 without', async () => {
      process.env.QUEUE_NOW_SLOT_PERCENT = '0';
      const seed = Array.from({ length: 501 }, () => createTestClimb());
      const join = async (connectionId: string, initialCurrentClimb?: ClimbQueueItem) => {
        await roomManager.registerClient(connectionId);
        const joinCtx = { connectionId, rateLimitTokens: 60, rateLimitLastReset: Date.now() };
        return sessionMutations.joinSession(
          {},
          {
            sessionId: uuidv4(),
            boardPath: '/kilter/1/2/3/40',
            username: 'User1',
            initialQueue: seed,
            initialCurrentClimb,
          },
          joinCtx,
        );
      };
      const seeded = await join('join-501-current', seed[0]);
      expect(seeded.queueState?.queue).toHaveLength(501);
      expect(seeded.queueState?.currentClimbQueueItem?.uuid).toBe(seed[0].uuid);
      await expect(join('join-501-nothing-current')).rejects.toThrow(/Invalid initialQueue/);
    });

    describe('opening a climb with Up next at 500 and nothing current (inside the percent)', () => {
      beforeEach(() => {
        process.env.QUEUE_NOW_SLOT_PERCENT = '100';
      });

      it.each([
        ['a new phone (placement NOW)', { placement: 'NOW' as const, shouldAddToQueue: false }],
        ['an old phone (shouldAddToQueue: true)', { shouldAddToQueue: true }],
      ])('stores 501 entries for %s and refuses nothing', async (_label, request) => {
        const upNext = Array.from({ length: 500 }, () => createTestClimb());
        const sessionId = await roomWith(upNext, null, 0);
        const opened = createTestClimb();
        await queueMutations.setCurrentClimb({}, { item: opened, ...request }, ctxFor(sessionId));
        const state = await roomManager.getQueueState(sessionId);
        expect(state.queue).toHaveLength(501);
        expect(uuidsOf(state.queue)).toEqual([opened.uuid, ...uuidsOf(upNext)]);
        expect(state.currentClimbQueueItem?.uuid).toBe(opened.uuid);
        expect(state.historyCount).toBe(0);
      });

      it('then Next keeps all 501, and a clear drops the cleared climb rather than store 501 with nothing current', async () => {
        const upNext = Array.from({ length: 500 }, () => createTestClimb());
        const sessionId = await roomWith(upNext, null, 0);
        const opened = createTestClimb();
        await queueMutations.setCurrentClimb({}, { item: opened, placement: 'NOW' }, ctxFor(sessionId));
        await queueMutations.setCurrentClimb({}, { item: upNext[0], placement: 'NOW' }, ctxFor(sessionId));
        const afterNext = await roomManager.getQueueState(sessionId);
        expect(afterNext.queue).toHaveLength(501);
        expect(afterNext.historyCount).toBe(1);
        expect(afterNext.currentClimbQueueItem?.uuid).toBe(upNext[0].uuid);

        // Back to [opened | ...500 Up next], then take it off the wall.
        await queueMutations.setCurrentClimb({}, { item: opened, placement: 'STEP' }, ctxFor(sessionId));
        publishSpy.mockClear();
        await queueMutations.setCurrentClimb({}, { item: null, placement: 'NOW' }, ctxFor(sessionId));
        const cleared = await roomManager.getQueueState(sessionId);
        expect(uuidsOf(cleared.queue)).toEqual(uuidsOf(upNext));
        expect(cleared.currentClimbQueueItem).toBeNull();
        expect(cleared.historyCount).toBe(0);
        const typenames = publishSpy.mock.calls.map(
          (call: unknown[]) => (call[1] as { __typename: string }).__typename,
        );
        // A clear has no climb to repaint, so its FullSync goes alone.
        expect(typenames).toEqual(['FullSync']);
      });

      it('refuses an add from there with QUEUE_FULL', async () => {
        const upNext = Array.from({ length: 500 }, () => createTestClimb());
        const sessionId = await roomWith(upNext, null, 0);
        await expect(
          queueMutations.addQueueItem({}, { item: createTestClimb() }, ctxFor(sessionId)),
        ).rejects.toMatchObject({ extensions: { code: 'QUEUE_FULL' } });
      });
    });
  });

  describe.each(['0', '100'])('payload orphans at QUEUE_NOW_SLOT_PERCENT=%s', (percent) => {
    beforeEach(() => {
      process.env.QUEUE_NOW_SLOT_PERCENT = percent;
    });

    it('joinSession with [A B C] + orphan X stores [X A B C], A B C still Up next', async () => {
      const connectionId = `join-orphan-${percent}`;
      await roomManager.registerClient(connectionId);
      const joinCtx = { connectionId, rateLimitTokens: 60, rateLimitLastReset: Date.now() };
      const [itemA, itemB, itemC, orphan] = [
        createTestClimb(),
        createTestClimb(),
        createTestClimb(),
        createTestClimb(),
      ];
      const result = await sessionMutations.joinSession(
        {},
        {
          sessionId: uuidv4(),
          boardPath: '/kilter/1/2/3/40',
          username: 'User1',
          initialQueue: [itemA, itemB, itemC],
          initialCurrentClimb: orphan,
        },
        joinCtx,
      );
      expect(uuidsOf(result.queueState?.queue ?? [])).toEqual([orphan.uuid, itemA.uuid, itemB.uuid, itemC.uuid]);
      expect(result.queueState?.currentClimbQueueItem?.uuid).toBe(orphan.uuid);
      expect(result.queueState?.historyCount).toBe(0);
    });

    it('setQueue inserts a payload orphan at the line it sent instead of clearing or appending it', async () => {
      const sessionId = await roomWith([], null, 0);
      const [history, upNextA, upNextB, orphan] = [
        createTestClimb(),
        createTestClimb(),
        createTestClimb(),
        createTestClimb(),
      ];
      const state = await queueMutations.setQueue(
        {},
        { queue: [history, upNextA, upNextB], currentClimbQueueItem: orphan, historyCount: 1 },
        ctxFor(sessionId),
      );
      expect(uuidsOf(state.queue)).toEqual([history.uuid, orphan.uuid, upNextA.uuid, upNextB.uuid]);
      expect(state.currentClimbQueueItem?.uuid).toBe(orphan.uuid);
      expect(publishSpy).toHaveBeenCalledWith(sessionId, expect.objectContaining({ __typename: 'FullSync' }));
    });
  });

  it('joinSession with only a current climb stores [current]', async () => {
    const connectionId = 'join-current-only';
    await roomManager.registerClient(connectionId);
    const joinCtx = { connectionId, rateLimitTokens: 60, rateLimitLastReset: Date.now() };
    const current = createTestClimb();
    const result = await sessionMutations.joinSession(
      {},
      { sessionId: uuidv4(), boardPath: '/kilter/1/2/3/40', username: 'User1', initialCurrentClimb: current },
      joinCtx,
    );
    expect(uuidsOf(result.queueState?.queue ?? [])).toEqual([current.uuid]);
    expect(result.queueState?.currentClimbQueueItem?.uuid).toBe(current.uuid);
  });

  describe('addQueueItem inside the percent', () => {
    beforeEach(() => {
      process.env.QUEUE_NOW_SLOT_PERCENT = '100';
    });

    it('refuses with QUEUE_FULL when Up next already holds 500 (the climb on the wall is not counted)', async () => {
      const queue = Array.from({ length: 501 }, () => createTestClimb());
      const sessionId = await roomWith(queue, queue[0], 0);
      await expect(
        queueMutations.addQueueItem({}, { item: createTestClimb() }, ctxFor(sessionId)),
      ).rejects.toMatchObject({ extensions: { code: 'QUEUE_FULL' } });
      expect(publishSpy).not.toHaveBeenCalled();
    });

    it('takes an add while Up next is at 499, giving 501 entries with the climb on the wall', async () => {
      const queue = Array.from({ length: 500 }, () => createTestClimb());
      const sessionId = await roomWith(queue, queue[0], 0);
      await queueMutations.addQueueItem({}, { item: createTestClimb() }, ctxFor(sessionId));
      const state = await roomManager.getQueueState(sessionId);
      expect(state.queue).toHaveLength(501);
    });

    it('trims History before refusing: History + Up next at 500 with one History entry takes the add', async () => {
      const queue = Array.from({ length: 501 }, () => createTestClimb());
      // [H | Now | 499 Up next]
      const sessionId = await roomWith(queue, queue[1], 1);
      const added = createTestClimb();
      await queueMutations.addQueueItem({}, { item: added }, ctxFor(sessionId));
      const state = await roomManager.getQueueState(sessionId);
      expect(state.queue).toHaveLength(501);
      expect(state.historyCount).toBe(0);
      expect(uuidsOf(state.queue).at(-1)).toBe(added.uuid);
    });

    it('honours a position inside History while a climb is current', async () => {
      const queue = [createTestClimb(), createTestClimb(), createTestClimb()];
      const sessionId = await roomWith(queue, queue[2], 2);
      const added = createTestClimb();
      await queueMutations.addQueueItem({}, { item: added, position: 0 }, ctxFor(sessionId));
      const state = await roomManager.getQueueState(sessionId);
      expect(uuidsOf(state.queue)[0]).toBe(added.uuid);
      expect(state.historyCount).toBe(3);
      expect(publishSpy).toHaveBeenCalledTimes(1);
    });

    it('clamps a History position to the line with nothing current and follows with a FullSync', async () => {
      const queue = [createTestClimb(), createTestClimb(), createTestClimb()];
      const sessionId = await roomWith(queue, null, 2);
      const added = createTestClimb();
      await queueMutations.addQueueItem({}, { item: added, position: 0 }, ctxFor(sessionId));
      const state = await roomManager.getQueueState(sessionId);
      expect(uuidsOf(state.queue)).toEqual([queue[0].uuid, queue[1].uuid, added.uuid, queue[2].uuid]);
      expect(state.historyCount).toBe(2);
      const typenames = publishSpy.mock.calls.map((call: unknown[]) => (call[1] as { __typename: string }).__typename);
      expect(typenames).toEqual(['QueueItemAdded', 'FullSync']);
    });
  });
});
