import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

vi.mock('server-only', () => ({}));

// `unstable_cache` is Next's data cache; outside a request it is a passthrough
// wrapper, which is exactly what these tests want to assert through. The key
// parts are RECORDED rather than ignored: an identity stub proves the return
// value but would stay green through a refactor that dropped the distinct id
// from the key and served one person's flag value to everyone.
const cacheKeyParts = vi.hoisted(() => [] as string[][]);
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown, keyParts: string[]) => {
    cacheKeyParts.push(keyParts);
    return fn;
  },
}));

const captureMessage = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureMessage }));

const FLAG = 'gyms-directory';

type FeatureFlagModule = typeof import('../server-feature-flag');

// Fresh module per test: the once-per-process Sentry guard is module state, and
// a shared instance would make "reports once" pass for the wrong reason.
async function loadModule(): Promise<FeatureFlagModule> {
  vi.resetModules();
  return import('../server-feature-flag');
}

function mockFetchOnce(response: { ok: boolean; status?: number; body?: unknown }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: async () => response.body ?? {},
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  captureMessage.mockReset();
  cacheKeyParts.length = 0;
  delete process.env.FEATURE_FLAG_OVERRIDES;
  delete process.env.POSTHOG_PROJECT_KEY;
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  delete process.env.POSTHOG_HOST;
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

describe('parseFeatureFlagOverrides', () => {
  it('reads the bare-key form as ON', async () => {
    const { parseFeatureFlagOverrides } = await loadModule();
    expect(parseFeatureFlagOverrides('gyms-directory')).toEqual({ 'gyms-directory': true });
  });

  it('reads the key=value form in both directions', async () => {
    const { parseFeatureFlagOverrides } = await loadModule();
    expect(parseFeatureFlagOverrides('gyms-directory=true,gym-kiosk=false')).toEqual({
      'gyms-directory': true,
      'gym-kiosk': false,
    });
  });

  it('ignores blank entries and unparseable values instead of throwing', async () => {
    const { parseFeatureFlagOverrides } = await loadModule();
    expect(parseFeatureFlagOverrides(' , gyms-directory = ON ,broken=maybe,=true')).toEqual({
      'gyms-directory': true,
    });
  });

  it('returns nothing for an unset variable', async () => {
    const { parseFeatureFlagOverrides } = await loadModule();
    expect(parseFeatureFlagOverrides(undefined)).toEqual({});
  });
});

describe('getServerFeatureFlag — overrides', () => {
  it('honours the bare-key override without calling PostHog', async () => {
    process.env.FEATURE_FLAG_OVERRIDES = FLAG;
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    const fetchMock = mockFetchOnce({ ok: true, body: { flags: { [FLAG]: { enabled: false } } } });

    const { getServerFeatureFlag } = await loadModule();

    // Local dev is the whole reason this branch exists: the browser PostHog
    // client refuses to boot off localhost, so there is no other way in.
    await expect(getServerFeatureFlag(FLAG, { distinctId: null })).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honours an explicit OFF override over a PostHog ON', async () => {
    process.env.FEATURE_FLAG_OVERRIDES = `${FLAG}=false`;
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    const fetchMock = mockFetchOnce({ ok: true, body: { flags: { [FLAG]: { enabled: true } } } });

    const { getServerFeatureFlag } = await loadModule();

    await expect(getServerFeatureFlag(FLAG, { distinctId: 'user-1' })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves other keys alone', async () => {
    process.env.FEATURE_FLAG_OVERRIDES = 'some-other-flag';
    const { getServerFeatureFlag } = await loadModule();

    await expect(getServerFeatureFlag(FLAG, { distinctId: 'user-1' })).resolves.toBe(false);
  });
});

describe('getServerFeatureFlag — configuration', () => {
  it('is off when no PostHog key is configured', async () => {
    const fetchMock = mockFetchOnce({ ok: true, body: { flags: { [FLAG]: { enabled: true } } } });
    const { getServerFeatureFlag } = await loadModule();

    await expect(getServerFeatureFlag(FLAG, { distinctId: 'user-1' })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    // Not an error: preview and CI builds have no key by design.
    expect(captureMessage).not.toHaveBeenCalled();
  });
});

describe('getServerFeatureFlag — identified vs anonymous', () => {
  it('sends the authenticated distinct id so person-property targeting can match', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    process.env.POSTHOG_HOST = 'https://us.i.posthog.com';
    const fetchMock = mockFetchOnce({ ok: true, body: { flags: { [FLAG]: { enabled: true } } } });

    const { getServerFeatureFlag } = await loadModule();
    await expect(getServerFeatureFlag(FLAG, { distinctId: 'user-uuid-1' })).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://us.i.posthog.com/flags/?v=2');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ api_key: 'phc_test', distinct_id: 'user-uuid-1' });
  });

  it('resolves false for a signed-out visitor without calling PostHog at all', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    const fetchMock = mockFetchOnce({ ok: true, body: { flags: { [FLAG]: { enabled: true } } } });

    const { getServerFeatureFlag } = await loadModule();

    // A flag targeted at a person property has no person to match against, so
    // asking would return false anyway — and asking with a generated id is the
    // trap: PostHog answers false for a perfectly configured flag and nothing
    // errors anywhere.
    await expect(getServerFeatureFlag(FLAG, { distinctId: null })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads PostHog saying the person is NOT in the flag', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    mockFetchOnce({ ok: true, body: { flags: { [FLAG]: { enabled: false } } } });

    const { getServerFeatureFlag } = await loadModule();
    await expect(getServerFeatureFlag(FLAG, { distinctId: 'somebody-else' })).resolves.toBe(false);
  });

  it('falls back to the legacy featureFlags shape', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    mockFetchOnce({ ok: true, body: { featureFlags: { [FLAG]: true } } });

    const { getServerFeatureFlag } = await loadModule();
    await expect(getServerFeatureFlag(FLAG, { distinctId: 'user-1' })).resolves.toBe(true);
  });

  it('treats a multivariate variant as being in the flag', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    mockFetchOnce({ ok: true, body: { featureFlags: { [FLAG]: 'variant-b' } } });

    const { getServerFeatureFlag } = await loadModule();
    await expect(getServerFeatureFlag(FLAG, { distinctId: 'user-1' })).resolves.toBe(true);
  });

  it('is off when the flag is missing from the response entirely', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    mockFetchOnce({ ok: true, body: { flags: {} } });

    const { getServerFeatureFlag } = await loadModule();
    await expect(getServerFeatureFlag(FLAG, { distinctId: 'user-1' })).resolves.toBe(false);
  });

  it('prefers the server-only key over the browser one', async () => {
    process.env.POSTHOG_PROJECT_KEY = 'phc_server';
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_browser';
    const fetchMock = mockFetchOnce({ ok: true, body: { flags: { [FLAG]: { enabled: true } } } });

    const { getServerFeatureFlag } = await loadModule();
    await expect(getServerFeatureFlag(FLAG, { distinctId: 'user-1' })).resolves.toBe(true);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).api_key).toBe('phc_server');
  });
});

describe('getServerFeatureFlag — failure modes', () => {
  it('fails closed on a non-200 and reports it once', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    mockFetchOnce({ ok: false, status: 503 });

    const { getServerFeatureFlag } = await loadModule();

    await expect(getServerFeatureFlag(FLAG, { distinctId: 'user-1' })).resolves.toBe(false);
    await expect(getServerFeatureFlag(FLAG, { distinctId: 'user-1' })).resolves.toBe(false);

    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(String(captureMessage.mock.calls[0][0])).toContain('HTTP 503');
  });

  it('fails closed when the request is aborted past its deadline', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    const { getServerFeatureFlag } = await loadModule();

    await expect(getServerFeatureFlag(FLAG, { distinctId: 'user-1' })).resolves.toBe(false);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(String(captureMessage.mock.calls[0][0])).toContain('AbortError');
  });

  it('fails closed when the response body is not JSON', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token <');
        },
      }),
    );

    const { getServerFeatureFlag } = await loadModule();
    await expect(getServerFeatureFlag(FLAG, { distinctId: 'user-1' })).resolves.toBe(false);
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });
});

describe('getServerFeatureFlag — anonymous visitors', () => {
  it('short-circuits a signed-out visitor to false by DEFAULT', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    const fetchMock = mockFetchOnce({ ok: true, body: { flags: { [FLAG]: { enabled: true } } } });

    const { getServerFeatureFlag } = await loadModule();

    await expect(getServerFeatureFlag(FLAG, { distinctId: null })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('evaluates a signed-out visitor when the caller opts in', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    const fetchMock = mockFetchOnce({ ok: true, body: { flags: { [FLAG]: { enabled: true } } } });

    const { getServerFeatureFlag, ANONYMOUS_DISTINCT_ID } = await loadModule();

    // Without this a percentage rollout can never reach the public: the surface
    // stays signed-in-only however the PostHog dashboard is configured, and
    // flipping the flag to 100% changes nothing for anonymous visitors.
    await expect(getServerFeatureFlag(FLAG, { distinctId: null, allowAnonymous: true })).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).distinct_id).toBe(ANONYMOUS_DISTINCT_ID);
  });

  it('still prefers a real person over the anonymous id when one is signed in', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    const fetchMock = mockFetchOnce({ ok: true, body: { flags: { [FLAG]: { enabled: true } } } });

    const { getServerFeatureFlag } = await loadModule();
    await getServerFeatureFlag(FLAG, { distinctId: 'user-uuid-1', allowAnonymous: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).distinct_id).toBe('user-uuid-1');
  });

  it('still fails closed for an anonymous visitor when PostHog is unreachable', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    mockFetchOnce({ ok: false, status: 500 });

    const { getServerFeatureFlag } = await loadModule();
    await expect(getServerFeatureFlag(FLAG, { distinctId: null, allowAnonymous: true })).resolves.toBe(false);
  });
});

describe('cache key', () => {
  it('includes the distinct id, so one person never sees another person answer', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    mockFetchOnce({ ok: true, body: { flags: { [FLAG]: { enabled: true } } } });

    const { getServerFeatureFlag } = await loadModule();
    await getServerFeatureFlag(FLAG, { distinctId: 'user-uuid-1' });

    expect(cacheKeyParts).toHaveLength(1);
    expect(cacheKeyParts[0]).toContain('user-uuid-1');
    expect(cacheKeyParts[0]).toContain(FLAG);
  });

  it('gives two people two different keys', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    mockFetchOnce({ ok: true, body: { flags: { [FLAG]: { enabled: true } } } });

    const { getServerFeatureFlag } = await loadModule();
    await getServerFeatureFlag(FLAG, { distinctId: 'user-a' });
    await getServerFeatureFlag(FLAG, { distinctId: 'user-b' });

    expect(cacheKeyParts).toHaveLength(2);
    expect(cacheKeyParts[0].join('|')).not.toBe(cacheKeyParts[1].join('|'));
  });

  it('gives two flags two different keys for the same person', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    mockFetchOnce({ ok: true, body: { flags: {} } });

    const { getServerFeatureFlag } = await loadModule();
    await getServerFeatureFlag(FLAG, { distinctId: 'user-a' });
    await getServerFeatureFlag('other-flag', { distinctId: 'user-a' });

    expect(cacheKeyParts[0].join('|')).not.toBe(cacheKeyParts[1].join('|'));
  });

  it('keys anonymous evaluations on the shared anonymous id', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    mockFetchOnce({ ok: true, body: { flags: { [FLAG]: { enabled: true } } } });

    const { getServerFeatureFlag, ANONYMOUS_DISTINCT_ID } = await loadModule();
    await getServerFeatureFlag(FLAG, { distinctId: null, allowAnonymous: true });

    // One entry for the whole signed-out population, by design — see the
    // constant's note on why an indexable surface wants all-or-nothing.
    expect(cacheKeyParts[0]).toContain(ANONYMOUS_DISTINCT_ID);
  });
});
