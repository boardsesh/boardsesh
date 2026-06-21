/**
 * Tests for queue sync fixes:
 * 1. updateQueueOnly - Redis-first approach (fixes version desync)
 * 2. addQueueItem - event publishing fix (only publish when item added)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { roomManager, VersionConflictError } from '../services/room-manager';
import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import { queueMutations } from '../graphql/resolvers/queue/mutations';
import { pubsub } from '../pubsub/index';
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
      await roomManager.updateQueueState(sessionId, [createTestClimb()], null, initialState.version);

      // Get state after update
      const state = await roomManager.getQueueState(sessionId);
      const previousVersion = state.version;
      const previousSequence = state.sequence;

      // Call updateQueueOnly
      const result = await roomManager.updateQueueOnly(sessionId, [createTestClimb(), createTestClimb()]);

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
      await roomManager.updateQueueState(sessionId, [climb], null, initialState.version);

      // Flush to ensure Postgres has the data
      await roomManager.flushPendingWrites();

      // Clear Redis to simulate empty Redis
      mockRedis._hashes.clear();

      // Reset and reinitialize room manager
      roomManager.reset();
      await roomManager.initialize(mockRedis);

      // updateQueueOnly should still work by falling back to Postgres
      const result = await roomManager.updateQueueOnly(sessionId, [climb, createTestClimb()]);

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
      await roomManager.updateQueueOnly(sessionId, [climb1, climb2]);

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
      const result = await roomManager.updateQueueOnly(sessionId, [climb1, climb2]);

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
      await expect(roomManager.updateQueueOnly(sessionId, [createTestClimb()], currentVersion + 100)).rejects.toThrow(
        VersionConflictError,
      );
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
      const result = await roomManager.updateQueueOnly(sessionId, [createTestClimb()], currentVersion);

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
      const result1 = await roomManager.updateQueueOnly(sessionId, [createTestClimb()]);
      expect(result1.version).toBe(initialState.version + 1);

      // Second update
      const result2 = await roomManager.updateQueueOnly(sessionId, [createTestClimb()]);
      expect(result2.version).toBe(result1.version + 1);
    });
  });

  describe('Return value', () => {
    it('should return version, sequence, and stateHash', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Create session
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

      const result = await roomManager.updateQueueOnly(sessionId, [createTestClimb()]);

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
      const result1 = await roomManager.updateQueueOnly(sessionId, [climb1]);

      // Update with different set
      const result2 = await roomManager.updateQueueOnly(sessionId, [climb1, climb2]);

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
        await roomManager.updateQueueOnly(sessionId, [createTestClimb()]);
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
    await roomManager.updateQueueState(sessionId, [climb], null, state.version);

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
    await roomManager.updateQueueState(sessionId, [climb1], null, state.version);

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
    await roomManager.updateQueueState(sessionId, [climb1, climb2], null, state.version);

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
    await roomManager.updateQueueState(sessionId, [climb], null, state.version);
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
