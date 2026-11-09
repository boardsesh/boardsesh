import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request, type IncomingMessage } from 'node:http';
import { connect as openTcpConnection, type AddressInfo, type Socket } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { oauthRefreshToken } from '@boardsesh/db/schema/auth';
import { createPartnerAuthorityRuntime, type PartnerAuthorityRuntime } from '../auth/partner/authority';
import { PARTNER_DISABLED_PATHS, PARTNER_ROUTES } from '../auth/partner/routes';
import { createPartnerDatabaseHandle, PARTNER_POOL_MAX } from '../auth/partner/transaction';
import { db } from '../db/client';
import { API_HOSTNAME, rejectApiHostRequest } from '../handlers/api-host';
import { createPartnerAuthHandler, type PartnerAuthHandlerOptions } from '../handlers/partner-auth';
import { redisClientManager } from '../redis/client';
import { getTrustedClientIp } from '../utils/client-ip';
import { logger } from '../utils/logger';
import {
  clientCredentials,
  createPartnerTestEnvironment,
  TEST_CONFIGURATION,
  TEST_ISSUER,
  TEST_RESOURCE,
  TEST_SESSION_COOKIE,
  testSessionBridge,
  type PartnerTestEnvironment,
  type TestClient,
} from '../auth/partner/__tests__/partner-fixture';

const TEST_DEADLINE_MS = 60_000;
const MINUTE_MS = 60_000;

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

/** Sets a counter directly, so a test can stand at a limit without sending thousands of requests. */
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

interface SentResponse {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
}

interface SendOptions {
  host?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Stands in for the private ingress appending a client address. */
  clientIp?: string;
}

/** Each test sends from a fresh address, so Redis buckets from earlier tests never interfere. */
function randomClientIp(): string {
  return `203.0.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 254) + 1}`;
}

function browserRouteTarget(path: string, parameters: Record<string, string>): string {
  return `${path}?${new URLSearchParams(parameters).toString()}`;
}

/** A server wired the way `startServer` wires it: partner routes, then the API host filter. */
async function startPartnerHost(options: PartnerAuthHandlerOptions) {
  const handler = createPartnerAuthHandler(options);
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
            ...(options.body !== undefined ? { 'Content-Length': Buffer.byteLength(options.body) } : {}),
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
    port,
    /** Sends the headers of a POST and then nothing, for as long as the socket stays open. */
    openEndlessPost(path: string, clientIp: string) {
      return new Promise<SentResponse>((resolve, reject) => {
        const outgoing = request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path,
            agent: false,
            headers: {
              Host: API_HOSTNAME,
              'X-Forwarded-For': clientIp,
              'Content-Type': 'application/x-www-form-urlencoded',
              'Transfer-Encoding': 'chunked',
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
        outgoing.write('client_id=slow');
      });
    },
    async close() {
      for (const socket of openSockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const CONSENT_PATH = '/api/auth/oauth2/consent';
const TOKEN_PATH = '/api/auth/oauth2/token';
const REVOKE_PATH = '/api/auth/oauth2/revoke';
const AUTHORIZE_PATH = '/api/auth/oauth2/authorize';
const METADATA_PATHS = [
  '/.well-known/oauth-authorization-server/api/auth',
  '/api/auth/.well-known/oauth-authorization-server',
];
const ERROR_PATH = '/api/auth/error';

function formBody(fields: Record<string, string>): { body: string; headers: Record<string, string> } {
  return {
    body: new URLSearchParams(fields).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  };
}

describe('partner OAuth routes on the API host', () => {
  let environment: PartnerTestEnvironment;
  let runtime: PartnerAuthorityRuntime;
  let partnerHost: Awaited<ReturnType<typeof startPartnerHost>>;
  const transactionSpy = { calls: 0 };

  beforeAll(async () => {
    environment = await createPartnerTestEnvironment();
    runtime = await createPartnerAuthorityRuntime(environment.database, TEST_CONFIGURATION, {
      plugins: [testSessionBridge(createPartnerDatabaseHandle(environment.database))],
      close: async () => {},
    });
    const realTransaction = environment.database.transaction.bind(environment.database);
    vi.spyOn(environment.database, 'transaction').mockImplementation(((...args: Parameters<typeof realTransaction>) => {
      transactionSpy.calls += 1;
      return realTransaction(...args);
    }) as typeof realTransaction);
    partnerHost = await startPartnerHost({
      mode: 'allowlist',
      loadRuntime: async () => runtime,
      bodyReadDeadlineMs: 400,
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await partnerHost?.close();
    await environment?.close();
  });

  async function transactionsDuring(work: () => Promise<unknown>): Promise<number> {
    const before = transactionSpy.calls;
    await work();
    return transactionSpy.calls - before;
  }

  const authorizeQuery = (client: TestClient) => ({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    scope: 'profile:read offline_access',
    state: randomUUID(),
    resource: TEST_RESOURCE,
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  });

  const sendToken = (fields: Record<string, string>, options: SendOptions = {}) =>
    partnerHost.send('POST', TOKEN_PATH, {
      ...options,
      body: formBody(fields).body,
      headers: { ...formBody(fields).headers, ...options.headers },
    });

  describe('the allowlist', () => {
    it('serves the named routes', async () => {
      const client = await environment.createClient({ publicClient: true });
      expect((await partnerHost.send('GET', browserRouteTarget(AUTHORIZE_PATH, authorizeQuery(client)))).status).toBe(
        302,
      );
      const tokenResponse = await sendToken({ grant_type: 'authorization_code', ...clientCredentials(client) });
      expect(tokenResponse.status).toBe(400);
      const revokeResponse = await partnerHost.send('POST', REVOKE_PATH, {
        ...formBody({ token: 'unknown', ...clientCredentials(client) }),
      });
      expect(revokeResponse.status).toBe(200);
      const consentResponse = await partnerHost.send('POST', CONSENT_PATH, {
        body: JSON.stringify({ accept: true }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(consentResponse.status).toBe(401);
      for (const path of METADATA_PATHS) expect((await partnerHost.send('GET', path)).status).toBe(200);
      expect((await partnerHost.send('GET', `${ERROR_PATH}?error=invalid_client`)).status).toBe(400);
    });

    it('answers nothing but the API host', async () => {
      for (const host of ['ws.boardsesh.com', 'www.boardsesh.com', 'localhost']) {
        const elsewhere = await partnerHost.send('GET', METADATA_PATHS[0], { host });
        expect(elsewhere.status).toBe(200);
        expect(JSON.parse(elsewhere.body)).toEqual({ reachedDispatcher: true });
      }
    });

    const widenedRequests: Array<[string, string, string]> = [
      ['a trailing slash on authorize', 'GET', `${AUTHORIZE_PATH}/`],
      ['a trailing slash on token', 'POST', `${TOKEN_PATH}/`],
      ['a trailing slash on discovery', 'GET', `${METADATA_PATHS[0]}/`],
      ['upper case', 'POST', TOKEN_PATH.toUpperCase()],
      ['a different case segment', 'POST', '/api/AUTH/oauth2/token'],
      ['a doubled slash', 'POST', '/api/auth//oauth2/token'],
      ['a doubled leading slash', 'GET', `/${AUTHORIZE_PATH}`],
      ['a percent-encoded slash', 'POST', '/api/auth/oauth2%2Ftoken'],
      ['a percent-encoded letter', 'POST', '/api/auth/oauth2/t%6Fken'],
      ['a dot segment', 'POST', '/api/auth/oauth2/./token'],
      ['a parent segment', 'POST', '/api/auth/oauth2/x/../token'],
      ['an encoded parent segment', 'POST', '/api/auth/oauth2/x/%2e%2e/token'],
      ['a backslash', 'POST', '/api/auth/oauth2\\token'],
      ['HEAD on authorize', 'HEAD', AUTHORIZE_PATH],
      ['HEAD on discovery', 'HEAD', METADATA_PATHS[0]],
      ['OPTIONS on authorize', 'OPTIONS', AUTHORIZE_PATH],
      ['OPTIONS on discovery', 'OPTIONS', METADATA_PATHS[0]],
      ['POST on authorize (stock accepts it)', 'POST', AUTHORIZE_PATH],
      ['GET on token', 'GET', TOKEN_PATH],
      ['PUT on revoke', 'PUT', REVOKE_PATH],
      ['the OIDC discovery path', 'GET', '/api/auth/.well-known/openid-configuration'],
      ['a suffix on the error page', 'GET', `${ERROR_PATH}/extra`],
      ['POST on the error page', 'POST', ERROR_PATH],
      ['a path that only starts the same', 'POST', `${TOKEN_PATH}x`],
    ];

    it.each(widenedRequests)('refuses %s', async (_label, method, path) => {
      const refused = await partnerHost.send(method, path);
      expect(refused.status).toBe(404);
      if (method !== 'HEAD') expect(JSON.parse(refused.body)).toEqual({ error: 'Not found' });
    });

    interface StockEndpoint {
      path?: string;
      options?: { method?: string | string[]; metadata?: { SERVER_ONLY?: boolean } };
    }

    function stockHttpRoutes(): Array<{ method: string; path: string }> {
      const routes: Array<{ method: string; path: string }> = [];
      for (const endpoint of Object.values(runtime.authority.api as Record<string, StockEndpoint>)) {
        if (!endpoint.path || endpoint.options?.metadata?.SERVER_ONLY) continue;
        const methods = endpoint.options?.method;
        for (const method of Array.isArray(methods) ? methods : [methods ?? 'GET']) {
          routes.push({ method, path: endpoint.path });
        }
      }
      return routes;
    }

    const issuerRelative = (path: string) => path.replace('/api/auth', '');
    const allowedInStock = new Set(
      PARTNER_ROUTES.filter((route) => route.kind !== 'discovery' && route.kind !== 'error').map(
        (route) => `${route.method} ${issuerRelative(route.pathname)}`,
      ),
    );

    it('has a decision for every stock route: allowed, disabled, or parameterised', () => {
      const disabled = new Set(PARTNER_DISABLED_PATHS);
      const undecided = stockHttpRoutes()
        .filter(({ method, path }) => !allowedInStock.has(`${method} ${path}`))
        // POST /oauth2/authorize shares its path with the allowed GET, so a disabled list cannot name it.
        .filter(({ path }) => !disabled.has(path) && !path.includes(':') && path !== '/oauth2/authorize');
      expect(undecided).toEqual([]);
      expect(new Set(stockHttpRoutes().map(({ path }) => path)).size).toBe(53);
    });

    it('refuses every other stock route over HTTP, with a signed-in climber', async () => {
      const client = await environment.createClient();
      const others = stockHttpRoutes().filter(
        // GET /error is the one stock path we also serve, as our own page.
        ({ method, path }) => !allowedInStock.has(`${method} ${path}`) && path !== '/error',
      );
      expect(others.length).toBeGreaterThan(40);
      for (const { method, path } of others) {
        const target = `/api/auth${path.replace(/:[^/]+/g, 'value')}`;
        const refused = await partnerHost.send(method, target, {
          headers: {
            Cookie: `${TEST_SESSION_COOKIE}=${client.owner.sessionToken}`,
            'Content-Type': 'application/json',
            Origin: TEST_CONFIGURATION.webOrigin,
          },
          body: method === 'GET' ? undefined : '{}',
        });
        expect({ method, target, status: refused.status }).toEqual({ method, target, status: 404 });
      }
    });

    it('also refuses them inside the authority itself, for every path a disabled list can name', async () => {
      const client = await environment.createClient();
      for (const path of PARTNER_DISABLED_PATHS) {
        const refused = await runtime.authority.handler(
          new Request(`${TEST_ISSUER}${path}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              cookie: `${TEST_SESSION_COOKIE}=${client.owner.sessionToken}`,
              origin: TEST_CONFIGURATION.webOrigin,
            },
            body: '{}',
          }),
        );
        expect({ path, status: refused.status }).toEqual({ path, status: 404 });
      }
    });

    it('does not let any request choose the mode', async () => {
      const held = await startPartnerHost({ mode: 'hold', loadRuntime: async () => runtime });
      try {
        const attemptsToChooseTheMode: Array<Record<string, string>> = [
          { 'X-Partner-Mode': 'open' },
          { Cookie: 'PARTNER_OAUTH_MODE=open' },
          { 'PARTNER-OAUTH-MODE': 'open' },
        ];
        for (const headers of attemptsToChooseTheMode) {
          expect((await held.send('GET', METADATA_PATHS[0], { headers })).status).toBe(503);
        }
        expect((await held.send('GET', `${METADATA_PATHS[0]}?PARTNER_OAUTH_MODE=open`)).status).toBe(503);
      } finally {
        await held.close();
      }
    });

    it('never forwards the Host header or a query string into the authority URL', async () => {
      const handleRequest = vi.spyOn(runtime, 'handleRequest');
      try {
        await partnerHost.send('POST', `${REVOKE_PATH}?client_id=spoof&token=spoof`, {
          ...formBody({ token: 'unknown', client_id: 'whatever' }),
          host: `${API_HOSTNAME}:8443`,
        });
        const forwarded = handleRequest.mock.calls[0][0];
        expect(forwarded.url).toBe(`${TEST_ISSUER}/oauth2/revoke`);
      } finally {
        handleRequest.mockRestore();
      }
    });
  });

  describe('the mode switch', () => {
    it('with off, answers false and never loads the runtime', async () => {
      const loadRuntime = vi.fn(async () => runtime);
      const handler = createPartnerAuthHandler({ mode: 'off', loadRuntime });
      const answered = await handler(
        { method: 'GET', url: METADATA_PATHS[0], headers: { host: API_HOSTNAME } } as unknown as IncomingMessage,
        {} as never,
      );
      expect(answered).toBe(false);
      expect(loadRuntime).not.toHaveBeenCalled();
    });

    it('with off, the API host filter still answers 404', async () => {
      const off = await startPartnerHost({ mode: 'off', loadRuntime: async () => runtime });
      try {
        for (const path of [TOKEN_PATH, AUTHORIZE_PATH, ...METADATA_PATHS, ERROR_PATH]) {
          expect((await off.send('GET', path)).status).toBe(404);
        }
      } finally {
        await off.close();
      }
    });

    it('with hold, answers 503 with Retry-After and loads nothing', async () => {
      const loadRuntime = vi.fn(async () => runtime);
      const held = await startPartnerHost({ mode: 'hold', loadRuntime });
      try {
        const paths: Array<[string, string]> = [
          ['GET', AUTHORIZE_PATH],
          ['POST', TOKEN_PATH],
          ['POST', REVOKE_PATH],
          ['OPTIONS', TOKEN_PATH],
          ['GET', METADATA_PATHS[0]],
          ['GET', ERROR_PATH],
        ];
        for (const [method, path] of paths) {
          const answered = await held.send(method, path);
          expect(answered.status).toBe(503);
          expect(answered.headers['retry-after']).toBe('60');
          expect(answered.headers['cache-control']).toBe('no-store');
        }
        expect((await held.send('GET', '/graphql')).status).toBe(404);
        expect(loadRuntime).not.toHaveBeenCalled();
      } finally {
        await held.close();
      }
    });
  });

  describe('discovery', () => {
    it('publishes only what is reachable, at both paths, with no transaction', async () => {
      const documents: Array<Record<string, unknown>> = [];
      const transactions = await transactionsDuring(async () => {
        for (const path of METADATA_PATHS) {
          const answered = await partnerHost.send('GET', path);
          expect(answered.status).toBe(200);
          expect(answered.headers['cache-control']).toContain('max-age=15');
          documents.push(JSON.parse(answered.body) as Record<string, unknown>);
        }
      });
      expect(transactions).toBe(0);
      expect(documents[0]).toEqual(documents[1]);
      expect(documents[0]).toEqual({
        issuer: TEST_ISSUER,
        authorization_endpoint: `${TEST_ISSUER}/oauth2/authorize`,
        token_endpoint: `${TEST_ISSUER}/oauth2/token`,
        revocation_endpoint: `${TEST_ISSUER}/oauth2/revoke`,
        scopes_supported: ['profile:read', 'offline_access'],
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
        token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
        revocation_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      });
    });

    it('survives concurrent load without touching the pool', async () => {
      const transactions = await transactionsDuring(async () => {
        for (let round = 0; round < 8; round += 1) {
          const responses = await Promise.all(
            Array.from({ length: 25 }, () => partnerHost.send('GET', METADATA_PATHS[0])),
          );
          expect(responses.every((answered) => answered.status === 200)).toBe(true);
        }
      });
      expect(transactions).toBe(0);
    });
  });

  describe('the error page', () => {
    it('shows the error code and never the free-text description', async () => {
      const answered = await partnerHost.send(
        'GET',
        `${ERROR_PATH}?error=invalid_client&error_description=${encodeURIComponent('<script>alert(1)</script>')}`,
      );
      expect(answered.status).toBe(400);
      expect(answered.headers['content-type']).toContain('text/html');
      expect(answered.headers['x-frame-options']).toBe('DENY');
      expect(answered.headers['content-security-policy']).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      );
      expect(answered.headers['referrer-policy']).toBe('no-referrer');
      expect(answered.headers['x-content-type-options']).toBe('nosniff');
      expect(answered.body).toContain('invalid_client');
      expect(answered.body).not.toContain('<script>alert');
    });

    it('replaces an error code that is not one', async () => {
      const answered = await partnerHost.send('GET', `${ERROR_PATH}?error=${encodeURIComponent('<img src=x>')}`);
      expect(answered.body).not.toContain('<img');
      expect(answered.body).toContain('invalid_request');
    });

    it('is where the provider sends a browser for an unknown client', async () => {
      const client = await environment.createClient({ publicClient: true });
      const refused = await partnerHost.send(
        'GET',
        browserRouteTarget(AUTHORIZE_PATH, { ...authorizeQuery(client), client_id: 'no-such-client' }),
      );
      expect(refused.status).toBe(302);
      const target = new URL(refused.headers.location!);
      expect(`${target.origin}${target.pathname}`).toBe(`${TEST_ISSUER}/error`);
      expect((await partnerHost.send('GET', `${ERROR_PATH}${target.search}`)).status).toBe(400);
    });
  });

  describe('authorize', () => {
    it('takes no transaction when signed out, and answers the sign-in redirect', async () => {
      const client = await environment.createClient({ publicClient: true });
      let answered: SentResponse | undefined;
      const transactions = await transactionsDuring(async () => {
        answered = await partnerHost.send('GET', browserRouteTarget(AUTHORIZE_PATH, authorizeQuery(client)));
      });
      expect(transactions).toBe(0);
      expect(answered?.status).toBe(302);
      expect(answered?.headers.location).toContain(`${TEST_CONFIGURATION.webOrigin}/oauth/sign-in`);
      expect(answered?.headers['cache-control']).toBe('no-store');
    });

    it('still takes no transaction when a client sneaks a code parameter onto a signed-out request', async () => {
      const client = await environment.createClient({ publicClient: true });
      const transactions = await transactionsDuring(async () => {
        const answered = await partnerHost.send(
          'GET',
          browserRouteTarget(AUTHORIZE_PATH, { ...authorizeQuery(client), code: 'planted' }),
        );
        expect(answered.status).toBe(302);
      });
      expect(transactions).toBe(0);
    });

    it.each([
      ['the secure cookie', '__Secure-next-auth.session-token=unknown'],
      ['a chunked cookie', 'next-auth.session-token.0=unknown'],
      ['a chunked secure cookie', '__Secure-next-auth.session-token.1=unknown'],
      ['the cookie after another one', 'theme=dark; next-auth.session-token=unknown'],
    ])('takes a transaction for %s', async (_label, cookie) => {
      const client = await environment.createClient({ publicClient: true });
      const transactions = await transactionsDuring(async () => {
        const answered = await partnerHost.send('GET', browserRouteTarget(AUTHORIZE_PATH, authorizeQuery(client)), {
          headers: { Cookie: cookie },
        });
        expect(answered.status).toBe(302);
      });
      expect(transactions).toBe(1);
    });

    it('takes no transaction for a cookie that only resembles the session cookie', async () => {
      const client = await environment.createClient({ publicClient: true });
      const transactions = await transactionsDuring(async () => {
        await partnerHost.send('GET', browserRouteTarget(AUTHORIZE_PATH, authorizeQuery(client)), {
          headers: { Cookie: 'not-next-auth.session-token=x; next-auth.session-token-old=y' },
        });
      });
      expect(transactions).toBe(0);
    });

    it('takes a transaction when a NextAuth session cookie is present', async () => {
      const client = await environment.createClient({ skipConsent: true });
      let answered: SentResponse | undefined;
      const transactions = await transactionsDuring(async () => {
        answered = await partnerHost.send('GET', browserRouteTarget(AUTHORIZE_PATH, authorizeQuery(client)), {
          headers: { Cookie: `${TEST_SESSION_COOKIE}=${client.owner.sessionToken}` },
        });
      });
      expect(transactions).toBe(1);
      expect(new URL(answered!.headers.location!).searchParams.has('code')).toBe(true);
    });

    it('rejects a body sent with a GET authorize by never reading it', async () => {
      const client = await environment.createClient({ publicClient: true });
      const answered = await partnerHost.send('GET', browserRouteTarget(AUTHORIZE_PATH, authorizeQuery(client)), {
        body: 'x'.repeat(1024),
      });
      expect(answered.status).toBe(302);
    });
  });

  describe('request bodies', () => {
    it('accepts exactly 64 KB', async () => {
      const client = await environment.createClient({ publicClient: true });
      const padding = 'z'.repeat(64 * 1024 - `grant_type=authorization_code&client_id=${client.clientId}&pad=`.length);
      const answered = await partnerHost.send('POST', TOKEN_PATH, {
        ...formBody({}),
        body: `grant_type=authorization_code&client_id=${client.clientId}&pad=${padding}`,
      });
      expect(answered.status).toBe(400);
      expect(JSON.parse(answered.body).error).toBe('invalid_request');
    });

    it('refuses a declared body over 64 KB without reading it', async () => {
      const handleRequest = vi.spyOn(runtime, 'handleRequest');
      try {
        const answered = await partnerHost.send('POST', TOKEN_PATH, {
          body: 'a'.repeat(64 * 1024 + 1),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        expect(answered.status).toBe(413);
        expect(JSON.parse(answered.body).error).toBe('payload_too_large');
        expect(answered.headers.connection).toBe('close');
        expect(handleRequest).not.toHaveBeenCalled();
      } finally {
        handleRequest.mockRestore();
      }
    });

    it('refuses a chunked body once it passes 64 KB', async () => {
      const answered = await new Promise<SentResponse>((resolve, reject) => {
        const outgoing = request(
          {
            host: '127.0.0.1',
            port: partnerHost.port,
            method: 'POST',
            path: TOKEN_PATH,
            agent: false,
            headers: {
              Host: API_HOSTNAME,
              'X-Forwarded-For': randomClientIp(),
              'Content-Type': 'application/x-www-form-urlencoded',
              'Transfer-Encoding': 'chunked',
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
        outgoing.write('a'.repeat(40 * 1024));
        outgoing.write('b'.repeat(40 * 1024));
      });
      expect(answered.status).toBe(413);
    });

    it(
      'gives up on an endless body at the deadline, with no transaction and no permit',
      async () => {
        const handleRequest = vi.spyOn(runtime, 'handleRequest');
        const acquire = vi.spyOn(runtime.admission, 'acquire');
        try {
          const started = performance.now();
          const answered = await partnerHost.openEndlessPost(TOKEN_PATH, randomClientIp());
          const elapsedMs = performance.now() - started;
          expect(answered.status).toBe(408);
          expect(answered.headers.connection).toBe('close');
          expect(elapsedMs).toBeGreaterThanOrEqual(380);
          expect(elapsedMs).toBeLessThan(2000);
          expect(handleRequest).not.toHaveBeenCalled();
          expect(acquire).not.toHaveBeenCalled();
        } finally {
          handleRequest.mockRestore();
          acquire.mockRestore();
        }
      },
      TEST_DEADLINE_MS,
    );

    it(
      'holds no database connection while endless bodies arrive',
      async () => {
        const refreshCount = 4;
        const client = await environment.createClient({ publicClient: true });
        const issued = await environment.issueTokens(client);
        const slowPosts = Array.from({ length: PARTNER_POOL_MAX * 3 }, () =>
          partnerHost.openEndlessPost(TOKEN_PATH, randomClientIp()),
        );
        const started = performance.now();
        const results = await Promise.all(
          Array.from({ length: refreshCount }, () =>
            sendToken({
              grant_type: 'refresh_token',
              refresh_token: issued.refresh_token!,
              ...clientCredentials(client),
            }),
          ),
        );
        const refreshedMs = performance.now() - started;
        // Without buffering these would wait for the slow posts' deadline.
        expect(refreshedMs).toBeLessThan(350);
        expect(results.filter((result) => result.status === 200).length).toBeGreaterThanOrEqual(1);
        expect((await Promise.all(slowPosts)).every((result) => result.status === 408)).toBe(true);
      },
      TEST_DEADLINE_MS,
    );

    it(
      'limits how many bodies one address can be sending at once',
      async () => {
        const clientIp = randomClientIp();
        const posts = Array.from({ length: 12 }, () => partnerHost.openEndlessPost(TOKEN_PATH, clientIp));
        const results = await Promise.all(posts);
        const refusedAtOnce = results.filter((result) => result.status === 503);
        expect(refusedAtOnce.length).toBeGreaterThanOrEqual(1);
        expect(refusedAtOnce.every((result) => result.headers['retry-after'] === '2')).toBe(true);
      },
      TEST_DEADLINE_MS,
    );
  });

  describe('the whole-app token budget', () => {
    beforeEach(() => enoughWindowLeft());

    const refreshForm = (client: TestClient, refreshToken: string) => ({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      ...clientCredentials(client),
    });

    it('is not spent by requests that only name the app', async () => {
      const client = await environment.createClient({ publicClient: true });
      await seedLimiter(client.clientId, 'oauth-client', 5999);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const junk = await sendToken(refreshForm(client, `junk-${randomUUID()}`));
        expect(junk.status).toBe(400);
      }
      // A public client's revoke answers 200 for any token, so it proves nothing either.
      const junkRevoke = await partnerHost.send('POST', REVOKE_PATH, {
        ...formBody({ token: `junk-${randomUUID()}`, ...clientCredentials(client) }),
      });
      expect(junkRevoke.status).toBe(200);
      expect(await limiterCount(client.clientId, 'oauth-client')).toBe(5999);
    });

    it('is spent by a token response that succeeds', async () => {
      const client = await environment.createClient({ publicClient: true });
      const issued = await environment.issueTokens(client);
      await seedLimiter(client.clientId, 'oauth-client', 100);
      expect((await sendToken(refreshForm(client, issued.refresh_token!))).status).toBe(200);
      expect(await limiterCount(client.clientId, 'oauth-client')).toBe(101);
    });

    it('refuses the app once it is used up, before any transaction', async () => {
      const client = await environment.createClient({ publicClient: true });
      const issued = await environment.issueTokens(client);
      await seedLimiter(client.clientId, 'oauth-client', 6000);
      const transactions = await transactionsDuring(async () => {
        const limited = await sendToken(refreshForm(client, issued.refresh_token!));
        expect(limited.status).toBe(429);
        expect(limited.headers['ratelimit-limit']).toBe('6000');
        expect(limited.headers['retry-after']).toBeDefined();
      });
      expect(transactions).toBe(0);
    });

    it(
      'stops a real flood of valid refreshes within one burst of the budget',
      async () => {
        const client = await environment.createClient({ publicClient: true });
        const refreshTokens: string[] = [];
        for (let climberIndex = 0; climberIndex < 30; climberIndex += 1) {
          const climber = await environment.createClimber();
          const authorization = await environment.authorize(client, { climber });
          const issued = await environment.exchange(client, authorization);
          refreshTokens.push(issued.body.refresh_token!);
        }
        await seedLimiter(client.clientId, 'oauth-client', 5990);

        const burst = await Promise.all(refreshTokens.map((token) => sendToken(refreshForm(client, token))));
        const succeeded = burst.filter((answered) => answered.status === 200).length;
        // Budget for 10, plus at most what was already past the check: 3 running and 16 queued.
        expect(succeeded).toBeGreaterThanOrEqual(10);
        expect(succeeded).toBeLessThanOrEqual(PARTNER_POOL_MAX + 16);
        expect(await limiterCount(client.clientId, 'oauth-client')).toBe(5990 + succeeded);

        const issuedAfter = await environment.issueTokens(client);
        expect((await sendToken(refreshForm(client, issuedAfter.refresh_token!))).status).toBe(429);
      },
      TEST_DEADLINE_MS,
    );
  });

  describe('what bills a limit', () => {
    beforeEach(() => enoughWindowLeft());

    const codeForm = (clientId: string) => ({
      grant_type: 'authorization_code',
      code: 'not-real',
      client_id: clientId,
    });

    it.each([
      ['a colon', (victim: string, victimIp: string) => `${victim}:${victimIp}`],
      ['a space', (victim: string) => `${victim} x`],
      ['a slash', (victim: string) => `${victim}/x`],
    ])('sends a client_id containing %s to the invalid bucket', async (_label, attackerClaim) => {
      const victim = randomUUID().replaceAll('-', '');
      const victimIp = randomClientIp();
      const attackerIp = randomClientIp();
      await sendToken(codeForm(attackerClaim(victim, victimIp)), { clientIp: attackerIp });
      expect(await limiterCount(`${victim}:${victimIp}`, 'oauth-client')).toBe(0);
      expect(await limiterCount(`invalid:${attackerIp}`, 'oauth-client')).toBe(1);
    });

    it('applies the same rule to a Basic credential', async () => {
      const victim = randomUUID().replaceAll('-', '');
      const victimIp = randomClientIp();
      const attackerIp = randomClientIp();
      const credential = Buffer.from(`${encodeURIComponent(`${victim}:${victimIp}`)}:secret`).toString('base64');
      await sendToken(
        { grant_type: 'authorization_code', code: 'not-real' },
        { clientIp: attackerIp, headers: { Authorization: `Basic ${credential}` } },
      );
      expect(await limiterCount(`${victim}:${victimIp}`, 'oauth-client')).toBe(0);
      expect(await limiterCount(`invalid:${attackerIp}`, 'oauth-client')).toBe(1);
    });

    it('bills the Basic client over a client_id in the form, as the provider authenticates it', async () => {
      const client = await environment.createClient();
      const otherClientId = randomUUID().replaceAll('-', '');
      const clientIp = randomClientIp();
      const credential = Buffer.from(`${client.clientId}:${client.clientSecret!}`).toString('base64');
      await sendToken(
        { grant_type: 'authorization_code', code: 'not-real', client_id: otherClientId },
        { clientIp, headers: { Authorization: `Basic ${credential}` } },
      );
      expect(await limiterCount(`${client.clientId}:${clientIp}`, 'oauth-client')).toBe(1);
      expect(await limiterCount(`${otherClientId}:${clientIp}`, 'oauth-client')).toBe(0);
    });

    it(
      'reads a form whatever a Content-Type parameter says, so a connection cannot dodge its limit',
      async () => {
        const client = await environment.createClient({ publicClient: true });
        let current = await environment.issueTokens(client);
        const statuses: number[] = [];
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const answered = await partnerHost.send('POST', TOKEN_PATH, {
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: current.refresh_token!,
              ...clientCredentials(client),
            }).toString(),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset="application/json"' },
          });
          statuses.push(answered.status);
          if (answered.status === 200) current = JSON.parse(answered.body) as typeof current;
        }
        expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 200));
        expect(statuses.slice(10)).toEqual([429, 429]);
      },
      TEST_DEADLINE_MS,
    );

    it('bills the client the provider reads from a body that is also valid JSON', async () => {
      const client = await environment.createClient({ publicClient: true });
      const issued = await environment.issueTokens(client);
      const decoyClientId = randomUUID().replaceAll('-', '');
      const clientIp = randomClientIp();
      const polyglotBody = JSON.stringify({
        client_id: decoyClientId,
        pad: `&grant_type=refresh_token&refresh_token=${encodeURIComponent(issued.refresh_token!)}&client_id=${client.clientId}&zz=`,
      });
      await partnerHost.send('POST', TOKEN_PATH, {
        clientIp,
        body: polyglotBody,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; x=application/json' },
      });
      expect(await limiterCount(`${decoyClientId}:${clientIp}`, 'oauth-refresh-ip')).toBe(0);
      expect(await limiterCount(`${client.clientId}:${clientIp}`, 'oauth-refresh-ip')).toBe(1);
    });

    it('limits consent per address, before the body is read', async () => {
      const clientIp = randomClientIp();
      await seedLimiter(clientIp, 'oauth-consent', 60);
      const limited = await partnerHost.send('POST', CONSENT_PATH, {
        clientIp,
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(limited.status).toBe(429);
      expect(limited.headers['ratelimit-limit']).toBe('60');
    });

    it('counts a body read against the address before any of it arrives', async () => {
      const clientIp = randomClientIp();
      await seedLimiter(clientIp, 'oauth-body-ip', 1200);
      const started = performance.now();
      const limited = await partnerHost.openEndlessPost(TOKEN_PATH, clientIp);
      expect(limited.status).toBe(429);
      expect(limited.headers['ratelimit-limit']).toBe('1200');
      // The endless body would otherwise run into the 400 ms deadline.
      expect(performance.now() - started).toBeLessThan(300);
    });

    it(
      'treats addresses in one IPv6 /64 as one client',
      async () => {
        const client = await environment.createClient({ publicClient: true });
        const target = browserRouteTarget(AUTHORIZE_PATH, authorizeQuery(client));
        const prefix = `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}:${Math.floor(Math.random() * 0xffff).toString(16)}`;
        for (let host = 1; host <= 60; host += 1) {
          expect((await partnerHost.send('GET', target, { clientIp: `${prefix}::${host.toString(16)}` })).status).toBe(
            302,
          );
        }
        const limited = await partnerHost.send('GET', target, { clientIp: `${prefix}:aaaa:bbbb:cccc:dddd` });
        expect(limited.status).toBe(429);
      },
      TEST_DEADLINE_MS,
    );
  });

  describe('a refused body', () => {
    /** Talks HTTP by hand: Node's client asks for `Connection: close` itself, which hides the server's answer. */
    function sendRawUntilClosed(requestText: string, port = partnerHost.port) {
      return new Promise<{ response: string; closedAfterMs: number }>((resolve, reject) => {
        const socket = openTcpConnection({ host: '127.0.0.1', port });
        const startedAt = performance.now();
        let response = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          response += chunk;
        });
        socket.on('error', reject);
        socket.on('close', () => resolve({ response, closedAfterMs: performance.now() - startedAt }));
        socket.write(requestText);
      });
    }

    const rawHeaders = (extraLines: string[]) =>
      [
        `POST ${TOKEN_PATH} HTTP/1.1`,
        `Host: ${API_HOSTNAME}`,
        `X-Forwarded-For: ${randomClientIp()}`,
        'Content-Type: application/x-www-form-urlencoded',
        'Connection: keep-alive',
        ...extraLines,
        '',
        '',
      ].join('\r\n');

    it('closes the connection after an oversized body, though the client asked to keep it', async () => {
      const { response, closedAfterMs } = await sendRawUntilClosed(rawHeaders(['Content-Length: 70000']));
      expect(response.toLowerCase()).toContain('connection: close');
      expect(response).toContain('413');
      expect(closedAfterMs).toBeLessThan(2000);
    });

    it('closes the connection after the deadline, though the client asked to keep it', async () => {
      const { response, closedAfterMs } = await sendRawUntilClosed(
        `${rawHeaders(['Transfer-Encoding: chunked'])}5\r\nhello\r\n`,
      );
      expect(response.toLowerCase()).toContain('connection: close');
      expect(response).toContain('408');
      expect(closedAfterMs).toBeLessThan(2500);
    });

    it(
      'refuses a new reader once 256 bodies are being read, whichever address it is from',
      async () => {
        const slowHost = await startPartnerHost({
          mode: 'allowlist',
          loadRuntime: async () => runtime,
          bodyReadDeadlineMs: 10_000,
        });
        try {
          // 32 addresses at their cap of 8, opened in small groups.
          for (let addressIndex = 0; addressIndex < 32; addressIndex += 1) {
            const clientIp = randomClientIp();
            for (let readIndex = 0; readIndex < 8; readIndex += 1) {
              slowHost.openEndlessPost(TOKEN_PATH, clientIp).catch(() => undefined);
            }
            await new Promise((resolve) => setTimeout(resolve, 15));
          }
          await vi.waitFor(
            async () => {
              const probe = await slowHost.send('POST', TOKEN_PATH, {
                ...formBody({ grant_type: 'authorization_code', client_id: 'probe' }),
              });
              expect(probe.status).toBe(503);
              expect(probe.headers['retry-after']).toBe('2');
            },
            { timeout: 8000, interval: 100 },
          );
        } finally {
          await slowHost.close();
        }
      },
      TEST_DEADLINE_MS,
    );
  });

  describe('a failed refresh lookup', () => {
    it('answers 503 and logs no token or hash', async () => {
      const client = await environment.createClient({ publicClient: true });
      const presented = `secret-refresh-${randomUUID()}`;
      const databaseError = Object.assign(new Error(`Failed query: select ... params: ${presented}`), {
        name: 'DrizzleQueryError',
        query: 'select',
        params: [presented],
        cause: Object.assign(new Error('terminating connection'), { code: '57P01' }),
      });
      const lookup = vi.spyOn(runtime, 'findRefreshConnection').mockRejectedValueOnce(databaseError);
      const errors = vi.spyOn(logger, 'error');
      const warnings = vi.spyOn(logger, 'warn');
      try {
        const answered = await sendToken({
          grant_type: 'refresh_token',
          refresh_token: presented,
          ...clientCredentials(client),
        });
        expect(answered.status).toBe(503);
        expect(answered.headers['retry-after']).toBe('2');
        expect(JSON.parse(answered.body).error).toBe('temporarily_unavailable');
        const logged = JSON.stringify([...errors.mock.calls, ...warnings.mock.calls]);
        expect(logged).not.toContain(presented);
        expect(logged).toContain('57P01');
      } finally {
        lookup.mockRestore();
        errors.mockRestore();
        warnings.mockRestore();
      }
    });
  });

  describe('rate limits', () => {
    beforeEach(() => enoughWindowLeft());

    it(
      'limits authorize per address, before any database work',
      async () => {
        const client = await environment.createClient({ publicClient: true });
        const clientIp = randomClientIp();
        const target = browserRouteTarget(AUTHORIZE_PATH, authorizeQuery(client));
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const allowed = await partnerHost.send('GET', target, { clientIp });
          expect(allowed.status).toBe(302);
          expect(allowed.headers['ratelimit-limit']).toBe('60');
        }
        const acquire = vi.spyOn(runtime.admission, 'acquire');
        try {
          const limited = await partnerHost.send('GET', target, { clientIp });
          expect(limited.status).toBe(429);
          expect(limited.headers['retry-after']).toBeDefined();
          expect(limited.headers['ratelimit-remaining']).toBe('0');
          expect(JSON.parse(limited.body).error).toBe('rate_limited');
          expect(acquire).not.toHaveBeenCalled();
        } finally {
          acquire.mockRestore();
        }
        // Another address is unaffected.
        expect((await partnerHost.send('GET', target)).status).toBe(302);
      },
      TEST_DEADLINE_MS,
    );

    it(
      'limits token requests per app and address before any transaction opens',
      async () => {
        const client = await environment.createClient({ publicClient: true });
        const clientIp = randomClientIp();
        const spentCodeForm = {
          grant_type: 'authorization_code',
          code: 'not-a-real-code',
          code_verifier: 'not-a-real-verifier',
          redirect_uri: client.redirectUri,
          ...clientCredentials(client),
        };
        let lastAllowed: SentResponse | undefined;
        for (let attempt = 0; attempt < 60; attempt += 1) {
          lastAllowed = await sendToken(spentCodeForm, { clientIp });
          expect(lastAllowed.status).toBe(400);
        }
        expect(lastAllowed?.headers['ratelimit-remaining']).toBe('0');
        const transactions = await transactionsDuring(async () => {
          const limited = await sendToken(spentCodeForm, { clientIp });
          expect(limited.status).toBe(429);
          expect(limited.headers['retry-after']).toBeDefined();
          expect(limited.headers['ratelimit-limit']).toBe('60');
        });
        expect(transactions).toBe(0);
      },
      TEST_DEADLINE_MS,
    );

    it(
      'limits a refresh token to 10 per minute per connection, before any transaction opens',
      async () => {
        const client = await environment.createClient({ publicClient: true });
        let issued = await environment.issueTokens(client);
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const refreshed = await sendToken({
            grant_type: 'refresh_token',
            refresh_token: issued.refresh_token!,
            ...clientCredentials(client),
          });
          expect(refreshed.status).toBe(200);
          issued = JSON.parse(refreshed.body) as typeof issued;
        }
        const transactions = await transactionsDuring(async () => {
          const limited = await sendToken({
            grant_type: 'refresh_token',
            refresh_token: issued.refresh_token!,
            ...clientCredentials(client),
          });
          expect(limited.status).toBe(429);
          expect(limited.headers['ratelimit-limit']).toBe('10');
        });
        expect(transactions).toBe(0);
      },
      TEST_DEADLINE_MS,
    );

    it(
      'counts a replayed spent token against its connection, not only its address',
      async () => {
        const client = await environment.createClient({ publicClient: true });
        const issued = await environment.issueTokens(client);
        const firstRefreshToken = issued.refresh_token!;
        let current = issued;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const rotated = await sendToken({
            grant_type: 'refresh_token',
            refresh_token: current.refresh_token!,
            ...clientCredentials(client),
          });
          expect(rotated.status).toBe(200);
          current = JSON.parse(rotated.body) as typeof issued;
        }
        // The spent token still has its ancestor row, and 10 rotations used up the bucket.
        const transactions = await transactionsDuring(async () => {
          const limited = await sendToken({
            grant_type: 'refresh_token',
            refresh_token: firstRefreshToken,
            ...clientCredentials(client),
          });
          expect(limited.status).toBe(429);
        });
        expect(transactions).toBe(0);
      },
      TEST_DEADLINE_MS,
    );

    it(
      'takes the address from the trusted hop, so a forged first hop gets no new bucket',
      async () => {
        const client = await environment.createClient({ publicClient: true });
        const trustedHop = randomClientIp();
        const target = browserRouteTarget(AUTHORIZE_PATH, authorizeQuery(client));
        for (let attempt = 0; attempt < 60; attempt += 1) {
          await partnerHost.send('GET', target, { clientIp: `198.51.100.${attempt}, ${trustedHop}` });
        }
        expect((await partnerHost.send('GET', target, { clientIp: `198.51.100.99, ${trustedHop}` })).status).toBe(429);
        const forgedCloudflareHeader = await partnerHost.send('GET', target, {
          clientIp: trustedHop,
          headers: { 'CF-Connecting-IP': randomClientIp() },
        });
        expect(forgedCloudflareHeader.status).toBe(429);
      },
      TEST_DEADLINE_MS,
    );
  });

  describe('the bounded queue', () => {
    it('refuses work at once when the queue is full', async () => {
      const permits: Array<{ release(): void }> = [];
      const acquired = await Promise.all(
        Array.from({ length: PARTNER_POOL_MAX }, () => runtime.admission.acquire('token')),
      );
      for (const permit of acquired) permits.push(permit!);
      const queued = Array.from({ length: 16 }, () => runtime.admission.acquire('token'));
      try {
        const started = performance.now();
        expect(await runtime.admission.acquire('token')).toBeNull();
        expect(performance.now() - started).toBeLessThan(50);
      } finally {
        for (const permit of permits) permit.release();
      }
      const released = await Promise.all(queued);
      for (const permit of released) permit?.release();
    });

    it('answers 503 with Retry-After when the pool is saturated', async () => {
      const permits = await Promise.all(
        Array.from({ length: PARTNER_POOL_MAX }, () => runtime.admission.acquire('token')),
      );
      const queued = Array.from({ length: 16 }, () => runtime.admission.acquire('token'));
      try {
        const client = await environment.createClient({ publicClient: true });
        const answered = await sendToken({ grant_type: 'authorization_code', ...clientCredentials(client) });
        expect(answered.status).toBe(503);
        expect(answered.headers['retry-after']).toBe('2');
        expect(JSON.parse(answered.body).error).toBe('temporarily_unavailable');
      } finally {
        for (const permit of permits) permit?.release();
      }
      for (const permit of await Promise.all(queued)) permit?.release();
    });

    it('caps how long a queued request waits', async () => {
      const permits = await Promise.all(
        Array.from({ length: PARTNER_POOL_MAX }, () => runtime.admission.acquire('token')),
      );
      try {
        const started = performance.now();
        const waited = await runtime.admission.acquire('token');
        const waitedMs = performance.now() - started;
        expect(waited).toBeNull();
        expect(waitedMs).toBeGreaterThanOrEqual(900);
        expect(waitedMs).toBeLessThan(1500);
      } finally {
        for (const permit of permits) permit?.release();
      }
    });

    it('never gives a queued authorize a permit a token request can use first', async () => {
      const held = await Promise.all(
        Array.from({ length: PARTNER_POOL_MAX }, () => runtime.admission.acquire('token')),
      );
      const queuedAuthorize = runtime.admission.acquire('authorize');
      const queuedToken = runtime.admission.acquire('token');
      held[0]?.release();
      const tokenPermit = await queuedToken;
      expect(tokenPermit).not.toBeNull();
      held[1]?.release();
      const authorizePermit = await queuedAuthorize;
      expect(authorizePermit).not.toBeNull();
      authorizePermit?.release();
      tokenPermit?.release();
      held[2]?.release();
    });

    it('limits authorize to one permit, however many are free', async () => {
      const first = await runtime.admission.acquire('authorize');
      const second = runtime.admission.acquire('authorize');
      let secondSettled = false;
      void second.then(() => {
        secondSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(secondSettled).toBe(false);
      first?.release();
      (await second)?.release();
    });
  });

  describe('CORS', () => {
    const appOrigin = 'https://app.example.test';

    beforeAll(() => runtime.registeredOrigins.invalidate());

    it('answers a preflight from a registered origin, and nothing else', async () => {
      await environment.createClient({ publicClient: true, redirectOrigin: appOrigin });
      runtime.registeredOrigins.invalidate();
      const allowed = await partnerHost.send('OPTIONS', TOKEN_PATH, { headers: { Origin: appOrigin } });
      expect(allowed.status).toBe(204);
      expect(allowed.headers['access-control-allow-origin']).toBe(appOrigin);
      expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();
      expect(allowed.headers['access-control-allow-methods']).toContain('POST');
      expect(allowed.headers['access-control-allow-headers']).toContain('Authorization');
      expect(allowed.headers.vary).toBe('Origin');
      const unknown = await partnerHost.send('OPTIONS', REVOKE_PATH, {
        headers: { Origin: 'https://evil.example.test' },
      });
      expect(unknown.status).toBe(204);
      expect(unknown.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('does not reach the authority for a preflight', async () => {
      const handleRequest = vi.spyOn(runtime, 'handleRequest');
      try {
        await partnerHost.send('OPTIONS', TOKEN_PATH, { headers: { Origin: appOrigin } });
        expect(handleRequest).not.toHaveBeenCalled();
      } finally {
        handleRequest.mockRestore();
      }
    });

    it('lets only the authenticated app read a successful token response', async () => {
      const client = await environment.createClient({ publicClient: true, redirectOrigin: appOrigin });
      const otherApp = await environment.createClient({
        publicClient: true,
        redirectOrigin: 'https://other.example.test',
      });
      runtime.registeredOrigins.invalidate();
      const issuedForOwn = await environment.issueTokens(client);
      const issuedForOther = await environment.issueTokens(otherApp);
      const fromOwnOrigin = await sendToken(
        { grant_type: 'refresh_token', refresh_token: issuedForOwn.refresh_token!, ...clientCredentials(client) },
        { headers: { Origin: appOrigin } },
      );
      expect(fromOwnOrigin.status).toBe(200);
      expect(fromOwnOrigin.headers['access-control-allow-origin']).toBe(appOrigin);
      expect(fromOwnOrigin.headers['access-control-expose-headers']).toContain('Retry-After');
      expect(fromOwnOrigin.headers['access-control-allow-credentials']).toBeUndefined();

      const fromAnotherAppsOrigin = await sendToken(
        { grant_type: 'refresh_token', refresh_token: issuedForOther.refresh_token!, ...clientCredentials(otherApp) },
        { headers: { Origin: appOrigin } },
      );
      expect(fromAnotherAppsOrigin.status).toBe(200);
      expect(fromAnotherAppsOrigin.headers['access-control-allow-origin']).toBeUndefined();
    });

    it(
      'lets any registered origin read an error or a limit, but not an unregistered one',
      async () => {
        await environment.createClient({ publicClient: true, redirectOrigin: appOrigin });
        runtime.registeredOrigins.invalidate();
        const unauthenticated = await sendToken(
          { grant_type: 'authorization_code', client_id: 'no-such-client' },
          { headers: { Origin: appOrigin } },
        );
        expect(unauthenticated.status).toBeGreaterThanOrEqual(400);
        expect(unauthenticated.headers['access-control-allow-origin']).toBe(appOrigin);
        expect(unauthenticated.headers['access-control-expose-headers']).toContain('RateLimit-Limit');

        const unregistered = await sendToken(
          { grant_type: 'authorization_code', client_id: 'no-such-client' },
          { headers: { Origin: 'https://evil.example.test' } },
        );
        expect(unregistered.headers['access-control-allow-origin']).toBeUndefined();

        const clientIp = randomClientIp();
        let limited: SentResponse | undefined;
        for (let attempt = 0; attempt < 62 && !limited; attempt += 1) {
          const answered = await sendToken(
            { grant_type: 'authorization_code', client_id: 'no-such-client' },
            { headers: { Origin: appOrigin }, clientIp },
          );
          if (answered.status === 429) limited = answered;
        }
        expect(limited?.status).toBe(429);
        expect(limited?.headers['access-control-allow-origin']).toBe(appOrigin);
        expect(limited?.headers['access-control-expose-headers']).toContain('Retry-After');
      },
      TEST_DEADLINE_MS,
    );

    it('treats a suspended app as unregistered', async () => {
      const suspendedOrigin = `https://suspended-${randomUUID()}.example.test`;
      const client = await environment.createClient({ publicClient: true, redirectOrigin: suspendedOrigin });
      runtime.registeredOrigins.invalidate();
      expect(
        (await partnerHost.send('OPTIONS', TOKEN_PATH, { headers: { Origin: suspendedOrigin } })).headers[
          'access-control-allow-origin'
        ],
      ).toBe(suspendedOrigin);
      await db.execute(sql`update oauth_client set disabled = true where client_id = ${client.clientId}`);
      runtime.registeredOrigins.invalidate();
      expect(
        (await partnerHost.send('OPTIONS', TOKEN_PATH, { headers: { Origin: suspendedOrigin } })).headers[
          'access-control-allow-origin'
        ],
      ).toBeUndefined();
    });

    it('allows consent only from the web origin, with credentials', async () => {
      const preflight = await partnerHost.send('OPTIONS', CONSENT_PATH, {
        headers: { Origin: TEST_CONFIGURATION.webOrigin },
      });
      expect(preflight.headers['access-control-allow-origin']).toBe(TEST_CONFIGURATION.webOrigin);
      expect(preflight.headers['access-control-allow-credentials']).toBe('true');
      const other = await partnerHost.send('OPTIONS', CONSENT_PATH, { headers: { Origin: appOrigin } });
      expect(other.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('responses', () => {
    it('names every response, and logs clientId and requestId with no secrets', async () => {
      const info = vi.spyOn(logger, 'info');
      try {
        const client = await environment.createClient();
        const answered = await sendToken({
          grant_type: 'refresh_token',
          refresh_token: 'super-secret-refresh-value',
          client_id: client.clientId,
          client_secret: client.clientSecret!,
        });
        const requestId = answered.headers['boardsesh-request-id'];
        expect(requestId).toMatch(/^req_/);
        const logCalls = info.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
        const logged = logCalls.find(([message]) => message === 'Partner OAuth request');
        expect(logged?.[1]).toMatchObject({ requestId, clientId: client.clientId, route: 'token' });
        const allLogs = JSON.stringify(info.mock.calls);
        expect(allLogs).not.toContain('super-secret-refresh-value');
        expect(allLogs).not.toContain(client.clientSecret);
      } finally {
        info.mockRestore();
      }
    });

    it('marks every OAuth response uncacheable', async () => {
      const client = await environment.createClient({ publicClient: true });
      const issued = await environment.issueTokens(client);
      const refreshed = await sendToken({
        grant_type: 'refresh_token',
        refresh_token: issued.refresh_token!,
        ...clientCredentials(client),
      });
      expect(refreshed.status).toBe(200);
      expect(refreshed.headers['cache-control']).toBe('no-store');
    });

    it('does not forward a browser cookie to token or revoke', async () => {
      const client = await environment.createClient({ publicClient: true });
      const handleRequest = vi.spyOn(runtime, 'handleRequest');
      try {
        await sendToken(
          { grant_type: 'authorization_code', ...clientCredentials(client) },
          { headers: { Cookie: `${TEST_SESSION_COOKIE}=x; other=y` } },
        );
        expect(handleRequest.mock.calls[0][0].headers.get('cookie')).toBeNull();
      } finally {
        handleRequest.mockRestore();
      }
    });
  });

  describe('RFC 7009', () => {
    it('answers an unknown token with 200', async () => {
      const client = await environment.createClient({ publicClient: true });
      const answered = await partnerHost.send('POST', REVOKE_PATH, {
        ...formBody({ token: `unknown-${randomUUID()}`, ...clientCredentials(client) }),
      });
      expect(answered.status).toBe(200);
    });

    it('still refuses a confidential app with no secret', async () => {
      const client = await environment.createClient();
      const answered = await partnerHost.send('POST', REVOKE_PATH, {
        ...formBody({ token: `unknown-${randomUUID()}`, client_id: client.clientId }),
      });
      expect(answered.status).toBeGreaterThanOrEqual(400);
      expect(JSON.parse(answered.body).error).toBe('invalid_client');
    });

    it('still revokes a real refresh token', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      const answered = await partnerHost.send('POST', REVOKE_PATH, {
        ...formBody({ token: issued.refresh_token!, token_type_hint: 'refresh_token', ...clientCredentials(client) }),
      });
      expect(answered.status).toBe(200);
      const [revoked] = await db
        .select({ revoked: oauthRefreshToken.revoked })
        .from(oauthRefreshToken)
        .where(eq(oauthRefreshToken.userId, client.owner.userId));
      expect(revoked.revoked).not.toBeNull();
    });
  });
});

describe('getTrustedClientIp', () => {
  function requestFrom(socketPeer: string, headers: Record<string, string>) {
    return { socket: { remoteAddress: socketPeer }, headers } as unknown as IncomingMessage;
  }

  it('believes cf-connecting-ip only from a real Cloudflare edge', () => {
    expect(
      getTrustedClientIp(
        requestFrom('10.0.0.5', { 'x-forwarded-for': '8.8.8.8, 173.245.48.5', 'cf-connecting-ip': '203.0.113.9' }),
      ),
    ).toBe('203.0.113.9');
  });

  it('ignores a forged cf-connecting-ip from anywhere else', () => {
    expect(
      getTrustedClientIp(
        requestFrom('10.0.0.5', { 'x-forwarded-for': '198.51.100.7', 'cf-connecting-ip': '203.0.113.9' }),
      ),
    ).toBe('198.51.100.7');
  });

  it('takes the last forwarded hop, never the caller-written first one', () => {
    expect(getTrustedClientIp(requestFrom('10.0.0.5', { 'x-forwarded-for': '1.1.1.1, 198.51.100.7' }))).toBe(
      '198.51.100.7',
    );
  });

  it('falls back to the socket peer when no private ingress stands in front', () => {
    expect(getTrustedClientIp(requestFrom('198.51.100.7', { 'x-forwarded-for': '1.1.1.1' }))).toBe('198.51.100.7');
  });

  it.each([
    ['a compressed address', '2001:db8:1:2::5'],
    ['the same /64 with other interface bits', '2001:db8:1:2:aaaa:bbbb:cccc:dddd'],
    ['the fully written form', '2001:0db8:0001:0002:0000:0000:0000:0005'],
    ['upper case', '2001:DB8:1:2::5'],
  ])('reduces %s to its /64', (_label, address) => {
    expect(getTrustedClientIp(requestFrom('10.0.0.5', { 'x-forwarded-for': address }))).toBe('2001:db8:1:2::/64');
  });

  it('keeps different /64s apart', () => {
    expect(getTrustedClientIp(requestFrom('10.0.0.5', { 'x-forwarded-for': '2001:db8:1:3::5' }))).toBe(
      '2001:db8:1:3::/64',
    );
  });

  it('reduces a Cloudflare-reported IPv6 visitor too', () => {
    expect(
      getTrustedClientIp(
        requestFrom('10.0.0.5', { 'x-forwarded-for': '173.245.48.5', 'cf-connecting-ip': '2001:db8:9:9::1' }),
      ),
    ).toBe('2001:db8:9:9::/64');
  });

  it('reduces an IPv6 socket peer too', () => {
    expect(getTrustedClientIp(requestFrom('2001:db8:7:7::1', {}))).toBe('2001:db8:7:7::/64');
  });

  it.each([
    ['dotted', '::ffff:203.0.113.9'],
    ['hexadecimal', '::ffff:cb00:7109'],
    ['fully written', '0:0:0:0:0:ffff:cb00:7109'],
  ])('treats a %s IPv4-mapped address as that IPv4 address', (_label, address) => {
    expect(getTrustedClientIp(requestFrom('10.0.0.5', { 'x-forwarded-for': address }))).toBe('203.0.113.9');
  });
});

describe('the deployed partner routes', () => {
  it(
    'serves the routes in the real server with the mode on, and nothing else on the API host',
    async () => {
      const { startServer } = await import('../server');
      vi.stubEnv('PARTNER_OAUTH_MODE', 'allowlist');
      vi.stubEnv('PARTNER_OAUTH_SECRETS', '1:partner-oauth-test-secret-never-deployed-0123456789');
      vi.stubEnv('PORT', '0');
      const server = await startServer();
      const { getPartnerAuthorityRuntime } = await import('../auth/partner/authority');
      try {
        if (!server.httpServer.listening) await once(server.httpServer, 'listening');
        const { port } = server.httpServer.address() as AddressInfo;
        const send = (method: string, path: string, host: string, body?: string) =>
          new Promise<SentResponse>((resolve, reject) => {
            const outgoing = request(
              {
                port,
                path,
                method,
                agent: false,
                headers: {
                  Host: host,
                  'X-Forwarded-For': randomClientIp(),
                  'Content-Type': 'application/x-www-form-urlencoded',
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
            outgoing.end(body);
          });

        const discovery = await send('GET', METADATA_PATHS[0], API_HOSTNAME);
        expect(discovery.status).toBe(200);
        expect((JSON.parse(discovery.body) as { issuer: string }).issuer).toBe('https://api.boardsesh.com/api/auth');

        const unknownClient = await send(
          'GET',
          browserRouteTarget(AUTHORIZE_PATH, {
            response_type: 'code',
            client_id: 'no-such-client',
            redirect_uri: 'https://client.example.test/callback',
          }),
          API_HOSTNAME,
        );
        expect(unknownClient.status).toBe(302);
        expect(unknownClient.headers.location).toContain('https://api.boardsesh.com/api/auth/error');
        expect((await send('GET', `${ERROR_PATH}?error=invalid_client`, API_HOSTNAME)).status).toBe(400);

        const token = await send('POST', TOKEN_PATH, API_HOSTNAME, 'grant_type=authorization_code&client_id=missing');
        expect(token.headers['boardsesh-request-id']).toMatch(/^req_/);
        expect(token.status).toBeGreaterThanOrEqual(400);
        expect(token.status).toBeLessThan(500);

        // The rest of the API host stays shut, and other hosts see no partner route.
        expect((await send('GET', '/graphql', API_HOSTNAME)).status).toBe(404);
        expect((await send('GET', '/api/auth/oauth2/userinfo', API_HOSTNAME)).status).toBe(404);
        expect((await send('POST', TOKEN_PATH, 'ws.boardsesh.com', 'grant_type=x')).status).toBe(404);
        expect((await send('GET', '/health', API_HOSTNAME)).status).toBe(200);
      } finally {
        vi.unstubAllEnvs();
        server.cleanupIntervals();
        await new Promise<void>((resolve) => server.wss.close(() => resolve()));
        await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
        await (await getPartnerAuthorityRuntime()).close();
      }
    },
    TEST_DEADLINE_MS,
  );

  it(
    'mounts in the real server only when asked',
    async () => {
      const { startServer } = await import('../server');
      const { once: onceEvent } = await import('node:events');
      vi.stubEnv('PARTNER_OAUTH_MODE', 'hold');
      vi.stubEnv('PORT', '0');
      const server = await startServer();
      try {
        if (!server.httpServer.listening) await onceEvent(server.httpServer, 'listening');
        const { port } = server.httpServer.address() as AddressInfo;
        const answered = await new Promise<number>((resolve, reject) => {
          const outgoing = request(
            { port, path: TOKEN_PATH, method: 'POST', agent: false, headers: { Host: API_HOSTNAME } },
            (incoming) => {
              incoming.resume();
              incoming.on('end', () => resolve(incoming.statusCode ?? 0));
            },
          );
          outgoing.on('error', reject);
          outgoing.end();
        });
        expect(answered).toBe(503);
      } finally {
        vi.unstubAllEnvs();
        server.cleanupIntervals();
        await new Promise<void>((resolve) => server.wss.close(() => resolve()));
        await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
      }
    },
    TEST_DEADLINE_MS,
  );
});
