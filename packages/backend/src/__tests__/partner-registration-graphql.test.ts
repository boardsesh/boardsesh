import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext, CreateOAuthClientInput } from '@boardsesh/shared-schema';
import { oauthClient, users } from '@boardsesh/db/schema/auth';
import { db } from '../db/client';
import { API_HOSTNAME } from '../handlers/api-host';
import { redisClientManager } from '../redis/client';
import { createPartnerTestEnvironment } from '../auth/partner/__tests__/partner-fixture';
import {
  __resetPartnerRegistrationDeploymentForTests,
  oauthClientMutations,
  oauthClientQueries,
} from '../graphql/resolvers/oauth-clients/partner-registration';

const TEST_DEADLINE_MS = 60_000;
const MINUTE_MS = 60_000;
const PARTNER_SECRET = '1:partner-oauth-test-secret-never-deployed-0123456789';

const CREATE_MUTATION = /* GraphQL */ `
  mutation Create($input: CreateOAuthClientInput!) {
    createOAuthClient(input: $input) {
      clientSecret
      client {
        clientId
        name
        publisherName
        applicationType
        tokenEndpointAuthMethod
        redirectUris
        maxActiveConnections
        maxNewConnectionsPerDay
        activeConnections
        suspendedAt
      }
    }
  }
`;
const LIST_QUERY = /* GraphQL */ `
  query List {
    myOAuthClients {
      clientId
      name
    }
  }
`;
/** A published terms version for this deployment; the shipped one may still be a draft. */
const TERMS_VERSION = 'graphql-test-terms-1';

const APP_INPUT: CreateOAuthClientInput = {
  name: 'Hangboard Planner',
  publisherName: 'Planner Labs',
  homepageUrl: 'https://planner.example.test/',
  privacyPolicyUrl: 'https://planner.example.test/privacy',
  applicationType: 'WEB',
  tokenEndpointAuthMethod: 'CLIENT_SECRET_BASIC',
  redirectUris: ['https://planner.example.test/oauth/boardsesh'],
  acceptedTermsVersion: TERMS_VERSION,
};

interface GraphQLReply {
  status: number;
  body: {
    data?: Record<string, unknown> | null;
    errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
  };
}

function limiterKey(identity: string, operation: string): string {
  return `ratelimit:${identity}:${operation}:${Math.floor(Date.now() / MINUTE_MS)}`;
}

async function limiterCount(identity: string, operation: string): Promise<number | null> {
  const stored = await redisClientManager.getClients().publisher.get(limiterKey(identity, operation));
  return stored === null ? null : Number(stored);
}

async function seedLimiter(identity: string, operation: string, count: number): Promise<void> {
  await redisClientManager.getClients().publisher.set(limiterKey(identity, operation), String(count), 'EX', 120);
}

/** Limits use fixed one-minute windows, so a counting test must not straddle a rollover. */
async function enoughWindowLeft(minimumMs = 15_000): Promise<void> {
  const remainingMs = MINUTE_MS - (Date.now() % MINUTE_MS);
  if (remainingMs < minimumMs) await new Promise((resolve) => setTimeout(resolve, remainingMs + 50));
}

// 254 random addresses let two tests draw the same one, and the address limit is
// shared within a minute, so one test's seeded count refused another's request.
// Each call gets its own address instead, from a run-specific start: a limiter
// key outlives its run by up to two minutes. 198.51.0.0-198.51.99.255, 25,600 of them.
let clientIpCounter = randomInt(0, 25_600);
function randomClientIp(): string {
  clientIpCounter = (clientIpCounter + 1) % 25_600;
  return `198.51.${clientIpCounter >> 8}.${clientIpCounter & 255}`;
}

/** A real first-party bearer token, the kind the app and the website send. */
function firstPartyToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer('boardsesh')
    .setAudience('boardsesh-mobile')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.NEXTAUTH_SECRET));
}

async function createDeveloper(verified = true): Promise<string> {
  const developerId = `developer-${randomUUID()}`;
  await db
    .insert(users)
    .values({ id: developerId, email: `${developerId}@example.invalid`, emailVerified: verified ? new Date() : null });
  return developerId;
}

async function startRealServer(environment: Record<string, string>) {
  for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
  vi.stubEnv('PORT', '0');
  __resetPartnerRegistrationDeploymentForTests();
  const { startServer } = await import('../server');
  const server = await startServer();
  if (!server.httpServer.listening) await once(server.httpServer, 'listening');
  const { port } = server.httpServer.address() as AddressInfo;

  function graphql(
    operation: { query: string; variables?: Record<string, unknown> },
    {
      bearer,
      clientIp = randomClientIp(),
      host,
      headers = {},
    }: { bearer?: string; clientIp?: string; host?: string; headers?: Record<string, string> } = {},
  ): Promise<GraphQLReply> {
    const payload = JSON.stringify(operation);
    return new Promise((resolve, reject) => {
      const outgoing = request(
        {
          port,
          path: '/graphql',
          method: 'POST',
          agent: false,
          headers: {
            ...(host ? { Host: host } : {}),
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'X-Forwarded-For': clientIp,
            ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
            ...headers,
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body: GraphQLReply['body'] = {};
            try {
              body = JSON.parse(text) as GraphQLReply['body'];
            } catch {
              body = {};
            }
            resolve({ status: incoming.statusCode ?? 0, body });
          });
        },
      );
      outgoing.on('error', reject);
      outgoing.end(payload);
    });
  }

  async function stop() {
    server.cleanupIntervals();
    await new Promise<void>((resolve) => server.wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
  }

  return { graphql, stop };
}

function errorOf(reply: GraphQLReply) {
  return reply.body.errors?.[0];
}

beforeAll(async () => {
  await redisClientManager.connect();
});

afterAll(async () => {
  await redisClientManager.disconnect();
  // The one partner authority this process built, for the allowlist and open
  // tests. Building it here instead would fail without secrets, which is fine.
  const { getPartnerAuthorityRuntime } = await import('../auth/partner/authority');
  await getPartnerAuthorityRuntime().then(
    (runtime) => runtime.close(),
    () => undefined,
  );
});

function resetDeployment(): void {
  vi.unstubAllEnvs();
  __resetPartnerRegistrationDeploymentForTests();
}

describe('with PARTNER_OAUTH_MODE off, in the real server', () => {
  afterAll(() => {
    vi.doUnmock('../auth/partner/authority');
    resetDeployment();
  });

  it(
    'answers every developer operation NOT_FOUND and touches nothing',
    async () => {
      let authorityLoaded = false;
      vi.doMock('../auth/partner/authority', () => {
        authorityLoaded = true;
        return { getPartnerAuthorityRuntime: () => Promise.reject(new Error('must not load')) };
      });
      const developerId = await createDeveloper();
      const server = await startRealServer({
        PARTNER_OAUTH_MODE: 'off',
        PARTNER_OAUTH_DEVELOPER_ALLOWLIST: developerId,
        PARTNER_OAUTH_SECRETS: PARTNER_SECRET,
      });
      try {
        await enoughWindowLeft();
        const bearer = await firstPartyToken(developerId);
        const clientIp = randomClientIp();
        const operations = [
          { query: CREATE_MUTATION, variables: { input: APP_INPUT } },
          { query: LIST_QUERY },
          {
            query: `mutation { updateOAuthClient(input: { clientId: "x", name: "Crimp Lab" }) { clientId } }`,
          },
          { query: `mutation { rotateOAuthClientSecret(clientId: "x") { clientSecret } }` },
          { query: `mutation { deleteOAuthClient(clientId: "x") }` },
        ];
        for (const operation of operations) {
          for (const caller of [{ bearer, clientIp }, { clientIp }]) {
            const reply = await server.graphql(operation, caller);
            expect(errorOf(reply)?.extensions?.code).toBe('NOT_FOUND');
            expect(errorOf(reply)?.message).toBe('Developer apps are not available.');
          }
        }
        // Answered before the limits, the database and Better Auth.
        expect(await limiterCount(developerId, 'oauthClientWrite')).toBeNull();
        expect(await limiterCount(developerId, 'oauthClientRead')).toBeNull();
        expect(await limiterCount(`oauth-client-ip:${clientIp}`, 'oauthClientWrite')).toBeNull();
        expect(await db.$count(oauthClient, eq(oauthClient.userId, developerId))).toBe(0);
        expect(authorityLoaded).toBe(false);
        // And the API host still serves nothing but /health.
        expect((await server.graphql({ query: LIST_QUERY }, { bearer, host: API_HOSTNAME })).status).toBe(404);
      } finally {
        await server.stop();
      }
    },
    TEST_DEADLINE_MS,
  );
});

describe('with PARTNER_OAUTH_MODE allowlist, in the real server', () => {
  let server: Awaited<ReturnType<typeof startRealServer>>;
  let developerId: string;
  /** A second listed developer, whose write budget no other test spends. */
  let secondDeveloperId: string;
  /** A third, for the address-limit tests, which each spend one write. */
  let addressDeveloperId: string;

  beforeAll(async () => {
    developerId = await createDeveloper();
    secondDeveloperId = await createDeveloper();
    addressDeveloperId = await createDeveloper();
    server = await startRealServer({
      PARTNER_OAUTH_MODE: 'allowlist',
      PARTNER_OAUTH_DEVELOPER_ALLOWLIST: `someone-else,${developerId},${secondDeveloperId},${addressDeveloperId}`,
      PARTNER_OAUTH_SECRETS: PARTNER_SECRET,
      PARTNER_DEVELOPER_TERMS_VERSION: TERMS_VERSION,
    });
  }, TEST_DEADLINE_MS);

  afterAll(async () => {
    await server?.stop();
    resetDeployment();
  });

  it(
    "registers an app on the developer's own account and shows its secret once",
    async () => {
      const bearer = await firstPartyToken(developerId);
      const created = await server.graphql({ query: CREATE_MUTATION, variables: { input: APP_INPUT } }, { bearer });
      expect(created.body.errors).toBeUndefined();
      const result = created.body.data?.createOAuthClient as {
        clientSecret: string;
        client: Record<string, unknown> & { clientId: string };
      };
      expect(result.clientSecret).toMatch(/^[A-Za-z]{32}$/);
      expect(result.client).toMatchObject({
        name: 'Hangboard Planner',
        publisherName: 'Planner Labs',
        applicationType: 'WEB',
        tokenEndpointAuthMethod: 'CLIENT_SECRET_BASIC',
        maxActiveConnections: 25,
        maxNewConnectionsPerDay: 20,
        activeConnections: 0,
        suspendedAt: null,
      });
      const [row] = await db.select().from(oauthClient).where(eq(oauthClient.clientId, result.client.clientId));
      expect(row).toMatchObject({ userId: developerId, skipConsent: false, requirePKCE: true });

      const listed = await server.graphql({ query: LIST_QUERY }, { bearer });
      expect(listed.body.data?.myOAuthClients).toEqual([
        { clientId: result.client.clientId, name: 'Hangboard Planner' },
      ]);
      // There is no field that could carry the secret again.
      const asked = await server.graphql({ query: `query { myOAuthClients { clientSecret } }` }, { bearer });
      expect(errorOf(asked)?.message).toMatch(/Cannot query field "clientSecret"/);
    },
    TEST_DEADLINE_MS,
  );

  it(
    'refuses anonymous callers and partner OAuth tokens, and charges them nothing',
    async () => {
      await enoughWindowLeft();
      const environment = await createPartnerTestEnvironment();
      try {
        const partnerClient = await environment.createClient();
        const partnerTokens = await environment.issueTokens(partnerClient);
        const clientIp = randomClientIp();
        const appsBefore = await db.$count(oauthClient);
        for (const bearer of [undefined, partnerTokens.access_token, partnerTokens.refresh_token]) {
          const reply = await server.graphql(
            { query: CREATE_MUTATION, variables: { input: APP_INPUT } },
            { bearer, clientIp },
          );
          expect(errorOf(reply)?.message).toMatch(/Authentication required/);
        }
        expect(await limiterCount(`oauth-client-ip:${clientIp}`, 'oauthClientWrite')).toBeNull();
        expect(await db.$count(oauthClient)).toBe(appsBefore);
      } finally {
        await environment.close();
      }
    },
    TEST_DEADLINE_MS,
  );

  it(
    'refuses a signed-in account that is not on the allowlist, charging only its own bucket',
    async () => {
      await enoughWindowLeft();
      const outsiderId = await createDeveloper();
      const clientIp = randomClientIp();
      const reply = await server.graphql(
        { query: CREATE_MUTATION, variables: { input: APP_INPUT } },
        { bearer: await firstPartyToken(outsiderId), clientIp },
      );
      expect(errorOf(reply)?.extensions).toMatchObject({ code: 'FORBIDDEN', reason: 'NOT_ALLOWLISTED' });
      expect(await limiterCount(outsiderId, 'oauthClientWrite')).toBe(1);
      expect(await limiterCount(`oauth-client-ip:${clientIp}`, 'oauthClientWrite')).toBeNull();
      expect(await db.$count(oauthClient, eq(oauthClient.userId, outsiderId))).toBe(0);
    },
    TEST_DEADLINE_MS,
  );

  it(
    'lets no number of throwaway accounts at one address lock a listed developer out',
    async () => {
      await enoughWindowLeft();
      const sharedAddress = randomClientIp();
      // Three accounts at their own limit of 10 a minute, one past it: more than the address's 30.
      for (let account = 0; account < 3; account += 1) {
        const bearer = await firstPartyToken(await createDeveloper());
        for (let attempt = 0; attempt < 11; attempt += 1) {
          const reply = await server.graphql(
            { query: CREATE_MUTATION, variables: { input: APP_INPUT } },
            { bearer, clientIp: sharedAddress },
          );
          expect(errorOf(reply)?.extensions?.code).toBe(attempt < 10 ? 'FORBIDDEN' : 'RATE_LIMITED');
        }
      }
      expect(await limiterCount(`oauth-client-ip:${sharedAddress}`, 'oauthClientWrite')).toBeNull();
      const listed = await server.graphql(
        { query: CREATE_MUTATION, variables: { input: APP_INPUT } },
        { bearer: await firstPartyToken(addressDeveloperId), clientIp: sharedAddress },
      );
      expect(listed.body.errors).toBeUndefined();
      expect(await limiterCount(`oauth-client-ip:${sharedAddress}`, 'oauthClientWrite')).toBe(1);
    },
    TEST_DEADLINE_MS,
  );

  it(
    'limits registration per developer',
    async () => {
      await enoughWindowLeft();
      const bearer = await firstPartyToken(developerId);
      await seedLimiter(developerId, 'oauthClientWrite', 10);
      const reply = await server.graphql({ query: CREATE_MUTATION, variables: { input: APP_INPUT } }, { bearer });
      expect(errorOf(reply)?.extensions).toMatchObject({ code: 'RATE_LIMITED', operation: 'oauthClientWrite' });
      // Reads have their own bucket.
      expect((await server.graphql({ query: LIST_QUERY }, { bearer })).body.errors).toBeUndefined();
    },
    TEST_DEADLINE_MS,
  );

  it(
    'limits registration per address, across accounts',
    async () => {
      await enoughWindowLeft();
      const clientIp = randomClientIp();
      await seedLimiter(`oauth-client-ip:${clientIp}`, 'oauthClientWrite', 30);
      const appsBefore = await db.$count(oauthClient, eq(oauthClient.userId, addressDeveloperId));
      const reply = await server.graphql(
        { query: CREATE_MUTATION, variables: { input: APP_INPUT } },
        { bearer: await firstPartyToken(addressDeveloperId), clientIp },
      );
      expect(errorOf(reply)?.extensions).toMatchObject({ code: 'RATE_LIMITED', operation: 'oauthClientWrite' });
      expect(await db.$count(oauthClient, eq(oauthClient.userId, addressDeveloperId))).toBe(appsBefore);
    },
    TEST_DEADLINE_MS,
  );

  it(
    'keys the address limit on the trusted address, not a cf-connecting-ip from a peer that is no Cloudflare edge',
    async () => {
      await enoughWindowLeft();
      // The test server's peer is loopback, which stands in for the private
      // ingress: its last X-Forwarded-For hop is the address that counts.
      const ingressAddress = randomClientIp();
      const spoofedAddress = randomClientIp();
      await seedLimiter(`oauth-client-ip:${ingressAddress}`, 'oauthClientWrite', 30);
      const reply = await server.graphql(
        { query: CREATE_MUTATION, variables: { input: APP_INPUT } },
        {
          bearer: await firstPartyToken(addressDeveloperId),
          clientIp: ingressAddress,
          headers: { 'CF-Connecting-IP': spoofedAddress },
        },
      );
      expect(errorOf(reply)?.extensions).toMatchObject({ code: 'RATE_LIMITED', operation: 'oauthClientWrite' });
      expect(await limiterCount(`oauth-client-ip:${spoofedAddress}`, 'oauthClientWrite')).toBeNull();
    },
    TEST_DEADLINE_MS,
  );

  it(
    'counts an IPv6 client as its /64',
    async () => {
      await enoughWindowLeft();
      const prefix = `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}:7`;
      await seedLimiter(`oauth-client-ip:${prefix}::/64`, 'oauthClientWrite', 30);
      const reply = await server.graphql(
        { query: CREATE_MUTATION, variables: { input: APP_INPUT } },
        { bearer: await firstPartyToken(addressDeveloperId), clientIp: `${prefix}::beef` },
      );
      expect(errorOf(reply)?.extensions).toMatchObject({ code: 'RATE_LIMITED', operation: 'oauthClientWrite' });
    },
    TEST_DEADLINE_MS,
  );

  it(
    'shows a refusal the developer can act on',
    async () => {
      const bearer = await firstPartyToken(secondDeveloperId);
      const reply = await server.graphql(
        {
          query: CREATE_MUTATION,
          variables: { input: { ...APP_INPUT, redirectUris: ['https://planner.example.test/cb#done'] } },
        },
        { bearer },
      );
      expect(errorOf(reply)?.extensions).toMatchObject({ code: 'BAD_USER_INPUT', reason: 'INVALID_INPUT' });
      expect(errorOf(reply)?.message).toMatch(/fragment/);
    },
    TEST_DEADLINE_MS,
  );

  it(
    'refuses a registration without the current developer terms',
    async () => {
      await enoughWindowLeft();
      const bearer = await firstPartyToken(secondDeveloperId);
      const { acceptedTermsVersion: _required, ...withoutTerms } = APP_INPUT;
      const missing = await server.graphql({ query: CREATE_MUTATION, variables: { input: withoutTerms } }, { bearer });
      expect(errorOf(missing)?.message).toMatch(/acceptedTermsVersion/);

      const outdated = await server.graphql(
        { query: CREATE_MUTATION, variables: { input: { ...APP_INPUT, acceptedTermsVersion: '2026-01-01' } } },
        { bearer },
      );
      expect(errorOf(outdated)?.extensions).toMatchObject({ code: 'BAD_USER_INPUT', reason: 'INVALID_INPUT' });
      expect(errorOf(outdated)?.message).toMatch(/Accept the current Boardsesh developer terms/);
    },
    TEST_DEADLINE_MS,
  );

  it(
    'requires a publisher at registration, holds it to the name rules, and lets an edit change it',
    async () => {
      await enoughWindowLeft();
      const bearer = await firstPartyToken(secondDeveloperId);
      const { publisherName: _required, ...withoutPublisher } = APP_INPUT;
      const missing = await server.graphql(
        { query: CREATE_MUTATION, variables: { input: withoutPublisher } },
        { bearer },
      );
      expect(errorOf(missing)?.message).toMatch(/publisherName/);

      const imitating = await server.graphql(
        { query: CREATE_MUTATION, variables: { input: { ...APP_INPUT, publisherName: 'B0ardsesh Team' } } },
        { bearer },
      );
      expect(errorOf(imitating)?.extensions).toMatchObject({ code: 'BAD_USER_INPUT', reason: 'INVALID_INPUT' });
      expect(errorOf(imitating)?.message).toBe('The publisher name cannot use or imitate "Boardsesh".');

      const created = await server.graphql({ query: CREATE_MUTATION, variables: { input: APP_INPUT } }, { bearer });
      expect(created.body.errors).toBeUndefined();
      const { clientId } = (created.body.data as { createOAuthClient: { client: { clientId: string } } })
        .createOAuthClient.client;
      const updated = await server.graphql(
        {
          query: /* GraphQL */ `
            mutation Update($input: UpdateOAuthClientInput!) {
              updateOAuthClient(input: $input) {
                clientId
                name
                publisherName
              }
            }
          `,
          variables: { input: { clientId, publisherName: 'Planner Labs Ltd' } },
        },
        { bearer },
      );
      expect(updated.body.errors).toBeUndefined();
      expect(updated.body.data?.updateOAuthClient).toEqual({
        clientId,
        name: APP_INPUT.name,
        publisherName: 'Planner Labs Ltd',
      });
    },
    TEST_DEADLINE_MS,
  );
});

describe('the other modes', () => {
  afterEach(resetDeployment);

  const context = (userId: string): ConnectionContext => ({
    connectionId: `test-${randomUUID()}`,
    isAuthenticated: true,
    userId,
  });

  it('pauses every operation in hold, before anything else', async () => {
    vi.stubEnv('PARTNER_OAUTH_MODE', 'hold');
    const developerId = await createDeveloper();
    vi.stubEnv('PARTNER_OAUTH_DEVELOPER_ALLOWLIST', developerId);
    await expect(
      oauthClientQueries.myOAuthClients(undefined, {}, { connectionId: 'anonymous', isAuthenticated: false }),
    ).rejects.toMatchObject({ extensions: { code: 'SERVICE_UNAVAILABLE', retryAfterSeconds: 60 } });
    await expect(
      oauthClientMutations.deleteOAuthClient(undefined, { clientId: 'x' }, context(developerId)),
    ).rejects.toMatchObject({ extensions: { code: 'SERVICE_UNAVAILABLE' } });
  });

  it('still registers only allowlisted developers in open, until developer email has a real proof', async () => {
    vi.stubEnv('PARTNER_OAUTH_MODE', 'open');
    vi.stubEnv('PARTNER_OAUTH_SECRETS', PARTNER_SECRET);
    const listed = await createDeveloper();
    const verifiedOutsider = await createDeveloper();
    vi.stubEnv('PARTNER_OAUTH_DEVELOPER_ALLOWLIST', listed);
    await expect(
      oauthClientMutations.createOAuthClient(
        undefined,
        { input: { ...APP_INPUT, applicationType: 'WEB', tokenEndpointAuthMethod: 'NONE' } },
        context(verifiedOutsider),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN', reason: 'NOT_ALLOWLISTED' } });
    const created = await oauthClientMutations.createOAuthClient(
      undefined,
      { input: { ...APP_INPUT, applicationType: 'WEB', tokenEndpointAuthMethod: 'NONE' } },
      context(listed),
    );
    expect(created.clientSecret).toBeNull();
    expect(created.client.tokenEndpointAuthMethod).toBe('NONE');
  });

  it('refuses an allowlisted developer whose email is not verified', async () => {
    vi.stubEnv('PARTNER_OAUTH_MODE', 'allowlist');
    vi.stubEnv('PARTNER_OAUTH_SECRETS', PARTNER_SECRET);
    const unverified = await createDeveloper(false);
    vi.stubEnv('PARTNER_OAUTH_DEVELOPER_ALLOWLIST', unverified);
    await expect(
      oauthClientMutations.createOAuthClient(undefined, { input: APP_INPUT }, context(unverified)),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN', reason: 'EMAIL_NOT_VERIFIED' } });
  });
});
