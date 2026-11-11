import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createTelemetry, type BetterAuthOptions, type TelemetryEvent } from 'better-auth';
import { drizzle } from 'drizzle-orm/postgres-js';

const callCounts = vi.hoisted(() => ({
  betterAuth: 0,
  createDedicatedPool: 0,
  poolSizes: [] as number[],
  poolIdleTimeouts: [] as unknown[],
}));

vi.mock('better-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('better-auth')>();
  return {
    ...actual,
    betterAuth: (...args: Parameters<typeof actual.betterAuth>) => {
      callCounts.betterAuth += 1;
      return actual.betterAuth(...args);
    },
  };
});

vi.mock('@boardsesh/db/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/db/client')>();
  return {
    ...actual,
    createDedicatedPool: (...args: Parameters<typeof actual.createDedicatedPool>) => {
      callCounts.createDedicatedPool += 1;
      callCounts.poolSizes.push(args[0]);
      callCounts.poolIdleTimeouts.push(args[1]?.connection?.idle_in_transaction_session_timeout);
      return actual.createDedicatedPool(...args);
    },
  };
});

const PARTNER_MODULES = [
  '../adapter-guard',
  '../admission',
  '../api-access',
  '../authority',
  '../bearer',
  '../configuration',
  '../connected-apps',
  '../connection',
  '../family-guard',
  '../fence',
  '../load-authority',
  '../locks',
  '../logbook-access',
  '../mode',
  '../offline',
  '../registered-origins',
  '../registration',
  '../registration-rules',
  '../routes',
  '../tables',
  '../transaction',
  '../../../handlers/partner-auth',
  '../../../handlers/partner-cors',
  '../../../handlers/partner-rate-limits',
  '../../../handlers/public-api/http',
  '../../../handlers/public-api/logbook',
  '../../../handlers/public-api/logbook-cursor',
  '../../../handlers/public-api/outcome',
  '../../../handlers/public-api/router',
  '../../../graphql/resolvers/connected-apps/connected-apps',
  '../../../graphql/resolvers/oauth-clients/partner-registration',
  '../../../services/logbook-tick-serializer',
];

const VALID_SECRET = 'partner-oauth-test-secret-never-deployed-0123456789';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock('../authority');
});

describe('PARTNER_OAUTH_MODE', () => {
  it.each([undefined, '', 'nonsense', 'ON', 'true'])('reads %j as off', async (rawMode) => {
    const { readPartnerOAuthMode } = await import('../mode');
    expect(readPartnerOAuthMode(rawMode)).toBe('off');
  });

  it.each(['off', 'hold', 'allowlist', 'open', ' OPEN '])('reads %j', async (rawMode) => {
    const { readPartnerOAuthMode } = await import('../mode');
    expect(readPartnerOAuthMode(rawMode)).toBe(rawMode.trim().toLowerCase());
  });
});

describe('importing partner modules', () => {
  it('constructs no instance, opens no pool and starts no telemetry', async () => {
    callCounts.betterAuth = 0;
    callCounts.createDedicatedPool = 0;
    await Promise.all(PARTNER_MODULES.map((modulePath) => import(modulePath)));
    expect(callCounts.betterAuth).toBe(0);
    expect(callCounts.createDedicatedPool).toBe(0);
  });

  it('builds an instance only when asked (proves the counter above can fail)', async () => {
    const { createPartnerAuthority } = await import('../authority');
    const { partnerAdapterSchema } = await import('../tables');
    callCounts.betterAuth = 0;
    const authority = createPartnerAuthority(drizzle.mock({ schema: partnerAdapterSchema }), {
      issuer: 'https://api.boardsesh.test/api/auth',
      resource: 'https://api.boardsesh.test/v1',
      webOrigin: 'https://www.boardsesh.test',
      secrets: [{ version: 1, value: VALID_SECRET }],
      nextAuthSecret: VALID_SECRET,
      developerTermsVersion: 'test-terms',
    });
    expect(callCounts.betterAuth).toBe(1);
    await authority.$context.catch(() => {});
  });
});

describe('the deployed authority', () => {
  it('opens two dedicated pools: three connections for OAuth and /v1, two for logbook snapshots', async () => {
    vi.stubEnv('PARTNER_OAUTH_SECRETS', `1:${VALID_SECRET}`);
    callCounts.poolSizes = [];
    callCounts.poolIdleTimeouts = [];
    const { getPartnerAuthorityRuntime } = await import('../authority');
    const runtime = await getPartnerAuthorityRuntime();
    try {
      expect(callCounts.poolSizes).toEqual([3, 2]);
      // Both end a session idle in a transaction after the 10 s partner transactions set.
      expect(callCounts.poolIdleTimeouts).toEqual([10_000, 10_000]);
      // The feed reads the primary through the partner pool, never the replica or the shared pool.
      const { db, dbRead } = await import('../../../db/client');
      expect(runtime.logbook.feed).not.toBe(db);
      expect(runtime.logbook.feed).not.toBe(dbRead);
      expect(runtime.logbook.snapshots).not.toBe(db);
      expect(runtime.logbook.snapshots).not.toBe(dbRead);
    } finally {
      await runtime.close();
    }
  });
});

describe('the F9 entry point', () => {
  it('builds nothing with the mode off, however many requests arrive', async () => {
    let authorityLoaded = false;
    vi.doMock('../authority', () => {
      authorityLoaded = true;
      return { getPartnerAuthorityRuntime: () => 'runtime' };
    });
    vi.stubEnv('PARTNER_OAUTH_MODE', 'off');
    callCounts.betterAuth = 0;
    callCounts.createDedicatedPool = 0;
    const { createPartnerAuthHandler } = await import('../../../handlers/partner-auth');
    const handler = createPartnerAuthHandler();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        handler(
          { method: 'POST', url: '/api/auth/oauth2/token', headers: { host: 'api.boardsesh.com' } } as never,
          {} as never,
        ),
      ).resolves.toBe(false);
    }
    expect(callCounts.betterAuth).toBe(0);
    expect(callCounts.createDedicatedPool).toBe(0);
    expect(authorityLoaded).toBe(false);
  });

  it('reads the mode once, from the environment', async () => {
    vi.stubEnv('PARTNER_OAUTH_MODE', 'off');
    const { createPartnerAuthHandler } = await import('../../../handlers/partner-auth');
    const loadRuntime = vi.fn(async () => null);
    const handler = createPartnerAuthHandler({ loadRuntime });
    vi.stubEnv('PARTNER_OAUTH_MODE', 'allowlist');
    await expect(
      handler({ method: 'GET', url: '/api/auth/error', headers: { host: 'api.boardsesh.com' } } as never, {} as never),
    ).resolves.toBe(false);
    expect(loadRuntime).not.toHaveBeenCalled();
  });
});

describe('the F10 entry point', () => {
  it('builds nothing with the mode off, however many requests arrive', async () => {
    let authorityLoaded = false;
    vi.doMock('../authority', () => {
      authorityLoaded = true;
      return { getPartnerAuthorityRuntime: () => 'runtime' };
    });
    vi.stubEnv('PARTNER_OAUTH_MODE', 'off');
    callCounts.betterAuth = 0;
    callCounts.createDedicatedPool = 0;
    const { createPublicApiHandler } = await import('../../../handlers/public-api/router');
    const handler = createPublicApiHandler();
    const requests = [
      { method: 'GET', url: '/v1/me' },
      { method: 'DELETE', url: '/v1/connection' },
      { method: 'OPTIONS', url: '/v1/me' },
    ];
    for (const { method, url } of requests) {
      await expect(
        handler(
          {
            method,
            url,
            headers: { host: 'api.boardsesh.com', authorization: 'Bearer abcdefghijklmnopqrstuvwxyzABCDEF' },
          } as never,
          {} as never,
        ),
      ).resolves.toBe(false);
    }
    expect(callCounts.betterAuth).toBe(0);
    expect(callCounts.createDedicatedPool).toBe(0);
    expect(authorityLoaded).toBe(false);
  });

  it('builds nothing for the logbook routes or the OpenAPI document with the mode off (L4)', async () => {
    let authorityLoaded = false;
    vi.doMock('../authority', () => {
      authorityLoaded = true;
      return { getPartnerAuthorityRuntime: () => 'runtime' };
    });
    vi.stubEnv('PARTNER_OAUTH_MODE', 'off');
    callCounts.betterAuth = 0;
    callCounts.createDedicatedPool = 0;
    const { createPublicApiHandler } = await import('../../../handlers/public-api/router');
    const handler = createPublicApiHandler();
    const requests = [
      { method: 'GET', url: '/v1/logbook/changes' },
      { method: 'GET', url: '/v1/logbook/changes?cursor=c3.expired&limit=5' },
      { method: 'GET', url: '/v1/logbook/ticks/0d6c4a2e-8f1b-4b7e-9c3a-5e2f1d0a9b77' },
      { method: 'OPTIONS', url: '/v1/logbook/changes' },
      { method: 'GET', url: '/v1/openapi.json' },
    ];
    for (const { method, url } of requests) {
      await expect(
        handler(
          {
            method,
            url,
            headers: { host: 'api.boardsesh.com', authorization: 'Bearer abcdefghijklmnopqrstuvwxyzABCDEF' },
          } as never,
          {} as never,
        ),
      ).resolves.toBe(false);
    }
    expect(callCounts.betterAuth).toBe(0);
    expect(callCounts.createDedicatedPool).toBe(0);
    expect(authorityLoaded).toBe(false);
  });

  it('reads the mode once, from the environment', async () => {
    vi.stubEnv('PARTNER_OAUTH_MODE', 'off');
    const { createPublicApiHandler } = await import('../../../handlers/public-api/router');
    const loadRuntime = vi.fn(async () => null);
    const handler = createPublicApiHandler({ loadRuntime });
    vi.stubEnv('PARTNER_OAUTH_MODE', 'allowlist');
    await expect(
      handler({ method: 'GET', url: '/v1/me', headers: { host: 'api.boardsesh.com' } } as never, {} as never),
    ).resolves.toBe(false);
    expect(loadRuntime).not.toHaveBeenCalled();
  });
});

describe('the F12 entry point', () => {
  it('answers NOT_FOUND with the mode off and builds nothing, signed in or not', async () => {
    let authorityLoaded = false;
    vi.doMock('../authority', () => {
      authorityLoaded = true;
      return { getPartnerAuthorityRuntime: () => 'runtime' };
    });
    vi.stubEnv('PARTNER_OAUTH_MODE', 'off');
    vi.stubEnv('PARTNER_OAUTH_DEVELOPER_ALLOWLIST', 'developer-1');
    callCounts.betterAuth = 0;
    callCounts.createDedicatedPool = 0;
    const { oauthClientMutations, oauthClientQueries, __resetPartnerRegistrationDeploymentForTests } =
      await import('../../../graphql/resolvers/oauth-clients/partner-registration');
    __resetPartnerRegistrationDeploymentForTests();
    const signedIn = { connectionId: 'developer', isAuthenticated: true, userId: 'developer-1' };
    const anonymous = { connectionId: 'anonymous', isAuthenticated: false };
    for (const context of [signedIn, anonymous]) {
      const calls = [
        oauthClientQueries.myOAuthClients(undefined, {}, context),
        oauthClientMutations.rotateOAuthClientSecret(undefined, { clientId: 'x' }, context),
        oauthClientMutations.deleteOAuthClient(undefined, { clientId: 'x' }, context),
        oauthClientMutations.updateOAuthClient(undefined, { input: { clientId: 'x', name: 'Crimp Lab' } }, context),
        oauthClientMutations.createOAuthClient(
          undefined,
          {
            input: {
              name: 'Crimp Lab',
              publisherName: 'Crimp Labs',
              privacyPolicyUrl: 'https://crimp.example.test/privacy',
              applicationType: 'WEB',
              tokenEndpointAuthMethod: 'NONE',
              redirectUris: ['https://crimp.example.test/cb'],
              acceptedTermsVersion: 'any',
            },
          },
          context,
        ),
      ];
      for (const call of calls) await expect(call).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    }
    expect(authorityLoaded).toBe(false);
    expect(callCounts.betterAuth).toBe(0);
    expect(callCounts.createDedicatedPool).toBe(0);
  });

  it('reads the mode once, from the environment', async () => {
    vi.stubEnv('PARTNER_OAUTH_MODE', 'off');
    const { oauthClientQueries, __resetPartnerRegistrationDeploymentForTests } =
      await import('../../../graphql/resolvers/oauth-clients/partner-registration');
    __resetPartnerRegistrationDeploymentForTests();
    const context = { connectionId: 'developer', isAuthenticated: true, userId: 'developer-1' };
    await expect(oauthClientQueries.myOAuthClients(undefined, {}, context)).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
    vi.stubEnv('PARTNER_OAUTH_MODE', 'allowlist');
    await expect(oauthClientQueries.myOAuthClients(undefined, {}, context)).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
  });
});

describe('loadPartnerAuthority', () => {
  it('returns null with the mode off and never loads the authority or Better Auth', async () => {
    let authorityLoaded = false;
    vi.doMock('../authority', () => {
      authorityLoaded = true;
      return { getPartnerAuthorityRuntime: () => 'runtime' };
    });
    const { loadPartnerAuthority } = await import('../load-authority');
    await expect(loadPartnerAuthority('off')).resolves.toBeNull();
    expect(authorityLoaded).toBe(false);
  });

  it('loads it once the mode is on', async () => {
    let authorityLoaded = false;
    vi.doMock('../authority', () => {
      authorityLoaded = true;
      return { getPartnerAuthorityRuntime: () => 'runtime' };
    });
    const { loadPartnerAuthority } = await import('../load-authority');
    await expect(loadPartnerAuthority('allowlist')).resolves.toBe('runtime');
    expect(authorityLoaded).toBe(true);
  });

  it('reads the deployed mode by default, and defaults to off', async () => {
    vi.stubEnv('PARTNER_OAUTH_MODE', '');
    const { loadPartnerAuthority } = await import('../load-authority');
    await expect(loadPartnerAuthority()).resolves.toBeNull();
  });
});

describe('BETTER_AUTH_TELEMETRY', () => {
  async function eventsPublishedWith(options: BetterAuthOptions): Promise<string[]> {
    const publishedTypes: string[] = [];
    const customTrack = async (event: TelemetryEvent) => {
      publishedTypes.push(event.type);
    };
    const { publish } = await createTelemetry(options, { customTrack, skipTestCheck: true });
    await publish({ type: 'probe', payload: {} });
    return publishedTypes;
  }

  it.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['yes', true],
    ['0', false],
    ['false', false],
    ['FALSE', false],
    ['', false],
  ])('treats BETTER_AUTH_TELEMETRY=%j the way the library does', async (flag, publishes) => {
    const { assertPartnerTelemetryOff } = await import('../configuration');
    vi.stubEnv('BETTER_AUTH_TELEMETRY', flag);
    // The library is the oracle: the flag beats `telemetry: { enabled: false }`.
    const libraryPublishes = (await eventsPublishedWith({ telemetry: { enabled: false } })).includes('probe');
    expect(libraryPublishes).toBe(publishes);
    if (publishes) expect(() => assertPartnerTelemetryOff()).toThrow(/BETTER_AUTH_TELEMETRY/);
    else expect(() => assertPartnerTelemetryOff()).not.toThrow();
  });

  it('refuses to build an authority when the flag is on, before Better Auth starts', async () => {
    const { createPartnerAuthority } = await import('../authority');
    const { PartnerAuthorityConfigurationError } = await import('../configuration');
    const { partnerAdapterSchema } = await import('../tables');
    vi.stubEnv('BETTER_AUTH_TELEMETRY', '1');
    callCounts.betterAuth = 0;
    expect(() =>
      createPartnerAuthority(drizzle.mock({ schema: partnerAdapterSchema }), {
        issuer: 'https://api.boardsesh.test/api/auth',
        resource: 'https://api.boardsesh.test/v1',
        webOrigin: 'https://www.boardsesh.test',
        secrets: [{ version: 1, value: VALID_SECRET }],
        nextAuthSecret: VALID_SECRET,
        developerTermsVersion: 'test-terms',
      }),
    ).toThrow(PartnerAuthorityConfigurationError);
    expect(callCounts.betterAuth).toBe(0);
  });
});

describe('NEXTAUTH_SECRET', () => {
  it.each([undefined, '', '   '])('is required to read the www session, refusing %j', async (rawSecret) => {
    const { readPartnerAuthorityConfiguration, PartnerAuthorityConfigurationError } = await import('../configuration');
    vi.stubEnv('PARTNER_OAUTH_SECRETS', `1:${VALID_SECRET}`);
    vi.stubEnv('NEXTAUTH_SECRET', rawSecret);
    expect(() => readPartnerAuthorityConfiguration()).toThrow(PartnerAuthorityConfigurationError);
    expect(() => readPartnerAuthorityConfiguration()).toThrow(/NEXTAUTH_SECRET/);
  });

  it('is read from the environment beside the partner secrets', async () => {
    const { readPartnerAuthorityConfiguration } = await import('../configuration');
    vi.stubEnv('PARTNER_OAUTH_SECRETS', `1:${VALID_SECRET}`);
    vi.stubEnv('NEXTAUTH_SECRET', 'web-secret');
    expect(readPartnerAuthorityConfiguration().nextAuthSecret).toBe('web-secret');
  });
});

describe('PARTNER_OAUTH_SECRETS', () => {
  it('accepts the largest version a logbook cursor can name', async () => {
    const { parsePartnerSecrets, PARTNER_SECRET_MAX_VERSION } = await import('../configuration');
    expect(parsePartnerSecrets(`${PARTNER_SECRET_MAX_VERSION}:${VALID_SECRET}`)).toEqual([
      { version: 999_999_999, value: VALID_SECRET },
    ]);
  });

  it('parses newest-first versioned secrets', async () => {
    const { parsePartnerSecrets } = await import('../configuration');
    expect(parsePartnerSecrets(`2:${VALID_SECRET},1:${VALID_SECRET}-old`)).toEqual([
      { version: 2, value: VALID_SECRET },
      { version: 1, value: `${VALID_SECRET}-old` },
    ]);
  });

  it.each([
    [undefined, /required/],
    ['', /required/],
    ['no-version-separator', /version:value/],
    ['x:not-numeric', /version:value/],
    ['1:too-short', /shorter than 32/],
    // An epoch-seconds version: logbook cursors carry nine digits, so it is refused at startup.
    [`1794292936:${VALID_SECRET}`, /above 999999999/],
    [`1:${VALID_SECRET},1:${VALID_SECRET}-other`, /repeats a version/],
  ])('refuses %j', async (rawSecrets, message) => {
    const { parsePartnerSecrets, PartnerAuthorityConfigurationError } = await import('../configuration');
    expect(() => parsePartnerSecrets(rawSecrets)).toThrow(PartnerAuthorityConfigurationError);
    expect(() => parsePartnerSecrets(rawSecrets)).toThrow(message);
  });
});

describe('the logbook routes read the primary', () => {
  // A lagging replica would answer a valid cursor with 410, and a stale
  // connection row would serve a Disconnected app (docs/integration-platform.md).
  it.each([
    '../logbook-access.ts',
    '../../../handlers/public-api/logbook.ts',
    '../../../services/logbook-feed.ts',
    '../../../services/logbook-snapshot.ts',
    '../../../services/logbook-tick-serializer.ts',
  ])('%s never reaches for the read replica', (modulePath) => {
    const source = readFileSync(new URL(modulePath, import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bdbRead\b|\bcreateReadDb\b|\bcreateReadPool\b|READ_REPLICA_URL/);
  });
});
