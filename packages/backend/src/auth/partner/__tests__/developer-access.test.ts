import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PARTNER_DEVELOPER_CONSOLE_FLAG } from '@boardsesh/auth-protocol/partner-oauth';
import { logger } from '../../../utils/logger';
import {
  __resetPartnerDeveloperAccessForTests,
  checkPartnerDeveloperAccess,
  PARTNER_DEVELOPER_ACCESS_CACHE_MS,
  PARTNER_DEVELOPER_ACCESS_TIMEOUT_MS,
} from '../developer-access';

const DEVELOPER = 'developer-1';
const WITH_KEY = { POSTHOG_PROJECT_KEY: 'phc_partner_test', POSTHOG_HOST: 'https://flags.example.test/' };
/** The `notProduction` option: a laptop or test database, or anything else. */
const LOCAL = true;
const PRODUCTION = false;
/** A Railway-shaped database address: public, so nothing proves this is not production. */
const RAILWAY_DATABASE_URL = 'postgresql://postgres:secret@monorail.proxy.rlwy.net:43210/railway';

type FetchCall = [URL | string, RequestInit];

function requestUrl([url]: FetchCall): string {
  return url instanceof URL ? url.href : url;
}

function flagsAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function enabledAnswer(enabled: boolean): Response {
  return flagsAnswer({ flags: { [PARTNER_DEVELOPER_CONSOLE_FLAG]: { key: PARTNER_DEVELOPER_CONSOLE_FLAG, enabled } } });
}

/** The flag request's JSON body. fetch is always called with a string here. */
function requestBody(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== 'string') throw new Error('Expected a JSON string body.');
  return JSON.parse(init.body) as Record<string, unknown>;
}

function stubFetch(answer: (url: URL | string, init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(answer);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function check(environment: Record<string, string | undefined>, notProduction: boolean, userId = DEVELOPER) {
  return checkPartnerDeveloperAccess(userId, { environment, notProduction });
}

beforeEach(() => {
  __resetPartnerDeveloperAccessForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('asking PostHog', () => {
  it('lets in an account the flag names, sending only its id for this one flag', async () => {
    const fetchMock = stubFetch(async () => enabledAnswer(true));
    expect(await check(WITH_KEY, PRODUCTION)).toEqual({
      decision: 'allowed',
      reason: 'posthog-enabled',
      detail: null,
    });

    const call = fetchMock.mock.calls[0] as FetchCall;
    const [, init] = call;
    expect(requestUrl(call)).toBe('https://flags.example.test/flags/?v=2');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    // No email and no other person data: the account id, pinned as the
    // `distinct_id` property too so a stored one cannot match.
    expect(requestBody(init)).toEqual({
      token: 'phc_partner_test',
      distinct_id: DEVELOPER,
      person_properties: { distinct_id: DEVELOPER },
      flag_keys_to_evaluate: [PARTNER_DEVELOPER_CONSOLE_FLAG],
      geoip_disable: true,
    });
  });

  it('refuses an account the flag does not name', async () => {
    stubFetch(async () => enabledAnswer(false));
    expect(await check(WITH_KEY, PRODUCTION)).toEqual({
      decision: 'refused',
      reason: 'posthog-disabled',
      detail: null,
    });
  });

  it('reads the older featureFlags shape, a variant included', async () => {
    stubFetch(async () => flagsAnswer({ featureFlags: { [PARTNER_DEVELOPER_CONSOLE_FLAG]: 'beta' } }));
    expect((await check(WITH_KEY, PRODUCTION, 'developer-variant')).decision).toBe('allowed');
    stubFetch(async () => flagsAnswer({ featureFlags: { [PARTNER_DEVELOPER_CONSOLE_FLAG]: false } }));
    expect((await check(WITH_KEY, PRODUCTION, 'developer-legacy-off')).decision).toBe('refused');
  });

  it('asks outside production too when a key is set, the way www does', async () => {
    const fetchMock = stubFetch(async () => enabledAnswer(true));
    expect((await check(WITH_KEY, LOCAL)).decision).toBe('allowed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the default host and the public key when those are all that is set', async () => {
    const fetchMock = stubFetch(async () => enabledAnswer(true));
    await check({ NEXT_PUBLIC_POSTHOG_KEY: 'phc_public' }, PRODUCTION);
    const call = fetchMock.mock.calls[0] as FetchCall;
    expect(requestUrl(call)).toBe('https://us.i.posthog.com/flags/?v=2');
    expect(requestBody(call[1])).toMatchObject({ token: 'phc_public' });
  });

  it('reaches plain http only on this machine', async () => {
    const fetchMock = stubFetch(async () => enabledAnswer(true));
    expect((await check({ ...WITH_KEY, POSTHOG_HOST: 'http://127.0.0.1:8010' }, PRODUCTION)).decision).toBe('allowed');
    expect(requestUrl(fetchMock.mock.calls[0] as FetchCall)).toBe('http://127.0.0.1:8010/flags/?v=2');
  });
});

describe('failing closed', () => {
  it.each([
    ['a non-2xx answer', () => flagsAnswer({}, 503), { reason: 'http-error', detail: '503' }],
    ['the flag missing from the answer', () => flagsAnswer({ flags: {} }), { reason: 'flag-missing', detail: null }],
    [
      'a quota limit',
      () => flagsAnswer({ flags: {}, quotaLimited: ['feature_flags'] }),
      { reason: 'quota-limited', detail: 'feature_flags' },
    ],
    [
      'a flag PostHog failed to compute',
      () =>
        flagsAnswer({
          flags: { [PARTNER_DEVELOPER_CONSOLE_FLAG]: { enabled: false, failed: true } },
          errorsWhileComputingFlags: true,
        }),
      { reason: 'flag-errored', detail: null },
    ],
    [
      'an unreadable body',
      () => new Response('<html>bad gateway</html>', { status: 200 }),
      { reason: 'request-failed', detail: 'SyntaxError' },
    ],
    [
      'a JSON body that is not an object',
      () => flagsAnswer(null),
      { reason: 'request-failed', detail: 'unreadable body' },
    ],
  ])('treats %s as "could not check", never as a yes', async (_label, answer, expected) => {
    stubFetch(async () => answer());
    expect(await check(WITH_KEY, PRODUCTION)).toEqual({ decision: 'unavailable', ...expected });
  });

  it('treats a request that throws as "could not check"', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await check(WITH_KEY, PRODUCTION)).toEqual({
      decision: 'unavailable',
      reason: 'request-failed',
      detail: 'TypeError',
    });
  });

  it('gives up at the deadline instead of holding the request open', async () => {
    vi.useFakeTimers();
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const pending = check(WITH_KEY, PRODUCTION);
    await vi.advanceTimersByTimeAsync(PARTNER_DEVELOPER_ACCESS_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ decision: 'unavailable', reason: 'request-failed', detail: 'AbortError' });
  });

  it.each(['http://flags.example.test', 'ftp://flags.example.test', 'not a url'])(
    'refuses to send the project token to %s',
    async (host) => {
      vi.spyOn(logger, 'error').mockImplementation(() => logger);
      const fetchMock = stubFetch(async () => enabledAnswer(true));
      expect(await check({ ...WITH_KEY, POSTHOG_HOST: host }, PRODUCTION)).toEqual({
        decision: 'unavailable',
        reason: 'invalid-host',
        detail: null,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('follows no redirect: a 307 is "could not check"', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const elsewhere: string[] = [];
    const server = createServer((incoming, outgoing) => {
      if (incoming.url?.startsWith('/elsewhere')) {
        elsewhere.push(incoming.url);
        outgoing.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ flags: {} }));
        return;
      }
      outgoing.writeHead(307, { Location: '/elsewhere/flags/?v=2' }).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    try {
      expect(await check({ ...WITH_KEY, POSTHOG_HOST: `http://127.0.0.1:${port}` }, PRODUCTION)).toEqual({
        decision: 'unavailable',
        reason: 'request-failed',
        detail: 'TypeError',
      });
      expect(elsewhere).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('still trusts a yes that came with an error for some other flag', async () => {
    stubFetch(async () =>
      flagsAnswer({ flags: { [PARTNER_DEVELOPER_CONSOLE_FLAG]: { enabled: true } }, errorsWhileComputingFlags: true }),
    );
    expect((await check(WITH_KEY, PRODUCTION)).decision).toBe('allowed');
  });

  it('logs one error per outage, and again for the next one', async () => {
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    stubFetch(async () => flagsAnswer({}, 500));
    await check(WITH_KEY, PRODUCTION, 'developer-a');
    await check(WITH_KEY, PRODUCTION, 'developer-b');
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect((errorLog.mock.calls[0] as unknown[] | undefined)?.[1]).toMatchObject({
      reason: 'http-error',
      detail: '500',
      error: expect.any(Error),
    });

    stubFetch(async () => enabledAnswer(false));
    await check(WITH_KEY, PRODUCTION, 'developer-c');
    stubFetch(async () => flagsAnswer({}, 500));
    await check(WITH_KEY, PRODUCTION, 'developer-d');
    expect(errorLog).toHaveBeenCalledTimes(2);
  });
});

describe('without a PostHog key', () => {
  it('refuses outside production without asking anyone', async () => {
    const fetchMock = stubFetch(async () => enabledAnswer(true));
    expect(await check({}, LOCAL)).toEqual({ decision: 'refused', reason: 'no-api-key', detail: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a broken deploy in production instead of calling the developer uninvited', async () => {
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const fetchMock = stubFetch(async () => enabledAnswer(true));
    expect(await check({ POSTHOG_PROJECT_KEY: '  ' }, PRODUCTION)).toEqual({
      decision: 'unavailable',
      reason: 'no-api-key',
      detail: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledTimes(1);
  });
});

describe('FEATURE_FLAG_OVERRIDES', () => {
  it('decides on a local or test database, both ways, without PostHog', async () => {
    const fetchMock = stubFetch(async () => enabledAnswer(false));
    expect(await check({ ...WITH_KEY, FEATURE_FLAG_OVERRIDES: PARTNER_DEVELOPER_CONSOLE_FLAG }, LOCAL)).toEqual({
      decision: 'allowed',
      reason: 'override',
      detail: null,
    });
    expect(await check({ FEATURE_FLAG_OVERRIDES: `cnc-packs,${PARTNER_DEVELOPER_CONSOLE_FLAG}=false` }, LOCAL)).toEqual(
      { decision: 'refused', reason: 'override', detail: null },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores an override for some other flag', async () => {
    expect((await check({ FEATURE_FLAG_OVERRIDES: 'cnc-packs' }, LOCAL)).reason).toBe('no-api-key');
  });

  it('turns nobody away in production: an "on" is ignored, PostHog decides, and it is logged once', async () => {
    const warnLog = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const fetchMock = stubFetch(async () => enabledAnswer(false));
    const environment = { ...WITH_KEY, FEATURE_FLAG_OVERRIDES: PARTNER_DEVELOPER_CONSOLE_FLAG };
    expect(await check(environment, PRODUCTION, 'developer-a')).toEqual({
      decision: 'refused',
      reason: 'posthog-disabled',
      detail: null,
    });
    expect(await check(environment, PRODUCTION, 'developer-b')).toMatchObject({ decision: 'refused' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnLog).toHaveBeenCalledTimes(1);
  });

  it('refuses everyone with "=false" in production too, without asking PostHog', async () => {
    const fetchMock = stubFetch(async () => enabledAnswer(true));
    expect(
      await check({ ...WITH_KEY, FEATURE_FLAG_OVERRIDES: `${PARTNER_DEVELOPER_CONSOLE_FLAG}=false` }, PRODUCTION),
    ).toEqual({ decision: 'refused', reason: 'override', detail: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cannot open the console in production even when PostHog is down or the key is missing', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const override = { FEATURE_FLAG_OVERRIDES: PARTNER_DEVELOPER_CONSOLE_FLAG };
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await check({ ...WITH_KEY, ...override }, PRODUCTION)).decision).toBe('unavailable');
    expect((await check(override, PRODUCTION)).decision).toBe('unavailable');
  });
});

describe('the default production test', () => {
  const ON = { FEATURE_FLAG_OVERRIDES: PARTNER_DEVELOPER_CONSOLE_FLAG };

  function stubProcessEnvironment(databaseUrl: string): void {
    for (const [name, value] of Object.entries({ ...WITH_KEY, ...ON })) vi.stubEnv(name, value);
    vi.stubEnv('DATABASE_URL', databaseUrl);
    // A label that says "not production" must not be enough on its own.
    vi.stubEnv('SENTRY_ENVIRONMENT', 'staging');
  }

  it('ignores an "on" override with a Railway database, whatever SENTRY_ENVIRONMENT says', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const fetchMock = stubFetch(async () => enabledAnswer(false));
    stubProcessEnvironment(RAILWAY_DATABASE_URL);
    expect(await checkPartnerDeveloperAccess(DEVELOPER)).toEqual({
      decision: 'refused',
      reason: 'posthog-disabled',
      detail: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honours it with a database on this machine', async () => {
    const fetchMock = stubFetch(async () => enabledAnswer(false));
    stubProcessEnvironment('postgresql://postgres:postgres@localhost:5432/main');
    expect(await checkPartnerDeveloperAccess(DEVELOPER)).toMatchObject({ decision: 'allowed', reason: 'override' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('wired to isPrivateDatabaseTarget', () => {
    afterEach(() => {
      vi.doUnmock('@boardsesh/db/client/config');
      vi.resetModules();
    });

    async function loadWithDatabase(isPrivate: boolean) {
      vi.resetModules();
      vi.doMock('@boardsesh/db/client/config', async (importOriginal) => ({
        ...(await importOriginal<typeof import('@boardsesh/db/client/config')>()),
        isPrivateDatabaseTarget: () => isPrivate,
        // Everything else says "not production"; only the database may decide.
        isTestEnvironment: () => true,
        isLocalDevelopment: () => true,
        isProductionSentryEnvironment: () => false,
        resolveSentryEnvironment: () => 'test',
      }));
      return import('../developer-access');
    }

    it('reads the process as production when the database is not provably private', async () => {
      const { checkPartnerDeveloperAccess: check, __resetPartnerDeveloperAccessForTests: reset } =
        await loadWithDatabase(false);
      reset();
      const { logger: loadedLogger } = await import('../../../utils/logger');
      vi.spyOn(loadedLogger, 'warn').mockImplementation(() => loadedLogger);
      stubFetch(async () => enabledAnswer(false));
      expect(await check(DEVELOPER, { environment: { ...WITH_KEY, ...ON } })).toMatchObject({
        decision: 'refused',
        reason: 'posthog-disabled',
      });
    });

    it('and as not production when it is', async () => {
      const { checkPartnerDeveloperAccess: check } = await loadWithDatabase(true);
      expect(await check(DEVELOPER, { environment: ON })).toMatchObject({ decision: 'allowed', reason: 'override' });
    });
  });
});

describe('the cache', () => {
  it('keeps a yes and a no for a minute per account, then asks again', async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(async (_url, init) => enabledAnswer(requestBody(init).distinct_id === 'invited'));
    expect((await check(WITH_KEY, PRODUCTION, 'invited')).decision).toBe('allowed');
    expect((await check(WITH_KEY, PRODUCTION, 'outsider')).decision).toBe('refused');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(PARTNER_DEVELOPER_ACCESS_CACHE_MS - 1);
    expect(await check(WITH_KEY, PRODUCTION, 'invited')).toEqual({
      decision: 'allowed',
      reason: 'posthog-enabled',
      detail: null,
    });
    expect((await check(WITH_KEY, PRODUCTION, 'outsider')).decision).toBe('refused');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The owner removes the developer from the flag: within a minute PostHog is asked again.
    fetchMock.mockImplementation(async () => enabledAnswer(false));
    await vi.advanceTimersByTimeAsync(1);
    expect((await check(WITH_KEY, PRODUCTION, 'invited')).decision).toBe('refused');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never keeps a failure, so a recovered PostHog is asked on the next request', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const fetchMock = stubFetch(async () => flagsAnswer({}, 502));
    expect((await check(WITH_KEY, PRODUCTION)).decision).toBe('unavailable');
    fetchMock.mockImplementation(async () => enabledAnswer(true));
    expect((await check(WITH_KEY, PRODUCTION)).decision).toBe('allowed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache an override, so changing it takes effect at once', async () => {
    stubFetch(async () => enabledAnswer(true));
    expect((await check({ FEATURE_FLAG_OVERRIDES: PARTNER_DEVELOPER_CONSOLE_FLAG }, LOCAL)).decision).toBe('allowed');
    expect((await check({}, LOCAL)).decision).toBe('refused');
  });

  it('holds at most a thousand accounts, dropping the oldest', async () => {
    const fetchMock = stubFetch(async () => enabledAnswer(true));
    for (let index = 0; index <= 1_000; index += 1) await check(WITH_KEY, PRODUCTION, `developer-${index}`);
    expect(fetchMock).toHaveBeenCalledTimes(1_001);
    await check(WITH_KEY, PRODUCTION, 'developer-1000');
    expect(fetchMock).toHaveBeenCalledTimes(1_001);
    await check(WITH_KEY, PRODUCTION, 'developer-0');
    expect(fetchMock).toHaveBeenCalledTimes(1_002);
  });
});
