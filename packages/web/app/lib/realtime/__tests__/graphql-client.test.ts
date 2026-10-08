import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { CreateGraphQLClientOptions, ExtendedClient } from '@boardsesh/graphql-client';

const shared = vi.hoisted(() => ({
  capturedOptions: [] as CreateGraphQLClientOptions[],
}));

vi.mock('@boardsesh/graphql-client', () => ({
  createGraphQLClient: (options: CreateGraphQLClientOptions) => {
    shared.capturedOptions.push(options);
    return { dispose: vi.fn() } as unknown as ExtendedClient;
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

import { createGraphQLClient } from '../graphql-client';
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
    });
    // The static token is folded into the provider, never passed alongside it.
    expect(shared.capturedOptions.at(-1)).not.toHaveProperty('authToken');
  });

  it('sends only the client identity when anonymous', async () => {
    createGraphQLClient({ url: 'wss://backend.test/graphql', authToken: null });

    await expect(lastConnectionParams()).resolves.toEqual({ clientIdentity: BROWSER_IDENTITY });
  });

  it('sends the client identity through the deprecated url signature too', async () => {
    createGraphQLClient('wss://backend.test/graphql');

    await expect(lastConnectionParams()).resolves.toEqual({ clientIdentity: BROWSER_IDENTITY });
  });
});
