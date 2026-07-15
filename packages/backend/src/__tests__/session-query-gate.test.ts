/**
 * Compat-matrix tests for the `session` query's membership gate (workstream
 * B3). Before this change, `session(sessionId)` had no membership check at
 * all — any client holding a session UUID could read the full queue, roster,
 * and board serial. The fix adds `isSessionMember` (a non-throwing,
 * single-shot counterpart of `requireSessionMember`) and returns a redacted
 * preview payload to non-members instead of an error, because two shipped
 * clients depend on the query succeeding without membership:
 *
 *  - mobile's GET_SESSION is an intentional PRE-JOIN preview for the
 *    join-confirmation screen (metadata + roster, no queueState selected).
 *  - mobile's GET_SESSION_QUEUE_STATE is a post-mutation-failure resync sent
 *    over HTTP, where every request gets a fresh `http-<uuid>` connectionId
 *    (see yoga.ts) — connection-based membership can never match there, so it
 *    already null-guards `session?.queueState` (queue-provider.tsx).
 *
 * This file pins the resulting compat matrix and confirms `eventsReplay`
 * (which still uses the throwing, retrying `requireSessionMember`) is
 * unaffected by the new gate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const getSessionUsersMock = vi.fn();
const getSessionByIdMock = vi.fn();
const getQueueStateMock = vi.fn();
const getSessionBoardSerialMock = vi.fn();
const getSessionLeaderConnectionIdMock = vi.fn();

vi.mock('../services/room-manager', () => ({
  roomManager: {
    getSessionUsers: (...args: unknown[]) => getSessionUsersMock(...args),
    getSessionById: (...args: unknown[]) => getSessionByIdMock(...args),
    getQueueState: (...args: unknown[]) => getQueueStateMock(...args),
    getSessionBoardSerial: (...args: unknown[]) => getSessionBoardSerialMock(...args),
    getSessionLeaderConnectionId: (...args: unknown[]) => getSessionLeaderConnectionIdMock(...args),
  },
}));

const eventsSinceMock = vi.fn();
vi.mock('../pubsub/index', () => ({
  pubsub: { getEventsSince: (...args: unknown[]) => eventsSinceMock(...args) },
}));

// Local, same-instance WS connection tracking (module-level `connections` map
// in graphql/context.ts). Tests populate this directly to simulate a
// same-instance WS connection whose context already has `sessionId` set.
const localContexts = vi.hoisted(() => new Map<string, { sessionId?: string }>());
vi.mock('../graphql/context', () => ({
  getContext: (connectionId: string) => localContexts.get(connectionId),
  updateContext: vi.fn(),
}));

// Cross-instance membership. `enabled: false` mirrors single-instance/no-Redis
// deployments where `getDistributedState()` returns null.
const distributedState = vi.hoisted(() => ({
  enabled: false,
  isConnectionInSession: vi.fn(),
}));
vi.mock('../services/distributed-state', () => ({
  getDistributedState: () =>
    distributedState.enabled ? { isConnectionInSession: distributedState.isConnectionInSession } : null,
}));

// Durable `board_session_participants` lookup — the only signal available for
// an authenticated HTTP caller (fresh connectionId per request, see yoga.ts).
// The helper reads the PRIMARY client (`db`, not `dbRead`) so a fresh join's
// participant row can't be missed via replica lag.
const dbMock = vi.hoisted(() => {
  const limit = vi.fn();
  return {
    limit,
    client: {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit,
    },
  };
});
vi.mock('../db/client', () => ({ db: dbMock.client, dbRead: dbMock.client }));

const { sessionQueries } = await import('../graphql/resolvers/sessions/queries');

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-default',
    transport: 'ws',
    isAuthenticated: false,
    ...overrides,
  };
}

const sampleSessionData = {
  id: 'session-1',
  name: 'Tuesday sesh',
  boardPath: '/kilter/1/2/3/40',
  goal: 'project the V6',
  isPublic: true,
  startedAt: new Date('2026-05-18T12:00:00Z'),
  endedAt: null,
  isPermanent: false,
  color: '#ff00aa',
  createdByUserId: 'creator-1',
};

const sampleUsers = [
  { id: 'p-1', username: 'Alice', isLeader: true, connectionState: 'CONNECTED' as const },
  { id: 'p-2', username: 'Bob', isLeader: false, connectionState: 'CONNECTED' as const },
];

const sampleQueueState = {
  sequence: 5,
  stateHash: 'hash-5',
  stateHashOrdered: 'hash-5-ordered',
  queue: [],
  currentClimbQueueItem: null,
  version: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  localContexts.clear();
  distributedState.enabled = false;
  getSessionUsersMock.mockResolvedValue(sampleUsers);
  getSessionByIdMock.mockResolvedValue(sampleSessionData);
  getQueueStateMock.mockResolvedValue(sampleQueueState);
  getSessionBoardSerialMock.mockResolvedValue('SERIAL-123');
  getSessionLeaderConnectionIdMock.mockResolvedValue(null);
  dbMock.limit.mockResolvedValue([]);
});

describe('session query — membership gate compat matrix', () => {
  it('WS-connected member (local context sessionId matches) gets the full payload incl. queueState', async () => {
    localContexts.set('ws-conn-1', { sessionId: 'session-1' });
    const ctx = makeCtx({ connectionId: 'ws-conn-1', transport: 'ws' });

    const result = await sessionQueries.session(undefined, { sessionId: 'session-1' }, ctx);

    expect(result).not.toBeNull();
    expect(result!.queueState).toEqual({
      sequence: 5,
      stateHash: 'hash-5',
      stateHashOrdered: 'hash-5-ordered',
      queue: [],
      currentClimbQueueItem: null,
    });
    expect(result!.users).toEqual(sampleUsers);
    expect(result!.lastConnectedBoardSerial).toBe('SERIAL-123');
    expect(result!.isLeader).toBe(false);
    // Fast local-context path: never falls through to distributed state or
    // the durable participants table.
    expect(distributedState.isConnectionInSession).not.toHaveBeenCalled();
    expect(dbMock.limit).not.toHaveBeenCalled();
  });

  it('member via cross-instance distributed state (no local context) gets the full payload', async () => {
    distributedState.enabled = true;
    distributedState.isConnectionInSession.mockResolvedValueOnce(true);
    const ctx = makeCtx({ connectionId: 'ws-conn-other-instance', transport: 'ws' });

    const result = await sessionQueries.session(undefined, { sessionId: 'session-1' }, ctx);

    expect(result!.queueState).not.toBeNull();
    expect(distributedState.isConnectionInSession).toHaveBeenCalledWith('ws-conn-other-instance', 'session-1');
    expect(dbMock.limit).not.toHaveBeenCalled();
  });

  it('WS caller the distributed state disowns still falls through to the durable row (pins the check order)', async () => {
    // An authenticated WS connection whose distributed-state entry says "not
    // in this session" (e.g. rejoin race, or a past participant on a fresh
    // socket) must still reach the durable check — distributed-state `false`
    // is a non-match, not a veto.
    distributedState.enabled = true;
    distributedState.isConnectionInSession.mockResolvedValueOnce(false);
    dbMock.limit.mockResolvedValueOnce([{ sessionId: 'session-1' }]);
    const ctx = makeCtx({
      connectionId: 'ws-conn-disowned',
      transport: 'ws',
      userId: 'user-42',
      isAuthenticated: true,
    });

    const result = await sessionQueries.session(undefined, { sessionId: 'session-1' }, ctx);

    expect(result!.queueState).not.toBeNull();
    expect(distributedState.isConnectionInSession).toHaveBeenCalledWith('ws-conn-disowned', 'session-1');
    expect(dbMock.limit).toHaveBeenCalledTimes(1);
  });

  it('distributed-state failure (Redis blip) degrades to the durable check instead of 500ing: row → full payload', async () => {
    distributedState.enabled = true;
    distributedState.isConnectionInSession.mockRejectedValueOnce(new Error('Redis connection lost'));
    dbMock.limit.mockResolvedValueOnce([{ sessionId: 'session-1' }]);
    const ctx = makeCtx({
      connectionId: 'ws-conn-redis-blip',
      transport: 'ws',
      userId: 'user-42',
      isAuthenticated: true,
    });

    const result = await sessionQueries.session(undefined, { sessionId: 'session-1' }, ctx);

    expect(result!.queueState).not.toBeNull();
    expect(dbMock.limit).toHaveBeenCalledTimes(1);
  });

  it('distributed-state failure with no durable row degrades to the preview — an error never grants membership', async () => {
    distributedState.enabled = true;
    distributedState.isConnectionInSession.mockRejectedValueOnce(new Error('Redis connection lost'));
    dbMock.limit.mockResolvedValueOnce([]);
    const ctx = makeCtx({
      connectionId: 'ws-conn-redis-blip-anon',
      transport: 'ws',
      userId: 'user-42',
      isAuthenticated: true,
    });

    const result = await sessionQueries.session(undefined, { sessionId: 'session-1' }, ctx);

    expect(result).not.toBeNull(); // no 500 — the query still resolves
    expect(result!.queueState).toBeNull();
    expect(result!.lastConnectedBoardSerial).toBeNull();
  });

  it('authenticated past participant over HTTP (fresh http-* connectionId, durable participant row) gets the full payload', async () => {
    // HTTP requests are stateless (never in the `graphql/context.ts` map) and
    // get a fresh connectionId every call — see yoga.ts — so the resolver
    // skips the connection-based checks entirely and goes straight to the
    // durable `board_session_participants` row.
    dbMock.limit.mockResolvedValueOnce([{ sessionId: 'session-1' }]);
    distributedState.enabled = true; // available, but must not be consulted for HTTP
    const ctx = makeCtx({
      connectionId: 'http-11111111-1111-1111-1111-111111111111',
      transport: 'http',
      userId: 'user-42',
      isAuthenticated: true,
    });

    const result = await sessionQueries.session(undefined, { sessionId: 'session-1' }, ctx);

    expect(result).not.toBeNull();
    expect(result!.queueState).not.toBeNull();
    expect(result!.lastConnectedBoardSerial).toBe('SERIAL-123');
    expect(dbMock.limit).toHaveBeenCalledTimes(1);
    // HTTP short-circuit: the connection-based checks are skipped, not just
    // unmatched.
    expect(distributedState.isConnectionInSession).not.toHaveBeenCalled();
  });

  it('anonymous HTTP caller for a live session they were "in" gets a preview — accepted degradation, no stable identity to check durably', async () => {
    const ctx = makeCtx({
      connectionId: 'http-22222222-2222-2222-2222-222222222222',
      transport: 'http',
      userId: undefined,
      isAuthenticated: false,
    });

    const result = await sessionQueries.session(undefined, { sessionId: 'session-1' }, ctx);

    expect(result).not.toBeNull();
    expect(result!.queueState).toBeNull();
    expect(result!.lastConnectedBoardSerial).toBeNull();
    expect(result!.isLeader).toBe(false);
    expect(result!.users).toEqual(sampleUsers); // roster stays — invite-preview contract
    // No userId at all: the helper doesn't even attempt the durable lookup.
    expect(dbMock.limit).not.toHaveBeenCalled();
    // Redis round-trips for the redacted fields are skipped entirely, not
    // fetched-then-discarded.
    expect(getQueueStateMock).not.toHaveBeenCalled();
    expect(getSessionBoardSerialMock).not.toHaveBeenCalled();
  });

  it('complete stranger with only the session UUID gets a preview: metadata + roster, queue/serial/leader redacted', async () => {
    const ctx = makeCtx({
      connectionId: 'http-33333333-3333-3333-3333-333333333333',
      transport: 'http',
      userId: undefined,
      isAuthenticated: false,
    });

    const result = await sessionQueries.session(undefined, { sessionId: 'session-1' }, ctx);

    expect(result).toEqual({
      id: 'session-1',
      name: 'Tuesday sesh',
      boardPath: '/kilter/1/2/3/40',
      users: sampleUsers,
      queueState: null,
      isLeader: false,
      lastConnectedBoardSerial: null,
      clientId: '',
      participantId: expect.any(String),
      goal: 'project the V6',
      notes: null,
      isPublic: true,
      startedAt: '2026-05-18T12:00:00.000Z',
      endedAt: null,
      isPermanent: false,
      color: '#ff00aa',
    });
  });

  it('private session (isPublic false): stranger still gets the preview with roster — invite link is the access token, queue stays redacted', async () => {
    // Pins the roster-in-preview contract for non-discoverable sessions.
    // Deliberate: mobile's join-confirmation screen needs the roster for
    // exactly these invite-only sessions, and the sensitive payload (queue,
    // board serial) is redacted either way. Changing this in either
    // direction (hiding the roster, or leaking the queue) must fail here.
    getSessionByIdMock.mockResolvedValueOnce({ ...sampleSessionData, isPublic: false });
    const ctx = makeCtx({
      connectionId: 'http-66666666-6666-6666-6666-666666666666',
      transport: 'http',
      userId: undefined,
      isAuthenticated: false,
    });

    const result = await sessionQueries.session(undefined, { sessionId: 'session-1' }, ctx);

    expect(result!.isPublic).toBe(false);
    expect(result!.users).toEqual(sampleUsers);
    expect(result!.name).toBe('Tuesday sesh');
    expect(result!.queueState).toBeNull();
    expect(result!.lastConnectedBoardSerial).toBeNull();
    expect(result!.isLeader).toBe(false);
  });

  it('authenticated HTTP caller with no durable participant row also gets a preview', async () => {
    dbMock.limit.mockResolvedValueOnce([]); // no matching row
    const ctx = makeCtx({
      connectionId: 'http-44444444-4444-4444-4444-444444444444',
      transport: 'http',
      userId: 'user-never-joined',
      isAuthenticated: true,
    });

    const result = await sessionQueries.session(undefined, { sessionId: 'session-1' }, ctx);

    expect(result!.queueState).toBeNull();
    expect(dbMock.limit).toHaveBeenCalledTimes(1);
  });

  it('dormant session (empty live roster) returns null before any membership check runs', async () => {
    getSessionUsersMock.mockResolvedValueOnce([]);
    const ctx = makeCtx({
      connectionId: 'http-dormant',
      transport: 'http',
      userId: 'user-1',
      isAuthenticated: true,
    });

    const result = await sessionQueries.session(undefined, { sessionId: 'session-empty' }, ctx);

    expect(result).toBeNull();
    expect(dbMock.limit).not.toHaveBeenCalled();
    expect(distributedState.isConnectionInSession).not.toHaveBeenCalled();
  });
});

describe('eventsReplay membership check is unaffected by the query gate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('still succeeds for a WS member via the local-context fast path', async () => {
    localContexts.set('ws-conn-1', { sessionId: 'session-1' });
    eventsSinceMock.mockResolvedValue([]);
    const ctx = makeCtx({ connectionId: 'ws-conn-1', transport: 'ws' });

    const result = await sessionQueries.eventsReplay(undefined, { sessionId: 'session-1', sinceSequence: 0 }, ctx);

    expect(result.currentSequence).toBe(sampleQueueState.sequence);
    expect(eventsSinceMock).toHaveBeenCalledWith('session-1', 0);
  });

  it('still rejects an authenticated HTTP caller with a durable participant row — unlike the `session` query, requireSessionMember has no durable fallback', async () => {
    // This is the key "unchanged" assertion: a caller who the NEW
    // isSessionMember helper would treat as a member (durable participants
    // row present) must still be rejected by eventsReplay, because it keeps
    // using the throwing, retrying requireSessionMember — which only ever
    // consults local/distributed connection state, never the durable table.
    dbMock.limit.mockResolvedValueOnce([{ sessionId: 'session-1' }]);
    const ctx = makeCtx({
      connectionId: 'http-55555555-5555-5555-5555-555555555555',
      transport: 'http',
      userId: 'user-42',
      isAuthenticated: true,
    });

    vi.useFakeTimers();
    const promise = sessionQueries.eventsReplay(undefined, { sessionId: 'session-1', sinceSequence: 0 }, ctx);
    const assertion = expect(promise).rejects.toThrow(/Unauthorized/);
    // Total retry backoff is ~6.35s (8 retries, 50ms initial, doubling);
    // 10s comfortably flushes every pending timer.
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(eventsSinceMock).not.toHaveBeenCalled();
  });
});
