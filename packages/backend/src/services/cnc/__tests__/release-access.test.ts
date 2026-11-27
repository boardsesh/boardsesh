import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  isCncCreationAllowed,
  requireCncCheckoutAccess,
  requireCncCreationAccess,
  resetCncReleaseAccessForTests,
} from '../release-access';

const fetchMock = vi.fn<typeof fetch>();
function answer(enabled: boolean): Response {
  return new Response(JSON.stringify({ flags: { 'cnc-packs': { enabled } } }), { status: 200 });
}

function requestBody(index = 0): unknown {
  const body = fetchMock.mock.calls[index][1]?.body;
  if (typeof body !== 'string') throw new Error('Expected a JSON request body');
  return JSON.parse(body) as unknown;
}

beforeEach(() => {
  resetCncReleaseAccessForTests();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('FEATURE_FLAG_OVERRIDES', '');
  vi.stubEnv('POSTHOG_PROJECT_KEY', 'project-key');
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', undefined);
  vi.stubEnv('POSTHOG_HOST', 'https://us.i.posthog.com');
  fetchMock.mockReset().mockImplementation(async () => answer(true));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetCncReleaseAccessForTests();
});

describe('CNC PostHog release access', () => {
  it('targets the authenticated account exactly as www and pins the distinct-id property', async () => {
    expect(await isCncCreationAllowed('account-1')).toBe(true);
    const [requestUrl, requestOptions] = fetchMock.mock.calls[0];
    expect(requestUrl).toEqual(new URL('https://us.i.posthog.com/flags/?v=2'));
    expect(requestOptions).toMatchObject({ method: 'POST', redirect: 'error', signal: expect.any(AbortSignal) });
    expect(requestBody()).toEqual({
      api_key: 'project-key',
      distinct_id: 'account-1',
      person_properties: { distinct_id: 'account-1' },
      flag_keys_to_evaluate: ['cnc-packs'],
      geoip_disable: true,
    });
  });

  it('uses www anonymous identity for public no-hole layouts', async () => {
    expect(await isCncCreationAllowed(null)).toBe(true);
    expect(requestBody()).toMatchObject({ distinct_id: 'anonymous-web-visitor' });
  });

  it('honors on and off standard overrides without contacting PostHog', async () => {
    vi.stubEnv('FEATURE_FLAG_OVERRIDES', 'cnc-packs=false');
    expect(await isCncCreationAllowed('account-1')).toBe(false);
    vi.stubEnv('FEATURE_FLAG_OVERRIDES', 'cnc-packs');
    expect(await isCncCreationAllowed('account-1')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['', ' account-1', 'account-1 '])(
    'refuses invalid account identity %j even with an override',
    async (userId) => {
      vi.stubEnv('FEATURE_FLAG_OVERRIDES', 'cnc-packs');
      expect(await isCncCreationAllowed(userId)).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('fails closed without either project key and falls back to the public key', async () => {
    vi.stubEnv('POSTHOG_PROJECT_KEY', undefined);
    expect(await isCncCreationAllowed('account-1')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'fallback-key');
    expect(await isCncCreationAllowed('account-1')).toBe(true);
    expect(requestBody()).toMatchObject({ api_key: 'fallback-key' });
  });

  it.each(['http://remote.example.com', 'file:///tmp/posthog', 'not-a-url'])('refuses unsafe host %j', async (host) => {
    vi.stubEnv('POSTHOG_HOST', host);
    expect(await isCncCreationAllowed('account-1')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('permits a local HTTP stand-in', async () => {
    vi.stubEnv('POSTHOG_HOST', 'http://127.0.0.1:3210/');
    expect(await isCncCreationAllowed('account-1')).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toEqual(new URL('http://127.0.0.1:3210/flags/?v=2'));
  });

  it.each([
    null,
    [],
    {},
    { flags: {} },
    { flags: { 'cnc-packs': { enabled: 'true' } } },
    { flags: { 'cnc-packs': { enabled: true, failed: true } } },
    { flags: { 'cnc-packs': { enabled: true } }, errorsWhileComputingFlags: true },
    { featureFlags: {}, quotaLimited: ['feature_flags'] },
  ])('fails closed for absent, malformed or errored answer %j', async (payload) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload)));
    expect(await isCncCreationAllowed('account-1')).toBe(false);
  });

  it.each([false, true, 'variant'])('accepts legacy PostHog answer %j', async (legacy) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ featureFlags: { 'cnc-packs': legacy } })));
    expect(await isCncCreationAllowed('account-1')).toBe(legacy !== false);
  });

  it('keeps answers separate per account and caches each for sixty seconds', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(answer(true))
      .mockResolvedValueOnce(answer(false))
      .mockResolvedValueOnce(answer(false));
    expect(await isCncCreationAllowed('account-1')).toBe(true);
    expect(await isCncCreationAllowed('account-2')).toBe(false);
    expect(await isCncCreationAllowed('account-1')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await isCncCreationAllowed('account-1')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not reuse an old enabled answer through a PostHog outage', async () => {
    vi.useFakeTimers();
    expect(await isCncCreationAllowed('account-1')).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(await isCncCreationAllowed('account-1')).toBe(false);
    fetchMock.mockResolvedValueOnce(answer(true));
    expect(await isCncCreationAllowed('account-1')).toBe(true);
  });

  it('coalesces concurrent checks for the same account', async () => {
    let finish: ((response: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const requests = [isCncCreationAllowed('account-1'), isCncCreationAllowed('account-1')];
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish!(answer(true));
    expect(await Promise.all(requests)).toEqual([true, true]);
  });

  it('caps the cache and keeps the newest account answer', async () => {
    for (let index = 0; index <= 1_000; index++) {
      await isCncCreationAllowed(`account-${index}`);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1_001);
    await isCncCreationAllowed('account-1000');
    expect(fetchMock).toHaveBeenCalledTimes(1_001);
    await isCncCreationAllowed('account-0');
    expect(fetchMock).toHaveBeenCalledTimes(1_002);
  });

  it('fails closed for non-success and unreadable responses', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    expect(await isCncCreationAllowed('account-1')).toBe(false);
    fetchMock.mockResolvedValueOnce(new Response('not json'));
    expect(await isCncCreationAllowed('account-1')).toBe(false);
  });

  it('bounds an unanswered request to 1.5 seconds', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const request = isCncCreationAllowed('account-1');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await request).toBe(false);
  });

  it('retains existing caller error codes when the flag is off', async () => {
    vi.stubEnv('FEATURE_FLAG_OVERRIDES', 'cnc-packs=false');
    await expect(requireCncCreationAccess('account-1')).rejects.toMatchObject({
      extensions: { code: 'CNC_WORKER_UNAVAILABLE' },
    });
    await expect(requireCncCheckoutAccess('account-1')).rejects.toMatchObject({
      extensions: { code: 'CNC_CHECKOUT_UNAVAILABLE' },
    });
  });
});
