import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — capture listener callbacks so tests can simulate native events
// ---------------------------------------------------------------------------

let wsMessageCallback: ((data: Record<string, unknown>) => void) | null = null;
let connectionStateCallback: ((data: Record<string, unknown>) => void) | null = null;

const mockConnect = vi.fn(() => Promise.resolve());
const mockDisconnect = vi.fn(() => Promise.resolve());
const mockSendOperation = vi.fn((_opts: Record<string, unknown>) => Promise.resolve());
const mockSubscribe = vi.fn((_opts: Record<string, unknown>) => Promise.resolve());
const mockUnsubscribe = vi.fn(() => Promise.resolve());
const mockSetWebviewActive = vi.fn(() => Promise.resolve());
const mockFlushBuffer = vi.fn(() => Promise.resolve());
const mockUpdateAuthToken = vi.fn(() => Promise.resolve());
const mockGetConnectionState = vi.fn(() => Promise.resolve({ connected: false, reconnectAttempt: 0 }));
const mockRemove = vi.fn();

const mockAddListener = vi.fn((event: string, cb: (data: Record<string, unknown>) => void) => {
  if (event === 'wsMessage') wsMessageCallback = cb;
  if (event === 'connectionStateChanged') connectionStateCallback = cb;
  return { remove: mockRemove };
});

vi.mock('@/app/lib/native-ws/native-ws-plugin', () => ({
  getNativeWebSocketPlugin: () => ({
    connect: mockConnect,
    disconnect: mockDisconnect,
    sendOperation: mockSendOperation,
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
    addListener: mockAddListener,
    setWebviewActive: mockSetWebviewActive,
    flushBuffer: mockFlushBuffer,
    updateAuthToken: mockUpdateAuthToken,
    getConnectionState: mockGetConnectionState,
  }),
  isNativeWebSocketAvailable: () => true,
}));

const mockUpdateNativeState = vi.fn();
const mockClearNativeState = vi.fn();

vi.mock('../../connection-manager/websocket-connection-manager', () => ({
  connectionManager: {
    updateNativeState: mockUpdateNativeState,
    clearNativeState: mockClearNativeState,
  },
}));

// Import after mocks
const { NativeWSClient, createNativeWSClient } = await import('../native-ws-client');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function simulateWsMessage(msg: { type: string; id?: string; payload?: Record<string, unknown> }) {
  if (!wsMessageCallback) throw new Error('wsMessage listener not registered');
  wsMessageCallback({ raw: JSON.stringify(msg) });
}

function simulateConnectionState(state: string) {
  if (!connectionStateCallback) throw new Error('connectionStateChanged listener not registered');
  connectionStateCallback({ state });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NativeWSClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsMessageCallback = null;
    connectionStateCallback = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('subscribe', () => {
    it('forwards subscription to native plugin with correct params', async () => {
      const client = new NativeWSClient({});
      const sink = { next: vi.fn(), error: vi.fn(), complete: vi.fn() };

      client.subscribe(
        { query: 'subscription { test }', variables: { foo: 'bar' } },
        sink,
      );

      // Flush microtask for async subscribe call
      await Promise.resolve();
      expect(mockSubscribe).toHaveBeenCalledTimes(1);

      const call = mockSubscribe.mock.calls[0]![0] as unknown as { query: string; variables: string; subscriptionId: string };
      expect(call.query).toBe('subscription { test }');
      expect(call.variables).toBe(JSON.stringify({ foo: 'bar' }));
      expect(call.subscriptionId).toMatch(/^sub-/);

      client.dispose();
    });

    it('delivers messages to the correct sink via wsMessage events', async () => {
      const client = new NativeWSClient({});
      const sink = { next: vi.fn(), error: vi.fn(), complete: vi.fn() };

      client.subscribe({ query: 'subscription { test }' }, sink);

      await Promise.resolve();
      expect(mockSubscribe).toHaveBeenCalledTimes(1);

      const subscriptionId = (mockSubscribe.mock.calls[0]![0] as unknown as { subscriptionId: string }).subscriptionId;

      simulateWsMessage({
        type: 'next',
        id: subscriptionId,
        payload: { data: { test: 'value' } },
      });

      expect(sink.next).toHaveBeenCalledWith({ test: 'value' });

      client.dispose();
    });

    it('filters messages for other subscription IDs', async () => {
      const client = new NativeWSClient({});
      const sink = { next: vi.fn(), error: vi.fn(), complete: vi.fn() };

      client.subscribe({ query: 'subscription { test }' }, sink);

      await Promise.resolve();
      expect(mockSubscribe).toHaveBeenCalledTimes(1);

      // Send a message with a different subscription ID
      simulateWsMessage({
        type: 'next',
        id: 'some-other-sub-id',
        payload: { data: { unrelated: true } },
      });

      expect(sink.next).not.toHaveBeenCalled();

      client.dispose();
    });

    it('calls plugin.unsubscribe when the returned function is invoked', async () => {
      const client = new NativeWSClient({});
      const sink = { next: vi.fn(), error: vi.fn(), complete: vi.fn() };

      const unsubscribe = client.subscribe({ query: 'subscription { test }' }, sink);

      await Promise.resolve();
      expect(mockSubscribe).toHaveBeenCalledTimes(1);

      const subscriptionId = (mockSubscribe.mock.calls[0]![0] as unknown as { subscriptionId: string }).subscriptionId;

      unsubscribe();

      expect(mockUnsubscribe).toHaveBeenCalledWith({ subscriptionId });

      client.dispose();
    });
  });

  describe('execute', () => {
    it('resolves with data on next + complete messages', async () => {
      const client = new NativeWSClient({});

      const promise = client.execute<{ result: string }>({
        query: 'mutation { doThing }',
        variables: { input: 'test' },
      });

      await Promise.resolve();
      expect(mockSendOperation).toHaveBeenCalledTimes(1);

      const operationId = (mockSendOperation.mock.calls[0]![0] as unknown as { operationId: string }).operationId;

      simulateWsMessage({
        type: 'next',
        id: operationId,
        payload: { data: { result: 'success' } },
      });

      simulateWsMessage({
        type: 'complete',
        id: operationId,
      });

      const result = await promise;
      expect(result).toEqual({ result: 'success' });

      client.dispose();
    });

    it('rejects on error message', async () => {
      const client = new NativeWSClient({});

      const promise = client.execute({ query: 'mutation { fail }' });

      await Promise.resolve();
      expect(mockSendOperation).toHaveBeenCalledTimes(1);

      const operationId = (mockSendOperation.mock.calls[0]![0] as unknown as { operationId: string }).operationId;

      simulateWsMessage({
        type: 'next',
        id: operationId,
        payload: { errors: [{ message: 'Something went wrong' }] },
      });

      await expect(promise).rejects.toThrow('Something went wrong');

      client.dispose();
    });

    it('rejects after 30s timeout', async () => {
      vi.useFakeTimers();

      const client = new NativeWSClient({});

      const promise = client.execute({ query: 'mutation { slow }' });

      await Promise.resolve();
      expect(mockSendOperation).toHaveBeenCalledTimes(1);

      // Advance past the 30s timeout
      vi.advanceTimersByTime(30_001);

      await expect(promise).rejects.toThrow('Operation timed out after 30000ms');

      client.dispose();
    });

    it('sends variables as stringified JSON', async () => {
      const client = new NativeWSClient({});

      client.execute({
        query: 'mutation { doThing }',
        variables: { key: 'value', nested: { deep: true } },
      });

      await Promise.resolve();
      expect(mockSendOperation).toHaveBeenCalledTimes(1);

      const call = mockSendOperation.mock.calls[0]![0] as unknown as { variables: string };
      expect(call.variables).toBe(JSON.stringify({ key: 'value', nested: { deep: true } }));

      client.dispose();
    });
  });

  describe('dispose', () => {
    it('calls plugin.disconnect', () => {
      const client = new NativeWSClient({});

      client.dispose();

      expect(mockDisconnect).toHaveBeenCalledTimes(1);
    });

    it('removes event listeners', () => {
      const client = new NativeWSClient({});

      client.dispose();

      // Two listener handles should be removed (wsMessage + connectionStateChanged)
      expect(mockRemove).toHaveBeenCalledTimes(2);
    });
  });

  describe('connection state', () => {
    it('starts in disconnected state', () => {
      const client = new NativeWSClient({});

      expect(client.getConnectionState()).toBe('disconnected');

      client.dispose();
    });

    it('updates state on connectionStateChanged events', () => {
      const client = new NativeWSClient({});

      simulateConnectionState('connecting');
      expect(client.getConnectionState()).toBe('connecting');

      simulateConnectionState('connected');
      expect(client.getConnectionState()).toBe('connected');

      simulateConnectionState('reconnecting');
      expect(client.getConnectionState()).toBe('reconnecting');

      client.dispose();
    });

    it('calls connectionManager.updateNativeState on state changes', () => {
      const client = new NativeWSClient({});

      simulateConnectionState('connected');

      expect(mockUpdateNativeState).toHaveBeenCalledWith('connected');

      client.dispose();
    });
  });

  describe('reconnection', () => {
    it('fires onReconnect callback on second connected event', () => {
      const onReconnect = vi.fn();
      const client = new NativeWSClient({ onReconnect });

      // First connection
      simulateConnectionState('connected');
      expect(onReconnect).not.toHaveBeenCalled();

      // Disconnect + reconnect
      simulateConnectionState('reconnecting');
      simulateConnectionState('connected');
      expect(onReconnect).toHaveBeenCalledTimes(1);

      client.dispose();
    });

    it('fires onReconnect callback on resync_needed message', () => {
      const onReconnect = vi.fn();
      const client = new NativeWSClient({ onReconnect });

      simulateWsMessage({ type: 'resync_needed' });

      expect(onReconnect).toHaveBeenCalledTimes(1);

      client.dispose();
    });

    it('does not fire onReconnect if no callback provided', () => {
      const client = new NativeWSClient({});

      // Should not throw
      simulateWsMessage({ type: 'resync_needed' });
      simulateConnectionState('connected');
      simulateConnectionState('reconnecting');
      simulateConnectionState('connected');

      client.dispose();
    });
  });

  describe('createNativeWSClient', () => {
    it('returns a NativeWSClient instance', () => {
      const client = createNativeWSClient();
      expect(client).toBeInstanceOf(NativeWSClient);
      client.dispose();
    });

    it('passes onReconnect option through', () => {
      const onReconnect = vi.fn();
      const client = createNativeWSClient({ onReconnect });

      // Trigger reconnect scenario
      simulateConnectionState('connected');
      simulateConnectionState('reconnecting');
      simulateConnectionState('connected');

      expect(onReconnect).toHaveBeenCalledTimes(1);

      client.dispose();
    });
  });
});
