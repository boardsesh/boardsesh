import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client, CreateGraphQLClientOptions, ExtendedClient } from '@boardsesh/graphql-client';
import { BACKEND_UNAVAILABLE_ERROR_NAME } from '@boardsesh/offline-sync/error-classification';

// The WebSocket half of offline mode (issue #4862). `getWsClient()` is the ONE
// place a socket can be created, and plenty of callers reach it with no
// connectivity gate of their own — the drawer host restoring a stored active
// board on a cold launch, a BLE auto-connect bind, a party-queue mutation. This
// suite pins the factory gate that catches all of them.

const disposeSpy = vi.hoisted(() => vi.fn());
const realClient = vi.hoisted(() => ({ dispose: disposeSpy }) as unknown as ExtendedClient);
const createGraphQLClient = vi.hoisted(() => vi.fn());

// Only the client factory is replaced: `execute` and `subscribe` stay REAL, so
// the assertions below run the same code path a mutation does in the app.
vi.mock('@boardsesh/graphql-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/graphql-client')>()),
  createGraphQLClient: (options: CreateGraphQLClientOptions) => createGraphQLClient(options),
}));

vi.mock('../../error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../env', () => ({ BACKEND_URL: 'https://api.test' }));

import { execute, subscribe } from '@boardsesh/graphql-client';
import { createWsClientModule } from '../ws-client-core';

const createSocket = vi.fn(() => ({}) as unknown as WebSocket);
const offlineMode = { on: false };

function createModule() {
  return createWsClientModule({
    createSocket,
    captureAuthCredentialGeneration: () => 1,
    getAuthToken: () => Promise.resolve('jwt-token'),
    isAuthCredentialGenerationCurrent: () => true,
    ensureFreshToken: () => Promise.resolve(true),
    recoverAuthRejection: () => Promise.resolve('refreshed' as const),
    isOfflineModeOn: () => offlineMode.on,
  });
}

/** What `subscribe()` handed the sink, if anything. */
function captureSubscriptionError(client: Client): { error: unknown; unsubscribe: () => void } {
  let captured: unknown;
  const unsubscribe = subscribe<Record<string, unknown>>(
    client,
    { query: 'subscription Feed { feed { id } }' },
    {
      next: () => {},
      error: (error) => {
        captured = error;
      },
      complete: () => {},
    },
  );
  return { error: captured, unsubscribe };
}

describe('ws-client — offline mode gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    offlineMode.on = false;
    createGraphQLClient.mockReturnValue(realClient);
  });

  it('builds no client at all while offline mode is on', () => {
    offlineMode.on = true;
    const { getWsClient } = createModule();

    getWsClient();
    getWsClient();

    // Not "a client that fails to connect" — no client, and so no socket.
    expect(createGraphQLClient).not.toHaveBeenCalled();
    expect(createSocket).not.toHaveBeenCalled();
  });

  it('hands the real client back when the switch is off', () => {
    const { getWsClient } = createModule();

    expect(getWsClient()).toBe(realClient);
    expect(createGraphQLClient).toHaveBeenCalledTimes(1);
  });

  it('reuses the one real client across calls', () => {
    const { getWsClient } = createModule();

    getWsClient();
    getWsClient();

    expect(createGraphQLClient).toHaveBeenCalledTimes(1);
  });

  // The whole point of the gate: a subscription started while the mode is on
  // fails locally instead of dialling. `BackendUnavailableError` is what PR-A's
  // HTTP chokepoint already throws — the shared classifier reads it as a
  // transport stop (no `retry_count` strike), `reportHandledError` drops it, and
  // React Query refuses to retry it.
  it('fails a subscription synchronously, with the offline-mode reason', () => {
    offlineMode.on = true;
    const { getWsClient } = createModule();

    const { error, unsubscribe } = captureSubscriptionError(getWsClient());

    expect(error).toMatchObject({ name: BACKEND_UNAVAILABLE_ERROR_NAME, reason: 'offline_mode' });
    expect(() => unsubscribe()).not.toThrow();
  });

  // graphql-ws models a mutation as a one-shot subscription, so this is every
  // imperative write in the app: the presence provider's board bind, a party
  // queue mutation, the drawer host's active-board restore.
  it('rejects a mutation immediately rather than waiting out its timeout', async () => {
    offlineMode.on = true;
    const { getWsClient } = createModule();

    await expect(execute(getWsClient(), { query: 'mutation Bind { bindBoard { id } }' })).rejects.toMatchObject({
      name: BACKEND_UNAVAILABLE_ERROR_NAME,
      reason: 'offline_mode',
    });
    expect(createGraphQLClient).not.toHaveBeenCalled();
  });

  it('rejects the pull-based iterate() the same way', async () => {
    offlineMode.on = true;
    const { getWsClient } = createModule();

    const iterator = getWsClient().iterate({ query: 'subscription Feed { feed { id } }' });

    await expect(iterator.next()).rejects.toMatchObject({ name: BACKEND_UNAVAILABLE_ERROR_NAME });
  });

  it('gives each rejection its own error object, so stacks are not shared', () => {
    offlineMode.on = true;
    const { getWsClient } = createModule();
    const client = getWsClient();

    const first = captureSubscriptionError(client).error;
    const second = captureSubscriptionError(client).error;

    expect(first).not.toBe(second);
  });

  it('leaves the lifecycle methods inert instead of throwing', () => {
    offlineMode.on = true;
    const { getWsClient } = createModule();
    const client = getWsClient();

    expect(() => client.on('connected', () => {})()).not.toThrow();
    expect(() => client.terminate()).not.toThrow();
    expect(() => void client.dispose()).not.toThrow();
  });

  // The stub is never cached as "the client". Caching it would leave a phone
  // that turned offline mode back off holding a dead transport for the rest of
  // the launch — the exact trap #4862 is about.
  it('builds a real client on the first call after the switch goes off', () => {
    offlineMode.on = true;
    const { getWsClient } = createModule();
    expect(getWsClient()).not.toBe(realClient);

    offlineMode.on = false;

    expect(getWsClient()).toBe(realClient);
    expect(createGraphQLClient).toHaveBeenCalledTimes(1);
  });

  it('goes inert again when the switch comes back on, without rebuilding later', () => {
    const { getWsClient } = createModule();
    expect(getWsClient()).toBe(realClient);

    offlineMode.on = true;
    expect(getWsClient()).not.toBe(realClient);

    offlineMode.on = false;
    expect(getWsClient()).toBe(realClient);
    expect(createGraphQLClient).toHaveBeenCalledTimes(1);
  });

  // `disposeWsClient` still owns the real client's teardown; the gate only
  // decides which client `getWsClient()` hands out.
  it('still disposes the real client when one was built', () => {
    const { getWsClient, disposeWsClient } = createModule();
    getWsClient();

    disposeWsClient();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});
