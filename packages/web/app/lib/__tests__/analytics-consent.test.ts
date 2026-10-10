import { beforeEach, afterEach, describe, it, expect, vi } from 'vite-plus/test';
import type { PostHog } from 'posthog-js-lite';
const harness = vi.hoisted(() => ({
  granted: false,
  deviceGranted: null as boolean | null,
  change: (() => {}) as () => void,
  clients: [] as Array<PostHog>,
  constructors: vi.fn(),
  network: vi.fn(async () => ({ status: 200, text: async () => '', json: async () => ({}) })),
}));
vi.mock('../consent', () => ({
  hasAnalyticsConsent: () => harness.granted,
  getWebConsentRecord: () =>
    (harness.deviceGranted ?? harness.granted)
      ? { analytics: 'granted', version: 1, source: 'web', decidedAt: '2026-10-08T00:00:00Z' }
      : null,
  subscribeWebConsent: (listener: () => void) => {
    harness.change = listener;
    return () => {};
  },
}));
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }));
vi.mock('posthog-js-lite', () => ({
  PostHog: function FakePostHog(_apiKey: string, options: unknown) {
    harness.constructors(options);
    const client = {
      capture: vi.fn(),
      identify: vi.fn(),
      reset: vi.fn(),
      setPersonProperties: vi.fn(),
      register: vi.fn(async () => {}),
      fetch: harness.network,
      optIn: vi.fn(async () => {}),
      optOut: vi.fn(async () => {}),
      setPersistedProperty: vi.fn(),
      reloadFeatureFlags: vi.fn(),
      onFeatureFlags: vi.fn(() => () => {}),
      shutdown: vi.fn(async () => {}),
    } as unknown as PostHog;
    harness.clients.push(client);
    return client;
  },
}));
const originalLocation = window.location;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  harness.granted = false;
  harness.deviceGranted = null;
  harness.clients.length = 0;
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'test');
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://posthog.test');
  Object.defineProperty(window, 'location', { configurable: true, value: new URL('https://boardsesh.com/') });
});
afterEach(() => {
  vi.unstubAllEnvs();
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});
describe('web analytics consent lifecycle', () => {
  it('preserves consented acquisition and conversions through anonymous sign-in authority checks', async () => {
    harness.granted = true;
    harness.deviceGranted = true;
    const analytics = await import('../analytics');
    analytics.track('Signup Completed');
    const acquisitionClient = harness.clients[0];
    harness.granted = false;
    harness.change();
    analytics.setAnalyticsFlagAccountId('account-a');
    expect(acquisitionClient.reset).not.toHaveBeenCalled();
    expect(acquisitionClient.setPersistedProperty).not.toHaveBeenCalled();
    analytics.track('While account is unresolved');
    expect(acquisitionClient.capture).toHaveBeenCalledTimes(1);
    await expect(
      acquisitionClient.fetch('https://posthog.test/batch/', { method: 'POST', headers: {} }),
    ).rejects.toThrow();
    harness.granted = true;
    harness.change();
    analytics.identify('account-a');
    analytics.track('After sign-in');
    expect(acquisitionClient.identify).toHaveBeenCalledWith('account-a', undefined);
    expect(acquisitionClient.capture).toHaveBeenLastCalledWith('After sign-in', undefined);
    expect(acquisitionClient.reset).not.toHaveBeenCalled();
    await acquisitionClient.fetch('https://posthog.test/batch/', { method: 'POST', headers: {} });
    expect(harness.network).toHaveBeenCalledOnce();
  });

  it.each(['withdrawal', 'account-switch', 'sign-out'] as const)(
    'discards suspended acquisition on %s instead of resuming another account queue',
    async (transition) => {
      harness.granted = true;
      harness.deviceGranted = true;
      const analytics = await import('../analytics');
      analytics.setAnalyticsFlagAccountId('account-a');
      analytics.track('Before authority hold');
      const acquisitionClient = harness.clients[0];
      const storageWrites = acquisitionClient.setPersistedProperty;
      harness.granted = false;
      harness.change();
      if (transition === 'withdrawal') {
        harness.deviceGranted = false;
        harness.change();
      } else {
        analytics.setAnalyticsFlagAccountId(transition === 'account-switch' ? 'account-b' : null);
      }
      expect(acquisitionClient.reset).toHaveBeenCalled();
      expect(storageWrites).toHaveBeenCalledWith('queue', null);
      harness.deviceGranted = true;
      harness.granted = true;
      harness.change();
      analytics.track('Later consent');
      expect(acquisitionClient.capture).toHaveBeenCalledTimes(1);
      await expect(
        acquisitionClient.fetch('https://posthog.test/batch/', { method: 'POST', headers: {} }),
      ).rejects.toThrow();
    },
  );

  it('keeps flags live in memory while every product entrypoint sends nothing', async () => {
    const analytics = await import('../analytics');
    analytics.readPosthogFeatureFlags(['gym-kiosk']);
    expect(harness.constructors).toHaveBeenCalledWith(
      expect.objectContaining({ persistence: 'memory', defaultOptIn: false }),
    );
    analytics.track('Before consent');
    analytics.pageview('/');
    expect(analytics.identify('account')).toBe(false);
    expect(analytics.capturePosthog('$web_vitals')).toBe(false);
    expect(analytics.setPersonProperties({ email: 'private@example.com' })).toBe(false);
    await analytics.trackBeforeNavigation('Before navigation');
    expect(harness.clients[0].capture).not.toHaveBeenCalled();
    expect(harness.clients[0].identify).not.toHaveBeenCalled();
  });
  it('replaces persistence and rebinds flag listeners on grant and withdrawal', async () => {
    const analytics = await import('../analytics');
    const flagsChanged = vi.fn();
    analytics.subscribePosthogFeatureFlags(flagsChanged);
    const before = flagsChanged.mock.calls.length;
    harness.granted = true;
    harness.change();
    expect(harness.constructors).toHaveBeenLastCalledWith(expect.objectContaining({ persistence: 'localStorage' }));
    expect(harness.clients[1].optIn).toHaveBeenCalled();
    expect(flagsChanged.mock.calls.length).toBeGreaterThan(before);
    analytics.track('Allowed');
    expect(harness.clients[1].capture).toHaveBeenCalledWith('Allowed', undefined);
    const storageWrites = harness.clients[1].setPersistedProperty;
    harness.granted = false;
    harness.change();
    const retired = harness.clients[1];
    for (const key of ['queue', 'ai_queue', 'ai_capture_queue', 'logs_queue'])
      expect(storageWrites).toHaveBeenCalledWith(key, null);
    // Retired storage writes are replaced so a late flush cannot resurrect the old blob.
    expect(
      retired.setPersistedProperty('queue' as Parameters<PostHog['setPersistedProperty']>[0], null),
    ).toBeUndefined();
    expect(retired.reset).toHaveBeenCalledWith([]);
    expect(retired.optOut).toHaveBeenCalledTimes(2);
    expect(harness.constructors).toHaveBeenLastCalledWith(expect.objectContaining({ persistence: 'memory' }));
    await expect(retired.fetch('https://posthog.test/batch/', { method: 'POST', headers: {} })).rejects.toThrow(
      'consent',
    );
    expect(harness.network).not.toHaveBeenCalled();
  });
  it('permits only flags traffic on the opted-out client', async () => {
    const analytics = await import('../analytics');
    analytics.readPosthogFeatureFlags([]);
    const client = harness.clients[0];
    await client.fetch('https://posthog.test/flags/?v=2', { method: 'POST', headers: {} });
    await expect(client.fetch('https://posthog.test/batch/', { method: 'POST', headers: {} })).rejects.toThrow(
      'consent',
    );
    expect(harness.network).toHaveBeenCalledOnce();
  });
  it('keeps the grant after identity reset on sign-out', async () => {
    harness.granted = true;
    const analytics = await import('../analytics');
    analytics.track('Allowed');
    analytics.reset();
    expect(harness.clients[0].optIn).toHaveBeenCalledTimes(2);
    analytics.track('After signout');
    expect(harness.clients[0].capture).toHaveBeenLastCalledWith('After signout', undefined);
  });
  it.each(['/embed/board/test', '/es/kiosk/one'])('never uses product analytics on %s', async (pathname) => {
    harness.granted = true;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new URL(`https://boardsesh.com${pathname}`),
    });
    const analytics = await import('../analytics');
    analytics.track('Excluded');
    analytics.pageview(pathname);
    expect(analytics.identify('account')).toBe(false);
    expect(harness.constructors).not.toHaveBeenCalled();
  });
});
