import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { db } from '../db/client';
import { esp32Controllers } from '@boardsesh/db/schema/app';
import { eq, sql } from 'drizzle-orm';
import { controllerMutations } from '../graphql/resolvers/controller/mutations';
import { controllerQueries } from '../graphql/resolvers/controller/queries';
import { controllerSubscriptions } from '../graphql/resolvers/controller/subscriptions';
import { pubsub } from '../pubsub';
import type { ConnectionContext, ControllerEvent } from '@boardsesh/shared-schema';

// Test user ID
const TEST_USER_ID = 'test-user-controller-tests';
const TEST_SESSION_ID = 'test-session-controller-tests';

// Helper to create a mock authenticated context
function createMockContext(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: `conn-${Date.now()}`,
    isAuthenticated: true,
    userId: TEST_USER_ID,
    sessionId: undefined,
    ...overrides,
  };
}

// Helper to create a mock controller context (with API key auth)
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

async function nextControllerEvent(
  iterator: AsyncIterator<{ controllerEvents: ControllerEvent }>,
): Promise<{ controllerEvents: ControllerEvent }> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Timed out waiting for controller event')), 2000);
  });

  try {
    const result = await Promise.race([iterator.next(), timeout]);
    if (result.done) {
      throw new Error('Controller event stream ended unexpectedly');
    }
    return result.value;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

describe('Controller Mutations', () => {
  beforeEach(async () => {
    // Create test user if not exists (needed for FK constraint)
    await db.execute(sql`
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES (${TEST_USER_ID}, 'test@controller.test', 'Test User', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
    // Clean up test controllers
    await db.execute(sql`DELETE FROM esp32_controllers WHERE user_id = ${TEST_USER_ID}`);
  });

  afterEach(async () => {
    // Clean up test controllers
    await db.execute(sql`DELETE FROM esp32_controllers WHERE user_id = ${TEST_USER_ID}`);
    vi.restoreAllMocks();
  });

  describe('registerController', () => {
    it('should register a controller with a valid API key', async () => {
      const ctx = createMockContext();

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
        ctx,
      );

      expect(result.controllerId).toBeDefined();
      expect(result.apiKey).toBeDefined();
      expect(result.apiKey).toHaveLength(64); // 32 bytes hex = 64 chars

      // Verify controller was created in database
      const [controller] = await db.select().from(esp32Controllers).where(eq(esp32Controllers.id, result.controllerId));

      expect(controller).toBeDefined();
      expect(controller.userId).toBe(TEST_USER_ID);
      expect(controller.boardName).toBe('kilter');
      expect(controller.name).toBe('Test Controller');
    });

    it('should require authentication', async () => {
      const ctx = createMockContext({ isAuthenticated: false, userId: undefined });

      await expect(
        controllerMutations.registerController(
          undefined,
          {
            input: {
              boardName: 'kilter',
              layoutId: 1,
              sizeId: 10,
              setIds: '1,2,3',
            },
          },
          ctx,
        ),
      ).rejects.toThrow('Authentication required');
    });
  });

  describe('deleteController', () => {
    it('should delete a controller owned by the user', async () => {
      const ctx = createMockContext();

      // First register a controller
      const registered = await controllerMutations.registerController(
        undefined,
        {
          input: {
            boardName: 'kilter',
            layoutId: 1,
            sizeId: 10,
            setIds: '1,2,3',
          },
        },
        ctx,
      );

      // Delete it
      const result = await controllerMutations.deleteController(
        undefined,
        { controllerId: registered.controllerId },
        ctx,
      );

      expect(result).toBe(true);

      // Verify controller was deleted
      const [controller] = await db
        .select()
        .from(esp32Controllers)
        .where(eq(esp32Controllers.id, registered.controllerId));

      expect(controller).toBeUndefined();
    });

    it('should not delete a controller owned by another user', async () => {
      // Create test users for this test
      await db.execute(sql`
        INSERT INTO users (id, email, name, created_at, updated_at)
        VALUES ('user-1', 'user1@test.com', 'User 1', now(), now())
        ON CONFLICT (id) DO NOTHING
      `);
      await db.execute(sql`
        INSERT INTO users (id, email, name, created_at, updated_at)
        VALUES ('user-2', 'user2@test.com', 'User 2', now(), now())
        ON CONFLICT (id) DO NOTHING
      `);

      const ctx1 = createMockContext({ userId: 'user-1' });
      const ctx2 = createMockContext({ userId: 'user-2' });

      // Register as user-1
      const registered = await controllerMutations.registerController(
        undefined,
        {
          input: {
            boardName: 'kilter',
            layoutId: 1,
            sizeId: 10,
            setIds: '1,2,3',
          },
        },
        ctx1,
      );

      // Try to delete as user-2 (should not throw but won't delete)
      await controllerMutations.deleteController(undefined, { controllerId: registered.controllerId }, ctx2);

      // Verify controller still exists
      const [controller] = await db
        .select()
        .from(esp32Controllers)
        .where(eq(esp32Controllers.id, registered.controllerId));

      expect(controller).toBeDefined();

      // Cleanup
      await db.execute(sql`DELETE FROM esp32_controllers WHERE user_id = 'user-1'`);
    });
  });

  describe('authorizeControllerForSession', () => {
    it('should authorize a controller for a session', async () => {
      const ctx = createMockContext();

      // Register a controller
      const registered = await controllerMutations.registerController(
        undefined,
        {
          input: {
            boardName: 'kilter',
            layoutId: 1,
            sizeId: 10,
            setIds: '1,2,3',
          },
        },
        ctx,
      );

      // Authorize for session
      const result = await controllerMutations.authorizeControllerForSession(
        undefined,
        { controllerId: registered.controllerId, sessionId: TEST_SESSION_ID },
        ctx,
      );

      expect(result).toBe(true);

      // Verify authorization
      const [controller] = await db
        .select()
        .from(esp32Controllers)
        .where(eq(esp32Controllers.id, registered.controllerId));

      expect(controller.authorizedSessionId).toBe(TEST_SESSION_ID);
    });

    it('should reject authorization from non-owner', async () => {
      // Create test users for this test
      await db.execute(sql`
        INSERT INTO users (id, email, name, created_at, updated_at)
        VALUES ('user-1', 'user1@test.com', 'User 1', now(), now())
        ON CONFLICT (id) DO NOTHING
      `);
      await db.execute(sql`
        INSERT INTO users (id, email, name, created_at, updated_at)
        VALUES ('user-2', 'user2@test.com', 'User 2', now(), now())
        ON CONFLICT (id) DO NOTHING
      `);

      const ctx1 = createMockContext({ userId: 'user-1' });
      const ctx2 = createMockContext({ userId: 'user-2' });

      // Register as user-1
      const registered = await controllerMutations.registerController(
        undefined,
        {
          input: {
            boardName: 'kilter',
            layoutId: 1,
            sizeId: 10,
            setIds: '1,2,3',
          },
        },
        ctx1,
      );

      // Try to authorize as user-2
      await expect(
        controllerMutations.authorizeControllerForSession(
          undefined,
          { controllerId: registered.controllerId, sessionId: TEST_SESSION_ID },
          ctx2,
        ),
      ).rejects.toThrow('Controller not found or not owned by user');

      // Cleanup
      await db.execute(sql`DELETE FROM esp32_controllers WHERE user_id = 'user-1'`);
    });
  });

  describe('controllerHeartbeat', () => {
    it('should require controller authentication', async () => {
      const ctx = createMockContext(); // No controller auth

      await expect(
        controllerMutations.controllerHeartbeat(undefined, { sessionId: TEST_SESSION_ID }, ctx),
      ).rejects.toThrow('Controller authentication required');
    });

    it('should update lastSeenAt for authenticated controller', async () => {
      const ctx = createMockContext();

      // Register a controller
      const registered = await controllerMutations.registerController(
        undefined,
        {
          input: {
            boardName: 'kilter',
            layoutId: 1,
            sizeId: 10,
            setIds: '1,2,3',
          },
        },
        ctx,
      );

      // Create controller context
      const controllerCtx = createControllerContext(registered.controllerId, registered.apiKey);

      const result = await controllerMutations.controllerHeartbeat(
        undefined,
        { sessionId: TEST_SESSION_ID },
        controllerCtx,
      );

      expect(result).toBe(true);

      // Verify lastSeenAt was updated
      const [controller] = await db
        .select()
        .from(esp32Controllers)
        .where(eq(esp32Controllers.id, registered.controllerId));

      expect(controller.lastSeenAt).toBeDefined();
    });
  });

  describe('setClimbFromLedPositions', () => {
    it('publishes raw frames for an unknown BLE climb so controllers can render a thumbnail', async () => {
      const ctx = createMockContext();
      const registered = await controllerMutations.registerController(
        undefined,
        {
          input: {
            boardName: 'kilter',
            layoutId: 1,
            sizeId: 10,
            setIds: '1,2,3',
          },
        },
        ctx,
      );
      const publishSpy = vi.spyOn(pubsub, 'publishQueueEvent').mockImplementation(() => {});
      const controllerCtx = createControllerContext(registered.controllerId, registered.apiKey, {
        controllerMac: 'AA:BB:CC:DD:EE:FF',
      });
      const frames = 'p999991r42,p999992r43';

      const result = await controllerMutations.setClimbFromLedPositions(
        undefined,
        { sessionId: TEST_SESSION_ID, frames },
        controllerCtx,
      );

      expect(result.matched).toBe(false);
      expect(publishSpy).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        expect.objectContaining({
          __typename: 'CurrentClimbChanged',
          item: null,
          frames,
          clientId: 'AA:BB:CC:DD:EE:FF',
        }),
      );
    });
  });

  describe('controllerEvents subscription', () => {
    it('sends flattened frames for unknown BLE climb thumbnails', async () => {
      const ctx = createMockContext();
      const registered = await controllerMutations.registerController(
        undefined,
        {
          input: {
            boardName: 'kilter',
            layoutId: 1,
            sizeId: 10,
            setIds: '1,2,3',
          },
        },
        ctx,
      );
      const controllerCtx = createControllerContext(registered.controllerId, registered.apiKey);
      const stream = controllerSubscriptions.controllerEvents.subscribe(
        undefined,
        { sessionId: TEST_SESSION_ID },
        controllerCtx,
      );
      const iterator = stream[Symbol.asyncIterator]();

      try {
        await nextControllerEvent(iterator);
        await nextControllerEvent(iterator);

        pubsub.publishQueueEvent(TEST_SESSION_ID, {
          __typename: 'CurrentClimbChanged',
          sequence: 1,
          stateHash: 'test-state-hash',
          item: null,
          frames: 'p1r12,p2r13',
          clientId: 'AA:BB:CC:DD:EE:FF',
          correlationId: null,
        });

        const update = await nextControllerEvent(iterator);
        expect(update.controllerEvents.__typename).toBe('LedUpdate');
        if (update.controllerEvents.__typename === 'LedUpdate') {
          expect(update.controllerEvents.frames).toBe('p1r42p2r43');
          expect(update.controllerEvents.climbName).toBe('Unknown Climb');
          expect(update.controllerEvents.clientId).toBe('AA:BB:CC:DD:EE:FF');
        }
      } finally {
        await iterator.return?.(undefined);
      }
    });
  });
});

describe('Controller Queries', () => {
  beforeEach(async () => {
    // Create test user if not exists (needed for FK constraint)
    await db.execute(sql`
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES (${TEST_USER_ID}, 'test@controller.test', 'Test User', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
    // Clean up test controllers
    await db.execute(sql`DELETE FROM esp32_controllers WHERE user_id = ${TEST_USER_ID}`);
  });

  afterEach(async () => {
    // Clean up test controllers
    await db.execute(sql`DELETE FROM esp32_controllers WHERE user_id = ${TEST_USER_ID}`);
  });

  describe('myControllers', () => {
    it('should return empty array for user with no controllers', async () => {
      const ctx = createMockContext();

      const result = await controllerQueries.myControllers(undefined, undefined, ctx);

      expect(result).toEqual([]);
    });

    it('should return user controllers', async () => {
      const ctx = createMockContext();

      // Register two controllers
      await controllerMutations.registerController(
        undefined,
        {
          input: {
            boardName: 'kilter',
            layoutId: 1,
            sizeId: 10,
            setIds: '1,2,3',
            name: 'Controller 1',
          },
        },
        ctx,
      );

      await controllerMutations.registerController(
        undefined,
        {
          input: {
            boardName: 'tension',
            layoutId: 2,
            sizeId: 12,
            setIds: '4,5,6',
            name: 'Controller 2',
          },
        },
        ctx,
      );

      const result = await controllerQueries.myControllers(undefined, undefined, ctx);

      expect(result).toHaveLength(2);
      expect(
        result
          .map((controller) => controller.name ?? '')
          .sort((leftName, rightName) => leftName.localeCompare(rightName)),
      ).toEqual(['Controller 1', 'Controller 2']);
    });

    it('should require authentication', async () => {
      const ctx = createMockContext({ isAuthenticated: false, userId: undefined });

      await expect(controllerQueries.myControllers(undefined, undefined, ctx)).rejects.toThrow(
        'Authentication required',
      );
    });

    it('should show controller online status correctly', async () => {
      const ctx = createMockContext();

      // Register a controller
      const registered = await controllerMutations.registerController(
        undefined,
        {
          input: {
            boardName: 'kilter',
            layoutId: 1,
            sizeId: 10,
            setIds: '1,2,3',
          },
        },
        ctx,
      );

      // Initially not online (never seen)
      let result = await controllerQueries.myControllers(undefined, undefined, ctx);
      expect(result[0].isOnline).toBe(false);

      // Update lastSeenAt to now
      await db
        .update(esp32Controllers)
        .set({ lastSeenAt: new Date() })
        .where(eq(esp32Controllers.id, registered.controllerId));

      // Should now be online
      result = await controllerQueries.myControllers(undefined, undefined, ctx);
      expect(result[0].isOnline).toBe(true);

      // Update lastSeenAt to 2 minutes ago
      const twoMinutesAgo = new Date(Date.now() - 120000);
      await db
        .update(esp32Controllers)
        .set({ lastSeenAt: twoMinutesAgo })
        .where(eq(esp32Controllers.id, registered.controllerId));

      // Should be offline
      result = await controllerQueries.myControllers(undefined, undefined, ctx);
      expect(result[0].isOnline).toBe(false);
    });
  });
});
