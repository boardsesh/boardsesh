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
  const marked = { 'x-boardsesh-analytics-consent': 'granted' };
  it.each([
    ['the derived backend proxy', '', 'https://ws.boardsesh.com/api/posthog', marked],
    [
      'an override naming the backend proxy',
      'https://ws.boardsesh.com/api/posthog/',
      'https://ws.boardsesh.com/api/posthog/',
      marked,
    ],
    ['a direct PostHog override', 'https://posthog.test', 'https://posthog.test', {}],
    [
      'another path on the backend',
      'https://ws.boardsesh.com/api/posthog/extra',
      'https://ws.boardsesh.com/api/posthog/extra',
      {},
    ],
    [
      'another host with the same path',
      'https://api.boardsesh.com/api/posthog',
      'https://api.boardsesh.com/api/posthog',
      {},
    ],
  ])(
    'consent header for %s: only our exact proxy hears consented capture, never flags or config',
    async (_label, override, host, consentHeader) => {
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', override);
      harness.granted = true;
      const analytics = await import('../analytics');
      analytics.readPosthogFeatureFlags([]);
      expect(harness.constructors).toHaveBeenLastCalledWith(expect.objectContaining({ host }));
      const client = harness.clients[0];
      const headers = { 'Content-Type': 'application/json' };
      const base = host.replace(/\/$/, '');
      await client.fetch(`${base}/batch/`, { method: 'POST', headers });
      await client.fetch(`${base}/flags/?v=2`, { method: 'POST', headers });
      await client.fetch(`${base}/array/phc_test/config`, { method: 'GET', headers });
      expect(harness.network).toHaveBeenNthCalledWith(
        1,
        `${base}/batch/`,
        expect.objectContaining({ headers: { ...headers, ...consentHeader } }),
      );
      expect(harness.network).toHaveBeenNthCalledWith(2, `${base}/flags/?v=2`, expect.objectContaining({ headers }));
      expect(harness.network).toHaveBeenNthCalledWith(
        3,
        `${base}/array/phc_test/config`,
        expect.objectContaining({ headers }),
      );
    },
  );
  it('recognises the backend proxy by exact origin and path only', async () => {
    const { isBackendPosthogProxy } = await import('../analytics');
    const backend = 'https://ws.boardsesh.com';
    expect(isBackendPosthogProxy('https://ws.boardsesh.com/api/posthog', backend)).toBe(true);
    expect(isBackendPosthogProxy('https://ws.boardsesh.com/api/posthog/', backend)).toBe(true);
    expect(isBackendPosthogProxy('https://WS.boardsesh.com/api/posthog', backend)).toBe(true);
    expect(isBackendPosthogProxy('https://ws.boardsesh.com/api/posthog/v2', backend)).toBe(false);
    expect(isBackendPosthogProxy('https://ws.boardsesh.com/proxy/api/posthog', backend)).toBe(false);
    expect(isBackendPosthogProxy('http://ws.boardsesh.com/api/posthog', backend)).toBe(false);
    expect(isBackendPosthogProxy('https://ws.boardsesh.com.evil.test/api/posthog', backend)).toBe(false);
    expect(isBackendPosthogProxy('https://us.i.posthog.com', backend)).toBe(false);
    expect(isBackendPosthogProxy('not a url', backend)).toBe(false);
    expect(isBackendPosthogProxy('https://ws.boardsesh.com/api/posthog', null)).toBe(false);
  });
  it('buckets signed-out flags on one browser id before and after Allow', async () => {
    const analytics = await import('../analytics');
    analytics.readPosthogFeatureFlags([]);
    const flagsBody = (distinctId: string) =>
      JSON.stringify({ distinct_id: distinctId, $anon_distinct_id: distinctId, $device_id: 'sdk-device' });
    const lastSentBody = () => {
      const calls = harness.network.mock.calls as unknown as Array<[string, { body: string }]>;
      return JSON.parse(calls.at(-1)?.[1].body ?? '{}') as Record<string, unknown>;
    };

    await harness.clients[0].fetch('https://posthog.test/flags/?v=2', {
      method: 'POST',
      headers: {},
      body: flagsBody('memory-anonymous'),
    });
    const beforeAllow = lastSentBody();
    expect(beforeAllow.distinct_id).toMatch(/^flags-browser:[0-9a-f-]{36}$/);
    expect(beforeAllow).not.toHaveProperty('$anon_distinct_id');
    expect(beforeAllow).not.toHaveProperty('$device_id');

    harness.granted = true;
    harness.change();
    const persisted = harness.clients.at(-1)!;
    expect(persisted).not.toBe(harness.clients[0]);
    await persisted.fetch('https://posthog.test/flags/?v=2', {
      method: 'POST',
      headers: {},
      body: flagsBody('persisted-anonymous'),
    });
    const afterAllow = lastSentBody();
    expect(afterAllow.distinct_id).toBe(beforeAllow.distinct_id);
    // With consent too: the SDK's anonymous id merges into the account at
    // sign-in, so it never rides beside the browser's flags id.
    expect(afterAllow).not.toHaveProperty('$anon_distinct_id');
    expect(afterAllow).not.toHaveProperty('$device_id');
  });
  it('fails a signed-out flag request closed when the browser has no crypto', async () => {
    vi.stubGlobal('crypto', undefined);
    try {
      const analytics = await import('../analytics');
      analytics.readPosthogFeatureFlags([]);
      await expect(
        harness.clients[0].fetch('https://posthog.test/flags/?v=2', {
          method: 'POST',
          headers: {},
          body: JSON.stringify({ distinct_id: 'memory-anonymous' }),
        }),
      ).rejects.toThrow('No secure random source');
      expect(harness.network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('leaves signed-in flags on the account id', async () => {
    const analytics = await import('../analytics');
    analytics.setAnalyticsFlagAccountId('account-a');
    analytics.readPosthogFeatureFlags([]);
    await harness.clients.at(-1)!.fetch('https://posthog.test/flags/?v=2', {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ distinct_id: 'account-a' }),
    });
    const calls = harness.network.mock.calls as unknown as Array<[string, { body: string }]>;
    expect(JSON.parse(calls.at(-1)?.[1].body ?? '{}').distinct_id).toBe('account-a');
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
