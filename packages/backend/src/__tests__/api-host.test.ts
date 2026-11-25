import { once } from 'node:events';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { WebSocket } from 'ws';
import {
  CATALOG_SCRAPER_BLOCK_START_MS,
  CATALOG_SCRAPER_REFUSAL,
  CATALOG_SCRAPER_USER_AGENT,
} from '@boardsesh/shared-schema/catalog-scraper-policy';

import { API_HOSTNAME, isApiHost, rejectApiHostRequest } from '../handlers/api-host';
import { startServer } from '../server';

describe('isApiHost', () => {
  it.each([
    [API_HOSTNAME],
    ['API.Boardsesh.COM'],
    [`${API_HOSTNAME}:443`],
    [`${API_HOSTNAME}:`],
    [`${API_HOSTNAME}.`],
    [`${API_HOSTNAME}.:8443`],
    [` ${API_HOSTNAME} `],
    [`${API_HOSTNAME}..`],
    [`${API_HOSTNAME}:abc`],
    [`${API_HOSTNAME}:1:2`],
    [`${API_HOSTNAME}/`],
    [`${API_HOSTNAME}/x`],
    [`${API_HOSTNAME}?x`],
    [`${API_HOSTNAME}#x`],
    [`u@${API_HOSTNAME}`],
    [`a@b@${API_HOSTNAME}`],
    [`${API_HOSTNAME}@`],
    [`${API_HOSTNAME}@@`],
    [`${API_HOSTNAME}\\`],
    [`${API_HOSTNAME}, x`],
    [`/${API_HOSTNAME}`],
    [`\\${API_HOSTNAME}`],
    ['%61pi.boardsesh.com'],
    ['api%2eboardsesh.com'],
    ['a\tpi.boardsesh.com'],
    [`\xad${API_HOSTNAME}`],
    ['\xaapi.boardsesh.com'],
    ['api.b\xbaardsesh.com'],
    [`${API_HOSTNAME} x`],
    [`${API_HOSTNAME}<`],
    [`${API_HOSTNAME}>`],
    [`${API_HOSTNAME}|`],
    [`${API_HOSTNAME}%`],
    [`${API_HOSTNAME}[`],
    [`${API_HOSTNAME}]`],
    [`${API_HOSTNAME}^`],
    [`${API_HOSTNAME};`],
    [`${API_HOSTNAME}&`],
    [`${API_HOSTNAME}!`],
    [`${API_HOSTNAME}$`],
    [`${API_HOSTNAME}'`],
    [`${API_HOSTNAME}(`],
    [`${API_HOSTNAME})`],
    [`${API_HOSTNAME}*`],
    [`${API_HOSTNAME}+`],
    [`${API_HOSTNAME}=`],
    [`${API_HOSTNAME}_`],
    [`${API_HOSTNAME}~`],
    [`${API_HOSTNAME}\xe9`],
  ])('recognises %j', (hostHeader) => {
    expect(isApiHost(hostHeader)).toBe(true);
  });

  it.each([
    ['ws.boardsesh.com'],
    ['www.boardsesh.com'],
    ['localhost:8080'],
    ['boardsesh-backend.railway.internal:8080'],
    ['[::1]:8080'],
    [`${API_HOSTNAME}.evil.com`],
    ['notapi.boardsesh.com'],
    [`${API_HOSTNAME}.evil.example`],
    [`evil.example/${API_HOSTNAME}`],
    [`evil.com/${API_HOSTNAME}`],
    [`evil.com?${API_HOSTNAME}`],
    [`evil.com#${API_HOSTNAME}`],
    [`${API_HOSTNAME}@evil.com`],
    [`evil.com:${API_HOSTNAME}`],
    [`x.${API_HOSTNAME}`],
    [`x-${API_HOSTNAME}`],
    [`${API_HOSTNAME}-x`],
    [`${API_HOSTNAME}x`],
    [''],
    [undefined],
  ])('does not recognise %j', (hostHeader) => {
    expect(isApiHost(hostHeader)).toBe(false);
  });

  // The dispatcher trusts what `new URL` reads, so nothing it reads as the API
  // host may slip past the filter. Latin-1, as Node decodes header bytes.
  // `@` is left out because what follows it is the host, and here nothing does.
  it('recognises the API host followed by any byte that cannot continue a name', () => {
    const missed: string[] = [];
    for (let byte = 1; byte <= 255; byte += 1) {
      const character = String.fromCharCode(byte);
      if (/[a-z0-9.@-]/i.test(character)) continue;
      if (!isApiHost(`${API_HOSTNAME}${character}`)) missed.push(`${API_HOSTNAME}${character}`);
    }
    expect(missed).toEqual([]);
  });

  it('recognises every single-byte variation that new URL reads as the API host', () => {
    const missed: string[] = [];
    for (let position = 0; position <= API_HOSTNAME.length; position += 1) {
      for (let byte = 1; byte <= 255; byte += 1) {
        const character = String.fromCharCode(byte);
        const candidates = [
          API_HOSTNAME.slice(0, position) + character + API_HOSTNAME.slice(position),
          API_HOSTNAME.slice(0, position) + character + API_HOSTNAME.slice(position + 1),
        ];
        for (const candidate of candidates) {
          if (URL.canParse(`http://${candidate}`) && new URL(`http://${candidate}`).hostname === API_HOSTNAME) {
            if (!isApiHost(candidate)) missed.push(candidate);
          }
        }
      }
    }
    expect(missed).toEqual([]);
  });
});

describe('rejectApiHostRequest', () => {
  function respondingTo(method: string, pathname: string, host: string) {
    const written: { status?: number; headers?: Record<string, string>; body?: string } = {};
    const response = {
      writeHead(status: number, headers: Record<string, string>) {
        written.status = status;
        written.headers = headers;
      },
      end(body: string) {
        written.body = body;
      },
    };
    const incoming = { method, headers: { host } };
    const rejected = rejectApiHostRequest(
      incoming as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      pathname,
    );
    return { rejected, written };
  }

  it('lets GET /health through on the API host without writing anything', () => {
    expect(respondingTo('GET', '/health', API_HOSTNAME)).toEqual({ rejected: false, written: {} });
  });

  it.each([
    ['GET', '/health/db'],
    ['GET', '/health/'],
    ['HEAD', '/health'],
    ['POST', '/health'],
    ['OPTIONS', '/health'],
    ['GET', '/graphql'],
    ['POST', '/graphql'],
    ['GET', '/robots.txt'],
    ['POST', '/auth/native/credentials'],
    ['GET', '/'],
  ])('answers %s %s with the plain 404', (method, pathname) => {
    expect(respondingTo(method, pathname, API_HOSTNAME)).toEqual({
      rejected: true,
      written: {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Not found' }),
      },
    });
  });

  it.each([
    ['GET', '/graphql'],
    ['POST', '/auth/native/credentials'],
    ['GET', '/robots.txt'],
  ])('leaves %s %s alone on every other host', (method, pathname) => {
    expect(respondingTo(method, pathname, 'ws.boardsesh.com')).toEqual({ rejected: false, written: {} });
  });
});

// The dispatcher and the upgrade check live inside startServer, so these drive
// the real server to prove both are actually wired to the filter.
describe('the running server on the API host', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let port = 0;

  afterEach(() => vi.restoreAllMocks());

  beforeAll(async () => {
    process.env.PORT = '0';
    server = await startServer({ host: '127.0.0.1' });
    if (!server.httpServer.listening) await once(server.httpServer, 'listening');
    const address = server.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server address');
    port = address.port;
  });

  afterAll(async () => {
    server.cleanupIntervals();
    await new Promise<void>((resolve) => server.wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
  });

  function send(method: string, path: string, host: string, body?: string, userAgent = 'boardsesh-test/1.0') {
    return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const outgoing = request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          agent: false,
          headers: { Host: host, 'Content-Type': 'application/json', 'User-Agent': userAgent },
        },
        (incoming) => {
          let received = '';
          incoming.setEncoding('utf8');
          incoming.on('data', (chunk: string) => {
            received += chunk;
          });
          incoming.on('end', () => resolve({ status: incoming.statusCode, body: received }));
        },
      );
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  }

  function openWebSocket(host: string, userAgent = 'boardsesh-test/1.0') {
    return new Promise<'open' | number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/graphql`, 'graphql-transport-ws', {
        headers: { Host: host, 'User-Agent': userAgent },
      });
      socket.once('open', () => {
        socket.terminate();
        resolve('open');
      });
      socket.once('unexpected-response', (clientRequest, response) => {
        const status = response.statusCode ?? 0;
        clientRequest.destroy();
        resolve(status);
      });
      socket.once('error', reject);
    });
  }

  it('answers GET /health', async () => {
    expect((await send('GET', '/health', API_HOSTNAME)).status).toBe(200);
  });

  it.each([
    ['GET', '/health/db'],
    ['GET', '/robots.txt'],
    ['GET', '/graphql'],
    // PARTNER_OAUTH_MODE is unset in this suite, so every partner route is off.
    ['GET', '/api/auth/oauth2/authorize'],
    ['POST', '/api/auth/oauth2/token'],
    ['POST', '/api/auth/oauth2/revoke'],
    ['POST', '/api/auth/oauth2/consent'],
    ['POST', '/api/auth/oauth2/consent-details'],
    ['GET', '/.well-known/oauth-authorization-server/api/auth'],
    ['GET', '/api/auth/.well-known/oauth-authorization-server'],
    ['GET', '/api/auth/error'],
    // The public /v1 API shares the mode, so it is off too.
    ['GET', '/v1/me'],
    ['DELETE', '/v1/connection'],
    ['OPTIONS', '/v1/me'],
    ['OPTIONS', '/v1/connection'],
    ['GET', '/v1/openapi.json'],
    // So are the logbook routes (L4).
    ['GET', '/v1/logbook/changes'],
    ['GET', '/v1/logbook/changes?cursor=c3.expired'],
    ['GET', '/v1/logbook/ticks/0d6c4a2e-8f1b-4b7e-9c3a-5e2f1d0a9b77'],
    ['OPTIONS', '/v1/logbook/changes'],
    ['OPTIONS', '/v1/logbook/ticks/0d6c4a2e-8f1b-4b7e-9c3a-5e2f1d0a9b77'],
  ])('answers %s %s with 404', async (method, path) => {
    expect(await send(method, path, API_HOSTNAME)).toEqual({
      status: 404,
      body: JSON.stringify({ error: 'Not found' }),
    });
  });

  it('refuses a GraphQL POST that ws.boardsesh.com accepts', async () => {
    const query = JSON.stringify({ query: '{ __typename }' });
    expect((await send('POST', '/graphql', API_HOSTNAME, query)).status).toBe(404);
    expect((await send('POST', '/graphql', 'ws.boardsesh.com', query)).status).toBe(200);
  });

  it('refuses a WebSocket upgrade that ws.boardsesh.com accepts', async () => {
    await expect(openWebSocket(API_HOSTNAME)).resolves.toBe(404);
    await expect(openWebSocket('ws.boardsesh.com')).resolves.toBe('open');
  });

  it('allows the announced scraper over HTTP and WebSocket before its deadline', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(CATALOG_SCRAPER_BLOCK_START_MS - 1);
    const query = JSON.stringify({ query: '{ __typename }' });
    expect((await send('POST', '/graphql', 'ws.boardsesh.com', query, CATALOG_SCRAPER_USER_AGENT)).status).toBe(200);
    await expect(openWebSocket('ws.boardsesh.com', CATALOG_SCRAPER_USER_AGENT)).resolves.toBe('open');
  });

  it('refuses the scraper at the deadline on the public and direct-origin hosts', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(CATALOG_SCRAPER_BLOCK_START_MS);
    const query = JSON.stringify({ query: '{ __typename }' });
    for (const host of ['ws.boardsesh.com', 'backend-origin.example']) {
      expect(await send('POST', '/graphql', host, query, CATALOG_SCRAPER_USER_AGENT)).toEqual({
        status: 403,
        body: JSON.stringify(CATALOG_SCRAPER_REFUSAL),
      });
      await expect(openWebSocket(host, CATALOG_SCRAPER_USER_AGENT)).resolves.toBe(403);
    }
  });

  it('refuses new operations on a scraper WebSocket opened before the deadline', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(CATALOG_SCRAPER_BLOCK_START_MS - 1);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/graphql`, 'graphql-transport-ws', {
      headers: { Host: 'ws.boardsesh.com', 'User-Agent': CATALOG_SCRAPER_USER_AGENT },
    });
    try {
      const result = await new Promise<{ before: unknown; after: unknown }>((resolve, reject) => {
        let before: unknown;
        socket.once('open', () => socket.send(JSON.stringify({ type: 'connection_init' })));
        socket.once('error', reject);
        socket.once('close', () => reject(new Error('Socket closed before the cutoff assertion')));
        socket.on('message', (message) => {
          const encodedResponse = Array.isArray(message)
            ? Buffer.concat(message)
            : message instanceof ArrayBuffer
              ? Buffer.from(message)
              : message;
          const responseText = encodedResponse.toString('utf8');
          const response = JSON.parse(responseText) as { type: string; id?: string; payload?: unknown };
          if (response.type === 'connection_ack') {
            socket.send(JSON.stringify({ id: 'before', type: 'subscribe', payload: { query: '{ __typename }' } }));
          } else if (response.type === 'next' && response.id === 'before') {
            before = response.payload;
          } else if (response.type === 'complete' && response.id === 'before') {
            clock.mockReturnValue(CATALOG_SCRAPER_BLOCK_START_MS);
            socket.send(JSON.stringify({ id: 'after', type: 'subscribe', payload: { query: '{ __typename }' } }));
          } else if (response.type === 'error' && response.id === 'after') {
            resolve({ before, after: response.payload });
          } else {
            reject(new Error(`Unexpected WebSocket response: ${responseText}`));
          }
        });
      });
      const { message, ...extensions } = CATALOG_SCRAPER_REFUSAL;
      expect(result.before).toEqual({ data: { __typename: 'Query' } });
      expect(result.after).toEqual([{ message, extensions }]);
    } finally {
      socket.terminate();
    }
  });

  it('preserves other GraphQL clients and non-catalog routes after the deadline', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(CATALOG_SCRAPER_BLOCK_START_MS + 1);
    const query = JSON.stringify({ query: '{ __typename }' });
    expect((await send('POST', '/graphql', 'ws.boardsesh.com', query, 'Mozilla/5.0')).status).toBe(200);
    await expect(openWebSocket('ws.boardsesh.com', 'Boardsesh/1.0')).resolves.toBe('open');
    expect((await send('GET', '/health', 'ws.boardsesh.com', undefined, CATALOG_SCRAPER_USER_AGENT)).status).toBe(200);
  });

  it.each([`${API_HOSTNAME}@`, `${API_HOSTNAME}@@`])(
    'answers Host %j over HTTP without serving GraphQL',
    async (host) => {
      const { status } = await send('GET', '/graphql', host);
      expect([400, 404]).toContain(status);
    },
  );

  it.each([`${API_HOSTNAME}@`, `${API_HOSTNAME}@@`])('refuses a WebSocket upgrade with Host %j', async (host) => {
    await expect(openWebSocket(host)).resolves.not.toBe('open');
  });

  it('keeps robots.txt on ws.boardsesh.com', async () => {
    expect((await send('GET', '/robots.txt', 'ws.boardsesh.com')).status).toBe(200);
  });
});
