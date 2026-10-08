import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PostHog } from 'posthog-react-native';
import { ConsentPostHog, sanitizeRememberedPosthogFile, setPosthogFlagIdentity } from '../posthog-client';
import { createConsentPosthogStorage } from '../consent-posthog-storage';
import {
  getConsentSnapshot,
  invalidateConsentAccount,
  isProductAnalyticsGranted,
  setBrowserConsentReader,
  updateConsentState,
} from '../consent-state';
import { applySessionReplayConsent } from '../session-replay-consent';
import { deferConsentDestination, consumeConsentDestination } from '../consent-navigation';
import { grantedConsent, grantAnalyticsForTest } from '../../../test/consent-fixture';
vi.mock('../replay-privacy', () => ({
  isNativeReplayPrivacyReady: () => true,
  applyNativeReplayPrivacy: async () => {},
}));

beforeEach(() => {
  setBrowserConsentReader(() => getConsentSnapshot().record);
  grantAnalyticsForTest();
  consumeConsentDestination();
});
afterEach(() => vi.restoreAllMocks());

describe('mobile consent privacy boundaries', () => {
  it('requires SDK, account, auth, flags and local authority together', () => {
    expect(isProductAnalyticsGranted()).toBe(true);
    for (const gate of ['sdkReady', 'accountResolved', 'authSettled', 'flagsResolved', 'settled', 'loaded'] as const) {
      updateConsentState({ [gate]: false });
      expect(isProductAnalyticsGranted()).toBe(false);
      grantAnalyticsForTest();
    }
    updateConsentState({ killed: true });
    expect(isProductAnalyticsGranted()).toBe(false);
  });
  it('observes an external grant invalidation before permitting the first capture', () => {
    updateConsentState({ accountId: 'account-a' });
    setBrowserConsentReader(() => {
      updateConsentState({ accountResolved: false, sdkReady: false });
      return grantedConsent;
    });
    expect(isProductAnalyticsGranted()).toBe(false);
  });
  it('drops queued transport while denied and aborts requests on credential invalidation', async () => {
    let requestSignal: AbortSignal | null | undefined;
    const fetchSpy = vi.spyOn(PostHog.prototype, 'fetch').mockImplementation(async (_url, options) => {
      requestSignal = options.signal;
      return { status: 200, text: async () => '', json: async () => ({}) };
    });
    const client = new ConsentPostHog('phc_test');
    updateConsentState({ record: { ...grantedConsent, analytics: 'denied' } });
    await client.fetch('https://backend/api/posthog/batch/', { method: 'POST', headers: {} });
    expect(fetchSpy).not.toHaveBeenCalled();
    grantAnalyticsForTest();
    const pending = client.fetch('https://backend/api/posthog/batch/', { method: 'POST', headers: {} });
    invalidateConsentAccount();
    expect(requestSignal?.aborted).toBe(true);
    await pending;
  });
  it('flags are available without consent and scrub all persisted identities and traits', async () => {
    const fetchSpy = vi.spyOn(PostHog.prototype, 'fetch');
    updateConsentState({ accountId: 'account-b', authSettled: true, accountResolved: false, sdkReady: false });
    setPosthogFlagIdentity('account-b');
    const client = new ConsentPostHog('phc_test');
    await client.fetch('https://backend/api/posthog/flags/', {
      method: 'POST',
      headers: {},
      body: JSON.stringify({
        distinct_id: 'account-a',
        $device_id: 'device-a',
        $anon_distinct_id: 'anon-a',
        person_properties: { email: 'a@example.com' },
        group_properties: { gym: 'private' },
        groups: { gym: 'private' },
      }),
    });
    const options = fetchSpy.mock.calls.at(-1)?.[1];
    expect(options?.credentials).toBe('omit');
    expect(JSON.parse(String(options?.body))).toEqual({
      distinct_id: 'account-b',
      person_properties: {},
      group_properties: {},
      groups: {},
    });
    invalidateConsentAccount();
    await client.fetch('https://backend/api/posthog/flags/', {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ distinct_id: 'account-b' }),
    });
    expect(JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body)).distinct_id).toMatch(/^flags-launch:/);
  });
  it('sanitizes the installed SDK file envelope without losing consented identity', () => {
    const sanitized = sanitizeRememberedPosthogFile(
      JSON.stringify({
        version: 'v1',
        content: {
          distinct_id: 'account-a',
          opted_out: false,
          queue: [{ email: 'private' }],
          ai_queue: [1],
          ai_capture_queue: [2],
          logs_queue: [3],
        },
      }),
    );
    expect(JSON.parse(sanitized!)).toEqual({
      version: 'v1',
      content: {
        distinct_id: 'account-a',
        opted_out: true,
        queue: [],
        ai_queue: [],
        ai_capture_queue: [],
        logs_queue: [],
      },
    });
    expect(sanitizeRememberedPosthogFile('broken')).toBeNull();
  });
  it('consented signed-out flags retain the SDK anonymous bucketing identity', async () => {
    const fetchSpy = vi.spyOn(PostHog.prototype, 'fetch');
    const client = new ConsentPostHog('phc_test');
    await client.fetch('https://backend/api/posthog/flags/', {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ distinct_id: 'consented-anonymous' }),
    });
    expect(JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body)).distinct_id).toBe('consented-anonymous');
  });
  it('a delayed disk write finishes before withdrawal deletes every legacy SDK file', async () => {
    const files = new Map<string, string>();
    let finishWrite: (() => void) | undefined;
    const backend = {
      getItem: async (key: string) => files.get(key) ?? null,
      setItem: vi.fn(async (key: string, payload: string) => {
        await new Promise<void>((resolve) => {
          finishWrite = resolve;
        });
        files.set(key, payload);
      }),
      removeItem: vi.fn(async (key: string) => {
        files.delete(key);
      }),
    };
    const adapter = createConsentPosthogStorage(backend, true);
    const writing = adapter.storage.setItem('.posthog-rn.json', 'grant');
    await vi.waitFor(() => expect(backend.setItem).toHaveBeenCalledOnce());
    const revoked = adapter.setGranted(false);
    await adapter.storage.setItem('.posthog-rn.json', 'denied-memory');
    finishWrite?.();
    await writing;
    await revoked;
    expect(files.size).toBe(0);
    expect(backend.removeItem).toHaveBeenCalledWith('.posthog-rn-logs.json');
  });
  it('temporary account suspension preserves disk identity and disables new writes', async () => {
    const backend = {
      getItem: vi.fn(async () => 'retained'),
      setItem: vi.fn(async () => {}),
      removeItem: vi.fn(async () => {}),
    };
    const adapter = createConsentPosthogStorage(backend, true);
    adapter.suspend();
    await adapter.storage.setItem('.posthog-rn.json', 'memory');
    expect(backend.removeItem).not.toHaveBeenCalled();
    expect(backend.setItem).not.toHaveBeenCalled();
    await adapter.setGranted(true);
    expect(backend.setItem).toHaveBeenCalledWith('.posthog-rn.json', 'memory');
  });
  it('a native replay start resolving after withdrawal is stopped again', async () => {
    let finishStart: (() => void) | undefined;
    const client = new PostHog('phc_test');
    const start = vi.spyOn(client, 'startSessionRecording').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        }),
    );
    const stop = vi.spyOn(client, 'stopSessionRecording');
    const starting = applySessionReplayConsent(client, true);
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    updateConsentState({ record: { ...grantedConsent, analytics: 'denied' } });
    const stopping = applySessionReplayConsent(client, false);
    expect(stop).toHaveBeenCalled();
    finishStart?.();
    await starting;
    await stopping;
    expect(stop.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it('retains the latest OS destination while preserving OAuth callbacks', () => {
    updateConsentState({ settled: false });
    expect(deferConsentDestination('com.boardsesh.app://auth/callback?code=secret')).toBe(false);
    expect(deferConsentDestination('/notifications')).toBe(true);
    expect(deferConsentDestination('com.boardsesh.app://climb/123?board=kilter')).toBe(true);
    expect(consumeConsentDestination()).toBe('/climb/123?board=kilter');
  });
});
