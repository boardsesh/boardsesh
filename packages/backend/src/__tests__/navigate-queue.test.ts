import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { roomManager } from '../services/room-manager';
import { db } from '../db/client';
import { sql } from 'drizzle-orm';
import { controllerMutations } from '../graphql/resolvers/controller/mutations';
import type { ConnectionContext, ClimbQueueItem, Climb } from '@boardsesh/shared-schema';
import { pubsub } from '../pubsub/index';

// Test IDs
const TEST_USER_ID = 'test-user-navigate-queue';
const TEST_SESSION_ID = 'test-session-navigate-queue';

// Helper to create a mock climb
function createMockClimb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: uuidv4(),
    name: 'Test Climb',
    difficulty: '6a/V3',
    angle: 40,
    ascensionist_count: 10,
    quality_average: '3.5',
    stars: 3.5,
    difficulty_error: '0.5',
    benchmark_difficulty: null,
    description: 'A test climb',
    setter_username: 'test_setter',
    frames: 'test-frames',
    ...overrides,
  };
}

// Helper to create a mock queue item
function createMockQueueItem(overrides: Partial<ClimbQueueItem> = {}): ClimbQueueItem {
  return {
    uuid: uuidv4(),
    climb: createMockClimb(),
    suggested: false,
    ...overrides,
  };
}

// Helper to create mock authenticated user context
function createMockContext(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: `conn-${Date.now()}`,
    isAuthenticated: true,
    userId: TEST_USER_ID,
    sessionId: TEST_SESSION_ID,
    ...overrides,
  };
}

// Helper to create controller context
function createControllerContext(
  controllerId: string,
  controllerApiKey: string,
  overrides: Partial<ConnectionContext> = {},
): ConnectionContext {
  return {
    connectionId: `conn-${Date.now()}`,
    isAuthenticated: false,
    userId: undefined,
    sessionId: undefined,
    controllerId,
    controllerApiKey,
    ...overrides,
  };
}

describe('navigateQueue mutation', () => {
  let publishSpy: ReturnType<typeof vi.spyOn>;
  let getQueueStateSpy: ReturnType<typeof vi.spyOn>;
  let updateQueueStateSpy: ReturnType<typeof vi.spyOn>;
  let registeredController: { controllerId: string; apiKey: string };

  beforeEach(async () => {
    // Reset room manager
    roomManager.reset();

    // Create test user if not exists (needed for FK constraint)
    await db.execute(sql`
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES (${TEST_USER_ID}, 'test@navigate-queue.test', 'Test User', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);

    // Clean up test data
    await db.execute(sql`DELETE FROM esp32_controllers WHERE user_id = ${TEST_USER_ID}`);

    // Register a controller for testing
    const userCtx = createMockContext();
    const result = await controllerMutations.registerController(
      undefined,
      {
        input: {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,2,3',
          name: 'Test Controller',
        },
      },
      userCtx,
    );
    registeredController = { controllerId: result.controllerId, apiKey: result.apiKey };

    // Authorize controller for test session
    await controllerMutations.authorizeControllerForSession(
      undefined,
      { controllerId: result.controllerId, sessionId: TEST_SESSION_ID },
      userCtx,
    );

    // Spy on pubsub.publishQueueEvent
    publishSpy = vi.spyOn(pubsub, 'publishQueueEvent').mockImplementation(() => {});

    // Spy on roomManager methods - these will be configured per test
    getQueueStateSpy = vi.spyOn(roomManager, 'getQueueState');
    updateQueueStateSpy = vi.spyOn(roomManager, 'updateQueueState');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
    await db.execute(sql`DELETE FROM esp32_controllers WHERE user_id = ${TEST_USER_ID}`);
  });

  describe('Direct navigation via queueItemUuid', () => {
    it('should navigate directly to a valid queueItemUuid', async () => {
      const item1 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 1' }) });
      const item2 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 2' }) });
      const item3 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 3' }) });
      const queue = [item1, item2, item3];

      // Mock roomManager methods
      getQueueStateSpy.mockResolvedValue({
        queue,
        currentClimbQueueItem: item1,
        version: 1,
        sequence: 1,
        stateHash: 'test-hash',
      });
      updateQueueStateSpy.mockResolvedValue({ version: 2, sequence: 2, stateHash: 'new-hash' });

      const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);

      // Navigate directly to item3
      const result = await controllerMutations.navigateQueue(
        undefined,
        { sessionId: TEST_SESSION_ID, direction: 'next', queueItemUuid: item3.uuid },
        controllerCtx,
      );

      expect(result).not.toBeNull();
      expect(result!.uuid).toBe(item3.uuid);
      expect(result!.climb.name).toBe('Climb 3');
    });

    it('should fall back to direction-based navigation when queueItemUuid not found', async () => {
      const item1 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 1' }) });
      const item2 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 2' }) });
      const queue = [item1, item2];

      getQueueStateSpy.mockResolvedValue({
        queue,
        currentClimbQueueItem: item1,
        version: 1,
        sequence: 1,
        stateHash: 'test-hash',
      });
      updateQueueStateSpy.mockResolvedValue({ version: 2, sequence: 2, stateHash: 'new-hash' });

      const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);

      // Navigate with non-existent queueItemUuid - should fall back to direction
      const result = await controllerMutations.navigateQueue(
        undefined,
        { sessionId: TEST_SESSION_ID, direction: 'next', queueItemUuid: 'non-existent-uuid' },
        controllerCtx,
      );

      // Should navigate to next item (item2)
      expect(result).not.toBeNull();
      expect(result!.uuid).toBe(item2.uuid);
    });
  });

  describe('Direction-based navigation', () => {
    it('should navigate "next" from middle of queue', async () => {
      const item1 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 1' }) });
      const item2 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 2' }) });
      const item3 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 3' }) });
      const queue = [item1, item2, item3];

      getQueueStateSpy.mockResolvedValue({
        queue,
        currentClimbQueueItem: item2,
        version: 1,
        sequence: 1,
        stateHash: 'test-hash',
      });
      updateQueueStateSpy.mockResolvedValue({ version: 2, sequence: 2, stateHash: 'new-hash' });

      const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);

      const result = await controllerMutations.navigateQueue(
        undefined,
        { sessionId: TEST_SESSION_ID, direction: 'next' },
        controllerCtx,
      );

      expect(result).not.toBeNull();
      expect(result!.uuid).toBe(item3.uuid);
    });

    it('should stay at end when navigating "next" at end of queue', async () => {
      const item1 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 1' }) });
      const item2 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 2' }) });
      const queue = [item1, item2];

      getQueueStateSpy.mockResolvedValue({
        queue,
        currentClimbQueueItem: item2,
        version: 1,
        sequence: 1,
        stateHash: 'test-hash',
      });

      const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);

      const result = await controllerMutations.navigateQueue(
        undefined,
        { sessionId: TEST_SESSION_ID, direction: 'next' },
        controllerCtx,
      );

      // Should stay at item2 (already at end) - updateQueueState should NOT be called
      expect(result).not.toBeNull();
      expect(result!.uuid).toBe(item2.uuid);
      expect(updateQueueStateSpy).not.toHaveBeenCalled();
    });

    it('should navigate "previous" from middle of queue', async () => {
      const item1 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 1' }) });
      const item2 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 2' }) });
      const item3 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 3' }) });
      const queue = [item1, item2, item3];

      getQueueStateSpy.mockResolvedValue({
        queue,
        currentClimbQueueItem: item2,
        version: 1,
        sequence: 1,
        stateHash: 'test-hash',
      });
      updateQueueStateSpy.mockResolvedValue({ version: 2, sequence: 2, stateHash: 'new-hash' });

      const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);

      const result = await controllerMutations.navigateQueue(
        undefined,
        { sessionId: TEST_SESSION_ID, direction: 'previous' },
        controllerCtx,
      );

      expect(result).not.toBeNull();
      expect(result!.uuid).toBe(item1.uuid);
    });

    it('should stay at start when navigating "previous" at start of queue', async () => {
      const item1 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 1' }) });
      const item2 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 2' }) });
      const queue = [item1, item2];

      getQueueStateSpy.mockResolvedValue({
        queue,
        currentClimbQueueItem: item1,
        version: 1,
        sequence: 1,
        stateHash: 'test-hash',
      });

      const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);

      const result = await controllerMutations.navigateQueue(
        undefined,
        { sessionId: TEST_SESSION_ID, direction: 'previous' },
        controllerCtx,
      );

      // Should stay at item1 (already at start) - updateQueueState should NOT be called
      expect(result).not.toBeNull();
      expect(result!.uuid).toBe(item1.uuid);
      expect(updateQueueStateSpy).not.toHaveBeenCalled();
    });

    it('should start at beginning when navigating "next" with no current climb', async () => {
      const item1 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 1' }) });
      const item2 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 2' }) });
      const queue = [item1, item2];

      getQueueStateSpy.mockResolvedValue({
        queue,
        currentClimbQueueItem: null, // No current climb
        version: 1,
        sequence: 1,
        stateHash: 'test-hash',
      });
      updateQueueStateSpy.mockResolvedValue({ version: 2, sequence: 2, stateHash: 'new-hash' });

      const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);

      const result = await controllerMutations.navigateQueue(
        undefined,
        { sessionId: TEST_SESSION_ID, direction: 'next' },
        controllerCtx,
      );

      // Should start at first item
      expect(result).not.toBeNull();
      expect(result!.uuid).toBe(item1.uuid);
    });

    it('should start at end when navigating "previous" with no current climb', async () => {
      const item1 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 1' }) });
      const item2 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 2' }) });
      const queue = [item1, item2];

      getQueueStateSpy.mockResolvedValue({
        queue,
        currentClimbQueueItem: null, // No current climb
        version: 1,
        sequence: 1,
        stateHash: 'test-hash',
      });
      updateQueueStateSpy.mockResolvedValue({ version: 2, sequence: 2, stateHash: 'new-hash' });

      const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);

      const result = await controllerMutations.navigateQueue(
        undefined,
        { sessionId: TEST_SESSION_ID, direction: 'previous' },
        controllerCtx,
      );

      // Should start at last item
      expect(result).not.toBeNull();
      expect(result!.uuid).toBe(item2.uuid);
    });

    describe('F3: nothing current with History', () => {
      const previousPercent = process.env.QUEUE_NOW_SLOT_PERCENT;
      afterEach(() => {
        if (previousPercent === undefined) delete process.env.QUEUE_NOW_SLOT_PERCENT;
        else process.env.QUEUE_NOW_SLOT_PERCENT = previousPercent;
      });

      const historyAndUpNext = () => {
        const history = createMockQueueItem({ climb: createMockClimb({ name: 'History' }) });
        const upNext = createMockQueueItem({ climb: createMockClimb({ name: 'Up next' }) });
        getQueueStateSpy.mockResolvedValue({
          queue: [history, upNext],
          currentClimbQueueItem: null,
          historyCount: 1,
          version: 1,
          sequence: 1,
          stateHash: 'test-hash',
        });
        updateQueueStateSpy.mockResolvedValue({ version: 2, sequence: 2, stateHash: 'new-hash' });
        return { history, upNext };
      };

      it('"next" starts at the head of Up next, not the oldest History climb', async () => {
        const { upNext } = historyAndUpNext();
        const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);
        const result = await controllerMutations.navigateQueue(
          undefined,
          { sessionId: TEST_SESSION_ID, direction: 'next' },
          controllerCtx,
        );
        expect(result!.uuid).toBe(upNext.uuid);
        expect(updateQueueStateSpy).toHaveBeenCalledWith(TEST_SESSION_ID, expect.any(Array), expect.anything(), 1, 1);
      });

      it('"previous" goes to History\'s last entry', async () => {
        const { history } = historyAndUpNext();
        const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);
        const result = await controllerMutations.navigateQueue(
          undefined,
          { sessionId: TEST_SESSION_ID, direction: 'previous' },
          controllerCtx,
        );
        expect(result!.uuid).toBe(history.uuid);
      });

      it('a pre-F3 orphan current climb stays in History on "next", with FullSync + trailing', async () => {
        const history = createMockQueueItem({ climb: createMockClimb({ name: 'History' }) });
        const upNext = createMockQueueItem({ climb: createMockClimb({ name: 'Up next' }) });
        const orphan = createMockQueueItem({ climb: createMockClimb({ name: 'Orphan' }) });
        getQueueStateSpy.mockResolvedValue({
          queue: [history, upNext],
          currentClimbQueueItem: orphan,
          historyCount: 1,
          version: 1,
          sequence: 1,
          stateHash: 'test-hash',
        });
        updateQueueStateSpy.mockResolvedValue({
          version: 2,
          sequence: 2,
          stateHash: 'new-hash',
          stateHashOrdered: 'new-ordered',
          historyCount: 2,
        });
        const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);
        const result = await controllerMutations.navigateQueue(
          undefined,
          { sessionId: TEST_SESSION_ID, direction: 'next', currentClimbUuid: orphan.uuid },
          controllerCtx,
        );
        expect(result!.uuid).toBe(upNext.uuid);
        expect(updateQueueStateSpy).toHaveBeenCalledWith(
          TEST_SESSION_ID,
          [history, orphan, upNext],
          expect.objectContaining({ uuid: upNext.uuid }),
          1,
          2,
        );
        const publishedCalls = publishSpy.mock.calls as unknown as [string, { __typename: string }, unknown?][];
        expect(publishedCalls.map(([, event]) => event.__typename)).toEqual(['FullSync', 'CurrentClimbChanged']);
        expect(publishedCalls[1][2]).toEqual({ buffer: false });
      });

      it('inside the percent, "next" with Up next empty stops instead of jumping to queue[0]', async () => {
        process.env.QUEUE_NOW_SLOT_PERCENT = '100';
        const history = createMockQueueItem({ climb: createMockClimb({ name: 'History' }) });
        getQueueStateSpy.mockResolvedValue({
          queue: [history],
          currentClimbQueueItem: null,
          historyCount: 1,
          version: 1,
          sequence: 1,
          stateHash: 'test-hash',
        });
        const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);
        const result = await controllerMutations.navigateQueue(
          undefined,
          { sessionId: TEST_SESSION_ID, direction: 'next' },
          controllerCtx,
        );
        expect(result).toBeNull();
        expect(updateQueueStateSpy).not.toHaveBeenCalled();
        expect(publishSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Edge cases', () => {
    it('should return null for empty queue', async () => {
      getQueueStateSpy.mockResolvedValue({
        queue: [],
        currentClimbQueueItem: null,
        version: 1,
        sequence: 1,
        stateHash: 'test-hash',
      });

      const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);

      const result = await controllerMutations.navigateQueue(
        undefined,
        { sessionId: TEST_SESSION_ID, direction: 'next' },
        controllerCtx,
      );

      expect(result).toBeNull();
    });

    it('should handle single-item queue', async () => {
      const item1 = createMockQueueItem({ climb: createMockClimb({ name: 'Only Climb' }) });
      const queue = [item1];

      getQueueStateSpy.mockResolvedValue({
        queue,
        currentClimbQueueItem: item1,
        version: 1,
        sequence: 1,
        stateHash: 'test-hash',
      });

      const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);

      // Navigate next - should stay at same position
      const result = await controllerMutations.navigateQueue(
        undefined,
        { sessionId: TEST_SESSION_ID, direction: 'next' },
        controllerCtx,
      );

      expect(result).not.toBeNull();
      expect(result!.uuid).toBe(item1.uuid);
      expect(updateQueueStateSpy).not.toHaveBeenCalled();
    });

    it('should throw error for invalid direction', async () => {
      const item1 = createMockQueueItem();
      const queue = [item1];

      getQueueStateSpy.mockResolvedValue({
        queue,
        currentClimbQueueItem: item1,
        version: 1,
        sequence: 1,
        stateHash: 'test-hash',
      });

      const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);

      await expect(
        controllerMutations.navigateQueue(
          undefined,
          { sessionId: TEST_SESSION_ID, direction: 'invalid' },
          controllerCtx,
        ),
      ).rejects.toThrow('Invalid direction');
    });
  });

  describe('Event publishing', () => {
    it('should publish CurrentClimbChanged event with clientId=null', async () => {
      const item1 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 1' }) });
      const item2 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 2' }) });
      const queue = [item1, item2];

      getQueueStateSpy.mockResolvedValue({
        queue,
        currentClimbQueueItem: item1,
        version: 1,
        sequence: 1,
        stateHash: 'test-hash',
      });
      updateQueueStateSpy.mockResolvedValue({ version: 2, sequence: 2, stateHash: 'new-hash' });

      const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);

      await controllerMutations.navigateQueue(
        undefined,
        { sessionId: TEST_SESSION_ID, direction: 'next' },
        controllerCtx,
      );

      // Verify event was published with correct structure
      expect(publishSpy).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        expect.objectContaining({
          __typename: 'CurrentClimbChanged',
          clientId: null, // Should be null for navigation events
          item: expect.objectContaining({ uuid: item2.uuid }),
          sequence: 2,
        }),
      );
    });

    it('should include correct sequence number in published event', async () => {
      const item1 = createMockQueueItem();
      const item2 = createMockQueueItem();
      const queue = [item1, item2];

      getQueueStateSpy.mockResolvedValue({
        queue,
        currentClimbQueueItem: item1,
        version: 1,
        sequence: 5,
        stateHash: 'test-hash',
      });
      updateQueueStateSpy.mockResolvedValue({ version: 2, sequence: 6, stateHash: 'new-hash' });

      const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);

      await controllerMutations.navigateQueue(
        undefined,
        { sessionId: TEST_SESSION_ID, direction: 'next' },
        controllerCtx,
      );

      expect(publishSpy).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        expect.objectContaining({
          sequence: 6,
        }),
      );
    });
  });

  describe('Concurrent navigation', () => {
    it('should handle rapid successive navigation requests', async () => {
      const items = Array.from({ length: 5 }, (_, i) =>
        createMockQueueItem({ climb: createMockClimb({ name: `Climb ${i + 1}` }) }),
      );
      const queue = items;

      // Start at first item
      getQueueStateSpy.mockResolvedValue({
        queue,
        currentClimbQueueItem: items[0],
        version: 1,
        sequence: 1,
        stateHash: 'test-hash',
      });

      let sequenceCounter = 1;
      updateQueueStateSpy.mockImplementation(async () => {
        sequenceCounter++;
        return {
          version: sequenceCounter,
          sequence: sequenceCounter,
          stateHash: `hash-${sequenceCounter}`,
        };
      });

      const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);

      // Fire 3 navigation requests concurrently
      const results = await Promise.all([
        controllerMutations.navigateQueue(undefined, { sessionId: TEST_SESSION_ID, direction: 'next' }, controllerCtx),
        controllerMutations.navigateQueue(undefined, { sessionId: TEST_SESSION_ID, direction: 'next' }, controllerCtx),
        controllerMutations.navigateQueue(undefined, { sessionId: TEST_SESSION_ID, direction: 'next' }, controllerCtx),
      ]);

      // All requests should complete successfully
      expect(results.every((r) => r !== null)).toBe(true);

      // updateQueueState should have been called 3 times
      expect(updateQueueStateSpy).toHaveBeenCalledTimes(3);
    });

    it('should serialize concurrent requests to the same target', async () => {
      const item1 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 1' }) });
      const item2 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 2' }) });
      const queue = [item1, item2];

      getQueueStateSpy.mockResolvedValue({
        queue,
        currentClimbQueueItem: item1,
        version: 1,
        sequence: 1,
        stateHash: 'test-hash',
      });
      updateQueueStateSpy.mockResolvedValue({ version: 2, sequence: 2, stateHash: 'new-hash' });

      const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);

      // Navigate to same target item concurrently
      const results = await Promise.all([
        controllerMutations.navigateQueue(
          undefined,
          { sessionId: TEST_SESSION_ID, direction: 'next', queueItemUuid: item2.uuid },
          controllerCtx,
        ),
        controllerMutations.navigateQueue(
          undefined,
          { sessionId: TEST_SESSION_ID, direction: 'next', queueItemUuid: item2.uuid },
          controllerCtx,
        ),
      ]);

      // Both should successfully navigate to the same item
      expect(results[0]?.uuid).toBe(item2.uuid);
      expect(results[1]?.uuid).toBe(item2.uuid);
    });
  });

  describe('Error handling', () => {
    it('should propagate error when updateQueueState fails', async () => {
      const item1 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 1' }) });
      const item2 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 2' }) });
      const queue = [item1, item2];

      getQueueStateSpy.mockResolvedValue({
        queue,
        currentClimbQueueItem: item1,
        version: 1,
        sequence: 1,
        stateHash: 'test-hash',
      });
      updateQueueStateSpy.mockRejectedValue(new Error('Update failed'));

      const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);

      await expect(
        controllerMutations.navigateQueue(undefined, { sessionId: TEST_SESSION_ID, direction: 'next' }, controllerCtx),
      ).rejects.toThrow('Update failed');
    });

    it('should not publish event when updateQueueState fails', async () => {
      const item1 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 1' }) });
      const item2 = createMockQueueItem({ climb: createMockClimb({ name: 'Climb 2' }) });
      const queue = [item1, item2];

      getQueueStateSpy.mockResolvedValue({
        queue,
        currentClimbQueueItem: item1,
        version: 1,
        sequence: 1,
        stateHash: 'test-hash',
      });
      updateQueueStateSpy.mockRejectedValue(new Error('Update failed'));

      const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);

      try {
        await controllerMutations.navigateQueue(
          undefined,
          { sessionId: TEST_SESSION_ID, direction: 'next' },
          controllerCtx,
        );
      } catch {
        // Expected to throw
      }

      expect(publishSpy).not.toHaveBeenCalled();
    });

    it('should handle getQueueState failure gracefully', async () => {
      getQueueStateSpy.mockRejectedValue(new Error('Failed to get queue state'));

      const controllerCtx = createControllerContext(registeredController.controllerId, registeredController.apiKey);

      await expect(
        controllerMutations.navigateQueue(undefined, { sessionId: TEST_SESSION_ID, direction: 'next' }, controllerCtx),
      ).rejects.toThrow('Failed to get queue state');
    });
  });

  describe('Authorization', () => {
    it('should require controller authentication', async () => {
      // User context without controller auth
      const userCtx = createMockContext();

      await expect(
        controllerMutations.navigateQueue(undefined, { sessionId: TEST_SESSION_ID, direction: 'next' }, userCtx),
      ).rejects.toThrow('Controller authentication required');
    });

    it('should allow any valid controller to navigate any session', async () => {
      // Create test user for a second controller
      await db.execute(sql`
        INSERT INTO users (id, email, name, created_at, updated_at)
        VALUES ('test-user-2', 'test2@navigate-queue.test', 'Test User 2', now(), now())
        ON CONFLICT (id) DO NOTHING
      `);

      // Register a second controller (no explicit session authorization needed)
      const userCtx = createMockContext({ userId: 'test-user-2' });
      const secondController = await controllerMutations.registerController(
        undefined,
        {
          input: {
            boardName: 'kilter',
            layoutId: 1,
            sizeId: 10,
            setIds: '1,2,3',
            name: 'Second Controller',
          },
        },
        userCtx,
      );

      const item1 = createMockQueueItem();
      const queue = [item1];

      getQueueStateSpy.mockResolvedValue({
        queue,
        currentClimbQueueItem: item1,
        version: 1,
        sequence: 1,
        stateHash: 'test-hash',
      });

      const controllerCtx = createControllerContext(secondController.controllerId, secondController.apiKey);

      // Controller should be able to navigate any session (authorization is just API key)
      const result = await controllerMutations.navigateQueue(
        undefined,
        { sessionId: TEST_SESSION_ID, direction: 'next' },
        controllerCtx,
      );

      // Should succeed - returns the climb at current position
      expect(result).not.toBeNull();
      expect(result!.uuid).toBe(item1.uuid);

      // Cleanup
      await db.execute(sql`DELETE FROM esp32_controllers WHERE user_id = 'test-user-2'`);
    });
  });
});
