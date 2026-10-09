import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import type { RawData, WebSocketServer } from 'ws';
import type { ConnectionContext } from '@boardsesh/shared-schema';

/**
 * End-to-end cover for issue #2863: the real `setupWebSocketServer` must put a
 * trusted client IP on every connection context, so anonymous callers keep the
 * same `applyRateLimit` bucket across reconnects instead of getting a fresh
 * uuidv4 connectionId bucket each time.
 *
 * This drives the genuine onConnect path (real `ws` upgrade with forged proxy
 * headers) rather than hand-calling createContext, so deleting the `clientIp`
 * argument in websocket/setup.ts turns every case here red.
 */

const { createdContexts } = vi.hoisted(() => ({
  createdContexts: [] as Pick<
    ConnectionContext,
    'connectionId' | 'clientIp' | 'socketPeerIp' | 'clientIdentity' | 'clientIdentityRaw'
  >[],
}));

vi.mock('../services/room-manager', () => ({
  roomManager: {
    registerClient: vi.fn().mockResolvedValue('participant-1'),
    clearBoardWriterForConnection: vi.fn().mockResolvedValue(undefined),
    disconnectClient: vi.fn().mockResolvedValue(undefined),
    removeClient: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../graphql/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../graphql/context')>();
  return {
    ...actual,
    createContext: (options?: Parameters<typeof actual.createContext>[0]) => {
      const context = actual.createContext(options);
      createdContexts.push(context);
      return context;
    },
  };
});

import { setupWebSocketServer } from '../websocket/setup';
import { getClientUsageSnapshotForTests, stopClientUsageReporter } from '../services/client-usage';

const GRAPHQL_TRANSPORT_WS = 'graphql-transport-ws';

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Test server did not expose a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

function decodeMessage(message: RawData): string {
  if (Array.isArray(message)) return Buffer.concat(message).toString('utf8');
  if (message instanceof ArrayBuffer) return Buffer.from(message).toString('utf8');
  return message.toString('utf8');
}

describe('WebSocket connection context client IP', () => {
  let httpServer: Server;
  let webSocketServer: WebSocketServer;
  let pingInterval: NodeJS.Timeout;
  let webSocketUrl: string;

  beforeAll(async () => {
    httpServer = createServer();
    const setup = setupWebSocketServer(httpServer);
    webSocketServer = setup.wss;
    pingInterval = setup.pingInterval;
    const port = await listen(httpServer);
    webSocketUrl = `ws://127.0.0.1:${port}/graphql`;
  });

  afterAll(async () => {
    clearInterval(pingInterval);
    for (const client of webSocketServer.clients) client.terminate();
    await new Promise<void>((resolve, reject) => webSocketServer.close((error) => (error ? reject(error) : resolve())));
    await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
  });

  beforeEach(() => {
    createdContexts.length = 0;
  });

  /**
   * Connect with forged upgrade headers (and an optional connection_init
   * payload) and resolve the context onConnect built.
   */
  async function connectAndReadContext(
    headers: Record<string, string>,
    connectionParams?: Record<string, unknown>,
  ): Promise<(typeof createdContexts)[number]> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(webSocketUrl, GRAPHQL_TRANSPORT_WS, { headers });
      socket.once('open', () =>
        socket.send(
          JSON.stringify(
            connectionParams ? { type: 'connection_init', payload: connectionParams } : { type: 'connection_init' },
          ),
        ),
      );
      socket.once('message', (message) => {
        const payload = JSON.parse(decodeMessage(message)) as { type?: unknown };
        if (payload.type !== 'connection_ack') {
          reject(new Error(`Expected connection_ack, got ${String(payload.type)}`));
          return;
        }
        socket.close(1000);
        resolve();
      });
      socket.once('error', reject);
    });

    const context = createdContexts.at(-1);
    if (!context) throw new Error('onConnect did not create a connection context');
    return context;
  }

  it('prefers cf-connecting-ip over a client-authored forwarded chain', async () => {
    const context = await connectAndReadContext({
      'cf-connecting-ip': '203.0.113.7',
      'x-forwarded-for': '198.51.100.9, 172.68.1.1',
    });

    expect(context.clientIp).toBe('203.0.113.7');
    expect(context.socketPeerIp).toBe('127.0.0.1');
  });

  it('keys on the last forwarded hop, ignoring an attacker-prefixed entry', async () => {
    const context = await connectAndReadContext({ 'x-forwarded-for': '198.51.100.9, 172.68.1.1' });

    expect(context.clientIp).toBe('172.68.1.1');
  });

  it('falls back to the upgrade socket address when no proxy headers are present', async () => {
    const context = await connectAndReadContext({});

    // The test server listens on 127.0.0.1, so a direct connection carrying no
    // Cloudflare or forwarded headers must still resolve a keyable identity
    // rather than undefined — undefined drops the caller back into the
    // connectionId bucket this fix exists to retire.
    expect(context.clientIp).toBe('127.0.0.1');
  });

  it('gives two reconnects from one IP the same rate-limit identity', async () => {
    const headers = { 'cf-connecting-ip': '203.0.113.7' };
    const first = await connectAndReadContext(headers);
    const second = await connectAndReadContext(headers);

    // The connectionId still rotates (uuidv4 per connection) — that rotation is
    // exactly why the pre-fix connectionId bucket was useless.
    expect(second.connectionId).not.toBe(first.connectionId);
    expect(first.clientIp).toBe('203.0.113.7');
    expect(second.clientIp).toBe(first.clientIp);
  });

  it('keeps the socket-peer backstop stable across forged Cloudflare identities', async () => {
    const first = await connectAndReadContext({ 'cf-connecting-ip': '203.0.113.7' });
    const second = await connectAndReadContext({ 'cf-connecting-ip': '198.51.100.22' });

    expect(second.clientIp).not.toBe(first.clientIp);
    expect(first.socketPeerIp).toBe('127.0.0.1');
    expect(second.socketPeerIp).toBe(first.socketPeerIp);
  });

  it('puts the connectionParams client identity on the created context', async () => {
    const context = await connectAndReadContext({}, { clientIdentity: 'boardsesh-mobile-web/2.6.0 (web)' });

    expect(context.clientIdentity).toEqual({ name: 'boardsesh-mobile-web', version: '2.6.0', platform: 'web' });
    expect(context.clientIdentityRaw).toBe('boardsesh-mobile-web/2.6.0 (web)');
  });

  it('ignores a non-string client identity param', async () => {
    const context = await connectAndReadContext({}, { clientIdentity: { name: 'boardsesh-mobile', version: '2.6.0' } });

    expect(context.clientIdentity).toBeUndefined();
    expect(context.clientIdentityRaw).toBeUndefined();
  });

  it('keeps an unparseable identity raw-only and still connects', async () => {
    const context = await connectAndReadContext({}, { clientIdentity: 'definitely not valid' });

    expect(context.clientIdentity).toBeUndefined();
    expect(context.clientIdentityRaw).toBe('definitely not valid');
  });

  it('does not read the identity from an upgrade header', async () => {
    const context = await connectAndReadContext({ 'x-boardsesh-client': 'boardsesh-web/1.0.0' });

    expect(context.clientIdentity).toBeUndefined();
  });

  it('counts each WebSocket operation against the connection client', async () => {
    stopClientUsageReporter();
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(webSocketUrl, GRAPHQL_TRANSPORT_WS);
      socket.once('open', () =>
        socket.send(JSON.stringify({ type: 'connection_init', payload: { clientIdentity: 'boardsesh-web/1.4.2' } })),
      );
      socket.on('message', (message) => {
        const payload = JSON.parse(decodeMessage(message)) as { type?: unknown };
        if (payload.type === 'connection_ack') {
          socket.send(JSON.stringify({ id: 'op-1', type: 'subscribe', payload: { query: '{ __typename }' } }));
        } else if (payload.type === 'complete') {
          socket.close(1000);
          resolve();
        } else if (payload.type === 'error') {
          reject(new Error(`Operation failed: ${decodeMessage(message)}`));
        }
      });
      socket.once('error', reject);
    });

    expect(getClientUsageSnapshotForTests()).toEqual([
      { clientName: 'boardsesh-web', clientVersion: '1.4.2', transport: 'ws', operations: 1 },
    ]);
    stopClientUsageReporter();
  });
});
