import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request, type IncomingMessage } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { and, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { ApiErrorResponseSchema, MeResponseSchema } from '@boardsesh/public-api';
import {
  oauthAccessToken,
  oauthConnections,
  oauthConsent,
  oauthConsentInteractions,
  oauthGrants,
  oauthRefreshAncestors,
  oauthRefreshToken,
  oauthSession,
  oauthSubjects,
  oauthVerification,
  userProfiles,
  users,
} from '@boardsesh/db/schema/auth';
import { createPartnerAuthorityRuntime, type PartnerAuthorityRuntime } from '../auth/partner/authority';
import { disconnectPartnerConnection } from '../auth/partner/connection';
import { createPartnerDatabaseHandle } from '../auth/partner/transaction';
import { db } from '../db/client';
import { API_HOSTNAME, rejectApiHostRequest } from '../handlers/api-host';
import { createPublicApiHandler, type PublicApiHandlerOptions } from '../handlers/public-api/router';
import { validateToken } from '../middleware/auth';
import { redisClientManager } from '../redis/client';
import { logger } from '../utils/logger';
import {
  createPartnerTestEnvironment,
  TEST_CONFIGURATION,
  testSessionBridge,
  type PartnerTestEnvironment,
  type TestClient,
  type TestClimber,
} from '../auth/partner/__tests__/partner-fixture';

const MINUTE_MS = 60_000;
const TEST_DEADLINE_MS = 60_000;
const MEDIA_BASE_URL = 'https://media.boardsesh.test';
const ME_PATH = '/v1/me';
const CONNECTION_PATH = '/v1/connection';

// The limits run against real Redis, the path production takes.
beforeAll(async () => {
  await redisClientManager.connect();
});

afterAll(async () => {
  await redisClientManager.disconnect();
});

function limiterKey(identity: string, operation: string): string {
  return `ratelimit:${identity}:${operation}:${Math.floor(Date.now() / MINUTE_MS)}`;
}

async function seedLimiter(identity: string, operation: string, count: number): Promise<void> {
  await redisClientManager.getClients().publisher.set(limiterKey(identity, operation), String(count), 'EX', 120);
}

async function limiterCount(identity: string, operation: string): Promise<number> {
  return Number(await redisClientManager.getClients().publisher.get(limiterKey(identity, operation)));
}

/** Limits use fixed one-minute windows, so a counting test must not straddle a rollover. */
async function enoughWindowLeft(minimumMs = 20_000): Promise<void> {
  const remainingMs = MINUTE_MS - (Date.now() % MINUTE_MS);
  if (remainingMs < minimumMs) await new Promise((resolve) => setTimeout(resolve, remainingMs + 50));
}

function randomClientIp(): string {
  return `198.51.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 254) + 1}`;
}

interface SentResponse {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
}

interface SendOptions {
  host?: string;
  token?: string;
  headers?: Record<string, string>;
  clientIp?: string;
  body?: string;
}

/** A server wired the way `startServer` wires it: the public API, then the API host filter. */
async function startApiHost(options: PublicApiHandlerOptions) {
  const handler = createPublicApiHandler(options);
  const server = createServer((req, res) => {
    void (async () => {
      if (await handler(req, res)) return;
      const pathname = new URL(req.url ?? '/', 'http://backend.internal').pathname;
      if (rejectApiHostRequest(req, res, pathname)) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reachedDispatcher: true }));
    })();
  });
  const openSockets = new Set<Socket>();
  server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  function send(method: string, path: string, options: SendOptions = {}): Promise<SentResponse> {
    return new Promise((resolve, reject) => {
      const outgoing = request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          agent: false,
          headers: {
            Host: options.host ?? API_HOSTNAME,
            'X-Forwarded-For': options.clientIp ?? randomClientIp(),
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
            ...options.headers,
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', () =>
            resolve({
              status: incoming.statusCode ?? 0,
              headers: incoming.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      outgoing.on('error', reject);
      outgoing.end(options.body);
    });
  }

  return {
    send,
    async close() {
      for (const socket of openSockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Every refusal of a token looks the same from outside. */
function expectInvalidToken(response: SentResponse, challenge = 'Bearer error="invalid_token"') {
  expect(response.status).toBe(401);
  expect(response.headers['www-authenticate']).toBe(challenge);
  expect(response.headers['cache-control']).toBe('no-store');
  const body = ApiErrorResponseSchema.parse(JSON.parse(response.body));
  expect(body.error).toBe('invalid_token');
  expect(body.requestId).toBe(response.headers['boardsesh-request-id']);
}

describe('the public /v1 API', () => {
  let environment: PartnerTestEnvironment;
  let runtime: PartnerAuthorityRuntime;
  let apiHost: Awaited<ReturnType<typeof startApiHost>>;

  beforeAll(async () => {
    environment = await createPartnerTestEnvironment();
    runtime = await createPartnerAuthorityRuntime(environment.database, TEST_CONFIGURATION, {
      plugins: [testSessionBridge(createPartnerDatabaseHandle(environment.database))],
      close: async () => {},
    });
    apiHost = await startApiHost({
      mode: 'allowlist',
      loadRuntime: async () => runtime,
      mediaBaseUrl: () => MEDIA_BASE_URL,
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await apiHost?.close();
    await environment?.close();
  });

  async function connectionOf(client: TestClient, climber: TestClimber = client.owner) {
    const [connection] = await db
      .select()
      .from(oauthConnections)
      .where(and(eq(oauthConnections.clientId, client.clientId), eq(oauthConnections.userId, climber.userId)));
    return connection;
  }

  /** The provider's own verdict on a token, through stock introspection by the app that holds it. */
  async function introspectionSaysActive(client: TestClient, token: string): Promise<boolean> {
    const { body } = await environment.introspect(client, token);
    return body.active === true;
  }

  /** A reconnect after Disconnect always passes through the consent screen again. */
  async function reconnect(client: TestClient): Promise<string> {
    const atConsent = await environment.authorize(client);
    expect(atConsent.location).toContain('/oauth/consent');
    const accepted = await environment.consent(client.owner, {
      accept: true,
      oauth_query: new URL(atConsent.location!).searchParams.toString(),
    });
    const exchanged = await environment.exchange(client, {
      location: accepted.body.url!,
      verifier: atConsent.verifier,
    });
    expect(exchanged.response.status).toBe(200);
    return exchanged.body.access_token!;
  }

  const getMe = (token: string, options: SendOptions = {}) => apiHost.send('GET', ME_PATH, { ...options, token });
  const disconnect = (token: string, options: SendOptions = {}) =>
    apiHost.send('DELETE', CONNECTION_PATH, { ...options, token });

  describe('GET /v1/me', () => {
    it('returns the app-scoped id and the profile, in the documented shape only', async () => {
      const client = await environment.createClient();
      await db.update(users).set({ name: 'Alexandra' }).where(eq(users.id, client.owner.userId));
      await db.insert(userProfiles).values({
        userId: client.owner.userId,
        displayName: 'Alex',
        avatarUrl: '/static/avatars/alex.webp?v=7',
      });
      const issued = await environment.issueTokens(client, ['profile:read', 'offline_access']);
      const answered = await getMe(issued.access_token);
      expect(answered.status).toBe(200);
      expect(answered.headers['cache-control']).toBe('no-store');
      expect(answered.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(answered.headers['boardsesh-request-id']).toMatch(/^req_/);
      expect(answered.headers['ratelimit-limit']).toBe('120');
      const body = JSON.parse(answered.body) as Record<string, unknown>;
      expect(MeResponseSchema.parse(body)).toEqual(body);
      expect(body).toEqual({
        id: expect.stringMatching(/^usr_[0-9A-Za-z]{22}$/),
        displayName: 'Alex',
        avatarUrl: `${MEDIA_BASE_URL}/avatars/alex.webp?v=7`,
      });
      expect(answered.body).not.toContain(client.owner.userId);
      const [subject] = await db
        .select()
        .from(oauthSubjects)
        .where(and(eq(oauthSubjects.userId, client.owner.userId), eq(oauthSubjects.clientId, client.clientId)));
      expect(subject.subject).toBe(body.id);
    });

    it('works with any granted scope, and leaves the profile out without profile:read', async () => {
      const client = await environment.createClient();
      await db.update(users).set({ name: 'Alexandra' }).where(eq(users.id, client.owner.userId));
      const issued = await environment.issueTokens(client, ['offline_access']);
      const answered = await getMe(issued.access_token);
      expect(answered.status).toBe(200);
      expect(Object.keys(JSON.parse(answered.body))).toEqual(['id']);
    });

    it('sends null for a climber with no name and no avatar', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client, ['profile:read']);
      const answered = await getMe(issued.access_token);
      expect(answered.status).toBe(200);
      expect(JSON.parse(answered.body)).toEqual({
        id: expect.stringMatching(/^usr_/),
        displayName: null,
        avatarUrl: null,
      });
    });

    it.each([
      ['javascript:alert(document.cookie)', null],
      ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', null],
      ['ftp://files.example.test/alex.png', null],
      ['avatars/alex.webp', null],
      // What updateProfile accepts and a partner's server must never fetch.
      ['http://boardsesh-backend.railway.internal/x', null],
      ['https://user:pass@evil.example/x.png', null],
      ['http://instance-data.ec2.internal/latest/meta-data/', null],
      ['https://cdn.example.test/alex.webp', null],
      [`${MEDIA_BASE_URL}/avatars/alex.webp?v=2`, `${MEDIA_BASE_URL}/avatars/alex.webp?v=2`],
      ['https://lh3.googleusercontent.com/a/ACg8ocAlex=s96-c', 'https://lh3.googleusercontent.com/a/ACg8ocAlex=s96-c'],
    ])('maps a stored avatar of %j to %j', async (stored, expected) => {
      const client = await environment.createClient();
      await db.insert(userProfiles).values({ userId: client.owner.userId, avatarUrl: stored });
      const issued = await environment.issueTokens(client, ['profile:read']);
      const answered = await getMe(issued.access_token);
      expect(answered.status).toBe(200);
      expect(JSON.parse(answered.body).avatarUrl).toBe(expected);
    });

    it("falls back to the sign-in provider's name and picture", async () => {
      const client = await environment.createClient();
      await db
        .update(users)
        .set({ name: 'Sam', image: 'https://platform-lookaside.fbsbx.com/platform/profilepic/?asid=7' })
        .where(eq(users.id, client.owner.userId));
      const issued = await environment.issueTokens(client, ['profile:read']);
      expect(JSON.parse((await getMe(issued.access_token)).body)).toMatchObject({
        displayName: 'Sam',
        avatarUrl: 'https://platform-lookaside.fbsbx.com/platform/profilepic/?asid=7',
      });
    });

    it('keeps the id across reconnects and gives every app its own', async () => {
      const client = await environment.createClient();
      const otherApp = await environment.createClient({ owner: client.owner });
      const first = await environment.issueTokens(client);
      const firstId = JSON.parse((await getMe(first.access_token)).body).id as string;
      expect(JSON.parse((await getMe(first.access_token)).body).id).toBe(firstId);

      expect((await disconnect(first.access_token)).status).toBe(204);
      const reconnected = await reconnect(client);
      expect(JSON.parse((await getMe(reconnected)).body).id).toBe(firstId);

      const forOtherApp = await environment.issueTokens(otherApp);
      const otherId = JSON.parse((await getMe(forOtherApp.access_token)).body).id as string;
      expect(otherId).toMatch(/^usr_/);
      expect(otherId).not.toBe(firstId);
    });

    it('mints one id when two first requests race', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      const answers = await Promise.all(Array.from({ length: 4 }, () => getMe(issued.access_token)));
      const ids = new Set(answers.map((answer) => JSON.parse(answer.body).id as string));
      expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200]);
      expect(ids.size).toBe(1);
    });
  });

  describe('the bearer check', () => {
    it('answers a request with no token with the bare challenge', async () => {
      expectInvalidToken(await apiHost.send('GET', ME_PATH), 'Bearer');
    });

    it.each([
      ['a Basic credential', { Authorization: 'Basic dXNlcjpwYXNz' }],
      ['a bare scheme', { Authorization: 'Bearer' }],
      ['two tokens', { Authorization: 'Bearer one two' }],
      ['a DPoP scheme', { Authorization: 'DPoP abc' }],
    ])('refuses %s', async (_label, headers) => {
      expectInvalidToken(await apiHost.send('GET', ME_PATH, { headers }));
    });

    it('never reads a token from the query string', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      expectInvalidToken(await apiHost.send('GET', `${ME_PATH}?access_token=${issued.access_token}`), 'Bearer');
    });

    it('refuses an unknown token, a refresh token and first-party credentials', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      expectInvalidToken(await getMe(`unknown${randomUUID().replaceAll('-', '')}`));
      expectInvalidToken(await getMe(issued.refresh_token!));
      // The shape of a native JWS and a NextAuth JWE. Neither is ever looked up as a partner token.
      expectInvalidToken(await getMe('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl'));
      expectInvalidToken(await getMe('eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..aXY.Y2lwaGVy.dGFn'));
      expectInvalidToken(
        await apiHost.send('GET', ME_PATH, { headers: { Cookie: `next-auth.session-token=${randomUUID()}` } }),
        'Bearer',
      );
    });

    it('requires the API audience: a token issued without resource never works', async () => {
      const client = await environment.createClient();
      const authorization = await environment.authorize(client, { omitResource: true });
      const exchanged = await environment.exchange(client, authorization);
      expect(exchanged.response.status).toBe(200);
      const accessToken = exchanged.body.access_token!;
      const [stored] = await db
        .select({ resources: oauthAccessToken.resources })
        .from(oauthAccessToken)
        .where(eq(oauthAccessToken.clientId, client.clientId));
      expect(stored.resources ?? []).not.toContain(TEST_CONFIGURATION.resource);
      // The provider alone would accept it; only the audience check stops it.
      expect(await introspectionSaysActive(client, accessToken)).toBe(true);
      expectInvalidToken(await getMe(accessToken));
      expectInvalidToken(await disconnect(accessToken));
      expect((await connectionOf(client)).revokedAt).toBeNull();
    });

    type TokenBreak = (client: TestClient, climber: TestClimber) => Promise<void>;
    const breaks: Array<[string, TokenBreak, boolean, string[]?]> = [
      [
        'expired',
        async (client) => {
          await db
            .update(oauthAccessToken)
            .set({ expiresAt: new Date(Date.now() - 1000) })
            .where(eq(oauthAccessToken.clientId, client.clientId));
        },
        false,
      ],
      [
        'marked revoked',
        async (client) => {
          await db
            .update(oauthAccessToken)
            .set({ revoked: new Date() })
            .where(eq(oauthAccessToken.clientId, client.clientId));
        },
        false,
      ],
      [
        'issued to a disabled app',
        async (client) => {
          await db.execute(sql`update oauth_client set disabled = true where client_id = ${client.clientId}`);
        },
        false,
      ],
      [
        'bound to a sign-in session that ended',
        async (_client, climber) => {
          await db
            .update(oauthSession)
            .set({ expiresAt: new Date(Date.now() - 1000) })
            .where(eq(oauthSession.id, climber.sessionId));
        },
        false,
        ['profile:read'],
      ],
      [
        'from a disconnected connection',
        async (client, climber) => {
          await db
            .update(oauthConnections)
            .set({ revokedAt: new Date() })
            .where(and(eq(oauthConnections.clientId, client.clientId), eq(oauthConnections.userId, climber.userId)));
        },
        true,
      ],
      [
        'from an older connection generation',
        async (client, climber) => {
          await db
            .update(oauthConnections)
            .set({ generation: sql`${oauthConnections.generation} + 1` })
            .where(and(eq(oauthConnections.clientId, client.clientId), eq(oauthConnections.userId, climber.userId)));
        },
        true,
      ],
      [
        'whose grant row is gone',
        async (client) => {
          const [token] = await db
            .select({ authorizationCodeId: oauthAccessToken.authorizationCodeId })
            .from(oauthAccessToken)
            .where(eq(oauthAccessToken.clientId, client.clientId));
          await db.delete(oauthGrants).where(eq(oauthGrants.authorizationCodeId, token.authorizationCodeId!));
        },
        true,
      ],
      [
        'bound to a DPoP key',
        async (client) => {
          await db
            .update(oauthAccessToken)
            .set({ confirmation: { jkt: 'thumbprint' } })
            .where(eq(oauthAccessToken.clientId, client.clientId));
        },
        true,
      ],
    ];

    it.each(breaks)(
      'refuses a token %s',
      async (_label, breakToken, providerStillAccepts, scopes = ['profile:read', 'offline_access']) => {
        const client = await environment.createClient();
        const issued = await environment.issueTokens(client, scopes);
        expect((await getMe(issued.access_token)).status).toBe(200);
        await breakToken(client, client.owner);
        expectInvalidToken(await getMe(issued.access_token));
        expectInvalidToken(await disconnect(issued.access_token));
        // Where the provider's own introspection still says active, the check
        // that refused it is ours: the connection, its generation or the grant.
        expect(await introspectionSaysActive(client, issued.access_token)).toBe(providerStillAccepts);
      },
    );

    it('refuses a token revoked through RFC 7009', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      expect((await environment.revoke(client, { token: issued.access_token })).response.status).toBe(200);
      expectInvalidToken(await getMe(issued.access_token));
    });

    it('stops working on the next request after a climber disconnects in Boardsesh', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      expect((await getMe(issued.access_token)).status).toBe(200);
      await disconnectPartnerConnection(environment.database, {
        userId: client.owner.userId,
        clientId: client.clientId,
        reason: 'climber_disconnect',
      });
      expectInvalidToken(await getMe(issued.access_token));
    });

    it('keeps partner tokens out of every first-party credential check', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      expect(issued.access_token).not.toContain('.');
      expect(issued.refresh_token).not.toContain('.');
      expect(await validateToken(issued.access_token)).toBeNull();
      expect(await validateToken(issued.refresh_token!)).toBeNull();
    });
  });

  describe('DELETE /v1/connection', () => {
    async function rowCounts(client: TestClient, climber: TestClimber, connectionId: string) {
      const { userId } = climber;
      const { clientId } = client;
      return {
        accessTokens: await db.$count(
          oauthAccessToken,
          and(eq(oauthAccessToken.userId, userId), eq(oauthAccessToken.clientId, clientId)),
        ),
        refreshTokens: await db.$count(
          oauthRefreshToken,
          and(eq(oauthRefreshToken.userId, userId), eq(oauthRefreshToken.clientId, clientId)),
        ),
        consents: await db.$count(
          oauthConsent,
          and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)),
        ),
        ancestors: await db.$count(
          oauthRefreshAncestors,
          and(eq(oauthRefreshAncestors.userId, userId), eq(oauthRefreshAncestors.clientId, clientId)),
        ),
        interactions: await db.$count(
          oauthConsentInteractions,
          and(eq(oauthConsentInteractions.userId, userId), eq(oauthConsentInteractions.clientId, clientId)),
        ),
        grants: await db.$count(oauthGrants, eq(oauthGrants.connectionId, connectionId)),
      };
    }

    it('ends every credential, remembered consent, ancestor and pending code of the connection', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      // A rotation, so the family has ancestry, and a second family.
      const refreshed = await environment.refresh(client, issued.refresh_token!);
      expect(refreshed.response.status).toBe(200);
      await environment.issueTokens(client);
      // A code issued and never redeemed.
      const pending = await environment.authorize(client);
      const pendingCode = new URL(pending.location!).searchParams.get('code');
      expect(pendingCode).toBeTruthy();
      const connection = await connectionOf(client);
      await db.insert(oauthConsent).values({
        id: randomUUID(),
        clientId: client.clientId,
        userId: client.owner.userId,
        scopes: ['profile:read'],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(oauthConsentInteractions).values({
        digest: randomUUID(),
        userId: client.owner.userId,
        authSessionId: randomUUID(),
        clientId: client.clientId,
        connectionGeneration: connection.generation,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const before = await rowCounts(client, client.owner, connection.id);
      expect(before.accessTokens).toBeGreaterThanOrEqual(2);
      expect(before.ancestors).toBeGreaterThan(0);
      expect(before.grants).toBe(3);
      const pendingCodeIds = (
        await db
          .select({ authorizationCodeId: oauthGrants.authorizationCodeId })
          .from(oauthGrants)
          .where(eq(oauthGrants.connectionId, connection.id))
      ).map((grant) => grant.authorizationCodeId);

      const answered = await disconnect(refreshed.body.access_token!);
      expect(answered.status).toBe(204);
      expect(answered.body).toBe('');
      expect(answered.headers['cache-control']).toBe('no-store');
      expect(answered.headers['content-type']).toBeUndefined();

      expect(await rowCounts(client, client.owner, connection.id)).toEqual({
        accessTokens: 0,
        refreshTokens: 0,
        consents: 0,
        ancestors: 0,
        interactions: 0,
        grants: 0,
      });
      for (const identifier of pendingCodeIds) {
        expect(await db.$count(oauthVerification, eq(oauthVerification.identifier, identifier))).toBe(0);
      }
      const after = await connectionOf(client);
      expect(after.generation).toBe(connection.generation + 1);
      expect(after.revokedAt).not.toBeNull();
      expect(after.revocationReason).toBe('app_disconnect');

      expectInvalidToken(await getMe(refreshed.body.access_token!));
      const refreshAfter = await environment.refresh(client, refreshed.body.refresh_token!);
      expect(refreshAfter.body.error).toBe('invalid_grant');
      // The consumed refresh token is no longer known at all, so a replay takes no lock.
      const replay = await environment.refresh(client, issued.refresh_token!);
      expect(replay.body.error).toBe('invalid_grant');
      expect(await db.$count(oauthRefreshAncestors, eq(oauthRefreshAncestors.clientId, client.clientId))).toBe(0);
    });

    it("leaves the climber's other apps and the app's other climbers alone", async () => {
      const client = await environment.createClient();
      const otherApp = await environment.createClient({ owner: client.owner });
      const otherClimber = await environment.createClimber();
      const ours = await environment.issueTokens(client);
      const otherAppTokens = await environment.issueTokens(otherApp);
      const authorization = await environment.authorize(client, { climber: otherClimber });
      const otherClimberTokens = (await environment.exchange(client, authorization)).body.access_token!;

      expect((await disconnect(ours.access_token)).status).toBe(204);
      expect((await getMe(otherAppTokens.access_token)).status).toBe(200);
      expect((await getMe(otherClimberTokens)).status).toBe(200);
      expect((await connectionOf(otherApp)).revokedAt).toBeNull();
      expect((await connectionOf(client, otherClimber)).revokedAt).toBeNull();
    });

    it('is idempotent: concurrent calls end the connection once, and a retry answers 401', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      const generation = (await connectionOf(client)).generation;
      const answers = await Promise.all(Array.from({ length: 4 }, () => disconnect(issued.access_token)));
      const statuses = answers.map((answer) => answer.status);
      expect(statuses).toContain(204);
      expect(statuses.every((status) => status === 204 || status === 401)).toBe(true);
      expect((await connectionOf(client)).generation).toBe(generation + 1);
      expectInvalidToken(await disconnect(issued.access_token));
    });

    it('answers success when the connection ended between the token check and the lock', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      const checked = await runtime.api.authenticate(issued.access_token);
      expect(checked.principal).toBeDefined();
      await disconnectPartnerConnection(environment.database, {
        userId: client.owner.userId,
        clientId: client.clientId,
        reason: 'climber_disconnect',
      });
      const generation = (await connectionOf(client)).generation;
      expect(await runtime.api.disconnect(checked.principal!)).toBe('already_disconnected');
      expect((await connectionOf(client)).generation).toBe(generation);
    });

    it('never ends a newer connection with a token from before a reconnect', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      const checked = await runtime.api.authenticate(issued.access_token);
      await disconnectPartnerConnection(environment.database, {
        userId: client.owner.userId,
        clientId: client.clientId,
        reason: 'climber_disconnect',
      });
      const reconnected = await reconnect(client);
      expect(await runtime.api.disconnect(checked.principal!)).toBe('token_invalid');
      expect((await connectionOf(client)).revokedAt).toBeNull();
      expect((await getMe(reconnected)).status).toBe(200);
    });

    it('re-reads the generation under the lock, even if a token of the old one survived', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      const checked = await runtime.api.authenticate(issued.access_token);
      await db
        .update(oauthConnections)
        .set({ generation: sql`${oauthConnections.generation} + 1` })
        .where(eq(oauthConnections.id, checked.principal!.connectionId));
      expect(await runtime.api.disconnect(checked.principal!)).toBe('token_invalid');
      expect((await connectionOf(client)).revokedAt).toBeNull();
    });

    it('re-reads the token under the lock', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      const checked = await runtime.api.authenticate(issued.access_token);
      await db.delete(oauthAccessToken).where(eq(oauthAccessToken.token, checked.principal!.accessTokenHash));
      expect(await runtime.api.disconnect(checked.principal!)).toBe('token_invalid');
      expect((await connectionOf(client)).revokedAt).toBeNull();
    });

    it(
      "takes the climber's row before the connection, so it waits for a password reset in flight",
      async () => {
        const client = await environment.createClient();
        const issued = await environment.issueTokens(client);
        const blocker = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
        try {
          let release: () => void = () => {};
          const released = new Promise<void>((resolve) => {
            release = resolve;
          });
          let holding: () => void = () => {};
          const heldLock = new Promise<void>((resolve) => {
            holding = resolve;
          });
          // A password reset takes the users row FOR NO KEY UPDATE (F8).
          const reset = blocker.begin(async (transaction) => {
            await transaction`select id from users where id = ${client.owner.userId} for no key update`;
            holding();
            await released;
          });
          await heldLock;
          let settled = false;
          const disconnecting = disconnect(issued.access_token).then((answer) => {
            settled = true;
            return answer;
          });
          await new Promise((resolve) => setTimeout(resolve, 400));
          expect(settled).toBe(false);
          expect((await connectionOf(client)).revokedAt).toBeNull();
          release();
          await reset;
          expect((await disconnecting).status).toBe(204);
        } finally {
          await blocker.end({ timeout: 5 });
        }
      },
      TEST_DEADLINE_MS,
    );

    it(
      'answers 503 with Retry-After when the lock does not come within the timeout',
      async () => {
        const client = await environment.createClient();
        const issued = await environment.issueTokens(client);
        const blocker = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
        try {
          let release: () => void = () => {};
          const released = new Promise<void>((resolve) => {
            release = resolve;
          });
          let holding: () => void = () => {};
          const heldLock = new Promise<void>((resolve) => {
            holding = resolve;
          });
          const deletion = blocker.begin(async (transaction) => {
            await transaction`select id from users where id = ${client.owner.userId} for update`;
            holding();
            await released;
          });
          await heldLock;
          const answered = await disconnect(issued.access_token);
          release();
          await deletion;
          expect(answered.status).toBe(503);
          expect(answered.headers['retry-after']).toBe('2');
          expect(ApiErrorResponseSchema.parse(JSON.parse(answered.body)).error).toBe('server_error');
          expect((await connectionOf(client)).revokedAt).toBeNull();
        } finally {
          await blocker.end({ timeout: 5 });
        }
      },
      TEST_DEADLINE_MS,
    );
  });

  describe('rate limits', () => {
    it('charges the connection and the app only once a token has passed', async () => {
      await enoughWindowLeft();
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      const connectionKey = `${client.clientId}:${client.owner.userId}`;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expectInvalidToken(await getMe(`forged${randomUUID().replaceAll('-', '')}`));
      }
      expect(await limiterCount(connectionKey, 'api-connection')).toBe(0);
      expect(await limiterCount(client.clientId, 'api-app')).toBe(0);
      expect((await getMe(issued.access_token)).status).toBe(200);
      expect(await limiterCount(connectionKey, 'api-connection')).toBe(1);
      expect(await limiterCount(client.clientId, 'api-app')).toBe(1);
    });

    it('refuses a connection over 120 a minute with 429 and Retry-After', async () => {
      await enoughWindowLeft();
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      await seedLimiter(`${client.clientId}:${client.owner.userId}`, 'api-connection', 120);
      const limited = await getMe(issued.access_token);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(limited.headers['ratelimit-limit']).toBe('120');
      expect(limited.headers['ratelimit-remaining']).toBe('0');
      expect(limited.headers['cache-control']).toBe('no-store');
      expect(ApiErrorResponseSchema.parse(JSON.parse(limited.body)).error).toBe('rate_limited');
      // The disconnect a limited app sends is limited too, and changes nothing.
      expect((await disconnect(issued.access_token)).status).toBe(429);
      expect((await connectionOf(client)).revokedAt).toBeNull();
    });

    it('refuses an app over 6,000 a minute across its climbers', async () => {
      await enoughWindowLeft();
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      await seedLimiter(client.clientId, 'api-app', 6000);
      const limited = await getMe(issued.access_token);
      expect(limited.status).toBe(429);
      expect(limited.headers['ratelimit-limit']).toBe('6000');
    });

    it('counts failed lookups per address, and answers 429 past 600 only after a lookup failed', async () => {
      await enoughWindowLeft();
      const clientIp = randomClientIp();
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      expectInvalidToken(await getMe(`forged${randomUUID().replaceAll('-', '')}`, { clientIp }));
      expect(await limiterCount(clientIp, 'api-invalid-token-ip')).toBe(1);
      expect((await getMe(issued.access_token, { clientIp })).status).toBe(200);
      expect(await limiterCount(clientIp, 'api-invalid-token-ip')).toBe(1);
      // A token-less request costs no lookup and is not counted.
      await apiHost.send('GET', ME_PATH, { clientIp });
      expect(await limiterCount(clientIp, 'api-invalid-token-ip')).toBe(1);

      await seedLimiter(clientIp, 'api-invalid-token-ip', 600);
      const authenticate = vi.spyOn(runtime.api, 'authenticate');
      try {
        const limited = await getMe(`forged${randomUUID().replaceAll('-', '')}`, { clientIp });
        expect(limited.status).toBe(429);
        expect(limited.headers['ratelimit-limit']).toBe('600');
        expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
        expect(ApiErrorResponseSchema.parse(JSON.parse(limited.body)).error).toBe('rate_limited');
        expect(authenticate).toHaveBeenCalledTimes(1);
      } finally {
        authenticate.mockRestore();
      }
    });

    it("never refuses a valid token for a neighbour's failed lookups at the same address", async () => {
      await enoughWindowLeft();
      // One Cloudflare Worker address, carrier NAT or cloud NAT gateway: many partners, one bucket.
      const sharedAddress = randomClientIp();
      await seedLimiter(sharedAddress, 'api-invalid-token-ip', 5000);
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      const answered = await getMe(issued.access_token, { clientIp: sharedAddress });
      expect(answered.status).toBe(200);
      // The neighbour's count is never read, and never published to this app.
      expect(answered.headers['ratelimit-limit']).toBe('120');
      expect((await disconnect(issued.access_token, { clientIp: sharedAddress })).status).toBe(204);
      expect(await limiterCount(sharedAddress, 'api-invalid-token-ip')).toBe(5000);
    });
  });

  describe('availability', () => {
    it('answers 503 at once when the /v1 queue is full, and leaves a permit for token work', async () => {
      const running = await Promise.all([runtime.admission.acquire('api'), runtime.admission.acquire('api')]);
      const queued = Array.from({ length: 16 }, () => runtime.admission.acquire('api'));
      try {
        const client = await environment.createClient();
        const issued = await environment.issueTokens(client);
        const answered = await getMe(issued.access_token);
        expect(answered.status).toBe(503);
        expect(answered.headers['retry-after']).toBe('2');
        expect(ApiErrorResponseSchema.parse(JSON.parse(answered.body)).error).toBe('server_error');
        const tokenPermit = await runtime.admission.acquire('token');
        expect(tokenPermit).not.toBeNull();
        tokenPermit?.release();
      } finally {
        for (const permit of running) permit?.release();
      }
      for (const permit of await Promise.all(queued)) permit?.release();
    });

    it('holds lookups for junk tokens to the two /v1 permits, leaving one for token work', async () => {
      const realAuthenticate = runtime.api.authenticate.bind(runtime.api);
      let inFlight = 0;
      let mostInFlight = 0;
      const authenticate = vi.spyOn(runtime.api, 'authenticate').mockImplementation(async (token) => {
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return await realAuthenticate(token);
        } finally {
          inFlight -= 1;
        }
      });
      try {
        const sharedAddress = randomClientIp();
        const junk = Array.from({ length: 10 }, () =>
          getMe(`junk${randomUUID().replaceAll('-', '')}`, { clientIp: sharedAddress }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        const tokenPermit = await runtime.admission.acquire('token');
        expect(tokenPermit).not.toBeNull();
        tokenPermit?.release();
        const statuses = (await Promise.all(junk)).map((answer) => answer.status);
        expect(statuses.every((status) => status === 401)).toBe(true);
        expect(authenticate).toHaveBeenCalledTimes(10);
        expect(mostInFlight).toBe(2);
      } finally {
        authenticate.mockRestore();
      }
    });

    it(
      "keeps a flooding address's junk in its own lane: others are served, and so is its valid token",
      async () => {
        await enoughWindowLeft();
        const floodingAddress = randomClientIp();
        const otherAddress = randomClientIp();
        const client = await environment.createClient();
        const issued = await environment.issueTokens(client);
        // Past the routing threshold (30), far below the 429 limit (600).
        await seedLimiter(floodingAddress, 'api-invalid-token-ip', 30);

        const realAuthenticate = runtime.api.authenticate.bind(runtime.api);
        let releaseJunk: () => void = () => {};
        const junkMayFinish = new Promise<void>((resolve) => {
          releaseJunk = resolve;
        });
        let junkInFlight = 0;
        const authenticate = vi.spyOn(runtime.api, 'authenticate').mockImplementation(async (token) => {
          if (!token.startsWith('junk')) return realAuthenticate(token);
          junkInFlight += 1;
          try {
            // Junk holds its permit until the test lets it go: no timers decide the outcome.
            await junkMayFinish;
            return await realAuthenticate(token);
          } finally {
            junkInFlight -= 1;
          }
        });
        const lanes: string[] = [];
        const realAcquire = runtime.admission.acquire.bind(runtime.admission);
        const acquire = vi.spyOn(runtime.admission, 'acquire').mockImplementation((lane) => {
          lanes.push(lane);
          return realAcquire(lane);
        });
        try {
          const answeredJunk: number[] = [];
          const junk = Array.from({ length: 8 }, () =>
            getMe(`junk${randomUUID().replaceAll('-', '')}`, { clientIp: floodingAddress }).then((answer) => {
              answeredJunk.push(answer.status);
              return answer.status;
            }),
          );
          // One running and four queued in the flagged lane; the other three are refused at once.
          const deadline = Date.now() + 3000;
          while (answeredJunk.length < 3 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(answeredJunk).toEqual([503, 503, 503]);
          expect(junkInFlight).toBe(1);

          // Another address is served while every junk lookup is still held.
          const fromElsewhere = await getMe(issued.access_token, { clientIp: otherAddress });
          expect(fromElsewhere.status).toBe(200);
          expect(junkInFlight).toBe(1);
          expect(answeredJunk).toHaveLength(3);
          expect(lanes.filter((lane) => lane === 'api-flagged')).toHaveLength(8);

          releaseJunk();
          const junkStatuses = await Promise.all(junk);
          // The held one fails its lookup; a queued one may also have passed its 1 s deadline.
          expect(junkStatuses).toContain(401);
          expect(junkStatuses.every((status) => status === 401 || status === 503)).toBe(true);

          // The flooding address's own valid token is still served, in its lane, and never 429.
          lanes.length = 0;
          const fromFloodingAddress = await getMe(issued.access_token, { clientIp: floodingAddress });
          expect(fromFloodingAddress.status).toBe(200);
          expect(lanes).toEqual(['api-flagged']);
          lanes.length = 0;
          expect((await getMe(issued.access_token, { clientIp: otherAddress })).status).toBe(200);
          expect(lanes).toEqual(['api']);
        } finally {
          releaseJunk();
          authenticate.mockRestore();
          acquire.mockRestore();
        }
      },
      TEST_DEADLINE_MS,
    );

    it('answers 401 when the climber is deleted between the profile read and the subject insert', async () => {
      const developer = await environment.createClimber();
      const client = await environment.createClient({ owner: developer });
      const climber = await environment.createClimber();
      const authorization = await environment.authorize(client, { climber });
      const accessToken = (await environment.exchange(client, authorization)).body.access_token!;
      const deleter = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
      try {
        let commit: () => void = () => {};
        const committing = new Promise<void>((resolve) => {
          commit = resolve;
        });
        let deleted: () => void = () => {};
        const rowDeleted = new Promise<void>((resolve) => {
          deleted = resolve;
        });
        // The deletion runs (and cascades) first, then waits to commit.
        const deletion = deleter.begin(async (transaction) => {
          await transaction`delete from users where id = ${climber.userId}`;
          deleted();
          await committing;
        });
        await rowDeleted;
        const answering = getMe(accessToken);
        // Commit only once /v1/me is waiting on the foreign key of its subject insert.
        const waitingOnInsert = async () =>
          (
            await db.execute(sql`
              select 1 from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'
                and query ilike 'insert into "oauth_subjects"%'
            `)
          ).length > 0;
        const deadline = Date.now() + 5000;
        while (!(await waitingOnInsert()) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(await waitingOnInsert()).toBe(true);
        commit();
        await deletion;
        expectInvalidToken(await answering);
      } finally {
        await deleter.end({ timeout: 5 });
      }
    });

    it('answers 500 in the documented shape when the database fails, and logs no token or hash', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      const error = vi.spyOn(logger, 'error');
      const failing = vi
        .spyOn(runtime.api, 'readClimber')
        .mockRejectedValueOnce(Object.assign(new Error(`select … where token = 'secret-hash'`), { code: '08006' }));
      try {
        const answered = await getMe(issued.access_token);
        expect(answered.status).toBe(500);
        const body = ApiErrorResponseSchema.parse(JSON.parse(answered.body));
        expect(body.error).toBe('server_error');
        expect(answered.body).not.toContain('secret-hash');
        expect(answered.body).not.toContain('select');
        const logs = JSON.stringify(error.mock.calls);
        expect(logs).toContain('Partner API request failed');
        expect(logs).not.toContain('secret-hash');
        expect(logs).not.toContain(issued.access_token);
      } finally {
        failing.mockRestore();
        error.mockRestore();
      }
    });

    it('logs requestId and clientId, and never the token', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      const info = vi.spyOn(logger, 'info');
      try {
        const answered = await getMe(issued.access_token);
        const logCalls = info.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
        const logged = logCalls.find(([message]) => message === 'Partner API request');
        expect(logged?.[1]).toMatchObject({
          requestId: answered.headers['boardsesh-request-id'],
          clientId: client.clientId,
          route: 'me',
          status: 200,
        });
        expect(JSON.stringify(info.mock.calls)).not.toContain(issued.access_token);
      } finally {
        info.mockRestore();
      }
    });
  });

  describe('routes and the mode', () => {
    it.each([
      ['a trailing slash', 'GET', '/v1/me/'],
      ['upper case', 'GET', '/V1/ME'],
      ['HEAD', 'HEAD', ME_PATH],
      ['POST on /v1/me', 'POST', ME_PATH],
      ['GET on /v1/connection', 'GET', CONNECTION_PATH],
      ['an encoded letter', 'GET', '/v1/m%65'],
      ['the OpenAPI document, which arrives with L4', 'GET', '/v1/openapi.json'],
      ['a logbook route, which arrives with L4', 'GET', '/v1/logbook/changes'],
    ])('refuses %s with the API host 404', async (_label, method, path) => {
      const refused = await apiHost.send(method, path, { token: 'whatever' });
      expect(refused.status).toBe(404);
      if (method !== 'HEAD') expect(JSON.parse(refused.body)).toEqual({ error: 'Not found' });
    });

    it('closes the connection after a request that sent a body, which no route reads', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      const answered = await disconnect(issued.access_token, {
        // Asks to keep the socket, so only the handler can be the reason it closes.
        headers: { 'Content-Type': 'application/json', 'Content-Length': '2', Connection: 'keep-alive' },
        body: '{}',
      });
      expect(answered.status).toBe(204);
      expect(answered.headers.connection).toBe('close');
    });

    it('answers nothing but the API host', async () => {
      for (const host of ['ws.boardsesh.com', 'www.boardsesh.com', 'localhost']) {
        const elsewhere = await apiHost.send('GET', ME_PATH, { host, token: 'whatever' });
        expect(JSON.parse(elsewhere.body)).toEqual({ reachedDispatcher: true });
      }
    });

    it('with off, answers false and loads nothing', async () => {
      const loadRuntime = vi.fn(async () => runtime);
      const off = await startApiHost({ mode: 'off', loadRuntime });
      try {
        for (const [method, path] of [
          ['GET', ME_PATH],
          ['DELETE', CONNECTION_PATH],
          ['OPTIONS', ME_PATH],
        ]) {
          const refused = await off.send(method, path, { token: 'whatever' });
          expect(refused.status).toBe(404);
        }
        expect(loadRuntime).not.toHaveBeenCalled();
      } finally {
        await off.close();
      }
    });

    it('with hold, answers 503 with Retry-After 60 and loads nothing', async () => {
      const loadRuntime = vi.fn(async () => runtime);
      const held = await startApiHost({ mode: 'hold', loadRuntime });
      try {
        for (const [method, path] of [
          ['GET', ME_PATH],
          ['DELETE', CONNECTION_PATH],
          ['OPTIONS', CONNECTION_PATH],
        ]) {
          const answered = await held.send(method, path, { token: 'whatever' });
          expect(answered.status).toBe(503);
          expect(answered.headers['retry-after']).toBe('60');
          expect(answered.headers['cache-control']).toBe('no-store');
          expect(ApiErrorResponseSchema.parse(JSON.parse(answered.body)).error).toBe('server_error');
        }
        expect(loadRuntime).not.toHaveBeenCalled();
      } finally {
        await held.close();
      }
    });
  });

  describe('CORS', () => {
    const appOrigin = `https://v1-app-${randomUUID()}.example.test`;
    const otherOrigin = `https://v1-other-${randomUUID()}.example.test`;

    it('answers a preflight from a registered origin, without credentials', async () => {
      await environment.createClient({ publicClient: true, redirectOrigin: appOrigin });
      runtime.registeredOrigins.invalidate();
      for (const path of [ME_PATH, CONNECTION_PATH]) {
        const allowed = await apiHost.send('OPTIONS', path, { headers: { Origin: appOrigin } });
        expect(allowed.status).toBe(204);
        expect(allowed.headers['access-control-allow-origin']).toBe(appOrigin);
        expect(allowed.headers['access-control-allow-methods']).toContain('DELETE');
        expect(allowed.headers['access-control-allow-headers']).toContain('Authorization');
        expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();
      }
      const unknown = await apiHost.send('OPTIONS', ME_PATH, { headers: { Origin: 'https://evil.example.test' } });
      expect(unknown.headers['access-control-allow-origin']).toBeUndefined();
    });

    it("shows a success only to the app's own origin, and a 401 to any registered origin", async () => {
      const client = await environment.createClient({ publicClient: true, redirectOrigin: appOrigin });
      await environment.createClient({ publicClient: true, redirectOrigin: otherOrigin });
      runtime.registeredOrigins.invalidate();
      const issued = await environment.issueTokens(client);

      const own = await getMe(issued.access_token, { headers: { Origin: appOrigin } });
      expect(own.status).toBe(200);
      expect(own.headers['access-control-allow-origin']).toBe(appOrigin);
      expect(own.headers['access-control-allow-credentials']).toBeUndefined();
      expect(own.headers.vary).toBe('Origin');

      const another = await getMe(issued.access_token, { headers: { Origin: otherOrigin } });
      expect(another.status).toBe(200);
      expect(another.headers['access-control-allow-origin']).toBeUndefined();

      const expired = await getMe(`expired${randomUUID().replaceAll('-', '')}`, { headers: { Origin: otherOrigin } });
      expect(expired.status).toBe(401);
      expect(expired.headers['access-control-allow-origin']).toBe(otherOrigin);
      expect(expired.headers['access-control-expose-headers']).toContain('WWW-Authenticate');

      const unregistered = await getMe(`expired${randomUUID().replaceAll('-', '')}`, {
        headers: { Origin: 'https://evil.example.test' },
      });
      expect(unregistered.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});

describe('the deployed /v1 routes', () => {
  it(
    'serve the real server with the mode on, and keep partner tokens out of GraphQL',
    async () => {
      const environment = await createPartnerTestEnvironment();
      const { startServer } = await import('../server');
      vi.stubEnv('PARTNER_OAUTH_MODE', 'allowlist');
      vi.stubEnv('PARTNER_OAUTH_SECRETS', '1:partner-oauth-test-secret-never-deployed-0123456789');
      vi.stubEnv('PORT', '0');
      const server = await startServer();
      const { getPartnerAuthorityRuntime } = await import('../auth/partner/authority');
      try {
        if (!server.httpServer.listening) await once(server.httpServer, 'listening');
        const { port } = server.httpServer.address() as AddressInfo;
        const send = (
          method: string,
          path: string,
          host: string,
          headers: Record<string, string> = {},
          body?: string,
        ) =>
          new Promise<SentResponse>((resolve, reject) => {
            const outgoing = request(
              {
                port,
                path,
                method,
                agent: false,
                headers: { Host: host, 'X-Forwarded-For': randomClientIp(), ...headers },
              },
              (incoming) => {
                const chunks: Buffer[] = [];
                incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
                incoming.on('end', () =>
                  resolve({
                    status: incoming.statusCode ?? 0,
                    headers: incoming.headers,
                    body: Buffer.concat(chunks).toString('utf8'),
                  }),
                );
              },
            );
            outgoing.on('error', reject);
            outgoing.end(body);
          });

        expectInvalidToken(await send('GET', ME_PATH, API_HOSTNAME), 'Bearer');
        // A token minted for another issuer's resource names a different audience here.
        const client = await environment.createClient();
        const issued = await environment.issueTokens(client);
        expectInvalidToken(
          await send('GET', ME_PATH, API_HOSTNAME, { Authorization: `Bearer ${issued.access_token}` }),
        );
        expectInvalidToken(
          await send('DELETE', CONNECTION_PATH, API_HOSTNAME, { Authorization: `Bearer ${issued.access_token}` }),
        );

        // Other hosts never see /v1.
        expect((await send('GET', ME_PATH, 'ws.boardsesh.com')).status).toBe(404);

        // A partner token is nobody on GraphQL.
        const graphql = await send(
          'POST',
          '/graphql',
          'ws.boardsesh.com',
          { 'Content-Type': 'application/json', Authorization: `Bearer ${issued.access_token}` },
          JSON.stringify({ query: '{ profile { id } }' }),
        );
        expect(graphql.status).toBe(200);
        expect(JSON.parse(graphql.body).data).toEqual({ profile: null });
      } finally {
        vi.unstubAllEnvs();
        server.cleanupIntervals();
        await new Promise<void>((resolve) => server.wss.close(() => resolve()));
        await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
        await (await getPartnerAuthorityRuntime()).close();
        await environment.close();
      }
    },
    TEST_DEADLINE_MS,
  );
});
