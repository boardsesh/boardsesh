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

const FLAG = 'some-server-flag';

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
    expect(parseFeatureFlagOverrides('some-server-flag')).toEqual({ 'some-server-flag': true });
  });

  it('reads the key=value form in both directions', async () => {
    const { parseFeatureFlagOverrides } = await loadModule();
    expect(parseFeatureFlagOverrides('some-server-flag=true,gym-kiosk=false')).toEqual({
      'some-server-flag': true,
      'gym-kiosk': false,
    });
  });

  it('ignores blank entries and unparseable values instead of throwing', async () => {
    const { parseFeatureFlagOverrides } = await loadModule();
    expect(parseFeatureFlagOverrides(' , some-server-flag = ON ,broken=maybe,=true')).toEqual({
      'some-server-flag': true,
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
    expect(String(captureMessage.mock.calls[0][0])).toContain('http-error: 503');
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

describe('resolution reasons', () => {
  it('names the override branch', async () => {
    process.env.FEATURE_FLAG_OVERRIDES = `${FLAG}=false`;
    const { getServerFeatureFlagResolution } = await loadModule();

    await expect(getServerFeatureFlagResolution(FLAG, { distinctId: 'user-1' })).resolves.toEqual({
      enabled: false,
      reason: 'override',
      detail: null,
    });
  });

  it('separates a missing key from a missing person', async () => {
    const { getServerFeatureFlagResolution } = await loadModule();
    await expect(getServerFeatureFlagResolution(FLAG, { distinctId: 'user-1' })).resolves.toMatchObject({
      reason: 'no-api-key',
    });

    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    const { getServerFeatureFlagResolution: resolveWithKey } = await loadModule();
    await expect(resolveWithKey(FLAG, { distinctId: null })).resolves.toMatchObject({ reason: 'no-distinct-id' });
  });

  it('separates PostHog saying no from PostHog never having heard of the flag', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    mockFetchOnce({ ok: true, body: { flags: { [FLAG]: { enabled: false } } } });
    const { getServerFeatureFlagResolution } = await loadModule();
    await expect(getServerFeatureFlagResolution(FLAG, { distinctId: 'user-1' })).resolves.toMatchObject({
      enabled: false,
      reason: 'posthog-disabled',
    });

    // The distinction this whole type exists for: `posthog-disabled` is the flag
    // working, `flag-missing` is the key pointing at the wrong project (or a
    // renamed flag) — same `false`, completely different fix.
    mockFetchOnce({ ok: true, body: { flags: { 'some-other-flag': { enabled: true } } } });
    const { getServerFeatureFlagResolution: resolveMissing } = await loadModule();
    await expect(resolveMissing(FLAG, { distinctId: 'user-1' })).resolves.toMatchObject({
      enabled: false,
      reason: 'flag-missing',
    });
  });

  it('reads a quota-limited project as broken, not as off', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    // PostHog answers 200 with an EMPTY flags map when the project is over its
    // feature-flag quota, which is otherwise identical to a deleted flag.
    mockFetchOnce({ ok: true, body: { flags: {}, quotaLimited: ['feature_flags'] } });

    const { getServerFeatureFlagResolution } = await loadModule();
    await expect(getServerFeatureFlagResolution(FLAG, { distinctId: 'user-1' })).resolves.toEqual({
      enabled: false,
      reason: 'quota-limited',
      detail: 'feature_flags',
    });
  });

  it('still reads quota-limited if PostHog renames the product string', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    mockFetchOnce({ ok: true, body: { flags: {}, quotaLimited: ['feature-flags-v2'] } });

    const { getServerFeatureFlagResolution } = await loadModule();

    // Matching a hardcoded product name would degrade this to `flag-missing`,
    // sending whoever is debugging to hunt a renamed flag during a billing
    // outage. The names PostHog did send land in `detail`.
    await expect(getServerFeatureFlagResolution(FLAG, { distinctId: 'user-1' })).resolves.toEqual({
      enabled: false,
      reason: 'quota-limited',
      detail: 'feature-flags-v2',
    });
  });

  it('ignores a quota limit on some other product when the flag resolved fine', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    mockFetchOnce({ ok: true, body: { flags: { [FLAG]: { enabled: true } }, quotaLimited: ['recordings'] } });

    const { getServerFeatureFlagResolution } = await loadModule();
    await expect(getServerFeatureFlagResolution(FLAG, { distinctId: 'user-1' })).resolves.toMatchObject({
      enabled: true,
      reason: 'posthog-enabled',
    });
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('carries the HTTP status and the error name as detail', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    mockFetchOnce({ ok: false, status: 401 });
    const { getServerFeatureFlagResolution } = await loadModule();
    await expect(getServerFeatureFlagResolution(FLAG, { distinctId: 'user-1' })).resolves.toEqual({
      enabled: false,
      reason: 'http-error',
      detail: '401',
    });

    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));
    const { getServerFeatureFlagResolution: resolveAborted } = await loadModule();
    await expect(resolveAborted(FLAG, { distinctId: 'user-1' })).resolves.toEqual({
      enabled: false,
      reason: 'request-failed',
      detail: 'AbortError',
    });
  });
});

describe('reporting', () => {
  it('reports a flag PostHog has never heard of', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    mockFetchOnce({ ok: true, body: { flags: {} } });

    const { getServerFeatureFlag } = await loadModule();
    await getServerFeatureFlag(FLAG, { distinctId: 'user-1' });

    // Used to be the silent branch: a 200 that simply didn't mention the flag
    // returned false with nothing in Sentry, so a key pointing at the wrong
    // project 404'd the page and left no trace anywhere.
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(String(captureMessage.mock.calls[0][0])).toContain('flag-missing');
  });

  it('reports a quota-limited project', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    mockFetchOnce({ ok: true, body: { flags: {}, quotaLimited: ['feature_flags'] } });

    const { getServerFeatureFlag } = await loadModule();
    await getServerFeatureFlag(FLAG, { distinctId: 'user-1' });

    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(String(captureMessage.mock.calls[0][0])).toContain('quota-limited');
  });

  it('re-arms after a recovery, so a second outage is not swallowed', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    const responses = [
      { ok: false, status: 503, json: async () => ({}) },
      { ok: true, status: 200, json: async () => ({ flags: { [FLAG]: { enabled: true } } }) },
      { ok: false, status: 503, json: async () => ({}) },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(responses.shift())),
    );

    const { getServerFeatureFlag } = await loadModule();

    await getServerFeatureFlag(FLAG, { distinctId: 'user-1' });
    expect(captureMessage).toHaveBeenCalledTimes(1);

    // PostHog answered, so the outage is over and the key re-arms. Latching for
    // the life of the process would make this second outage silent.
    await expect(getServerFeatureFlag(FLAG, { distinctId: 'user-1' })).resolves.toBe(true);
    await getServerFeatureFlag(FLAG, { distinctId: 'user-1' });
    expect(captureMessage).toHaveBeenCalledTimes(2);
  });

  it('stays quiet when the flag simply says no', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    mockFetchOnce({ ok: true, body: { flags: { [FLAG]: { enabled: false } } } });

    const { getServerFeatureFlag } = await loadModule();
    await getServerFeatureFlag(FLAG, { distinctId: 'user-1' });

    // A closed gate is the point of a flag. Reporting it would bury the four
    // reasons above in noise from every anonymous pageview.
    expect(captureMessage).not.toHaveBeenCalled();
  });
});

describe('probeServerFeatureFlag', () => {
  it('asks PostHog without going through the data cache', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    const fetchMock = mockFetchOnce({ ok: true, body: { flags: { [FLAG]: { enabled: true } } } });

    const { probeServerFeatureFlag } = await loadModule();
    await expect(probeServerFeatureFlag(FLAG, { distinctId: 'user-1' })).resolves.toMatchObject({
      enabled: true,
      reason: 'posthog-enabled',
    });

    // The whole point of the probe: a cached stale `false` and a live `false`
    // are different problems, so it must not read (or write) the cache.
    expect(cacheKeyParts).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never spends the once-per-process Sentry budget', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
    mockFetchOnce({ ok: true, body: { flags: {} } });

    const { probeServerFeatureFlag, getServerFeatureFlag } = await loadModule();

    // An admin opening the diagnostics endpoint while a flag is broken must not
    // mark the key as already-reported: the next genuinely broken PAGE request
    // in this worker would then fail silently, so the observability endpoint
    // would be costing observability.
    await probeServerFeatureFlag(FLAG, { distinctId: 'admin-1' });
    expect(captureMessage).not.toHaveBeenCalled();

    await getServerFeatureFlag(FLAG, { distinctId: null, allowAnonymous: true });
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(String(captureMessage.mock.calls[0][0])).toContain('flag-missing');
  });

  it('honours the override and the missing-key short circuits too', async () => {
    process.env.FEATURE_FLAG_OVERRIDES = FLAG;
    const fetchMock = mockFetchOnce({ ok: true, body: { flags: {} } });

    const { probeServerFeatureFlag } = await loadModule();
    await expect(probeServerFeatureFlag(FLAG, { distinctId: null, allowAnonymous: true })).resolves.toMatchObject({
      enabled: true,
      reason: 'override',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('describeServerFeatureFlagConfig', () => {
  it('names the env var holding the key, never the key itself', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_browser';
    const { describeServerFeatureFlagConfig } = await loadModule();

    const config = describeServerFeatureFlagConfig();
    expect(config.apiKeySource).toBe('NEXT_PUBLIC_POSTHOG_KEY');
    expect(JSON.stringify(config)).not.toContain('phc_browser');
    expect(config.host).toBe('https://us.i.posthog.com');
  });

  it('reports the server key, the host override and the parsed overrides', async () => {
    process.env.POSTHOG_PROJECT_KEY = 'phc_server';
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_browser';
    process.env.POSTHOG_HOST = 'https://eu.i.posthog.com/';
    process.env.FEATURE_FLAG_OVERRIDES = `${FLAG}=false`;
    const { describeServerFeatureFlagConfig } = await loadModule();

    expect(describeServerFeatureFlagConfig()).toEqual({
      apiKeySource: 'POSTHOG_PROJECT_KEY',
      // Trailing slash stripped, matching the URL the evaluation builds.
      host: 'https://eu.i.posthog.com',
      overrides: { [FLAG]: false },
    });
  });

  it('reports no key when the environment has none', async () => {
    const { describeServerFeatureFlagConfig } = await loadModule();
    expect(describeServerFeatureFlagConfig().apiKeySource).toBeNull();
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
