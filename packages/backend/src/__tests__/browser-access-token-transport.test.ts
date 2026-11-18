/**
 * #7596 B3a in the real server: a browser access token over real GraphQL HTTP
 * and one real WebSocket. It authenticates while its session is live, is
 * refused (401) once the session ends, gives leases the session's expiry,
 * proves a recent sign-in only for a fresh login, and its socket is closed by
 * the admission sweep after sign-out.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { PARTNER_CONSOLE_RECENT_SIGN_IN_REQUIRED } from '@boardsesh/auth-protocol/partner-oauth';
import { authSession, users } from '@boardsesh/db/schema/auth';
import { notificationDevices } from '@boardsesh/db/schema';
import { db } from '../db/client';
import { redisClientManager } from '../redis/client';
import { startFakePosthogFlags, type FakePosthogFlags } from './helpers/fake-posthog-flags';
import { __resetPartnerRegistrationDeploymentForTests } from '../graphql/resolvers/oauth-clients/partner-registration';
import {
  browserAccessTokenKey,
  issueBrowserAccessToken,
  selectLiveSessions,
} from '../auth/authority/browser-access-token';
import { denyFirstPartySession } from '../auth/authority/lineage';
import { CARRIED_WEB_SESSION_LINEAGE_PREFIX } from '../auth/authority/web-session';
import { sessionTokenDigest } from '../auth/authority/session-token';

const TEST_DEADLINE_MS = 60_000;
const MINUTE_MS = 60_000;
const ACCESS_SECRET = 'synthetic-browser-access-token-transport-secret';
const PARTNER_SECRET = '1:partner-oauth-test-secret-never-deployed-0123456789';
const TERMS_VERSION = 'browser-token-test-terms-1';
const REFUSED = {
  status: 401,
  body: { errors: [{ message: 'Authentication is required', extensions: { code: 'UNAUTHENTICATED' } }] },
} as const;

type GraphQLReply = {
  status: number;
  body: { data?: Record<string, unknown> | null; errors?: { message: string; extensions?: Record<string, unknown> }[] };
};

let posthog: FakePosthogFlags;
let port = 0;
let stopServer: () => Promise<void> = async () => {};

function graphql(query: string, bearer?: string, variables?: Record<string, unknown>): Promise<GraphQLReply> {
  const payload = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        port,
        path: '/graphql',
        method: 'POST',
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Forwarded-For': `198.18.${randomBytes(1)[0]}.${randomBytes(1)[0]}`,
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () =>
          resolve({
            status: incoming.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as GraphQLReply['body'],
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
}

async function climber() {
  const id = `browser-token-${randomUUID()}`;
  await db.insert(users).values({ id, email: `${id}@example.invalid`, emailVerified: new Date() });
  return id;
}

/** A session row as each writer leaves it, and a token the access command would sign for it. */
async function sessionWithToken(
  userId: string,
  shape: { lineage?: 'bridge' | 'carried'; signedInAgoMs?: number; expiresInMs?: number } = {},
) {
  const sessionId = randomUUID();
  await db.insert(authSession).values({
    id: sessionId,
    token: sessionTokenDigest(randomBytes(32).toString('base64url')),
    userId,
    expiresAt: new Date(Date.now() + (shape.expiresInMs ?? 30 * 24 * 60 * MINUTE_MS)),
    updatedAt: new Date(),
    originalAuthenticatedAt: new Date(Date.now() - (shape.signedInAgoMs ?? 60_000)),
    legacyLineageId:
      shape.lineage === 'bridge'
        ? `session:${randomBytes(32).toString('hex')}`
        : shape.lineage === 'carried'
          ? `${CARRIED_WEB_SESSION_LINEAGE_PREFIX}${sessionId}`
          : null,
    revocationGeneration: 0,
  });
  const session = (await selectLiveSessions(db, [sessionId], new Date())).get(sessionId);
  if (!session) throw new Error('Synthetic session not live');
  const issued = await issueBrowserAccessToken(browserAccessTokenKey(ACCESS_SECRET), session, new Date());
  if (!issued) throw new Error('No token issued');
  return { session, token: issued.token };
}

beforeAll(async () => {
  await redisClientManager.connect();
  posthog = await startFakePosthogFlags();
  for (const [name, value] of Object.entries({
    ...posthog.environment,
    PARTNER_OAUTH_MODE: 'allowlist',
    PARTNER_OAUTH_SECRETS: PARTNER_SECRET,
    PARTNER_DEVELOPER_TERMS_VERSION: TERMS_VERSION,
    CURRENT_STORE_WEB_SESSION_MODE: 'backend-staging',
    AUTH_BROWSER_ACCESS_TOKEN_SECRET: ACCESS_SECRET,
    AUTH_CUTOFF_ENFORCEMENT: 'enforce',
    PORT: '0',
  }))
    vi.stubEnv(name, value);
  __resetPartnerRegistrationDeploymentForTests();
  const { startServer } = await import('../server');
  const server = await startServer();
  if (!server.httpServer.listening) await once(server.httpServer, 'listening');
  port = (server.httpServer.address() as AddressInfo).port;
  stopServer = async () => {
    server.cleanupIntervals();
    await new Promise<void>((resolve) => server.wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
  };
}, TEST_DEADLINE_MS);

afterAll(async () => {
  await stopServer();
  await posthog?.close();
  vi.unstubAllEnvs();
  __resetPartnerRegistrationDeploymentForTests();
  const { getPartnerAuthorityRuntime } = await import('../auth/partner/authority');
  await getPartnerAuthorityRuntime().then(
    (runtime) => runtime.close(),
    () => undefined,
  );
  await redisClientManager.disconnect();
});

describe('a browser access token over GraphQL HTTP', () => {
  it(
    'authenticates while its session is live and answers 401 once it signed out',
    async () => {
      const userId = await climber();
      const { session, token } = await sessionWithToken(userId);
      expect(await graphql('{ authenticatedUserId }', token)).toEqual({
        status: 200,
        body: { data: { authenticatedUserId: userId } },
      });
      await denyFirstPartySession(db, session);
      expect(await graphql('{ authenticatedUserId }', token)).toEqual(REFUSED);
      // A token that claims the browser audience but carries another account is refused, not anonymous.
      const issuedAt = Math.floor(Date.now() / 1000);
      const unsigned = await new SignJWT({ sid: session.authSessionId, gen: 0 })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(userId)
        .setIssuer('boardsesh')
        .setAudience('boardsesh-browser')
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + 600)
        .sign(new TextEncoder().encode('a-key-the-backend-never-signs-with-0123'));
      expect(await graphql('{ authenticatedUserId }', unsigned)).toEqual(REFUSED);
      // The app's token is unchanged.
      const appToken = await new SignJWT({ gen: 0, ngen: 0 })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(userId)
        .setIssuer('boardsesh')
        .setAudience('boardsesh-mobile')
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(process.env.NEXTAUTH_SECRET));
      expect((await graphql('{ authenticatedUserId }', appToken)).body).toEqual({
        data: { authenticatedUserId: userId },
      });
    },
    TEST_DEADLINE_MS,
  );

  it(
    'leases a notification device for the session, not for the 15-minute token',
    async () => {
      const userId = await climber();
      const { session, token } = await sessionWithToken(userId, { expiresInMs: 2 * 60 * MINUTE_MS });
      const installationId = `browser-token-${randomUUID()}`;
      const reply = await graphql(
        'mutation Register($input: RegisterNotificationDeviceInput!) { registerNotificationDevice(input: $input) }',
        token,
        {
          input: {
            installationId,
            token: `ExponentPushToken[${randomBytes(8).toString('hex')}]`,
            platform: 'ios',
            locale: 'en-US',
          },
        },
      );
      expect(reply.body.errors).toBeUndefined();
      const [device] = await db
        .select()
        .from(notificationDevices)
        .where(eq(notificationDevices.installationId, installationId));
      expect(device.expiresAt.getTime()).toBe(session.expiresAt.getTime());
    },
    TEST_DEADLINE_MS,
  );
});

describe('a browser access token on a WebSocket', () => {
  it(
    'is closed by the admission sweep once its session signs out',
    async () => {
      const userId = await climber();
      const { session, token } = await sessionWithToken(userId);
      const socket = new WebSocket(`ws://127.0.0.1:${port}/graphql`, 'graphql-transport-ws');
      const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
      const acknowledged = new Promise<void>((resolve) =>
        socket.on('message', (message) => {
          if ((JSON.parse(String(message)) as { type: string }).type === 'connection_ack') resolve();
        }),
      );
      await once(socket, 'open');
      socket.send(JSON.stringify({ type: 'connection_init', payload: { authToken: token } }));
      await acknowledged;
      await denyFirstPartySession(db, session);
      const code = await Promise.race([
        closed,
        new Promise<'still open'>((resolve) => setTimeout(() => resolve('still open'), 10_000)),
      ]);
      expect(code).toBe(4401);
    },
    TEST_DEADLINE_MS,
  );
});

describe('the developer console with a browser access token', () => {
  it(
    'accepts a change only from a login under five minutes old',
    async () => {
      const developerId = await climber();
      posthog.invite(developerId);
      const fresh = await sessionWithToken(developerId, { signedInAgoMs: 60_000 });
      const created = await graphql(
        'mutation Create($input: CreateOAuthClientInput!) { createOAuthClient(input: $input) { client { clientId } } }',
        fresh.token,
        {
          input: {
            name: 'Hangboard Planner',
            publisherName: 'Planner Labs',
            homepageUrl: 'https://planner.example.test/',
            privacyPolicyUrl: 'https://planner.example.test/privacy',
            applicationType: 'WEB',
            tokenEndpointAuthMethod: 'CLIENT_SECRET_BASIC',
            redirectUris: ['https://planner.example.test/oauth/boardsesh'],
            acceptedTermsVersion: TERMS_VERSION,
          },
        },
      );
      expect(created.body.errors).toBeUndefined();
      const { clientId } = (created.body.data as { createOAuthClient: { client: { clientId: string } } })
        .createOAuthClient.client;
      const rotate = (bearer: string) =>
        graphql(
          'mutation Rotate($clientId: ID!) { rotateOAuthClientSecret(clientId: $clientId) { clientSecret } }',
          bearer,
          {
            clientId,
          },
        );
      for (const [label, shape] of Object.entries({
        bridged: { lineage: 'bridge', signedInAgoMs: 30_000 },
        carried: { lineage: 'carried', signedInAgoMs: 30_000 },
        'an old login': { signedInAgoMs: 10 * MINUTE_MS },
      } as const)) {
        const reply = await rotate((await sessionWithToken(developerId, shape)).token);
        expect(reply.body.errors?.[0]?.extensions, label).toMatchObject({
          code: 'FORBIDDEN',
          reason: PARTNER_CONSOLE_RECENT_SIGN_IN_REQUIRED,
        });
      }
      const accepted = await rotate(fresh.token);
      expect(accepted.body.errors).toBeUndefined();
    },
    TEST_DEADLINE_MS,
  );
});
