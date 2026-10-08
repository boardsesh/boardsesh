/**
 * Unit tests for `requireSessionMember` — the subscription-authorization gate
 * (queueUpdates / sessionUpdates / eventsReplay). Covers the changes for
 * issues #2355 and #2385:
 *
 *  1. **Durable fast-path (WS only).** An authenticated WebSocket connection
 *     holding a `board_session_participants` row is authorized on the FIRST
 *     check with zero backoff — even when its `ConnectionContext.sessionId` is
 *     still undefined (the graphql-ws reconnect auto-replay race). HTTP callers
 *     are deliberately excluded so `eventsReplay` over HTTP still proves active
 *     connection membership.
 *  2. **Typed denial.** The two terminal failure branches throw a
 *     `GraphQLError` carrying `extensions.code = 'NOT_SESSION_MEMBER'` plus a
 *     `reason` (`no-session-id` | `session-mismatch`) so clients can branch
 *     without scraping the message string.
 *  3. The pre-existing local-context / distributed-state / retry-propagation
 *     paths are unchanged.
 *
 * Mirrors the mocking scaffold in `session-query-gate.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const privacyAccess = vi.hoisted(() => ({ allowed: true }));
vi.mock('../services/privacy', () => ({
  canAccessResource: async () => privacyAccess.allowed,
  canViewActivityIdentity: async () => true,
  requireResourceAccess: async () => {
    if (!privacyAccess.allowed) throw new Error('Not found');
  },
}));

// Local, same-instance WS connection tracking (module-level `connections` map
// in graphql/context.ts). Tests populate this to simulate a same-instance WS
// connection whose context already has `sessionId` set.
const localContexts = vi.hoisted(() => new Map<string, { sessionId?: string }>());
const getContextMock = vi.hoisted(() => vi.fn((connectionId: string) => localContexts.get(connectionId)));
vi.mock('../graphql/context', () => ({
  getContext: getContextMock,
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

// Durable `board_session_participants` lookup (primary `db`). `limit` resolves
// the row array; `[]` = no durable membership.
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

const { requireSessionMember, isDurableSessionMember } = await import('../graphql/resolvers/shared/helpers');

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-default',
    transport: 'ws',
    isAuthenticated: false,
    ...overrides,
  };
}

/** Drive a rejecting call to completion under fake timers (the retry loop can
 *  burn up to ~6.35s of real backoff) and return the thrown error. */
async function expectRejection(promise: Promise<void>): Promise<unknown> {
  let caught: unknown;
  const settled = promise.then(
    () => {
      throw new Error('expected requireSessionMember to reject');
    },
    (error: unknown) => {
      caught = error;
    },
  );
  // 10s comfortably flushes every pending backoff timer.
  await vi.advanceTimersByTimeAsync(10_000);
  await settled;
  return caught;
}

beforeEach(() => {
  privacyAccess.allowed = true;
  vi.clearAllMocks();
  localContexts.clear();
  distributedState.enabled = false;
  dbMock.limit.mockResolvedValue([]);
  // clearAllMocks() clears call history but NOT a `mockImplementation` override
  // a prior test installed — restore the default lookup so each test starts
  // from a clean "reads localContexts" baseline.
  getContextMock.mockImplementation((connectionId: string) => localContexts.get(connectionId));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('requireSessionMember — durable fast-path (issues #2355 / #2385)', () => {
  it('authorizes an authenticated WS member from the durable row with no backoff, before the retry loop', async () => {
    // Reconnect auto-replay race: the fresh connection has no local/distributed
    // membership yet, but the durable participant row (from a prior join) is
    // enough.
    dbMock.limit.mockResolvedValueOnce([{ sessionId: 'session-1' }]);
    const ctx = makeCtx({ connectionId: 'ws-reconnected', transport: 'ws', userId: 'user-1', isAuthenticated: true });

    await expect(requireSessionMember(ctx, 'session-1')).resolves.toBeUndefined();

    // Fast-path returns before ever touching the connection-state loop.
    expect(dbMock.limit).toHaveBeenCalledTimes(1);
    expect(getContextMock).not.toHaveBeenCalled();
    expect(distributedState.isConnectionInSession).not.toHaveBeenCalled();
  });

  it('does NOT use the durable fast-path for an HTTP caller with a durable row (still rejects)', async () => {
    // Preserves the pre-existing eventsReplay-over-HTTP strictness pinned by
    // session-query-gate.test.ts: an HTTP request must prove active connection
    // membership, not just a past-participant row.
    vi.useFakeTimers();
    dbMock.limit.mockResolvedValue([{ sessionId: 'session-1' }]);
    const ctx = makeCtx({
      connectionId: 'http-55555555',
      transport: 'http',
      userId: 'user-1',
      isAuthenticated: true,
    });

    const error = await expectRejection(requireSessionMember(ctx, 'session-1'));

    expect(error).toBeInstanceOf(GraphQLError);
    expect((error as GraphQLError).extensions).toMatchObject({ code: 'NOT_SESSION_MEMBER', reason: 'no-session-id' });
    // The WS gate skipped the durable check entirely — no participants read ran.
    expect(dbMock.limit).not.toHaveBeenCalled();
  });

  it('skips the durable check for an anonymous caller (no userId) and falls through to the loop', async () => {
    localContexts.set('ws-anon', { sessionId: 'session-1' });
    const ctx = makeCtx({ connectionId: 'ws-anon', transport: 'ws' });

    await expect(requireSessionMember(ctx, 'session-1')).resolves.toBeUndefined();

    expect(dbMock.limit).not.toHaveBeenCalled();
  });
});

describe('requireSessionMember — existing connection-state paths (unchanged)', () => {
  it('authorizes via the local-context fast path (already joined on this instance)', async () => {
    localContexts.set('ws-1', { sessionId: 'session-1' });
    const ctx = makeCtx({ connectionId: 'ws-1', transport: 'ws' });

    await expect(requireSessionMember(ctx, 'session-1')).resolves.toBeUndefined();
    expect(distributedState.isConnectionInSession).not.toHaveBeenCalled();
  });

  it('authorizes via cross-instance distributed state', async () => {
    distributedState.enabled = true;
    distributedState.isConnectionInSession.mockResolvedValueOnce(true);
    const ctx = makeCtx({ connectionId: 'ws-other-instance', transport: 'ws' });

    await expect(requireSessionMember(ctx, 'session-1')).resolves.toBeUndefined();
    expect(distributedState.isConnectionInSession).toHaveBeenCalledWith('ws-other-instance', 'session-1');
  });

  it('waits through the retry loop for a join that propagates mid-window', async () => {
    vi.useFakeTimers();
    // Context is empty on the first check, then the join lands and sets sessionId.
    let checks = 0;
    getContextMock.mockImplementation((connectionId: string) => {
      void connectionId;
      checks += 1;
      return checks >= 2 ? { sessionId: 'session-1' } : undefined;
    });
    const ctx = makeCtx({ connectionId: 'ws-joining', transport: 'ws' });

    const promise = requireSessionMember(ctx, 'session-1');
    // First backoff is 50ms; flush it so the second check runs.
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBeUndefined();
  });
});

describe('requireSessionMember — typed denials', () => {
  it('throws NOT_SESSION_MEMBER / no-session-id when the connection never joined', async () => {
    vi.useFakeTimers();
    const ctx = makeCtx({ connectionId: 'ws-stale', transport: 'ws' });

    const error = await expectRejection(requireSessionMember(ctx, 'session-1'));

    expect(error).toBeInstanceOf(GraphQLError);
    expect((error as GraphQLError).message).toMatch(/not in any session/);
    expect((error as GraphQLError).extensions).toMatchObject({ code: 'NOT_SESSION_MEMBER', reason: 'no-session-id' });
  });

  it('throws NOT_SESSION_MEMBER / session-mismatch when joined to a different session', async () => {
    vi.useFakeTimers();
    localContexts.set('ws-b', { sessionId: 'other-session' });
    const ctx = makeCtx({ connectionId: 'ws-b', transport: 'ws' });

    const error = await expectRejection(requireSessionMember(ctx, 'session-1'));

    expect(error).toBeInstanceOf(GraphQLError);
    expect((error as GraphQLError).message).toMatch(/session mismatch/);
    expect((error as GraphQLError).extensions).toMatchObject({
      code: 'NOT_SESSION_MEMBER',
      reason: 'session-mismatch',
    });
  });
});

describe('isDurableSessionMember', () => {
  it('returns true when a participant row exists', async () => {
    dbMock.limit.mockResolvedValueOnce([{ sessionId: 'session-1' }]);
    await expect(isDurableSessionMember('user-1', 'session-1')).resolves.toBe(true);
  });

  it('returns false when no participant row exists', async () => {
    dbMock.limit.mockResolvedValueOnce([]);
    await expect(isDurableSessionMember('user-1', 'session-1')).resolves.toBe(false);
  });
});

describe('session audience revocation', () => {
  it('rejects revoked access before consulting durable participation or live membership', async () => {
    privacyAccess.allowed = false;
    localContexts.set('ws-existing', { sessionId: 'session-1' });
    dbMock.limit.mockResolvedValue([{ sessionId: 'session-1' }]);
    await expect(
      requireSessionMember(
        makeCtx({ connectionId: 'ws-existing', userId: 'revoked-user', isAuthenticated: true }),
        'session-1',
      ),
    ).rejects.toThrow('Not found');
    expect(dbMock.limit).not.toHaveBeenCalled();
    expect(getContextMock).not.toHaveBeenCalled();
  });
});
