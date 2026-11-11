import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { createAuthMiddleware } from 'better-auth/api';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  oauthAccessToken,
  oauthClient,
  oauthConnections,
  oauthConsent,
  oauthRefreshAncestors,
  oauthRefreshToken,
  oauthSession,
  oauthVerification,
} from '@boardsesh/db/schema/auth';
import { db } from '../../../db/client';
import {
  PARTNER_AUTHORIZATION_CODE_LIFETIME_SECONDS,
  PARTNER_ISSUER,
  PARTNER_RESOURCE,
  PARTNER_SCOPES,
  PARTNER_SIGNED_QUERY_LIFETIME_SECONDS,
  PARTNER_WEB_ORIGIN,
} from '../configuration';
import { PARTNER_POOL_MAX } from '../transaction';
import {
  createPartnerTestEnvironment,
  TEST_CONFIGURATION,
  TEST_ISSUER,
  TEST_OAUTH_OPTIONS,
  TEST_RESOURCE,
  TEST_SESSION_HEADER,
  type PartnerTestEnvironment,
  type RequestHandlerInstance,
  type TestClient,
} from './partner-fixture';

function revocationPresentation(token: string, presentation: string): string {
  if (presentation === 'whitespace') return `  ${token}  `;
  if (presentation === 'Bearer' || presentation === 'DPoP') return `${presentation} ${token}`;
  return token;
}

describe('partner authority against real Postgres (ported from the BA-01 prototype suite)', () => {
  let environment: PartnerTestEnvironment;

  beforeAll(async () => {
    environment = await createPartnerTestEnvironment();
  });

  afterAll(async () => {
    await environment?.close();
  });

  const issueTokens = (client: TestClient, scopes?: string[], target?: RequestHandlerInstance) =>
    environment.issueTokens(client, scopes, target);

  it('serves RFC 8414 metadata at both paths, and no OIDC discovery', async () => {
    const issuer = new URL(TEST_ISSUER);
    for (const metadataUrl of [
      `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`,
      `${TEST_ISSUER}/.well-known/oauth-authorization-server`,
    ]) {
      const response = await environment.auth.handler(new Request(metadataUrl));
      expect(response.status).toBe(200);
      const metadata = (await response.json()) as Record<string, unknown>;
      expect(metadata.issuer).toBe(TEST_ISSUER);
      expect(metadata.authorization_endpoint).toBe(`${TEST_ISSUER}/oauth2/authorize`);
      expect(metadata.token_endpoint).toBe(`${TEST_ISSUER}/oauth2/token`);
      expect(metadata.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
      expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
      // Discovery only publishes scopes whose routes exist.
      expect(metadata.scopes_supported).toEqual(['logbook:read', 'profile:read', 'offline_access']);
    }
    const oidc = await environment.auth.handler(new Request(`${TEST_ISSUER}/.well-known/openid-configuration`));
    expect(oidc.status).toBe(404);
  });

  it('refuses a resource the client is not linked to', async () => {
    const client = await environment.createClient({ linkResource: false });
    const refused = await environment.authorize(client);
    expect(new URL(refused.location!).searchParams.get('error')).toBe('invalid_target');
    expect(new URL(refused.location!).searchParams.has('code')).toBe(false);
  });

  it('refuses client registration from a signed-in climber and from nobody', async () => {
    const climber = await environment.createClimber();
    const clientName = `registration-${randomUUID()}`;
    const asCallers: Record<string, string>[] = [{ [TEST_SESSION_HEADER]: climber.sessionToken }, {}];
    for (const headers of asCallers) {
      const response = await environment.instance.handler(
        new Request(`${TEST_ISSUER}/oauth2/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ client_name: clientName, redirect_uris: ['https://client.example.test/cb'] }),
        }),
      );
      expect(response.status).toBe(403);
    }
    expect(await db.select().from(oauthClient).where(eq(oauthClient.name, clientName))).toEqual([]);
  });

  it.each([
    ['a foreign origin', { origin: 'https://evil.example' }],
    ['no origin', {}],
  ])('checks the origin of a cookie-bearing consent post: %s is refused', async (_label, originHeaders) => {
    const client = await environment.createClient({ skipConsent: false });
    const atConsent = await environment.authorize(client);
    const response = await environment.instance.handler(
      new Request(`${TEST_ISSUER}/oauth2/consent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'unrelated=1',
          [TEST_SESSION_HEADER]: client.owner.sessionToken,
          ...originHeaders,
        },
        body: JSON.stringify({ accept: true, oauth_query: new URL(atConsent.location!).searchParams.toString() }),
      }),
    );
    expect(response.status).toBe(403);
    expect(await db.select().from(oauthConsent).where(eq(oauthConsent.clientId, client.clientId))).toEqual([]);
  });

  it('accepts a cookie-bearing consent post from the web origin', async () => {
    const client = await environment.createClient({ skipConsent: false });
    const atConsent = await environment.authorize(client);
    const response = await environment.instance.handler(
      new Request(`${TEST_ISSUER}/oauth2/consent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'unrelated=1',
          origin: TEST_CONFIGURATION.webOrigin,
          [TEST_SESSION_HEADER]: client.owner.sessionToken,
        },
        body: JSON.stringify({ accept: true, oauth_query: new URL(atConsent.location!).searchParams.toString() }),
      }),
    );
    expect(response.status).toBe(200);
  });

  it('pins the values a typo would quietly weaken', async () => {
    expect(TEST_OAUTH_OPTIONS).toMatchObject({
      allowDynamicClientRegistration: false,
      allowUnauthenticatedClientRegistration: false,
      clientRegistrationRequirePKCE: true,
      enforcePerClientResources: true,
      refreshTokenReuseInterval: 0,
      codeExpiresIn: 600,
      accessTokenExpiresIn: 3600,
      refreshTokenExpiresIn: 90 * 24 * 60 * 60,
      storeTokens: 'hashed',
      storeClientSecret: 'encrypted',
      disableJwtPlugin: true,
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    expect(PARTNER_SCOPES).toEqual(['logbook:read', 'profile:read', 'offline_access']);
    expect(PARTNER_SIGNED_QUERY_LIFETIME_SECONDS).toBe(600);
    expect(PARTNER_AUTHORIZATION_CODE_LIFETIME_SECONDS).toBe(60);
    expect(PARTNER_POOL_MAX).toBe(3);
    expect([PARTNER_ISSUER, PARTNER_RESOURCE, PARTNER_WEB_ORIGIN]).toEqual([
      'https://api.boardsesh.com/api/auth',
      'https://api.boardsesh.com/v1',
      'https://www.boardsesh.com',
    ]);

    const { options } = await environment.auth.$context;
    expect(options.user?.deleteUser?.enabled).toBe(false);
    expect(options.user?.changeEmail?.enabled).toBe(false);
    expect(options.account?.accountLinking?.enabled).toBe(false);
    expect(options.session?.cookieCache?.enabled).toBe(false);
    expect(options.rateLimit?.enabled).toBe(false);
    expect(options.telemetry?.enabled).toBe(false);
    expect(options.logger?.disabled).toBe(true);
    expect(options.onAPIError?.throw).toBe(true);
  });

  it('redeems a PKCE code on another instance and binds an opaque token to the resource and scopes', async () => {
    const client = await environment.createClient();
    const authorization = await environment.authorize(client);
    expect(authorization.response.status).toBe(302);
    const redirect = new URL(authorization.location!);
    expect(redirect.searchParams.get('state')).toBe(authorization.state);
    expect(redirect.searchParams.get('iss')).toBe(TEST_ISSUER);
    const issued = await environment.exchange(client, authorization, environment.secondaryInstance);
    expect(issued.response.status).toBe(200);
    expect(issued.body.token_type).toBe('Bearer');
    expect(issued.body.access_token!.split('.')).toHaveLength(1);
    expect(issued.body.expires_in).toBe(3600);
    expect(issued.response.headers.get('cache-control')).toContain('no-store');

    const inspected = await environment.introspect(client, issued.body.access_token!);
    expect(inspected.body).toMatchObject({
      active: true,
      sub: client.owner.userId,
      client_id: client.clientId,
      scope: 'profile:read offline_access',
    });
    expect([inspected.body.aud].flat()).toContain(TEST_RESOURCE);

    const [accessRecord] = await db
      .select()
      .from(oauthAccessToken)
      .where(eq(oauthAccessToken.clientId, client.clientId));
    const [refreshRecord] = await db
      .select()
      .from(oauthRefreshToken)
      .where(eq(oauthRefreshToken.clientId, client.clientId));
    // storeTokens: 'hashed': the raw token never reaches the database.
    expect(accessRecord.token).not.toBe(issued.body.access_token);
    expect(refreshRecord.token).not.toBe(issued.body.refresh_token);
    expect(accessRecord.expiresAt.getTime() - accessRecord.createdAt.getTime()).toBe(3600 * 1000);
    expect(refreshRecord.expiresAt.getTime() - refreshRecord.createdAt.getTime()).toBe(90 * 24 * 3600 * 1000);
  });

  it('stores a confidential client secret encrypted, never in the clear', async () => {
    const client = await environment.createClient();
    const [stored] = await db.select().from(oauthClient).where(eq(oauthClient.clientId, client.clientId));
    expect(client.clientSecret).toBeTypeOf('string');
    expect(stored.clientSecret).toBeTypeOf('string');
    expect(stored.clientSecret).not.toBe(client.clientSecret);
  });

  it('issues a 60 second code while the consent link stays signed for 600', async () => {
    // Date only: real HTTP, PostgreSQL, Redis and timeout scheduling still run.
    // The code's issuance clock is not its later database INSERT timestamp.
    const issuedAt = Math.floor(Date.now() / 1000) * 1000;
    vi.useFakeTimers({ toFake: ['Date'], now: issuedAt });
    try {
      const consentClient = await environment.createClient({ skipConsent: false });
      const atConsent = await environment.authorize(consentClient);
      const consentUrl = new URL(atConsent.location!);
      expect(consentUrl.href).toContain(TEST_OAUTH_OPTIONS.consentPage);
      expect(Number(consentUrl.searchParams.get('exp')) - issuedAt / 1000).toBe(600);

      const client = await environment.createClient({ publicClient: true });
      const authorization = await environment.authorize(client);
      const codeRows = await db.select().from(oauthVerification);
      const code = codeRows.find((record) => {
        const payload = JSON.parse(record.value) as { query?: { client_id?: string } };
        return payload.query?.client_id === client.clientId;
      });
      expect(code).toBeDefined();
      expect(code!.expiresAt.getTime()).toBe(issuedAt + 60_000);
      const expiresUnused = await environment.authorize(client);

      vi.setSystemTime(issuedAt + 59_000);
      expect((await environment.exchange(client, authorization, environment.secondaryInstance)).response.status).toBe(
        200,
      );
      vi.setSystemTime(issuedAt + 61_000);
      const rejected = await environment.exchange(client, expiresUnused, environment.secondaryInstance);
      expect(rejected.response.status).toBe(400);
      expect(rejected.body.error).toBe('invalid_grant');
    } finally {
      vi.useRealTimers();
    }
  });

  it('public clients redeem PKCE codes and rotate without a client secret', async () => {
    const client = await environment.createClient({ publicClient: true });
    expect(client.clientSecret).toBeUndefined();
    const issued = await issueTokens(client);
    const rotated = await environment.refresh(client, issued.refresh_token!, environment.instance);
    expect(rotated.response.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(issued.refresh_token);
  });

  it('requires offline_access before issuing a refresh token', async () => {
    const client = await environment.createClient();
    const issued = await issueTokens(client, ['profile:read']);
    expect(issued.refresh_token).toBeUndefined();
  });

  it.each([{ challengeMethod: 'plain' }, { omitChallenge: true }])(
    'rejects authorization without PKCE S256: %j',
    async (options) => {
      const client = await environment.createClient({ publicClient: true });
      const authorization = await environment.authorize(client, options);
      expect(authorization.response.status).toBe(302);
      const rejected = new URL(authorization.location!);
      expect(rejected.searchParams.get('error')).toBe('invalid_request');
      expect(rejected.searchParams.has('code')).toBe(false);
      expect(
        await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.clientId, client.clientId)),
      ).toHaveLength(0);
    },
  );

  it('rejects a wrong PKCE verifier and a redirect substitution', async () => {
    const client = await environment.createClient();
    const invalidExchanges: Record<string, string>[] = [
      { code_verifier: randomBytes(32).toString('base64url') },
      { redirect_uri: 'https://evil.test/callback' },
    ];
    for (const overrides of invalidExchanges) {
      const authorization = await environment.authorize(client);
      const rejected = await environment.exchange(client, authorization, environment.secondaryInstance, overrides);
      expect(rejected.response.status).toBe(400);
      expect(rejected.body.access_token).toBeUndefined();
    }
  });

  it('rejects scopes and audiences outside the client registration', async () => {
    const client = await environment.createClient();
    const scopeRequest = await environment.authorize(client, { scopes: ['not-granted:write'] });
    expect(new URL(scopeRequest.location!).searchParams.get('error')).toBe('invalid_scope');
    const resourceRequest = await environment.authorize(client, { resource: 'https://evil.test/v1' });
    expect(new URL(resourceRequest.location!).searchParams.get('error')).toBe('invalid_target');
  });

  it('refuses a code presented by a different app before it can be consumed', async () => {
    const client = await environment.createClient();
    const otherClient = await environment.createClient();
    const authorization = await environment.authorize(client);
    const code = new URL(authorization.location!).searchParams.get('code')!;
    const stolen = await environment.exchange(otherClient, {
      location: authorization.location,
      verifier: authorization.verifier,
    });
    expect(stolen.body.error).toBe('invalid_grant');
    // The real client can still redeem, because the stolen attempt never reached the provider.
    expect(code).toBeTruthy();
    expect((await environment.exchange(client, authorization)).response.status).toBe(200);
  });

  it('rotates refresh tokens, and replaying an old one closes its family', async () => {
    const client = await environment.createClient();
    const issued = await issueTokens(client);
    const rotated = await environment.refresh(client, issued.refresh_token!);
    expect(rotated.response.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(issued.refresh_token);
    const replay = await environment.refresh(client, issued.refresh_token!, environment.instance);
    expect(replay.body.error).toBe('invalid_grant');
    expect((await environment.introspect(client, rotated.body.access_token!)).body.active).toBe(false);
    expect((await environment.refresh(client, rotated.body.refresh_token!)).body.error).toBe('invalid_grant');
  });

  it.each([false, true])('reuse closes only its own family, publicClient=%s', async (publicClient) => {
    const client = await environment.createClient({ publicClient });
    const firstGrant = await issueTokens(client);
    const independentGrant = await issueTokens(client);
    const rotated = await environment.refresh(client, firstGrant.refresh_token!, environment.instance);
    expect(rotated.response.status).toBe(200);
    expect((await environment.refresh(client, firstGrant.refresh_token!)).body.error).toBe('invalid_grant');
    expect((await environment.refresh(client, rotated.body.refresh_token!)).body.error).toBe('invalid_grant');
    const independentRefresh = await environment.refresh(client, independentGrant.refresh_token!, environment.instance);
    expect(independentRefresh.response.status).toBe(200);
    if (!publicClient) {
      expect((await environment.introspect(client, independentRefresh.body.access_token!)).body.active).toBe(true);
    }
  });

  it('invalid client authentication cannot trigger family cleanup', async () => {
    const client = await environment.createClient();
    const issued = await issueTokens(client);
    const rotated = await environment.refresh(client, issued.refresh_token!, environment.instance);
    for (const clientSecret of [undefined, 'wrong-secret']) {
      const rejected = await environment.refresh({ ...client, clientSecret }, issued.refresh_token!);
      expect(rejected.body.error).toBe('invalid_client');
      expect((await environment.introspect(client, rotated.body.access_token!)).body.active).toBe(true);
    }
    expect((await environment.refresh(client, rotated.body.refresh_token!)).response.status).toBe(200);
  });

  it.each(['raw', 'whitespace', 'Bearer', 'DPoP'])(
    'another app cannot revoke or replay a public connection: %s',
    async (presentation) => {
      const firstClient = await environment.createClient({ publicClient: true });
      const secondClient = await environment.createClient({ publicClient: true, owner: firstClient.owner });
      const firstTokens = await issueTokens(firstClient);
      const secondTokens = await issueTokens(secondClient);
      const rotatedFirst = await environment.refresh(firstClient, firstTokens.refresh_token!, environment.instance);
      expect((await environment.refresh(secondClient, firstTokens.refresh_token!)).body.error).toBe('invalid_grant');
      const wrongClientRevoke = await environment.revoke(secondClient, {
        token: revocationPresentation(firstTokens.refresh_token!, presentation),
        token_type_hint: 'refresh_token',
      });
      expect(wrongClientRevoke.response.status).toBe(200);
      expect((await environment.refresh(secondClient, secondTokens.refresh_token!)).response.status).toBe(200);
      expect((await environment.refresh(firstClient, rotatedFirst.body.refresh_token!)).response.status).toBe(200);
    },
  );

  it.each(['raw', 'whitespace', 'Bearer', 'DPoP'])(
    'revoking a consumed token closes only its family: %s',
    async (presentation) => {
      const client = await environment.createClient();
      const firstGrant = await issueTokens(client);
      const independentGrant = await issueTokens(client);
      const rotated = await environment.refresh(client, firstGrant.refresh_token!, environment.instance);
      const revoked = await environment.revoke(client, {
        token: revocationPresentation(firstGrant.refresh_token!, presentation),
        token_type_hint: 'refresh_token',
      });
      expect(revoked.response.status).toBe(200);
      expect((await environment.introspect(client, rotated.body.access_token!)).body.active).toBe(false);
      expect((await environment.introspect(client, independentGrant.access_token)).body.active).toBe(true);
    },
  );

  it('revoking an access token leaves the refresh credential, and a wrong hint still finds the token', async () => {
    const client = await environment.createClient();
    const issued = await issueTokens(client);
    const revokedAccess = await environment.revoke(client, {
      token: issued.access_token,
      token_type_hint: 'refresh_token',
    });
    expect(revokedAccess.response.status).toBe(200);
    expect((await environment.introspect(client, issued.access_token)).body.active).toBe(false);
    const rotated = await environment.refresh(client, issued.refresh_token!);
    expect(rotated.response.status).toBe(200);
    const revokedRefresh = await environment.revoke(client, {
      token: rotated.body.refresh_token!,
      token_type_hint: 'access_token',
    });
    expect(revokedRefresh.response.status).toBe(200);
    expect((await environment.introspect(client, rotated.body.access_token!)).body.active).toBe(false);
    expect((await environment.refresh(client, rotated.body.refresh_token!)).body.error).toBe('invalid_grant');
  });

  it('never widens a scope when refreshing', async () => {
    const client = await environment.createClient();
    const issued = await issueTokens(client, ['profile:read', 'offline_access']);
    const widened = await environment.refresh(
      client,
      issued.refresh_token!,
      environment.secondaryInstance,
      'profile:read admin:everything offline_access',
    );
    expect(widened.response.status).toBe(400);
    expect(widened.body.error).toBe('invalid_scope');
    expect((await environment.introspect(client, issued.access_token)).body.scope).toBe('profile:read offline_access');
  });

  it('existing tokens stop working once a client is suspended', async () => {
    const client = await environment.createClient();
    const issued = await issueTokens(client);
    await db.update(oauthClient).set({ disabled: true }).where(eq(oauthClient.clientId, client.clientId));
    const inspected = await environment.introspect(client, issued.access_token);
    expect(inspected.body.active).not.toBe(true);
    expect((await environment.refresh(client, issued.refresh_token!)).response.status).not.toBe(200);
  });

  it('offline tokens detach from the session while session-bound grants stay attached', async () => {
    const client = await environment.createClient();
    await issueTokens(client, ['profile:read']);
    const [sessionBound] = await db
      .select()
      .from(oauthAccessToken)
      .where(eq(oauthAccessToken.clientId, client.clientId));
    expect(sessionBound.sessionId).not.toBeNull();

    const offlineClient = await environment.createClient();
    const offline = await issueTokens(offlineClient);
    const [detachedAccess] = await db
      .select()
      .from(oauthAccessToken)
      .where(eq(oauthAccessToken.clientId, offlineClient.clientId));
    const [detachedRefresh] = await db
      .select()
      .from(oauthRefreshToken)
      .where(eq(oauthRefreshToken.clientId, offlineClient.clientId));
    expect(detachedAccess.sessionId).toBeNull();
    expect(detachedRefresh.sessionId).toBeNull();
    // Deleting the browser session leaves an offline grant working.
    await db.delete(oauthSession).where(eq(oauthSession.id, offlineClient.owner.sessionId));
    expect((await environment.introspect(offlineClient, offline.access_token)).body.active).toBe(true);
  });

  it('remembers consumed ancestry so a later prune cannot hide reuse', async () => {
    const client = await environment.createClient();
    const ancestryRows = () =>
      db
        .select()
        .from(oauthRefreshAncestors)
        .where(
          and(
            eq(oauthRefreshAncestors.clientId, client.clientId),
            eq(oauthRefreshAncestors.userId, client.owner.userId),
          ),
        );
    const firstGrant = await issueTokens(client);
    // Recorded at issuance, hashed, and not yet consumed.
    const [issuedAncestor] = await ancestryRows();
    expect(issuedAncestor.tokenHash).not.toBe(firstGrant.refresh_token);
    expect(issuedAncestor.consumedAt).toBeNull();
    const rotated = await environment.refresh(client, firstGrant.refresh_token!, environment.instance);
    expect(rotated.response.status).toBe(200);
    const rows = await ancestryRows();
    expect(rows).toHaveLength(2);
    const ancestor = rows.find((row) => row.tokenHash === issuedAncestor.tokenHash)!;
    expect(ancestor.consumedAt).not.toBeNull();
    // Model the provider pruning the expired consumed row.
    await db.delete(oauthRefreshToken).where(eq(oauthRefreshToken.token, ancestor.tokenHash));
    const replay = await environment.refresh(client, firstGrant.refresh_token!);
    expect(replay.body.error).toBe('invalid_grant');
    expect((await environment.introspect(client, rotated.body.access_token!)).body.active).toBe(false);
  });

  it('after 91 days a rotated grant keeps working and its first ancestor still trips reuse', async () => {
    const client = await environment.createClient();
    const anotherClient = await environment.createClient({ publicClient: true, owner: client.owner });
    const firstGrant = await issueTokens(client);
    const independentGrant = await issueTokens(client);
    const originalTime = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(originalTime + 30 * 24 * 3600 * 1000);
      const day30 = await environment.refresh(client, firstGrant.refresh_token!, environment.instance);
      const independentDay30 = await environment.refresh(client, independentGrant.refresh_token!, environment.instance);
      expect(day30.response.status).toBe(200);
      expect(independentDay30.response.status).toBe(200);
      vi.setSystemTime(originalTime + 91 * 24 * 3600 * 1000);
      const day91 = await environment.refresh(client, day30.body.refresh_token!);
      const independentDay91 = await environment.refresh(client, independentDay30.body.refresh_token!);
      expect(day91.response.status).toBe(200);
      expect(independentDay91.response.status).toBe(200);
      expect((await environment.introspect(client, day91.body.access_token!)).body.active).toBe(true);

      const invalidSecret = await environment.refresh(
        { ...client, clientSecret: 'wrong-secret' },
        firstGrant.refresh_token!,
      );
      expect(invalidSecret.body.error).toBe('invalid_client');
      expect((await environment.refresh(anotherClient, firstGrant.refresh_token!)).body.error).toBe('invalid_grant');
      const expiredRevoke = await environment.revoke(client, {
        token: `Bearer ${firstGrant.refresh_token!}`,
        token_type_hint: 'refresh_token',
      });
      expect(expiredRevoke.response.status).toBe(200);
      expect((await environment.introspect(client, day91.body.access_token!)).body.active).toBe(true);

      const replay = await environment.refresh(client, firstGrant.refresh_token!);
      expect(replay.body.error).toBe('invalid_grant');
      expect((await environment.introspect(client, day91.body.access_token!)).body.active).toBe(false);
      expect((await environment.refresh(client, day91.body.refresh_token!)).body.error).toBe('invalid_grant');
      expect((await environment.introspect(client, independentDay91.body.access_token!)).body.active).toBe(true);
      expect((await environment.refresh(client, independentDay91.body.refresh_token!)).response.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a provider failure after a token mint rolls back tokens and code consumption', async () => {
    const client = await environment.createClient();
    const failingInstance = environment.createInstance([
      {
        id: 'test-injected-mint-failure',
        hooks: {
          after: [
            {
              matcher: (context) => context.path === '/oauth2/token',
              handler: createAuthMiddleware(async () => {
                throw new Error('Injected token mint failure');
              }),
            },
          ],
        },
      },
    ]);
    const authorization = await environment.authorize(client);
    const failed = await environment.exchange(client, authorization, failingInstance);
    expect(failed.response.status).toBe(500);
    expect(await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.clientId, client.clientId))).toHaveLength(
      0,
    );
    expect(
      await db.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.clientId, client.clientId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(oauthRefreshAncestors).where(eq(oauthRefreshAncestors.clientId, client.clientId)),
    ).toHaveLength(0);
    // The code was restored, so the app can still finish the exchange.
    expect((await environment.exchange(client, authorization)).response.status).toBe(200);
  });

  it('a failed refresh mint rolls back successor ancestry and parent consumption together', async () => {
    const client = await environment.createClient();
    const issued = await issueTokens(client);
    const failingInstance = environment.createInstance([
      {
        id: 'test-injected-refresh-failure',
        hooks: {
          after: [
            {
              matcher: (context) => context.path === '/oauth2/token',
              handler: createAuthMiddleware(async () => {
                throw new Error('Injected refresh ancestry failure');
              }),
            },
          ],
        },
      },
    ]);
    expect((await environment.refresh(client, issued.refresh_token!, failingInstance)).response.status).toBe(500);
    const [providerRow] = await db
      .select()
      .from(oauthRefreshToken)
      .where(and(eq(oauthRefreshToken.clientId, client.clientId), isNull(oauthRefreshToken.revoked)));
    expect(providerRow.token).toBeDefined();
    expect((await environment.refresh(client, issued.refresh_token!, environment.instance)).response.status).toBe(200);
  });

  it('first-party session routes never accept an OAuth access token', async () => {
    const client = await environment.createClient();
    const issued = await issueTokens(client);
    const response = await environment.auth.handler(
      new Request(`${TEST_ISSUER}/get-session`, { headers: { authorization: `Bearer ${issued.access_token}` } }),
    );
    expect(await response.json()).toBeNull();
  });

  it('accepting a narrower consent excludes refresh permission and later consent cannot widen old tokens', async () => {
    const client = await environment.createClient({ skipConsent: false });
    const initial = await environment.authorize(client);
    const narrowed = await environment.consent(client.owner, {
      accept: true,
      oauth_query: new URL(initial.location!).searchParams.toString(),
      scope: 'profile:read',
    });
    expect(narrowed.response.status).toBe(200);
    const originalTokens = await environment.exchange(client, {
      location: narrowed.body.url!,
      verifier: initial.verifier,
    });
    expect(originalTokens.response.status).toBe(200);
    expect(originalTokens.body.refresh_token).toBeUndefined();
    const expanded = await environment.authorize(client, { scopes: ['profile:read', 'offline_access'] });
    const accepted = await environment.consent(client.owner, {
      accept: true,
      oauth_query: new URL(expanded.location!).searchParams.toString(),
    });
    const expandedTokens = await environment.exchange(client, {
      location: accepted.body.url!,
      verifier: expanded.verifier,
    });
    expect(expandedTokens.response.status).toBe(200);
    expect((await environment.introspect(client, originalTokens.body.access_token!)).body.scope).toBe('profile:read');
    expect((await environment.introspect(client, expandedTokens.body.access_token!)).body.scope).toBe(
      'profile:read offline_access',
    );
  });

  it('checks the consent signature before the fence, so a forged query cannot touch another app', async () => {
    const client = await environment.createClient({ skipConsent: false });
    const otherClient = await environment.createClient({ skipConsent: false });
    const authorization = await environment.authorize(client);
    const query = new URL(authorization.location!).searchParams.toString();
    const tampered = await environment.consent(client.owner, {
      accept: true,
      oauth_query: `${query}&scope=profile:read`,
    });
    expect(tampered.response.status).toBe(400);
    const forged = await environment.consent(client.owner, {
      accept: true,
      oauth_query: query.replace(client.clientId, otherClient.clientId),
    });
    expect(forged.response.status).toBe(400);
    expect(
      await db
        .select()
        .from(oauthConnections)
        .where(
          and(eq(oauthConnections.clientId, otherClient.clientId), eq(oauthConnections.userId, client.owner.userId)),
        ),
    ).toHaveLength(0);
  });

  it('form POST authorization works when the parameters are in the body', async () => {
    const client = await environment.createClient();
    const verifier = randomBytes(32).toString('base64url');
    const response = await environment.instance.handler(
      new Request(`${TEST_ISSUER}/oauth2/authorize?client_id=ignored-query-client`, {
        method: 'POST',
        headers: {
          [TEST_SESSION_HEADER]: client.owner.sessionToken,
          origin: 'https://www.boardsesh.test',
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body: new URLSearchParams({
          response_type: 'code',
          client_id: client.clientId,
          redirect_uri: client.redirectUri,
          scope: 'profile:read offline_access',
          resource: TEST_RESOURCE,
          state: randomUUID(),
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
        }),
      }),
    );
    expect(response.status).toBe(302);
    const location = response.headers.get('location')!;
    expect(new URL(location).searchParams.has('code')).toBe(true);
    expect((await environment.exchange(client, { location, verifier })).response.status).toBe(200);
  });
});
