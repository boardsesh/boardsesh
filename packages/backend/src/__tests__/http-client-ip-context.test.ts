import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';

/**
 * Cover for issue #4034: anonymous HTTP requests must key their rate-limit
 * bucket on a trusted hop, not on the client-authored first `x-forwarded-for`
 * entry (which let a scripted caller mint a fresh bucket per request, or pin a
 * victim's IP to exhaust theirs).
 *
 * Normalization itself is owned by websocket-client-ip.test.ts; this file
 * covers the HTTP context builder and the `req` plumbing behind `yoga.handle`.
 */

const { resolverCalls } = vi.hoisted(() => ({
  resolverCalls: [] as { forwardedFor?: string; cloudflareIp?: string; remoteAddress?: string; resolved?: string }[],
}));

function headerText(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(',') : value;
}

// Wrap rather than replace: the real resolver keeps running (so the assertions
// below are about genuine behaviour), and every call is recorded with the Node
// request it actually saw. That recording is what makes the end-to-end case
// fail if the `req` plumbing in yoga.ts is deleted — a spy on yoga.ts's own
// `buildHttpConnectionContext` export could not, because `createYogaInstance`
// captures the same-module reference.
vi.mock('../websocket/client-ip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../websocket/client-ip')>();
  return {
    ...actual,
    resolveWebSocketClientIp: (req?: IncomingMessage) => {
      const resolved = actual.resolveWebSocketClientIp(req);
      resolverCalls.push({
        forwardedFor: headerText(req?.headers['x-forwarded-for']),
        cloudflareIp: headerText(req?.headers['cf-connecting-ip']),
        remoteAddress: req?.socket?.remoteAddress,
        resolved,
      });
      return resolved;
    },
  };
});

vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    ...actual,
    validateToken: async (token: string) =>
      token === 'valid-token' ? { userId: 'user-1', isAuthenticated: true } : null,
  };
});

import { buildHttpConnectionContext, createYogaInstance } from '../graphql/yoga';

/** Minimal stand-in for the Node request Yoga hands the context factory. */
function nodeRequest(options: { headers?: Record<string, string>; remoteAddress?: string }): IncomingMessage {
  return {
    headers: options.headers ?? {},
    socket: { remoteAddress: options.remoteAddress },
  } as unknown as IncomingMessage;
}

function fetchRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/graphql', { method: 'POST', headers });
}

describe('buildHttpConnectionContext client IP', () => {
  beforeEach(() => {
    resolverCalls.length = 0;
  });

  it('ignores a client-authored first forwarded hop and keys on the last one', async () => {
    const context = await buildHttpConnectionContext({
      request: fetchRequest(),
      req: nodeRequest({ headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, remoteAddress: '10.0.0.5' }),
    });

    expect(context.clientIp).toBe('203.0.113.9');
  });

  it('prefers cf-connecting-ip over the forwarded chain', async () => {
    const context = await buildHttpConnectionContext({
      request: fetchRequest(),
      req: nodeRequest({
        headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '6.6.6.6, 198.51.100.4' },
        remoteAddress: '10.0.0.5',
      }),
    });

    expect(context.clientIp).toBe('203.0.113.7');
  });

  it('trusts a single-hop forwarded chain — the residual a direct-origin caller can still forge', async () => {
    const context = await buildHttpConnectionContext({
      request: fetchRequest(),
      req: nodeRequest({ headers: { 'x-forwarded-for': '203.0.113.9' }, remoteAddress: '10.0.0.5' }),
    });

    // Behind Cloudflare a lone entry IS our edge's own observation, so trusting
    // it is right. Reaching the Railway origin directly it is client-authored
    // again — the documented residual this fix does not close, shared with
    // og-climb.ts and the WebSocket path (#4034).
    expect(context.clientIp).toBe('203.0.113.9');
  });

  it('falls through to the socket peer when the forwarded chain is junk', async () => {
    const context = await buildHttpConnectionContext({
      request: fetchRequest(),
      req: nodeRequest({ headers: { 'x-forwarded-for': 'not-an-ip' }, remoteAddress: '198.51.100.44' }),
    });

    expect(context.clientIp).toBe('198.51.100.44');
  });

  it('keys a direct-to-origin caller on the socket peer instead of a per-request bucket', async () => {
    // Pre-fix this request resolved to undefined and fell through to the
    // `http-<uuid>` connectionId branch of applyRateLimit — a fresh bucket per
    // request, i.e. no limit at all.
    const first = await buildHttpConnectionContext({
      request: fetchRequest(),
      req: nodeRequest({ remoteAddress: '198.51.100.44' }),
    });
    const second = await buildHttpConnectionContext({
      request: fetchRequest(),
      req: nodeRequest({ remoteAddress: '198.51.100.44' }),
    });

    expect(first.connectionId).not.toBe(second.connectionId);
    expect(first.clientIp).toBe('198.51.100.44');
    expect(second.clientIp).toBe(first.clientIp);
  });

  it('ignores x-real-ip entirely', async () => {
    const context = await buildHttpConnectionContext({
      request: fetchRequest({ 'x-real-ip': '6.6.6.6' }),
      req: nodeRequest({ headers: { 'x-real-ip': '6.6.6.6' }, remoteAddress: '198.51.100.44' }),
    });

    expect(context.clientIp).toBe('198.51.100.44');
  });

  it('groups an IPv6 client on its /64 prefix', async () => {
    const context = await buildHttpConnectionContext({
      request: fetchRequest(),
      req: nodeRequest({ headers: { 'cf-connecting-ip': '2001:db8:1:2:3:4:5:6' } }),
    });

    expect(context.clientIp).toBe('2001:db8:1:2::/64');
  });

  it('leaves clientIp undefined when there is no Node request (yoga.fetch path)', async () => {
    const context = await buildHttpConnectionContext({ request: fetchRequest() });

    expect(context.clientIp).toBeUndefined();
    expect(context.isAuthenticated).toBe(false);
  });

  it('carries the derived clientIp on authenticated contexts too', async () => {
    const req = nodeRequest({ headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' } });

    const authenticated = await buildHttpConnectionContext({
      request: fetchRequest({ authorization: 'Bearer valid-token' }),
      req,
    });
    const anonymous = await buildHttpConnectionContext({ request: fetchRequest(), req });

    expect(authenticated.isAuthenticated).toBe(true);
    expect(authenticated.userId).toBe('user-1');
    expect(authenticated.clientIp).toBe('203.0.113.9');
    expect(anonymous.isAuthenticated).toBe(false);
    expect(anonymous.userId).toBeUndefined();
    expect(anonymous.clientIp).toBe('203.0.113.9');
  });
});

describe('Yoga HTTP request wiring', () => {
  let httpServer: Server;
  let graphqlUrl: string;

  beforeAll(async () => {
    const yoga = createYogaInstance();
    httpServer = createServer((req, res) => {
      void yoga.handle(req, res);
    });
    const port = await new Promise<number>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => {
        const address = httpServer.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Test server did not expose a TCP port'));
          return;
        }
        resolve(address.port);
      });
    });
    graphqlUrl = `http://127.0.0.1:${port}/graphql`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
  });

  beforeEach(() => {
    resolverCalls.length = 0;
  });

  async function query(headers: Record<string, string>): Promise<void> {
    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ query: '{ __typename }' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { __typename: 'Query' } });
  }

  it('hands the real Node request, forged proxy headers and all, to the IP resolver', async () => {
    await query({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9', 'x-real-ip': '6.6.6.6' });

    const call = resolverCalls.at(-1);
    expect(call).toBeDefined();
    // A missing `req` (deleted plumbing) shows up here as an undefined chain and
    // an undefined resolution, not as a silently-passing unit test.
    expect(call?.forwardedFor).toBe('6.6.6.6, 203.0.113.9');
    expect(call?.resolved).toBe('203.0.113.9');
  });

  it('resolves the loopback socket peer when a real request sends no proxy headers', async () => {
    await query({});

    const call = resolverCalls.at(-1);
    expect(call?.forwardedFor).toBeUndefined();
    expect(call?.remoteAddress).toBeDefined();
    expect(call?.resolved).toBe('127.0.0.1');
  });

  it('registers the gym refresh mutation and enforces cron authentication in the full schema', async () => {
    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/graphql-response+json' },
      body: JSON.stringify({ query: 'mutation { refreshGymActivityStats { gymCount } }' }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      errors: [{ message: 'Cron authentication required', extensions: { code: 'UNAUTHENTICATED' } }],
    });
  });
});
