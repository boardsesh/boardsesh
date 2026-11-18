/**
 * #7596 B6 in the real server: partner OAuth consent at api.boardsesh.com reads
 * the first-party session cookies (login, then bridged) before the legacy
 * NextAuth cookie, but only while CURRENT_STORE_WEB_SESSION_MODE is on. A
 * browser names the same partner session before and after it is bridged, so
 * nobody consents again at cutover.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as oauth from 'oauth4webapi';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { browserSessionCookieName, signBrowserSessionCookie } from '@boardsesh/auth-protocol/browser-session-cookie';
import { authSession, oauthSession } from '@boardsesh/db/schema/auth';
import { db } from '../db/client';
import { redisClientManager } from '../redis/client';
import { bridgeLegacyCredential } from '../auth/authority/bridge';
import { denyFirstPartySession } from '../auth/authority/lineage';
import { selectLiveSessions } from '../auth/authority/browser-access-token';
import { bridgeTokenKey, sessionTokenDigest } from '../auth/authority/session-token';
import { startFakePosthogFlags, type FakePosthogFlags } from './helpers/fake-posthog-flags';
import {
  CONSENT_PAGE,
  createAccount,
  firstPartyToken,
  freshClientIp,
  ISSUER,
  LAUNCH_TERMS_VERSION,
  nowSeconds,
  PARTNER_SECRET,
  REGISTER_MUTATION,
  RESOURCE,
  SIGN_IN_PAGE,
  signInOnWeb,
  startRealServer,
  WEB_ORIGIN,
  type RunningServer,
} from './helpers/partner-launch-harness';

const DEADLINE_MS = 60_000;
const COOKIE_SECRET = 'synthetic-first-party-cookie-secret-for-consent';
const BRIDGE_KEY = bridgeTokenKey('synthetic-consent-suite-bridge-token-secret');
const LOGIN_NAME = browserSessionCookieName('login', true);
const BRIDGED_NAME = browserSessionCookieName('bridged', true);

let posthog: FakePosthogFlags;
let server: RunningServer;
let metadata: oauth.AuthorizationServer;
let app: { clientId: string; redirectUri: string };

const MODE_ON = {
  CURRENT_STORE_WEB_SESSION_MODE: 'backend-staging',
  AUTH_BROWSER_SESSION_COOKIE_SECRET: COOKIE_SECRET,
};

beforeAll(async () => {
  await redisClientManager.connect();
  posthog = await startFakePosthogFlags();
  server = await startRealServer({
    ...posthog.environment,
    PARTNER_OAUTH_MODE: 'allowlist',
    PARTNER_OAUTH_SECRETS: PARTNER_SECRET,
    PARTNER_DEVELOPER_TERMS_VERSION: LAUNCH_TERMS_VERSION,
    ...MODE_ON,
  });
  const ip = freshClientIp();
  metadata = await oauth.processDiscoveryResponse(
    ISSUER,
    await oauth.discoveryRequest(ISSUER, { algorithm: 'oauth2', [oauth.customFetch]: server.fetchFor(ip) }),
  );
  const developerId = await createAccount('consent-developer');
  posthog.invite(developerId);
  const reply = await server.graphql(
    REGISTER_MUTATION,
    {
      input: {
        name: 'Crimp Planner',
        publisherName: 'Crimp Labs',
        homepageUrl: 'https://consent-app.example.test/',
        privacyPolicyUrl: 'https://consent-app.example.test/privacy',
        applicationType: 'WEB',
        tokenEndpointAuthMethod: 'CLIENT_SECRET_BASIC',
        redirectUris: ['https://consent-app.example.test/oauth/boardsesh'],
        acceptedTermsVersion: LAUNCH_TERMS_VERSION,
      },
    },
    { bearer: await firstPartyToken(developerId) },
  );
  expect(reply.errors).toBeUndefined();
  const created = reply.data?.createOAuthClient as { client: { clientId: string; redirectUris: string[] } };
  app = { clientId: created.client.clientId, redirectUri: created.client.redirectUris[0] };
}, DEADLINE_MS);

beforeEach(() => {
  for (const [name, value] of Object.entries(MODE_ON)) vi.stubEnv(name, value);
});

afterAll(async () => {
  await server?.stop();
  await server?.shutdownProcessServices();
  await posthog?.close();
  const { getPartnerAuthorityRuntime } = await import('../auth/partner/authority');
  await getPartnerAuthorityRuntime().then(
    (runtime) => runtime.close(),
    () => undefined,
  );
  await redisClientManager.disconnect();
});

async function authorizeUrl(): Promise<URL> {
  const url = new URL(metadata.authorization_endpoint ?? '');
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    scope: 'profile:read',
    state: oauth.generateRandomState(),
    code_challenge: await oauth.calculatePKCECodeChallenge(oauth.generateRandomCodeVerifier()),
    code_challenge_method: 'S256',
    resource: RESOURCE,
  }).toString();
  return url;
}

/** Where authorize sends this browser: `consent`, `sign-in`, `app` (remembered consent), or the status. */
async function authorize(cookies: string[], url?: URL): Promise<{ landing: string; location: string; status: number }> {
  const target = url ?? (await authorizeUrl());
  const reply = await server.send('GET', `${target.pathname}${target.search}`, {
    clientIp: freshClientIp(),
    headers: cookies.length ? { Cookie: cookies.join('; ') } : {},
  });
  expect(reply.headers['set-cookie']).toBeUndefined();
  const location = reply.headers.location ?? '';
  // A consent already given is remembered: authorize then goes straight to the app.
  const landing = location.startsWith(`${CONSENT_PAGE}?`)
    ? 'consent'
    : location.startsWith(`${SIGN_IN_PAGE}?`)
      ? 'sign-in'
      : location.startsWith(`${app.redirectUri}?`)
        ? 'app'
        : String(reply.status);
  return { landing, location, status: reply.status };
}

async function approve(consentLink: string, cookies: string[]) {
  const reply = await server.send('POST', '/api/auth/oauth2/consent', {
    clientIp: freshClientIp(),
    headers: { 'Content-Type': 'application/json', Cookie: cookies.join('; '), Origin: WEB_ORIGIN },
    body: JSON.stringify({ oauth_query: new URL(consentLink).search.slice(1), accept: true }),
  });
  return { status: reply.status, body: (reply.body ? JSON.parse(reply.body) : {}) as Record<string, unknown> };
}

/** A login row as `issueWebSession` writes it, and the signed login cookie that carries its token. */
async function loginSession(userId: string, signedInAgoMs = 60_000) {
  const token = randomBytes(32).toString('base64url');
  const sessionId = randomUUID();
  await db.insert(authSession).values({
    id: sessionId,
    token: sessionTokenDigest(token),
    userId,
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
    createdAt: new Date(Date.now() - signedInAgoMs),
    updatedAt: new Date(),
    originalAuthenticatedAt: new Date(Date.now() - signedInAgoMs),
    revocationGeneration: 0,
  });
  return { sessionId, token, cookie: `${LOGIN_NAME}=${signBrowserSessionCookie('login', token, COOKIE_SECRET)}` };
}

const legacyValue = (cookie: string) => cookie.slice(cookie.indexOf('=') + 1);
const partnerSessions = async (userId: string) =>
  (await db.select({ id: oauthSession.id }).from(oauthSession).where(eq(oauthSession.userId, userId))).map(
    (row) => row.id,
  );
const partnerSessionId = (userId: string, authSessionId: string, authTimeSeconds: number) =>
  `nextauth_${createHash('sha256')
    .update(JSON.stringify(['partner-session-v1', userId, authSessionId, authTimeSeconds]))
    .digest('hex')}`;

describe('consent with the web session mode on', () => {
  it(
    'lets a login session consent, under its own id and sign-in time',
    async () => {
      const userId = await createAccount('login-consent');
      const login = await loginSession(userId);
      const opened = await authorize([login.cookie]);
      expect(opened.landing).toBe('consent');
      const approved = await approve(opened.location, [login.cookie]);
      expect(approved.status).toBe(200);
      expect(String(approved.body.url)).toContain('code=');
      const [row] = await db.select().from(authSession).where(eq(authSession.id, login.sessionId));
      expect(await partnerSessions(userId)).toEqual([
        partnerSessionId(userId, login.sessionId, Math.floor((row.originalAuthenticatedAt?.getTime() ?? 0) / 1000)),
      ]);
    },
    DEADLINE_MS,
  );

  it(
    'names the same partner session for a browser before and after it is bridged',
    async () => {
      const userId = await createAccount('bridge-consent');
      const legacy = await signInOnWeb(userId, { webMode: 'allowlist' });
      const before = await authorize([legacy]);
      expect(before.landing).toBe('consent');
      const identity = await partnerSessions(userId);
      expect(identity).toHaveLength(1);
      const bridged = await bridgeLegacyCredential(
        db,
        legacyValue(legacy),
        process.env.NEXTAUTH_SECRET ?? '',
        BRIDGE_KEY,
        'on',
      );
      if (bridged.status !== 'bridged') throw new Error(`Bridge answered ${bridged.status}`);
      const bridgedCookie = `${BRIDGED_NAME}=${signBrowserSessionCookie('bridged', bridged.token, COOKIE_SECRET)}`;
      // The link the legacy cookie opened is answered by the bridged cookie, as the same login.
      expect((await approve(before.location, [bridgedCookie])).status).toBe(200);
      // Signed in as the same climber: the consent just given is remembered.
      expect((await authorize([bridgedCookie])).landing).toBe('app');
      // The rollback window keeps the legacy cookie beside the bridged one; still one session.
      expect((await authorize([bridgedCookie, legacy])).landing).toBe('app');
      expect(await partnerSessions(userId)).toEqual(identity);
    },
    DEADLINE_MS,
  );

  it(
    'is signed out by an ended first-party session, whatever older legacy cookie is still there',
    async () => {
      const userId = await createAccount('ended-consent');
      const olderLegacy = await signInOnWeb(userId, { webMode: 'allowlist', authTime: nowSeconds() - 3600 });
      expect((await authorize([olderLegacy])).landing).toBe('consent');
      const login = await loginSession(userId);
      const live = (await selectLiveSessions(db, [login.sessionId], new Date())).get(login.sessionId);
      if (!live) throw new Error('Synthetic session not live');
      await denyFirstPartySession(db, live);
      expect((await authorize([login.cookie, olderLegacy])).landing).toBe('sign-in');
    },
    DEADLINE_MS,
  );

  it(
    'uses a legacy cookie that is a newer login than the first-party session, as www does',
    async () => {
      const userId = await createAccount('stale-consent');
      const login = await loginSession(userId, 10 * 60_000);
      const newerAuthTime = nowSeconds() - 30;
      const newerLegacy = await signInOnWeb(userId, { webMode: 'allowlist', authTime: newerAuthTime });
      expect((await authorize([login.cookie, newerLegacy])).landing).toBe('consent');
      const [only] = await partnerSessions(userId);
      // The partner session is the legacy login's, not the stale login cookie's.
      const [row] = await db.select().from(authSession).where(eq(authSession.id, login.sessionId));
      const staleIdentity = partnerSessionId(
        userId,
        login.sessionId,
        Math.floor((row.originalAuthenticatedAt?.getTime() ?? 0) / 1000),
      );
      expect(only).not.toBe(staleIdentity);
      expect(only).toMatch(/^nextauth_[0-9a-f]{64}$/);
    },
    DEADLINE_MS,
  );

  it(
    'still lets a browser with only the legacy cookie consent',
    async () => {
      const userId = await createAccount('legacy-consent');
      const legacy = await signInOnWeb(userId, { webMode: 'allowlist' });
      const opened = await authorize([legacy]);
      expect(opened.landing).toBe('consent');
      expect((await approve(opened.location, [legacy])).status).toBe(200);
    },
    DEADLINE_MS,
  );

  it(
    'reads a conflicted login cookie as signed out, never falling back to the bridged one',
    async () => {
      const userId = await createAccount('conflict-consent');
      const [first, second] = [await loginSession(userId), await loginSession(userId)];
      const legacy = await signInOnWeb(userId, { webMode: 'allowlist' });
      const bridged = await bridgeLegacyCredential(
        db,
        legacyValue(legacy),
        process.env.NEXTAUTH_SECRET ?? '',
        BRIDGE_KEY,
        'on',
      );
      if (bridged.status !== 'bridged') throw new Error('Bridge refused');
      const bridgedCookie = `${BRIDGED_NAME}=${signBrowserSessionCookie('bridged', bridged.token, COOKIE_SECRET)}`;
      expect((await authorize([bridgedCookie])).landing).toBe('consent');
      expect((await authorize([first.cookie, second.cookie, bridgedCookie, legacy])).landing).toBe('sign-in');
    },
    DEADLINE_MS,
  );

  it(
    'does not accept a login value under the bridged name',
    async () => {
      const userId = await createAccount('swap-consent');
      const login = await loginSession(userId);
      const swapped = `${BRIDGED_NAME}=${signBrowserSessionCookie('login', login.token, COOKIE_SECRET)}`;
      expect((await authorize([swapped])).landing).toBe('sign-in');
      expect((await authorize([login.cookie])).landing).toBe('consent');
    },
    DEADLINE_MS,
  );

  it(
    'answers 503, not signed out, when the cookie secret is unusable',
    async () => {
      const userId = await createAccount('secret-consent');
      const login = await loginSession(userId);
      for (const secret of ['', 'short', process.env.NEXTAUTH_SECRET ?? '']) {
        vi.stubEnv('AUTH_BROWSER_SESSION_COOKIE_SECRET', secret);
        expect((await authorize([login.cookie])).status, secret.length ? 'weak or reused' : 'unset').toBe(503);
      }
    },
    DEADLINE_MS,
  );
});

describe('consent with the web session mode off', () => {
  it(
    'ignores first-party cookies entirely and reads the legacy cookie as before',
    async () => {
      const userId = await createAccount('mode-off-consent');
      const login = await loginSession(userId);
      const legacy = await signInOnWeb(userId, { webMode: 'allowlist' });
      for (const mode of ['legacy', '', 'not-a-mode']) {
        vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', mode);
        // Even an unusable cookie secret changes nothing while the mode is off.
        vi.stubEnv('AUTH_BROWSER_SESSION_COOKIE_SECRET', '');
        const url = await authorizeUrl();
        const withFirstParty = await authorize([login.cookie], url);
        const withNothing = await authorize([], url);
        expect({ ...withFirstParty, location: new URL(withFirstParty.location).pathname }).toEqual({
          ...withNothing,
          location: new URL(withNothing.location).pathname,
        });
        expect(withNothing.landing).toBe('sign-in');
        expect((await authorize([login.cookie, legacy])).landing).toBe('consent');
      }
      expect(await partnerSessions(userId)).toHaveLength(1);
    },
    DEADLINE_MS,
  );
});
