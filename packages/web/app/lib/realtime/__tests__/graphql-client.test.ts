import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { CreateGraphQLClientOptions, ExtendedClient } from '@boardsesh/graphql-client';

const shared = vi.hoisted(() => ({
  capturedOptions: [] as CreateGraphQLClientOptions[],
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
  connectionManager: { registerClient: vi.fn(() => () => {}) },
}));

import { acquireRealtimeClient as acquireSharedRealtimeClient, createGraphQLClient } from '../graphql-client';
import { WEB_CLIENT_VERSION } from '@/app/lib/client-identity';

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
});
