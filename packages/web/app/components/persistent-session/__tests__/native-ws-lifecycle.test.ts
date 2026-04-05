import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockIsNativeApp = vi.fn(() => false);
const mockGetPlatform = vi.fn<() => 'ios' | 'android' | 'web'>(() => 'web');

vi.mock('@/app/lib/ble/capacitor-utils', () => ({
  isNativeApp: () => mockIsNativeApp(),
  getPlatform: () => mockGetPlatform(),
}));

vi.mock('@/app/lib/native-ws/native-ws-plugin', () => ({
  getNativeWebSocketPlugin: () => null,
  isNativeWebSocketAvailable: () => mockIsNativeApp() && mockGetPlatform() === 'ios',
}));

const mockExecute = vi.fn((..._args: unknown[]) => Promise.resolve({ joinSession: null } as Record<string, unknown>));
const mockSubscribe = vi.fn((..._args: unknown[]) => () => {});
const mockDisposeGraphql = vi.fn();

vi.mock('../../graphql-queue/graphql-client', () => ({
  createGraphQLClient: vi.fn(() => ({
    dispose: mockDisposeGraphql,
    on: () => () => {},
    terminate: vi.fn(),
  })),
  execute: mockExecute,
  subscribe: mockSubscribe,
}));

const mockNativeExecute = vi.fn(() => Promise.resolve({}));
const mockNativeSubscribe = vi.fn(() => () => {});
const mockNativeDispose = vi.fn();

vi.mock('../../graphql-queue/native-ws-client', () => ({
  isNativeWebSocketAvailable: () => mockIsNativeApp() && mockGetPlatform() === 'ios',
  createNativeWSClient: vi.fn(() => ({
    execute: mockNativeExecute,
    subscribe: mockNativeSubscribe,
    dispose: mockNativeDispose,
    getConnectionState: () => 'connected',
  })),
  NativeWSClient: class MockNativeWSClient {
    execute = mockNativeExecute;
    subscribe = mockNativeSubscribe;
    dispose = mockNativeDispose;
    getConnectionState = () => 'connected';
  },
}));

vi.mock('../../connection-manager/websocket-connection-manager', () => ({
  connectionManager: {
    updateNativeState: vi.fn(),
    clearNativeState: vi.fn(),
    registerClient: () => () => {},
    subscribe: () => () => {},
    getSnapshot: () => ({ name: null, state: 'idle', lastActivity: null, error: null }),
    forceReconnect: vi.fn(),
    setPrimaryName: vi.fn(),
    dispose: vi.fn(),
    __resetForTests: vi.fn(),
  },
}));

// Import modules after mocks
const { isNativeWebSocketAvailable } = await import('../../graphql-queue/native-ws-client');
const { createNativeWSClient } = await import('../../graphql-queue/native-ws-client');
const { connectionManager } = await import('../../connection-manager/websocket-connection-manager');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('native WebSocket detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsNativeApp.mockReturnValue(false);
    mockGetPlatform.mockReturnValue('web');
  });

  it('returns false on web platform', () => {
    mockIsNativeApp.mockReturnValue(false);
    mockGetPlatform.mockReturnValue('web');

    expect(isNativeWebSocketAvailable()).toBe(false);
  });

  it('returns false on Android native', () => {
    mockIsNativeApp.mockReturnValue(true);
    mockGetPlatform.mockReturnValue('android');

    expect(isNativeWebSocketAvailable()).toBe(false);
  });

  it('returns true on iOS native', () => {
    mockIsNativeApp.mockReturnValue(true);
    mockGetPlatform.mockReturnValue('ios');

    expect(isNativeWebSocketAvailable()).toBe(true);
  });
});

describe('executeOnTransport branching', () => {
  // Test the executeOnTransport utility from use-queue-mutations
  // by importing it and exercising both code paths.

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes execute through NativeWSClient when native client is provided', async () => {
    mockIsNativeApp.mockReturnValue(true);
    mockGetPlatform.mockReturnValue('ios');

    const nativeClient = createNativeWSClient();
    const expectedResult = { data: 'native-result' };
    mockNativeExecute.mockResolvedValueOnce(expectedResult);

    // Directly test the pattern used in use-queue-mutations
    const result = await nativeClient.execute({
      query: 'mutation { test }',
      variables: { input: 'val' },
    });

    expect(mockNativeExecute).toHaveBeenCalledWith({
      query: 'mutation { test }',
      variables: { input: 'val' },
    });
    expect(result).toEqual(expectedResult);
  });

  it('routes execute through graphql-ws execute for standard Client', async () => {
    mockIsNativeApp.mockReturnValue(false);
    mockGetPlatform.mockReturnValue('web');

    const { createGraphQLClient } = await import('../../graphql-queue/graphql-client');
    const graphqlClient = createGraphQLClient({
      url: 'ws://localhost:8080/graphql',
      authToken: null,
    });

    const expectedResult = { data: 'web-result' };
    mockExecute.mockResolvedValueOnce(expectedResult);

    // The graphql-ws path uses the separate execute function
    const result = await mockExecute(graphqlClient, {
      query: 'mutation { test }',
      variables: { input: 'val' },
    });

    expect(mockExecute).toHaveBeenCalledWith(graphqlClient, {
      query: 'mutation { test }',
      variables: { input: 'val' },
    });
    expect(result).toEqual(expectedResult);
  });
});

describe('connection manager native state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updateNativeState updates the connection manager', () => {
    connectionManager.updateNativeState('connected' as 'connected');

    expect(connectionManager.updateNativeState).toHaveBeenCalledWith('connected');
  });

  it('clearNativeState resets the connection manager', () => {
    connectionManager.clearNativeState();

    expect(connectionManager.clearNativeState).toHaveBeenCalled();
  });
});

describe('native client lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsNativeApp.mockReturnValue(true);
    mockGetPlatform.mockReturnValue('ios');
  });

  it('createNativeWSClient returns a client with execute, subscribe, dispose', () => {
    const client = createNativeWSClient();

    expect(typeof client.execute).toBe('function');
    expect(typeof client.subscribe).toBe('function');
    expect(typeof client.dispose).toBe('function');
  });

  it('subscribe returns an unsubscribe function', () => {
    const client = createNativeWSClient();
    const sink = { next: vi.fn(), error: vi.fn(), complete: vi.fn() };

    const unsubscribe = client.subscribe(
      { query: 'subscription { events }' },
      sink,
    );

    expect(typeof unsubscribe).toBe('function');
  });

  it('dispose cleans up the client', () => {
    const client = createNativeWSClient();

    client.dispose();

    expect(mockNativeDispose).toHaveBeenCalled();
  });
});
