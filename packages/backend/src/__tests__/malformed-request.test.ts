import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { API_HOSTNAME } from '../handlers/api-host';
import { createMalformedRequestRecorder, MALFORMED_REQUEST_LOG_INTERVAL_MS } from '../handlers/request-guard';
import { startServer } from '../server';
import { logger } from '../utils/logger';
import { getWorkerDatabaseUrl } from './worker-db';
import { WebSocket } from 'ws';

// Replaces one route's handler so these tests can throw from inside the real
// dispatcher. Everything else about the server is the production code path.
const robotsRoute = vi.hoisted(() => ({
  override: null as ((res: ServerResponse) => void) | null,
}));

vi.mock('../handlers/robots', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../handlers/robots')>();
  return {
    ...actual,
    handleRobotsTxt: (...args: Parameters<typeof actual.handleRobotsTxt>) => {
      if (robotsRoute.override) robotsRoute.override(args[1]);
      else actual.handleRobotsTxt(...args);
    },
  };
});

// Counts what the running server reports, because the tally itself only reaches
// the log once per real minute.
const recordedRefusals = vi.hoisted(() => ({ count: 0 }));

// What the region trust check decided, as seen from inside Yoga's context.
const edgeRegionDecisions = vi.hoisted(() => [] as Array<string | undefined>);

vi.mock('../utils/flag-country', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/flag-country')>();
  return {
    ...actual,
    resolveEdgeRegionCode: (...args: Parameters<typeof actual.resolveEdgeRegionCode>) => {
      const decision = actual.resolveEdgeRegionCode(...args);
      edgeRegionDecisions.push(decision);
      return decision;
    },
  };
});

// Forces the rejection branch, which a real cap would need many sockets to reach.
const anonymousCap = vi.hoisted(() => ({ rejectEveryone: false }));

vi.mock('../websocket/connection-cap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../websocket/connection-cap')>();
  return {
    ...actual,
    tryAcquireAnonConnectionSlot: (...args: Parameters<typeof actual.tryAcquireAnonConnectionSlot>) =>
      anonymousCap.rejectEveryone
        ? { allowed: false, rejection: { tier: 'client-ip', key: 'ip:test', active: 1, limit: 1 } }
        : actual.tryAcquireAnonConnectionSlot(...args),
  };
});

vi.mock('../handlers/request-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../handlers/request-guard')>();
  return {
    ...actual,
    createMalformedRequestRecorder: () => {
      const recorder = actual.createMalformedRequestRecorder();
      return {
        ...recorder,
        record: () => {
          recordedRefusals.count += 1;
          recorder.record();
        },
      };
    },
  };
});

type RawResponse = {
  statusLine: string | null;
  headers: string;
  body: string;
  serverClosed: boolean;
};

const REFUSED_BODY = JSON.stringify({ error: 'Bad request' });
const DEADLINE_MS = 3_000;
const HEALTHY_ROUTE_DEADLINE_MS = 8_000;
/** How long a response may keep arriving, and the server may close, after the first byte. */
const SETTLE_AFTER_FIRST_BYTE_MS = 100;

/**
 * Sends bytes exactly as written, which `http.request` and `fetch` refuse to do
 * for most of these inputs. Latin-1, so `\xNN` puts that one byte on the wire.
 * Resolves with no status line when the deadline passes in silence.
 */
function sendRaw(port: number, request: string, deadlineMs = DEADLINE_MS): Promise<RawResponse> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    let received = '';
    let serverClosed = false;
    let settleTimer: NodeJS.Timeout | undefined;

    const finish = () => {
      clearTimeout(deadlineTimer);
      clearTimeout(settleTimer);
      socket.removeAllListeners();
      socket.on('error', () => undefined);
      socket.destroy();
      const headerEnd = received.indexOf('\r\n\r\n');
      const head = headerEnd === -1 ? received : received.slice(0, headerEnd);
      resolve({
        statusLine: received ? (head.split('\r\n')[0] ?? null) : null,
        headers: head.toLowerCase(),
        body: headerEnd === -1 ? '' : received.slice(headerEnd + 4),
        serverClosed,
      });
    };

    const deadlineTimer = setTimeout(finish, deadlineMs);
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
      clearTimeout(settleTimer);
      settleTimer = setTimeout(finish, SETTLE_AFTER_FIRST_BYTE_MS);
    });
    socket.on('close', () => {
      serverClosed = true;
      finish();
    });
    socket.on('error', () => undefined);
    socket.write(Buffer.from(request, 'latin1'));
  });
}

function requestBytes(target: string, host: string | null, options: { method?: string; extra?: string } = {}): string {
  const { method = 'GET', extra = '' } = options;
  const hostLine = host === null ? '' : `Host: ${host}\r\n`;
  return `${method} ${target} HTTP/1.1\r\n${hostLine}${extra}\r\n`;
}

function http10Bytes(target: string, host: string | null): string {
  const hostLine = host === null ? '' : `Host: ${host}\r\n`;
  return `GET ${target} HTTP/1.0\r\n${hostLine}\r\n`;
}

function graphqlPostBytes(target: string, host: string, extraHeaders = ''): string {
  const query = JSON.stringify({ query: '{ __typename }' });
  const extra = `${extraHeaders}Content-Type: application/json\r\nContent-Length: ${query.length}\r\n`;
  return requestBytes(target, host, { method: 'POST', extra }) + query;
}

const shown = (input: string) =>
  input.length > 40 ? `${JSON.stringify(input.slice(0, 40))}… (${input.length})` : JSON.stringify(input);

// Node's parser accepts every one of these and hands it to the request
// listener. `new URL` then throws, because the parsed base is `http://<Host>`
// and a scheme-relative target (`//…`) names a host of its own.
const UNPARSEABLE_TARGETS = [
  '//',
  '///',
  '////',
  '//:',
  '//:80',
  '//[',
  '//[::1',
  '//x:abc',
  '//x:abc/health',
  '//@',
  '//?',
  '//#',
  '/\\',
  '/\\\\',
  '//\\',
  'http://',
  'http:///',
  'http://[',
  'http://[::1',
  'http://x:abc/',
  'http://x:99999/',
  'http://@/',
  'foo://[',
  `//[${'a'.repeat(15_000)}`,
].map((target) => [shown(target), target] as const);

const UNPARSEABLE_HOSTS = [
  'x:abc',
  'x:99999',
  'x:65536',
  'x:-1',
  'x:1a',
  ':80',
  ':',
  '::',
  '::1',
  '[::1',
  '[::1]:abc',
  '[::1]x',
  '[]',
  '[z]',
  '[:::]',
  '::1]',
  '[fe80::1%25en0]',
  '[fe80::1%en0]',
  'a b',
  'a, b',
  '@',
  '#',
  '?',
  '/',
  '//',
  '\\',
  '%',
  '%zz',
  'a%b',
  '<',
  '>',
  '^',
  '|',
  '1.2.3.256',
  '0x100000000',
  '999.999.999.999',
  '1.1.1.1.1',
  '4294967296',
  'xn--',
  'xn--a',
  '\x80',
  '\xa0',
  '\xad',
  `${API_HOSTNAME}:abc`,
].map((host) => [shown(host), host] as const);

const OTHER_UNPARSEABLE_REQUESTS: ReadonlyArray<readonly [string, string, string]> = [
  [
    'POST // with its whole body',
    requestBytes('//', 'localhost', { method: 'POST', extra: 'Content-Length: 5\r\n' }) + 'hello',
    REFUSED_BODY,
  ],
  [
    'POST // with a body that never finishes',
    requestBytes('//', 'localhost', { method: 'POST', extra: 'Content-Length: 500\r\n' }) + 'he',
    REFUSED_BODY,
  ],
  ['an HTTP/1.0 // with no Host', http10Bytes('//', null), REFUSED_BODY],
  ['an HTTP/1.0 request with Host x:abc', http10Bytes('/nope', 'x:abc'), REFUSED_BODY],
  ['two Hosts, the first bad', `GET /nope HTTP/1.1\r\nHost: x:abc\r\nHost: localhost\r\n\r\n`, REFUSED_BODY],
  [
    'an Upgrade header without Connection: Upgrade',
    requestBytes('//', 'localhost', { extra: 'Upgrade: websocket\r\n' }),
    REFUSED_BODY,
  ],
  ['HEAD //, which has no body', requestBytes('//', 'localhost', { method: 'HEAD' }), ''],
];

const WEBSOCKET_HEADERS =
  'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: graphql-transport-ws\r\n';

describe('the running server', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let port = 0;
  const unhandledRejections: unknown[] = [];
  const uncaughtExceptions: unknown[] = [];
  const originalRejectionListeners = process.rawListeners('unhandledRejection') as NodeJS.UnhandledRejectionListener[];
  const originalExceptionListeners = process.rawListeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];

  beforeAll(async () => {
    // Recorders in place of the runner's own, so a stray rejection fails the
    // row that caused it rather than the whole run.
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
    process.on('unhandledRejection', (reason) => unhandledRejections.push(reason));
    process.on('uncaughtException', (error) => uncaughtExceptions.push(error));

    process.env.PORT = '0';
    server = await startServer();
    if (!server.httpServer.listening) await once(server.httpServer, 'listening');
    const address = server.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server address');
    port = address.port;
  });

  afterAll(async () => {
    server.cleanupIntervals();
    server.wss.clients.forEach((client) => client.terminate());
    await new Promise<void>((resolve) => server.wss.close(() => resolve()));
    server.httpServer.closeAllConnections();
    await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));

    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
    for (const listener of originalRejectionListeners) process.on('unhandledRejection', listener);
    for (const listener of originalExceptionListeners) process.on('uncaughtException', listener);
  });

  afterEach(async () => {
    robotsRoute.override = null;
    vi.restoreAllMocks();
    // A rejection is reported on a later tick than the response that exposed it.
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandledRejections.splice(0)).toEqual([]);
    expect(uncaughtExceptions.splice(0)).toEqual([]);
  });

  function expectRefused(response: RawResponse, body = REFUSED_BODY) {
    expect(response.statusLine).toBe('HTTP/1.1 400 Bad Request');
    expect(response.headers).toContain('connection: close');
    expect(response.body).toBe(body);
    expect(response.serverClosed).toBe(true);
  }

  describe('refuses what it cannot parse', () => {
    it.each(UNPARSEABLE_TARGETS)('target %s', async (_label, target) => {
      expectRefused(await sendRaw(port, requestBytes(target, 'localhost')));
    });

    it.each(UNPARSEABLE_HOSTS)('Host %s', async (_label, host) => {
      expectRefused(await sendRaw(port, requestBytes('/nope', host)));
    });

    it.each(OTHER_UNPARSEABLE_REQUESTS)('%s', async (_label, request, expectedBody) => {
      expectRefused(await sendRaw(port, request), expectedBody);
    });

    it('sends one response when another request is pipelined behind the bad one', async () => {
      const response = await sendRaw(port, requestBytes('//', 'localhost') + requestBytes('/nope', 'localhost'));
      expectRefused(response);
      expect(response.body).not.toContain('HTTP/1.1');
    });
  });

  describe('logging', () => {
    it('keeps the sender’s bytes out of every log and logs a burst no more than once', async () => {
      const errorLog = vi.spyOn(logger, 'error');
      const warnLog = vi.spyOn(logger, 'warn');
      const infoLog = vi.spyOn(logger, 'info');
      const canary = 'canary-from-the-sender';
      const refusalsBefore = recordedRefusals.count;

      for (let attempt = 0; attempt < 25; attempt += 1) {
        expectRefused(await sendRaw(port, requestBytes(`//${canary}:abc`, `${canary}:abc`)));
      }

      expect(recordedRefusals.count - refusalsBefore).toBe(25);
      expect(errorLog).not.toHaveBeenCalled();
      expect(warnLog.mock.calls.length).toBeLessThanOrEqual(1);
      expect(JSON.stringify([warnLog.mock.calls, infoLog.mock.calls])).not.toContain(canary);
    });
  });

  // Node answers these itself before the listener runs. Pinned so a change to
  // the parser settings or a `clientError` handler shows up here.
  describe('leaves Node’s own refusals alone', () => {
    it.each([
      ['a control byte in the target', requestBytes('/a\x01b', 'localhost'), 'HTTP/1.1 400 Bad Request'],
      ['a control byte in the Host', requestBytes('/nope', 'a\x01b'), 'HTTP/1.1 400 Bad Request'],
      ['DEL in the Host', requestBytes('/nope', 'a\x7fb'), 'HTTP/1.1 400 Bad Request'],
      ['a target with no leading slash', requestBytes('a', 'localhost'), 'HTTP/1.1 400 Bad Request'],
      ['HTTP/1.1 with no Host', requestBytes('/health', null), 'HTTP/1.1 400 Bad Request'],
      ['an HTTP/2 preface', 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'HTTP/1.1 400 Bad Request'],
      [
        'a 17 KB target',
        requestBytes(`/${'a'.repeat(17_000)}`, 'localhost'),
        'HTTP/1.1 431 Request Header Fields Too Large',
      ],
      ['a 17 KB Host', requestBytes('/nope', 'a'.repeat(17_000)), 'HTTP/1.1 431 Request Header Fields Too Large'],
    ])('%s', async (_label, request, statusLine) => {
      const response = await sendRaw(port, request);
      expect(response.statusLine).toBe(statusLine);
      expect(response.serverClosed).toBe(true);
    });

    it('closes a CONNECT without a response', async () => {
      const response = await sendRaw(port, 'CONNECT x:abc HTTP/1.1\r\nHost: x:abc\r\n\r\n');
      expect(response.statusLine).toBeNull();
      expect(response.serverClosed).toBe(true);
    });
  });

  describe('keeps answering what it always answered', () => {
    it.each([
      ['GET /health', requestBytes('/health', 'ws.boardsesh.com'), 'HTTP/1.1 200 OK'],
      ['GET /health/db', requestBytes('/health/db', 'ws.boardsesh.com'), 'HTTP/1.1 200 OK'],
      ['Railway’s probe Host', requestBytes('/health', 'healthcheck.railway.app'), 'HTTP/1.1 200 OK'],
      ['OPTIONS *', requestBytes('*', 'localhost', { method: 'OPTIONS' }), 'HTTP/1.1 404 Not Found'],
      ['GET *', requestBytes('*', 'localhost'), 'HTTP/1.1 404 Not Found'],
      ['an absolute-form target', requestBytes('http://example.com/health', 'localhost'), 'HTTP/1.1 200 OK'],
      ['an https absolute-form target', requestBytes('https://example.com/health', 'localhost'), 'HTTP/1.1 200 OK'],
      ['an absolute-form /graphql', requestBytes('http://example.com/graphql', 'localhost'), 'HTTP/1.1 200 OK'],
      ['a target naming its own host', requestBytes('//foo/health', 'localhost'), 'HTTP/1.1 200 OK'],
      ['extra slashes before the host', requestBytes('///foo/health', 'localhost'), 'HTTP/1.1 200 OK'],
      ['a bad percent escape in the path', requestBytes('/%zz', 'localhost'), 'HTTP/1.1 404 Not Found'],
      ['a NUL escape in the path', requestBytes('/%00', 'localhost'), 'HTTP/1.1 404 Not Found'],
      ['a 15 KB target', requestBytes(`/${'a'.repeat(15_000)}`, 'localhost'), 'HTTP/1.1 404 Not Found'],
      ['an empty Host', requestBytes('/nope', ''), 'HTTP/1.1 404 Not Found'],
      ['a blank Host', requestBytes('/nope', '   '), 'HTTP/1.1 404 Not Found'],
      ['a bracketed IPv6 Host', requestBytes('/nope', '[::1]'), 'HTTP/1.1 404 Not Found'],
      ['a bracketed IPv6 Host with a port', requestBytes('/nope', '[::1]:8080'), 'HTTP/1.1 404 Not Found'],
      ['Railway’s private IPv6 network', requestBytes('/nope', '[fd12::1]:8080'), 'HTTP/1.1 404 Not Found'],
      ['an IPv4-mapped IPv6 Host', requestBytes('/nope', '[::ffff:127.0.0.1]:8080'), 'HTTP/1.1 404 Not Found'],
      ['an IPv4 Host with a port', requestBytes('/nope', '127.0.0.1:8080'), 'HTTP/1.1 404 Not Found'],
      ['a Host with an empty port', requestBytes('/nope', 'x:'), 'HTTP/1.1 404 Not Found'],
      ['the highest port', requestBytes('/nope', 'x:65535'), 'HTTP/1.1 404 Not Found'],
      ['a tab inside the Host', requestBytes('/nope', 'a\tb'), 'HTTP/1.1 404 Not Found'],
      ['a 15 KB Host', requestBytes('/nope', 'a'.repeat(15_000)), 'HTTP/1.1 404 Not Found'],
    ])('%s', async (_label, request, statusLine) => {
      const response = await sendRaw(port, request, HEALTHY_ROUTE_DEADLINE_MS);
      expect(response.statusLine).toBe(statusLine);
      // Keep-alive survives: only a refused request closes its connection.
      expect(response.headers).not.toContain('connection: close');
      expect(response.serverClosed).toBe(false);
    });

    it.each([
      ['/health', 'HTTP/1.1 200 OK'],
      ['/nope', 'HTTP/1.1 404 Not Found'],
    ])('answers HTTP/1.0 with no Host on %s', async (target, statusLine) => {
      const response = await sendRaw(port, http10Bytes(target, null), HEALTHY_ROUTE_DEADLINE_MS);
      expect(response.statusLine).toBe(statusLine);
      expect(response.serverClosed).toBe(true);
    });

    it('runs a GraphQL POST', async () => {
      const query = JSON.stringify({ query: '{ __typename }' });
      const response = await sendRaw(
        port,
        requestBytes('/graphql', 'ws.boardsesh.com', {
          method: 'POST',
          extra: `Content-Type: application/json\r\nContent-Length: ${query.length}\r\n`,
        }) + query,
        HEALTHY_ROUTE_DEADLINE_MS,
      );
      expect(response.statusLine).toBe('HTTP/1.1 200 OK');
      expect(response.body).toContain('__typename');
    });

    it('still sends CORS headers to an allowed origin', async () => {
      const response = await sendRaw(
        port,
        requestBytes('/health', 'ws.boardsesh.com', { extra: 'Origin: https://boardsesh.com\r\n' }),
        HEALTHY_ROUTE_DEADLINE_MS,
      );
      expect(response.statusLine).toBe('HTTP/1.1 200 OK');
      expect(response.headers).toContain('access-control-allow-origin: https://boardsesh.com');
    });

    it('keeps the API host’s route list', async () => {
      const health = await sendRaw(port, requestBytes('/health', API_HOSTNAME), HEALTHY_ROUTE_DEADLINE_MS);
      expect(health.statusLine).toBe('HTTP/1.1 200 OK');

      const graphql = await sendRaw(port, requestBytes('/graphql', API_HOSTNAME), HEALTHY_ROUTE_DEADLINE_MS);
      expect(graphql.statusLine).toBe('HTTP/1.1 404 Not Found');
      expect(graphql.body).toContain(JSON.stringify({ error: 'Not found' }));
    });
  });

  // ws matches the path before it calls verifyClient, and everything verifyClient
  // does with these headers is total. Nothing here throws; these rows keep it so.
  describe('the WebSocket upgrade path', () => {
    it.each([
      ['/graphql', 'localhost', null, 'HTTP/1.1 101 Switching Protocols'],
      ['/graphql', '', null, 'HTTP/1.1 101 Switching Protocols'],
      ['/graphql', 'x:abc', null, 'HTTP/1.1 101 Switching Protocols'],
      ['/graphql', '[::1', null, 'HTTP/1.1 101 Switching Protocols'],
      ['/graphql', '::1', null, 'HTTP/1.1 101 Switching Protocols'],
      ['/graphql', 'a b', null, 'HTTP/1.1 101 Switching Protocols'],
      ['/graphql?token=%ZZ', 'localhost', null, 'HTTP/1.1 101 Switching Protocols'],
      ['/graphql', 'localhost', 'https://boardsesh.com', 'HTTP/1.1 101 Switching Protocols'],
      ['/graphql', API_HOSTNAME, null, 'HTTP/1.1 404 Not Found'],
      ['/graphql', 'localhost', 'http://x:abc', 'HTTP/1.1 403 Forbidden'],
      ['/graphql', 'localhost', 'http://[', 'HTTP/1.1 403 Forbidden'],
      ['/graphql', 'x:abc', 'http://%', 'HTTP/1.1 403 Forbidden'],
      ['//', 'localhost', null, 'HTTP/1.1 400 Bad Request'],
      ['//graphql', 'localhost', null, 'HTTP/1.1 400 Bad Request'],
      ['/graphql/', 'localhost', null, 'HTTP/1.1 400 Bad Request'],
      ['http://x/graphql', 'localhost', null, 'HTTP/1.1 400 Bad Request'],
      ['*', 'localhost', null, 'HTTP/1.1 400 Bad Request'],
    ])('%s with Host %j and Origin %j', async (target, host, origin, statusLine) => {
      const originHeader = origin === null ? '' : `Origin: ${origin}\r\n`;
      const response = await sendRaw(port, requestBytes(target, host, { extra: WEBSOCKET_HEADERS + originHeader }));
      expect(response.statusLine).toBe(statusLine);
    });
  });

  describe('a rejected upgrade', () => {
    it('clips every sender-set header it logs', async () => {
      const warnLog = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const filler = 'a'.repeat(3_000);
      const extra = `${WEBSOCKET_HEADERS}Origin: http://o${filler}\r\nUser-Agent: u${filler}\r\nX-Forwarded-For: f${filler}\r\n`;

      const response = await sendRaw(port, requestBytes('/graphql', `h${filler}`, { extra }));

      expect(response.statusLine).toBe('HTTP/1.1 403 Forbidden');
      const logged = (warnLog.mock.calls as unknown as Array<[string, Record<string, string>]>).find(([message]) =>
        message.includes('Rejected connection'),
      )?.[1];
      for (const field of ['origin', 'host', 'userAgent', 'forwardedFor']) {
        expect(logged?.[field]).toHaveLength(256);
      }
    });
  });

  describe('what an accepted connection logs', () => {
    const FILLER = 'a'.repeat(7_000);
    const OVERSIZED_HEADERS = { 'User-Agent': `u${FILLER}`, 'X-Forwarded-For': `f${FILLER}` };
    const LOGGED_BYTES_LIMIT = 4_000;

    function openConnection(connectionParams: Record<string, unknown>, headers: Record<string, string> = {}) {
      return new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/graphql`, 'graphql-transport-ws', { headers });
        socket.once('open', () => socket.send(JSON.stringify({ type: 'connection_init', payload: connectionParams })));
        socket.once('message', () => {
          socket.terminate();
          resolve();
        });
        socket.once('close', () => resolve());
        socket.once('error', reject);
      });
    }

    function loggedCalls(spy: { mock: { calls: unknown } }) {
      return spy.mock.calls as Array<[string, Record<string, string>]>;
    }

    it('clips the User-Agent and X-Forwarded-For it records', async () => {
      const infoLog = vi.spyOn(logger, 'info').mockImplementation(() => logger);

      await openConnection({}, OVERSIZED_HEADERS);

      const connected = loggedCalls(infoLog).find(([message]) => message.startsWith('Client connected'))?.[1];
      expect(connected?.userAgent).toHaveLength(256);
      expect(connected?.forwardedFor).toHaveLength(256);
      expect(JSON.stringify(infoLog.mock.calls).length).toBeLessThan(LOGGED_BYTES_LIMIT);
    });

    it('clips an unauthenticated 1 MB controllerMac', async () => {
      const infoLog = vi.spyOn(logger, 'info').mockImplementation(() => logger);

      await openConnection({ controllerMac: 'M'.repeat(1_000_000) });

      const macLine = loggedCalls(infoLog).find(([message]) => message.startsWith('[Auth] Controller MAC'));
      expect(macLine?.[0]).toBe(`[Auth] Controller MAC: ${'M'.repeat(17)}`);
      expect(JSON.stringify(infoLog.mock.calls).length).toBeLessThan(LOGGED_BYTES_LIMIT);
    });

    it('keeps a real MAC whole', async () => {
      const infoLog = vi.spyOn(logger, 'info').mockImplementation(() => logger);

      await openConnection({ controllerMac: 'AA:BB:CC:DD:EE:FF' });

      const macLine = loggedCalls(infoLog).find(([message]) => message.startsWith('[Auth] Controller MAC'));
      expect(macLine?.[0]).toBe('[Auth] Controller MAC: AA:BB:CC:DD:EE:FF');
    });

    it('clips the User-Agent it records when the anonymous cap refuses', async () => {
      const warnLog = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      anonymousCap.rejectEveryone = true;

      try {
        await openConnection({}, OVERSIZED_HEADERS);
      } finally {
        anonymousCap.rejectEveryone = false;
      }

      const rejected = loggedCalls(warnLog).find(([message]) => message.includes('over concurrency cap'))?.[1];
      expect(rejected?.userAgent).toHaveLength(256);
    });
  });

  describe('the API host when its Host is malformed', () => {
    const UNPARSEABLE_API_HOSTS = [
      `${API_HOSTNAME}:abc`,
      `${API_HOSTNAME}:1:2`,
      `${API_HOSTNAME}, x`,
      `${API_HOSTNAME} x`,
      `${API_HOSTNAME}<`,
      `${API_HOSTNAME}|`,
    ];
    const READABLE_API_HOSTS = [
      `${API_HOSTNAME};x`,
      `${API_HOSTNAME}_x`,
      `${API_HOSTNAME}~x`,
      `${API_HOSTNAME}/`,
      `${API_HOSTNAME}/x`,
      `${API_HOSTNAME}?x`,
      `${API_HOSTNAME}#x`,
      `u@${API_HOSTNAME}`,
      `${API_HOSTNAME}\\`,
      `/${API_HOSTNAME}`,
      `\\${API_HOSTNAME}`,
      '%61pi.boardsesh.com',
      'a\tpi.boardsesh.com',
      `\xad${API_HOSTNAME}`,
      '\xaapi.boardsesh.com',
      'api.b\xbaardsesh.com',
    ];
    const LOOKALIKE_HOSTS = [
      `evil.com/${API_HOSTNAME}`,
      `${API_HOSTNAME}.evil.example`,
      `not${API_HOSTNAME}`,
      `${API_HOSTNAME}@evil.com`,
    ];

    const upgrade = (host: string) => sendRaw(port, requestBytes('/graphql', host, { extra: WEBSOCKET_HEADERS }));

    it.each(UNPARSEABLE_API_HOSTS.map((host) => [shown(host), host] as const))(
      'refuses a GraphQL POST and an upgrade for %s',
      async (_label, host) => {
        expect((await sendRaw(port, graphqlPostBytes('/graphql', host))).statusLine).toBe('HTTP/1.1 400 Bad Request');
        expect((await upgrade(host)).statusLine).toBe('HTTP/1.1 404 Not Found');
      },
    );

    it.each(READABLE_API_HOSTS.map((host) => [shown(host), host] as const))(
      'keeps the route list for a GraphQL POST and an upgrade on %s',
      async (_label, host) => {
        const post = await sendRaw(port, graphqlPostBytes('/graphql', host), HEALTHY_ROUTE_DEADLINE_MS);
        expect(post.statusLine).toBe('HTTP/1.1 404 Not Found');
        expect(post.body).toContain(JSON.stringify({ error: 'Not found' }));
        expect((await upgrade(host)).statusLine).toBe('HTTP/1.1 404 Not Found');
      },
    );

    it.each(LOOKALIKE_HOSTS.map((host) => [shown(host), host] as const))(
      'leaves the lookalike %s out of the filter',
      async (_label, host) => {
        expect((await upgrade(host)).statusLine).toBe('HTTP/1.1 101 Switching Protocols');
      },
    );
  });

  describe('GraphQL by target form', () => {
    function expectGraphqlAnswer(response: RawResponse) {
      expect(response.statusLine).toBe('HTTP/1.1 200 OK');
      expect(response.body).toContain('__typename');
      expect(response.body).not.toContain('node_modules');
      expect(response.body).not.toMatch(/\n\s+at /);
    }

    it.each([
      ['http://x/graphql', 'x:80'],
      ['http://x:80/graphql', 'x:80'],
      ['https://x/graphql?a=1', 'x:443'],
      ['http://example.com/graphql', 'localhost'],
      ['/graphql', 'ws.boardsesh.com'],
      ['/graphql?a=1', 'ws.boardsesh.com'],
    ])('runs a POST to %s with Host %s', async (target, host) => {
      expectGraphqlAnswer(await sendRaw(port, graphqlPostBytes(target, host), HEALTHY_ROUTE_DEADLINE_MS));
    });

    it.each([
      ['/graphql?query=%7B__typename%7D', 'ws.boardsesh.com'],
      ['http://x/graphql?query=%7B__typename%7D', 'x:80'],
    ])('keeps the query string on a GET to %s', async (target, host) => {
      const request = requestBytes(target, host, { extra: 'Accept: application/json\r\n' });
      expectGraphqlAnswer(await sendRaw(port, request, HEALTHY_ROUTE_DEADLINE_MS));
    });

    // utils/flag-country.ts trusts this header only on the exact path Cloudflare
    // clears it on, so no other target form may look like that path by the time
    // Yoga's context runs.
    describe('the edge region header', () => {
      // The loopback peer counts as our private ingress, so the last hop decides.
      const TRUSTED_EDGE_HEADERS = 'X-Forwarded-For: 203.0.113.9, 173.245.48.1\r\nX-Boardsesh-Region-Code: AU\r\n';
      const postFromEdge = (target: string) =>
        sendRaw(port, graphqlPostBytes(target, 'ws.boardsesh.com', TRUSTED_EDGE_HEADERS), HEALTHY_ROUTE_DEADLINE_MS);

      beforeAll(() => {
        process.env.BOARDSESH_TRUST_EDGE_REGION_HEADER = 'true';
      });
      afterAll(() => {
        delete process.env.BOARDSESH_TRUST_EDGE_REGION_HEADER;
      });
      beforeEach(() => {
        edgeRegionDecisions.length = 0;
      });

      it('is trusted on the exact path the edge rule covers', async () => {
        expectGraphqlAnswer(await postFromEdge('/graphql'));
        expect(edgeRegionDecisions).toContain('AU');
      });

      it.each(['//foo/graphql', '/\\foo/graphql', 'http://x/graphql', 'https://ws.boardsesh.com/graphql'])(
        'is not trusted on %s',
        async (target) => {
          const response = await postFromEdge(target);
          expect(response.statusLine).not.toBeNull();
          expect(response.body).not.toMatch(/\n\s+at /);
          expect(edgeRegionDecisions).not.toContain('AU');
        },
      );
    });
  });

  describe('when a handler throws', () => {
    const fail = (error: unknown) => () => {
      throw error;
    };
    const robots = () => sendRaw(port, requestBytes('/robots.txt', 'localhost'), HEALTHY_ROUTE_DEADLINE_MS);

    beforeAll(() => {
      // These rows log on purpose. Keep the output readable.
      logger.silent = true;
    });
    afterAll(() => {
      logger.silent = false;
    });

    it('answers 500 when nothing has been sent', async () => {
      robotsRoute.override = fail(new Error('boom'));
      const response = await robots();
      expect(response.statusLine).toBe('HTTP/1.1 500 Internal Server Error');
      expect(response.body).toContain('Internal server error');
    });

    it('drops the connection when the status line has already gone out', async () => {
      robotsRoute.override = (res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '100' });
        res.flushHeaders();
        throw new Error('boom after headers');
      };
      const response = await robots();
      expect(response.statusLine).toBe('HTTP/1.1 200 OK');
      expect(response.serverClosed).toBe(true);
    });

    // Upstream resets carry the same codes as a client disconnect, so this branch
    // can run with the client still waiting.
    it.each([
      ['ECONNRESET', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
      ['EPIPE', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })],
      ['an aborted fetch cause', Object.assign(new TypeError('fetch failed'), { cause: new Error('aborted') })],
    ])('drops the connection on an error that looks like a client abort: %s', async (_label, error) => {
      robotsRoute.override = fail(error);
      const response = await robots();
      expect(response.statusLine).toBeNull();
      expect(response.serverClosed).toBe(true);
    });

    it('leaves a finished response intact when the handler throws afterwards', async () => {
      // Bigger than a socket buffer, so most of it is still queued when the
      // handler throws. A small body is on the wire before anything could cut it.
      const finishedBody = 'x'.repeat(16 * 1024 * 1024);
      robotsRoute.override = (res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(finishedBody.length) });
        res.end(finishedBody);
        throw new Error('boom after end');
      };
      const response = await robots();
      expect(response.statusLine).toBe('HTTP/1.1 200 OK');
      expect(response.body.length).toBe(finishedBody.length);
    });

    it('drops the connection when reporting the error throws as well', async () => {
      robotsRoute.override = fail(new Error('boom'));
      vi.spyOn(logger, 'error').mockImplementation(() => {
        throw new Error('the logger failed too');
      });
      const response = await robots();
      expect(response.statusLine).toBeNull();
      expect(response.serverClosed).toBe(true);
    });

    it('still answers after every failure above', async () => {
      const response = await sendRaw(port, requestBytes('/nope', 'localhost'), HEALTHY_ROUTE_DEADLINE_MS);
      expect(response.statusLine).toBe('HTTP/1.1 404 Not Found');
    });
  });
});

describe('createMalformedRequestRecorder', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports a burst that stops, in one line, and stays quiet afterwards', () => {
    vi.useFakeTimers();
    const warnLog = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const recorder = createMalformedRequestRecorder();

    for (let attempt = 0; attempt < 10_000; attempt += 1) recorder.record();
    expect(warnLog).not.toHaveBeenCalled();

    vi.advanceTimersByTime(MALFORMED_REQUEST_LOG_INTERVAL_MS);
    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(warnLog).toHaveBeenLastCalledWith(expect.any(String), { refused: 10_000 });

    vi.advanceTimersByTime(MALFORMED_REQUEST_LOG_INTERVAL_MS * 5);
    expect(warnLog).toHaveBeenCalledTimes(1);

    recorder.record();
    vi.advanceTimersByTime(MALFORMED_REQUEST_LOG_INTERVAL_MS);
    expect(warnLog).toHaveBeenCalledTimes(2);
    expect(warnLog).toHaveBeenLastCalledWith(expect.any(String), { refused: 1 });

    clearInterval(recorder.flushTimer);
  });

  it('does not hold the process open', () => {
    const recorder = createMalformedRequestRecorder();
    expect(recorder.flushTimer.hasRef()).toBe(false);
    clearInterval(recorder.flushTimer);
  });

  it('survives a logger that throws', () => {
    vi.useFakeTimers();
    vi.spyOn(logger, 'warn').mockImplementation(() => {
      throw new Error('the logger failed');
    });
    const recorder = createMalformedRequestRecorder();

    recorder.record();
    expect(() => vi.advanceTimersByTime(MALFORMED_REQUEST_LOG_INTERVAL_MS)).not.toThrow();

    clearInterval(recorder.flushTimer);
  });
});

// What a stray rejection does depends on the listeners in the process, so these
// run the real server in a child rather than inside the test runner.
describe('the server process', () => {
  let sentrySink: Server;
  let sentrySinkPort = 0;
  const sentryEnvelopes: string[] = [];
  let serverProcess: ChildProcess | undefined;

  beforeAll(async () => {
    sentrySink = createServer((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        const received = Buffer.concat(chunks);
        const gzipped = incoming.headers['content-encoding'] === 'gzip';
        sentryEnvelopes.push((gzipped ? gunzipSync(received) : received).toString('utf8'));
        outgoing.writeHead(200, { 'Content-Type': 'application/json' });
        outgoing.end('{}');
      });
    });
    sentrySink.listen(0, '127.0.0.1');
    await once(sentrySink, 'listening');
    const address = sentrySink.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP sink address');
    sentrySinkPort = address.port;
  });

  afterAll(async () => {
    sentrySink.closeAllConnections();
    await new Promise<void>((resolve) => sentrySink.close(() => resolve()));
  });

  afterEach(async () => {
    if (serverProcess && serverProcess.exitCode === null && serverProcess.signalCode === null) {
      const exited = once(serverProcess, 'exit');
      serverProcess.kill('SIGKILL');
      await exited;
    }
    serverProcess = undefined;
    sentryEnvelopes.length = 0;
  });

  async function launch(sentryMode: 'sentry-on' | 'sentry-off'): Promise<number> {
    const child = fork(new URL('./helpers/malformed-request-process.ts', import.meta.url), [sentryMode], {
      execArgv: ['--import', createRequire(import.meta.url).resolve('tsx')],
      env: {
        ...process.env,
        DATABASE_URL: getWorkerDatabaseUrl(),
        MALFORMED_REQUEST_SENTRY_DSN: `http://public@127.0.0.1:${sentrySinkPort}/1`,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    serverProcess = child;

    let childOutput = '';
    const keepOutputTail = (chunk: Buffer) => {
      childOutput = (childOutput + chunk.toString('utf8')).slice(-4_000);
    };
    child.stdout?.on('data', keepOutputTail);
    child.stderr?.on('data', keepOutputTail);

    const message = await new Promise<{ type: string; port: number }>((resolve, reject) => {
      const bootDeadline = setTimeout(
        () => reject(new Error(`Server process did not start within ${CHILD_BOOT_DEADLINE_MS} ms:\n${childOutput}`)),
        CHILD_BOOT_DEADLINE_MS,
      );
      child.once('message', (received) => {
        clearTimeout(bootDeadline);
        resolve(received as { type: string; port: number });
      });
      child.once('error', (error) => {
        clearTimeout(bootDeadline);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(bootDeadline);
        reject(new Error(`Server process exited (${code ?? signal}) before listening:\n${childOutput}`));
      });
    });
    expect(message.type).toBe('listening');
    return message.port;
  }

  const CHILD_BOOT_DEADLINE_MS = 60_000;
  const CHILD_TEST_TIMEOUT_MS = 90_000;

  it(
    'stays up with Sentry off, where a stray rejection would exit the process',
    { timeout: CHILD_TEST_TIMEOUT_MS },
    async () => {
      const childPort = await launch('sentry-off');

      const scheme = await sendRaw(childPort, requestBytes('//', 'localhost'));
      expect(scheme.statusLine).toBe('HTTP/1.1 400 Bad Request');
      expect(scheme.serverClosed).toBe(true);

      const host = await sendRaw(childPort, requestBytes('/nope', 'x:abc'));
      expect(host.statusLine).toBe('HTTP/1.1 400 Bad Request');

      expect(serverProcess?.exitCode).toBeNull();
      const stillServing = await sendRaw(childPort, requestBytes('/nope', 'localhost'), HEALTHY_ROUTE_DEADLINE_MS);
      expect(stillServing.statusLine).toBe('HTTP/1.1 404 Not Found');
    },
  );

  it(
    'answers instead of hanging with Sentry on, and sends Sentry nothing about refused requests',
    { timeout: CHILD_TEST_TIMEOUT_MS },
    async () => {
      const childPort = await launch('sentry-on');

      for (const request of [
        requestBytes('//', 'localhost'),
        requestBytes('/nope', 'x:abc'),
        requestBytes('/nope', '[::1'),
        requestBytes('/\\', 'localhost'),
        requestBytes('http://[', 'localhost'),
        requestBytes('//', 'localhost', { extra: 'X-Forwarded-Host: proxy.example\r\n' }),
        http10Bytes('//', null),
      ]) {
        const response = await sendRaw(childPort, request);
        expect(response.statusLine).toBe('HTTP/1.1 400 Bad Request');
        expect(response.serverClosed).toBe(true);
      }

      // The control: same process and sampler, on a request it does record.
      const recorded = await sendRaw(
        childPort,
        graphqlPostBytes('/graphql', 'ws.boardsesh.com'),
        HEALTHY_ROUTE_DEADLINE_MS,
      );
      expect(recorded.statusLine).toBe('HTTP/1.1 200 OK');

      const flushed = once(serverProcess as ChildProcess, 'message');
      serverProcess?.send('flush');
      await flushed;

      expect(sentryEnvelopes.filter((envelope) => envelope.includes('"type":"event"'))).toEqual([]);
      const transactions = sentryEnvelopes.filter((envelope) => envelope.includes('"type":"transaction"'));
      expect(transactions).toHaveLength(1);
      expect(transactions[0]).toContain('POST /graphql');
      expect(serverProcess?.exitCode).toBeNull();
    },
  );
});
