import { once } from 'node:events';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vite-plus/test';
import { type Client, createClient } from 'graphql-ws';
// eslint-disable-next-line import/no-named-as-default -- `ws` exports both default and named `WebSocket`; default is the correct one for graphql-ws.
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { startServer } from '../server';
import { db } from '../db/client';
import { boardClimbs } from '@boardsesh/db/schema';
import type { ClimbQueueItem } from '@boardsesh/shared-schema';

type JoinSessionResult = {
  id: string;
  boardPath: string;
  isLeader: boolean;
  clientId: string;
  users: Array<{ id: string; username: string; isLeader: boolean }>;
  queueState: { queue: Array<{ uuid: string }>; currentClimbQueueItem: { uuid: string } | null };
};

type AddQueueItemResult = {
  uuid: string;
  climb: { name: string };
};

type SetCurrentClimbResult = {
  uuid: string;
  climb: { name: string; mirrored: boolean };
};

type MirrorCurrentClimbResult = {
  uuid: string;
  climb: { mirrored: boolean };
};

type SessionQueryResult = {
  queueState: { queue: Array<{ uuid: string }>; currentClimbQueueItem: { uuid: string } | null };
  users: Array<{ id: string; connectionState?: string }>;
};

type QueueEvent =
  | {
      __typename: 'FullSync';
      state: { queue: Array<{ uuid: string }>; currentClimbQueueItem?: { uuid: string } | null };
    }
  | { __typename: 'QueueItemAdded'; item: { uuid: string; climb?: { name: string } } }
  | { __typename: 'QueueItemRemoved'; uuid: string }
  | { __typename: 'QueueReordered'; uuid: string; oldIndex: number; newIndex: number }
  | { __typename: 'CurrentClimbChanged'; item: { uuid: string; climb?: { name: string } } | null }
  | { __typename: 'ClimbMirrored'; mirrored: boolean };

type SessionEvent =
  | { __typename: 'UserJoined'; user: { id: string; username: string } }
  | { __typename: 'UserPresenceChanged'; user: { id: string; username?: string; connectionState: string } }
  | { __typename: 'UserLeft'; userId: string }
  | { __typename: 'LeaderChanged'; leaderId: string; leaderConnectionId?: string | null }
  | { __typename: 'SessionEnded'; reason: string };

// Test fixtures
const TEST_BOARD_PATH = '/kilter/1/2/3/40';
let testPort = 0;

// Helper to generate unique session IDs for each test
let testCounter = 0;
const createTestSessionId = () => `test-session-${Date.now()}-${testCounter++}`;

// Pre-generate stable UUIDs for test climbs (keyed by label for test assertions)
const testClimbUuids = new Map<string, string>();
function getTestClimbUuid(label: string): string {
  if (!testClimbUuids.has(label)) {
    testClimbUuids.set(label, uuidv4());
  }
  return testClimbUuids.get(label)!;
}

const createTestClimb = (label: string): ClimbQueueItem => ({
  uuid: getTestClimbUuid(label),
  climb: {
    uuid: `climb-${label}`,
    setter_username: 'test-setter',
    name: `Test Climb ${label}`,
    description: 'A test climb',
    frames: 'test-frames',
    angle: 40,
    ascensionist_count: 10,
    difficulty: 'V5',
    quality_average: '4.5',
    stars: 4.5,
    difficulty_error: '0.5',
    mirrored: false,
    benchmark_difficulty: 'V5',
  },
  addedBy: 'test-user',
  tickedBy: [],
  suggested: false,
});

// Helper to execute GraphQL operations (mutations and queries)
async function execute<T>(
  client: Client,
  operation: { query: string; variables?: Record<string, unknown> },
): Promise<T> {
  return new Promise((resolve, reject) => {
    let result: T;
    client.subscribe<T>(operation, {
      next: (data) => {
        if (data.errors) {
          console.error('GraphQL errors:', JSON.stringify(data.errors, null, 2));
          reject(new Error(data.errors[0].message));
          return;
        }
        result = data.data as T;
      },
      error: (err) => {
        console.error('Subscription error:', err);
        reject(err);
      },
      complete: () => resolve(result),
    });
  });
}

// Asserts the event has the expected __typename and narrows for follow-up access.
function expectTypename<T extends { __typename: string }, K extends T['__typename']>(
  event: T,
  typename: K,
): asserts event is Extract<T, { __typename: K }> {
  expect(event.__typename).toBe(typename);
}

// Helper to wait for a specific event from a subscription
function waitForEvent<T>(
  client: Client,
  query: string,
  predicate: (event: T) => boolean,
  timeout = 5000,
): Promise<T> & { ready: Promise<void> } {
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const pending = new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Timeout waiting for event (${timeout}ms)`));
    }, timeout);

    const unsubscribe = client.subscribe(
      { query },
      {
        next: (data) => {
          const d = data.data as Record<string, T> | null | undefined;
          const event = d?.queueUpdates || d?.sessionUpdates;
          if (event) markReady();
          if (event && predicate(event)) {
            clearTimeout(timeoutId);
            unsubscribe();
            resolve(event);
          }
        },
        error: (err) => {
          clearTimeout(timeoutId);
          reject(err);
        },
        complete: () => {},
      },
    );
  });
  return Object.assign(pending, { ready });
}

// Helper to collect multiple events from a subscription
function collectEvents<T>(client: Client, query: string, count: number, timeout = 5000): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const events: T[] = [];
    const timeoutId = setTimeout(() => {
      reject(new Error(`Timeout collecting events: got ${events.length}/${count}`));
    }, timeout);

    const unsubscribe = client.subscribe(
      { query },
      {
        next: (data) => {
          const d = data.data as Record<string, T> | null | undefined;
          const event = d?.queueUpdates || d?.sessionUpdates;
          if (event && (event as { __typename?: string }).__typename !== 'SessionRosterSnapshot') {
            events.push(event);
            if (events.length >= count) {
              clearTimeout(timeoutId);
              unsubscribe();
              resolve(events);
            }
          }
        },
        error: (err) => {
          clearTimeout(timeoutId);
          reject(err);
        },
        complete: () => {},
      },
    );
  });
}

describe('Daemon Integration Tests', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  const activeClients: Client[] = [];

  const createTestClient = () => {
    const client = createClient({
      url: `ws://localhost:${testPort}/graphql`,
      webSocketImpl: WebSocket,
      lazy: false,
      retryAttempts: 0,
    });
    activeClients.push(client);
    return client;
  };

  beforeAll(async () => {
    // Queue payloads refer to real public catalogue entries; missing/deleted
    // content is intentionally redacted by the GraphQL privacy projector.
    await db.insert(boardClimbs).values(
      [
        'test-climb-1',
        'current-test',
        'mirror-test',
        'to-remove',
        'item-0',
        'item-1',
        'item-2',
        'sync-test',
        'current-sync',
        'reorder-0',
        'reorder-1',
        'cleanup-test',
        'persist-test',
      ].map((label) => ({
        uuid: `climb-${label}`,
        boardType: 'kilter',
        layoutId: 1,
        name: `Test Climb ${label}`,
        frames: 'test-frames',
        angle: 40,
        isListed: true,
        isDraft: false,
      })),
    );
    process.env.PORT = '0';
    server = await startServer();
    if (!server.httpServer.listening) await once(server.httpServer, 'listening');
    const address = server.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server address');
    testPort = address.port;
    // Wait for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  afterAll(async () => {
    server.wss.close();
    server.httpServer.close();
  });

  afterEach(async () => {
    // Dispose all clients created during the test
    await Promise.all(activeClients.map((client) => client.dispose()));
    activeClients.length = 0;
    // Clear per-test UUID cache
    testClimbUuids.clear();
  });

  describe('Session Management', () => {
    it('should allow a client to join a session and receive initial state', async () => {
      const sessionId = createTestSessionId();
      const client = createTestClient();

      const result = await execute<{ joinSession: JoinSessionResult }>(client, {
        query: `
          mutation JoinSession($sessionId: ID!, $boardPath: String!, $username: String) {
            joinSession(sessionId: $sessionId, boardPath: $boardPath, username: $username) {
              id
              boardPath
              isLeader
              clientId
              users { id username isLeader }
              queueState { queue { uuid } currentClimbQueueItem { uuid } }
            }
          }
        `,
        variables: {
          sessionId,
          boardPath: TEST_BOARD_PATH,
          username: 'TestUser1',
        },
      });

      expect(result.joinSession.id).toBe(sessionId);
      expect(result.joinSession.boardPath).toBe(TEST_BOARD_PATH);
      expect(result.joinSession.isLeader).toBe(true);
      expect(result.joinSession.users).toHaveLength(1);
      expect(result.joinSession.users[0].username).toBe('TestUser1');
      expect(result.joinSession.queueState.queue).toEqual([]);
    });

    it('should assign first client as leader', async () => {
      const sessionId = createTestSessionId();
      const client = createTestClient();

      const result = await execute<{ joinSession: JoinSessionResult }>(client, {
        query: `
          mutation {
            joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}", username: "Leader") {
              isLeader
            }
          }
        `,
      });

      expect(result.joinSession.isLeader).toBe(true);
    });

    it('should assign second client as non-leader', async () => {
      const sessionId = createTestSessionId();
      const client1 = createTestClient();
      const client2 = createTestClient();

      // First client joins
      const result1 = await execute<{ joinSession: JoinSessionResult }>(client1, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}", username: "Leader") { isLeader clientId } }`,
      });

      // Second client joins
      const result2 = await execute<{ joinSession: JoinSessionResult }>(client2, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}", username: "Follower") { isLeader clientId users { id isLeader } } }`,
      });

      expect(result1.joinSession.isLeader).toBe(true);
      expect(result2.joinSession.isLeader).toBe(false);
      expect(result2.joinSession.users).toHaveLength(2);

      // Verify one user is leader
      const leader = result2.joinSession.users.find((u) => u.isLeader);
      expect(leader).toBeDefined();
      expect(leader!.id).toBe(result1.joinSession.clientId);
    });
  });

  describe('Queue Subscriptions', () => {
    it('should receive FullSync when subscribing to queueUpdates', async () => {
      const sessionId = createTestSessionId();
      const client = createTestClient();

      // Join session first
      await execute(client, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}") { id } }`,
      });

      // Subscribe and wait for initial FullSync
      const event = await waitForEvent<QueueEvent | SessionEvent>(
        client,
        `subscription { queueUpdates(sessionId: "${sessionId}") { __typename ... on FullSync { state { queue { uuid } } } } }`,
        (e) => e.__typename === 'FullSync',
      );

      expectTypename(event, 'FullSync');
      expect(event.state.queue).toEqual([]);
    });
  });

  describe('Queue Operations', () => {
    it('should add a queue item successfully', async () => {
      const sessionId = createTestSessionId();
      const client = createTestClient();

      // Join session
      await execute(client, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}") { id } }`,
      });

      // Add a queue item
      const testClimb = createTestClimb('test-climb-1');
      const result = await execute<{ addQueueItem: AddQueueItemResult }>(client, {
        query: `
          mutation AddQueueItem($item: ClimbQueueItemInput!) {
            addQueueItem(item: $item) { uuid climb { name } }
          }
        `,
        variables: { item: testClimb },
      });

      expect(result.addQueueItem.uuid).toBe(getTestClimbUuid('test-climb-1'));
      expect(result.addQueueItem.climb.name).toBe('Test Climb test-climb-1');
    });

    it('should set current climb successfully', async () => {
      const sessionId = createTestSessionId();
      const client = createTestClient();

      // Join session
      await execute(client, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}") { id } }`,
      });

      // Set current climb
      const testClimb = createTestClimb('current-test');
      const result = await execute<{ setCurrentClimb: SetCurrentClimbResult }>(client, {
        query: `
          mutation SetCurrentClimb($item: ClimbQueueItemInput) {
            setCurrentClimb(item: $item, shouldAddToQueue: true) { uuid climb { name } }
          }
        `,
        variables: { item: testClimb },
      });

      expect(result.setCurrentClimb.uuid).toBe(getTestClimbUuid('current-test'));
    });

    it('should mirror current climb successfully', async () => {
      const sessionId = createTestSessionId();
      const client = createTestClient();

      // Join session
      await execute(client, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}") { id } }`,
      });

      // Set a current climb first
      const testClimb = createTestClimb('mirror-test');
      await execute(client, {
        query: `mutation SetCurrentClimb($item: ClimbQueueItemInput) { setCurrentClimb(item: $item) { uuid } }`,
        variables: { item: testClimb },
      });

      // Mirror the climb
      const result = await execute<{ mirrorCurrentClimb: MirrorCurrentClimbResult }>(client, {
        query: `mutation { mirrorCurrentClimb(mirrored: true) { uuid climb { mirrored } } }`,
      });

      expect(result.mirrorCurrentClimb.climb.mirrored).toBe(true);
    });

    it('should remove a queue item', async () => {
      const sessionId = createTestSessionId();
      const client = createTestClient();

      // Join session
      await execute(client, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}") { id } }`,
      });

      // Add an item first
      const testClimb = createTestClimb('to-remove');
      await execute(client, {
        query: `mutation AddQueueItem($item: ClimbQueueItemInput!) { addQueueItem(item: $item) { uuid } }`,
        variables: { item: testClimb },
      });

      // Remove the item
      const result = await execute<{ removeQueueItem: boolean }>(client, {
        query: `mutation { removeQueueItem(uuid: "${getTestClimbUuid('to-remove')}") }`,
      });

      expect(result.removeQueueItem).toBe(true);
    });

    it('should reorder queue items', async () => {
      const sessionId = createTestSessionId();
      const client = createTestClient();

      // Join session
      await execute(client, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}") { id } }`,
      });

      // Add multiple items
      await execute(client, {
        query: `mutation AddQueueItem($item: ClimbQueueItemInput!) { addQueueItem(item: $item) { uuid } }`,
        variables: { item: createTestClimb('item-0') },
      });
      await execute(client, {
        query: `mutation AddQueueItem($item: ClimbQueueItemInput!) { addQueueItem(item: $item) { uuid } }`,
        variables: { item: createTestClimb('item-1') },
      });
      await execute(client, {
        query: `mutation AddQueueItem($item: ClimbQueueItemInput!) { addQueueItem(item: $item) { uuid } }`,
        variables: { item: createTestClimb('item-2') },
      });

      // Reorder: move item-2 from index 2 to index 0
      const result = await execute<{ reorderQueueItem: boolean }>(client, {
        query: `mutation { reorderQueueItem(uuid: "${getTestClimbUuid('item-2')}", oldIndex: 2, newIndex: 0) }`,
      });

      expect(result.reorderQueueItem).toBe(true);

      // Verify the order by querying the session
      const sessionResult = await execute<{ session: SessionQueryResult }>(client, {
        query: `query { session(sessionId: "${sessionId}") { queueState { queue { uuid } } } }`,
      });

      expect(sessionResult.session.queueState.queue[0].uuid).toBe(getTestClimbUuid('item-2'));
      expect(sessionResult.session.queueState.queue[1].uuid).toBe(getTestClimbUuid('item-0'));
      expect(sessionResult.session.queueState.queue[2].uuid).toBe(getTestClimbUuid('item-1'));
    });
  });

  describe('Multi-Client Sync', () => {
    it('should sync queue additions across clients', async () => {
      const sessionId = createTestSessionId();
      const client1 = createTestClient();
      const client2 = createTestClient();

      // Both clients join session
      await execute(client1, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}", username: "Client1") { id } }`,
      });
      await execute(client2, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}", username: "Client2") { id } }`,
      });

      // Client 2 subscribes to queue updates
      const eventPromise = collectEvents<QueueEvent>(
        client2,
        `subscription { queueUpdates(sessionId: "${sessionId}") { __typename ... on FullSync { state { queue { uuid } } } ... on QueueItemAdded { item { uuid climb { name } } } } }`,
        2, // FullSync + QueueItemAdded
      );

      // Wait for subscription to be established
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Client 1 adds an item
      await execute(client1, {
        query: `mutation AddQueueItem($item: ClimbQueueItemInput!) { addQueueItem(item: $item) { uuid } }`,
        variables: { item: createTestClimb('sync-test') },
      });

      const events = await eventPromise;

      // First event should be FullSync, second should be QueueItemAdded
      expect(events[0]).toBeDefined();
      const second = events[1];
      expect(second).toBeDefined();
      expectTypename(events[0]!, 'FullSync');
      expectTypename(second!, 'QueueItemAdded');
      expect(second!.item.uuid).toBe(getTestClimbUuid('sync-test'));
    });

    it('should sync current climb changes across clients', async () => {
      const sessionId = createTestSessionId();
      const client1 = createTestClient();
      const client2 = createTestClient();

      // Both clients join session
      await execute(client1, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}") { id } }`,
      });
      await execute(client2, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}") { id } }`,
      });

      // Client 2 subscribes to queue updates
      const eventPromise = collectEvents<QueueEvent>(
        client2,
        `subscription { queueUpdates(sessionId: "${sessionId}") { __typename ... on FullSync { state { currentClimbQueueItem { uuid } } } ... on CurrentClimbChanged { item { uuid } } } }`,
        2, // FullSync + CurrentClimbChanged
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Client 1 sets current climb
      await execute(client1, {
        query: `mutation SetCurrentClimb($item: ClimbQueueItemInput) { setCurrentClimb(item: $item) { uuid } }`,
        variables: { item: createTestClimb('current-sync') },
      });

      const events = await eventPromise;

      const second = events[1];
      expect(second).toBeDefined();
      expectTypename(second!, 'CurrentClimbChanged');
      expect(second!.item?.uuid).toBe(getTestClimbUuid('current-sync'));
    });

    it('should sync queue reordering across clients', async () => {
      const sessionId = createTestSessionId();
      const client1 = createTestClient();
      const client2 = createTestClient();

      // Both clients join session
      await execute(client1, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}") { id } }`,
      });
      await execute(client2, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}") { id } }`,
      });

      // Client 1 adds items
      await execute(client1, {
        query: `mutation AddQueueItem($item: ClimbQueueItemInput!) { addQueueItem(item: $item) { uuid } }`,
        variables: { item: createTestClimb('reorder-0') },
      });
      await execute(client1, {
        query: `mutation AddQueueItem($item: ClimbQueueItemInput!) { addQueueItem(item: $item) { uuid } }`,
        variables: { item: createTestClimb('reorder-1') },
      });

      // Client 2 subscribes
      const eventPromise = waitForEvent<QueueEvent | SessionEvent>(
        client2,
        `subscription { queueUpdates(sessionId: "${sessionId}") { __typename ... on FullSync { state { queue { uuid } } } ... on QueueReordered { uuid oldIndex newIndex } } }`,
        (e) => e.__typename === 'QueueReordered',
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Client 1 reorders
      await execute(client1, {
        query: `mutation { reorderQueueItem(uuid: "${getTestClimbUuid('reorder-1')}", oldIndex: 1, newIndex: 0) }`,
      });

      const event = await eventPromise;

      expectTypename(event, 'QueueReordered');
      expect(event.uuid).toBe(getTestClimbUuid('reorder-1'));
      expect(event.oldIndex).toBe(1);
      expect(event.newIndex).toBe(0);
    });
  });

  describe('Leader Election', () => {
    it('should elect new leader when current leader disconnects', async () => {
      const sessionId = createTestSessionId();
      const client1 = createTestClient();
      const client2 = createTestClient();

      // Client 1 joins first (becomes leader)
      const result1 = await execute<{ joinSession: JoinSessionResult }>(client1, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}", username: "Leader") { isLeader clientId } }`,
      });
      expect(result1.joinSession.isLeader).toBe(true);

      // Client 2 joins second (not leader)
      const result2 = await execute<{ joinSession: JoinSessionResult }>(client2, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}", username: "Follower") { isLeader clientId } }`,
      });
      expect(result2.joinSession.isLeader).toBe(false);

      // Client 2 subscribes to session updates
      const eventPromise = waitForEvent<QueueEvent | SessionEvent>(
        client2,
        `subscription { sessionUpdates(sessionId: "${sessionId}") { __typename ... on LeaderChanged { leaderId leaderConnectionId } ... on UserPresenceChanged { user { id connectionState } } } }`,
        (e) => e.__typename === 'LeaderChanged',
      );

      await eventPromise.ready;

      // Client 1 disconnects
      await client1.dispose();
      // Remove from activeClients so afterEach doesn't try to dispose again
      const idx = activeClients.indexOf(client1);
      if (idx > -1) activeClients.splice(idx, 1);

      const event = await eventPromise;

      expectTypename(event, 'LeaderChanged');
      expect(event.leaderId).toBe(result2.joinSession.clientId);
      expect(event.leaderConnectionId).toBe(result2.joinSession.clientId);
    });

    it('should maintain leader when non-leader disconnects', async () => {
      const sessionId = createTestSessionId();
      const client1 = createTestClient();
      const client2 = createTestClient();

      // Client 1 joins first (becomes leader)
      const result1 = await execute<{ joinSession: JoinSessionResult }>(client1, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}", username: "Leader") { isLeader clientId } }`,
      });
      expect(result1.joinSession.isLeader).toBe(true);

      // Client 2 joins second (not leader)
      const result2 = await execute<{ joinSession: JoinSessionResult }>(client2, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}", username: "Follower") { isLeader clientId } }`,
      });

      // Client 1 subscribes to session updates to detect the passive disconnect.
      const eventPromise = waitForEvent<QueueEvent | SessionEvent>(
        client1,
        `subscription { sessionUpdates(sessionId: "${sessionId}") { __typename ... on UserLeft { userId } ... on LeaderChanged { leaderId leaderConnectionId } } }`,
        (e) => e.__typename === 'UserLeft',
      );

      await eventPromise.ready;

      // Client 2 disconnects
      await client2.dispose();
      const idx = activeClients.indexOf(client2);
      if (idx > -1) activeClients.splice(idx, 1);

      const event = await eventPromise;

      // The anonymous follower is removed outright (UserLeft), not parked as
      // RECONNECTING; leadership stays with client1 (no LeaderChanged for a
      // non-leader departure).
      expectTypename(event, 'UserLeft');
      expect(event.userId).toBe(result2.joinSession.clientId);
    });
  });

  describe('Session Events', () => {
    it('should emit UserJoined when client joins', async () => {
      const sessionId = createTestSessionId();
      const client1 = createTestClient();
      const client2 = createTestClient();

      // Client 1 joins and subscribes
      await execute(client1, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}", username: "First") { id } }`,
      });

      const eventPromise = waitForEvent<QueueEvent | SessionEvent>(
        client1,
        `subscription { sessionUpdates(sessionId: "${sessionId}") { __typename ... on UserJoined { user { id username } } } }`,
        (e) => e.__typename === 'UserJoined',
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Client 2 joins
      await execute(client2, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}", username: "Second") { id } }`,
      });

      const event = await eventPromise;

      expectTypename(event, 'UserJoined');
      expect(event.user.username).toBe('Second');
    });

    it('should emit UserLeft when an anonymous client passively disconnects', async () => {
      const sessionId = createTestSessionId();
      const client1 = createTestClient();
      const client2 = createTestClient();

      // Both clients join
      await execute(client1, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}", username: "First") { id } }`,
      });
      const result2 = await execute<{ joinSession: JoinSessionResult }>(client2, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}", username: "Second") { clientId } }`,
      });

      // Client 1 subscribes to session updates
      const eventPromise = waitForEvent<QueueEvent | SessionEvent>(
        client1,
        `subscription { sessionUpdates(sessionId: "${sessionId}") { __typename ... on UserLeft { userId } } }`,
        (e) => e.__typename === 'UserLeft',
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Client 2 disconnects. An anonymous connection can't be resumed on
      // reconnect, so the server removes it immediately (UserLeft) rather than
      // parking it as RECONNECTING.
      await client2.dispose();
      const idx = activeClients.indexOf(client2);
      if (idx > -1) activeClients.splice(idx, 1);

      const event = await eventPromise;

      expectTypename(event, 'UserLeft');
      expect(event.userId).toBe(result2.joinSession.clientId);
    });

    it('should emit LeaderChanged when leader leaves', async () => {
      const sessionId = createTestSessionId();
      const client1 = createTestClient();
      const client2 = createTestClient();

      // Client 1 joins first (becomes leader)
      const result1 = await execute<{ joinSession: JoinSessionResult }>(client1, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}", username: "Leader") { clientId } }`,
      });

      // Client 2 joins second
      const result2 = await execute<{ joinSession: JoinSessionResult }>(client2, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}", username: "Follower") { clientId } }`,
      });

      // Client 2 subscribes to session updates
      const eventPromise = collectEvents<SessionEvent>(
        client2,
        `subscription { sessionUpdates(sessionId: "${sessionId}") { __typename ... on UserLeft { userId } ... on LeaderChanged { leaderId leaderConnectionId } } }`,
        2, // UserLeft + LeaderChanged
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Client 1 disconnects (leader leaves)
      await client1.dispose();
      const idx = activeClients.indexOf(client1);
      if (idx > -1) activeClients.splice(idx, 1);

      const events = await eventPromise;

      // The anonymous leader is removed outright (UserLeft) and leadership hands
      // off to client2 (LeaderChanged) — no RECONNECTING park in between.
      const userLeftEvent = events.find((e) => e.__typename === 'UserLeft');
      const leaderChangedEvent = events.find((e) => e.__typename === 'LeaderChanged');

      expect(userLeftEvent).toBeDefined();
      expect(leaderChangedEvent).toBeDefined();
      expectTypename(userLeftEvent!, 'UserLeft');
      expectTypename(leaderChangedEvent!, 'LeaderChanged');
      expect(userLeftEvent.userId).toBe(result1.joinSession.clientId);
      expect(leaderChangedEvent.leaderId).toBe(result2.joinSession.clientId);
      expect(leaderChangedEvent.leaderConnectionId).toBe(result2.joinSession.clientId);
    });
  });

  describe('Disconnect Handling', () => {
    it('should preserve recoverable session state when all clients passively disconnect', async () => {
      const sessionId = createTestSessionId();
      const client1 = createTestClient();

      // Join and add some state
      await execute(client1, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}") { id } }`,
      });
      await execute(client1, {
        query: `mutation AddQueueItem($item: ClimbQueueItemInput!) { addQueueItem(item: $item) { uuid } }`,
        variables: { item: createTestClimb('cleanup-test') },
      });

      // Disconnect
      await client1.dispose();
      const idx = activeClients.indexOf(client1);
      if (idx > -1) activeClients.splice(idx, 1);

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 200));

      // New client joins the same session. The anonymous first client was
      // removed on disconnect (no RECONNECTING ghost), so only the new client is
      // in the roster — but the queue state is still recoverable from Redis.
      const client2 = createTestClient();
      const result = await execute<{ joinSession: JoinSessionResult }>(client2, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}") { isLeader users { id } queueState { queue { uuid } } } }`,
      });

      // New client should be leader, and the queue should remain recoverable.
      expect(result.joinSession.isLeader).toBe(true);
      expect(result.joinSession.queueState.queue).toHaveLength(1);
      expect(result.joinSession.users).toHaveLength(1);
    });

    it('should continue session when one of multiple clients disconnects', async () => {
      const sessionId = createTestSessionId();
      const client1 = createTestClient();
      const client2 = createTestClient();

      // Both clients join
      await execute(client1, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}", username: "User1") { id } }`,
      });
      await execute(client2, {
        query: `mutation { joinSession(sessionId: "${sessionId}", boardPath: "${TEST_BOARD_PATH}", username: "User2") { id } }`,
      });

      // Add queue item
      await execute(client1, {
        query: `mutation AddQueueItem($item: ClimbQueueItemInput!) { addQueueItem(item: $item) { uuid } }`,
        variables: { item: createTestClimb('persist-test') },
      });

      // Client 1 disconnects
      await client1.dispose();
      const idx = activeClients.indexOf(client1);
      if (idx > -1) activeClients.splice(idx, 1);

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Client 2 should still see the queue item (query session state)
      const result = await execute<{ session: SessionQueryResult }>(client2, {
        query: `query { session(sessionId: "${sessionId}") { queueState { queue { uuid } } users { id connectionState } } }`,
      });

      expect(result.session.queueState.queue).toHaveLength(1);
      expect(result.session.queueState.queue[0].uuid).toBe(getTestClimbUuid('persist-test'));
      // The anonymous client1 was removed on disconnect; only the still-connected
      // client2 remains in the roster.
      expect(result.session.users).toHaveLength(1);
      expect(result.session.users[0].connectionState).toBe('CONNECTED');
    });
  });

  describe('HTTP path handling', () => {
    it('returns 400 for /static/beta-link-thumbnails/ with no platform segment', async () => {
      const res = await fetch(`http://localhost:${testPort}/static/beta-link-thumbnails/`);
      expect(res.status).toBe(400);
    });

    it('returns 400 for /static/beta-link-thumbnails/<platform> with no filename', async () => {
      const res = await fetch(`http://localhost:${testPort}/static/beta-link-thumbnails/instagram`);
      expect(res.status).toBe(400);
    });

    it('returns 400 for /static/beta-link-thumbnails/ with empty platform segment', async () => {
      const res = await fetch(`http://localhost:${testPort}/static/beta-link-thumbnails//filename.jpg`);
      expect(res.status).toBe(400);
    });
  });
});
