/**
 * Regression tests for the joinSession / createSession context-update flow.
 *
 * Background: `roomManager.joinSession` returns `clientId: connectionId` (the
 * WebSocket connection ID). For a long time the resolvers passed that value
 * into `updateContext` as `userId`, clobbering the real authenticated user
 * UUID set by auth middleware. Downstream resolvers (climb mutations, ESP32
 * auto-authorize, tick adoption) then queried using the connection ID and
 * either matched zero rows or wrote records under the wrong owner.
 *
 * These tests pin the contract: `updateContext` must never receive a
 * `userId` field from joinSession / createSession — auth already set it.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { sessionMutations } from '../graphql/resolvers/sessions/mutations';
import { roomManager } from '../services/room-manager';
import { updateContext } from '../graphql/context';
import { pubsub } from '../pubsub/index';

vi.mock('../services/room-manager', () => ({
  roomManager: {
    joinSession: vi.fn().mockResolvedValue({
      clientId: 'ws-conn-abc-123',
      isLeader: true,
      users: [],
      queue: [],
      currentClimbQueueItem: null,
      sequence: 0,
      stateHash: 'hash',
      sessionName: null,
      participantId: 'stable-participant-123',
      participantWasKnown: false,
      participantWasReconnecting: false,
    }),
    leaveSession: vi.fn().mockResolvedValue({
      sessionId: 'session-aaaa-bbbb-cccc-dddd',
      participantId: 'stable-participant-123',
      newLeaderId: undefined,
      // Default to a full departure so the UserLeft broadcast path is
      // exercised by tests that don't override with `mockResolvedValueOnce`.
      // The per-tab leave case (`participantFullyLeft: false`) is covered by
      // its own explicit override elsewhere.
      participantFullyLeft: true,
    }),
    createDiscoverableSession: vi.fn().mockResolvedValue({}),
    getSessionById: vi.fn().mockResolvedValue(null),
    endSession: vi.fn().mockResolvedValue(undefined),
    getSessionUsers: vi.fn().mockResolvedValue([]),
    getSessionLeaderConnectionId: vi.fn().mockResolvedValue(null),
    // Driver-state plumbing (Phase 2 of the queue-control-bar pivot).
    // New session-returning resolvers (joinSession/createSession) now read
    // the current driver via the room manager; mock it to "no driver" so
    // these tests don't need to care about the new field.
    getSessionDriverParticipantId: vi.fn().mockResolvedValue(null),
    // Session-level board serial (Phase 2 simplified pivot). Returned by
    // session-shape resolvers so the lightbulb-on-confirm flow can show
    // peers which physical board is paired. Default to "no board" so this
    // existing test suite needn't model BLE pairing.
    getSessionBoardSerial: vi.fn().mockResolvedValue(null),
    getWallConnections: vi.fn().mockResolvedValue(new Map()),
  },
}));

vi.mock('../pubsub/index', () => ({
  pubsub: { publishSessionEvent: vi.fn() },
}));

vi.mock('../graphql/context', () => ({
  updateContext: vi.fn(),
  // requireSessionMember (shared helper) consults getContext to find the
  // latest sessionId for a connection. Returning the same shape the test
  // passes in lets membership checks pass cleanly so endSession tests
  // reach the authorization branch under test.
  getContext: vi.fn((connectionId: string) => ({
    connectionId,
    sessionId: 'session-end-1',
    transport: 'ws',
    isAuthenticated: true,
  })),
}));

vi.mock('uuid', () => ({
  v4: () => 'test-session-uuid',
}));

vi.mock('../db/client', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  },
}));

function makeWsAuthenticatedCtx(userId: string): ConnectionContext {
  return {
    connectionId: 'ws-conn-abc-123',
    sessionId: undefined,
    userId,
    isAuthenticated: true,
  };
}

describe('joinSession does not clobber ctx.userId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes sessionId and participantId to updateContext without clobbering the authenticated user UUID', async () => {
    const realUserId = '8a68ddc8-8da0-47e2-a968-1029b6fb4bb3';
    const ctx = makeWsAuthenticatedCtx(realUserId);

    await sessionMutations.joinSession(
      undefined,
      {
        sessionId: 'session-aaaa-bbbb-cccc-dddd',
        boardPath: '/kilter/1/2/3/40',
      },
      ctx,
    );

    expect(updateContext).toHaveBeenCalledOnce();
    const [calledConnectionId, calledUpdates] = vi.mocked(updateContext).mock.calls[0];
    expect(calledConnectionId).toBe('ws-conn-abc-123');
    expect(calledUpdates).toEqual({
      sessionId: 'session-aaaa-bbbb-cccc-dddd',
      participantId: 'stable-participant-123',
    });
    expect(calledUpdates).not.toHaveProperty('userId');
  });
});

describe('createSession does not clobber ctx.userId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes sessionId and participantId to updateContext on the WebSocket path', async () => {
    const realUserId = '8a68ddc8-8da0-47e2-a968-1029b6fb4bb3';
    const ctx = makeWsAuthenticatedCtx(realUserId);

    await sessionMutations.createSession(
      undefined,
      {
        input: {
          boardPath: '/kilter/1/2/3/40',
          latitude: 0,
          longitude: 0,
          discoverable: false,
          name: 'Test',
        },
      },
      ctx,
    );

    expect(updateContext).toHaveBeenCalledOnce();
    const [, calledUpdates] = vi.mocked(updateContext).mock.calls[0];
    expect(calledUpdates).toEqual({
      sessionId: 'test-session-uuid',
      participantId: 'stable-participant-123',
    });
    expect(calledUpdates).not.toHaveProperty('userId');
  });
});

describe('leaveSession publishes UserLeft with the stable participant ID', () => {
  // Background: the disconnect handler in websocket/setup.ts and the
  // explicit `leaveSession` mutation both emit a `UserLeft` event so
  // peers can drop the departing user from their participant list. The
  // GraphQL schema names the payload field `userId` but the current contract
  // with the client is that it carries the stable participant ID. Clients
  // populate their participant list from `UserJoined.user.id` and filter by
  // `u.id !== event.userId`, so joined and left events must agree.
  //
  // Earlier commits in this PR stopped clobbering `ctx.userId` with the
  // connection ID. The leaveSession mutation was previously guarded by
  // `if (userId)` and only fired because of that clobber, so it would
  // have silently stopped emitting UserLeft for unauthenticated clients
  // (and for authenticated clients would have emitted the real user
  // UUID when the participant ID differs from the user ID. These tests pin the
  // current behaviour.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits UserLeft with the returned participantId for authenticated clients', async () => {
    const realUserId = '8a68ddc8-8da0-47e2-a968-1029b6fb4bb3';
    vi.mocked(roomManager.leaveSession).mockResolvedValueOnce({
      sessionId: 'session-aaaa-bbbb-cccc-dddd',
      participantId: realUserId,
      newLeaderId: undefined,
      // participant had only this connection; UserLeft should fire. (When
      // false — e.g. a sibling tab still in the session — the resolver
      // intentionally suppresses the broadcast.)
      participantFullyLeft: true,
    });
    const ctx: ConnectionContext = {
      connectionId: 'ws-conn-abc-123',
      sessionId: 'session-aaaa-bbbb-cccc-dddd',
      userId: realUserId,
      isAuthenticated: true,
    };

    await sessionMutations.leaveSession(undefined, undefined, ctx);

    const calls = vi.mocked(pubsub.publishSessionEvent).mock.calls;
    const userLeftCall = calls.find(
      (call): call is [string, { __typename: 'UserLeft'; userId: string }] =>
        typeof call[1] === 'object' &&
        call[1] !== null &&
        (call[1] as { __typename?: string }).__typename === 'UserLeft',
    );
    expect(userLeftCall).toBeDefined();
    expect(userLeftCall![0]).toBe('session-aaaa-bbbb-cccc-dddd');
    expect(userLeftCall![1].userId).toBe(realUserId);
    expect(userLeftCall![1].userId).not.toBe('ws-conn-abc-123');

    // updateContext must clear ONLY session/participant state; userId must be
    // preserved for downstream resolvers on this same connection (queries,
    // social actions, etc.).
    expect(updateContext).toHaveBeenCalledOnce();
    const [, calledUpdates] = vi.mocked(updateContext).mock.calls[0];
    expect(calledUpdates).toEqual({ sessionId: undefined, participantId: undefined });
    expect(calledUpdates).not.toHaveProperty('userId');
  });

  it('emits UserLeft for unauthenticated clients (which previously had no userId on ctx)', async () => {
    vi.mocked(roomManager.leaveSession).mockResolvedValueOnce({
      sessionId: 'session-zzzz',
      participantId: 'anon-stable-participant',
      newLeaderId: undefined,
      participantFullyLeft: true,
    });
    const ctx: ConnectionContext = {
      connectionId: 'ws-conn-anon-456',
      sessionId: 'session-zzzz',
      userId: undefined,
      isAuthenticated: false,
    };

    await sessionMutations.leaveSession(undefined, undefined, ctx);

    const calls = vi.mocked(pubsub.publishSessionEvent).mock.calls;
    const userLeftCall = calls.find(
      (call): call is [string, { __typename: 'UserLeft'; userId: string }] =>
        typeof call[1] === 'object' &&
        call[1] !== null &&
        (call[1] as { __typename?: string }).__typename === 'UserLeft',
    );
    expect(userLeftCall).toBeDefined();
    expect(userLeftCall![1].userId).toBe('anon-stable-participant');
  });
});

vi.mock('../graphql/resolvers/shared/helpers', async (importOriginal) => {
  // Real validateInput / requireAuthenticated / requireSessionMember; bypass
  // applyRateLimit so endSession tests aren't subject to per-process limits.
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    applyRateLimit: vi.fn().mockResolvedValue(undefined),
  };
});

describe('endSession authorization (B2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: session exists, no stable leader, empty user list.
    vi.mocked(roomManager.getSessionById).mockResolvedValue({
      id: 'session-end-1',
      createdByUserId: 'creator-user-uuid',
    } as unknown as Awaited<ReturnType<typeof roomManager.getSessionById>>);
  });

  function makeAuthenticatedMemberCtx(connectionId: string, userId: string): ConnectionContext {
    return {
      connectionId,
      transport: 'ws',
      sessionId: 'session-end-1',
      userId,
      participantId: userId,
      isAuthenticated: true,
    };
  }

  it('rejects an authenticated WS member whose getSessionUsers entry says isLeader=true but the authoritative leader is someone else', async () => {
    // The exact scenario the B2 fix targets: SessionUser.isLeader can be
    // stale during handoff. Without the distributedState check, the stale
    // user-list entry would have authorized this caller.
    const ctx = makeAuthenticatedMemberCtx('ws-caller', 'caller-user');
    vi.mocked(roomManager.getSessionUsers).mockResolvedValueOnce([
      { id: 'caller-user', userId: 'caller-user', isLeader: true, username: 'Caller', connectionState: 'CONNECTED' },
    ] as unknown as Awaited<ReturnType<typeof roomManager.getSessionUsers>>);
    vi.mocked(roomManager.getSessionLeaderConnectionId).mockResolvedValueOnce('ws-other-leader');

    await expect(sessionMutations.endSession(undefined, { sessionId: 'session-end-1' }, ctx)).rejects.toThrow(
      /Only the session creator or current leader/,
    );
    expect(roomManager.endSession).not.toHaveBeenCalled();
  });

  it('accepts when distributedState reports the caller as the leader (connectionId match)', async () => {
    const ctx = makeAuthenticatedMemberCtx('ws-real-leader', 'leader-user');
    vi.mocked(roomManager.getSessionLeaderConnectionId).mockResolvedValueOnce('ws-real-leader');

    await sessionMutations.endSession(undefined, { sessionId: 'session-end-1' }, ctx);
    expect(roomManager.endSession).toHaveBeenCalledWith('session-end-1');
  });

  it('accepts the session creator even when not the current leader', async () => {
    // ctx.userId matches sessionData.createdByUserId; leader can be anyone.
    const ctx = makeAuthenticatedMemberCtx('ws-creator', 'creator-user-uuid');
    vi.mocked(roomManager.getSessionLeaderConnectionId).mockResolvedValueOnce('ws-someone-else');

    await sessionMutations.endSession(undefined, { sessionId: 'session-end-1' }, ctx);
    expect(roomManager.endSession).toHaveBeenCalledWith('session-end-1');
  });

  it('rejects an unauthenticated WS caller even when they are the current leader', async () => {
    // Auth regression guard: requireAuthenticated must run before the
    // leader check, so an anonymous leader cannot destroy the session.
    const ctx: ConnectionContext = {
      connectionId: 'ws-anon-leader',
      transport: 'ws',
      sessionId: 'session-end-1',
      userId: undefined,
      isAuthenticated: false,
    };
    vi.mocked(roomManager.getSessionLeaderConnectionId).mockResolvedValueOnce('ws-anon-leader');

    await expect(sessionMutations.endSession(undefined, { sessionId: 'session-end-1' }, ctx)).rejects.toThrow(
      /Authentication required/,
    );
    expect(roomManager.endSession).not.toHaveBeenCalled();
  });
});
