// @vitest-environment jsdom
//
// Offline mode on → off must bring back the spray-wall notification stream and
// the live climb-stats stream, and the next Offline mode on must close every
// socket again (#6766). Turning offline mode on makes ConnectivityBridge dispose
// the graphql-ws client. graphql-ws never reconnects a disposed client, but it
// still opens a new socket for a new operation on one, and no later dispose
// owns that socket. The notification stream subscribed once per effect run, so
// it never came back. The climb-stats stream kept its first client and
// re-subscribed on the dead one, so its socket stayed open through the next
// Offline mode on.
//
// Runs the REAL stack below the two consumers: `createWsClientModule`,
// graphql-ws, the connectivity store and ConnectivityBridge. Only the socket is
// fake.

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const server = await vi.hoisted(async () =>
  (await import('./helpers/fake-graphql-ws-server')).createFakeGraphqlWsServer(),
);

vi.mock('../../lib/graphql/ws-client', async () => {
  const { createWsClientModule } = await import('../../lib/graphql/ws-client-core');
  const { getConnectivitySnapshot } = await import('../../lib/connectivity/connectivity-store');
  return createWsClientModule({
    createSocket: (url) => new server.FakeServerSocket(url) as unknown as WebSocket,
    captureAuthCredentialGeneration: () => 1,
    getAuthToken: async () => 'jwt-token',
    isAuthCredentialGenerationCurrent: () => true,
    ensureFreshToken: async () => true,
    recoverAuthRejection: async () => 'refreshed' as const,
    isOfflineModeOn: () => getConnectivitySnapshot().offlineMode,
    getClientIdentity: () => 'boardsesh-mobile/test',
  });
});

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

vi.mock('../feature-flags-provider', () => ({
  useBackendOutageDetectionEnabled: () => true,
  useInteractiveRequestDeadlineEnabled: () => true,
}));

vi.mock('../../lib/error-reporting', () => ({
  reportError: vi.fn(),
  reportHandledError: vi.fn(),
}));

import {
  __resetConnectivityStoreForTests,
  bindConnectivityStore,
  setOfflineMode,
} from '../../lib/connectivity/connectivity-store';
import { ConnectivityBridge } from '../../components/connectivity-bridge';
import { disposeWsClient } from '../../lib/graphql/ws-client';
import { __resetWsClientLifecycleForTests } from '../../lib/graphql/ws-client-lifecycle';
import { subscribeClimbStatsStream } from '../../lib/climb-stats/subscribe-climb-stats-stream';
import { useSprayCompletionUpdates } from '../../notifications/use-spray-completion-updates';

function SprayCompletionProbe() {
  useSprayCompletionUpdates(true, 'user-1');
  return null;
}

function renderApp() {
  const queryClient = new QueryClient();
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ConnectivityBridge),
      createElement(SprayCompletionProbe),
    ),
  );
}

/** The open connection carrying both live streams, or null. */
function socketWithBothStreams() {
  return (
    server
      .openSockets()
      .find(
        (socket) =>
          [...socket.liveSubscriptions.values()].includes('NotificationReceived') &&
          [...socket.liveSubscriptions.values()].includes('ClimbStatsUpdated'),
      ) ?? null
  );
}

async function waitForBothStreams() {
  await waitFor(() => {
    expect(socketWithBothStreams()).not.toBeNull();
  });
  const socket = socketWithBothStreams();
  if (!socket) throw new Error('no socket carries both streams');
  return socket;
}

describe('live streams after Offline mode on → off', () => {
  let releaseClimbStats: (() => void) | null = null;

  beforeEach(() => {
    server.reset();
    __resetConnectivityStoreForTests();
    bindConnectivityStore({
      probe: async () => 'healthy',
      readDeviceState: async () => ({ device: 'online', deviceReachability: 'reachable' }),
      onOnlineChange: () => {},
    });
  });

  afterEach(() => {
    releaseClimbStats?.();
    releaseClimbStats = null;
    cleanup();
    disposeWsClient();
    __resetWsClientLifecycleForTests();
    __resetConnectivityStoreForTests();
  });

  it('brings both streams back on one new connection, and closes it on the next Offline mode on', async () => {
    renderApp();
    const climbStatsHandlers = { next: vi.fn(), connected: vi.fn(), error: vi.fn() };
    releaseClimbStats = subscribeClimbStatsStream('kilter', 1, climbStatsHandlers);
    const firstSocket = await waitForBothStreams();

    await act(async () => {
      setOfflineMode(true, 'more');
    });
    await waitFor(() => {
      expect(server.openSockets()).toHaveLength(0);
    });

    await act(async () => {
      setOfflineMode(false, 'more');
    });
    const rejoinedSocket = await waitForBothStreams();
    expect(rejoinedSocket.connectionId).not.toBe(firstSocket.connectionId);
    expect(server.openSockets()).toHaveLength(1);
    // The catch-up refresh follows the replacement client's connection too.
    await waitFor(() => {
      expect(climbStatsHandlers.connected).toHaveBeenCalledTimes(2);
    });

    // A stream left on the disposed client would keep its socket open here.
    await act(async () => {
      setOfflineMode(true, 'more');
    });
    await waitFor(() => {
      expect(server.openSockets()).toHaveLength(0);
    });
  });

  it('starts both streams when the app launched with Offline mode already on', async () => {
    setOfflineMode(true, 'more');
    renderApp();
    const climbStatsHandlers = { next: vi.fn(), connected: vi.fn(), error: vi.fn() };
    releaseClimbStats = subscribeClimbStatsStream('kilter', 1, climbStatsHandlers);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(server.openSockets()).toHaveLength(0);

    await act(async () => {
      setOfflineMode(false, 'more');
    });
    await waitForBothStreams();
    expect(server.openSockets()).toHaveLength(1);
  });
});
