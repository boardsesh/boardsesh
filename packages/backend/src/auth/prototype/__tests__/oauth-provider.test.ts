import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createAuthMiddleware } from 'better-auth/api';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { createPrototypeEnvironment } from '../environment';
import { createPrototypeAuthority } from '../authority';
import { PROTOTYPE_ISSUER, PROTOTYPE_OAUTH_OPTIONS, PROTOTYPE_RESOURCE } from '../oauth-options';
import { createSerializedPrototypeOAuthHandler, disconnectPrototypeOAuthConnection } from '../oauth-transaction';
import { createPrototypeLegacyHandler, revokePrototypeUser } from '../legacy-bridge';
import { rejectPrototypeServerFailure } from '../transaction-response';

type PrototypeEnvironment = Awaited<ReturnType<typeof createPrototypeEnvironment>>;
type PrototypeAuthority = PrototypeEnvironment['auth'];
type PrototypeHandler = Pick<PrototypeAuthority, 'handler'>;

interface OAuthClientFixture {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  cookie: string;
  userId: string;
}

interface OAuthResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  active?: boolean;
  aud?: string | string[];
  sub?: string;
  client_id?: string;
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  url?: string;
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
}

async function postForm(authority: PrototypeHandler, path: string, fields: Record<string, string>) {
  const response = await authority.handler(
    new Request(`${PROTOTYPE_ISSUER}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    }),
  );
  const responseText = await response.text();
  return { response, body: (responseText ? JSON.parse(responseText) : {}) as OAuthResponse };
}

async function postJson(authority: PrototypeHandler, path: string, cookie: string, body: Record<string, unknown>) {
  const response = await authority.handler(
    new Request(`${PROTOTYPE_ISSUER}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://www.boardsesh.test' },
      body: JSON.stringify(body),
    }),
  );
  return { response, body: (await response.json()) as OAuthResponse };
}

function clientCredentials(client: OAuthClientFixture): Record<string, string> {
  return {
    client_id: client.clientId,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
  };
}

function revocationPresentation(token: string, presentation: string): string {
  if (presentation === 'whitespace') return `  ${token}  `;
  if (presentation === 'Bearer' || presentation === 'DPoP') return `${presentation} ${token}`;
  return token;
}

describe('BA-01 pinned OAuth Provider against disposable Postgres', () => {
  let environment: PrototypeEnvironment;

  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
  });

  afterAll(async () => {
    await environment?.close();
  });

  async function createClient(
    options: { publicClient?: boolean; skipConsent?: boolean; owner?: OAuthClientFixture } = {},
  ) {
    const identifier = randomUUID();
    let cookie: string;
    let userId: string;
    if (options.owner) {
      cookie = options.owner.cookie;
      userId = options.owner.userId;
    } else {
      const signup = await environment.auth.api.signUpEmail({
        body: {
          name: 'OAuth prototype climber',
          email: `${identifier}@example.test`,
          password: 'prototype-password-123',
        },
        asResponse: true,
      });
      expect(signup.status).toBe(200);
      cookie = cookieHeader(signup);
      expect(cookie).not.toBe('');
      const signedUp = (await signup.json()) as { user: { id: string } };
      userId = signedUp.user.id;
    }
    const redirectUri = `https://client.example.test/callback/${identifier}`;
    const registered = await environment.auth.api.adminCreateOAuthClient({
      headers: new Headers({ cookie }),
      body: {
        client_name: 'BA-01 fixture',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: options.publicClient ? 'none' : 'client_secret_post',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: PROTOTYPE_OAUTH_OPTIONS.scopes.join(' '),
        require_pkce: true,
        skip_consent: options.skipConsent ?? true,
      },
    });
    if (!registered?.client_id) throw new Error('Prototype client registration did not return an ID');
    await environment.database.insert(environment.schema.oauthClientResource).values({
      id: randomUUID(),
      clientId: registered.client_id,
      resourceId: PROTOTYPE_RESOURCE,
      createdAt: new Date(),
    });
    return {
      clientId: registered.client_id,
      clientSecret: registered.client_secret ?? undefined,
      redirectUri,
      cookie,
      userId,
    } satisfies OAuthClientFixture;
  }

  async function authorize(
    client: OAuthClientFixture,
    options: { scopes?: string[]; challengeMethod?: string; omitChallenge?: boolean; resource?: string } = {},
    authority: PrototypeHandler = environment.auth,
  ) {
    const verifier = randomBytes(32).toString('base64url');
    const authorization = new URL(`${PROTOTYPE_ISSUER}/oauth2/authorize`);
    authorization.search = new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      scope: (options.scopes ?? ['profile:read', 'offline_access']).join(' '),
      state: randomUUID(),
      resource: options.resource ?? PROTOTYPE_RESOURCE,
      ...(options.omitChallenge
        ? {}
        : {
            code_challenge: createHash('sha256').update(verifier).digest('base64url'),
            code_challenge_method: options.challengeMethod ?? 'S256',
          }),
    }).toString();
    const response = await authority.handler(new Request(authorization, { headers: { cookie: client.cookie } }));
    const location = response.headers.get('location');
    return { response, location, verifier, state: authorization.searchParams.get('state') };
  }

  async function exchange(
    client: OAuthClientFixture,
    authorization: { location: string | null; verifier: string },
    authority: PrototypeHandler = environment.auth,
    overrides: Record<string, string> = {},
  ) {
    if (!authorization.location) throw new Error('Authorization did not return a redirect');
    const code = new URL(authorization.location).searchParams.get('code');
    if (!code) throw new Error(`Authorization did not return a code: ${authorization.location}`);
    return postForm(authority, '/oauth2/token', {
      grant_type: 'authorization_code',
      code,
      code_verifier: authorization.verifier,
      redirect_uri: client.redirectUri,
      ...clientCredentials(client),
      ...overrides,
    });
  }

  async function issueTokens(
    client: OAuthClientFixture,
    scopes?: string[],
    authority: PrototypeHandler = environment.auth,
  ) {
    const authorization = await authorize(client, { scopes }, authority);
    const issued = await exchange(client, authorization, authority);
    expect(issued.response.status).toBe(200);
    expect(issued.body.access_token).toBeTypeOf('string');
    return issued.body;
  }

  function introspect(
    client: OAuthClientFixture,
    token: string,
    authority: PrototypeHandler = environment.secondaryAuth,
  ) {
    return postForm(authority, '/oauth2/introspect', { token, ...clientCredentials(client) });
  }

  function refresh(
    client: OAuthClientFixture,
    token: string,
    authority: PrototypeHandler = environment.secondaryAuth,
    scope?: string,
  ) {
    return postForm(authority, '/oauth2/token', {
      grant_type: 'refresh_token',
      refresh_token: token,
      ...clientCredentials(client),
      ...(scope ? { scope } : {}),
    });
  }

  it('serves RFC 8414 path insertion and OIDC append discovery with identical issuer', async () => {
    const issuer = new URL(PROTOTYPE_ISSUER);
    const metadataPaths = [
      `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`,
      `${PROTOTYPE_ISSUER}/.well-known/openid-configuration`,
    ];
    for (const metadataUrl of metadataPaths) {
      const response = await environment.auth.handler(new Request(metadataUrl));
      expect(response.status).toBe(200);
      const metadata = (await response.json()) as OAuthResponse;
      expect(metadata.issuer).toBe(PROTOTYPE_ISSUER);
      expect(metadata.authorization_endpoint).toBe(`${PROTOTYPE_ISSUER}/oauth2/authorize`);
      expect(metadata.token_endpoint).toBe(`${PROTOTYPE_ISSUER}/oauth2/token`);
      expect(metadata.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
      expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    }
  });

  it('redeems a PKCE code on another instance and binds an opaque access token to the resource and scopes', async () => {
    const client = await createClient();
    const authorization = await authorize(client);
    expect(authorization.response.status).toBe(302);
    const redirect = new URL(authorization.location!);
    expect(redirect.searchParams.get('state')).toBe(authorization.state);
    expect(redirect.searchParams.get('iss')).toBe(PROTOTYPE_ISSUER);
    const issued = await exchange(client, authorization, environment.secondaryAuth);
    expect(issued.response.status).toBe(200);
    expect(issued.body.token_type).toBe('Bearer');
    expect(issued.body.access_token).toBeTypeOf('string');
    expect(issued.body.access_token!.split('.')).toHaveLength(1);
    expect(issued.body.refresh_token).toBeTypeOf('string');
    expect(issued.body.expires_in).toBe(3600);
    const inspected = await introspect(client, issued.body.access_token!);
    expect(inspected.body).toMatchObject({
      active: true,
      sub: client.userId,
      client_id: client.clientId,
      scope: 'profile:read offline_access',
    });
    expect([inspected.body.aud].flat()).toContain(PROTOTYPE_RESOURCE);
    expect(issued.response.headers.get('cache-control')).toContain('no-store');

    const [accessRecord] = await environment.database
      .select()
      .from(environment.schema.oauthAccessToken)
      .where(eq(environment.schema.oauthAccessToken.clientId, client.clientId));
    const [refreshRecord] = await environment.database
      .select()
      .from(environment.schema.oauthRefreshToken)
      .where(eq(environment.schema.oauthRefreshToken.clientId, client.clientId));
    expect(accessRecord.token).not.toBe(issued.body.access_token);
    expect(refreshRecord.token).not.toBe(issued.body.refresh_token);
    expect(accessRecord.expiresAt.getTime() - accessRecord.createdAt.getTime()).toBe(3600 * 1000);
    expect(refreshRecord.expiresAt.getTime() - refreshRecord.createdAt.getTime()).toBe(90 * 24 * 3600 * 1000);
  });

  it('public clients redeem PKCE codes and rotate without a client secret', async () => {
    const client = await createClient({ publicClient: true });
    expect(client.clientSecret).toBeUndefined();
    const authorization = await authorize(client);
    const codeRows = await environment.database.select().from(environment.schema.verification);
    const code = codeRows.find((record) => {
      const payload = JSON.parse(record.value) as { query?: { client_id?: string } };
      return payload.query?.client_id === client.clientId;
    });
    expect(code).toBeDefined();
    expect(code!.expiresAt.getTime() - code!.createdAt.getTime()).toBe(60 * 1000);
    const issued = await exchange(client, authorization, environment.secondaryAuth);
    expect(issued.response.status).toBe(200);
    expect(issued.body.expires_in).toBe(3600);
    const rotated = await refresh(client, issued.body.refresh_token!, environment.auth);
    expect(rotated.response.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(issued.body.refresh_token);
  });

  it('requires offline_access before issuing a refresh token', async () => {
    const client = await createClient();
    const issued = await issueTokens(client, ['profile:read']);
    expect(issued.refresh_token).toBeUndefined();
  });

  it.each([{ challengeMethod: 'plain' }, { omitChallenge: true }])(
    'rejects authorization without PKCE S256: %j',
    async (options) => {
      const client = await createClient({ publicClient: true });
      const authorization = await authorize(client, options);
      expect(authorization.response.status).toBe(302);
      const rejected = new URL(authorization.location!);
      expect(rejected.searchParams.get('error')).toBe('invalid_request');
      expect(rejected.searchParams.has('code')).toBe(false);
      expect(
        await environment.database
          .select()
          .from(environment.schema.oauthAccessToken)
          .where(eq(environment.schema.oauthAccessToken.clientId, client.clientId)),
      ).toHaveLength(0);
    },
  );

  it('rejects a wrong PKCE verifier and a redirect substitution', async () => {
    const client = await createClient();
    const invalidExchanges: Record<string, string>[] = [
      { code_verifier: randomBytes(32).toString('base64url') },
      { redirect_uri: 'https://evil.test/callback' },
    ];
    for (const overrides of invalidExchanges) {
      const authorization = await authorize(client);
      const rejected = await exchange(client, authorization, environment.secondaryAuth, overrides);
      expect(rejected.response.status).toBe(400);
      expect(rejected.body.access_token).toBeUndefined();
    }
  });

  it('rejects scopes and audiences outside the client authorization', async () => {
    const client = await createClient();
    const scopeRequest = await authorize(client, { scopes: ['not-granted:write'] });
    expect(scopeRequest.response.status).toBe(302);
    expect(new URL(scopeRequest.location!).searchParams.get('error')).toBe('invalid_scope');
    const resourceRequest = await authorize(client, { resource: 'https://evil.test/v1' });
    expect(resourceRequest.response.status).toBe(302);
    expect(new URL(resourceRequest.location!).searchParams.get('error')).toBe('invalid_target');
    expect(
      await environment.database
        .select()
        .from(environment.schema.oauthAccessToken)
        .where(eq(environment.schema.oauthAccessToken.clientId, client.clientId)),
    ).toHaveLength(0);
  });

  it('redeems an authorization code at most once across two instances', async () => {
    const client = await createClient();
    const authorization = await authorize(client);
    const redemptions = await Promise.all([
      exchange(client, authorization, environment.auth),
      exchange(client, authorization, environment.secondaryAuth),
    ]);
    // The property is at most one winner. Under load both can lose, which is safe.
    const winners = redemptions.filter(({ response }) => response.status === 200);
    expect(winners.length).toBeLessThanOrEqual(1);
    expect(redemptions.filter(({ response }) => response.status >= 400)).toHaveLength(2 - winners.length);
  });

  it('rotates refresh tokens and sequential replay invalidates the app/user family', async () => {
    const client = await createClient();
    const issued = await issueTokens(client);
    const rotated = await refresh(client, issued.refresh_token!);
    expect(rotated.response.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(issued.refresh_token);
    const replay = await refresh(client, issued.refresh_token!, environment.auth);
    expect(replay.body.error).toBe('invalid_grant');
    expect((await introspect(client, rotated.body.access_token!)).body.active).toBe(false);
    expect((await refresh(client, rotated.body.refresh_token!)).body.error).toBe('invalid_grant');
  });

  it('stock rolling refresh issues past day 90 but an expired retained browser session disables opaque access', async () => {
    const client = await createClient();
    const issued = await issueTokens(client);
    const originalTime = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(originalTime + 30 * 24 * 3600 * 1000);
      const day30 = await refresh(client, issued.refresh_token!);
      expect(day30.response.status).toBe(200);
      vi.setSystemTime(originalTime + 91 * 24 * 3600 * 1000);
      const day91 = await refresh(client, day30.body.refresh_token!, environment.auth);
      expect(day91.response.status).toBe(200);
      // This stock-provider limitation remains a separate partner readiness gate.
      expect((await introspect(client, day91.body.access_token!)).body.active).toBe(false);
      const [currentRefresh] = await environment.database
        .select()
        .from(environment.schema.oauthRefreshToken)
        .where(
          and(
            eq(environment.schema.oauthRefreshToken.clientId, client.clientId),
            isNull(environment.schema.oauthRefreshToken.revoked),
          ),
        );
      expect(currentRefresh.expiresAt.getTime() - currentRefresh.createdAt.getTime()).toBe(90 * 24 * 3600 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stock replay cleanup also invalidates independent app/user grants, a partner-contract blocker', async () => {
    const client = await createClient();
    const firstGrant = await issueTokens(client);
    const independentGrant = await issueTokens(client);
    expect((await refresh(client, firstGrant.refresh_token!)).response.status).toBe(200);
    expect((await refresh(client, firstGrant.refresh_token!, environment.auth)).body.error).toBe('invalid_grant');
    // Required isolated-family behavior is not supplied by the stock provider.
    expect((await introspect(client, independentGrant.access_token!)).body.active).toBe(false);
  });

  it('never widens a token scope when refreshing', async () => {
    const client = await createClient();
    const issued = await issueTokens(client, ['profile:read', 'offline_access']);
    const widened = await refresh(
      client,
      issued.refresh_token!,
      environment.secondaryAuth,
      'profile:read logbook:read offline_access',
    );
    expect(widened.response.status).toBe(400);
    expect(widened.body.error).toBe('invalid_scope');
    expect((await introspect(client, issued.access_token!)).body.scope).toBe('profile:read offline_access');
  });

  it('individual access-token revocation preserves the refresh credential', async () => {
    const client = await createClient();
    const issued = await issueTokens(client);
    const revoked = await postForm(environment.secondaryAuth, '/oauth2/revoke', {
      token: issued.access_token!,
      token_type_hint: 'access_token',
      ...clientCredentials(client),
    });
    expect(revoked.response.status).toBe(200);
    expect((await introspect(client, issued.access_token!)).body.active).toBe(false);
    expect((await refresh(client, issued.refresh_token!)).response.status).toBe(200);
  });

  it('first-party cookie sessions cannot be authenticated with an OAuth access token', async () => {
    const client = await createClient();
    const issued = await issueTokens(client);
    const response = await environment.secondaryAuth.handler(
      new Request(`${PROTOTYPE_ISSUER}/get-session`, { headers: { authorization: `Bearer ${issued.access_token}` } }),
    );
    expect(await response.json()).toBeNull();
  });

  it('existing opaque access tokens fail introspection after client suspension', async () => {
    const client = await createClient();
    const issued = await issueTokens(client);
    await environment.auth.api.adminUpdateOAuthClient({
      headers: new Headers({ cookie: client.cookie }),
      body: { client_id: client.clientId, update: { disabled: true } },
    });
    const inspected = await introspect(client, issued.access_token!);
    expect(inspected.response.status).not.toBe(200);
    expect(inspected.body.active).not.toBe(true);
    expect((await refresh(client, issued.refresh_token!)).response.status).not.toBe(200);
  });

  it('secret rotation invalidates the previous secret immediately', async () => {
    const client = await createClient();
    const issued = await issueTokens(client);
    const rotated = await environment.auth.api.rotateClientSecret({
      headers: new Headers({ cookie: client.cookie }),
      body: { client_id: client.clientId },
    });
    expect(rotated.client_secret).toBeTypeOf('string');
    expect((await introspect(client, issued.access_token!)).body.error).toBe('invalid_client');
    const currentClient = { ...client, clientSecret: rotated.client_secret };
    expect((await introspect(currentClient, issued.access_token!)).body.active).toBe(true);
  });

  it('provider consent deletion alone does not implement product Disconnect', async () => {
    const client = await createClient({ skipConsent: false });
    const authorization = await authorize(client);
    expect(authorization.location).toContain(PROTOTYPE_OAUTH_OPTIONS.consentPage);
    const consentQuery = new URL(authorization.location!).searchParams.toString();
    const consent = await postJson(environment.auth, '/oauth2/consent', client.cookie, {
      accept: true,
      oauth_query: consentQuery,
    });
    expect(consent.response.status).toBe(200);
    const issued = await exchange(client, { location: consent.body.url!, verifier: authorization.verifier });
    expect(issued.response.status).toBe(200);
    const consents = await environment.auth.api.getOAuthConsents({ headers: new Headers({ cookie: client.cookie }) });
    const connectionConsent = consents.find((record) => record.clientId === client.clientId);
    if (!connectionConsent) throw new Error('Expected persisted fixture consent');
    await environment.auth.api.deleteOAuthConsent({
      headers: new Headers({ cookie: client.cookie }),
      body: { id: connectionConsent.id },
    });
    // This is a deliberate gap characterization. It is never a launch assertion.
    expect((await introspect(client, issued.body.access_token!)).body.active).toBe(true);
    expect((await refresh(client, issued.body.refresh_token!)).response.status).toBe(200);
  });

  it('serialized cross-instance refresh races invalidate every descendant when reuse is detected', async () => {
    const client = await createClient();
    const firstInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const secondInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const issued = await issueTokens(client, undefined, firstInstance);
    const redemptions = await Promise.all([
      refresh(client, issued.refresh_token!, firstInstance),
      refresh(client, issued.refresh_token!, secondInstance),
    ]);
    const successful = redemptions.filter(({ response }) => response.status === 200);
    expect(successful).toHaveLength(1);
    expect(redemptions.filter(({ body }) => body.error === 'invalid_grant')).toHaveLength(1);
    const winner = successful[0].body;
    expect((await introspect(client, winner.access_token!, secondInstance)).body.active).toBe(false);
    expect((await refresh(client, winner.refresh_token!, firstInstance)).body.error).toBe('invalid_grant');
  });

  it.each([false, true])(
    'scoped-family glue preserves independent grants for publicClient=%s',
    async (publicClient) => {
      const client = await createClient({ publicClient });
      const firstInstance = createSerializedPrototypeOAuthHandler(environment.database);
      const secondInstance = createSerializedPrototypeOAuthHandler(environment.database);
      const firstGrant = await issueTokens(client, undefined, firstInstance);
      const independentGrant = await issueTokens(client, undefined, firstInstance);
      const rotated = await refresh(client, firstGrant.refresh_token!, firstInstance);
      expect(rotated.response.status).toBe(200);
      expect((await refresh(client, firstGrant.refresh_token!, secondInstance)).body.error).toBe('invalid_grant');
      expect((await refresh(client, rotated.body.refresh_token!, secondInstance)).body.error).toBe('invalid_grant');
      const independentRefresh = await refresh(client, independentGrant.refresh_token!, firstInstance);
      expect(independentRefresh.response.status).toBe(200);
      if (!publicClient) {
        expect((await introspect(client, independentRefresh.body.access_token!, secondInstance)).body.active).toBe(
          true,
        );
      }
    },
  );

  it('invalid confidential-client authentication cannot trigger family cleanup', async () => {
    const client = await createClient();
    const firstInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const secondInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const issued = await issueTokens(client, undefined, firstInstance);
    const rotated = await refresh(client, issued.refresh_token!, firstInstance);
    for (const clientSecret of [undefined, 'wrong-secret']) {
      const rejected = await refresh({ ...client, clientSecret }, issued.refresh_token!, secondInstance);
      expect(rejected.body.error).toBe('invalid_client');
      expect((await introspect(client, rotated.body.access_token!, firstInstance)).body.active).toBe(true);
    }
    expect((await refresh(client, rotated.body.refresh_token!, secondInstance)).response.status).toBe(200);
  });

  it.each(['raw', 'whitespace', 'Bearer', 'DPoP'])(
    'cross-client consumed-token revocation cannot revoke either public connection: %s',
    async (presentation) => {
      const firstClient = await createClient({ publicClient: true });
      const secondClient = await createClient({ publicClient: true, owner: firstClient });
      const firstInstance = createSerializedPrototypeOAuthHandler(environment.database);
      const secondInstance = createSerializedPrototypeOAuthHandler(environment.database);
      const firstTokens = await issueTokens(firstClient, undefined, firstInstance);
      const secondTokens = await issueTokens(secondClient, undefined, firstInstance);
      const rotatedFirst = await refresh(firstClient, firstTokens.refresh_token!, firstInstance);
      const wrongClientRefresh = await refresh(secondClient, firstTokens.refresh_token!, secondInstance);
      expect(wrongClientRefresh.body.error).toBe('invalid_grant');
      const wrongClientRevoke = await postForm(secondInstance, '/oauth2/revoke', {
        client_id: secondClient.clientId,
        token: revocationPresentation(firstTokens.refresh_token!, presentation),
        token_type_hint: 'refresh_token',
      });
      expect(wrongClientRevoke.response.status).toBe(200);
      expect((await refresh(secondClient, secondTokens.refresh_token!, secondInstance)).response.status).toBe(200);
      expect((await refresh(firstClient, rotatedFirst.body.refresh_token!, firstInstance)).response.status).toBe(200);
    },
  );

  it.each(['raw', 'whitespace', 'Bearer', 'DPoP'])(
    'consumed-token revocation removes only its grant family: %s',
    async (presentation) => {
      const client = await createClient();
      const firstInstance = createSerializedPrototypeOAuthHandler(environment.database);
      const secondInstance = createSerializedPrototypeOAuthHandler(environment.database);
      const firstGrant = await issueTokens(client, undefined, firstInstance);
      const independentGrant = await issueTokens(client, undefined, firstInstance);
      const rotated = await refresh(client, firstGrant.refresh_token!, firstInstance);
      const revoked = await postForm(secondInstance, '/oauth2/revoke', {
        token: revocationPresentation(firstGrant.refresh_token!, presentation),
        token_type_hint: 'refresh_token',
        ...clientCredentials(client),
      });
      expect(revoked.response.status).toBe(200);
      expect((await introspect(client, rotated.body.access_token!, firstInstance)).body.active).toBe(false);
      expect((await introspect(client, independentGrant.access_token!, firstInstance)).body.active).toBe(true);
    },
  );

  it('revoking an expired consumed ancestor cannot destroy a later independent grant', async () => {
    const client = await createClient();
    const firstInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const secondInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const initialTime = Date.now();
    const firstGrant = await issueTokens(client, undefined, firstInstance);
    expect((await refresh(client, firstGrant.refresh_token!, firstInstance)).response.status).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(initialTime + 91 * 24 * 3600 * 1000);
      const signedIn = await environment.auth.api.signInEmail({
        body: {
          email: (
            await environment.database
              .select()
              .from(environment.schema.user)
              .where(eq(environment.schema.user.id, client.userId))
          )[0].email,
          password: 'prototype-password-123',
        },
        asResponse: true,
      });
      expect(signedIn.status).toBe(200);
      const laterClient = { ...client, cookie: cookieHeader(signedIn) };
      const laterGrant = await issueTokens(laterClient, undefined, firstInstance);
      const revoked = await postForm(secondInstance, '/oauth2/revoke', {
        ...clientCredentials(client),
        token: `Bearer ${firstGrant.refresh_token!}`,
        token_type_hint: 'refresh_token',
      });
      expect(revoked.response.status).toBe(200);
      expect((await introspect(client, laterGrant.access_token!, secondInstance)).body.active).toBe(true);
      expect((await refresh(client, laterGrant.refresh_token!, secondInstance)).response.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { pruneProviderRow: false, signOut: false },
    { pruneProviderRow: true, signOut: false },
    { pruneProviderRow: false, signOut: true },
    { pruneProviderRow: true, signOut: true },
  ])('expired consumed refresh reuse ends only its rolling family: %j', async ({ pruneProviderRow, signOut }) => {
    const client = await createClient();
    const anotherClient = await createClient({ publicClient: true, owner: client });
    const firstInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const secondInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const firstGrant = await issueTokens(client, undefined, firstInstance);
    const [ancestor] = await environment.database
      .select()
      .from(environment.schema.prototypeOAuthRefreshAncestor)
      .where(eq(environment.schema.prototypeOAuthRefreshAncestor.clientId, client.clientId));
    expect(ancestor.tokenHash).not.toBe(firstGrant.refresh_token);
    const independentGrant = await issueTokens(client, undefined, firstInstance);
    const initialSessions = await environment.database
      .select()
      .from(environment.schema.session)
      .where(eq(environment.schema.session.userId, client.userId));
    expect(initialSessions).toHaveLength(1);
    if (signOut) {
      expect((await postJson(environment.auth, '/sign-out', client.cookie, {})).response.status).toBe(200);
      expect((await introspect(client, firstGrant.access_token!, secondInstance)).body.active).toBe(true);
    }
    const initialTime = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(initialTime + 30 * 24 * 3600 * 1000);
      const firstDay30 = await refresh(client, firstGrant.refresh_token!, firstInstance);
      const independentDay30 = await refresh(client, independentGrant.refresh_token!, firstInstance);
      expect(firstDay30.response.status).toBe(200);
      expect(independentDay30.response.status).toBe(200);
      expect((await introspect(client, firstDay30.body.access_token!, secondInstance)).body.active).toBe(true);
      expect((await introspect(client, independentDay30.body.access_token!, secondInstance)).body.active).toBe(true);
      vi.setSystemTime(initialTime + 91 * 24 * 3600 * 1000);
      const firstDay91 = await refresh(client, firstDay30.body.refresh_token!, secondInstance);
      const independentDay91 = await refresh(client, independentDay30.body.refresh_token!, secondInstance);
      expect(firstDay91.response.status).toBe(200);
      expect(independentDay91.response.status).toBe(200);
      expect((await introspect(client, firstDay91.body.access_token!, secondInstance)).body.active).toBe(true);
      expect((await introspect(client, independentDay91.body.access_token!, secondInstance)).body.active).toBe(true);
      const sessions = await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, client.userId));
      expect(sessions).toHaveLength(signOut ? 0 : 1);
      if (!signOut) {
        expect(sessions[0].expiresAt.getTime()).toBeLessThan(Date.now());
        expect(sessions[0].createdAt).toEqual(initialSessions[0].createdAt);
      }
      if (pruneProviderRow) {
        // Model the provider's expired-token cleanup, including its FK children.
        await environment.database
          .delete(environment.schema.oauthRefreshToken)
          .where(eq(environment.schema.oauthRefreshToken.token, ancestor.tokenHash));
      }
      const [retained] = await environment.database
        .select()
        .from(environment.schema.prototypeOAuthRefreshAncestor)
        .where(eq(environment.schema.prototypeOAuthRefreshAncestor.tokenHash, ancestor.tokenHash));
      expect(retained.expiresAt.getTime()).toBeLessThan(Date.now());
      expect(retained.consumedAt).not.toBeNull();

      const restarted = createSerializedPrototypeOAuthHandler(environment.database);
      const invalidSecret = await refresh(
        { ...client, clientSecret: 'wrong-secret' },
        firstGrant.refresh_token!,
        restarted,
      );
      expect(invalidSecret.body.error).toBe('invalid_client');
      expect((await refresh(anotherClient, firstGrant.refresh_token!, restarted)).body.error).toBe('invalid_grant');
      const expiredRevoke = await postForm(restarted, '/oauth2/revoke', {
        ...clientCredentials(client),
        token: `Bearer ${firstGrant.refresh_token!}`,
        token_type_hint: 'refresh_token',
      });
      expect(expiredRevoke.response.status).toBe(200);
      expect((await introspect(client, firstDay91.body.access_token!, restarted)).body.active).toBe(true);

      const replay = await refresh(client, firstGrant.refresh_token!, restarted);
      expect(replay.body.error).toBe('invalid_grant');
      expect((await introspect(client, firstDay91.body.access_token!, secondInstance)).body.active).toBe(false);
      expect((await refresh(client, firstDay91.body.refresh_token!, firstInstance)).body.error).toBe('invalid_grant');
      expect((await introspect(client, independentDay91.body.access_token!, secondInstance)).body.active).toBe(true);
      expect((await refresh(client, independentDay91.body.refresh_token!, firstInstance)).response.status).toBe(200);
      const retainedFamilies = await environment.database
        .select()
        .from(environment.schema.prototypeOAuthRefreshAncestor)
        .where(eq(environment.schema.prototypeOAuthRefreshAncestor.clientId, client.clientId));
      expect(retainedFamilies).not.toHaveLength(0);
      expect(retainedFamilies.every((record) => record.authorizationCodeId !== ancestor.authorizationCodeId)).toBe(
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('offline detachment leaves grants without offline_access session-bound', async () => {
    const client = await createClient();
    const firstInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const issued = await issueTokens(client, ['profile:read'], firstInstance);
    expect(issued.refresh_token).toBeUndefined();
    const [accessToken] = await environment.database
      .select()
      .from(environment.schema.oauthAccessToken)
      .where(eq(environment.schema.oauthAccessToken.clientId, client.clientId));
    expect(accessToken.sessionId).not.toBeNull();
    expect((await introspect(client, issued.access_token!, firstInstance)).body.active).toBe(true);
    expect((await postJson(environment.auth, '/sign-out', client.cookie, {})).response.status).toBe(200);
    expect((await introspect(client, issued.access_token!, firstInstance)).body.active).toBe(false);
  });

  it('RFC revocation searches the actual supported token type when the hint is wrong', async () => {
    const client = await createClient();
    const firstInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const secondInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const issued = await issueTokens(client, undefined, firstInstance);
    const revokeAccess = await postForm(secondInstance, '/oauth2/revoke', {
      ...clientCredentials(client),
      token: issued.access_token!,
      token_type_hint: 'refresh_token',
    });
    expect(revokeAccess.response.status).toBe(200);
    expect((await introspect(client, issued.access_token!, secondInstance)).body.active).toBe(false);
    const rotated = await refresh(client, issued.refresh_token!, firstInstance);
    expect(rotated.response.status).toBe(200);
    const revokeRefresh = await postForm(secondInstance, '/oauth2/revoke', {
      ...clientCredentials(client),
      token: rotated.body.refresh_token!,
      token_type_hint: 'access_token',
    });
    expect(revokeRefresh.response.status).toBe(200);
    expect((await introspect(client, rotated.body.access_token!, firstInstance)).body.active).toBe(false);
    expect((await refresh(client, rotated.body.refresh_token!, firstInstance)).body.error).toBe('invalid_grant');
  });

  it('a provider failure after token mint rolls back both tokens and code consumption', async () => {
    const client = await createClient();
    const healthyInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const failingInstance = createSerializedPrototypeOAuthHandler(environment.database, {
      plugins: [
        {
          id: 'prototype-injected-mint-failure',
          hooks: {
            after: [
              {
                matcher: (context) => context.path === '/oauth2/token',
                handler: createAuthMiddleware(async () => {
                  throw new Error('Injected disposable token-mint failure');
                }),
              },
            ],
          },
        },
      ],
    });
    const authorization = await authorize(client, {}, healthyInstance);
    const failed = await exchange(client, authorization, failingInstance);
    expect(failed.response.status).toBe(500);
    const accessRows = await environment.database
      .select()
      .from(environment.schema.oauthAccessToken)
      .where(eq(environment.schema.oauthAccessToken.clientId, client.clientId));
    const refreshRows = await environment.database
      .select()
      .from(environment.schema.oauthRefreshToken)
      .where(eq(environment.schema.oauthRefreshToken.clientId, client.clientId));
    expect(accessRows).toHaveLength(0);
    expect(refreshRows).toHaveLength(0);
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeOAuthRefreshAncestor)
        .where(eq(environment.schema.prototypeOAuthRefreshAncestor.clientId, client.clientId)),
    ).toHaveLength(0);
    expect((await exchange(client, authorization, healthyInstance)).response.status).toBe(200);
  });

  it('a failed refresh mint rolls back successor ancestry and parent consumption together', async () => {
    const client = await createClient();
    const healthyInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const issued = await issueTokens(client, undefined, healthyInstance);
    const failingInstance = createSerializedPrototypeOAuthHandler(environment.database, {
      plugins: [
        {
          id: 'prototype-injected-refresh-ancestry-failure',
          hooks: {
            after: [
              {
                matcher: (context) => context.path === '/oauth2/token',
                handler: createAuthMiddleware(async () => {
                  throw new Error('Injected disposable refresh ancestry failure');
                }),
              },
            ],
          },
        },
      ],
    });
    expect((await refresh(client, issued.refresh_token!, failingInstance)).response.status).toBe(500);
    const providerRows = await environment.database
      .select()
      .from(environment.schema.oauthRefreshToken)
      .where(eq(environment.schema.oauthRefreshToken.clientId, client.clientId));
    const ancestorRows = await environment.database
      .select()
      .from(environment.schema.prototypeOAuthRefreshAncestor)
      .where(eq(environment.schema.prototypeOAuthRefreshAncestor.clientId, client.clientId));
    expect(providerRows).toHaveLength(1);
    expect(providerRows[0].revoked).toBeNull();
    expect(ancestorRows).toHaveLength(1);
    expect(ancestorRows[0].consumedAt).toBeNull();
    expect((await refresh(client, issued.refresh_token!, healthyInstance)).response.status).toBe(200);
  });

  it('transactional Disconnect wins against issuance and preserves unrelated connections', async () => {
    const client = await createClient();
    const unrelated = await createClient();
    const firstInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const secondInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const issued = await issueTokens(client, undefined, firstInstance);
    const unrelatedTokens = await issueTokens(unrelated, undefined, firstInstance);
    const [racedRefresh] = await Promise.all([
      refresh(client, issued.refresh_token!, firstInstance),
      disconnectPrototypeOAuthConnection(environment.database, client.userId, client.clientId),
    ]);
    expect((await introspect(client, issued.access_token!, secondInstance)).body.active).toBe(false);
    expect((await refresh(client, issued.refresh_token!, secondInstance)).body.error).toBe('invalid_grant');
    if (racedRefresh.body.access_token) {
      expect((await introspect(client, racedRefresh.body.access_token, secondInstance)).body.active).toBe(false);
      expect((await refresh(client, racedRefresh.body.refresh_token!, secondInstance)).body.error).toBe(
        'invalid_grant',
      );
    }
    expect((await introspect(unrelated, unrelatedTokens.access_token!, secondInstance)).body.active).toBe(true);
    const remainingAncestors = await environment.database
      .select()
      .from(environment.schema.prototypeOAuthRefreshAncestor);
    expect(remainingAncestors.some((record) => record.clientId === client.clientId)).toBe(false);
    expect(remainingAncestors.some((record) => record.clientId === unrelated.clientId)).toBe(true);
  });

  it('Disconnect consumes outstanding codes and forces fresh consent after a handler restart', async () => {
    const client = await createClient();
    const firstInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const pending = await authorize(client, {}, firstInstance);
    expect(new URL(pending.location!).searchParams.has('code')).toBe(true);
    await disconnectPrototypeOAuthConnection(environment.database, client.userId, client.clientId);
    const restarted = createSerializedPrototypeOAuthHandler(environment.database);
    expect((await exchange(client, pending, restarted)).body.error).toBe('invalid_grant');
    const reconnect = await authorize(client, {}, restarted);
    expect(reconnect.location).toContain(PROTOTYPE_OAUTH_OPTIONS.consentPage);
  });

  it('immutable consent interactions reject account switches, tampering and replay across instances', async () => {
    const client = await createClient({ skipConsent: false });
    const anotherAccount = await createClient();
    const firstInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const secondInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const authorization = await authorize(client, {}, firstInstance);
    const query = new URL(authorization.location!).searchParams.toString();
    const switched = await postJson(secondInstance, '/oauth2/consent', anotherAccount.cookie, {
      accept: true,
      oauth_query: query,
    });
    expect(switched.response.status).toBe(400);
    const tampered = await postJson(secondInstance, '/oauth2/consent', client.cookie, {
      accept: true,
      oauth_query: `${query}&scope=logbook:read`,
    });
    expect(tampered.response.status).toBe(400);
    const accepted = await postJson(secondInstance, '/oauth2/consent', client.cookie, {
      accept: true,
      oauth_query: query,
    });
    expect(accepted.response.status).toBe(200);
    const issued = await exchange(
      client,
      { location: accepted.body.url!, verifier: authorization.verifier },
      firstInstance,
    );
    expect(issued.response.status).toBe(200);
    expect((await introspect(client, issued.body.access_token!, secondInstance)).body.sub).toBe(client.userId);
    const replay = await postJson(firstInstance, '/oauth2/consent', client.cookie, {
      accept: true,
      oauth_query: query,
    });
    expect(replay.response.status).toBe(400);
  });

  it('a persisted Disconnect generation rejects old consent but permits explicit reconnect', async () => {
    const client = await createClient({ skipConsent: false });
    const firstInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const authorization = await authorize(client, {}, firstInstance);
    const oldQuery = new URL(authorization.location!).searchParams.toString();
    await disconnectPrototypeOAuthConnection(environment.database, client.userId, client.clientId);
    const restarted = createSerializedPrototypeOAuthHandler(environment.database);
    const staleConsent = await postJson(restarted, '/oauth2/consent', client.cookie, {
      accept: true,
      oauth_query: oldQuery,
    });
    expect(staleConsent.response.status).toBe(400);
    const reconnect = await authorize(client, {}, restarted);
    const newQuery = new URL(reconnect.location!).searchParams.toString();
    const accepted = await postJson(restarted, '/oauth2/consent', client.cookie, {
      accept: true,
      oauth_query: newQuery,
    });
    expect(accepted.response.status).toBe(200);
    expect(
      (await exchange(client, { location: accepted.body.url!, verifier: reconnect.verifier }, restarted)).response
        .status,
    ).toBe(200);
  });

  it('accepting a narrower consent excludes refresh permission, and later consent cannot widen old tokens', async () => {
    const client = await createClient({ skipConsent: false });
    const firstInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const secondInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const initial = await authorize(client, {}, firstInstance);
    const narrowed = await postJson(secondInstance, '/oauth2/consent', client.cookie, {
      accept: true,
      oauth_query: new URL(initial.location!).searchParams.toString(),
      scope: 'profile:read',
    });
    expect(narrowed.response.status).toBe(200);
    const originalTokens = await exchange(
      client,
      { location: narrowed.body.url!, verifier: initial.verifier },
      firstInstance,
    );
    expect(originalTokens.response.status).toBe(200);
    expect(originalTokens.body.refresh_token).toBeUndefined();
    const expanded = await authorize(
      client,
      { scopes: ['profile:read', 'logbook:read', 'offline_access'] },
      secondInstance,
    );
    const accepted = await postJson(firstInstance, '/oauth2/consent', client.cookie, {
      accept: true,
      oauth_query: new URL(expanded.location!).searchParams.toString(),
    });
    const expandedTokens = await exchange(
      client,
      { location: accepted.body.url!, verifier: expanded.verifier },
      secondInstance,
    );
    expect(expandedTokens.response.status).toBe(200);
    expect((await introspect(client, originalTokens.body.access_token!, secondInstance)).body.scope).toBe(
      'profile:read',
    );
    expect((await introspect(client, expandedTokens.body.access_token!, firstInstance)).body.scope).toBe(
      'profile:read logbook:read offline_access',
    );
  });

  it('form POST authorization requires fresh consent after Disconnect', async () => {
    const client = await createClient();
    await disconnectPrototypeOAuthConnection(environment.database, client.userId, client.clientId);
    const authority = createSerializedPrototypeOAuthHandler(environment.database);
    const verifier = randomBytes(32).toString('base64url');
    const response = await authority.handler(
      new Request(`${PROTOTYPE_ISSUER}/oauth2/authorize?client_id=ignored-query-client&prompt=none`, {
        method: 'POST',
        headers: {
          cookie: client.cookie,
          origin: 'https://www.boardsesh.test',
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body: new URLSearchParams({
          response_type: 'code',
          client_id: client.clientId,
          redirect_uri: client.redirectUri,
          scope: 'profile:read offline_access',
          resource: PROTOTYPE_RESOURCE,
          state: randomUUID(),
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
        }),
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain(PROTOTYPE_OAUTH_OPTIONS.consentPage);
    expect(new URL(response.headers.get('location')!).searchParams.has('code')).toBe(false);
    const accepted = await postJson(authority, '/oauth2/consent', client.cookie, {
      accept: true,
      oauth_query: new URL(response.headers.get('location')!).searchParams.toString(),
    });
    expect(accepted.response.status).toBe(200);
    expect((await exchange(client, { location: accepted.body.url!, verifier }, authority)).response.status).toBe(200);
  });

  it('password reset rejects an already issued code through its revoked canonical session', async () => {
    const client = await createClient();
    const authority = createSerializedPrototypeOAuthHandler(environment.database);
    const pending = await authorize(client, {}, authority);
    expect(new URL(pending.location!).searchParams.get('code')).toBeTruthy();
    const resetToken = randomUUID();
    await environment.database.insert(environment.schema.verification).values({
      id: randomUUID(),
      identifier: `reset-password:${resetToken}`,
      value: client.userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const reset = await postJson(
      { handler: createPrototypeLegacyHandler(environment.database) },
      '/reset-password',
      '',
      { token: resetToken, newPassword: 'password-reset-before-code-redemption' },
    );
    expect(reset.response.status).toBe(200);
    const redeemed = await exchange(client, pending, authority);
    expect(redeemed.response.status).toBe(400);
    expect(redeemed.body.error).toBe('invalid_request');
    expect(
      await environment.database
        .select()
        .from(environment.schema.oauthAccessToken)
        .where(eq(environment.schema.oauthAccessToken.userId, client.userId)),
    ).toHaveLength(0);
    expect(
      await environment.database
        .select()
        .from(environment.schema.oauthRefreshToken)
        .where(eq(environment.schema.oauthRefreshToken.userId, client.userId)),
    ).toHaveLength(0);
  });

  it('password reset revokes detached offline credentials and ancestry without ending another connection', async () => {
    const client = await createClient();
    const unrelated = await createClient();
    const authority = createSerializedPrototypeOAuthHandler(environment.database);
    const issued = await issueTokens(client, undefined, authority);
    const unrelatedTokens = await issueTokens(unrelated, undefined, authority);
    const [detached] = await environment.database
      .select()
      .from(environment.schema.oauthAccessToken)
      .where(eq(environment.schema.oauthAccessToken.clientId, client.clientId));
    expect(detached.sessionId).toBeNull();
    const resetToken = randomUUID();
    await environment.database.insert(environment.schema.verification).values({
      id: randomUUID(),
      identifier: `reset-password:${resetToken}`,
      value: client.userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const reset = await postJson(
      { handler: createPrototypeLegacyHandler(environment.database) },
      '/reset-password',
      '',
      {
        token: resetToken,
        newPassword: 'password-reset-must-end-detached-offline-grant',
      },
    );
    expect(reset.response.status).toBe(200);
    expect((await introspect(client, issued.access_token!, authority)).body.active).toBe(false);
    expect((await refresh(client, issued.refresh_token!, authority)).body.error).toBe('invalid_grant');
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeOAuthRefreshAncestor)
        .where(eq(environment.schema.prototypeOAuthRefreshAncestor.userId, client.userId)),
    ).toHaveLength(0);
    expect((await introspect(unrelated, unrelatedTokens.access_token!, authority)).body.active).toBe(true);
  });

  it('canonical account deletion removes detached offline credentials and ancestry for only that user', async () => {
    const developerApplication = await createClient();
    const climber = await createClient();
    // The app belongs to someone else and must survive this climber's deletion.
    const client = { ...developerApplication, cookie: climber.cookie, userId: climber.userId };
    const authority = createSerializedPrototypeOAuthHandler(environment.database);
    const issued = await issueTokens(client, undefined, authority);
    const developerTokens = await issueTokens(developerApplication, undefined, authority);
    const [detached] = await environment.database
      .select()
      .from(environment.schema.oauthAccessToken)
      .where(
        and(
          eq(environment.schema.oauthAccessToken.clientId, client.clientId),
          eq(environment.schema.oauthAccessToken.userId, client.userId),
        ),
      );
    expect(detached.sessionId).toBeNull();
    const deleted = await environment.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(6975, 1)`);
      // Enable deletion only for this disposable experiment. The lifecycle hook
      // is the same canonical revocation helper used by the legacy adapter.
      const deletionAuthority = createPrototypeAuthority(transaction, {
        user: { deleteUser: { enabled: true } },
        databaseHooks: {
          user: {
            delete: {
              async before(user) {
                await revokePrototypeUser(transaction, user.id);
              },
            },
          },
        },
      });
      const response = await postJson(deletionAuthority, '/delete-user', client.cookie, {
        password: 'prototype-password-123',
      });
      return rejectPrototypeServerFailure(response.response);
    });
    expect(deleted.status).toBe(200);
    expect(
      await environment.database
        .select()
        .from(environment.schema.user)
        .where(eq(environment.schema.user.id, client.userId)),
    ).toHaveLength(0);
    expect(
      await environment.database
        .select()
        .from(environment.schema.oauthAccessToken)
        .where(eq(environment.schema.oauthAccessToken.userId, client.userId)),
    ).toHaveLength(0);
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeOAuthRefreshAncestor)
        .where(eq(environment.schema.prototypeOAuthRefreshAncestor.userId, client.userId)),
    ).toHaveLength(0);
    const [survivingApplication] = await environment.database
      .select()
      .from(environment.schema.oauthClient)
      .where(eq(environment.schema.oauthClient.clientId, client.clientId));
    expect(survivingApplication.userId).toBe(developerApplication.userId);
    expect((await introspect(client, issued.access_token!, authority)).body.active).toBe(false);
    expect((await refresh(client, issued.refresh_token!, authority)).body.error).toBe('invalid_grant');
    expect((await introspect(developerApplication, developerTokens.access_token!, authority)).body.active).toBe(true);
    expect((await refresh(developerApplication, developerTokens.refresh_token!, authority)).response.status).toBe(200);
  });

  it.each(['reset-first', 'redemption-first'] as const)(
    'password reset racing code redemption leaves no usable partner descendants (%s)',
    async (order) => {
      const client = await createClient();
      const firstInstance = createSerializedPrototypeOAuthHandler(environment.database);
      const secondInstance = createSerializedPrototypeOAuthHandler(environment.database);
      const pending = await authorize(client, {}, firstInstance);
      const resetToken = randomUUID();
      await environment.database.insert(environment.schema.verification).values({
        id: randomUUID(),
        identifier: `reset-password:${resetToken}`,
        value: client.userId,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const reset = () =>
        postJson({ handler: createPrototypeLegacyHandler(environment.database) }, '/reset-password', '', {
          token: resetToken,
          newPassword: 'password-reset-during-code-redemption',
        });
      const redeem = () => exchange(client, pending, secondInstance);
      const outcomes =
        order === 'reset-first' ? await Promise.all([reset(), redeem()]) : await Promise.all([redeem(), reset()]);
      const [resetResult, redemptionResult] = order === 'reset-first' ? outcomes : [outcomes[1], outcomes[0]];
      expect(resetResult.response.status).toBe(200);
      expect([200, 400]).toContain(redemptionResult.response.status);
      if (redemptionResult.body.access_token) {
        expect((await introspect(client, redemptionResult.body.access_token, firstInstance)).body.active).toBe(false);
      }
      expect(
        await environment.database
          .select()
          .from(environment.schema.oauthAccessToken)
          .where(eq(environment.schema.oauthAccessToken.userId, client.userId)),
      ).toHaveLength(0);
      expect(
        await environment.database
          .select()
          .from(environment.schema.oauthRefreshToken)
          .where(eq(environment.schema.oauthRefreshToken.userId, client.userId)),
      ).toHaveLength(0);
      expect(
        await environment.database
          .select()
          .from(environment.schema.prototypeOAuthRefreshAncestor)
          .where(eq(environment.schema.prototypeOAuthRefreshAncestor.userId, client.userId)),
      ).toHaveLength(0);
    },
  );

  it('a consent interaction cannot move to a new session for the same user', async () => {
    const client = await createClient({ skipConsent: false });
    const firstInstance = createSerializedPrototypeOAuthHandler(environment.database);
    const authorization = await authorize(client, {}, firstInstance);
    const [user] = await environment.database
      .select()
      .from(environment.schema.user)
      .where(eq(environment.schema.user.id, client.userId));
    const signedIn = await environment.auth.api.signInEmail({
      body: { email: user.email, password: 'prototype-password-123' },
      asResponse: true,
    });
    expect(signedIn.status).toBe(200);
    const replacementCookie = cookieHeader(signedIn);
    expect(replacementCookie).not.toBe(client.cookie);
    const rejected = await postJson(firstInstance, '/oauth2/consent', replacementCookie, {
      accept: true,
      oauth_query: new URL(authorization.location!).searchParams.toString(),
    });
    expect(rejected.response.status).toBe(400);
  });
});
