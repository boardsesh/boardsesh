// @vitest-environment node
/**
 * #7596 B3b through the real graphql-ws client and a real WebSocket server:
 * a socket whose 15-minute browser token the backend refuses (close 4401) gets
 * a new token, reconnects and resubscribes. graphql-ws gives up on a 4401
 * before it asks `shouldRetry`, so this is only true because the socket class
 * turns the close into a retryable one. A legacy token's socket still closes
 * on 4401, as on main.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  registerAccessTokenRefresher,
  rememberBrowserAccessToken,
  resetBrowserAccessTokensForTests,
} from '@/app/lib/auth/browser-access-token';
import { createGraphQLClient } from '../graphql-client';

const viewer = { userId: 'user-1', authSessionId: 'session-1' };
let server: WebSocketServer;
let url: string;
/** The `authToken` of every `connection_init` the server received, in order. */
let handshakes: (string | undefined)[] = [];
let refusedTokens = new Set<string>();

beforeAll(async () => {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
  server.on('connection', (socket: ServerSocket) => {
    let token: string | undefined;
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as { type: string; id?: string; payload?: { authToken?: string } };
      if (message.type === 'connection_init') {
        token = message.payload?.authToken;
        handshakes.push(token);
        socket.send(JSON.stringify({ type: 'connection_ack' }));
      } else if (message.type === 'subscribe') {
        // As the backend does: an expired or revoked token is closed at its next operation.
        if (token !== undefined && refusedTokens.has(token)) socket.close(4401, 'Unauthorized');
        else socket.send(JSON.stringify({ type: 'next', id: message.id, payload: { data: { viewerToken: token } } }));
      }
    });
  });
});
afterAll(async () => {
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  handshakes = [];
  refusedTokens = new Set();
  resetBrowserAccessTokensForTests();
});
afterEach(() => resetBrowserAccessTokensForTests());

function firstResult(client: ReturnType<typeof createGraphQLClient>) {
  return new Promise<{ data?: unknown; error?: unknown }>((resolve) => {
    const stop = client.subscribe(
      { query: 'subscription { viewerToken }' },
      {
        next: (result) => {
          resolve({ data: result.data });
          stop();
        },
        error: (error) => resolve({ error }),
        complete: () => {},
      },
    );
  });
}

describe('a browser-token socket refused with 4401', () => {
  it('gets one new token, reconnects and resubscribes', async () => {
    rememberBrowserAccessToken('expired-token', viewer, 900);
    refusedTokens.add('expired-token');
    const refresher = vi.fn(async () => {
      rememberBrowserAccessToken('fresh-token', viewer, 900);
    });
    registerAccessTokenRefresher(refresher);
    const client = createGraphQLClient({ url, authToken: 'expired-token' });
    try {
      expect(await firstResult(client)).toEqual({ data: { viewerToken: 'fresh-token' } });
      expect(handshakes).toEqual(['expired-token', 'fresh-token']);
      expect(refresher).toHaveBeenCalledTimes(1);
    } finally {
      await client.dispose();
    }
  }, 20_000);
});

describe('a legacy token socket refused with 4401 (mode off, as on main)', () => {
  it('closes for good, without a new token or a reconnect', async () => {
    refusedTokens.add('nextauth-jwe');
    const refresher = vi.fn(async () => {});
    registerAccessTokenRefresher(refresher);
    const client = createGraphQLClient({ url, authToken: 'nextauth-jwe' });
    try {
      const result = await firstResult(client);
      expect(result.error).toMatchObject({ code: 4401 });
      expect(handshakes).toEqual(['nextauth-jwe']);
      expect(refresher).not.toHaveBeenCalled();
    } finally {
      await client.dispose();
    }
  }, 20_000);
});
