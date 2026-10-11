import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const posthogMocks = vi.hoisted(() => ({
  captureBackendEvent: vi.fn(),
}));

// The real hashSessionIdForAnalytics, so the salt contract is tested end to end.
vi.mock('../services/analytics/posthog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/analytics/posthog')>()),
  captureBackendEvent: posthogMocks.captureBackendEvent,
}));

// Matches apns-analytics.test.ts: reset + dynamic import so the hoisted mock is
// the module the subject binds to. A static top-level import binds the real one.
async function loadLiveActivityModule(): Promise<typeof import('../services/analytics/live-activity')> {
  vi.resetModules();
  return import('../services/analytics/live-activity');
}

function pushDelivery(overrides: { failedCount?: number; staleCount?: number } = {}) {
  return {
    sessionId: 'session-1',
    event: 'update' as const,
    source: 'heartbeat' as const,
    tokenCount: 3,
    sentCount: 3,
    failedCount: 0,
    staleCount: 0,
    elapsedMs: 42,
    ...overrides,
  };
}

describe('trackLiveActivityPushDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not capture a delivery where nothing failed or went stale', async () => {
    const { trackLiveActivityPushDelivery } = await loadLiveActivityModule();
    trackLiveActivityPushDelivery(pushDelivery());

    expect(posthogMocks.captureBackendEvent).not.toHaveBeenCalled();
  });

  it('captures a delivery with failures', async () => {
    const { trackLiveActivityPushDelivery } = await loadLiveActivityModule();
    trackLiveActivityPushDelivery(pushDelivery({ failedCount: 2 }));

    expect(posthogMocks.captureBackendEvent).toHaveBeenCalledWith(
      'Live Activity Push Delivery',
      expect.objectContaining({
        properties: expect.objectContaining({ failedCount: 2, staleCount: 0 }),
      }),
    );
  });

  it('captures a delivery with stale tokens', async () => {
    const { trackLiveActivityPushDelivery } = await loadLiveActivityModule();
    trackLiveActivityPushDelivery(pushDelivery({ staleCount: 1 }));

    expect(posthogMocks.captureBackendEvent).toHaveBeenCalledWith(
      'Live Activity Push Delivery',
      expect.objectContaining({
        properties: expect.objectContaining({ failedCount: 0, staleCount: 1 }),
      }),
    );
  });
});

// GDPR (#2644): Live Activity telemetry is operational and sent whatever a
// climber's consent, so no event may name a user. The posthog helper enforces
// the distinct id and person profile; this pins that no call site even tries.
async function captureEveryEvent(): Promise<void> {
  const analytics = await loadLiveActivityModule();
  analytics.trackLiveActivityStarted({
    sessionId: 'session-1',
    tokenLength: 64,
    apnsConfigured: true,
    tokenPreviouslyRegistered: false,
    tokenRebound: false,
  });
  analytics.trackLiveActivityEnded({ sessionId: 'session-1', reason: 'unregister' });
  analytics.trackLiveActivityEndedAttributionGap({
    sessionId: 'session-1',
    reason: 'missing_user_id',
    tokenCount: 1,
  });
  analytics.trackLiveActivityWidgetNavigation({
    sessionId: 'session-1',
    action: 'next',
    outcome: 'success',
    statusCode: 200,
    boundSessionId: 'session-2',
  });
  analytics.trackLiveActivityWidgetNavigationAttributionGap({
    sessionId: 'session-1',
    action: 'next',
    outcome: 'success',
    statusCode: 200,
    reason: 'missing_user_id',
    boundSessionId: 'session-2',
  });
  analytics.trackLiveActivityPushDelivery(pushDelivery({ failedCount: 1 }));
  analytics.trackLiveActivityPushDeliveryAttributionGap({
    ...pushDelivery({ failedCount: 1 }),
    reason: 'missing_user_id',
  });
}

function capturedProperties(): Array<{ event: string; properties: Record<string, unknown> }> {
  return posthogMocks.captureBackendEvent.mock.calls.map(([event, options]) => ({
    event: event as string,
    properties: (options as { properties: Record<string, unknown> }).properties,
  }));
}

const hmac = (salt: string, value: string) => createHmac('sha256', salt).update(value).digest('hex');

describe('Live Activity session hash', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends a salted SHA-256 of the session id on every event when the salt is set', async () => {
    vi.stubEnv('POSTHOG_SESSION_HASH_SALT', 'test-salt');
    await captureEveryEvent();

    const captured = capturedProperties();
    expect(captured).toHaveLength(7);
    for (const { properties } of captured) {
      expect(properties.sessionHash).toBe(hmac('test-salt', 'session-1'));
      expect(properties.sessionHash).not.toContain('session-1');
    }
    const navigation = captured.filter(({ event }) => event.startsWith('Live Activity Widget Navigation'));
    expect(navigation).toHaveLength(2);
    for (const { properties } of navigation) {
      expect(properties.boundSessionHash).toBe(hmac('test-salt', 'session-2'));
    }
  });

  it('omits the hash when no salt is configured', async () => {
    vi.stubEnv('POSTHOG_SESSION_HASH_SALT', '');
    await captureEveryEvent();

    for (const { properties } of capturedProperties()) {
      expect(properties.sessionHash).toBeUndefined();
      expect(properties.boundSessionHash).toBeUndefined();
    }
  });
});

describe('Live Activity events carry no user identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes neither a distinct id nor a user id for any event', async () => {
    vi.stubEnv('POSTHOG_SESSION_HASH_SALT', 'test-salt');
    await captureEveryEvent();
    vi.unstubAllEnvs();

    expect(posthogMocks.captureBackendEvent).toHaveBeenCalledTimes(7);
    for (const [, options] of posthogMocks.captureBackendEvent.mock.calls) {
      expect(options).not.toHaveProperty('distinctId');
      expect(options).not.toHaveProperty('systemDistinctId');
      const { properties } = options as { properties: Record<string, unknown> };
      expect(properties).not.toHaveProperty('userId');
      expect(properties).not.toHaveProperty('sessionId');
      expect(properties).not.toHaveProperty('boundSessionId');
      // The raw ids never ride along under another name.
      expect(JSON.stringify(properties)).not.toMatch(/session-[12]/);
    }
  });
});
