/**
 * Tests for the activityPushToken register/unregister mutations.
 *
 * Verifies:
 * - Unauthenticated requests are rejected.
 * - Authenticated but non-participant requests are rejected.
 * - Bad token format is rejected.
 * - Authenticated participant + good token succeeds.
 * - The unregister DELETE is scoped by both token AND sessionId.
 * - Token rebind is detected and logged.
 * - Eviction respects the 1-hour freshness window.
 * - An immediate APNs push is fired for the just-registered token.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { activityPushTokens } from '@boardsesh/db/schema/app';
import { boardSessionParticipants } from '../db/schema';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Mocks — exercised before the resolver is imported.
// ---------------------------------------------------------------------------

const participantRows = vi.fn<() => Array<{ sessionId: string }>>(() => []);
const requireResourceAccessMock = vi.fn(async () => undefined);
vi.mock('../services/privacy', () => ({ requireResourceAccess: requireResourceAccessMock }));
const existingTokenRows = vi.fn<() => Array<{ sessionId: string }>>(() => []);
const countRows = vi.fn<() => Array<{ value: number }>>(() => [{ value: 0 }]);
const oldestTokenRows = vi.fn<() => Array<{ token: string }>>(() => []);
const oldestLimit = vi.fn<(_n: number) => Promise<Array<{ token: string }>>>(async (_n) => oldestTokenRows());

const insertOnConflictDoUpdate = vi.fn();
const deleteWhere = vi.fn();
const insertValuesReturn = { onConflictDoUpdate: insertOnConflictDoUpdate };
const insertReturn = { values: vi.fn(() => insertValuesReturn) };

vi.mock('../db/client', () => {
  // Drizzle-style chain: select().from(table).where().limit() OR
  //                     select(...).from(table).where()   (thenable for count)
  //                     select(...).from(table).where().orderBy(...).limit() (oldest)
  //
  // The chain remembers which table was passed to from(...) so .limit(1) can
  // dispatch to the right mocked row source: `boardSessionParticipants` →
  // participantRows (the participant lookup), `activityPushTokens` →
  // existingTokenRows (the rebind lookup inside the transaction).
  function makeSelectChain() {
    let currentTable: unknown = null;
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn((table: unknown) => {
      currentTable = table;
      return chain;
    });
    chain.where = vi.fn(() => {
      const result: Record<string, unknown> = {};
      result.limit = vi.fn(async (_n: number) => {
        if (currentTable === activityPushTokens) return existingTokenRows();
        if (currentTable === boardSessionParticipants) return participantRows();
        return [];
      });
      result.orderBy = vi.fn(() => ({
        limit: oldestLimit,
      }));
      // Make this object thenable so `await db.select().from().where()` resolves
      // eslint-disable-next-line unicorn/no-thenable -- The Drizzle mock must be both awaitable and chainable.
      result.then = (onFulfilled: (rows: Array<{ value: number }>) => unknown) => onFulfilled(countRows());
      return result;
    });
    return chain;
  }

  const db = {
    select: vi.fn(() => makeSelectChain()),
    insert: vi.fn(() => insertReturn),
    delete: vi.fn(() => ({ where: deleteWhere })),
    // The resolver runs the rebind lookup, count, optional eviction and the
    // insert inside `db.transaction(...)` under a Postgres advisory lock. The
    // mock transaction just exposes the same surface and invokes the callback
    // synchronously — `execute` is a no-op here because the tests don't care
    // about the lock SQL itself, only about the chained select/delete/insert
    // calls.
    transaction: vi.fn(
      async <T>(callback: (tx: typeof db & { execute: (q: unknown) => Promise<void> }) => Promise<T>): Promise<T> => {
        const tx = {
          ...db,
          execute: vi.fn(async (_q: unknown) => undefined),
        };
        return callback(tx);
      },
    ),
  };

  return { db };
});

// Stub the APNs service so the resolver's immediate-send-on-register branch
// can be observed without touching real APNs state.
const sendLiveActivityUpdateToTokensMock = vi.fn(async () => undefined);
const isApnsConfiguredMock = vi.fn(() => false);
const incrementApnsMetricMock = vi.fn();
const trackLiveActivityStartedMock = vi.fn();
const trackLiveActivityEndedMock = vi.fn();

vi.mock('../services/apns', () => ({
  isApnsConfigured: () => isApnsConfiguredMock(),
  sendLiveActivityUpdateToTokens: sendLiveActivityUpdateToTokensMock,
  incrementApnsMetric: incrementApnsMetricMock,
}));

vi.mock('../services/analytics/live-activity', () => ({
  trackLiveActivityStarted: trackLiveActivityStartedMock,
  trackLiveActivityEnded: trackLiveActivityEndedMock,
}));

vi.mock('../services/room-manager', () => ({
  roomManager: {
    getQueueState: vi.fn(async () => ({
      queue: [{ uuid: 'q1', climb: { uuid: 'c1', name: 'Test', difficulty: 'V5', angle: 40 } }],
      currentClimbQueueItem: { uuid: 'q1', climb: { uuid: 'c1', name: 'Test', difficulty: 'V5', angle: 40 } },
    })),
  },
}));

const { pushTokenMutations, __resetPushTokenRateLimitForTests } =
  await import('../graphql/resolvers/sessions/push-tokens');

const loggerInfoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'a'.repeat(64); // 64 hex chars
const INVALID_TOKEN = 'not-a-real-hex-token';
const SESSION_ID = 'session-test-1';
const OTHER_SESSION_ID = 'session-test-2';
const USER_ID = 'user-test-1';

function authedCtx(userId = USER_ID): ConnectionContext {
  return {
    connectionId: `http-${userId}`,
    sessionId: undefined,
    userId,
    isAuthenticated: true,
  };
}

function anonCtx(): ConnectionContext {
  return {
    connectionId: 'http-anon-1',
    sessionId: undefined,
    userId: undefined,
    isAuthenticated: false,
  };
}

function resetAllMocks(): void {
  vi.clearAllMocks();
  requireResourceAccessMock.mockReset().mockResolvedValue(undefined);
  __resetPushTokenRateLimitForTests();
  participantRows.mockReturnValue([{ sessionId: SESSION_ID }]);
  existingTokenRows.mockReturnValue([]);
  countRows.mockReturnValue([{ value: 0 }]);
  oldestTokenRows.mockReturnValue([]);
  isApnsConfiguredMock.mockReturnValue(false);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterAll(() => {
  loggerInfoSpy.mockRestore();
  loggerWarnSpy.mockRestore();
  loggerErrorSpy.mockRestore();
});

describe('registerActivityPushToken', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('rejects a former participant whose current session access was revoked', async () => {
    requireResourceAccessMock.mockRejectedValueOnce(new Error('Not found'));
    await expect(
      pushTokenMutations.registerActivityPushToken(
        undefined,
        { sessionId: SESSION_ID, token: VALID_TOKEN },
        authedCtx(),
      ),
    ).rejects.toThrow('Not found');
    expect(requireResourceAccessMock).toHaveBeenCalledWith('session', SESSION_ID, USER_ID);
    expect(insertReturn.values).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated callers', async () => {
    await expect(
      pushTokenMutations.registerActivityPushToken(undefined, { sessionId: SESSION_ID, token: VALID_TOKEN }, anonCtx()),
    ).rejects.toThrow('Authentication required');
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      `[APNs] Rejected Live Activity token registration for session ${SESSION_ID}: unauthenticated`,
    );
  });

  it('rejects authenticated non-participants', async () => {
    participantRows.mockReturnValue([]); // no participant row
    await expect(
      pushTokenMutations.registerActivityPushToken(
        undefined,
        { sessionId: SESSION_ID, token: VALID_TOKEN },
        authedCtx(),
      ),
    ).rejects.toThrow('not a participant');
  });

  it('rejects bad token format', async () => {
    await expect(
      pushTokenMutations.registerActivityPushToken(
        undefined,
        { sessionId: SESSION_ID, token: INVALID_TOKEN },
        authedCtx(),
      ),
    ).rejects.toThrow('Invalid APNs token format');
  });

  it('accepts the 160-hex-char ActivityKit token shape used on iOS 17.2+', async () => {
    // iOS 17.2+ ships 80-byte Live Activity push tokens. The previous regex
    // capped at 128 hex chars and rejected real tokens with a confusing
    // "invalid token format (length 160)" error — guard against re-tightening.
    const longActivityToken = 'b'.repeat(160);
    const result = await pushTokenMutations.registerActivityPushToken(
      undefined,
      { sessionId: SESSION_ID, token: longActivityToken },
      authedCtx(),
    );
    expect(result).toBe(true);
  });

  it('inserts when authenticated participant supplies a valid token', async () => {
    const result = await pushTokenMutations.registerActivityPushToken(
      undefined,
      { sessionId: SESSION_ID, token: VALID_TOKEN },
      authedCtx(),
    );

    expect(result).toBe(true);
    expect(insertReturn.values).toHaveBeenCalledWith(
      expect.objectContaining({ token: VALID_TOKEN, sessionId: SESSION_ID, userId: USER_ID }),
    );
    expect(insertOnConflictDoUpdate).toHaveBeenCalled();
    expect(incrementApnsMetricMock).toHaveBeenCalledTimes(1);
    expect(incrementApnsMetricMock).toHaveBeenCalledWith('tokensRegistered');
    expect(trackLiveActivityStartedMock).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      tokenLength: VALID_TOKEN.length,
      apnsConfigured: false,
      tokenPreviouslyRegistered: false,
      tokenRebound: false,
    });
    expect(loggerInfoSpy).toHaveBeenCalledWith(
      `[APNs] Registered Live Activity token for session ${SESSION_ID}: ${VALID_TOKEN.slice(0, 8)}...`,
    );
  });

  it('does NOT fire an immediate APNs send when APNs is not configured', async () => {
    // Default mock returns false; this test makes that contract explicit so a
    // regression in the `isApnsConfigured()` guard would fail loudly.
    isApnsConfiguredMock.mockReturnValue(false);

    const result = await pushTokenMutations.registerActivityPushToken(
      undefined,
      { sessionId: SESSION_ID, token: VALID_TOKEN },
      authedCtx(),
    );

    expect(result).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sendLiveActivityUpdateToTokensMock).not.toHaveBeenCalled();
  });

  it('logs a rebind warning when an existing token moves between sessions', async () => {
    existingTokenRows.mockReturnValue([{ sessionId: OTHER_SESSION_ID }]);

    const result = await pushTokenMutations.registerActivityPushToken(
      undefined,
      { sessionId: SESSION_ID, token: VALID_TOKEN },
      authedCtx(),
    );

    expect(result).toBe(true);
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      `[APNs] Rebound token ${VALID_TOKEN.slice(0, 8)}... from session ${OTHER_SESSION_ID} → ${SESSION_ID} (user ${USER_ID})`,
    );
    expect(incrementApnsMetricMock).toHaveBeenCalledWith('tokensRebound');
    expect(trackLiveActivityStartedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        tokenPreviouslyRegistered: true,
        tokenRebound: true,
      }),
    );
  });

  it('does not evict when at cap but oldest token is fresh (within 1h)', async () => {
    // Cap is 8; we report a count of 9 (over cap) but the freshness-filtered
    // SELECT returns no eviction candidates because every token was updated
    // in the last hour. The resolver should refuse instead of evicting.
    countRows.mockReturnValue([{ value: 9 }]);
    oldestTokenRows.mockReturnValue([]); // no stale candidates

    await expect(
      pushTokenMutations.registerActivityPushToken(
        undefined,
        { sessionId: SESSION_ID, token: VALID_TOKEN },
        authedCtx(),
      ),
    ).rejects.toThrow('Too many active devices');
    expect(insertReturn.values).not.toHaveBeenCalled();
  });

  it('evicts oldest tokens when the per-session cap is reached and they are stale', async () => {
    const oldestTokens = [{ token: 'b'.repeat(64) }, { token: 'c'.repeat(64) }];
    countRows.mockReturnValue([{ value: 9 }]);
    oldestTokenRows.mockReturnValue(oldestTokens);
    deleteWhere.mockResolvedValue(undefined);

    const result = await pushTokenMutations.registerActivityPushToken(
      undefined,
      { sessionId: SESSION_ID, token: VALID_TOKEN },
      authedCtx(),
    );

    expect(result).toBe(true);
    expect(oldestLimit).toHaveBeenCalledWith(2);
    expect(deleteWhere).toHaveBeenCalledTimes(2);
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      `[APNs] Evicting 2 old Live Activity token(s) for session ${SESSION_ID}; cap is 8`,
    );
    expect(incrementApnsMetricMock).toHaveBeenCalledWith('tokensEvicted');
  });

  it('does not enforce the cap when upserting an existing token in the same session', async () => {
    // Rebind for the same session = no row growth = cap shouldn't apply even
    // if we're already at 9.
    existingTokenRows.mockReturnValue([{ sessionId: SESSION_ID }]);
    countRows.mockReturnValue([{ value: 9 }]);
    oldestTokenRows.mockReturnValue([]);

    const result = await pushTokenMutations.registerActivityPushToken(
      undefined,
      { sessionId: SESSION_ID, token: VALID_TOKEN },
      authedCtx(),
    );

    expect(result).toBe(true);
    expect(insertOnConflictDoUpdate).toHaveBeenCalled();
  });

  it('triggers an immediate APNs send when APNs is configured', async () => {
    isApnsConfiguredMock.mockReturnValue(true);
    sendLiveActivityUpdateToTokensMock.mockResolvedValue(undefined);

    const result = await pushTokenMutations.registerActivityPushToken(
      undefined,
      { sessionId: SESSION_ID, token: VALID_TOKEN },
      authedCtx(),
    );

    expect(result).toBe(true);
    // The immediate send is fire-and-forget; flush microtasks so the test
    // observes the call.
    await new Promise((resolve) => setImmediate(resolve));
    expect(sendLiveActivityUpdateToTokensMock).toHaveBeenCalledWith(
      SESSION_ID,
      [{ token: VALID_TOKEN, userId: USER_ID }],
      expect.objectContaining({ climbUuid: 'c1' }),
      { source: 'registration' },
    );
  });

  it('rejects empty sessionId or token', async () => {
    await expect(
      pushTokenMutations.registerActivityPushToken(undefined, { sessionId: '', token: VALID_TOKEN }, authedCtx()),
    ).rejects.toThrow('sessionId and token are required');
    await expect(
      pushTokenMutations.registerActivityPushToken(undefined, { sessionId: SESSION_ID, token: '' }, authedCtx()),
    ).rejects.toThrow('sessionId and token are required');
  });
});

describe('unregisterActivityPushToken', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('rejects unauthenticated callers', async () => {
    await expect(
      pushTokenMutations.unregisterActivityPushToken(
        undefined,
        { sessionId: SESSION_ID, token: VALID_TOKEN },
        anonCtx(),
      ),
    ).rejects.toThrow('Authentication required');
  });

  it('rejects authenticated non-participants', async () => {
    participantRows.mockReturnValue([]);
    await expect(
      pushTokenMutations.unregisterActivityPushToken(
        undefined,
        { sessionId: SESSION_ID, token: VALID_TOKEN },
        authedCtx(),
      ),
    ).rejects.toThrow('not a participant');
  });

  it('rejects bad token format', async () => {
    await expect(
      pushTokenMutations.unregisterActivityPushToken(
        undefined,
        { sessionId: SESSION_ID, token: INVALID_TOKEN },
        authedCtx(),
      ),
    ).rejects.toThrow('Invalid APNs token format');
  });

  it('issues DELETE scoped by token AND sessionId for valid input', async () => {
    deleteWhere.mockResolvedValue(undefined);

    const result = await pushTokenMutations.unregisterActivityPushToken(
      undefined,
      { sessionId: SESSION_ID, token: VALID_TOKEN },
      authedCtx(),
    );

    expect(result).toBe(true);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
    expect(trackLiveActivityEndedMock).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      reason: 'unregister',
    });
    expect(loggerInfoSpy).toHaveBeenCalledWith(
      `[APNs] Unregistered Live Activity token for session ${SESSION_ID}: ${VALID_TOKEN.slice(0, 8)}...`,
    );
  });
});

describe('rate limiting', () => {
  beforeEach(() => {
    resetAllMocks();
    deleteWhere.mockResolvedValue(undefined);
  });

  it('rejects with a rate-limit error after the bucket is exhausted', async () => {
    // Bucket capacity is 5. Burn through capacity from a single (user, session) pair.
    for (let i = 0; i < 5; i++) {
      await pushTokenMutations.registerActivityPushToken(
        undefined,
        { sessionId: SESSION_ID, token: VALID_TOKEN },
        authedCtx(),
      );
    }

    await expect(
      pushTokenMutations.registerActivityPushToken(
        undefined,
        { sessionId: SESSION_ID, token: VALID_TOKEN },
        authedCtx(),
      ),
    ).rejects.toThrow('Too many push-token requests');
  });

  it('shares the bucket across register and unregister for the same (user, session)', async () => {
    // 3 registers + 2 unregisters = 5 calls, all should succeed.
    for (let i = 0; i < 3; i++) {
      await pushTokenMutations.registerActivityPushToken(
        undefined,
        { sessionId: SESSION_ID, token: VALID_TOKEN },
        authedCtx(),
      );
    }
    for (let i = 0; i < 2; i++) {
      await pushTokenMutations.unregisterActivityPushToken(
        undefined,
        { sessionId: SESSION_ID, token: VALID_TOKEN },
        authedCtx(),
      );
    }

    // 6th call (any kind) trips the limit.
    await expect(
      pushTokenMutations.unregisterActivityPushToken(
        undefined,
        { sessionId: SESSION_ID, token: VALID_TOKEN },
        authedCtx(),
      ),
    ).rejects.toThrow('Too many push-token requests');
  });

  it('isolates buckets across distinct users', async () => {
    // User A burns their bucket on SESSION_ID.
    for (let i = 0; i < 5; i++) {
      await pushTokenMutations.registerActivityPushToken(
        undefined,
        { sessionId: SESSION_ID, token: VALID_TOKEN },
        authedCtx('user-a'),
      );
    }
    // User B on the same session should still succeed.
    const result = await pushTokenMutations.registerActivityPushToken(
      undefined,
      { sessionId: SESSION_ID, token: VALID_TOKEN },
      authedCtx('user-b'),
    );
    expect(result).toBe(true);
  });
});
