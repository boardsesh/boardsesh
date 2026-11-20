import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { CreateGraphQLClientOptions, ExtendedClient } from '@boardsesh/graphql-client';

const shared = vi.hoisted(() => ({
  capturedOptions: [] as CreateGraphQLClientOptions[],
  registerClient: vi.fn((): (() => void) => () => {}),
}));

vi.mock('@boardsesh/graphql-client', () => ({
  createGraphQLClient: (options: CreateGraphQLClientOptions) => {
    shared.capturedOptions.push(options);
    return { dispose: vi.fn(async () => {}) } as unknown as ExtendedClient;
  },
  execute: vi.fn(),
  subscribe: vi.fn(),
  getOperationName: vi.fn(),
  GraphQLOperationError: class extends Error {},
  isClimbDuplicateExtension: vi.fn(),
}));

vi.mock('../websocket-connection-manager', () => ({
  connectionManager: { registerClient: shared.registerClient },
}));

import { acquireRealtimeClient as acquireSharedRealtimeClient, createGraphQLClient } from '../graphql-client';
import { WEB_CLIENT_VERSION } from '@/app/lib/client-identity';
import { browserSessionGuard } from '@/app/lib/auth/session-guard';
import { rememberBrowserAccessToken, resetBrowserAccessTokensForTests } from '@/app/lib/auth/browser-access-token';

const BROWSER_IDENTITY = `boardsesh-web/${WEB_CLIENT_VERSION}`;

function lastConnectionParams(): Promise<Record<string, unknown>> {
  const options = shared.capturedOptions.at(-1);
  if (!options?.connectionParams) throw new Error('createGraphQLClient was not given a connectionParams provider');
  return options.connectionParams();
}

describe('web realtime createGraphQLClient connectionParams', () => {
  beforeEach(() => {
    shared.capturedOptions.length = 0;
  });

  it('sends the auth token and the client identity when signed in', async () => {
    createGraphQLClient({ url: 'wss://backend.test/graphql', authToken: 'session-token' });

    await expect(lastConnectionParams()).resolves.toEqual({
      authToken: 'session-token',
      clientIdentity: BROWSER_IDENTITY,
      clientPlatform: 'web',
    });
    // The static token is folded into the provider, never passed alongside it.
    expect(shared.capturedOptions.at(-1)).not.toHaveProperty('authToken');
  });

  it('sends only the client identity when anonymous', async () => {
    createGraphQLClient({ url: 'wss://backend.test/graphql', authToken: null });

    await expect(lastConnectionParams()).resolves.toEqual({ clientIdentity: BROWSER_IDENTITY, clientPlatform: 'web' });
  });

  it('sends the client identity through the deprecated url signature too', async () => {
    createGraphQLClient('wss://backend.test/graphql');

    await expect(lastConnectionParams()).resolves.toEqual({ clientIdentity: BROWSER_IDENTITY, clientPlatform: 'web' });
  });
});

describe('web realtime createGraphQLClient socket wiring', () => {
  beforeEach(() => {
    shared.capturedOptions.length = 0;
    shared.registerClient.mockClear();
  });

  it('uses the error-swallowing socket and registers the client with the connection manager', () => {
    const unregister = vi.fn();
    shared.registerClient.mockReturnValueOnce(unregister);
    const client = createGraphQLClient({
      url: 'wss://backend.test/graphql',
      authToken: 'session-token',
      connectionName: 'privacy',
    });
    const options = shared.capturedOptions.at(-1);
    if (!options?.webSocketImpl || !options.onClientCreated) throw new Error('Socket wiring was not passed');

    expect(Object.getPrototypeOf(options.webSocketImpl)).toBe(WebSocket);
    expect(options).not.toHaveProperty('lazyCloseTimeoutMs');

    const cleanup = options.onClientCreated(client);
    expect(shared.registerClient).toHaveBeenCalledWith(client, 'privacy');
    expect(unregister).not.toHaveBeenCalled();
    cleanup?.();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it('passes a caller’s lazy-close delay through unchanged', () => {
    createGraphQLClient({ url: 'wss://backend.test/graphql', authToken: null, lazyCloseTimeoutMs: 1500 });

    expect(shared.capturedOptions.at(-1)?.lazyCloseTimeoutMs).toBe(1500);
  });
});

describe('acquireRealtimeClient', () => {
  // Every handle a test takes is released after it, even when the test throws,
  // so the module's shared client never carries over into the next test.
  const handles: Array<{ release: () => void }> = [];
  const acquireRealtimeClient = (options: Parameters<typeof acquireSharedRealtimeClient>[0]) => {
    const handle = acquireSharedRealtimeClient(options);
    handles.push(handle);
    return handle;
  };
  beforeEach(() => {
    shared.capturedOptions.length = 0;
  });
  afterEach(() => {
    for (const handle of handles.splice(0)) handle.release();
  });

  it('hands every holder of the same token one client and disposes it after the last release', () => {
    const first = acquireRealtimeClient({ url: 'wss://backend.test/graphql', authToken: 'shared-token' });
    const second = acquireRealtimeClient({ url: 'wss://backend.test/graphql', authToken: 'shared-token' });
    expect(second.client).toBe(first.client);
    expect(shared.capturedOptions).toHaveLength(1);

    first.release();
    first.release();
    expect(first.client.dispose).not.toHaveBeenCalled();
    second.release();
    expect(first.client.dispose).toHaveBeenCalledOnce();

    const next = acquireRealtimeClient({ url: 'wss://backend.test/graphql', authToken: 'shared-token' });
    expect(next.client).not.toBe(first.client);
    next.release();
  });

  it('opens a fresh client for a new token and closes the old one once its holders move on', () => {
    const old = acquireRealtimeClient({ url: 'wss://backend.test/graphql', authToken: 'old-token' });
    const renewed = acquireRealtimeClient({ url: 'wss://backend.test/graphql', authToken: 'new-token' });
    expect(renewed.client).not.toBe(old.client);
    old.release();
    expect(old.client.dispose).toHaveBeenCalledOnce();
    expect(renewed.client.dispose).not.toHaveBeenCalled();
    renewed.release();
  });

  it('closes the shared socket as soon as the account changes, before its holders release it', () => {
    const guard = browserSessionGuard();
    guard.accept({ userId: 'user-a', authSessionId: 'login-a' });
    const held = acquireRealtimeClient({ url: 'wss://backend.test/graphql', authToken: 'token-a' });

    guard.accept({ userId: 'user-a', authSessionId: 'login-a2' });

    expect(held.client.dispose).toHaveBeenCalledOnce();
    const reacquired = acquireRealtimeClient({ url: 'wss://backend.test/graphql', authToken: 'token-a' });
    expect(reacquired.client).not.toBe(held.client);
    reacquired.release();
  });
});

describe('web realtime client with a 15-minute browser token (#7596 B3b)', () => {
  const viewer = { userId: 'user-1', authSessionId: 'session-1' };
  const FIFTEEN_MINUTES = 15 * 60;

  beforeEach(() => {
    shared.capturedOptions.length = 0;
    resetBrowserAccessTokensForTests();
  });

  it('reads the current token at each connect and gives the socket the 4401-retrying class', async () => {
    rememberBrowserAccessToken('browser-token-1', viewer, FIFTEEN_MINUTES);
    createGraphQLClient({ url: 'wss://backend.test/graphql', authToken: 'browser-token-1' });
    const options = shared.capturedOptions.at(-1);
    await expect(lastConnectionParams()).resolves.toMatchObject({ authToken: 'browser-token-1' });
    rememberBrowserAccessToken('browser-token-2', viewer, FIFTEEN_MINUTES);
    await expect(lastConnectionParams()).resolves.toMatchObject({ authToken: 'browser-token-2' });
    // Not the plain error-swallowing socket: one more class that remaps 4401 (proven end to end in
    // graphql-client-browser-token.test.ts), and no retry predicate of its own.
    expect(Object.getPrototypeOf(options?.webSocketImpl)).not.toBe(WebSocket);
    expect(options).not.toHaveProperty('shouldRetry');
  });

  it('keeps one shared socket while the token is refreshed for the same viewer', () => {
    rememberBrowserAccessToken('browser-token-1', viewer, FIFTEEN_MINUTES);
    const first = acquireSharedRealtimeClient({ url: 'wss://backend.test/graphql', authToken: 'browser-token-1' });
    rememberBrowserAccessToken('browser-token-2', viewer, FIFTEEN_MINUTES);
    const second = acquireSharedRealtimeClient({ url: 'wss://backend.test/graphql', authToken: 'browser-token-2' });
    expect(second.client).toBe(first.client);
    first.release();
    second.release();
  });
});
