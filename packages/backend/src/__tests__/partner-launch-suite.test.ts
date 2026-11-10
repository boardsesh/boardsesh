import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import * as oauth from 'oauth4webapi';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  accounts,
  mobileRefreshTokens,
  oauthAccessToken,
  oauthAppPolicy,
  oauthClient,
  oauthConnections,
  oauthConsentInteractions,
  oauthGrants,
  oauthRefreshAncestors,
  oauthRefreshToken,
  oauthSession,
  oauthSubjects,
  oauthVerification,
  sessions,
  userCredentials,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { insertCurrentStorePasswordIdentity } from '../auth/current-store/password-identity';
import { db } from '../db/client';
import { redisClientManager } from '../redis/client';
import { revokePartnerUser, suspendPartnerApp, unsuspendPartnerApp } from '../scripts/partner-app-admin';
import { runPartnerOAuthSweep } from '../services/partner-oauth-sweep';
import { logger } from '../utils/logger';
import {
  CONSENT_PAGE,
  createAccount,
  firstPartyToken,
  freshClientIp,
  ISSUER,
  nowSeconds,
  LAUNCH_TERMS_VERSION,
  PARTNER_SECRET,
  REGISTER_MUTATION,
  RESOURCE,
  SIGN_IN_PAGE,
  signInOnWeb,
  startRealServer,
  useDeployment,
  WEB_ORIGIN,
  type RunningServer,
} from './helpers/partner-launch-harness';
import { getWorkerDatabaseUrl } from './worker-db';

/**
 * F17, the partner OAuth launch suite. One file, the assembled stack: the real
 * `startServer` on real Postgres and Redis, the www cookie the installed
 * NextAuth writes, and oauth4webapi as the partner app. Earlier PRs prove each
 * piece against its own fixture; this proves them together, end to end.
 *
 * Launch gates and done criteria (BA-07-08 plan section 4, the fast path's
 * section 3 and launch gates, docs/integration-platform.md "Test suite required
 * before launch") map to the describe blocks below. What no test here can prove
 * is listed at the end of that doc section.
 *
 * - Gate 1 (every revocation path ends connections): "the revocation table", "races".
 * - Gate 2 (the pinned provider, two instances, real Postgres and Redis): this
 *   file; "two instances" at the end.
 * - Gate 7, log half (no codes, tokens or secrets in logs): "the logs", last.
 * - Gate 8 (hold and off; /graphql and native login unaffected): "mode off",
 *   "mode hold", "switching modes".
 * - Gate 10 (published scopes match shipped routes): "discovery", "codes".
 * - BA-07 done: "the journey", "codes", "refresh", "resource", "widening",
 *   "token revocation", "suspend, rotate and delete", "two instances".
 * - BA-08 done: "registration", "consent", "the journey" (Disconnect, reconnect,
 *   per-app subject), "suspend, rotate and delete", "switching modes".
 *
 * Needs REDIS_URL (CI sets it), like the other partner route suites. About 30 s
 * on a laptop, budget 60 s. Time moves by rewriting rows, never by waiting; races
 * wait on what pg_stat_activity reports, never on a timer.
 */

const SUITE_DEADLINE_MS = 30_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TOKEN_PATH = '/api/auth/oauth2/token';
const REVOKE_PATH = '/api/auth/oauth2/revoke';
const AUTHORIZE_PATH = '/api/auth/oauth2/authorize';
const CONSENT_PATH = '/api/auth/oauth2/consent';
const CONSENT_DETAILS_PATH = '/api/auth/oauth2/consent-details';
const DISCOVERY_PATHS = [
  '/.well-known/oauth-authorization-server/api/auth',
  '/api/auth/.well-known/oauth-authorization-server',
];
const ME_PATH = '/v1/me';
const CONNECTION_PATH = '/v1/connection';
/** The partner surfaces a mode switch turns on and off, as method and path. */
const PARTNER_SURFACES: Array<[string, string]> = [
  ['GET', AUTHORIZE_PATH],
  ['POST', TOKEN_PATH],
  ['POST', REVOKE_PATH],
  ['POST', CONSENT_PATH],
  ['POST', CONSENT_DETAILS_PATH],
  ['GET', DISCOVERY_PATHS[0]],
  ['GET', DISCOVERY_PATHS[1]],
  ['GET', ME_PATH],
  ['DELETE', CONNECTION_PATH],
];

// ---------------------------------------------------------------------------
// What leaves the server: every log entry and console line, checked last.
// ---------------------------------------------------------------------------

const logLines: string[] = [];
const credentialsSeen = new Set<string>();
const captureLogEntry = (entry: unknown) => logLines.push(JSON.stringify(entry));

function remember(...values: Array<string | null | undefined>): void {
  for (const value of values) if (value && value.length >= 16) credentialsSeen.add(value);
}

beforeAll(async () => {
  logger.on('data', captureLogEntry);
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[method].bind(console);
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
      logLines.push(
        parts.map((part) => (part instanceof Error ? `${part.message} ${part.stack}` : String(part))).join(' '),
      );
      original(...parts);
    });
  }
  await redisClientManager.connect();
});

afterAll(async () => {
  logger.off('data', captureLogEntry);
  vi.restoreAllMocks();
  await redisClientManager.disconnect();
});

// ---------------------------------------------------------------------------
// The modes that load nothing. These run first, before anything in this
// process has built the authority, so "never loaded" means what it says.
// ---------------------------------------------------------------------------

describe('mode off, in the real server', () => {
  afterAll(() => {
    vi.doUnmock('../auth/partner/authority');
    vi.unstubAllEnvs();
  });

  it(
    'serves no partner surface, loads no Better Auth, and leaves GraphQL and native login alone',
    async () => {
      let authorityLoaded = false;
      vi.doMock('../auth/partner/authority', () => {
        authorityLoaded = true;
        return { getPartnerAuthorityRuntime: () => Promise.reject(new Error('must not load')) };
      });
      const developerId = await createAccount('developer');
      const hiddenServer = await startRealServer({
        PARTNER_OAUTH_MODE: 'off',
        PARTNER_OAUTH_SECRETS: PARTNER_SECRET,
        PARTNER_OAUTH_DEVELOPER_ALLOWLIST: developerId,
      });
      try {
        for (const [method, path] of PARTNER_SURFACES) {
          const answer = await hiddenServer.send(method, path, {
            headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyzABCDEF' },
          });
          expect({ method, path, status: answer.status }).toEqual({ method, path, status: 404 });
        }
        const developerConsole = await hiddenServer.graphql(`query { myOAuthClients { clientId } }`, undefined, {
          bearer: await firstPartyToken(developerId),
        });
        expect(developerConsole.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
        await expectFirstPartyUnaffected(hiddenServer);
        expect(authorityLoaded).toBe(false);
      } finally {
        await hiddenServer.stop();
      }
    },
    SUITE_DEADLINE_MS,
  );
});

describe('mode hold, in the real server', () => {
  afterAll(() => {
    vi.doUnmock('../auth/partner/authority');
    vi.unstubAllEnvs();
  });

  it(
    'answers every partner surface 503 with Retry-After, loads no Better Auth, and leaves GraphQL and native login alone',
    async () => {
      let authorityLoaded = false;
      vi.doMock('../auth/partner/authority', () => {
        authorityLoaded = true;
        return { getPartnerAuthorityRuntime: () => Promise.reject(new Error('must not load')) };
      });
      const developerId = await createAccount('developer');
      const heldServer = await startRealServer({
        PARTNER_OAUTH_MODE: 'hold',
        PARTNER_OAUTH_SECRETS: PARTNER_SECRET,
        PARTNER_OAUTH_DEVELOPER_ALLOWLIST: developerId,
      });
      try {
        for (const [method, path] of PARTNER_SURFACES) {
          const answer = await heldServer.send(method, path, {
            headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyzABCDEF' },
          });
          expect({ method, path, status: answer.status, retryAfter: answer.headers['retry-after'] }).toEqual({
            method,
            path,
            status: 503,
            retryAfter: '60',
          });
        }
        const developerConsole = await heldServer.graphql(`query { myOAuthClients { clientId } }`, undefined, {
          bearer: await firstPartyToken(developerId),
        });
        expect(developerConsole.errors?.[0]?.extensions?.code).toBe('SERVICE_UNAVAILABLE');
        await expectFirstPartyUnaffected(heldServer);
        expect(authorityLoaded).toBe(false);
      } finally {
        await heldServer.stop();
      }
    },
    SUITE_DEADLINE_MS,
  );
});

/** GraphQL answers a signed-in climber, and a password climber can sign in natively. */
async function expectFirstPartyUnaffected(target: RunningServer): Promise<void> {
  const climberId = await createAccount('native');
  const email = `${climberId}@example.invalid`;
  await db.insert(userCredentials).values({ userId: climberId, passwordHash: await bcrypt.hash('native-password', 4) });
  const profile = await target.graphql(`query { profile { id } }`, undefined, {
    bearer: await firstPartyToken(climberId),
  });
  expect(profile.status).toBe(200);
  expect(profile.data).toEqual({ profile: { id: climberId } });
  const nativeLogin = await target.send('POST', '/auth/native/credentials', {
    host: 'ws.boardsesh.com',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'native-password' }),
  });
  expect(nativeLogin.status).toBe(200);
  expect(JSON.parse(nativeLogin.body)).toMatchObject({ jwt: expect.any(String), refreshToken: expect.any(String) });
}

// ---------------------------------------------------------------------------
// Partner OAuth on: one server for the journey, as production runs it.
// ---------------------------------------------------------------------------

type AppKind = 'confidential-basic' | 'confidential-post' | 'public-native' | 'public-web';

interface PartnerApp {
  kind: AppKind;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  /** An https origin the app registered, for browser CORS. */
  origin: string | null;
  client: oauth.Client;
  auth: oauth.ClientAuth;
  developerId: string;
  /** The app's own egress address. */
  ip: string;
}

interface Climber {
  userId: string;
  cookie: string;
  /** The climber's browser address. */
  ip: string;
}

interface Authorization {
  url: URL;
  verifier: string;
  state: string;
  redirectUri: string;
}

interface Connection {
  app: PartnerApp;
  climber: Climber;
  tokens: oauth.TokenEndpointResponse & { refresh_token: string };
}

let server: RunningServer;
let metadata: oauth.AuthorizationServer;
let closeMainRuntime: (() => Promise<void>) | undefined;
/** For barriers and writers outside the server: a session of our own. */
let rawSql: ReturnType<typeof postgres>;
const developerPool: string[] = Array.from({ length: 64 }, () => `developer-${randomUUID()}`);
const MAIN_DEPLOYMENT = {
  PARTNER_OAUTH_MODE: 'allowlist',
  PARTNER_OAUTH_SECRETS: PARTNER_SECRET,
  PARTNER_OAUTH_DEVELOPER_ALLOWLIST: developerPool.join(','),
  PARTNER_DEVELOPER_TERMS_VERSION: LAUNCH_TERMS_VERSION,
};
let appCounter = 0;

function oauthOptions(ip: string) {
  return { [oauth.customFetch]: server.fetchFor(ip) };
}

async function registerApp(kind: AppKind = 'confidential-basic', target: RunningServer = server): Promise<PartnerApp> {
  const developerId = developerPool.pop();
  if (!developerId) throw new Error('The developer pool ran out; raise its size.');
  await db
    .insert(users)
    .values({ id: developerId, email: `${developerId}@example.invalid`, name: 'Developer', emailVerified: new Date() });
  appCounter += 1;
  const host = `app-${appCounter}.example.test`;
  const native = kind === 'public-native';
  const authMethod = {
    'confidential-basic': 'CLIENT_SECRET_BASIC',
    'confidential-post': 'CLIENT_SECRET_POST',
    'public-native': 'NONE',
    'public-web': 'NONE',
  }[kind];
  const redirectUris = native
    ? [`com.example.app${appCounter}:/oauth/boardsesh`, 'http://127.0.0.1/callback']
    : [`https://${host}/oauth/boardsesh`];
  const reply = await target.graphql(
    REGISTER_MUTATION,
    {
      input: {
        name: `Crimp Planner ${appCounter}`,
        publisherName: 'Crimp Labs',
        homepageUrl: `https://${host}/`,
        privacyPolicyUrl: `https://${host}/privacy`,
        applicationType: native ? 'NATIVE' : 'WEB',
        tokenEndpointAuthMethod: authMethod,
        redirectUris,
        acceptedTermsVersion: LAUNCH_TERMS_VERSION,
      },
    },
    { bearer: await firstPartyToken(developerId) },
  );
  expect(reply.errors).toBeUndefined();
  const created = reply.data?.createOAuthClient as {
    clientSecret: string | null;
    client: { clientId: string; redirectUris: string[] };
  };
  remember(created.clientSecret);
  if (created.clientSecret) {
    // What a Basic header carries (RFC 6749 2.3.1), whole and encoded, so a logged header is caught too.
    const pair = `${encodeURIComponent(created.client.clientId)}:${encodeURIComponent(created.clientSecret)}`;
    remember(pair, Buffer.from(pair).toString('base64'));
  }
  const auth =
    kind === 'confidential-basic'
      ? oauth.ClientSecretBasic(created.clientSecret ?? '')
      : kind === 'confidential-post'
        ? oauth.ClientSecretPost(created.clientSecret ?? '')
        : oauth.None();
  return {
    kind,
    clientId: created.client.clientId,
    clientSecret: created.clientSecret,
    redirectUri: created.client.redirectUris[0],
    origin: native ? null : `https://${host}`,
    client: { client_id: created.client.clientId },
    auth,
    developerId,
    ip: freshClientIp(),
  };
}

async function newClimber(label = 'climber', webMode = 'allowlist'): Promise<Climber> {
  const userId = await createAccount(label);
  const cookie = await signInOnWeb(userId, { webMode });
  remember(cookie.split('=')[1]);
  return { userId, cookie, ip: freshClientIp() };
}

async function startAuthorization(
  app: PartnerApp,
  {
    scopes = ['profile:read', 'offline_access'],
    redirectUri = app.redirectUri,
    resource = RESOURCE,
    extra = {},
  }: { scopes?: string[]; redirectUri?: string; resource?: string | null; extra?: Record<string, string> } = {},
): Promise<Authorization> {
  const verifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const url = new URL(metadata.authorization_endpoint ?? '');
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: app.clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    state,
    code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    ...(resource === null ? {} : { resource }),
    ...extra,
  }).toString();
  return { url, verifier, state, redirectUri };
}

/** The climber's browser opening an authorize link, with or without the www session. */
async function openAuthorize(url: URL, climber: Pick<Climber, 'ip'> & { cookie: string | null }, target = server) {
  const reply = await target.send('GET', `${url.pathname}${url.search}`, {
    clientIp: climber.ip,
    headers: climber.cookie ? { Cookie: climber.cookie } : {},
  });
  const location = reply.headers.location ?? '';
  // The consent link's signature is a bearer of the open screen: it must not be logged either.
  if (location.startsWith(`${CONSENT_PAGE}?`)) remember(new URL(location).searchParams.get('sig'));
  return { reply, location };
}

/** What the www consent page posts, with the climber's cookie, from www. */
async function postConsentRoute(
  path: string,
  consentLink: string,
  climber: Pick<Climber, 'ip' | 'cookie'>,
  body: Record<string, unknown> = {},
  { origin = WEB_ORIGIN, target = server }: { origin?: string | null; target?: RunningServer } = {},
) {
  const reply = await target.send('POST', path, {
    clientIp: climber.ip,
    headers: { 'Content-Type': 'application/json', Cookie: climber.cookie, ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ oauth_query: new URL(consentLink).search.slice(1), ...body }),
  });
  return { reply, body: (reply.body ? JSON.parse(reply.body) : {}) as Record<string, unknown> };
}

const approve = (consentLink: string, climber: Climber, accept = true, target = server) =>
  postConsentRoute(CONSENT_PATH, consentLink, climber, { accept }, { target });

/** The app's callback handling and code exchange, all by oauth4webapi. */
async function redeem(app: PartnerApp, authorization: Authorization, callbackUrl: string, target = server) {
  const parameters = oauth.validateAuthResponse(metadata, app.client, new URL(callbackUrl), authorization.state);
  const code = parameters.get('code');
  remember(code);
  const response = await oauth.authorizationCodeGrantRequest(
    metadata,
    app.client,
    app.auth,
    parameters,
    authorization.redirectUri,
    authorization.verifier,
    { additionalParameters: { resource: RESOURCE }, [oauth.customFetch]: target.fetchFor(app.ip) },
  );
  const tokens = await oauth.processAuthorizationCodeResponse(metadata, app.client, response);
  remember(tokens.access_token, tokens.refresh_token);
  return tokens;
}

/** The browser's way to the app's callback: through the consent screen, unless consent is remembered. */
async function callbackFor(authorization: Authorization, climber: Climber, target = server): Promise<string> {
  const { location } = await openAuthorize(authorization.url, climber, target);
  if (!location.startsWith(`${CONSENT_PAGE}?`)) return location;
  const approved = await approve(location, climber, true, target);
  expect(approved.reply.status).toBe(200);
  return approved.body.url as string;
}

/** Authorize, consent and exchange: the whole connection, for a signed-in climber. */
async function connect(
  app: PartnerApp,
  climber: Climber,
  options: Parameters<typeof startAuthorization>[1] = {},
): Promise<Connection> {
  const authorization = await startAuthorization(app, options);
  const tokens = await redeem(app, authorization, await callbackFor(authorization, climber));
  if (!tokens.refresh_token) throw new Error('No refresh token was issued.');
  return { app, climber, tokens: { ...tokens, refresh_token: tokens.refresh_token } };
}

/**
 * An authorize error the provider may send to the app: a 302 to the registered
 * redirect URI carrying the error, the app's state and the issuer, and no code.
 * oauth4webapi must read it as that error.
 */
function expectErrorAtApp(
  opened: { reply: { status: number }; location: string },
  app: PartnerApp,
  authorization: Authorization,
  error: string,
): void {
  expect(opened.reply.status).toBe(302);
  const target = new URL(opened.location);
  expect(`${target.origin}${target.pathname}`).toBe(app.redirectUri);
  expect({
    error: target.searchParams.get('error'),
    state: target.searchParams.get('state'),
    iss: target.searchParams.get('iss'),
    code: target.searchParams.get('code'),
  }).toEqual({ error, state: authorization.state, iss: ISSUER.href, code: null });
  let thrown: unknown;
  try {
    oauth.validateAuthResponse(metadata, app.client, target, authorization.state);
  } catch (caught) {
    thrown = caught;
  }
  expect(thrown).toBeInstanceOf(oauth.AuthorizationResponseError);
  expect((thrown as oauth.AuthorizationResponseError).error).toBe(error);
}

/** `/v1/me` as a real client calls it. A 401 comes back as its challenge. */
async function callMe(app: PartnerApp, accessToken: string, target = server) {
  try {
    const response = await oauth.protectedResourceRequest(
      accessToken,
      'GET',
      new URL(`${RESOURCE}/me`),
      undefined,
      undefined,
      { [oauth.customFetch]: target.fetchFor(app.ip) },
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } catch (error) {
    if (error instanceof oauth.WWWAuthenticateChallengeError) {
      return { status: error.status, body: { challenge: error.cause[0]?.parameters.error ?? null } };
    }
    throw error;
  }
}

async function refresh(app: PartnerApp, refreshToken: string, target = server, extra: Record<string, string> = {}) {
  const response = await oauth.refreshTokenGrantRequest(metadata, app.client, app.auth, refreshToken, {
    additionalParameters: { resource: RESOURCE, ...extra },
    [oauth.customFetch]: target.fetchFor(app.ip),
  });
  const raw = response.clone();
  try {
    const tokens = await oauth.processRefreshTokenResponse(metadata, app.client, response);
    remember(tokens.access_token, tokens.refresh_token);
    return { ok: true as const, tokens: tokens as oauth.TokenEndpointResponse & { refresh_token: string } };
  } catch (error) {
    if (error instanceof oauth.ResponseBodyError)
      return { ok: false as const, error: error.error, status: error.status };
    // A 401 with a Basic challenge (invalid_client), or something that is no OAuth
    // error body at all: keep what came back, so a failure says what it was.
    const body = await raw.text();
    let code = `http_${raw.status}`;
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string') {
        code = (parsed as { error: string }).error;
      }
    } catch {
      // Not JSON: the status is all there is.
    }
    return { ok: false as const, error: code, status: raw.status, body };
  }
}

async function disconnectByApp(app: PartnerApp, accessToken: string, target = server) {
  return target.send('DELETE', CONNECTION_PATH, {
    clientIp: app.ip,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

async function connectionRow(connection: Pick<Connection, 'app' | 'climber'>) {
  const [row] = await db
    .select()
    .from(oauthConnections)
    .where(
      and(
        eq(oauthConnections.userId, connection.climber.userId),
        eq(oauthConnections.clientId, connection.app.clientId),
      ),
    );
  return row;
}

/**
 * Moves one refresh token through time. Its expiry is copied, immutably, to its
 * ancestry row at issuance, so both rows move together or the family guard
 * rightly calls the lineage forged.
 */
async function moveRefreshToken(row: typeof oauthRefreshToken.$inferSelect, at: { createdAt?: Date; expiresAt: Date }) {
  await db.transaction(async (transaction) => {
    await transaction
      .update(oauthRefreshToken)
      .set({ expiresAt: at.expiresAt, ...(at.createdAt ? { createdAt: at.createdAt } : {}) })
      .where(eq(oauthRefreshToken.id, row.id));
    await transaction
      .update(oauthRefreshAncestors)
      .set({ expiresAt: at.expiresAt })
      .where(eq(oauthRefreshAncestors.tokenHash, row.token));
  });
}

/** Nothing issued before can reach the API or renew access, and the connection says why. */
async function expectEnded(connection: Connection, { rowGone = false } = {}): Promise<void> {
  expect(await callMe(connection.app, connection.tokens.access_token)).toEqual({
    status: 401,
    body: { challenge: 'invalid_token' },
  });
  expect(await refresh(connection.app, connection.tokens.refresh_token)).toMatchObject({
    ok: false,
    error: 'invalid_grant',
  });
  const row = await connectionRow(connection);
  if (rowGone) {
    expect(row).toBeUndefined();
    return;
  }
  expect(row.revokedAt).not.toBeNull();
  expect(row.generation).toBeGreaterThan(0);
}

/** The connection still works: the API answers, and a refresh rotates. Returns the newest tokens. */
async function expectAlive(connection: Connection): Promise<Connection> {
  expect((await callMe(connection.app, connection.tokens.access_token)).status).toBe(200);
  const refreshed = await refresh(connection.app, connection.tokens.refresh_token);
  expect(refreshed.ok).toBe(true);
  if (!refreshed.ok) throw new Error('unreachable');
  const row = await connectionRow(connection);
  expect(row.revokedAt).toBeNull();
  return { ...connection, tokens: refreshed.tokens };
}

describe('partner OAuth on, in the real server', () => {
  beforeAll(async () => {
    rawSql = postgres(getWorkerDatabaseUrl(), { max: 4, onnotice: () => {} });
    server = await startRealServer(MAIN_DEPLOYMENT);
    // Taken now, from this module graph: "two instances" later loads a second one.
    const { getPartnerAuthorityRuntime } = await import('../auth/partner/authority');
    closeMainRuntime = async () => (await getPartnerAuthorityRuntime()).close();
    // An unmodified OAuth client configures itself from the RFC 8414 document.
    const ip = freshClientIp();
    metadata = await oauth.processDiscoveryResponse(
      ISSUER,
      await oauth.discoveryRequest(ISSUER, { algorithm: 'oauth2', ...oauthOptions(ip) }),
    );
  }, SUITE_DEADLINE_MS);

  afterAll(async () => {
    await server?.stop();
    await server?.shutdownProcessServices();
    await closeMainRuntime?.();
    await rawSql?.end({ timeout: 5 });
  });

  describe('discovery', () => {
    it('publishes the same document at both paths, for this issuer, with only what is served', async () => {
      const bodies = await Promise.all(DISCOVERY_PATHS.map((path) => server.send('GET', path)));
      for (const answer of bodies) expect(answer.status).toBe(200);
      expect(JSON.parse(bodies[0].body)).toEqual(JSON.parse(bodies[1].body));
      expect(metadata).toMatchObject({
        issuer: ISSUER.href,
        authorization_endpoint: `${ISSUER.href}/oauth2/authorize`,
        token_endpoint: `${ISSUER.href}/oauth2/token`,
        revocation_endpoint: `${ISSUER.href}/oauth2/revoke`,
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
      });
      // Gate 10: only shipped scopes. logbook:read joined with its route (L4).
      expect(metadata.scopes_supported).toEqual(['logbook:read', 'profile:read', 'offline_access']);
      expect(metadata).not.toHaveProperty('introspection_endpoint');
      expect(metadata).not.toHaveProperty('userinfo_endpoint');
      expect(metadata).not.toHaveProperty('registration_endpoint');
      // No OIDC discovery (decision 5).
      expect((await server.send('GET', '/api/auth/.well-known/openid-configuration')).status).toBe(404);
    });
  });

  describe('registration', () => {
    it('lets an allowlisted developer register confidential and public apps, and no one else', async () => {
      const confidential = await registerApp('confidential-basic');
      expect(confidential.clientSecret).toMatch(/^[A-Za-z]{32}$/);
      const publicNative = await registerApp('public-native');
      expect(publicNative.clientSecret).toBeNull();
      const [row] = await db.select().from(oauthClient).where(eq(oauthClient.clientId, confidential.clientId));
      // F12 fixes these for every app: consent always shown, PKCE always required.
      expect(row).toMatchObject({ skipConsent: false, requirePKCE: true, disabled: false });
      const [policy] = await db.select().from(oauthAppPolicy).where(eq(oauthAppPolicy.clientId, confidential.clientId));
      expect(policy).toMatchObject({ maxActiveConnections: 25, maxNewConnectionsPerDay: 20 });

      const outsider = await createAccount('outsider');
      const refused = await server.graphql(
        REGISTER_MUTATION,
        {
          input: {
            name: 'Outside Planner',
            publisherName: 'Crimp Labs',
            privacyPolicyUrl: 'https://outside.example.test/privacy',
            applicationType: 'WEB',
            tokenEndpointAuthMethod: 'NONE',
            redirectUris: ['https://outside.example.test/cb'],
            acceptedTermsVersion: LAUNCH_TERMS_VERSION,
          },
        },
        { bearer: await firstPartyToken(outsider) },
      );
      expect(refused.errors?.[0]?.extensions).toMatchObject({ code: 'FORBIDDEN', reason: 'NOT_ALLOWLISTED' });
    });
  });

  describe('the journey', () => {
    it(
      'signed out, signs in, sees the consent screen, approves, exchanges with PKCE, reads /v1/me, refreshes, disconnects, reconnects',
      async () => {
        const app = await registerApp('confidential-basic');
        const climberId = await createAccount('journey');
        const browser = { ip: freshClientIp() };

        // Signed out: the provider sends the browser to the www sign-in page, and sets no cookie.
        const authorization = await startAuthorization(app);
        const signedOut = await openAuthorize(authorization.url, { ...browser, cookie: null });
        expect(signedOut.reply.status).toBe(302);
        expect(signedOut.location.startsWith(`${SIGN_IN_PAGE}?`)).toBe(true);
        expect(signedOut.reply.headers['set-cookie']).toBeUndefined();

        // The climber signs in on www; the sign-in page re-enters authorize with the query it was given.
        const climber: Climber = {
          userId: climberId,
          ip: browser.ip,
          cookie: await signInOnWeb(climberId, { webMode: 'allowlist' }),
        };
        remember(climber.cookie.split('=')[1]);
        const reentry = new URL(authorization.url);
        reentry.search = new URL(signedOut.location).search;
        const consentScreen = await openAuthorize(reentry, climber);
        expect(consentScreen.location.startsWith(`${CONSENT_PAGE}?`)).toBe(true);
        expect(consentScreen.reply.headers['set-cookie']).toBeUndefined();

        // What the www page shows, read without spending the link.
        const details = await postConsentRoute(CONSENT_DETAILS_PATH, consentScreen.location, climber);
        expect(details.reply.status).toBe(200);
        expect(details.body).toMatchObject({
          client: {
            clientId: app.clientId,
            name: expect.stringContaining('Crimp Planner'),
            redirectHost: new URL(app.redirectUri).host,
          },
          scopes: [
            { scope: 'profile:read', includesOnlyMeTicks: false },
            { scope: 'offline_access', includesOnlyMeTicks: false },
          ],
          reconnect: false,
          reviewed: false,
        });

        // Approve: the app gets a code, its state and the issuer (RFC 9207), checked by oauth4webapi.
        const approved = await approve(consentScreen.location, climber);
        expect(approved.reply.status).toBe(200);
        const callback = new URL(approved.body.url as string);
        expect(`${callback.origin}${callback.pathname}`).toBe(app.redirectUri);
        expect(callback.searchParams.get('iss')).toBe(ISSUER.href);

        // The code row lives 60 seconds, whatever the 600-second consent link said.
        const connection = await connectionRow({ app, climber });
        const [grant] = await db.select().from(oauthGrants).where(eq(oauthGrants.connectionId, connection.id));
        const [codeRow] = await db
          .select()
          .from(oauthVerification)
          .where(eq(oauthVerification.identifier, grant.authorizationCodeId));
        // Both times were written by the one request, so this holds however slow the machine is.
        const codeLifetimeMs = codeRow.expiresAt.getTime() - (codeRow.createdAt?.getTime() ?? 0);
        expect(codeLifetimeMs).toBeGreaterThan(59_000);
        expect(codeLifetimeMs).toBeLessThanOrEqual(61_000);
        // Approved but not redeemed: the connection is not live yet, so it fills no cap.
        expect(connection.connectedAt).toBeNull();

        const tokens = await redeem(app, authorization, callback.href);
        expect(tokens).toMatchObject({ token_type: 'bearer', expires_in: 3600, scope: 'profile:read offline_access' });
        expect(tokens.refresh_token).toEqual(expect.any(String));
        expect((await connectionRow({ app, climber })).connectedAt).not.toBeNull();
        // 90-day rotating refresh token.
        const [refreshRow] = await db
          .select()
          .from(oauthRefreshToken)
          .where(and(eq(oauthRefreshToken.userId, climberId), eq(oauthRefreshToken.clientId, app.clientId)));
        expect(Math.round((refreshRow.expiresAt.getTime() - Date.now()) / DAY_MS)).toBe(90);

        // /v1/me: an app-specific subject, and the profile the scope allows.
        const me = await callMe(app, tokens.access_token);
        expect(me.status).toBe(200);
        expect(me.body).toEqual({
          id: expect.stringMatching(/^usr_[0-9A-Za-z]{22}$/),
          displayName: 'journey',
          avatarUrl: null,
        });
        const subject = me.body.id;

        // Refresh rotates: a new pair, and the old refresh token is spent.
        const rotated = await refresh(app, tokens.refresh_token ?? '');
        expect(rotated.ok).toBe(true);
        if (!rotated.ok) throw new Error('unreachable');
        expect(rotated.tokens.refresh_token).not.toBe(tokens.refresh_token);
        expect((await callMe(app, rotated.tokens.access_token)).status).toBe(200);

        // Disconnect from the app: 204, and every family of the connection ends.
        expect((await disconnectByApp(app, rotated.tokens.access_token)).status).toBe(204);
        const ended: Connection = { app, climber, tokens: rotated.tokens };
        await expectEnded(ended);
        expect((await connectionRow({ app, climber })).revocationReason).toBe('app_disconnect');

        // Reconnecting asks for consent again, keeps the subject, and never revives old credentials.
        const again = await startAuthorization(app);
        const reconsent = await openAuthorize(again.url, climber);
        expect(reconsent.location.startsWith(`${CONSENT_PAGE}?`)).toBe(true);
        const reconnectDetails = await postConsentRoute(CONSENT_DETAILS_PATH, reconsent.location, climber);
        expect(reconnectDetails.body.reconnect).toBe(true);
        const reapproved = await approve(reconsent.location, climber);
        const fresh = await redeem(app, again, reapproved.body.url as string);
        expect((await callMe(app, fresh.access_token)).body.id).toBe(subject);
        expect(await callMe(app, rotated.tokens.access_token)).toEqual({
          status: 401,
          body: { challenge: 'invalid_token' },
        });
        expect(await refresh(app, rotated.tokens.refresh_token)).toMatchObject({ ok: false, error: 'invalid_grant' });
        expect(await refresh(app, tokens.refresh_token ?? '')).toMatchObject({ ok: false, error: 'invalid_grant' });
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'works for a public native app through a private-use scheme and a loopback port it picks at runtime',
      async () => {
        const app = await registerApp('public-native');
        const viaScheme = await connect(app, await newClimber());
        expect((await callMe(app, viaScheme.tokens.access_token)).status).toBe(200);
        expect((await refresh(app, viaScheme.tokens.refresh_token)).ok).toBe(true);

        // Registered as http://127.0.0.1/callback; RFC 8252 lets the port differ.
        const viaLoopback = await connect(app, await newClimber(), { redirectUri: 'http://127.0.0.1:53682/callback' });
        expect((await callMe(app, viaLoopback.tokens.access_token)).status).toBe(200);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      "gives each app its own subject, and Disconnect ends that app's connection only",
      async () => {
        const app = await registerApp();
        const otherApp = await registerApp();
        const climber = await newClimber();
        const here = await connect(app, climber);
        const there = await connect(otherApp, climber);
        const hereId = (await callMe(app, here.tokens.access_token)).body.id;
        const thereId = (await callMe(otherApp, there.tokens.access_token)).body.id;
        expect(hereId).not.toBe(thereId);
        expect(hereId).not.toBe(climber.userId);
        expect((await disconnectByApp(app, here.tokens.access_token)).status).toBe(204);
        await expectEnded(here);
        await expectAlive(there);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'issues no refresh token without offline_access',
      async () => {
        const app = await registerApp();
        const authorization = await startAuthorization(app, { scopes: ['profile:read'] });
        const tokens = await redeem(app, authorization, await callbackFor(authorization, await newClimber()));
        expect(tokens.refresh_token).toBeUndefined();
        expect((await callMe(app, tokens.access_token)).status).toBe(200);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'works for a confidential app that posts its secret in the form',
      async () => {
        const app = await registerApp('confidential-post');
        const connection = await connect(app, await newClimber());
        await expectAlive(connection);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'returns access_denied with the state when the climber declines, and connects nothing',
      async () => {
        const app = await registerApp();
        const climber = await newClimber();
        const authorization = await startAuthorization(app);
        const { location } = await openAuthorize(authorization.url, climber);
        const declined = await approve(location, climber, false);
        const callback = new URL(declined.body.url as string);
        expect(callback.searchParams.get('error')).toBe('access_denied');
        expect(callback.searchParams.get('state')).toBe(authorization.state);
        expect(() => oauth.validateAuthResponse(metadata, app.client, callback, authorization.state)).toThrow(
          oauth.AuthorizationResponseError,
        );
        const row = await connectionRow({ app, climber });
        expect(row?.connectedAt ?? null).toBeNull();
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'keeps partner tokens out of first-party surfaces',
      async () => {
        const app = await registerApp();
        const connection = await connect(app, await newClimber());
        for (const bearer of [connection.tokens.access_token, connection.tokens.refresh_token]) {
          const profile = await server.graphql(`query { profile { id } }`, undefined, { bearer });
          expect(profile.data).toEqual({ profile: null });
          const deletion = await server.graphql(
            `mutation { deleteAccount(input: { removeSetterName: false }) }`,
            undefined,
            {
              bearer,
            },
          );
          expect(deletion.errors?.[0]?.message).toMatch(/Authentication required/);
          const nativeRefresh = await server.send('POST', '/auth/native/refresh', {
            host: 'ws.boardsesh.com',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: bearer }),
          });
          expect(nativeRefresh.status).toBe(401);
          // The watch's pairing and session control take only a first-party token.
          for (const [method, path] of [
            ['POST', '/api/watch/pair-code'],
            ['GET', '/api/session/state'],
          ]) {
            const watch = await server.send(method, path, {
              host: 'ws.boardsesh.com',
              headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
              body: method === 'POST' ? '{}' : undefined,
            });
            expect({ path, status: watch.status }).toEqual({ path, status: 401 });
          }
          // Nor can a partner token register an app.
          const registration = await server.graphql(
            REGISTER_MUTATION,
            {
              input: {
                name: 'Token Planner',
                publisherName: 'Crimp Labs',
                privacyPolicyUrl: 'https://token.example.test/privacy',
                applicationType: 'WEB',
                tokenEndpointAuthMethod: 'NONE',
                redirectUris: ['https://token.example.test/cb'],
                acceptedTermsVersion: LAUNCH_TERMS_VERSION,
              },
            },
            { bearer },
          );
          expect(registration.errors?.[0]?.message).toMatch(/Authentication required/);
        }
        await expectAlive(connection);
        // A first-party token is nobody at /v1.
        expect(await callMe(app, await firstPartyToken(connection.climber.userId))).toEqual({
          status: 401,
          body: { challenge: 'invalid_token' },
        });
      },
      SUITE_DEADLINE_MS,
    );
  });

  describe('codes', () => {
    it(
      'refuses a wrong PKCE verifier, and a replayed code ends the tokens it issued',
      async () => {
        const app = await registerApp();
        const climber = await newClimber();

        const wrongVerifier = await startAuthorization(app);
        await expect(
          redeem(
            app,
            { ...wrongVerifier, verifier: oauth.generateRandomCodeVerifier() },
            await callbackFor(wrongVerifier, climber),
          ),
        ).rejects.toMatchObject({ error: 'invalid_grant' });

        // Consent is remembered now, so this goes straight back to the app.
        const authorization = await startAuthorization(app);
        const callback = await callbackFor(authorization, climber);
        const tokens = await redeem(app, authorization, callback);
        expect((await callMe(app, tokens.access_token)).status).toBe(200);
        await expect(redeem(app, authorization, callback)).rejects.toMatchObject({
          error: 'invalid_grant',
        });
        expect(await callMe(app, tokens.access_token)).toEqual({ status: 401, body: { challenge: 'invalid_token' } });
        expect(await refresh(app, tokens.refresh_token ?? '')).toMatchObject({ ok: false, error: 'invalid_grant' });
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'refuses a code past its 60 seconds',
      async () => {
        const app = await registerApp();
        const climber = await newClimber();
        const authorization = await startAuthorization(app);
        const { location } = await openAuthorize(authorization.url, climber);
        const approved = await approve(location, climber);
        // The clock moves for the code row only: its expiry is now behind us.
        const connection = await connectionRow({ app, climber });
        const [grant] = await db.select().from(oauthGrants).where(eq(oauthGrants.connectionId, connection.id));
        await db
          .update(oauthVerification)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(oauthVerification.identifier, grant.authorizationCodeId));
        await expect(redeem(app, authorization, approved.body.url as string)).rejects.toMatchObject({
          error: 'invalid_grant',
        });
      },
      SUITE_DEADLINE_MS,
    );

    it.each([
      ['an unregistered redirect URI', { redirect_uri: 'https://elsewhere.example.test/cb' }],
      ['an unknown client', { client_id: 'not-a-registered-client' }],
    ])('shows an error page and never redirects for %s', async (label, overrides) => {
      const app = await registerApp('public-web');
      const climber = await newClimber();
      const authorization = await startAuthorization(app);
      for (const [name, value] of Object.entries(overrides)) authorization.url.searchParams.set(name, value);
      const { reply, location } = await openAuthorize(authorization.url, climber);
      // Nowhere but the API host's own error page: no redirect URI can be trusted here.
      expect(reply.status).toBe(302);
      const target = new URL(location);
      expect(`${target.origin}${target.pathname}`).toBe(`${ISSUER.href}/error`);
      expect(target.searchParams.get('error')).toBe(
        label === 'an unknown client' ? 'invalid_client' : 'invalid_redirect',
      );
      expect(target.searchParams.has('code')).toBe(false);
      expect(target.searchParams.has('state')).toBe(false);
      // The page itself: an error, never framed, never cached, never indexed.
      const page = await server.send('GET', `${target.pathname}${target.search}`);
      expect(page.status).toBe(400);
      expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(page.headers['x-frame-options']).toBe('DENY');
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.headers['x-robots-tag']).toBe('noindex');
      expect(await db.$count(oauthConnections, eq(oauthConnections.userId, climber.userId))).toBe(0);
    });

    it(
      'offers no scope the API does not serve: workouts:write waits for its route',
      async () => {
        const app = await registerApp();
        const climber = await newClimber();
        const authorization = await startAuthorization(app, { scopes: ['workouts:write', 'offline_access'] });
        expectErrorAtApp(await openAuthorize(authorization.url, climber), app, authorization, 'invalid_scope');
      },
      SUITE_DEADLINE_MS,
    );

    it.each([
      ['no code challenge', { code_challenge: null, code_challenge_method: null }],
      ['the plain method', { code_challenge_method: 'plain' }],
    ])('issues no code for %s', async (_label, overrides) => {
      const app = await registerApp('public-web');
      const climber = await newClimber();
      const authorization = await startAuthorization(app);
      for (const [name, value] of Object.entries(overrides)) {
        if (value === null) authorization.url.searchParams.delete(name);
        else authorization.url.searchParams.set(name, value);
      }
      // docs/partner-api.md: back to the registered redirect URI with invalid_request and the state.
      expectErrorAtApp(await openAuthorize(authorization.url, climber), app, authorization, 'invalid_request');
      expect(await db.$count(oauthConnections, eq(oauthConnections.userId, climber.userId))).toBe(0);
    });
  });

  describe('refresh', () => {
    it(
      'closes only the replayed family: a second device on the same connection keeps working',
      async () => {
        const app = await registerApp();
        const climber = await newClimber();
        const phone = await connect(app, climber);
        // A second device connects the same climber: remembered consent, no screen, a new family.
        const tablet = await connect(app, climber);
        expect(tablet.tokens.refresh_token).not.toBe(phone.tokens.refresh_token);

        const rotated = await refresh(app, phone.tokens.refresh_token);
        expect(rotated.ok).toBe(true);
        if (!rotated.ok) throw new Error('unreachable');
        // Replaying the spent token closes its family, successor included.
        expect(await refresh(app, phone.tokens.refresh_token)).toMatchObject({ ok: false, error: 'invalid_grant' });
        expect(await refresh(app, rotated.tokens.refresh_token)).toMatchObject({ ok: false, error: 'invalid_grant' });
        expect((await callMe(app, rotated.tokens.access_token)).status).toBe(401);
        // The other family, and the connection, carry on.
        await expectAlive(tablet);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'refreshes on day 30, rolls the 90 days on every rotation, and refuses a token left past day 90',
      async () => {
        const app = await registerApp();
        const connection = await connect(app, await newClimber());
        const familyRows = () =>
          db
            .select()
            .from(oauthRefreshToken)
            .where(
              and(
                eq(oauthRefreshToken.userId, connection.climber.userId),
                eq(oauthRefreshToken.clientId, app.clientId),
                isNull(oauthRefreshToken.revoked),
              ),
            );

        // Day 30: issued 30 days ago, 60 days left.
        let [current] = await familyRows();
        await moveRefreshToken(current, {
          createdAt: new Date(Date.now() - 30 * DAY_MS),
          expiresAt: new Date(Date.now() + 60 * DAY_MS),
        });
        const day30 = await refresh(app, connection.tokens.refresh_token);
        expect(day30).toMatchObject({ ok: true });
        if (!day30.ok) throw new Error('unreachable');

        // Day 89 and a bit: one minute left. The rotation starts a fresh 90 days.
        [current] = await familyRows();
        await moveRefreshToken(current, {
          createdAt: new Date(Date.now() - 90 * DAY_MS + 60_000),
          expiresAt: new Date(Date.now() + 60_000),
        });
        const day90 = await refresh(app, day30.tokens.refresh_token);
        expect(day90.ok).toBe(true);
        if (!day90.ok) throw new Error('unreachable');
        [current] = await familyRows();
        expect(Math.round((current.expiresAt.getTime() - Date.now()) / DAY_MS)).toBe(90);
        expect((await callMe(app, day90.tokens.access_token)).status).toBe(200);

        // A token nobody used for 90 days is refused.
        await moveRefreshToken(current, { expiresAt: new Date(Date.now() - DAY_MS) });
        expect(await refresh(app, day90.tokens.refresh_token)).toMatchObject({ ok: false, error: 'invalid_grant' });
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'answers an expired access token 401 a browser can read, then a refresh recovers',
      async () => {
        const app = await registerApp('public-web');
        const connection = await connect(app, await newClimber());
        // The access token row is gone, as the sweep leaves it after expiry.
        await db
          .delete(oauthAccessToken)
          .where(
            and(eq(oauthAccessToken.userId, connection.climber.userId), eq(oauthAccessToken.clientId, app.clientId)),
          );
        const expired = await server.send('GET', ME_PATH, {
          clientIp: app.ip,
          headers: { Authorization: `Bearer ${connection.tokens.access_token}`, Origin: app.origin ?? '' },
        });
        expect(expired.status).toBe(401);
        expect(expired.headers['www-authenticate']).toMatch(/error="invalid_token"/);
        expect(expired.headers['access-control-allow-origin']).toBe(app.origin);
        expect(expired.headers['access-control-expose-headers']).toContain('WWW-Authenticate');
        // The documented recovery: refresh once, retry.
        const refreshed = await refresh(app, connection.tokens.refresh_token);
        expect(refreshed.ok).toBe(true);
        if (!refreshed.ok) throw new Error('unreachable');
        expect((await callMe(app, refreshed.tokens.access_token)).status).toBe(200);
      },
      SUITE_DEADLINE_MS,
    );
  });

  describe('resource', () => {
    it(
      'never makes an API token from a grant that did not name the API',
      async () => {
        const app = await registerApp();
        const climber = await newClimber();
        const withoutResource = await startAuthorization(app, { resource: null });
        const parameters = oauth.validateAuthResponse(
          metadata,
          app.client,
          new URL(await callbackFor(withoutResource, climber)),
          withoutResource.state,
        );
        const exchanged = await oauth.processAuthorizationCodeResponse(
          metadata,
          app.client,
          await oauth.authorizationCodeGrantRequest(
            metadata,
            app.client,
            app.auth,
            parameters,
            withoutResource.redirectUri,
            withoutResource.verifier,
            oauthOptions(app.ip),
          ),
        );
        remember(exchanged.access_token, exchanged.refresh_token);
        expect(await callMe(app, exchanged.access_token)).toEqual({
          status: 401,
          body: { challenge: 'invalid_token' },
        });
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'refuses another resource at authorize, at the exchange and at refresh',
      async () => {
        const app = await registerApp();
        const climber = await newClimber();
        const elsewhere = 'https://api.boardsesh.com/v2';

        const wrongResource = await startAuthorization(app, { resource: elsewhere });
        expectErrorAtApp(await openAuthorize(wrongResource.url, climber), app, wrongResource, 'invalid_target');

        const authorization = await startAuthorization(app);
        const parameters = oauth.validateAuthResponse(
          metadata,
          app.client,
          new URL(await callbackFor(authorization, climber)),
          authorization.state,
        );
        const atExchange = await oauth.authorizationCodeGrantRequest(
          metadata,
          app.client,
          app.auth,
          parameters,
          authorization.redirectUri,
          authorization.verifier,
          { additionalParameters: { resource: elsewhere }, ...oauthOptions(app.ip) },
        );
        expect(atExchange.status).toBe(400);
        expect(((await atExchange.json()) as { error: string }).error).toBe('invalid_target');

        const connection = await connect(app, climber);
        const atRefresh = await oauth.refreshTokenGrantRequest(
          metadata,
          app.client,
          app.auth,
          connection.tokens.refresh_token,
          { additionalParameters: { resource: elsewhere }, ...oauthOptions(app.ip) },
        );
        expect(atRefresh.status).toBe(400);
        expect(((await atRefresh.json()) as { error: string }).error).toBe('invalid_target');
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'makes an API token when the authorization or the code exchange names the API',
      async () => {
        const app = await registerApp();
        const climber = await newClimber();
        const outcomes: Record<string, unknown> = {};
        for (const [label, atAuthorize, atExchange] of [
          ['authorize only', RESOURCE, null],
          ['exchange only', null, RESOURCE],
        ] as const) {
          const authorization = await startAuthorization(app, { resource: atAuthorize });
          const parameters = oauth.validateAuthResponse(
            metadata,
            app.client,
            new URL(await callbackFor(authorization, climber)),
            authorization.state,
          );
          const response = await oauth.authorizationCodeGrantRequest(
            metadata,
            app.client,
            app.auth,
            parameters,
            authorization.redirectUri,
            authorization.verifier,
            { ...(atExchange ? { additionalParameters: { resource: atExchange } } : {}), ...oauthOptions(app.ip) },
          );
          const body = (await response.json()) as { access_token?: string; error?: string };
          remember(body.access_token);
          outcomes[label] = {
            status: response.status,
            error: body.error ?? null,
            api: body.access_token ? (await callMe(app, body.access_token)).status : null,
          };
        }
        // Either step is enough. A grant that named it at neither is refused above.
        expect(outcomes).toEqual({
          'authorize only': { status: 200, error: null, api: 200 },
          'exchange only': { status: 200, error: null, api: 200 },
        });
      },
      SUITE_DEADLINE_MS,
    );

    it(
      "carries the grant's audience through every refresh: left out it is kept (RFC 8707 2.2), and no other is ever issued",
      async () => {
        const app = await registerApp();
        const connection = await connect(app, await newClimber());
        const elsewhere = 'https://api.boardsesh.com/v2';

        // Another resource, alone or beside the API's, is refused, and the refresh token is not spent.
        for (const resources of [[elsewhere], [RESOURCE, elsewhere]]) {
          const parameters = new URLSearchParams();
          for (const resource of resources) parameters.append('resource', resource);
          const refused = await oauth.refreshTokenGrantRequest(
            metadata,
            app.client,
            app.auth,
            connection.tokens.refresh_token,
            { additionalParameters: parameters, ...oauthOptions(app.ip) },
          );
          expect({ resources, status: refused.status, body: await refused.json() }).toMatchObject({
            resources,
            status: 400,
            body: { error: 'invalid_target' },
          });
        }

        // Left out, the grant's audience is kept, and the token reads the API.
        const refreshed = await oauth.processRefreshTokenResponse(
          metadata,
          app.client,
          await oauth.refreshTokenGrantRequest(
            metadata,
            app.client,
            app.auth,
            connection.tokens.refresh_token,
            oauthOptions(app.ip),
          ),
        );
        remember(refreshed.access_token, refreshed.refresh_token);
        expect((await callMe(app, refreshed.access_token)).status).toBe(200);

        // No token this connection ever got names anything but the API.
        const accessTokens = await db
          .select({ resources: oauthAccessToken.resources })
          .from(oauthAccessToken)
          .where(
            and(eq(oauthAccessToken.userId, connection.climber.userId), eq(oauthAccessToken.clientId, app.clientId)),
          );
        const refreshTokens = await db
          .select({ resources: oauthRefreshToken.resources })
          .from(oauthRefreshToken)
          .where(
            and(eq(oauthRefreshToken.userId, connection.climber.userId), eq(oauthRefreshToken.clientId, app.clientId)),
          );
        const issued = [...accessTokens, ...refreshTokens];
        expect(issued.length).toBeGreaterThanOrEqual(4);
        for (const { resources } of issued) expect(resources).toEqual([RESOURCE]);
      },
      SUITE_DEADLINE_MS,
    );
  });

  describe('widening', () => {
    it(
      'gives new scopes to new tokens only, and refuses to widen by refresh',
      async () => {
        const app = await registerApp();
        const climber = await newClimber();
        const narrow = await connect(app, climber, { scopes: ['offline_access'] });
        expect((await callMe(app, narrow.tokens.access_token)).body).toEqual({ id: expect.any(String) });
        expect(
          await refresh(app, narrow.tokens.refresh_token, server, { scope: 'profile:read offline_access' }),
        ).toMatchObject({ ok: false, error: 'invalid_scope' });

        // Asking for more shows the consent screen again.
        const wider = await startAuthorization(app);
        const { location } = await openAuthorize(wider.url, climber);
        expect(location.startsWith(`${CONSENT_PAGE}?`)).toBe(true);
        const approved = await approve(location, climber);
        const widened = await redeem(app, wider, approved.body.url as string);
        expect((await callMe(app, widened.access_token)).body).toHaveProperty('displayName');
        // The old token keeps the scopes it was issued with.
        expect((await callMe(app, narrow.tokens.access_token)).body).toEqual({ id: expect.any(String) });
      },
      SUITE_DEADLINE_MS,
    );
  });

  describe('token revocation', () => {
    it(
      'ends one access token, or one refresh family, and nothing else; and answers 200 for a stranger',
      async () => {
        const app = await registerApp();
        const otherApp = await registerApp();
        const connection = await connect(app, await newClimber());
        const revoke = async (by: PartnerApp, token: string) =>
          oauth.processRevocationResponse(
            await oauth.revocationRequest(metadata, by.client, by.auth, token, oauthOptions(by.ip)),
          );

        // Another app cannot revoke this app's token, though it is told 200.
        await revoke(otherApp, connection.tokens.access_token);
        expect((await callMe(app, connection.tokens.access_token)).status).toBe(200);
        await revoke(app, `unknown-${randomUUID()}`);

        await revoke(app, connection.tokens.access_token);
        expect((await callMe(app, connection.tokens.access_token)).status).toBe(401);
        const rotated = await refresh(app, connection.tokens.refresh_token);
        expect(rotated.ok).toBe(true);
        if (!rotated.ok) throw new Error('unreachable');

        await revoke(app, rotated.tokens.refresh_token);
        // docs/partner-api.md: revoking a refresh token also ends the access tokens issued with it.
        // Checked before anything else touches the family: a later replay of the refresh
        // token closes the whole family anyway, which would hide a revoke that left them.
        expect(await callMe(app, rotated.tokens.access_token)).toEqual({
          status: 401,
          body: { challenge: 'invalid_token' },
        });
        expect(await refresh(app, rotated.tokens.refresh_token)).toMatchObject({ ok: false, error: 'invalid_grant' });
        // Revoking a credential is not Disconnect: the connection is not ended.
        expect((await connectionRow(connection)).revokedAt).toBeNull();
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'holds each confidential app to the authentication method it registered',
      async () => {
        for (const kind of ['confidential-basic', 'confidential-post'] as const) {
          const app = await registerApp(kind);
          const secret = app.clientSecret ?? '';
          const switched: PartnerApp = {
            ...app,
            auth: kind === 'confidential-basic' ? oauth.ClientSecretPost(secret) : oauth.ClientSecretBasic(secret),
          };
          const connection = await connect(app, await newClimber());
          // The right secret by the other method: refused at refresh and at the code exchange.
          expect({ kind, outcome: await refresh(switched, connection.tokens.refresh_token) }).toMatchObject({
            kind,
            outcome: { ok: false, error: 'invalid_client' },
          });
          const authorization = await startAuthorization(app);
          const parameters = oauth.validateAuthResponse(
            metadata,
            app.client,
            new URL(await callbackFor(authorization, connection.climber)),
            authorization.state,
          );
          const exchange = await oauth.authorizationCodeGrantRequest(
            metadata,
            switched.client,
            switched.auth,
            parameters,
            authorization.redirectUri,
            authorization.verifier,
            { additionalParameters: { resource: RESOURCE }, ...oauthOptions(app.ip) },
          );
          expect({
            kind,
            status: exchange.status,
            error: ((await exchange.json()) as { error?: string }).error,
          }).toEqual(
            // partner-api.md: 401 with a Basic challenge when the request used Basic, 400 when it used the body.
            { kind, status: kind === 'confidential-basic' ? 400 : 401, error: 'invalid_client' },
          );
          await expectAlive(connection);
        }
      },
      SUITE_DEADLINE_MS,
    );

    it(
      "refuses one app's refresh token presented by another app",
      async () => {
        const app = await registerApp();
        const otherApp = await registerApp();
        const connection = await connect(app, await newClimber());
        const stolen = await refresh(otherApp, connection.tokens.refresh_token);
        expect(stolen.ok).toBe(false);
        await expectAlive(connection);
      },
      SUITE_DEADLINE_MS,
    );
  });

  describe('consent', () => {
    it(
      'counts a sign-in under 30 days old and refuses one over it',
      async () => {
        const app = await registerApp();
        const climberId = await createAccount('aging');
        const ip = freshClientIp();
        const at = async (authTime: number) => {
          const cookie = await signInOnWeb(climberId, { webMode: 'allowlist', authTime });
          return (await openAuthorize((await startAuthorization(app)).url, { ip, cookie })).location;
        };
        expect((await at(nowSeconds() - 29 * 86_400)).startsWith(`${CONSENT_PAGE}?`)).toBe(true);
        expect((await at(nowSeconds() - 31 * 86_400)).startsWith(`${SIGN_IN_PAGE}?`)).toBe(true);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'refuses a sign-in from before the last password write, and one inside the 60 seconds after it',
      async () => {
        const app = await registerApp();
        const climberId = await createAccount('reset');
        // Every time here is fixed against one anchor, so a slow machine moves none of the gaps:
        // the password changed ten minutes ago, and each sign-in sits 30 s or more from a boundary.
        const passwordWrittenAt = nowSeconds() - 600;
        await db
          .insert(userCredentials)
          .values({ userId: climberId, passwordHash: 'hash', updatedAt: new Date(passwordWrittenAt * 1000) });
        const ip = freshClientIp();
        const at = async (authTime: number) => {
          const cookie = await signInOnWeb(climberId, { webMode: 'allowlist', authTime });
          return (await openAuthorize((await startAuthorization(app)).url, { ip, cookie })).location;
        };
        expect((await at(passwordWrittenAt - 3000)).startsWith(`${SIGN_IN_PAGE}?`)).toBe(true);
        expect((await at(passwordWrittenAt + 30)).startsWith(`${SIGN_IN_PAGE}?`)).toBe(true);
        expect((await at(passwordWrittenAt + 120)).startsWith(`${CONSENT_PAGE}?`)).toBe(true);
      },
      SUITE_DEADLINE_MS,
    );

    it.each([
      ['without a sign-in time', { withoutAuthTime: true }],
      ['without a login id', { withoutLoginId: true }],
      ['without either', { withoutAuthTime: true, withoutLoginId: true }],
    ])(
      'sends a session carried over from before the sign-in claims (%s) to sign in, and its consent calls nowhere',
      async (_label, migrated) => {
        const app = await registerApp();
        const userId = await createAccount('migrated');
        const ip = freshClientIp();
        // A link opened by a current sign-in of the same climber, then answered with the old cookie.
        const current: Climber = { userId, ip, cookie: await signInOnWeb(userId, { webMode: 'allowlist' }) };
        const { location: link } = await openAuthorize((await startAuthorization(app)).url, current);
        expect(link.startsWith(`${CONSENT_PAGE}?`)).toBe(true);
        const stale: Climber = { userId, ip, cookie: await signInOnWeb(userId, { webMode: 'allowlist', migrated }) };
        remember(stale.cookie.split('=')[1]);
        const { location } = await openAuthorize((await startAuthorization(app)).url, stale);
        expect(location.startsWith(`${SIGN_IN_PAGE}?`)).toBe(true);
        for (const path of [CONSENT_DETAILS_PATH, CONSENT_PATH]) {
          const refused = await postConsentRoute(path, link, stale, { accept: true });
          expect({ path, status: refused.reply.status, error: refused.body.error }).toEqual({
            path,
            status: 401,
            error: 'login_required',
          });
        }
        expect(await db.$count(oauthConnections, eq(oauthConnections.userId, userId))).toBe(0);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      "treats a deleted account's cookie as signed out",
      async () => {
        const app = await registerApp();
        const climber = await newClimber();
        await db.delete(users).where(eq(users.id, climber.userId));
        const { location } = await openAuthorize((await startAuthorization(app)).url, climber);
        expect(location.startsWith(`${SIGN_IN_PAGE}?`)).toBe(true);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'takes consent only from www, once, from the climber the link was shown to',
      async () => {
        const app = await registerApp();
        const climber = await newClimber();
        const authorization = await startAuthorization(app);
        const { location } = await openAuthorize(authorization.url, climber);

        for (const origin of ['https://preview.boardsesh.com', 'https://app.boardsesh.com', null]) {
          const crossSite = await postConsentRoute(CONSENT_PATH, location, climber, { accept: true }, { origin });
          expect(crossSite.reply.status).toBe(403);
        }

        // The link's query is signed: a changed scope is not this link any more.
        const tampered = new URL(location);
        tampered.searchParams.set('scope', 'profile:read offline_access openid');
        expect((await approve(tampered.href, climber)).reply.status).toBe(400);
        expect((await postConsentRoute(CONSENT_DETAILS_PATH, tampered.href, climber)).reply.status).toBe(400);

        // Someone else signs in on the same computer and answers the open link.
        const switched = {
          ...climber,
          cookie: await signInOnWeb(await createAccount('switched'), { webMode: 'allowlist' }),
        };
        expect((await approve(location, switched)).reply.status).toBe(400);
        expect((await postConsentRoute(CONSENT_DETAILS_PATH, location, switched)).reply.status).toBe(400);

        const approved = await approve(location, climber);
        expect(approved.reply.status).toBe(200);
        expect(approved.reply.headers['cache-control']).toBe('no-store');
        // The same link again: spent.
        expect((await approve(location, climber)).reply.status).toBe(400);
        await redeem(app, authorization, approved.body.url as string);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'turns a climber away at once when the app is full, and fills no place with an unredeemed approval',
      async () => {
        const app = await registerApp();
        await db
          .update(oauthAppPolicy)
          .set({ maxNewConnectionsPerDay: 1 })
          .where(eq(oauthAppPolicy.clientId, app.clientId));
        // Approved and never redeemed: holds no place.
        const walkAway = await newClimber();
        const { location } = await openAuthorize((await startAuthorization(app)).url, walkAway);
        expect((await approve(location, walkAway)).reply.status).toBe(200);

        await connect(app, await newClimber());
        const late = await newClimber();
        const lateAuthorization = await startAuthorization(app);
        const lateScreen = await openAuthorize(lateAuthorization.url, late);
        const refused = await approve(lateScreen.location, late);
        expect(new URL(refused.body.url as string).searchParams.get('error')).toBe('temporarily_unavailable');
        expect((await connectionRow({ app, climber: late }))?.connectedAt ?? null).toBeNull();
      },
      SUITE_DEADLINE_MS,
    );
  });

  // -------------------------------------------------------------------------
  // The fast path's section 3: every way a climber's credentials change, on a
  // connection made through the real server, read back through the real API.
  // -------------------------------------------------------------------------

  describe('the revocation table', () => {
    let app: PartnerApp;
    let otherApp: PartnerApp;

    beforeAll(async () => {
      app = await registerApp();
      otherApp = await registerApp();
      // Every row connects a new climber to these two apps; the owner raises caps in the policy row.
      await db
        .update(oauthAppPolicy)
        .set({ maxActiveConnections: 200, maxNewConnectionsPerDay: 200 })
        .where(inArray(oauthAppPolicy.clientId, [app.clientId, otherApp.clientId]));
    });

    /** A climber with a password set yesterday, signed in now, connected to `app`. */
    async function liveConnection({ password = 'hash-before' as string | null, label = 'row' } = {}) {
      const userId = await createAccount(label);
      if (password !== null) {
        await db
          .insert(userCredentials)
          .values({ userId, passwordHash: password, updatedAt: new Date(Date.now() - DAY_MS) });
      }
      const climber: Climber = {
        userId,
        ip: freshClientIp(),
        cookie: await signInOnWeb(userId, { webMode: 'allowlist' }),
      };
      remember(climber.cookie.split('=')[1]);
      return connect(app, climber);
    }

    it(
      'row 1: a forgotten-password reset on www ends the connection (the route, update branch)',
      async () => {
        const connection = await liveConnection();
        const bystander = await liveConnection({ label: 'bystander' });
        const climberId = connection.climber.userId;
        // Statement for statement: web/app/api/auth/reset-password/route.ts, its transaction.
        await db.transaction(async (transaction) => {
          await transaction
            .select({ userId: userCredentials.userId })
            .from(userCredentials)
            .where(eq(userCredentials.userId, climberId))
            .limit(1);
          await transaction
            .update(userCredentials)
            .set({ passwordHash: 'hash-after', updatedAt: new Date() })
            .where(eq(userCredentials.userId, climberId));
          await transaction
            .update(users)
            .set({ emailVerified: new Date(), updatedAt: new Date() })
            .where(and(eq(users.id, climberId), isNull(users.emailVerified)));
          await transaction
            .delete(verificationTokens)
            .where(eq(verificationTokens.identifier, `password-reset:${climberId}`));
        });
        await expectEnded(connection);
        expect((await connectionRow(connection)).revocationReason).toBe('account_security_revocation');
        await expectAlive(bystander);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'row 1: the same reset ends the connection of an account that had no password (insert branch)',
      async () => {
        const connection = await liveConnection({ password: null });
        await db.transaction(async (transaction) => {
          await transaction
            .insert(userCredentials)
            .values({ userId: connection.climber.userId, passwordHash: 'hash-after' });
        });
        await expectEnded(connection);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'row 2: the staged reset ends the connection, its users FOR UPDATE and the trigger in one transaction',
      async () => {
        const connection = await liveConnection();
        // The write shape of backend/src/auth/current-store/password-recovery.ts: users FOR UPDATE, then the hash.
        await db.transaction(async (transaction) => {
          await transaction
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, connection.climber.userId))
            .for('update');
          await transaction
            .update(userCredentials)
            .set({ passwordHash: 'hash-after' })
            .where(eq(userCredentials.userId, connection.climber.userId));
        });
        await expectEnded(connection);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'row 3: setting a first password ends the connection (web internal route)',
      async () => {
        const connection = await liveConnection({ password: null });
        // Statement for statement: web/app/api/internal/set-password/route.ts, its transaction.
        await db.transaction(async (transaction) => {
          await transaction
            .insert(userCredentials)
            .values({ userId: connection.climber.userId, passwordHash: 'hash-after' });
          await transaction
            .update(users)
            .set({ emailVerified: new Date(), updatedAt: new Date() })
            .where(and(eq(users.id, connection.climber.userId), isNull(users.emailVerified)));
        });
        await expectEnded(connection);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'row 4: a change-password writer, when one exists, ends the connection through the same UPDATE',
      async () => {
        const connection = await liveConnection();
        await db
          .update(userCredentials)
          .set({ passwordHash: 'hash-after' })
          .where(eq(userCredentials.userId, connection.climber.userId));
        await expectEnded(connection);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'row 5: deleting the account through GraphQL removes the connection and every token, and leaves the app',
      async () => {
        const connection = await liveConnection();
        const bystander = await liveConnection({ label: 'bystander' });
        const deleted = await server.graphql(
          `mutation { deleteAccount(input: { removeSetterName: false }) }`,
          undefined,
          { bearer: await firstPartyToken(connection.climber.userId) },
        );
        expect(deleted.errors).toBeUndefined();
        expect(deleted.data).toEqual({ deleteAccount: true });
        await expectEnded(connection, { rowGone: true });
        expect(await db.$count(oauthSubjects, eq(oauthSubjects.userId, connection.climber.userId))).toBe(0);
        expect(await db.$count(oauthClient, eq(oauthClient.clientId, app.clientId))).toBe(1);
        await expectAlive(bystander);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      "row 6: a users delete, as NextAuth's adapter would issue, cascades the same way",
      async () => {
        const connection = await liveConnection();
        await db.delete(users).where(eq(users.id, connection.climber.userId));
        await expectEnded(connection, { rowGone: true });
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'rows 7 and 8: linking or unlinking a sign-in provider ends nothing',
      async () => {
        const connection = await liveConnection();
        const providerAccountId = randomUUID();
        await db
          .insert(accounts)
          .values({ userId: connection.climber.userId, provider: 'google', providerAccountId, type: 'oauth' });
        const linked = await expectAlive(connection);
        await db.delete(accounts).where(eq(accounts.providerAccountId, providerAccountId));
        await expectAlive(linked);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'row 9: registration writes a password through the real identity insert; a connection made after it lives',
      async () => {
        const email = `registered-${randomUUID()}@example.invalid`;
        const created = await db.transaction((transaction) =>
          insertCurrentStorePasswordIdentity(transaction, { email, name: 'New climber', passwordHash: 'hash' }, true),
        );
        const climber: Climber = {
          userId: created.userId,
          ip: freshClientIp(),
          cookie: await signInOnWeb(created.userId, { webMode: 'allowlist' }),
        };
        // That insert is a password write, so a sign-in in the next 60 seconds does not count yet.
        const tooSoon = await openAuthorize((await startAuthorization(app)).url, climber);
        expect(tooSoon.location.startsWith(`${SIGN_IN_PAGE}?`)).toBe(true);
        // A minute on (only updated_at moves, which ends nothing), the same sign-in counts.
        await db
          .update(userCredentials)
          .set({ updatedAt: new Date(Date.now() - 2 * 60_000) })
          .where(eq(userCredentials.userId, created.userId));
        await expectAlive(await connect(app, climber));
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'row 10: web sign-out ends nothing, and the connection outlives the www login that made it',
      async () => {
        const connection = await liveConnection();
        // Signing out drops the cookie; the closest database write is a sessions row going.
        await db.insert(sessions).values({
          userId: connection.climber.userId,
          sessionToken: randomUUID(),
          expires: new Date(Date.now() + 60_000),
        });
        await db.delete(sessions).where(eq(sessions.userId, connection.climber.userId));
        // The bridged login row ages out and the sweep takes it.
        await db
          .update(oauthSession)
          .set({ expiresAt: new Date(Date.now() - 2 * HOUR_MS) })
          .where(eq(oauthSession.userId, connection.climber.userId));
        await runPartnerOAuthSweep();
        expect(await db.$count(oauthSession, eq(oauthSession.userId, connection.climber.userId))).toBe(0);
        // offline_access still renews, and the new token reads the API.
        await expectAlive(await expectAlive(connection));
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'rows 11 and 12: native sign-in, native sign-out and a watch refresh token end nothing',
      async () => {
        const userId = await createAccount('native');
        await db.insert(userCredentials).values({
          userId,
          passwordHash: await bcrypt.hash('native-password', 4),
          updatedAt: new Date(Date.now() - DAY_MS),
        });
        const climber: Climber = {
          userId,
          ip: freshClientIp(),
          cookie: await signInOnWeb(userId, { webMode: 'allowlist' }),
        };
        const connection = await connect(app, climber);
        const nativeLogin = await server.send('POST', '/auth/native/credentials', {
          host: 'ws.boardsesh.com',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: `${userId}@example.invalid`, password: 'native-password' }),
        });
        expect(nativeLogin.status).toBe(200);
        const { refreshToken } = JSON.parse(nativeLogin.body) as { refreshToken: string };
        remember(refreshToken);
        // A watch pairing issues one more first-party refresh token.
        await db.insert(mobileRefreshTokens).values({
          userId,
          tokenHash: randomUUID().replaceAll('-', ''),
          expiresAt: new Date(Date.now() + DAY_MS),
        });
        const nativeSignOut = await server.send('POST', '/auth/native/revoke', {
          host: 'ws.boardsesh.com',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        expect(nativeSignOut.status).toBe(200);
        expect(
          await db.$count(
            mobileRefreshTokens,
            and(eq(mobileRefreshTokens.userId, userId), isNull(mobileRefreshTokens.revokedAt)),
          ),
        ).toBe(0);
        await expectAlive(connection);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'rows 13 and 14: verifying or changing the email ends nothing',
      async () => {
        const connection = await liveConnection();
        await db.update(users).set({ emailVerified: new Date() }).where(eq(users.id, connection.climber.userId));
        const verified = await expectAlive(connection);
        await db
          .update(users)
          .set({ email: `changed-${randomUUID()}@example.invalid` })
          .where(eq(users.id, connection.climber.userId));
        await expectAlive(verified);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      "row 15: revoke-user ends every connection the climber has, across apps, and nobody else's; a dry run ends none",
      async () => {
        const connection = await liveConnection();
        const second = await connect(otherApp, connection.climber);
        const bystander = await liveConnection({ label: 'bystander' });

        const dryRun = await revokePartnerUser(db, { userId: connection.climber.userId, apply: false });
        expect(dryRun).toMatchObject({ applied: false, after: null, before: { liveConnections: 2 } });
        const stillLive = await expectAlive(connection);

        const applied = await revokePartnerUser(db, { userId: connection.climber.userId, apply: true });
        expect(applied).toMatchObject({
          applied: true,
          connectionsRevoked: 2,
          after: { liveConnections: 0, accessTokens: 0, refreshTokens: 0, consents: 0, grants: 0, pendingCodes: 0 },
        });
        await expectEnded(stillLive);
        await expectEnded(second);
        await expectAlive(bystander);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'row 16: a direct SQL password write ends the connection',
      async () => {
        const connection = await liveConnection();
        await rawSql`UPDATE user_credentials SET password_hash = 'hash-after' WHERE user_id = ${connection.climber.userId}`;
        await expectEnded(connection);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'after any of them, reconnecting asks for consent, keeps the subject, and never revives the old tokens',
      async () => {
        const connection = await liveConnection();
        const subject = (await callMe(app, connection.tokens.access_token)).body.id;
        await db
          .update(userCredentials)
          .set({ passwordHash: 'hash-after' })
          .where(eq(userCredentials.userId, connection.climber.userId));
        await expectEnded(connection);
        // The reset made the old sign-in too old to approve anything; the climber signs in again a minute later.
        expect(
          (await openAuthorize((await startAuthorization(app)).url, connection.climber)).location.startsWith(
            `${SIGN_IN_PAGE}?`,
          ),
        ).toBe(true);
        await db
          .update(userCredentials)
          .set({ updatedAt: new Date(Date.now() - 2 * 60_000) })
          .where(eq(userCredentials.userId, connection.climber.userId));
        const climber: Climber = {
          ...connection.climber,
          cookie: await signInOnWeb(connection.climber.userId, { webMode: 'allowlist' }),
        };
        const authorization = await startAuthorization(app);
        const { location } = await openAuthorize(authorization.url, climber);
        expect(location.startsWith(`${CONSENT_PAGE}?`)).toBe(true);
        const approved = await approve(location, climber);
        const fresh = await redeem(app, authorization, approved.body.url as string);
        expect((await callMe(app, fresh.access_token)).body.id).toBe(subject);
        expect((await callMe(app, connection.tokens.access_token)).status).toBe(401);
        expect(await refresh(app, connection.tokens.refresh_token)).toMatchObject({
          ok: false,
          error: 'invalid_grant',
        });
      },
      SUITE_DEADLINE_MS,
    );
  });

  // -------------------------------------------------------------------------
  // Races, with barriers on what the database says, never on a clock.
  // -------------------------------------------------------------------------

  /**
   * Waits until this many sessions in this database wait on a lock, or until
   * `settled` says the request being waited for has already finished.
   */
  async function waitForLockWaiters(minimum: number, settled: () => boolean = () => false): Promise<boolean> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (settled()) return false;
      const [row] = await rawSql<Array<{ waiting: number }>>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (row.waiting >= minimum) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Fewer than ${minimum} sessions ever waited on a lock`);
  }

  /**
   * A starting gun. Holds the climber's `users` row FOR UPDATE, which every
   * issuer, refresh and Disconnect must take FOR SHARE first, starts the
   * requests, waits until all of them are queued on that row, then lets them go
   * at once. Fails if they did not all queue: a race that ran one after the
   * other proves nothing.
   */
  async function releaseTogether<Outcomes extends readonly unknown[]>(
    userId: string,
    requests: () => { [Index in keyof Outcomes]: Promise<Outcomes[Index]> },
  ): Promise<Outcomes> {
    const holder = await rawSql.reserve();
    try {
      await holder`BEGIN`;
      await holder`SELECT 1 FROM users WHERE id = ${userId} FOR UPDATE`;
      const started = requests();
      let settledCount = 0;
      for (const request of started) {
        void Promise.resolve(request).then(
          () => (settledCount += 1),
          () => (settledCount += 1),
        );
      }
      const queued = await waitForLockWaiters(started.length, () => settledCount > 0);
      await holder`COMMIT`;
      const outcomes = (await Promise.allSettled(started)) as Array<PromiseSettledResult<unknown>>;
      expect({ allQueuedBehindTheGun: queued }).toEqual({ allQueuedBehindTheGun: true });
      return outcomes.map((outcome) => {
        if (outcome.status === 'rejected') throw outcome.reason;
        return outcome.value;
      }) as unknown as Outcomes;
    } finally {
      holder.release();
    }
  }

  describe('cleanup failure', () => {
    it(
      'a Disconnect whose cleanup fails ends nothing, answers an error, and a retry ends it',
      async () => {
        const app = await registerApp();
        const connection = await connect(app, await newClimber());
        const before = await connectionRow(connection);
        const refreshRows = () =>
          db.$count(
            oauthRefreshToken,
            and(eq(oauthRefreshToken.userId, connection.climber.userId), eq(oauthRefreshToken.clientId, app.clientId)),
          );
        const refreshRowsBefore = await refreshRows();
        // A fault in the middle of the cleanup, for this climber only: deleting their refresh tokens fails.
        const fault = `launch_suite_fault_${randomUUID().replaceAll('-', '')}`;
        await rawSql.unsafe(`
          CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $fault$
          BEGIN
            IF OLD.user_id = '${connection.climber.userId}' THEN
              RAISE EXCEPTION 'injected partner cleanup failure';
            END IF;
            RETURN OLD;
          END;
          $fault$`);
        await rawSql.unsafe(
          `CREATE TRIGGER ${fault} BEFORE DELETE ON oauth_refresh_token FOR EACH ROW EXECUTE FUNCTION ${fault}()`,
        );
        try {
          const failed = await disconnectByApp(app, connection.tokens.access_token);
          expect(failed.status).toBe(500);
          // All or nothing: the generation, the revocation and every token are as they were.
          const after = await connectionRow(connection);
          expect({ generation: after.generation, revokedAt: after.revokedAt }).toEqual({
            generation: before.generation,
            revokedAt: null,
          });
          expect(await refreshRows()).toBe(refreshRowsBefore);
          expect((await callMe(app, connection.tokens.access_token)).status).toBe(200);
        } finally {
          await rawSql.unsafe(`DROP TRIGGER IF EXISTS ${fault} ON oauth_refresh_token`);
          await rawSql.unsafe(`DROP FUNCTION IF EXISTS ${fault}()`);
        }
        expect((await disconnectByApp(app, connection.tokens.access_token)).status).toBe(204);
        await expectEnded(connection);
      },
      SUITE_DEADLINE_MS,
    );
  });

  describe('races', () => {
    it(
      'a refresh queued behind a password reset gets invalid_grant, never a token',
      async () => {
        const app = await registerApp();
        const userId = await createAccount('racer');
        await db
          .insert(userCredentials)
          .values({ userId, passwordHash: 'hash-before', updatedAt: new Date(Date.now() - DAY_MS) });
        const connection = await connect(app, {
          userId,
          ip: freshClientIp(),
          cookie: await signInOnWeb(userId, { webMode: 'allowlist' }),
        });

        const writer = await rawSql.reserve();
        try {
          await writer`BEGIN`;
          // The trigger runs now and holds the climber's row until the reset commits.
          await writer`UPDATE user_credentials SET password_hash = 'hash-after' WHERE user_id = ${userId}`;
          const refreshing = refresh(app, connection.tokens.refresh_token);
          await waitForLockWaiters(1);
          await writer`COMMIT`;
          expect(await refreshing).toMatchObject({ ok: false, error: 'invalid_grant' });
        } finally {
          writer.release();
        }
        await expectEnded(connection);
        expect(await db.$count(oauthRefreshToken, eq(oauthRefreshToken.userId, userId))).toBe(0);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'a Disconnect and a widening consent on the same connection both finish without a server error',
      async () => {
        // Cross-PR: F13's consent locks the consent link, then the connection;
        // F10's Disconnect locks the connection, then deletes consent links.
        const app = await registerApp();
        const climber = await newClimber();
        const narrow = await connect(app, climber, { scopes: ['offline_access'] });
        const wider = await startAuthorization(app);
        const { location } = await openAuthorize(wider.url, climber);
        expect(location.startsWith(`${CONSENT_PAGE}?`)).toBe(true);
        const signature = new URL(location).searchParams.get('sig') ?? '';
        const digest = createHash('sha256').update(`partner-consent-interaction-v1:${signature}`).digest('hex');

        // Hold the open link so both requests queue on it in a known order: consent first.
        const holder = await rawSql.reserve();
        try {
          await holder`BEGIN`;
          await holder`SELECT 1 FROM oauth_consent_interactions WHERE digest = ${digest} FOR UPDATE`;
          const consenting = approve(location, climber);
          await waitForLockWaiters(1);
          // A Disconnect that never waits on the link may finish here; one that does queues behind consent.
          let disconnectFinished = false;
          const disconnecting = disconnectByApp(app, narrow.tokens.access_token).finally(() => {
            disconnectFinished = true;
          });
          await waitForLockWaiters(2, () => disconnectFinished);
          await holder`ROLLBACK`;
          const [consented, disconnected] = await Promise.all([consenting, disconnecting]);
          // Either may win. A deadlock victim answers 503 instead.
          expect({ consent: consented.reply.status < 500, disconnect: disconnected.status }).toEqual({
            consent: true,
            disconnect: 204,
          });
        } finally {
          holder.release();
        }
        await expectEnded(narrow);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'deleting an app while a consent answer, a refresh and a Disconnect queue on it: no deadlock, no server error',
      async () => {
        // F15: the delete cascades into the app's connections, consent screens and
        // tokens. It locks them first in the partner order (users, screens,
        // connections), so a consent answer holding its screen and waiting on the
        // connection never meets a cascade holding the connection and waiting on
        // that screen. Postgres would abort one of them (503 or a busy refusal).
        const app = await registerApp();
        const climber = await newClimber();
        const narrow = await connect(app, climber, { scopes: ['offline_access'] });
        const other = await connect(app, await newClimber());
        const wider = await startAuthorization(app);
        const { location } = await openAuthorize(wider.url, climber);
        expect(location.startsWith(`${CONSENT_PAGE}?`)).toBe(true);
        const developerBearer = await firstPartyToken(app.developerId);

        // The gun: a key share on the app row, which any in-flight insert naming
        // the app holds. The delete takes every lock of its own, then waits here
        // to delete that row, which is the moment its cascade would start.
        const holder = await rawSql.reserve();
        try {
          await holder`BEGIN`;
          await holder`SELECT 1 FROM oauth_client WHERE client_id = ${app.clientId} FOR KEY SHARE`;
          let deleteFinished = false;
          const deleting = server
            .graphql(
              `mutation DeleteApp($clientId: ID!) { deleteOAuthClient(clientId: $clientId) }`,
              { clientId: app.clientId },
              { bearer: developerBearer },
            )
            .finally(() => {
              deleteFinished = true;
            });
          await waitForLockWaiters(1, () => deleteFinished);
          const consenting = approve(location, climber);
          await waitForLockWaiters(2);
          const refreshing = refresh(app, narrow.tokens.refresh_token);
          await waitForLockWaiters(3);
          const disconnecting = disconnectByApp(app, other.tokens.access_token);
          await waitForLockWaiters(4);
          await holder`ROLLBACK`;

          const [deleted, consented, refreshed, disconnected] = await Promise.all([
            deleting,
            consenting,
            refreshing,
            disconnecting,
          ]);
          expect({ errors: deleted.errors, deleted: deleted.data?.deleteOAuthClient }).toEqual({
            errors: undefined,
            deleted: true,
          });
          // Each queued request found the app gone and answered as a client error.
          expect({
            consent: consented.reply.status,
            refreshIssued: refreshed.ok,
            refreshServerError: !refreshed.ok && (refreshed.status ?? 0) >= 500,
            disconnectServerError: disconnected.status >= 500,
          }).toEqual({ consent: 400, refreshIssued: false, refreshServerError: false, disconnectServerError: false });
        } finally {
          // A failed assertion must not leave the key share held for the next test's hooks.
          await holder`ROLLBACK`.catch(() => undefined);
          holder.release();
        }
        for (const table of [oauthConnections, oauthConsentInteractions, oauthRefreshToken] as const) {
          expect(await db.$count(table, eq(table.clientId, app.clientId))).toBe(0);
        }
      },
      SUITE_DEADLINE_MS,
    );

    it(
      "account deletion takes its app's partner locks before the cascade: consent, refresh and Disconnect queue behind it",
      async () => {
        // What this proves: deleteAccount takes the app's partner-order locks
        // (lockOwnedAppsForDeletion) before its users delete cascades into the
        // app, so a consent answer, a refresh and a Disconnect on that app queue
        // behind the deletion and then answer as client errors. It does not
        // reproduce a deadlock: with the lock step removed, these three finish
        // before the cascade and no cycle forms here or in the reviewer's
        // stronger probe. The step is a defensive guard that keeps account
        // deletion in the same order as app deletion. Same gun as above: a key
        // share on the app row parks the cascade where it would delete the app.
        const app = await registerApp();
        const climber = await newClimber();
        const narrow = await connect(app, climber, { scopes: ['offline_access'] });
        const other = await connect(app, await newClimber());
        const wider = await startAuthorization(app);
        const { location } = await openAuthorize(wider.url, climber);
        expect(location.startsWith(`${CONSENT_PAGE}?`)).toBe(true);
        const developerBearer = await firstPartyToken(app.developerId);

        const holder = await rawSql.reserve();
        try {
          await holder`BEGIN`;
          await holder`SELECT 1 FROM oauth_client WHERE client_id = ${app.clientId} FOR KEY SHARE`;
          let deleteFinished = false;
          const deleting = server
            .graphql(`mutation { deleteAccount(input: { removeSetterName: false }) }`, {}, { bearer: developerBearer })
            .finally(() => {
              deleteFinished = true;
            });
          await waitForLockWaiters(1, () => deleteFinished);
          const consenting = approve(location, climber);
          await waitForLockWaiters(2);
          const refreshing = refresh(app, narrow.tokens.refresh_token);
          await waitForLockWaiters(3);
          const disconnecting = disconnectByApp(app, other.tokens.access_token);
          await waitForLockWaiters(4);
          await holder`ROLLBACK`;

          const [deleted, consented, refreshed, disconnected] = await Promise.all([
            deleting,
            consenting,
            refreshing,
            disconnecting,
          ]);
          expect({ errors: deleted.errors, deleted: deleted.data?.deleteAccount }).toEqual({
            errors: undefined,
            deleted: true,
          });
          expect({
            consent: consented.reply.status,
            refreshIssued: refreshed.ok,
            refreshServerError: !refreshed.ok && (refreshed.status ?? 0) >= 500,
            disconnectServerError: disconnected.status >= 500,
          }).toEqual({ consent: 400, refreshIssued: false, refreshServerError: false, disconnectServerError: false });
        } finally {
          // A failed assertion must not leave the key share held for the next test's hooks.
          await holder`ROLLBACK`.catch(() => undefined);
          holder.release();
        }
        expect(await db.$count(users, eq(users.id, app.developerId))).toBe(0);
        for (const table of [oauthConnections, oauthConsentInteractions, oauthRefreshToken] as const) {
          expect(await db.$count(table, eq(table.clientId, app.clientId))).toBe(0);
        }
      },
      SUITE_DEADLINE_MS,
    );
  });

  // -------------------------------------------------------------------------
  // F11's sweep against rows real flows wrote.
  // -------------------------------------------------------------------------

  describe('the retention sweep', () => {
    it(
      'sweeps a rotated refresh token, and replaying it still closes its family',
      async () => {
        const app = await registerApp();
        const connection = await connect(app, await newClimber());
        const [spent] = await db
          .select()
          .from(oauthRefreshToken)
          .where(
            and(eq(oauthRefreshToken.userId, connection.climber.userId), eq(oauthRefreshToken.clientId, app.clientId)),
          );
        const rotated = await refresh(app, connection.tokens.refresh_token);
        if (!rotated.ok) throw new Error('The rotation failed.');
        // Two hours on: the rotation is past the sweep's one-hour grace, and the
        // access token issued with the spent refresh token has expired.
        const twoHoursAgo = new Date(Date.now() - 2 * HOUR_MS);
        await db.update(oauthRefreshToken).set({ revoked: twoHoursAgo }).where(eq(oauthRefreshToken.id, spent.id));
        await db
          .update(oauthRefreshAncestors)
          .set({ consumedAt: twoHoursAgo })
          .where(eq(oauthRefreshAncestors.tokenHash, spent.token));
        await db
          .update(oauthAccessToken)
          .set({ expiresAt: twoHoursAgo })
          .where(eq(oauthAccessToken.refreshId, spent.id));
        await runPartnerOAuthSweep();
        expect(await db.$count(oauthRefreshToken, eq(oauthRefreshToken.id, spent.id))).toBe(0);
        expect(await db.$count(oauthRefreshAncestors, eq(oauthRefreshAncestors.tokenHash, spent.token))).toBe(1);

        expect(await refresh(app, connection.tokens.refresh_token)).toMatchObject({
          ok: false,
          error: 'invalid_grant',
        });
        expect(await refresh(app, rotated.tokens.refresh_token)).toMatchObject({ ok: false, error: 'invalid_grant' });
        expect((await callMe(app, rotated.tokens.access_token)).status).toBe(401);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'sweeps an unanswered consent screen and an unredeemed code, and the link then answers nothing',
      async () => {
        const app = await registerApp();
        const climber = await newClimber();
        const unanswered = await openAuthorize((await startAuthorization(app)).url, climber);
        const authorization = await startAuthorization(app);
        const { location } = await openAuthorize(authorization.url, climber);
        const approved = await approve(location, climber);
        expect(approved.reply.status).toBe(200);
        const connection = await connectionRow({ app, climber });
        const [grant] = await db.select().from(oauthGrants).where(eq(oauthGrants.connectionId, connection.id));

        await db
          .update(oauthConsentInteractions)
          .set({ expiresAt: new Date(Date.now() - 2 * HOUR_MS) })
          .where(eq(oauthConsentInteractions.userId, climber.userId));
        // Two hours on: the code expired and its grant is past the sweep's one-hour grace.
        await db
          .update(oauthVerification)
          .set({ expiresAt: new Date(Date.now() - 2 * HOUR_MS) })
          .where(eq(oauthVerification.identifier, grant.authorizationCodeId));
        await db
          .update(oauthGrants)
          .set({ createdAt: new Date(Date.now() - 2 * HOUR_MS) })
          .where(eq(oauthGrants.authorizationCodeId, grant.authorizationCodeId));
        await runPartnerOAuthSweep();

        expect(await db.$count(oauthConsentInteractions, eq(oauthConsentInteractions.userId, climber.userId))).toBe(0);
        expect(await db.$count(oauthVerification, eq(oauthVerification.identifier, grant.authorizationCodeId))).toBe(0);
        expect(await db.$count(oauthGrants, eq(oauthGrants.authorizationCodeId, grant.authorizationCodeId))).toBe(0);
        expect((await approve(unanswered.location, climber)).reply.status).toBe(400);
        await expect(redeem(app, authorization, approved.body.url as string)).rejects.toMatchObject({
          error: 'invalid_grant',
        });
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'leaves a live connection alone',
      async () => {
        const app = await registerApp();
        const connection = await connect(app, await newClimber());
        await runPartnerOAuthSweep();
        await expectAlive(connection);
      },
      SUITE_DEADLINE_MS,
    );
  });

  // -------------------------------------------------------------------------
  // F12's admin side.
  // -------------------------------------------------------------------------

  describe('suspend, rotate and delete', () => {
    it(
      'a suspended app gets no tokens, no API and no consent; unsuspending brings the same tokens back',
      async () => {
        const app = await registerApp();
        const connection = await connect(app, await newClimber());
        const climber = await newClimber();
        const openScreen = await openAuthorize((await startAuthorization(app)).url, climber);

        const dryRun = await suspendPartnerApp(db, { clientId: app.clientId, reason: 'Abuse report', apply: false });
        expect(dryRun.applied).toBe(false);
        expect((await callMe(app, connection.tokens.access_token)).status).toBe(200);

        await suspendPartnerApp(db, { clientId: app.clientId, reason: 'Abuse report', apply: true });
        expect(await callMe(app, connection.tokens.access_token)).toEqual({
          status: 401,
          body: { challenge: 'invalid_token' },
        });
        expect((await refresh(app, connection.tokens.refresh_token)).ok).toBe(false);
        const afterSuspension = await openAuthorize((await startAuthorization(app)).url, climber);
        expect(afterSuspension.location.startsWith(CONSENT_PAGE)).toBe(false);
        for (const path of [CONSENT_DETAILS_PATH, CONSENT_PATH]) {
          const refused = await postConsentRoute(path, openScreen.location, climber, { accept: true });
          expect({ path, status: refused.reply.status, error: refused.body.error }).toEqual({
            path,
            status: 403,
            error: 'app_suspended',
          });
        }
        // Suspension is not revocation.
        expect((await connectionRow(connection)).revokedAt).toBeNull();

        await unsuspendPartnerApp(db, { clientId: app.clientId, apply: true });
        await expectAlive(connection);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'a rotated secret works at once, and the old one stops at once',
      async () => {
        const app = await registerApp('confidential-basic');
        const connection = await connect(app, await newClimber());
        const rotated = await server.graphql(
          `mutation Rotate($clientId: ID!) { rotateOAuthClientSecret(clientId: $clientId) { clientSecret } }`,
          { clientId: app.clientId },
          { bearer: await firstPartyToken(app.developerId) },
        );
        expect(rotated.errors).toBeUndefined();
        const credentials = rotated.data?.rotateOAuthClientSecret as { clientSecret: string } | undefined;
        if (!credentials) throw new Error('Rotation returned no secret.');
        const newSecret = credentials.clientSecret;
        remember(newSecret);
        expect(await refresh(app, connection.tokens.refresh_token)).toMatchObject({
          ok: false,
          error: 'invalid_client',
        });
        const withNewSecret = { ...app, auth: oauth.ClientSecretBasic(newSecret) };
        await expectAlive({ ...connection, app: withNewSecret });
      },
      SUITE_DEADLINE_MS,
    );

    it(
      "deleting an app ends every connection to it and nobody else's",
      async () => {
        const app = await registerApp();
        const otherApp = await registerApp();
        const climber = await newClimber();
        const doomed = await connect(app, climber);
        const kept = await connect(otherApp, climber);
        const deleted = await server.graphql(
          `mutation Delete($clientId: ID!) { deleteOAuthClient(clientId: $clientId) }`,
          { clientId: app.clientId },
          { bearer: await firstPartyToken(app.developerId) },
        );
        expect(deleted.data).toEqual({ deleteOAuthClient: true });
        expect(await callMe(app, doomed.tokens.access_token)).toEqual({
          status: 401,
          body: { challenge: 'invalid_token' },
        });
        expect((await refresh(app, doomed.tokens.refresh_token)).ok).toBe(false);
        expect(await connectionRow(doomed)).toBeUndefined();
        await expectAlive(kept);
      },
      SUITE_DEADLINE_MS,
    );
  });

  // -------------------------------------------------------------------------
  // The mode switch: what a stage change does to apps already connected.
  // -------------------------------------------------------------------------

  describe('switching modes', () => {
    /** Another deployment beside the main one, then back to the main one's settings. */
    async function withDeployment(mode: string, work: (other: RunningServer) => Promise<void>): Promise<void> {
      const other = await startRealServer({ ...MAIN_DEPLOYMENT, PARTNER_OAUTH_MODE: mode });
      try {
        await work(other);
      } finally {
        await other.stop();
        await useDeployment(MAIN_DEPLOYMENT);
      }
    }

    it(
      'hold pauses connected apps with 503 and Retry-After, off hides everything, and neither disconnects anyone',
      async () => {
        const app = await registerApp();
        const connection = await connect(app, await newClimber());

        await withDeployment('hold', async (held) => {
          const me = await held.send('GET', ME_PATH, {
            headers: { Authorization: `Bearer ${connection.tokens.access_token}` },
          });
          expect([me.status, me.headers['retry-after']]).toEqual([503, '60']);
          expect(await refresh(app, connection.tokens.refresh_token, held)).toMatchObject({ ok: false, status: 503 });
          const disconnect = await disconnectByApp(app, connection.tokens.access_token, held);
          expect([disconnect.status, disconnect.headers['retry-after']]).toEqual([503, '60']);
          await expectFirstPartyUnaffected(held);
        });
        await withDeployment('off', async (hidden) => {
          const me = await hidden.send('GET', ME_PATH, {
            headers: { Authorization: `Bearer ${connection.tokens.access_token}` },
          });
          expect(me.status).toBe(404);
          expect((await disconnectByApp(app, connection.tokens.access_token, hidden)).status).toBe(404);
          await expectFirstPartyUnaffected(hidden);
        });
        expect((await connectionRow(connection)).revokedAt).toBeNull();
        await expectAlive(connection);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'open serves the same flow, and still registers only allowlisted developers',
      async () => {
        const app = await registerApp();
        await withDeployment('open', async (opened) => {
          const climber = await newClimber();
          const authorization = await startAuthorization(app);
          const tokens = await redeem(app, authorization, await callbackFor(authorization, climber, opened), opened);
          expect((await callMe(app, tokens.access_token, opened)).status).toBe(200);

          const outsider = await createAccount('outsider');
          const refused = await opened.graphql(
            REGISTER_MUTATION,
            {
              input: {
                name: 'Outside Planner',
                publisherName: 'Crimp Labs',
                privacyPolicyUrl: 'https://outside.example.test/privacy',
                applicationType: 'WEB',
                tokenEndpointAuthMethod: 'NONE',
                redirectUris: ['https://outside.example.test/cb'],
                acceptedTermsVersion: LAUNCH_TERMS_VERSION,
              },
            },
            { bearer: await firstPartyToken(outsider) },
          );
          expect(refused.errors?.[0]?.extensions).toMatchObject({ code: 'FORBIDDEN', reason: 'NOT_ALLOWLISTED' });
        });
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'with the web still off and the backend on, consent fails closed and signing in again does not help',
      async () => {
        const app = await registerApp();
        const userId = await createAccount('mismatch');
        const ip = freshClientIp();
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const cookie = await signInOnWeb(userId, { webMode: 'off' });
          const authorization = await startAuthorization(app);
          const { location } = await openAuthorize(authorization.url, { ip, cookie });
          expect(location.startsWith(`${SIGN_IN_PAGE}?`)).toBe(true);
        }
        // Turned on in the documented order, web first: the next sign-in counts.
        const climber: Climber = { userId, ip, cookie: await signInOnWeb(userId, { webMode: 'allowlist' }) };
        await expectAlive(await connect(app, climber));
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'a sign-in made while only the web was on counts as soon as the backend turns on',
      async () => {
        const app = await registerApp();
        const climber = await newClimber('early', 'allowlist');
        await withDeployment('off', async (hidden) => {
          const authorization = await startAuthorization(app);
          expect((await openAuthorize(authorization.url, climber, hidden)).reply.status).toBe(404);
        });
        await expectAlive(await connect(app, climber));
      },
      SUITE_DEADLINE_MS,
    );
  });

  // -------------------------------------------------------------------------
  // Two instances: a second copy of the whole backend, loaded fresh, with its
  // own authority, pools, admission gates and Redis clients, on the same
  // Postgres and Redis. Last, because loading it replaces this file's modules.
  // -------------------------------------------------------------------------

  describe('two instances', () => {
    let second: RunningServer;
    let closeSecond: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      vi.resetModules();
      const secondLogger = (await import('../utils/logger')).logger;
      secondLogger.on('data', captureLogEntry);
      second = await startRealServer(MAIN_DEPLOYMENT);
      const { getPartnerAuthorityRuntime } = await import('../auth/partner/authority');
      const secondRedis = (await import('../redis/client')).redisClientManager;
      const { closePool } = await import('@boardsesh/db/client');
      closeSecond = async () => {
        await second.stop();
        await second.shutdownProcessServices();
        await (await getPartnerAuthorityRuntime()).close();
        await secondRedis.disconnect().catch(() => undefined);
        await closePool();
        secondLogger.off('data', captureLogEntry);
      };
    }, SUITE_DEADLINE_MS);

    afterAll(async () => {
      await closeSecond?.();
    });

    it(
      'redeems on one a code the other issued, and closes a family on one that the other rotated',
      async () => {
        const app = await registerApp();
        const climber = await newClimber();
        const authorization = await startAuthorization(app);
        const tokens = await redeem(app, authorization, await callbackFor(authorization, climber, server), second);
        const connection: Connection = {
          app,
          climber,
          tokens: { ...tokens, refresh_token: tokens.refresh_token ?? '' },
        };
        expect((await callMe(app, tokens.access_token, server)).status).toBe(200);

        const rotated = await refresh(app, connection.tokens.refresh_token, second);
        if (!rotated.ok) throw new Error('The rotation failed.');
        expect(await refresh(app, connection.tokens.refresh_token, server)).toMatchObject({
          ok: false,
          error: 'invalid_grant',
        });
        expect(await refresh(app, rotated.tokens.refresh_token, second)).toMatchObject({
          ok: false,
          error: 'invalid_grant',
        });
        expect((await callMe(app, rotated.tokens.access_token, second)).status).toBe(401);
      },
      SUITE_DEADLINE_MS,
    );

    /** The token endpoint's answer to a code, kept as status and error instead of thrown. */
    async function redeemOutcome(
      app: PartnerApp,
      authorization: Authorization,
      callback: string,
      target: RunningServer,
    ) {
      try {
        const tokens = await redeem(app, authorization, callback, target);
        return { ok: true as const, tokens };
      } catch (error) {
        if (error instanceof oauth.ResponseBodyError) return { ok: false as const, error: error.error };
        throw error;
      }
    }

    it(
      'gives one token set when the same code reaches both at once, and leaves the other family alone',
      async () => {
        const app = await registerApp();
        const climber = await newClimber();
        const tablet = await connect(app, climber);
        const authorization = await startAuthorization(app);
        const callback = await callbackFor(authorization, climber);
        const outcomes = await releaseTogether(climber.userId, () => [
          redeemOutcome(app, authorization, callback, server),
          redeemOutcome(app, authorization, callback, second),
        ]);
        expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
        expect(outcomes.find((outcome) => !outcome.ok)).toMatchObject({ error: 'invalid_grant' });
        await expectAlive(tablet);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'gives one successor when the same refresh token reaches both at once, and the other family lives',
      async () => {
        const app = await registerApp();
        const climber = await newClimber();
        const phone = await connect(app, climber);
        const tablet = await connect(app, climber);
        const outcomes = await releaseTogether(climber.userId, () => [
          refresh(app, phone.tokens.refresh_token, server),
          refresh(app, phone.tokens.refresh_token, second),
        ]);
        const winners = outcomes.filter((outcome) => outcome.ok);
        expect(winners).toHaveLength(1);
        expect(outcomes.find((outcome) => !outcome.ok)).toMatchObject({ error: 'invalid_grant' });
        // The loser presented a spent token, so the winner's family is closed too: at most one usable successor.
        const [winner] = winners;
        if (!winner?.ok) throw new Error('unreachable');
        expect((await refresh(app, winner.tokens.refresh_token, server)).ok).toBe(false);
        expect((await callMe(app, winner.tokens.access_token, second)).status).toBe(401);
        // Only that family: the other device on the same connection carries on.
        await expectAlive(tablet);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'leaves nothing usable when a refresh on one races a Disconnect on the other',
      async () => {
        const app = await registerApp();
        const climber = await newClimber();
        const connection = await connect(app, climber);
        const [refreshed, disconnected] = await releaseTogether(climber.userId, () => [
          refresh(app, connection.tokens.refresh_token, server),
          disconnectByApp(app, connection.tokens.access_token, second),
        ]);
        expect(disconnected.status).toBe(204);
        // Whichever won the connection lock, nothing issued before or during the Disconnect works after it.
        if (refreshed.ok) {
          expect((await callMe(app, refreshed.tokens.access_token, second)).status).toBe(401);
          expect((await refresh(app, refreshed.tokens.refresh_token, second)).ok).toBe(false);
        } else {
          expect(refreshed).toMatchObject({ error: 'invalid_grant' });
        }
        await expectEnded(connection);
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'reconnects on one while the other is handed the old refresh token: the new generation works, the old stays dead',
      async () => {
        const app = await registerApp();
        const climber = await newClimber();
        const old = await connect(app, climber);
        expect((await disconnectByApp(app, old.tokens.access_token)).status).toBe(204);
        const again = await startAuthorization(app);
        const callback = await callbackFor(again, climber);
        // The old token was deleted with its connection, so it is refused before any lock: no gun here.
        const [fresh, stale] = await Promise.all([
          redeemOutcome(app, again, callback, server),
          refresh(app, old.tokens.refresh_token, second),
        ]);
        expect(stale).toMatchObject({ ok: false, error: 'invalid_grant' });
        if (!fresh.ok) throw new Error(`The reconnect failed: ${fresh.error}`);
        expect((await callMe(app, fresh.tokens.access_token, second)).status).toBe(200);
        expect((await callMe(app, old.tokens.access_token, second)).status).toBe(401);
        const row = await connectionRow(old);
        expect({ revokedAt: row.revokedAt, generation: row.generation }).toEqual({ revokedAt: null, generation: 1 });
      },
      SUITE_DEADLINE_MS,
    );

    it(
      'ends access on one the moment the other disconnects: no instance caches a token as good',
      async () => {
        const app = await registerApp();
        const connection = await connect(app, await newClimber());
        expect((await callMe(app, connection.tokens.access_token, server)).status).toBe(200);
        expect((await callMe(app, connection.tokens.access_token, second)).status).toBe(200);
        expect((await disconnectByApp(app, connection.tokens.access_token, second)).status).toBe(204);
        expect(await callMe(app, connection.tokens.access_token, server)).toEqual({
          status: 401,
          body: { challenge: 'invalid_token' },
        });
      },
      SUITE_DEADLINE_MS,
    );
  });

  // -------------------------------------------------------------------------
  // Gate 7's log half: everything above went through the real logger.
  // -------------------------------------------------------------------------

  describe('the logs', () => {
    it('carry no code, token, client secret or session cookie from anything this file did', () => {
      expect(credentialsSeen.size).toBeGreaterThan(100);
      expect(logLines.length).toBeGreaterThan(100);
      // The routes do log: each request leaves a line with its id, route and status.
      expect(logLines.some((line) => line.includes('Partner OAuth request'))).toBe(true);
      const leaks = [...credentialsSeen].filter((credential) => logLines.some((line) => line.includes(credential)));
      expect(leaks).toEqual([]);
      // And no line carries an Authorization header, or a Basic or Bearer credential,
      // even one this file never saw whole (a truncated or re-encoded one).
      const headerLines = logLines.filter(
        (line) =>
          /\bauthorization\b["']?\s*[:=]/i.test(line) || /\b(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/.test(line),
      );
      expect(headerLines).toEqual([]);
    });
  });
});
