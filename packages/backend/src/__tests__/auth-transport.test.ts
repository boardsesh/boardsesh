import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import type { RawData, WebSocketServer } from 'ws';

vi.mock('../services/room-manager', () => ({
  roomManager: {
    registerClient: vi.fn().mockResolvedValue('participant-1'),
    clearBoardWriterForConnection: vi.fn().mockResolvedValue(undefined),
    disconnectClient: vi.fn().mockResolvedValue(undefined),
    removeClient: vi.fn().mockResolvedValue(undefined),
  },
}));

import { createYogaInstance } from '../graphql/yoga';
import { setupWebSocketServer } from '../websocket/setup';

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

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function decodeMessage(message: RawData): string {
  if (Array.isArray(message)) return Buffer.concat(message).toString('utf8');
  if (message instanceof ArrayBuffer) return Buffer.from(message).toString('utf8');
  return message.toString('utf8');
}

describe('GraphQL transport authentication', () => {
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
    await closeWebSocketServer(webSocketServer);
    await closeServer(httpServer);
  });

  it('keeps an HTTP request with an invalid Bearer credential anonymous and usable', async () => {
    const yoga = createYogaInstance();
    const response = await yoga.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer definitely-invalid',
      },
      body: JSON.stringify({ query: '{ __typename }' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { __typename: 'Query' } });
  });

  it.each(['Bearer', 'Bearer   '])(
    'keeps an HTTP request with an empty Bearer credential anonymous and usable (%j)',
    async (header) => {
      const yoga = createYogaInstance();
      const response = await yoga.fetch('http://localhost/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: header,
        },
        body: JSON.stringify({ query: '{ __typename }' }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ data: { __typename: 'Query' } });
    },
  );

  it('keeps an HTTP request with no credential anonymous and usable', async () => {
    const yoga = createYogaInstance();
    const response = await yoga.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { __typename: 'Query' } });
  });

  it('accepts a WebSocket with invalid auth as anonymous', async () => {
    const acknowledged = new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(webSocketUrl, GRAPHQL_TRANSPORT_WS);
      socket.once('open', () => {
        socket.send(JSON.stringify({ type: 'connection_init', payload: { authToken: 'definitely-invalid' } }));
      });
      socket.once('message', (message) => {
        const payload = JSON.parse(decodeMessage(message)) as { type?: unknown };
        resolve(typeof payload.type === 'string' ? payload.type : '');
        socket.close(1000);
      });
      socket.once('error', reject);
    });

    await expect(acknowledged).resolves.toBe('connection_ack');
  });

  it.each([
    ['empty string', ''],
    ['null', null],
  ])('accepts a WebSocket with an explicit %s auth token as anonymous', async (_label, authToken) => {
    const acknowledged = new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(webSocketUrl, GRAPHQL_TRANSPORT_WS);
      socket.once('open', () => {
        socket.send(JSON.stringify({ type: 'connection_init', payload: { authToken } }));
      });
      socket.once('message', (message) => {
        const payload = JSON.parse(decodeMessage(message)) as { type?: unknown };
        resolve(typeof payload.type === 'string' ? payload.type : '');
        socket.close(1000);
      });
      socket.once('error', reject);
    });

    await expect(acknowledged).resolves.toBe('connection_ack');
  });

  it('accepts a WebSocket with an explicit empty query token as anonymous', async () => {
    const acknowledged = new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`${webSocketUrl}?token=`, GRAPHQL_TRANSPORT_WS);
      socket.once('open', () => socket.send(JSON.stringify({ type: 'connection_init' })));
      socket.once('message', (message) => {
        const payload = JSON.parse(decodeMessage(message)) as { type?: unknown };
        resolve(typeof payload.type === 'string' ? payload.type : '');
        socket.close(1000);
      });
      socket.once('error', reject);
    });

    await expect(acknowledged).resolves.toBe('connection_ack');
  });

  it('accepts a WebSocket with no credential as anonymous', async () => {
    const acknowledged = new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(webSocketUrl, GRAPHQL_TRANSPORT_WS);
      socket.once('open', () => socket.send(JSON.stringify({ type: 'connection_init' })));
      socket.once('message', (message) => {
        const payload = JSON.parse(decodeMessage(message)) as { type?: unknown };
        resolve(typeof payload.type === 'string' ? payload.type : '');
        socket.close(1000);
      });
      socket.once('error', reject);
    });

    await expect(acknowledged).resolves.toBe('connection_ack');
  });
});
