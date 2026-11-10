import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { and, eq, sql } from 'drizzle-orm';
import { createAuthMiddleware } from 'better-auth/api';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  oauthConnections,
  oauthConsent,
  oauthConsentInteractions,
  oauthGrants,
  oauthRefreshToken,
  oauthSession,
  userCredentials,
  userProfiles,
  users,
} from '@boardsesh/db/schema/auth';
import { db } from '../../../db/client';
import { describeConsentScopes } from '../consent';
import { disconnectPartnerConnection } from '../connection';
import { PARTNER_SCOPES } from '../configuration';
import {
  createPartnerTestEnvironment,
  READ_ONLY_PROOF_APPLICATION_NAME,
  TEST_CONFIGURATION,
  TEST_ISSUER,
  TEST_OAUTH_OPTIONS,
  TEST_RESOURCE,
  type PartnerTestEnvironment,
  type RequestHandlerInstance,
  type TestClient,
} from './partner-fixture';

const TEST_DEADLINE_MS = 20_000;
const DAY_SECONDS = 24 * 60 * 60;
const LOGIN_PAGE = `${TEST_CONFIGURATION.webOrigin}/oauth/sign-in`;

// The installed NextAuth encoder writes these cookies, as www does in production.
const webRequire = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const { encode: encodeNextAuthSession } = webRequire('next-auth/jwt') as {
  encode(this: void, options: { token: Record<string, unknown>; secret: string; maxAge?: number }): Promise<string>;
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

interface WebClimber {
  userId: string;
  authSessionId: string;
  /** A `Cookie` header carrying this climber's www session. */
  cookie: string;
}

interface SignIn {
  /** The `auth_time` claim; null leaves it out, as on a cookie from before the claim. Defaults to an hour ago. */
  authTime?: unknown;
  /** Null leaves the login id out. Defaults to a new login. */
  authSessionId?: string | null;
}

async function signInAs(userId: string, { authTime = nowSeconds() - 3600, authSessionId }: SignIn = {}) {
  const login = authSessionId === undefined ? randomUUID() : authSessionId;
  const credential = await encodeNextAuthSession({
    token: {
      sub: userId,
      ...(login === null ? {} : { authSessionId: login }),
      ...(authTime === null ? {} : { auth_time: authTime }),
    },
    secret: TEST_CONFIGURATION.nextAuthSecret,
    maxAge: 30 * DAY_SECONDS,
  });
  return { userId, authSessionId: login ?? '', cookie: `next-auth.session-token=${credential}` };
}

async function webClimber(signIn: SignIn = {}): Promise<WebClimber> {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, email: `${userId}@example.invalid` });
  return signInAs(userId, signIn);
}

/** Better Auth's own signed session cookie, as `better-call` would sign it. */
function signedBetterAuthCookie(token: string): string {
  const signature = createHmac('sha256', TEST_CONFIGURATION.secrets[0].value).update(token).digest('base64');
  const value = encodeURIComponent(`${token}.${signature}`);
  return `__Secure-better-auth.session_token=${value}; better-auth.session_token=${value}`;
}

interface Authorization {
  response: Response;
  location: string;
  verifier: string;
  /** The signed query of the consent page, which the www page posts back. */
  oauthQuery: string;
}

async function authorize(
  target: RequestHandlerInstance,
  client: TestClient,
  cookie: string | null,
  extra: Record<string, string> = {},
): Promise<Authorization> {
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL(`${TEST_ISSUER}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    scope: 'profile:read offline_access',
    state: randomUUID(),
    resource: TEST_RESOURCE,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...extra,
  }).toString();
  const response = await target.handler(new Request(url, { headers: cookie ? { cookie } : {} }));
  const location = response.headers.get('location') ?? '';
  return { response, location, verifier, oauthQuery: URL.canParse(location) ? new URL(location).search.slice(1) : '' };
}

interface JsonResponse {
  response: Response;
  body: Record<string, unknown>;
}

async function postJson(
  target: RequestHandlerInstance,
  path: string,
  cookie: string | null,
  body: Record<string, unknown>,
  origin: string | null = TEST_CONFIGURATION.webOrigin,
  extraHeaders: Record<string, string> = {},
): Promise<JsonResponse> {
  const response = await target.handler(
    new Request(`${TEST_ISSUER}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(origin ? { origin } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  return { response, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

async function interactionFor(oauthQuery: string) {
  const signature = new URLSearchParams(oauthQuery).get('sig') ?? '';
  const digest = createHash('sha256').update(`partner-consent-interaction-v1:${signature}`).digest('hex');
  const [interaction] = await db
    .select()
    .from(oauthConsentInteractions)
    .where(eq(oauthConsentInteractions.digest, digest));
  return interaction;
}

async function connectionOf(climber: { userId: string }, client: TestClient) {
  const [connection] = await db
    .select()
    .from(oauthConnections)
    .where(and(eq(oauthConnections.userId, climber.userId), eq(oauthConnections.clientId, client.clientId)));
  return connection;
}

async function grantsOf(climber: { userId: string }, client: TestClient) {
  const connection = await connectionOf(climber, client);
  if (!connection) return [];
  return db.select().from(oauthGrants).where(eq(oauthGrants.connectionId, connection.id));
}

function codeIn(url: unknown): string | null {
  return typeof url === 'string' && URL.canParse(url) ? new URL(url).searchParams.get('code') : null;
}

describe('partner consent', () => {
  let environment: PartnerTestEnvironment;
  let instance: RequestHandlerInstance;

  beforeAll(async () => {
    environment = await createPartnerTestEnvironment();
    instance = environment.instance;
  });

  afterAll(async () => {
    await environment?.close();
  });

  const consentClient = (options: Parameters<PartnerTestEnvironment['createClient']>[0] = {}) =>
    environment.createClient({ skipConsent: false, ...options });

  async function approve(climber: WebClimber, client: TestClient, target = instance) {
    const authorization = await authorize(target, client, climber.cookie);
    expect(authorization.location.startsWith(TEST_OAUTH_OPTIONS.consentPage)).toBe(true);
    const approved = await postJson(target, '/oauth2/consent', climber.cookie, {
      accept: true,
      oauth_query: authorization.oauthQuery,
    });
    return { authorization, approved };
  }

  describe('the session bridge', () => {
    it('turns a recent www sign-in into a partner session, without setting a cookie', async () => {
      const client = await consentClient();
      const authTime = nowSeconds() - 3600;
      const climber = await webClimber({ authTime });
      const authorization = await authorize(instance, client, climber.cookie);

      expect(authorization.response.status).toBe(302);
      expect(authorization.location.startsWith(`${TEST_OAUTH_OPTIONS.consentPage}?`)).toBe(true);
      expect(authorization.response.headers.getSetCookie()).toEqual([]);
      const [session] = await db.select().from(oauthSession).where(eq(oauthSession.userId, climber.userId));
      expect(session.id).toMatch(/^nextauth_[a-f0-9]{64}$/);
      // The provider takes a code's auth time, and max_age, from this.
      expect(session.createdAt).toEqual(new Date(authTime * 1000));
      expect(await interactionFor(authorization.oauthQuery)).toMatchObject({
        userId: climber.userId,
        authSessionId: session.id,
        clientId: client.clientId,
        connectionGeneration: 0,
        consumedAt: null,
      });
    });

    it.each([
      ['from before the auth_time claim', { authTime: null }],
      ['signed in 30 days ago', { authTime: nowSeconds() - 30 * DAY_SECONDS }],
      ['signed in 40 days ago', { authTime: nowSeconds() - 40 * DAY_SECONDS }],
      ['with a fractional sign-in time', { authTime: nowSeconds() - 0.5 }],
      ['with a sign-in time in the future', { authTime: nowSeconds() + 3600 }],
      ['with a sign-in time that is a string', { authTime: String(nowSeconds()) }],
      ['with a non-positive sign-in time', { authTime: -1 }],
      ['without a login id', { authSessionId: null }],
    ] satisfies [string, SignIn][])('sends a session %s to sign in, and creates nothing', async (_label, signIn) => {
      const client = await consentClient();
      const climber = await webClimber(signIn);
      const authorization = await authorize(instance, client, climber.cookie);

      expect(authorization.location.startsWith(`${LOGIN_PAGE}?`)).toBe(true);
      expect(await db.select().from(oauthSession).where(eq(oauthSession.userId, climber.userId))).toEqual([]);
      expect(
        await db.select().from(oauthConsentInteractions).where(eq(oauthConsentInteractions.userId, climber.userId)),
      ).toEqual([]);
    });

    it('sends a sign-in from before the last password change to sign in, then accepts one a minute after it', async () => {
      const client = await consentClient();
      const climber = await webClimber({ authTime: nowSeconds() - 3600 });
      const changedAt = new Date((nowSeconds() - 120) * 1000);
      await db.insert(userCredentials).values({ userId: climber.userId, passwordHash: 'x', updatedAt: changedAt });
      expect((await authorize(instance, client, climber.cookie)).location.startsWith(`${LOGIN_PAGE}?`)).toBe(true);

      // Inside the clock tolerance: the web server's clock could be ahead of the database's.
      const tooSoon = await signInAs(climber.userId, { authTime: nowSeconds() - 61 });
      expect((await authorize(instance, client, tooSoon.cookie)).location.startsWith(`${LOGIN_PAGE}?`)).toBe(true);

      const afterIt = await signInAs(climber.userId, { authTime: nowSeconds() - 59 });
      const authorization = await authorize(instance, client, afterIt.cookie);
      expect(authorization.location.startsWith(`${TEST_OAUTH_OPTIONS.consentPage}?`)).toBe(true);
    });

    it('treats a deleted account as signed out, though its cookie still decrypts', async () => {
      const client = await consentClient();
      const climber = await signInAs(randomUUID());
      expect((await authorize(instance, client, climber.cookie)).location.startsWith(`${LOGIN_PAGE}?`)).toBe(true);
    });

    it('never signs anyone in from a Better Auth session cookie, even a correctly signed one', async () => {
      const client = await consentClient();
      const standIn = await environment.createClimber();
      const betterAuthCookie = signedBetterAuthCookie(standIn.sessionToken);
      const staleWebSession = (await webClimber({ authTime: null })).cookie;
      for (const cookie of [betterAuthCookie, `${betterAuthCookie}; ${staleWebSession}`]) {
        expect((await authorize(instance, client, cookie)).location.startsWith(`${LOGIN_PAGE}?`)).toBe(true);
      }
    });

    it('never finds a session by its token, the lookup a Better Auth cookie depends on', async () => {
      const standIn = await environment.createClimber();
      const context = await environment.auth.$context;
      expect(await context.internalAdapter.findSession(standIn.sessionToken)).toBeNull();
      // Sessions are still found by id, which is how a code names its session.
      expect(
        await context.adapter.findOne({ model: 'session', where: [{ field: 'id', value: standIn.sessionId }] }),
      ).toMatchObject({ id: standIn.sessionId });
    });

    it('keeps one session row per login, and a new one for the next login', async () => {
      const client = await consentClient();
      const climber = await webClimber();
      await authorize(instance, client, climber.cookie);
      await authorize(instance, client, climber.cookie);
      expect(await db.select().from(oauthSession).where(eq(oauthSession.userId, climber.userId))).toHaveLength(1);
      await authorize(instance, client, (await signInAs(climber.userId)).cookie);
      expect(await db.select().from(oauthSession).where(eq(oauthSession.userId, climber.userId))).toHaveLength(2);
    });

    it('drops prompt=login, so a recent sign-in is not sent to sign in again', async () => {
      const client = await consentClient();
      const climber = await webClimber();
      const onlyLogin = await authorize(instance, client, climber.cookie, { prompt: 'login' });
      expect(onlyLogin.location.startsWith(`${TEST_OAUTH_OPTIONS.consentPage}?`)).toBe(true);
      expect(new URLSearchParams(onlyLogin.oauthQuery).has('prompt')).toBe(false);
      const withConsent = await authorize(instance, client, climber.cookie, { prompt: 'login consent' });
      expect(new URLSearchParams(withConsent.oauthQuery).get('prompt')).toBe('consent');

      // Signed out, the sign-in page's link carries no prompt=login for it to loop on.
      const signedOut = await authorize(instance, client, null, { prompt: 'login' });
      expect(signedOut.location.startsWith(`${LOGIN_PAGE}?`)).toBe(true);
      expect(new URL(signedOut.location).searchParams.has('prompt')).toBe(false);
    });

    it('records the real sign-in time on the tokens the consent issues', async () => {
      const client = await consentClient();
      const authTime = nowSeconds() - 7200;
      const climber = await webClimber({ authTime });
      const { authorization, approved } = await approve(climber, client);
      const exchanged = await environment.exchange(client, {
        location: approved.body.url as string,
        verifier: authorization.verifier,
      });
      expect(exchanged.response.status).toBe(200);
      const [refreshToken] = await db
        .select()
        .from(oauthRefreshToken)
        .where(eq(oauthRefreshToken.userId, climber.userId));
      expect(refreshToken.authTime).toEqual(new Date(authTime * 1000));
    });
  });

  describe('a consent link', () => {
    it('can be approved once: the second approval is refused and issues no second code', async () => {
      const client = await consentClient();
      const climber = await webClimber();
      const { authorization, approved } = await approve(climber, client);
      expect(codeIn(approved.body.url)).not.toBeNull();

      const again = await postJson(instance, '/oauth2/consent', climber.cookie, {
        accept: true,
        oauth_query: authorization.oauthQuery,
      });
      expect(again.response.status).toBe(400);
      expect(again.body.error).toBe('invalid_request');
      expect(await grantsOf(climber, client)).toHaveLength(1);
      expect((await interactionFor(authorization.oauthQuery)).consumedAt).not.toBeNull();
    });

    it('cannot reconnect an app after Disconnect', async () => {
      const client = await consentClient();
      const climber = await webClimber();
      const pending = await authorize(instance, client, climber.cookie);
      await approve(climber, client);
      expect(
        await disconnectPartnerConnection(environment.database, {
          userId: climber.userId,
          clientId: client.clientId,
          reason: 'climber_disconnect',
        }),
      ).toBe(true);

      const late = await postJson(instance, '/oauth2/consent', climber.cookie, {
        accept: true,
        oauth_query: pending.oauthQuery,
      });
      expect(late.response.status).toBe(400);
      const connection = await connectionOf(climber, client);
      expect(connection.revokedAt).not.toBeNull();
      expect(connection.generation).toBe(1);
      expect(await grantsOf(climber, client)).toEqual([]);
    });

    it('reconnects with a fresh link after Disconnect, under the new generation', async () => {
      const client = await consentClient();
      const climber = await webClimber();
      await approve(climber, client);
      await disconnectPartnerConnection(environment.database, {
        userId: climber.userId,
        clientId: client.clientId,
        reason: 'climber_disconnect',
      });
      const { authorization, approved } = await approve(climber, client);
      expect((await interactionFor(authorization.oauthQuery)).connectionGeneration).toBe(1);
      expect(codeIn(approved.body.url)).not.toBeNull();
      const connection = await connectionOf(climber, client);
      expect(connection.revokedAt).toBeNull();
      expect((await grantsOf(climber, client)).map((grant) => grant.generation)).toEqual([1]);
    });

    it('belongs to the climber it was shown to', async () => {
      const client = await consentClient();
      const shownTo = await webClimber();
      const someoneElse = await webClimber();
      const authorization = await authorize(instance, client, shownTo.cookie);

      const stolen = await postJson(instance, '/oauth2/consent', someoneElse.cookie, {
        accept: true,
        oauth_query: authorization.oauthQuery,
      });
      expect(stolen.response.status).toBe(400);
      expect(await connectionOf(someoneElse, client)).toBeUndefined();
      // The attempt did not spend it for the climber it belongs to.
      const own = await postJson(instance, '/oauth2/consent', shownTo.cookie, {
        accept: true,
        oauth_query: authorization.oauthQuery,
      });
      expect(codeIn(own.body.url)).not.toBeNull();
    });

    it('belongs to the login it was shown to, so switching accounts and back invalidates it', async () => {
      const client = await consentClient();
      const climber = await webClimber();
      const authorization = await authorize(instance, client, climber.cookie);
      const nextLogin = await signInAs(climber.userId);
      const answered = await postJson(instance, '/oauth2/consent', nextLogin.cookie, {
        accept: true,
        oauth_query: authorization.oauthQuery,
      });
      expect(answered.response.status).toBe(400);
      expect(await connectionOf(climber, client)).toBeUndefined();
    });

    it('expires with its signature', async () => {
      const client = await consentClient();
      const climber = await webClimber();
      const authorization = await authorize(instance, client, climber.cookie);
      const interaction = await interactionFor(authorization.oauthQuery);
      expect(interaction.expiresAt.getTime()).toBe(
        Number(new URLSearchParams(authorization.oauthQuery).get('exp')) * 1000,
      );
      await db
        .update(oauthConsentInteractions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(oauthConsentInteractions.digest, interaction.digest));
      const expired = await postJson(instance, '/oauth2/consent', climber.cookie, {
        accept: true,
        oauth_query: authorization.oauthQuery,
      });
      expect(expired.response.status).toBe(400);
    });

    it('is refused when tampered with, before anything is looked up', async () => {
      const client = await consentClient();
      const climber = await webClimber();
      const authorization = await authorize(instance, client, climber.cookie);
      const tampered = await postJson(instance, '/oauth2/consent', climber.cookie, {
        accept: true,
        oauth_query: authorization.oauthQuery.replace('profile%3Aread', 'offline_access'),
      });
      expect(tampered.response.status).toBe(400);
      expect((await interactionFor(authorization.oauthQuery)).consumedAt).toBeNull();
    });

    it('is spent by a denial too', async () => {
      const client = await consentClient();
      const climber = await webClimber();
      const authorization = await authorize(instance, client, climber.cookie);
      const denied = await postJson(instance, '/oauth2/consent', climber.cookie, {
        accept: false,
        oauth_query: authorization.oauthQuery,
      });
      expect(new URL(denied.body.url as string).searchParams.get('error')).toBe('access_denied');
      const approved = await postJson(instance, '/oauth2/consent', climber.cookie, {
        accept: true,
        oauth_query: authorization.oauthQuery,
      });
      expect(approved.response.status).toBe(400);
      expect(await connectionOf(climber, client)).toBeUndefined();
    });

    it('asks a stale session to sign in again instead of answering', async () => {
      const client = await consentClient();
      const climber = await webClimber();
      const authorization = await authorize(instance, client, climber.cookie);
      const stale = await signInAs(climber.userId, { authSessionId: climber.authSessionId, authTime: null });
      const answered = await postJson(instance, '/oauth2/consent', stale.cookie, {
        accept: true,
        oauth_query: authorization.oauthQuery,
      });
      expect(answered.response.status).toBe(401);
      expect(answered.body.error).toBe('login_required');
      expect((await interactionFor(authorization.oauthQuery)).consumedAt).toBeNull();
    });

    it(
      'approved for a first connection while another tab connects and disconnects, cannot undo the Disconnect',
      async () => {
        const client = await consentClient();
        const climber = await webClimber();
        let armed = false;
        // Runs after the consent guard checked generation 0 (no row yet) and the
        // provider wrote the code, before the fence binds it: the window the
        // after-hook re-check closes.
        const racing = environment.createInstance([
          {
            id: 'disconnect-during-consent',
            hooks: {
              after: [
                {
                  matcher: (context) => armed && context.path === '/oauth2/authorize',
                  handler: createAuthMiddleware(async () => {
                    armed = false;
                    await db.insert(oauthConnections).values({
                      id: randomUUID(),
                      userId: climber.userId,
                      clientId: client.clientId,
                      connectedAt: new Date(),
                    });
                    await disconnectPartnerConnection(environment.database, {
                      userId: climber.userId,
                      clientId: client.clientId,
                      reason: 'climber_disconnect',
                    });
                  }),
                },
              ],
            },
          },
        ]);
        const authorization = await authorize(racing, client, climber.cookie);
        expect((await interactionFor(authorization.oauthQuery)).connectionGeneration).toBe(0);
        armed = true;
        const answered = await postJson(racing, '/oauth2/consent', climber.cookie, {
          accept: true,
          oauth_query: authorization.oauthQuery,
        });

        expect(armed).toBe(false);
        expect(answered.response.status).toBe(400);
        const connection = await connectionOf(climber, client);
        expect(connection.generation).toBe(1);
        expect(connection.revokedAt).not.toBeNull();
        expect(await grantsOf(climber, client)).toEqual([]);
        expect(
          await db
            .select()
            .from(oauthConsent)
            .where(and(eq(oauthConsent.userId, climber.userId), eq(oauthConsent.clientId, client.clientId))),
        ).toEqual([]);
      },
      TEST_DEADLINE_MS,
    );
  });

  describe('cross-site requests', () => {
    it.each([
      ['a sibling subdomain', 'https://preview.boardsesh.test'],
      ['a lookalike host', 'https://www.boardsesh.test.evil.example'],
      ['an opaque origin', 'null'],
      ['plain http', 'http://www.boardsesh.test'],
      ['no origin at all', null],
    ])('are refused from %s, and spend nothing', async (_label, origin) => {
      const client = await consentClient();
      const climber = await webClimber();
      const authorization = await authorize(instance, client, climber.cookie);
      for (const path of ['/oauth2/consent', '/oauth2/consent-details']) {
        const refused = await postJson(
          instance,
          path,
          climber.cookie,
          { accept: true, oauth_query: authorization.oauthQuery },
          origin,
        );
        expect({ path, status: refused.response.status }).toEqual({ path, status: 403 });
      }
      expect((await interactionFor(authorization.oauthQuery)).consumedAt).toBeNull();
      expect(await connectionOf(climber, client)).toBeUndefined();
    });

    // Better Auth's own check takes a Referer when Origin is missing. This one
    // takes Origin only, so it does not depend on that library behaviour.
    it('are refused with only a www Referer and no Origin', async () => {
      const client = await consentClient();
      const climber = await webClimber();
      const authorization = await authorize(instance, client, climber.cookie);
      for (const path of ['/oauth2/consent', '/oauth2/consent-details']) {
        const refused = await postJson(
          instance,
          path,
          climber.cookie,
          { accept: true, oauth_query: authorization.oauthQuery },
          null,
          { referer: `${TEST_CONFIGURATION.webOrigin}/oauth/consent?${authorization.oauthQuery}` },
        );
        expect({ path, status: refused.response.status, error: refused.body.error }).toEqual({
          path,
          status: 403,
          error: 'invalid_request',
        });
      }
      expect((await interactionFor(authorization.oauthQuery)).consumedAt).toBeNull();
    });
  });

  describe('connection caps', () => {
    it('refuse a climber once the app has its active connections, and leave nothing behind', async () => {
      const client = await consentClient({ policy: { maxActiveConnections: 1 } });
      await approve(await webClimber(), client);
      const turnedAway = await webClimber();
      const { authorization, approved } = await approve(turnedAway, client);

      expect(approved.response.status).toBe(200);
      const redirect = new URL(approved.body.url as string);
      expect(redirect.origin + redirect.pathname).toBe(client.redirectUri);
      expect(redirect.searchParams.get('error')).toBe('temporarily_unavailable');
      expect(redirect.searchParams.get('state')).toBe(new URLSearchParams(authorization.oauthQuery).get('state'));
      expect(redirect.searchParams.has('code')).toBe(false);
      expect(await connectionOf(turnedAway, client)).toBeUndefined();
      expect(await db.select().from(oauthConsent).where(eq(oauthConsent.userId, turnedAway.userId))).toEqual([]);
      // Rolled back whole, so the climber can try again once a place frees up.
      expect((await interactionFor(authorization.oauthQuery)).consumedAt).toBeNull();
    });

    it('count a reconnect as a new connection for the day', async () => {
      const client = await consentClient({ policy: { maxNewConnectionsPerDay: 1 } });
      const first = await webClimber();
      await approve(first, client);
      await disconnectPartnerConnection(environment.database, {
        userId: first.userId,
        clientId: client.clientId,
        reason: 'climber_disconnect',
      });
      const second = await webClimber();
      const { approved } = await approve(second, client);
      expect(new URL(approved.body.url as string).searchParams.get('error')).toBe('temporarily_unavailable');
      expect(new URL(approved.body.url as string).searchParams.get('error_description')).toMatch(/today/);
    });

    it('count only approved connections, not rows a code created and nobody approved', async () => {
      const client = await consentClient({ policy: { maxActiveConnections: 1, maxNewConnectionsPerDay: 1 } });
      const neverApproved = await webClimber();
      await db
        .insert(oauthConnections)
        .values({ id: randomUUID(), userId: neverApproved.userId, clientId: client.clientId, connectedAt: null });
      const { approved } = await approve(await webClimber(), client);
      expect(codeIn(approved.body.url)).not.toBeNull();
    });

    it('refuse every connection to an app with no policy row', async () => {
      const client = await consentClient({ policy: false });
      const { approved } = await approve(await webClimber(), client);
      expect(new URL(approved.body.url as string).searchParams.get('error')).toBe('access_denied');
    });

    it(
      'hold under two climbers taking the last place at once, on two instances',
      async () => {
        const client = await consentClient({ policy: { maxActiveConnections: 1 } });
        const [left, right] = await Promise.all([webClimber(), webClimber()]);
        const [leftLink, rightLink] = await Promise.all([
          authorize(instance, client, left.cookie),
          authorize(environment.secondaryInstance, client, right.cookie),
        ]);
        const answers = await Promise.all([
          postJson(instance, '/oauth2/consent', left.cookie, { accept: true, oauth_query: leftLink.oauthQuery }),
          postJson(environment.secondaryInstance, '/oauth2/consent', right.cookie, {
            accept: true,
            oauth_query: rightLink.oauthQuery,
          }),
        ]);
        const codes = answers.map((answer) => codeIn(answer.body.url)).filter(Boolean);
        expect(codes).toHaveLength(1);
        const connected = await db
          .select()
          .from(oauthConnections)
          .where(and(eq(oauthConnections.clientId, client.clientId), sql`${oauthConnections.connectedAt} is not null`));
        expect(connected).toHaveLength(1);
      },
      TEST_DEADLINE_MS,
    );
  });

  describe('the consent details', () => {
    it('state what the climber is approving, including that logbook:read covers "only me" ticks', async () => {
      const client = await consentClient();
      await db.update(users).set({ name: 'Account name' }).where(eq(users.id, client.owner.userId));
      await db.insert(userProfiles).values({ userId: client.owner.userId, displayName: 'Sequence Labs' });
      await db.execute(
        sql`update oauth_client set name = 'Sequence', uri = 'https://sequence.example', policy = 'https://sequence.example/privacy' where client_id = ${client.clientId}`,
      );
      const climber = await webClimber();
      const authorization = await authorize(instance, client, climber.cookie);
      const details = await postJson(instance, '/oauth2/consent-details', climber.cookie, {
        oauth_query: authorization.oauthQuery,
      });

      expect(details.response.status).toBe(200);
      expect(details.response.headers.get('cache-control')).toBe('no-store');
      expect(details.body).toEqual({
        client: {
          clientId: client.clientId,
          name: 'Sequence',
          homepageUrl: 'https://sequence.example',
          privacyPolicyUrl: 'https://sequence.example/privacy',
          termsUrl: null,
          developerName: 'Sequence Labs',
          redirectHost: new URL(client.redirectUri).host,
        },
        scopes: [
          { scope: 'profile:read', includesOnlyMeTicks: false },
          { scope: 'offline_access', includesOnlyMeTicks: false },
        ],
        reconnect: false,
        reviewed: false,
        expiresAt: (await interactionFor(authorization.oauthQuery)).expiresAt.toISOString(),
      });
      // Reading them spends nothing.
      expect((await interactionFor(authorization.oauthQuery)).consumedAt).toBeNull();
      // Decision 21, ready for L4: the one scope that reads "only me" ticks says so.
      expect(describeConsentScopes(['logbook:read'])).toEqual([{ scope: 'logbook:read', includesOnlyMeTicks: true }]);
    });

    it('offer only published scopes: logbook:read cannot be asked for until its route ships', async () => {
      expect(PARTNER_SCOPES).not.toContain('logbook:read');
      const client = await consentClient();
      const climber = await webClimber();
      const authorization = await authorize(instance, client, climber.cookie, { scope: 'logbook:read' });
      expect(new URL(authorization.location).searchParams.get('error')).toBe('invalid_scope');
    });

    it('say when approving reconnects an app the climber disconnected', async () => {
      const client = await consentClient();
      const climber = await webClimber();
      await approve(climber, client);
      await disconnectPartnerConnection(environment.database, {
        userId: climber.userId,
        clientId: client.clientId,
        reason: 'climber_disconnect',
      });
      const authorization = await authorize(instance, client, climber.cookie);
      const details = await postJson(instance, '/oauth2/consent-details', climber.cookie, {
        oauth_query: authorization.oauthQuery,
      });
      expect(details.body.reconnect).toBe(true);
    });

    it('are refused for a spent link, another climber and a signed-out browser', async () => {
      const client = await consentClient();
      const climber = await webClimber();
      const { authorization } = await approve(climber, client);
      const spent = await postJson(instance, '/oauth2/consent-details', climber.cookie, {
        oauth_query: authorization.oauthQuery,
      });
      expect(spent.response.status).toBe(400);
      const fresh = await authorize(instance, client, (await webClimber()).cookie);
      expect(
        (await postJson(instance, '/oauth2/consent-details', climber.cookie, { oauth_query: fresh.oauthQuery }))
          .response.status,
      ).toBe(400);
      const signedOut = await postJson(instance, '/oauth2/consent-details', null, { oauth_query: fresh.oauthQuery });
      expect(signedOut.response.status).toBe(401);
    });
  });

  describe('against a password reset', () => {
    /** Waits until one partner request is blocked on a database lock. */
    async function waitForBlockedRequest(deadlineMs = 5_000): Promise<void> {
      const deadline = Date.now() + deadlineMs;
      while (Date.now() < deadline) {
        const blocked = await db.execute(
          sql`select pid from pg_stat_activity where wait_event_type = 'Lock' and application_name = ${READ_ONLY_PROOF_APPLICATION_NAME}`,
        );
        if (blocked.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('Expected a blocked partner request.');
    }

    it(
      'a consent queued behind a reset reads the reset, and asks for a sign-in',
      async () => {
        const client = await consentClient();
        const climber = await webClimber({ authTime: nowSeconds() - 3600 });
        await db.insert(userCredentials).values({
          userId: climber.userId,
          passwordHash: 'before',
          updatedAt: new Date((nowSeconds() - 7200) * 1000),
        });
        const authorization = await authorize(instance, client, climber.cookie);
        expect(authorization.location.startsWith(TEST_OAUTH_OPTIONS.consentPage)).toBe(true);

        let resetMayCommit!: () => void;
        const commitSignal = new Promise<void>((resolve) => {
          resetMayCommit = resolve;
        });
        let resetHoldsUsers!: () => void;
        const usersHeld = new Promise<void>((resolve) => {
          resetHoldsUsers = resolve;
        });
        // The staged reset's order: users first, then the password row.
        const reset = db.transaction(async (transaction) => {
          await transaction.execute(sql`select 1 from users where id = ${climber.userId} for no key update`);
          resetHoldsUsers();
          await commitSignal;
          await transaction
            .update(userCredentials)
            .set({ passwordHash: 'after', updatedAt: new Date() })
            .where(eq(userCredentials.userId, climber.userId));
        });
        await usersHeld;
        const answer = postJson(instance, '/oauth2/consent', climber.cookie, {
          accept: true,
          oauth_query: authorization.oauthQuery,
        });
        await waitForBlockedRequest();
        resetMayCommit();
        await reset;

        const answered = await answer;
        expect(answered.response.status).toBe(401);
        expect(answered.body.error).toBe('login_required');
        expect(await connectionOf(climber, client)).toBeUndefined();
      },
      TEST_DEADLINE_MS,
    );

    it(
      'never locks the password row, so a legacy reset holding it does not hold up consent',
      async () => {
        const client = await consentClient();
        const climber = await webClimber();
        await db.insert(userCredentials).values({
          userId: climber.userId,
          passwordHash: 'before',
          updatedAt: new Date((nowSeconds() - 7200) * 1000),
        });
        const authorization = await authorize(instance, client, climber.cookie);
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let rowHeld!: () => void;
        const held = new Promise<void>((resolve) => {
          rowHeld = resolve;
        });
        // The legacy reset locks the password row before its trigger reaches users.
        const legacyReset = db.transaction(async (transaction) => {
          await transaction.execute(sql`select 1 from user_credentials where user_id = ${climber.userId} for update`);
          rowHeld();
          await released;
        });
        await held;
        try {
          const startedAt = Date.now();
          const answered = await postJson(instance, '/oauth2/consent', climber.cookie, {
            accept: true,
            oauth_query: authorization.oauthQuery,
          });
          expect(codeIn(answered.body.url)).not.toBeNull();
          // Well inside the 2 s lock timeout a wait on that row would end in.
          expect(Date.now() - startedAt).toBeLessThan(1500);
        } finally {
          release();
          await legacyReset;
        }
      },
      TEST_DEADLINE_MS,
    );
  });
});
