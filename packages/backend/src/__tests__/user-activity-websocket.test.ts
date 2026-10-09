import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createClient, type Client } from 'graphql-ws';
import { WebSocket, type WebSocketServer } from 'ws';
import { eq } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';

vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    ...actual,
    validateToken: async (token: string) =>
      token.startsWith('valid:') ? { userId: token.slice('valid:'.length), isAuthenticated: true } : null,
  };
});

import { db } from '../db/client';
import { setupWebSocketServer } from '../websocket/setup';
import { resetUserActivityMemoryForTests } from '../services/user-activity';
import { getClientUsageSnapshotForTests, stopClientUsageReporter } from '../services/client-usage';

describe('authenticated WebSocket activity across UTC midnight', () => {
  let httpServer: Server;
  let webSocketServer: WebSocketServer;
  let pingInterval: NodeJS.Timeout;
  let webSocketUrl: string;
  let graphqlClient: Client | undefined;

  beforeAll(async () => {
    httpServer = createServer();
    const setup = setupWebSocketServer(httpServer);
    webSocketServer = setup.wss;
    pingInterval = setup.pingInterval;
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Test server has no TCP port');
    webSocketUrl = `ws://127.0.0.1:${address.port}/graphql`;
  });

  afterEach(async () => {
    await graphqlClient?.dispose();
    graphqlClient = undefined;
    vi.useRealTimers();
    resetUserActivityMemoryForTests();
    stopClientUsageReporter();
  });

  afterAll(async () => {
    clearInterval(pingInterval);
    for (const client of webSocketServer.clients) client.terminate();
    await new Promise<void>((resolve, reject) => webSocketServer.close((error) => (error ? reject(error) : resolve())));
    await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
  });

  it('records the connection day and the next operation day without reconnecting', async () => {
    const userId = randomUUID();
    await db.insert(dbSchema.users).values({ id: userId, email: `${userId}@example.invalid` });
    resetUserActivityMemoryForTests();
    stopClientUsageReporter();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T23:59:59.000Z'));

    await new Promise<void>((resolve, reject) => {
      graphqlClient = createClient({
        url: webSocketUrl,
        webSocketImpl: WebSocket,
        lazy: false,
        retryAttempts: 0,
        connectionParams: {
          authToken: `valid:${userId}`,
          clientPlatform: 'ios',
          clientIdentity: 'boardsesh-mobile/2.6.0 (ios; build 45)',
        },
        onNonLazyError: reject,
        on: { connected: () => resolve() },
      });
    });
    const activityRows = () =>
      db.select().from(dbSchema.userActivityDays).where(eq(dbSchema.userActivityDays.userId, userId));
    await vi.waitFor(async () => {
      expect(await activityRows()).toEqual([{ userId, day: '2026-10-08', platform: 'ios' }]);
    });

    vi.setSystemTime(new Date('2026-10-09T00:00:01.000Z'));
    if (!graphqlClient) throw new Error('GraphQL client did not connect');
    for await (const result of graphqlClient.iterate({ query: 'query { myAnalyticsConsent { analytics } }' })) {
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({ myAnalyticsConsent: null });
    }
    expect(getClientUsageSnapshotForTests()).toEqual([
      { clientName: 'boardsesh-mobile', clientVersion: '2.6.0', transport: 'ws', operations: 1 },
    ]);
    await vi.waitFor(async () => {
      expect((await activityRows()).map(({ day, platform }) => `${day}:${platform}`).sort()).toEqual([
        '2026-10-08:ios',
        '2026-10-09:ios',
      ]);
    });
  });
});
