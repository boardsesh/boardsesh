import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PostHog } from 'posthog-js-lite';

const harness = vi.hoisted(() => ({
  granted: true,
  change: (() => {}) as () => void,
  clients: [] as PostHog[],
  holdBatch: false,
  batchStarted: false,
}));
vi.mock('../consent', () => ({
  hasAnalyticsConsent: () => harness.granted,
  getWebConsentRecord: () => ({ analytics: 'granted', version: 1, source: 'web', decidedAt: '2026-10-08T00:00:00Z' }),
  subscribeWebConsent: (listener: () => void) => {
    harness.change = listener;
    return () => {};
  },
}));
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }));
vi.mock('posthog-js-lite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('posthog-js-lite')>();
  return {
    PostHog: class extends actual.PostHog {
      constructor(apiKey: string, options: ConstructorParameters<typeof actual.PostHog>[1]) {
        super(apiKey, { ...options, flushInterval: 0, fetchRetryCount: 0 });
        harness.clients.push(this);
      }
    },
  };
});

const originalLocation = window.location;
beforeEach(() => {
  vi.resetModules();
  harness.clients.length = 0;
  harness.granted = true;
  harness.holdBatch = false;
  harness.batchStarted = false;
  window.localStorage.clear();
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'consent-sdk-review');
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://posthog.test');
  Object.defineProperty(window, 'location', { configurable: true, value: new URL('https://boardsesh.com/') });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      if (url.includes('/batch') && harness.holdBatch) {
        harness.batchStarted = true;
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return { status: 200, json: async () => ({ featureFlags: {} }), text: async () => '' };
    }),
  );
});
afterEach(async () => {
  harness.holdBatch = false;
  await Promise.all(harness.clients.map((client) => client.shutdown(100).catch(() => {})));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

describe('consent suspension with the installed PostHog SDK', () => {
  it('preserves identity and an interrupted conversion flush through anonymous sign-in', async () => {
    const analytics = await import('../analytics');
    analytics.track('Signup Completed');
    const acquisition = harness.clients[0];
    const acquisitionId = acquisition.getDistinctId();
    harness.holdBatch = true;
    const interruptedFlush = acquisition.flush().catch(() => {});
    await vi.waitFor(() => expect(harness.batchStarted).toBe(true));
    harness.granted = false;
    harness.change();
    analytics.setAnalyticsFlagAccountId('account-a');
    await interruptedFlush;
    expect(acquisition.getPersistedProperty('queue' as Parameters<PostHog['getPersistedProperty']>[0])).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ event: 'Signup Completed', distinct_id: acquisitionId }),
      }),
    ]);
    expect(acquisition.getDistinctId()).toBe(acquisitionId);
    harness.holdBatch = false;
    harness.granted = true;
    harness.change();
    analytics.identify('account-a');
    const queued = acquisition.getPersistedProperty('queue' as Parameters<PostHog['getPersistedProperty']>[0]);
    expect(queued).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({
            event: '$identify',
            properties: expect.objectContaining({ $anon_distinct_id: acquisitionId }),
          }),
        }),
      ]),
    );
    await acquisition.flush();
    expect(acquisition.getPersistedProperty('queue' as Parameters<PostHog['getPersistedProperty']>[0])).toEqual([]);
  });

  it('discards account A conversions through loading, sign-out, and account B sign-in', async () => {
    const analytics = await import('../analytics');
    analytics.setAnalyticsFlagAccountId('account-a');
    analytics.identify('account-a');
    analytics.track('Account A conversion');
    const previous = harness.clients[0];
    harness.granted = false;
    harness.change();
    analytics.setAnalyticsFlagAccountId(null);
    analytics.setAnalyticsFlagAccountId('account-b');
    harness.granted = true;
    harness.change();
    analytics.identify('account-b');
    expect(previous.getPersistedProperty('queue' as Parameters<PostHog['getPersistedProperty']>[0])).toBeUndefined();
    const current = harness.clients.at(-1)!;
    expect(current.getDistinctId()).toBe('account-b');
    const queued = current.getPersistedProperty('queue' as Parameters<PostHog['getPersistedProperty']>[0]);
    expect(JSON.stringify(queued)).not.toContain('Account A conversion');
    expect(JSON.stringify(queued)).not.toContain('account-a');
  });
});

describe('share-link capabilities with the installed PostHog SDK', () => {
  const wallUuid = '3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f';
  const inviteToken = 'Ab3_dE-fGhIjKlMnOpQrSt';

  afterEach(() => {
    Object.defineProperty(document, 'referrer', { configurable: true, value: '' });
  });

  it("keeps an unlisted wall's uuid and an invite token out of every queued event", async () => {
    // A climber scans a wall poster, lands on the wall's list, and arrived from
    // a sign-in page that was carrying a home board's invite back.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new URL(`https://boardsesh.com/b/garage/40/list?wall=${wallUuid}&src=qr&medium=board`),
    });
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      value: `https://boardsesh.com/auth/login?callbackUrl=${encodeURIComponent(`/b/home-wall?invite=${inviteToken}`)}`,
    });
    const analytics = await import('../analytics');
    analytics.pageview('/b/garage/40/list');
    analytics.track('Spray Wall Opened');
    analytics.identify('account-a', { email: 'climber@example.com' });
    analytics.setPersonProperties({ last_wall_url: window.location.href }, { first_wall_url: window.location.href });

    const queued = harness.clients[0].getPersistedProperty('queue' as Parameters<PostHog['getPersistedProperty']>[0]);
    const serialized = JSON.stringify(queued);
    expect(serialized).toContain('Spray Wall Opened');
    expect(serialized).not.toContain(wallUuid);
    expect(serialized).not.toContain(inviteToken);
    expect(serialized).toContain('https://boardsesh.com/b/garage/40/list?src=qr&medium=board');
  });
});
