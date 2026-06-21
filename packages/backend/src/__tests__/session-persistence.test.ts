import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { GraphQLError } from 'graphql';
import { v4 as uuidv4 } from 'uuid';
import { roomManager } from '../services/room-manager';
import { db } from '../db/client';
import { sessions, sessionQueues, boardSessionParticipants } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import { createMockRedis, type MockRedis } from './helpers/mock-redis';

const createTestClimb = (): ClimbQueueItem => ({
  uuid: uuidv4(),
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

// Helper function to register a client before joining.
// Pass `userId` to simulate an authenticated user — that's the only path that
// produces a stable participantId across reconnects (anonymous reconnects
// intentionally yield a fresh participantId, per the join-side security fix).
const registerAndJoinSession = async (
  clientId: string,
  sessionId: string,
  boardPath: string,
  username?: string,
  userId?: string,
) => {
  await roomManager.registerClient(clientId, username, userId);
  return roomManager.joinSession(clientId, sessionId, boardPath, username);
};

describe('Session Persistence - Hybrid Redis + Postgres', () => {
  let mockRedis: MockRedis;

  beforeEach(async () => {
    // Create fresh mock Redis for each test
    mockRedis = createMockRedis();

    // Reset room manager and initialize with mock Redis
    roomManager.reset();
    await roomManager.initialize(mockRedis);
  });

  afterEach(() => {
    roomManager.reset();
    vi.clearAllTimers();
  });

  describe('Session Lifecycle Transitions', () => {
    it('should keep a durable session row without marking it inactive on last leave', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Create and join session
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

      // Verify active status
      let session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      expect(session[0]?.status).toBe('active');

      // Leave session
      await roomManager.leaveSession('client-1');

      // Verify durable state remains not-ended
      session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      expect(session[0]?.status).toBe('active');
      expect(session[0]?.endedAt).toBeNull();

      // Verify session not deleted from Postgres
      expect(session.length).toBe(1);
    });

    it('should allow rejoining without changing the durable lifecycle status', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Create session, join, and leave
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');
      await roomManager.leaveSession('client-1');

      // Verify durable state remains active until explicit end
      let session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      expect(session[0]?.status).toBe('active');

      // Rejoin
      await registerAndJoinSession('client-2', sessionId, boardPath, 'User2');

      // Verify durable state is unchanged
      session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      expect(session[0]?.status).toBe('active');
    });

    it('should transition to ended when endSession is called', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Create session
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

      // End session
      await roomManager.endSession(sessionId);

      // Verify ended status
      const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      expect(session[0]?.status).toBe('ended');

      // Verify removed from Redis (deleteSession uses multi.del)
      expect(mockRedis.del).toHaveBeenCalledWith(`boardsesh:session:${sessionId}`); // eslint-disable-line @typescript-eslint/unbound-method -- vi.fn() mock, no `this` concern
    });
  });

  describe('Lazy Restoration from Redis', () => {
    it('should restore a Redis-backed session when user rejoins', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';
      const climb = createTestClimb();

      // Create session and add climb to queue
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');
      const currentState = await roomManager.getQueueState(sessionId);
      await roomManager.updateQueueState(sessionId, [climb], null, currentState.version);

      // Leave session (makes it inactive but keeps in Redis)
      await roomManager.leaveSession('client-1');

      // Clear in-memory state to simulate server restart
      roomManager.reset();
      await roomManager.initialize(mockRedis);

      // Rejoin should restore from Redis
      const result = await registerAndJoinSession('client-2', sessionId, boardPath, 'User2');

      // Verify queue was restored from Redis
      expect(result.queue).toHaveLength(1);
      expect(result.queue[0]?.uuid).toBe(climb.uuid);
    });

    it('should handle multiple users joining a Redis-backed session concurrently', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Create session and make it inactive
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');
      await roomManager.leaveSession('client-1');

      // Clear in-memory state
      roomManager.reset();
      await roomManager.initialize(mockRedis);

      // Register clients before joining
      await Promise.all([
        roomManager.registerClient('client-2'),
        roomManager.registerClient('client-3'),
        roomManager.registerClient('client-4'),
      ]);

      // Multiple users join concurrently
      const results = await Promise.all([
        roomManager.joinSession('client-2', sessionId, boardPath, 'User2'),
        roomManager.joinSession('client-3', sessionId, boardPath, 'User3'),
        roomManager.joinSession('client-4', sessionId, boardPath, 'User4'),
      ]);

      // Verify all joined successfully
      expect(results).toHaveLength(3);
      const users = await roomManager.getSessionUsers(sessionId);
      expect(users).toHaveLength(3);
    });
  });

  describe('Reconnect Lifecycle', () => {
    // Stable participantId across reconnects only works for authenticated
    // users (the P1 fix removed trust in client-supplied participantId). The
    // tests below pass userIds that are written to board_sessions.created_by_user_id;
    // those values need to exist in the users table (FK constraint).
    const RECONNECT_TEST_USERS = ['user-A', 'leader-participant-id', 'member-participant-id'];

    beforeEach(async () => {
      for (const userId of RECONNECT_TEST_USERS) {
        await db.execute(sql`
          INSERT INTO users (id, email, name, created_at, updated_at)
          VALUES (${userId}, ${userId + '@reconnect.test'}, ${userId}, now(), now())
          ON CONFLICT (id) DO NOTHING
        `);
      }
    });

    afterEach(async () => {
      // Sessions FK-cascade onto board_sessions; clean up users we inserted.
      for (const userId of RECONNECT_TEST_USERS) {
        await db.execute(sql`DELETE FROM board_sessions WHERE created_by_user_id = ${userId}`);
        await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
      }
    });

    it('treats an anonymous reconnect as a fresh participant (no client-supplied participantId trust)', async () => {
      // P1 security guarantee: client-supplied participantId is ignored for
      // anonymous users so a malicious member cannot grab another peer's
      // SessionUser.id and impersonate them. The trade-off: an anonymous
      // user that drops the WebSocket and reconnects gets a new
      // participantId, and peers see UserLeft + UserJoined instead of
      // UserPresenceChanged. This test pins that intentional UX in place.
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // First anonymous connection joins.
      const original = await registerAndJoinSession('anon-conn-1', sessionId, boardPath, 'Anon');
      expect(original.participantId).toBe('anon-conn-1');

      await roomManager.disconnectClient('anon-conn-1');

      // Reconnect from a NEW anonymous connection. Even if the client tries
      // to replay the previous participantId, the server must reject it.
      await roomManager.registerClient('anon-conn-2');
      const rejoined = await roomManager.joinSession(
        'anon-conn-2',
        sessionId,
        boardPath,
        'Anon',
        undefined,
        undefined,
        undefined,
        undefined,
        original.participantId, // attacker-controlled value — must be ignored
      );

      expect(rejoined.participantId).toBe('anon-conn-2');
      expect(rejoined.participantId).not.toBe(original.participantId);
      expect(rejoined.participantWasReconnecting).toBe(false);
      expect(rejoined.participantWasKnown).toBe(false);
    });

    it('marks a passively disconnected participant as reconnecting and restores them on reconnect', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Authenticated user: stable participantId == userId across reconnects.
      // Anonymous users intentionally don't share continuity here; that's the
      // P1 security fix on the join side.
      const joined = await registerAndJoinSession('client-1', sessionId, boardPath, 'User1', 'user-A');

      const disconnectResult = await roomManager.disconnectClient('client-1');
      expect(disconnectResult?.presenceUser).toEqual(
        expect.objectContaining({
          id: joined.participantId,
          username: 'User1',
          connectionState: 'RECONNECTING',
        }),
      );

      const reconnectingUsers = await roomManager.getSessionUsers(sessionId);
      expect(reconnectingUsers).toContainEqual(
        expect.objectContaining({
          id: joined.participantId,
          connectionState: 'RECONNECTING',
        }),
      );

      // Reconnect: a NEW connection authenticated as the same userId resolves
      // to the same participantId server-side.
      await roomManager.registerClient('client-1b', 'User1', 'user-A');
      const rejoined = await roomManager.joinSession('client-1b', sessionId, boardPath, 'User1');

      expect(rejoined.participantWasReconnecting).toBe(true);
      expect(rejoined.participantId).toBe(joined.participantId);
      expect(rejoined.users).toContainEqual(
        expect.objectContaining({
          id: joined.participantId,
          connectionState: 'CONNECTED',
        }),
      );
    });

    it('elects a new leader on passive leader disconnect while the old leader is reconnecting', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      const leader = await registerAndJoinSession('leader-client', sessionId, boardPath, 'Leader');
      const member = await registerAndJoinSession('member-client', sessionId, boardPath, 'Member');

      expect(leader.isLeader).toBe(true);
      expect(member.isLeader).toBe(false);

      const disconnectResult = await roomManager.disconnectClient('leader-client');

      expect(disconnectResult?.newLeaderId).toBe('member-client');
      expect(disconnectResult?.newLeaderParticipantId).toBe(member.participantId);
      expect(disconnectResult?.presenceUser).toEqual(
        expect.objectContaining({
          id: leader.participantId,
          isLeader: false,
          connectionState: 'RECONNECTING',
        }),
      );

      const users = await roomManager.getSessionUsers(sessionId);
      expect(users).toContainEqual(
        expect.objectContaining({
          id: member.participantId,
          isLeader: true,
          connectionState: 'CONNECTED',
        }),
      );
      expect(users).toContainEqual(
        expect.objectContaining({
          id: leader.participantId,
          isLeader: false,
          connectionState: 'RECONNECTING',
        }),
      );
    });

    it('returns stable participant leader IDs separately from connection IDs on passive disconnect', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Authenticated users: participantId is bound to userId server-side.
      // Client-supplied participantId is ignored (P1 security fix).
      await roomManager.registerClient('leader-conn', 'Leader', 'leader-participant-id');
      const leader = await roomManager.joinSession('leader-conn', sessionId, boardPath, 'Leader');
      await roomManager.registerClient('member-conn', 'Member', 'member-participant-id');
      const member = await roomManager.joinSession('member-conn', sessionId, boardPath, 'Member');

      expect(leader.participantId).toBe('leader-participant-id');
      expect(member.participantId).toBe('member-participant-id');

      const disconnectResult = await roomManager.disconnectClient('leader-conn');

      expect(disconnectResult?.newLeaderId).toBe('member-conn');
      expect(disconnectResult?.newLeaderParticipantId).toBe('member-participant-id');
    });

    it('returns stable participant leader IDs when a leader explicitly leaves', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      await roomManager.registerClient('leader-conn', 'Leader', 'leader-participant-id');
      await roomManager.joinSession('leader-conn', sessionId, boardPath, 'Leader');
      await roomManager.registerClient('member-conn', 'Member', 'member-participant-id');
      await roomManager.joinSession('member-conn', sessionId, boardPath, 'Member');

      const leaveResult = await roomManager.leaveSession('leader-conn');

      expect(leaveResult?.newLeaderId).toBe('member-conn');
      expect(leaveResult?.newLeaderParticipantId).toBe('member-participant-id');
    });

    it('evicts a participant who disconnects and never reconnects after the grace period', async () => {
      // Regression for the A6 ghost-participant bug. Before this fix, the
      // grace-timer callback spared any participant present in the user
      // list — but getSessionParticipants intentionally retains
      // RECONNECTING entries with zero live connections during the grace
      // window, so a never-reconnecting participant would linger as a
      // RECONNECTING ghost until the Redis TTL expired (~4h). The fix
      // queries the live-connection count and evicts when it's zero.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const sessionId = uuidv4();
        const boardPath = '/kilter/1/2/3/40';

        const joined = await registerAndJoinSession('ghost-conn', sessionId, boardPath, 'GhostUser', 'user-A');

        // Sanity: participant is present and CONNECTED.
        let users = await roomManager.getSessionUsers(sessionId);
        expect(users).toContainEqual(
          expect.objectContaining({ id: joined.participantId, connectionState: 'CONNECTED' }),
        );

        // Passive disconnect (e.g. WS dropped, tab closed). Participant
        // flips to RECONNECTING and the grace timer is armed.
        const disconnectResult = await roomManager.disconnectClient('ghost-conn');
        expect(disconnectResult?.presenceUser).toEqual(
          expect.objectContaining({ id: joined.participantId, connectionState: 'RECONNECTING' }),
        );

        users = await roomManager.getSessionUsers(sessionId);
        expect(users).toContainEqual(
          expect.objectContaining({ id: joined.participantId, connectionState: 'RECONNECTING' }),
        );

        // Advance past the grace period. No reconnect arrives.
        await vi.advanceTimersByTimeAsync(70_000);

        // The participant must be gone — evicted by the grace timer once
        // it confirmed zero live connections, not lingering as a ghost.
        users = await roomManager.getSessionUsers(sessionId);
        expect(users.find((u) => u.id === joined.participantId)).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('Lazy Restoration from Postgres', () => {
    it('should restore dormant session from Postgres when Redis expires', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';
      const climb = createTestClimb();

      // Create session and add climb to queue
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');
      const currentState = await roomManager.getQueueState(sessionId);
      await roomManager.updateQueueState(sessionId, [climb], null, currentState.version);

      // Flush pending writes to ensure data in Postgres
      await roomManager.flushPendingWrites();

      // Leave session
      await roomManager.leaveSession('client-1');

      // Simulate Redis expiry by clearing Redis and resetting room manager
      const redisHashes = mockRedis._hashes;
      redisHashes.clear();

      roomManager.reset();
      await roomManager.initialize(mockRedis);

      // Rejoin should restore from Postgres
      const result = await registerAndJoinSession('client-2', sessionId, boardPath, 'User2');

      // Verify queue was restored from Postgres
      expect(result.queue).toHaveLength(1);
      expect(result.queue[0]?.uuid).toBe(climb.uuid);
    });

    it('refuses to join an ended session instead of resurrecting it', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Create and end session
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');
      await roomManager.endSession(sessionId);

      // Clear in-memory state (simulate a fresh instance / Redis expiry)
      roomManager.reset();
      await roomManager.initialize(mockRedis);

      // Register, then assert the join itself is rejected (do NOT use
      // registerAndJoinSession — we need to assert on the join call).
      await roomManager.registerClient('client-2', 'User2');
      const error = await roomManager.joinSession('client-2', sessionId, boardPath, 'User2').catch((err) => err);
      expect(error).toBeInstanceOf(GraphQLError);
      expect((error as GraphQLError).extensions?.code).toBe('SESSION_ENDED');

      // No zombie room: the durable row is still ended, and the rejected joiner
      // never became a live participant.
      const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      expect(row?.status).toBe('ended');
      expect(row?.endedAt).not.toBeNull();
      const users = await roomManager.getSessionUsers(sessionId);
      expect(users.some((user) => user.id === 'client-2')).toBe(false);
    });
  });

  describe('Debounced Writes and Flush', () => {
    beforeEach(() => {
      // shouldAdvanceTime: true allows real I/O (Postgres queries) to complete
      // while still giving control over timer advancement via advanceTimersByTimeAsync
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should debounce Postgres writes for 30 seconds', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';
      const climb1 = createTestClimb();
      const climb2 = createTestClimb();

      // Create session
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

      // Add multiple climbs rapidly
      let currentState = await roomManager.getQueueState(sessionId);
      await roomManager.updateQueueState(sessionId, [climb1], null, currentState.version);

      currentState = await roomManager.getQueueState(sessionId);
      await roomManager.updateQueueState(sessionId, [climb1, climb2], null, currentState.version);

      // Check Postgres immediately - should not have latest state yet
      let queueRows = await db.select().from(sessionQueues).where(eq(sessionQueues.sessionId, sessionId));

      // Either no row yet, or old state
      if (queueRows.length > 0) {
        const queue = queueRows[0]?.queue as unknown[];
        expect(queue.length).toBeLessThan(2);
      }

      // Fast-forward 30 seconds to trigger the debounce callback
      await vi.advanceTimersByTimeAsync(30000);

      // The debounce callback fires and starts writeQueueStateToPostgres asynchronously.
      // Switch to real timers and wait briefly for the Postgres I/O to complete.
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Now check Postgres - should have latest state
      queueRows = await db.select().from(sessionQueues).where(eq(sessionQueues.sessionId, sessionId));

      expect(queueRows.length).toBe(1);
      const queue = queueRows[0]?.queue as unknown[];
      expect(queue).toHaveLength(2);
    });

    it('should flush pending writes on flushPendingWrites call', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';
      const climb = createTestClimb();

      // Create session and update queue
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');
      const currentState = await roomManager.getQueueState(sessionId);
      await roomManager.updateQueueState(sessionId, [climb], null, currentState.version);

      // Flush immediately (don't wait for timer)
      await roomManager.flushPendingWrites();

      // Verify data in Postgres
      const queueRows = await db.select().from(sessionQueues).where(eq(sessionQueues.sessionId, sessionId));

      expect(queueRows.length).toBe(1);
      const queue = queueRows[0]?.queue as unknown[];
      expect(queue).toHaveLength(1);
    });

    it('should cancel pending timer when new update arrives', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';
      const climb1 = createTestClimb();
      const climb2 = createTestClimb();

      // Create session
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

      // First update
      let currentState = await roomManager.getQueueState(sessionId);
      await roomManager.updateQueueState(sessionId, [climb1], null, currentState.version);

      // Wait 15 seconds
      await vi.advanceTimersByTimeAsync(15000);

      // Second update (should reset timer)
      currentState = await roomManager.getQueueState(sessionId);
      await roomManager.updateQueueState(sessionId, [climb1, climb2], null, currentState.version);

      // Wait another 15 seconds (total 30s from start, but only 15s from second update)
      await vi.advanceTimersByTimeAsync(15000);

      // Should not be written yet (timer was reset)
      let queueRows = await db.select().from(sessionQueues).where(eq(sessionQueues.sessionId, sessionId));

      if (queueRows.length > 0) {
        const queue = queueRows[0]?.queue as unknown[];
        expect(queue.length).toBeLessThan(2);
      }

      // Wait final 15 seconds (30s from second update) to trigger the debounce callback
      await vi.advanceTimersByTimeAsync(15000);

      // The debounce callback fires and starts writeQueueStateToPostgres asynchronously.
      // Switch to real timers and wait briefly for the Postgres I/O to complete.
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Now should be written
      queueRows = await db.select().from(sessionQueues).where(eq(sessionQueues.sessionId, sessionId));

      expect(queueRows.length).toBe(1);
      const queue = queueRows[0]?.queue as unknown[];
      expect(queue).toHaveLength(2);
    });
  });

  describe('isActive Field Calculation', () => {
    it('should mark session as active when users are connected', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Create discoverable session
      await roomManager.createDiscoverableSession(sessionId, boardPath, 'user-123', 37.7749, -122.4194, 'Test Session');

      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

      // Query nearby sessions
      const nearby = await roomManager.findNearbySessions(37.7749, -122.4194, 10000);

      const session = nearby.find((s) => s.id === sessionId);
      expect(session?.isActive).toBe(true);
      expect(session?.participantCount).toBe(1);
    });

    it('should mark session as active when in Redis even without connected users', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Create discoverable session
      await roomManager.createDiscoverableSession(sessionId, boardPath, 'user-123', 37.7749, -122.4194, 'Test Session');

      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');
      await roomManager.leaveSession('client-1');

      // Clear in-memory state but Redis still has it
      roomManager.reset();
      await roomManager.initialize(mockRedis);

      // Query nearby sessions
      const nearby = await roomManager.findNearbySessions(37.7749, -122.4194, 10000);

      const session = nearby.find((s) => s.id === sessionId);
      expect(session?.isActive).toBe(true);
      expect(session?.participantCount).toBe(0);
    });

    it('should exclude sessions that exist only in Postgres from discovery', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Create discoverable session
      await roomManager.createDiscoverableSession(sessionId, boardPath, 'user-123', 37.7749, -122.4194, 'Test Session');

      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');
      await roomManager.leaveSession('client-1');

      // Clear both in-memory and Redis (simulate TTL expiry)
      const redisHashes = mockRedis._hashes;
      redisHashes.clear();

      roomManager.reset();
      await roomManager.initialize(mockRedis);

      // Query nearby sessions
      const nearby = await roomManager.findNearbySessions(37.7749, -122.4194, 10000);

      const session = nearby.find((s) => s.id === sessionId);
      expect(session).toBeUndefined();
    });

    it('should exclude ended sessions from discovery', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Create discoverable session
      await roomManager.createDiscoverableSession(sessionId, boardPath, 'user-123', 37.7749, -122.4194, 'Test Session');

      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');
      await roomManager.endSession(sessionId);

      // Query nearby sessions
      const nearby = await roomManager.findNearbySessions(37.7749, -122.4194, 10000);

      const session = nearby.find((s) => s.id === sessionId);
      expect(session).toBeUndefined();
    });
  });

  describe('Graceful Degradation - Redis Unavailable', () => {
    it('should work in Postgres-only mode when Redis is not available', async () => {
      // Reset without Redis
      roomManager.reset();
      await roomManager.initialize();

      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';
      const climb = createTestClimb();

      // Should still work
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');
      const currentState = await roomManager.getQueueState(sessionId);
      await roomManager.updateQueueState(sessionId, [climb], null, currentState.version);

      // Verify queue works
      const state = await roomManager.getQueueState(sessionId);
      expect(state.queue).toHaveLength(1);
      expect(state.queue[0]?.uuid).toBe(climb.uuid);

      // Leave session
      await roomManager.leaveSession('client-1');

      // Durable session row should remain not-ended; liveness is not persisted to SQL
      const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      expect(session[0]?.status).toBe('active');
      expect(await roomManager.isSessionActive(sessionId)).toBe(false);
    });

    it('should not restore sessions in Postgres-only mode after server restart', async () => {
      // Run without Redis
      roomManager.reset();
      await roomManager.initialize();

      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // Create session and leave
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');
      await roomManager.leaveSession('client-1');

      // Reset (simulate server restart)
      roomManager.reset();
      await roomManager.initialize();

      // Try to rejoin - should create new session (no restoration in Postgres-only mode)
      const result = await registerAndJoinSession('client-2', sessionId, boardPath, 'User2');

      // Should be fresh session
      expect(result.queue).toHaveLength(0);
    });
  });

  describe('Data Ownership and Separation', () => {
    it('should store queue state in both Redis and Postgres', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';
      const climb = createTestClimb();

      // Create session and update queue
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');
      const currentState = await roomManager.getQueueState(sessionId);
      await roomManager.updateQueueState(sessionId, [climb], null, currentState.version);

      // Flush to Postgres
      await roomManager.flushPendingWrites();

      // Verify in Redis
      const redisHashes = mockRedis._hashes;
      const redisSession = redisHashes.get(`boardsesh:session:${sessionId}`);
      expect(redisSession?.queue).toBeDefined();

      // Verify in Postgres
      const pgQueue = await db.select().from(sessionQueues).where(eq(sessionQueues.sessionId, sessionId));
      expect(pgQueue).toHaveLength(1);
      expect(pgQueue[0]?.queue as unknown[]).toHaveLength(1);
    });

    it('should only store connected users in Redis, not Postgres', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';
      const climb = createTestClimb();

      // Create session and join users
      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');
      await registerAndJoinSession('client-2', sessionId, boardPath, 'User2');

      // Update queue to trigger Redis session hash creation
      // (new sessions only get their Redis hash written on queue update, not on creation)
      const currentState = await roomManager.getQueueState(sessionId);
      await roomManager.updateQueueState(sessionId, [climb], null, currentState.version);

      // With distributed state enabled, users are tracked via the distributed state manager
      // (session members set), not via redisStore.saveUsers(). Verify users are accessible
      // through the roomManager API.
      const users = await roomManager.getSessionUsers(sessionId);
      expect(users.length).toBeGreaterThan(0);

      const participantRows = await db
        .select()
        .from(boardSessionParticipants)
        .where(eq(boardSessionParticipants.sessionId, sessionId));
      expect(participantRows).toHaveLength(0);

      // Session queue state should be in Redis (written by updateQueueState)
      const redisHashes = mockRedis._hashes;
      const redisSession = redisHashes.get(`boardsesh:session:${sessionId}`);
      expect(redisSession).toBeDefined();
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle version conflicts with retry logic', async () => {
      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      await registerAndJoinSession('client-1', sessionId, boardPath, 'User1');

      // Simulate concurrent updates with same version
      const currentState = await roomManager.getQueueState(sessionId);
      const climb1 = createTestClimb();
      const climb2 = createTestClimb();

      // Both updates use same version - second should retry
      await Promise.all([
        roomManager.updateQueueState(sessionId, [climb1], null, currentState.version),
        roomManager.updateQueueState(sessionId, [climb2], null, currentState.version),
      ]);

      // Final state should have one of them (retry logic should handle conflict)
      const finalState = await roomManager.getQueueState(sessionId);
      expect(finalState.queue.length).toBeGreaterThan(0);
    });

    it('should handle Redis operations failing gracefully', async () => {
      // Create Redis mock that fails on hmset
      const failingRedis = createMockRedis();
      failingRedis.hmset = vi.fn(async () => {
        throw new Error('Redis connection error');
      });

      roomManager.reset();
      await roomManager.initialize(failingRedis);

      const sessionId = uuidv4();
      const boardPath = '/kilter/1/2/3/40';

      // When hmset fails, registerClient's distributed state registerConnection()
      // calls redis.multi().hmset()...exec() which triggers the error. The room
      // manager catches this and throws "Failed to register client: distributed
      // state error", preventing the client from being in an inconsistent state.
      await expect(registerAndJoinSession('client-1', sessionId, boardPath, 'User1')).rejects.toThrow(
        'Failed to register client: distributed state error',
      );
    });
  });
});
