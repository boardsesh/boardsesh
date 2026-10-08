import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { PostHogOptions, PostHogCustomStorage } from 'posthog-react-native';

const sdk = vi.hoisted(() => ({
  events: [] as string[],
  calls: [] as string[],
  files: new Map<string, string>(),
  constructed: 0,
}));
vi.mock('../is-dev-build', () => ({ isDevBuild: () => false }));
vi.mock('../posthog-storage-backend', () => ({
  posthogStorageBackend: {
    getItem: async (key: string) => sdk.files.get(key) ?? null,
    setItem: async (key: string, payload: string) => {
      sdk.files.set(key, payload);
    },
    removeItem: async (key: string) => {
      sdk.files.delete(key);
    },
  },
}));
vi.mock('posthog-react-native', () => ({
  PostHogPersistedProperty: {
    Queue: 'queue',
    AiQueue: 'ai_queue',
    AiCaptureQueue: 'ai_capture_queue',
    LogsQueue: 'logs_queue',
    OptedOut: 'opted_out',
  },
  PostHog: class {
    distinctId = 'anonymous';
    anonymousId = 'anonymous';
    optedOut = true;
    options: PostHogOptions;
    storage?: PostHogCustomStorage;
    initialized: Promise<void>;
    constructor(_key: string, options: PostHogOptions) {
      sdk.constructed++;
      this.options = options;
      this.storage = options.customStorage;
      this.initialized = this.load();
    }
    async load() {
      const file = await this.storage?.getItem('.posthog-rn.json');
      if (file) {
        const parsed = JSON.parse(file).content;
        this.distinctId = parsed.distinct_id;
        this.anonymousId = parsed.anonymous_id;
        this.optedOut = parsed.opted_out;
      }
    }
    ready() {
      return this.initialized;
    }
    getDistinctId() {
      return this.distinctId;
    }
    getAnonymousId() {
      return this.anonymousId;
    }
    optIn() {
      sdk.calls.push('optIn');
      this.optedOut = false;
      return Promise.resolve();
    }
    optOut() {
      sdk.calls.push('optOut');
      this.optedOut = true;
      return Promise.resolve();
    }
    identify(accountId: string) {
      sdk.calls.push(`identify:${accountId}`);
      this.distinctId = accountId;
      const event = { event: '$identify', distinct_id: accountId, properties: {} };
      const beforeSend = this.options.before_send;
      if (!this.optedOut && typeof beforeSend === 'function' && beforeSend(event)) sdk.events.push('$identify');
    }
    reset() {
      sdk.calls.push('reset');
      this.distinctId = this.anonymousId = 'fresh-anonymous';
      this.optedOut = true;
    }
    setPersistedProperty() {}
    register() {}
    reloadFeatureFlags() {}
    stopSessionRecording() {
      return Promise.resolve();
    }
    fetch() {
      return Promise.resolve({ status: 200, text: async () => '', json: async () => ({}) });
    }
  },
}));

beforeEach(() => {
  vi.resetModules();
  sdk.events.length = 0;
  sdk.calls.length = 0;
  sdk.files.clear();
  sdk.constructed = 0;
  vi.stubEnv('EXPO_PUBLIC_POSTHOG_KEY', 'phc_consent_test');
  sdk.files.set(
    '.posthog-rn.json',
    JSON.stringify({
      version: 'v1',
      content: { distinct_id: 'account-a', anonymous_id: 'anonymous-a', opted_out: false, queue: [{ event: 'old' }] },
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
});
const grant = {
  analytics: 'granted' as const,
  version: 1,
  decidedAt: '2026-10-08T12:00:00.123Z',
  source: 'ios' as const,
};

describe('enabled mobile SDK consent lifecycle', () => {
  it('constructs one memory flags client while account authority is unresolved, preserving consented disk identity', async () => {
    const consent = await import('../consent-state');
    consent.updateConsentState({ loaded: true, settled: true, flagsResolved: true, record: grant, authSettled: false });
    const posthog = await import('../posthog-client');
    expect(posthog.isAnalyticsEnabled).toBe(true);
    await posthog.initializePosthogClient();
    expect(sdk.constructed).toBe(1);
    expect(sdk.events).toEqual([]);
    expect(posthog.getPostHogClient()?.getDistinctId()).toBe('account-a');
    expect(JSON.parse(sdk.files.get('.posthog-rn.json')!).content.distinct_id).toBe('account-a');
    expect(consent.isProductAnalyticsGranted()).toBe(false);
  });
  it('resets account A then opts in and captures identify B before opening public capture', async () => {
    const consent = await import('../consent-state');
    consent.updateConsentState({ loaded: true, settled: true, flagsResolved: true, record: grant, authSettled: false });
    const posthog = await import('../posthog-client');
    await posthog.initializePosthogClient();
    sdk.calls.length = 0;
    consent.updateConsentState({ authSettled: true, accountResolved: true, accountId: 'account-b' });
    await posthog.applyPosthogConsent();
    expect(sdk.calls).toEqual(['reset', 'optIn', 'identify:account-b']);
    expect(sdk.events).toEqual(['$identify']);
    expect(consent.isProductAnalyticsGranted()).toBe(true);
    expect(sdk.constructed).toBe(1);
    consent.updateConsentState({ record: { ...grant, analytics: 'denied' } });
    await posthog.applyPosthogConsent();
    expect(sdk.files.size).toBe(0);
    expect(consent.isProductAnalyticsGranted()).toBe(false);
  });
  it('resets a pinned account before granting a signed-out launch', async () => {
    const consent = await import('../consent-state');
    consent.updateConsentState({ loaded: true, settled: true, flagsResolved: true, record: grant, authSettled: false });
    const posthog = await import('../posthog-client');
    await posthog.initializePosthogClient();
    sdk.calls.length = 0;
    consent.updateConsentState({ authSettled: true, accountResolved: true, accountId: null });
    await posthog.applyPosthogConsent();
    expect(sdk.calls).toEqual(['reset', 'optIn']);
    expect(posthog.getPostHogClient()?.getDistinctId()).toBe('fresh-anonymous');
    expect(consent.isProductAnalyticsGranted()).toBe(true);
  });
});
