import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const apnsMocks = vi.hoisted(() => ({
  Provider: vi.fn(),
  Notification: vi.fn(),
  send: vi.fn(),
  shutdown: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  tokenRows: vi.fn<() => Array<{ token: string; userId: string | null }>>(() => []),
  deleteWhere: vi.fn(async () => undefined),
}));

const analyticsMocks = vi.hoisted(() => ({
  trackLiveActivityEnded: vi.fn(),
  trackLiveActivityEndedAttributionGap: vi.fn(),
  trackLiveActivityPushDelivery: vi.fn(),
  trackLiveActivityPushDeliveryAttributionGap: vi.fn(),
}));

vi.mock('@parse/node-apn', () => ({
  default: {
    Provider: apnsMocks.Provider,
    Notification: apnsMocks.Notification,
  },
}));

vi.mock('../db/client', () => {
  function makeSelectChain() {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(async () => dbMocks.tokenRows());
    return chain;
  }

  return {
    db: {
      select: vi.fn(() => makeSelectChain()),
      delete: vi.fn(() => ({ where: dbMocks.deleteWhere })),
    },
  };
});

vi.mock('../services/analytics/live-activity', () => analyticsMocks);
// Transport/analytics tests keep authorization in the real-DB APNs suite.
vi.mock('../services/privacy', () => ({
  canAccessResource: async () => true,
  canViewActivityIdentity: async () => true,
}));
vi.mock('../services/board-session-privacy', () => ({ canReadClimbContent: async () => true }));

async function loadApnsModule(): Promise<typeof import('../services/apns')> {
  vi.resetModules();
  const apnsModule = await import('../services/apns');
  apnsModule.__resetApnsForTests();
  return apnsModule;
}

function stubApnsEnv(): void {
  vi.stubEnv('APNS_KEY_ID', 'key-id');
  vi.stubEnv('APNS_TEAM_ID', 'team-id');
  vi.stubEnv('APNS_KEY_CONTENTS', Buffer.from('test-key').toString('base64'));
  vi.stubEnv('APNS_BUNDLE_ID', 'com.boardsesh.test');
  vi.stubEnv('APNS_PRODUCTION', 'true');
}

describe('APNs analytics instrumentation', () => {
  const TOKEN_ONE = 'a'.repeat(64);
  const TOKEN_TWO = 'b'.repeat(64);
  const TOKEN_THREE = 'c'.repeat(64);
  const TOKEN_FOUR = 'd'.repeat(64);
  const SESSION_ID = 'session-apns-analytics';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    apnsMocks.Provider.mockImplementation(function MockProvider() {
      return {
        send: apnsMocks.send,
        shutdown: apnsMocks.shutdown,
      };
    });
    apnsMocks.Notification.mockImplementation(function MockNotification() {
      return {};
    });
    apnsMocks.send.mockResolvedValue({ sent: [{ device: TOKEN_ONE }], failed: [] });
    dbMocks.tokenRows.mockReturnValue([]);
  });

  it('tracks per-user delivery for immediate Live Activity updates', async () => {
    stubApnsEnv();
    const { initializeApns, sendLiveActivityUpdateToTokens } = await loadApnsModule();
    initializeApns();

    await sendLiveActivityUpdateToTokens(
      SESSION_ID,
      [{ token: TOKEN_ONE, userId: 'user-1' }],
      {
        climbName: 'Hidden from analytics',
        climbDifficulty: 'V5',
        angle: 40,
        currentIndex: 0,
        totalClimbs: 1,
        hasNext: false,
        hasPrevious: false,
        climbUuid: 'climb-1',
      },
      { source: 'registration' },
    );

    expect(analyticsMocks.trackLiveActivityPushDelivery).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      event: 'update',
      source: 'registration',
      tokenCount: 1,
      sentCount: 1,
      failedCount: 0,
      staleCount: 0,
      elapsedMs: expect.any(Number),
    });
  });

  it('tracks delivery counts separately by recipient user', async () => {
    stubApnsEnv();
    apnsMocks.send.mockResolvedValue({
      sent: [{ device: TOKEN_ONE }, { device: TOKEN_THREE }],
      failed: [
        { device: TOKEN_TWO, status: 410, response: { reason: 'Unregistered' } },
        { device: TOKEN_FOUR, status: 500, response: { reason: 'InternalServerError' } },
      ],
    });
    const { initializeApns, sendLiveActivityUpdateToTokens } = await loadApnsModule();
    initializeApns();

    await sendLiveActivityUpdateToTokens(
      SESSION_ID,
      [
        { token: TOKEN_ONE, userId: 'user-1' },
        { token: TOKEN_TWO, userId: 'user-1' },
        { token: TOKEN_THREE, userId: 'user-2' },
        { token: TOKEN_FOUR, userId: null },
      ],
      {
        climbName: 'Hidden from analytics',
        climbDifficulty: 'V5',
        angle: 40,
        currentIndex: 0,
        totalClimbs: 1,
        hasNext: false,
        hasPrevious: false,
        climbUuid: 'climb-1',
      },
      { source: 'registration' },
    );

    expect(analyticsMocks.trackLiveActivityPushDelivery).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      event: 'update',
      source: 'registration',
      tokenCount: 2,
      sentCount: 1,
      failedCount: 1,
      staleCount: 1,
      elapsedMs: expect.any(Number),
    });
    expect(analyticsMocks.trackLiveActivityPushDelivery).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      event: 'update',
      source: 'registration',
      tokenCount: 1,
      sentCount: 1,
      failedCount: 0,
      staleCount: 0,
      elapsedMs: expect.any(Number),
    });
    expect(analyticsMocks.trackLiveActivityPushDeliveryAttributionGap).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      event: 'update',
      source: 'registration',
      reason: 'missing_user_id',
      tokenCount: 1,
      sentCount: 0,
      failedCount: 1,
      staleCount: 0,
      elapsedMs: expect.any(Number),
    });
  });

  it('does not track delivery when there are no target tokens', async () => {
    stubApnsEnv();
    const { initializeApns, sendLiveActivityUpdateToTokens } = await loadApnsModule();
    initializeApns();

    await sendLiveActivityUpdateToTokens(
      SESSION_ID,
      [],
      {
        climbName: 'Hidden from analytics',
        climbDifficulty: 'V5',
        angle: 40,
        currentIndex: 0,
        totalClimbs: 1,
        hasNext: false,
        hasPrevious: false,
        climbUuid: 'climb-1',
      },
      { source: 'registration' },
    );

    expect(apnsMocks.send).not.toHaveBeenCalled();
    expect(analyticsMocks.trackLiveActivityPushDelivery).not.toHaveBeenCalled();
    expect(analyticsMocks.trackLiveActivityPushDeliveryAttributionGap).not.toHaveBeenCalled();
  });

  it('tracks one session-ended event per attributed user when ending Live Activities', async () => {
    stubApnsEnv();
    dbMocks.tokenRows.mockReturnValue([
      { token: TOKEN_ONE, userId: 'user-1' },
      { token: TOKEN_TWO, userId: 'user-1' },
      { token: TOKEN_THREE, userId: null },
    ]);
    apnsMocks.send.mockResolvedValue({
      sent: [{ device: TOKEN_ONE }, { device: TOKEN_TWO }, { device: TOKEN_THREE }],
      failed: [],
    });
    const { initializeApns, endLiveActivity } = await loadApnsModule();
    initializeApns();

    await endLiveActivity(SESSION_ID);

    expect(analyticsMocks.trackLiveActivityPushDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        event: 'end',
        source: 'event',
        tokenCount: 2,
        sentCount: 2,
        failedCount: 0,
      }),
    );
    expect(analyticsMocks.trackLiveActivityPushDeliveryAttributionGap).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        event: 'end',
        source: 'event',
        reason: 'missing_user_id',
        tokenCount: 1,
        sentCount: 1,
        failedCount: 0,
      }),
    );
    expect(analyticsMocks.trackLiveActivityEnded).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      reason: 'session-ended',
      tokenCount: 2,
    });
    expect(analyticsMocks.trackLiveActivityEndedAttributionGap).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      reason: 'missing_user_id',
      tokenCount: 1,
    });
    expect(analyticsMocks.trackLiveActivityEnded).toHaveBeenCalledTimes(1);
  });
});
