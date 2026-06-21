import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq, inArray } from 'drizzle-orm';
import { activityPushTokens, boardSessions } from '@boardsesh/db/schema/app';
import { users } from '@boardsesh/db/schema/auth';
import { db } from '../db/client';
import type { LiveActivityContentState } from '../services/apns';
import type { BoardHolder } from '../services/apns/board-connection';

interface MockSendResult {
  sent: unknown[];
  failed: unknown[];
}

type MockSend = (notification: Record<string, unknown>, tokens: string[]) => Promise<MockSendResult>;

const { mockSend, mockShutdown, ProviderCtor, NotificationCtor } = vi.hoisted(() => {
  const mockSend = vi.fn<MockSend>(async () => ({ sent: [], failed: [] }));
  const mockShutdown = vi.fn(async () => undefined);
  // Arrow-function implementations can't be invoked with `new`. The SUT does
  // `new apn.Provider(...)` / `new apn.Notification()`, so the mock impls must
  // be `function` expressions that populate `this`.
  const ProviderCtor = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.send = mockSend;
    this.shutdown = mockShutdown;
  });
  const NotificationCtor = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.aps = {};
  });
  return { mockSend, mockShutdown, ProviderCtor, NotificationCtor };
});

vi.mock('@parse/node-apn', () => ({
  default: { Provider: ProviderCtor, Notification: NotificationCtor },
  Provider: ProviderCtor,
  Notification: NotificationCtor,
}));

const APNS_ENV_KEYS = [
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_KEY_CONTENTS',
  'APNS_BUNDLE_ID',
  'APNS_PRODUCTION',
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const key of APNS_ENV_KEYS) snap[key] = process.env[key];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const key of APNS_ENV_KEYS) {
    if (snap[key] === undefined) delete process.env[key];
    else process.env[key] = snap[key];
  }
}

function setApnsEnv(overrides: Partial<Record<(typeof APNS_ENV_KEYS)[number], string | undefined>> = {}): void {
  const defaults: Record<(typeof APNS_ENV_KEYS)[number], string> = {
    APNS_KEY_ID: 'TEST_KEY_ID',
    APNS_TEAM_ID: 'TEST_TEAM_ID',
    APNS_KEY_CONTENTS: 'a'.repeat(40),
    APNS_BUNDLE_ID: 'com.boardsesh.test',
    APNS_PRODUCTION: 'false',
  };
  for (const key of APNS_ENV_KEYS) {
    // `key in overrides` distinguishes "caller explicitly passed undefined"
    // (unset the env var) from "caller didn't mention this key" (use default).
    const value = key in overrides ? overrides[key] : defaults[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

interface ApnsModule {
  initializeApns: () => void;
  shutdownApns: () => Promise<void>;
  __resetApnsForTests: () => void;
  __setApnsTimingForTests: (opts: { debounceMs?: number; dbRetryDelaysMs?: readonly number[] }) => void;
  isApnsConfigured: () => boolean;
  hasPendingSend: (sessionId: string) => boolean;
  sendLiveActivityUpdate: (sessionId: string, contentState: LiveActivityContentState) => void;
  endLiveActivity: (sessionId: string) => Promise<void>;
  setSessionHolderResolver: (resolver: ((sessionId: string) => Promise<BoardHolder | null>) | null) => void;
}

async function loadApns(): Promise<ApnsModule> {
  return (await import('../services/apns')) as unknown as ApnsModule;
}

async function insertSession(sessionId: string): Promise<void> {
  await db.insert(boardSessions).values({
    id: sessionId,
    boardPath: 'kilter',
    status: 'active',
  });
}

async function insertTokens(sessionId: string, tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  await db.insert(activityPushTokens).values(
    tokens.map((token) => ({
      token,
      sessionId,
    })),
  );
}

async function insertUser(userId: string): Promise<void> {
  await db
    .insert(users)
    .values({ id: userId, email: `${userId}@apns-test.local`, name: userId })
    .onConflictDoNothing();
}

async function insertTokenForUser(sessionId: string, token: string, userId: string | null): Promise<void> {
  await db.insert(activityPushTokens).values({ token, sessionId, userId });
}

/** content-state of the first send whose token set includes `token`. */
function contentStateForToken(
  calls: [Record<string, unknown>, string[]][],
  token: string,
): (LiveActivityContentState & Record<string, unknown>) | undefined {
  for (const [notification, tokens] of calls) {
    if (!tokens.includes(token)) continue;
    const aps = notification.aps as { 'content-state'?: LiveActivityContentState & Record<string, unknown> };
    return aps['content-state'];
  }
  return undefined;
}

async function tokensForSession(sessionId: string): Promise<string[]> {
  const rows = await db
    .select({ token: activityPushTokens.token })
    .from(activityPushTokens)
    .where(eq(activityPushTokens.sessionId, sessionId));
  return rows.map((r) => r.token).sort();
}

// Tiny test-only debounce/retry windows. Real production values are 1_000 ms
// debounce + [1_000, 3_000, 8_000] ms retry array — we shrink them via
// __setApnsTimingForTests so we can use real timers instead of fake timers
// (faking setTimeout would deadlock postgres-js's connection pool).
const TEST_DEBOUNCE_MS = 25;
const TEST_DB_RETRY_DELAYS_MS = [10] as const;
// Generous slack on top of debounce + retry windows so parallel DB deletes
// (Promise.all over up to 6 staleTokenDeletions) all finish before assertions.
const SETTLE_SLACK_MS = 300;

function waitForSettle(extraMs = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_SLACK_MS + extraMs));
}

const sampleContentState: LiveActivityContentState = {
  climbName: 'Test Climb',
  climbDifficulty: 'V5',
  angle: 40,
  currentIndex: 0,
  totalClimbs: 5,
  hasNext: true,
  hasPrevious: false,
  climbUuid: 'climb-uuid-1',
};

describe('APNs Live Activity service', () => {
  let envSnapshot: Record<string, string | undefined>;
  let apns: ApnsModule;

  beforeAll(async () => {
    // Reset modules once so the dynamic import below resolves
    // `import apn from '@parse/node-apn'` through the vi.mock factory above.
    // The mocked module is cached for the rest of the file; subsequent tests
    // share the same SUT instance and rely on __resetApnsForTests for cleanup.
    vi.resetModules();
    apns = await loadApns();
  });

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    apns.__resetApnsForTests();
    apns.__setApnsTimingForTests({ debounceMs: TEST_DEBOUNCE_MS, dbRetryDelaysMs: TEST_DB_RETRY_DELAYS_MS });
    vi.clearAllMocks();
    mockSend.mockImplementation(async () => ({ sent: [], failed: [] }));
  });

  afterEach(async () => {
    await apns.shutdownApns();
    apns.__resetApnsForTests();
    restoreEnv(envSnapshot);
  });

  describe('initializeApns', () => {
    it('returns disabled when APNS_BUNDLE_ID is missing', () => {
      setApnsEnv({ APNS_BUNDLE_ID: undefined });
      apns.initializeApns();
      expect(apns.isApnsConfigured()).toBe(false);
      expect(ProviderCtor).not.toHaveBeenCalled();
    });

    it('initializes the provider when every required env var is set', () => {
      setApnsEnv();
      apns.initializeApns();
      expect(apns.isApnsConfigured()).toBe(true);
      expect(ProviderCtor).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendLiveActivityUpdate', () => {
    it('is a no-op when APNs is not configured', async () => {
      apns.sendLiveActivityUpdate('session-noconfig', sampleContentState);
      await waitForSettle();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('debounces multiple calls within DEBOUNCE_MS to a single send with the latest state', async () => {
      const sessionId = 'session-debounce';
      setApnsEnv();
      apns.initializeApns();
      await insertSession(sessionId);
      await insertTokens(sessionId, ['debounce-token-1', 'debounce-token-2']);

      apns.sendLiveActivityUpdate(sessionId, { ...sampleContentState, currentIndex: 0 });
      apns.sendLiveActivityUpdate(sessionId, { ...sampleContentState, currentIndex: 1 });
      apns.sendLiveActivityUpdate(sessionId, { ...sampleContentState, currentIndex: 2 });

      await waitForSettle();

      expect(mockSend).toHaveBeenCalledTimes(1);
      const [notification, tokens] = mockSend.mock.calls[0];
      const aps = notification.aps as { 'content-state'?: LiveActivityContentState; event?: string };
      expect(aps['content-state']?.currentIndex).toBe(2);
      expect(aps.event).toBe('update');
      expect([...tokens].sort()).toEqual(['debounce-token-1', 'debounce-token-2']);
    });
  });

  describe('executeDebouncedSend retry', () => {
    it('retries on transient DB failure then sends successfully', async () => {
      const sessionId = 'session-retry-succeed';
      setApnsEnv();
      apns.initializeApns();
      await insertSession(sessionId);
      await insertTokens(sessionId, ['retry-token']);

      const selectSpy = vi.spyOn(db, 'select').mockImplementationOnce(() => {
        throw new Error('transient DB failure');
      });

      try {
        apns.sendLiveActivityUpdate(sessionId, sampleContentState);
        // Wait long enough for debounce + every retry-delay slot to elapse.
        const retryBudget = TEST_DB_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
        await waitForSettle(TEST_DEBOUNCE_MS + retryBudget);

        expect(mockSend).toHaveBeenCalledTimes(1);
        const [, tokens] = mockSend.mock.calls[0];
        expect(tokens).toEqual(['retry-token']);
      } finally {
        selectSpy.mockRestore();
      }
    });

    it('requeues with a fresh retry counter after exhausting the retry schedule', async () => {
      // After the SUT walks the whole DB_RETRY_DELAYS_MS schedule with every
      // attempt still failing, it requeues the latest state instead of
      // dropping the update outright. That bounds the user-visible regression
      // to one more debounce window rather than waiting for the 90 s heartbeat.
      const sessionId = 'session-retry-requeue';
      setApnsEnv();
      apns.initializeApns();
      await insertSession(sessionId);
      await insertTokens(sessionId, ['requeue-token']);

      const selectSpy = vi.spyOn(db, 'select').mockImplementation(() => {
        throw new Error('DB unavailable');
      });

      try {
        apns.sendLiveActivityUpdate(sessionId, sampleContentState);
        // Wait long enough for one full debounce → all retries → give-up cycle.
        const retryBudget = TEST_DB_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
        await waitForSettle(TEST_DEBOUNCE_MS + retryBudget);

        expect(mockSend).not.toHaveBeenCalled();
        // SUT requeued — a new debounce window is in flight for this session.
        expect(apns.hasPendingSend(sessionId)).toBe(true);
      } finally {
        // Halt the requeue loop *before* restoring the spy so the next cycle
        // doesn't race the test teardown by succeeding against a real DB call.
        apns.__resetApnsForTests();
        selectSpy.mockRestore();
      }
    });
  });

  describe('stale token cleanup', () => {
    it('deletes tokens for 410 / BadDeviceToken / Unregistered / ExpiredToken; leaves others intact', async () => {
      const sessionId = 'session-stale';
      setApnsEnv();
      apns.initializeApns();
      await insertSession(sessionId);
      const seeded = [
        'stale-status-410',
        'stale-bad-device',
        'stale-unregistered',
        'stale-expired',
        'live-token-500',
        'live-token-sent',
      ];
      await insertTokens(sessionId, seeded);

      mockSend.mockImplementationOnce(async () => ({
        sent: [{ device: 'live-token-sent' }],
        failed: [
          { device: 'stale-status-410', status: 410, response: { reason: undefined } },
          { device: 'stale-bad-device', status: 400, response: { reason: 'BadDeviceToken' } },
          { device: 'stale-unregistered', status: 410, response: { reason: 'Unregistered' } },
          { device: 'stale-expired', status: 410, response: { reason: 'ExpiredToken' } },
          { device: 'live-token-500', status: 500, response: { reason: 'InternalServerError' } },
        ],
      }));

      apns.sendLiveActivityUpdate(sessionId, sampleContentState);
      await waitForSettle();

      expect(mockSend).toHaveBeenCalledTimes(1);
      const remaining = await tokensForSession(sessionId);
      expect(remaining).toEqual(['live-token-500', 'live-token-sent'].sort());
    });
  });

  describe('endLiveActivity', () => {
    it('cancels a pending debounce so no update is sent, only the end event', async () => {
      const sessionId = 'session-end-cancels';
      setApnsEnv();
      apns.initializeApns();
      await insertSession(sessionId);
      await insertTokens(sessionId, ['end-cancel-token']);

      apns.sendLiveActivityUpdate(sessionId, sampleContentState);
      await apns.endLiveActivity(sessionId);

      // Wait past the debounce window — if cancellation failed, a second
      // (`update`) send would fire here.
      await waitForSettle();

      expect(mockSend).toHaveBeenCalledTimes(1);
      const [notification] = mockSend.mock.calls[0];
      const aps = notification.aps as { event?: string };
      expect(aps.event).toBe('end');
    });

    it('cleans up all push tokens for the session after the end push', async () => {
      const sessionId = 'session-end-cleanup';
      setApnsEnv();
      apns.initializeApns();
      await insertSession(sessionId);
      await insertTokens(sessionId, ['cleanup-token-a', 'cleanup-token-b']);

      await apns.endLiveActivity(sessionId);
      const remaining = await tokensForSession(sessionId);
      expect(remaining).toEqual([]);
    });
  });

  describe('cleanupTokensForSession (via endLiveActivity)', () => {
    it('only deletes tokens for the given session', async () => {
      const sessionA = 'session-isolation-A';
      const sessionB = 'session-isolation-B';
      setApnsEnv();
      apns.initializeApns();
      await insertSession(sessionA);
      await insertSession(sessionB);
      await insertTokens(sessionA, ['iso-token-A1', 'iso-token-A2']);
      await insertTokens(sessionB, ['iso-token-B1']);

      await apns.endLiveActivity(sessionA);

      const rowsB = await tokensForSession(sessionB);
      expect(rowsB).toEqual(['iso-token-B1']);

      const remainingA = await db
        .select({ token: activityPushTokens.token })
        .from(activityPushTokens)
        .where(inArray(activityPushTokens.token, ['iso-token-A1', 'iso-token-A2']));
      expect(remainingA).toEqual([]);
    });
  });

  describe('per-token board-connection grouping', () => {
    it('omits boardConnection and sends a single group when no holder resolver is wired', async () => {
      const sessionId = 'session-no-resolver';
      setApnsEnv();
      apns.initializeApns();
      await insertSession(sessionId);
      await insertTokens(sessionId, ['group-none-1', 'group-none-2']);

      apns.sendLiveActivityUpdate(sessionId, sampleContentState);
      await waitForSettle();

      expect(mockSend).toHaveBeenCalledTimes(1);
      const state = contentStateForToken(mockSend.mock.calls, 'group-none-1');
      expect(state?.boardConnection).toBeUndefined();
      expect(state?.holderDisplayName).toBeUndefined();
    });

    it('splits into connectedByMe (holder) and heldByPeer (others) groups', async () => {
      const sessionId = 'session-grouping';
      const holderUserId = 'holder-user';
      const peerUserId = 'peer-user';
      setApnsEnv();
      apns.initializeApns();
      await insertSession(sessionId);
      await insertUser(holderUserId);
      await insertUser(peerUserId);
      await insertTokenForUser(sessionId, 'holder-token', holderUserId);
      await insertTokenForUser(sessionId, 'peer-token', peerUserId);
      await insertTokenForUser(sessionId, 'anon-token', null);

      apns.setSessionHolderResolver(async () => ({ holderUserId, holderDisplayName: 'Holder Name' }));

      apns.sendLiveActivityUpdate(sessionId, sampleContentState);
      await waitForSettle();

      // Two distinct states: connectedByMe (holder's device) + heldByPeer (the
      // rest), so exactly two grouped sends.
      expect(mockSend).toHaveBeenCalledTimes(2);

      const holderState = contentStateForToken(mockSend.mock.calls, 'holder-token');
      expect(holderState?.boardConnection).toBe('connectedByMe');
      expect(holderState?.holderDisplayName).toBeUndefined();

      const peerState = contentStateForToken(mockSend.mock.calls, 'peer-token');
      expect(peerState?.boardConnection).toBe('heldByPeer');
      expect(peerState?.holderDisplayName).toBe('Holder Name');

      // The anonymous (null-userId) token can't be the holder → heldByPeer too,
      // and should ride in the SAME group as the peer (same derived state).
      const anonState = contentStateForToken(mockSend.mock.calls, 'anon-token');
      expect(anonState?.boardConnection).toBe('heldByPeer');
      expect(anonState?.holderDisplayName).toBe('Holder Name');
    });

    it('sends a single disconnected group when the resolver reports no holder', async () => {
      const sessionId = 'session-disconnected';
      setApnsEnv();
      apns.initializeApns();
      await insertSession(sessionId);
      await insertUser('disc-user');
      await insertTokenForUser(sessionId, 'disc-token-1', 'disc-user');
      await insertTokenForUser(sessionId, 'disc-token-2', null);

      apns.setSessionHolderResolver(async () => ({ holderUserId: null, holderDisplayName: null }));

      apns.sendLiveActivityUpdate(sessionId, sampleContentState);
      await waitForSettle();

      expect(mockSend).toHaveBeenCalledTimes(1);
      const state = contentStateForToken(mockSend.mock.calls, 'disc-token-1');
      expect(state?.boardConnection).toBe('disconnected');
      expect(state?.holderDisplayName).toBeUndefined();
    });

    it('falls back to a single boardConnection-omitted send when the resolver throws', async () => {
      const sessionId = 'session-resolver-throws';
      setApnsEnv();
      apns.initializeApns();
      await insertSession(sessionId);
      await insertTokens(sessionId, ['throw-token-1', 'throw-token-2']);

      apns.setSessionHolderResolver(async () => {
        throw new Error('redis down');
      });

      apns.sendLiveActivityUpdate(sessionId, sampleContentState);
      await waitForSettle();

      expect(mockSend).toHaveBeenCalledTimes(1);
      const state = contentStateForToken(mockSend.mock.calls, 'throw-token-1');
      expect(state?.boardConnection).toBeUndefined();
    });
  });
});
