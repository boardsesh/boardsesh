import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import type { RawData, WebSocketServer } from 'ws';

/**
 * An anonymous socket controls the text of a subscription's validation error
 * (an unknown field name is echoed in the message). `ws` allows a 100 MiB frame,
 * so the error log line must be clipped, while the client still gets the whole
 * error it asked for.
 */

vi.mock('../services/room-manager', () => ({
  roomManager: {
    registerClient: vi.fn().mockResolvedValue('participant-1'),
    removeClient: vi.fn().mockResolvedValue(undefined),
    clearBoardWriterForConnection: vi.fn().mockResolvedValue(undefined),
    disconnectClient: vi.fn().mockResolvedValue(undefined),
  },
}));

import { setupWebSocketServer } from '../websocket/setup';
import { resetAnonConnectionCapRegistry } from '../websocket/connection-cap';
import { logger } from '../utils/logger';

const FIELD_NAME_LENGTH = 100_000;

function decodeMessage(message: RawData): string {
  if (Array.isArray(message)) return Buffer.concat(message).toString('utf8');
  if (message instanceof ArrayBuffer) return Buffer.from(message).toString('utf8');
  return message.toString('utf8');
}

describe('websocket subscription error logging', () => {
  let httpServer: Server;
  let webSocketServer: WebSocketServer;
  let pingInterval: NodeJS.Timeout;
  let port = 0;

  beforeAll(async () => {
    process.env.WS_ANON_CONNECTIONS_PER_SOCKET_PEER = '10000';
    httpServer = createServer();
    const setup = setupWebSocketServer(httpServer);
    webSocketServer = setup.wss;
    pingInterval = setup.pingInterval;
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port');
    port = address.port;
  });

  afterAll(async () => {
    clearInterval(pingInterval);
    for (const client of webSocketServer.clients) client.terminate();
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    resetAnonConnectionCapRegistry();
    delete process.env.WS_ANON_CONNECTIONS_PER_SOCKET_PEER;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function subscribeWithUnknownField(fieldName: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/graphql`, 'graphql-transport-ws');
      socket.once('error', reject);
      socket.once('open', () => socket.send(JSON.stringify({ type: 'connection_init' })));
      socket.on('message', (raw) => {
        const message = JSON.parse(decodeMessage(raw)) as { type: string };
        if (message.type === 'connection_ack') {
          socket.send(
            JSON.stringify({ id: '1', type: 'subscribe', payload: { query: `subscription { ${fieldName} }` } }),
          );
        } else if (message.type === 'error') {
          socket.terminate();
          resolve(decodeMessage(raw));
        }
      });
    });
  }

  it('clips the logged error but sends the client the whole one', async () => {
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const fieldName = 'f'.repeat(FIELD_NAME_LENGTH);

    const clientFrame = await subscribeWithUnknownField(fieldName);

    expect(clientFrame).toContain(fieldName);
    const graphqlErrorCalls = errorLog.mock.calls.filter(([message]) => String(message) === 'GraphQL error:');
    expect(graphqlErrorCalls).toHaveLength(1);
    const loggedBytes = JSON.stringify(graphqlErrorCalls[0]).length;
    console.info(`logged bytes for a ${FIELD_NAME_LENGTH}-char field name: ${loggedBytes}`);
    expect(loggedBytes).toBeLessThan(2000);
  });
});
