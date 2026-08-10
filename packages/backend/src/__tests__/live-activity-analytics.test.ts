import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const posthogMocks = vi.hoisted(() => ({
  captureBackendEvent: vi.fn(),
}));

vi.mock('../services/analytics/posthog', () => ({
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
    userId: 'user-1',
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
        distinctId: 'user-1',
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
