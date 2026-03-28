import { beforeEach, describe, expect, it, vi } from 'vitest';

let capturedOnHandlers: {
  connected?: () => void;
  closed?: (event: unknown) => void;
  error?: (error: unknown) => void;
} = {};
let capturedShouldRetry: ((errorOrCloseEvent: unknown) => boolean) | undefined;

const mockDispose = vi.fn();
const mockSubscribe = vi.fn();

vi.mock('graphql-ws', () => ({
  createClient: vi.fn((options: { on?: typeof capturedOnHandlers, shouldRetry?: typeof capturedShouldRetry }) => {
    capturedOnHandlers = options.on || {};
    capturedShouldRetry = options.shouldRetry;
    return {
      subscribe: mockSubscribe,
      dispose: mockDispose,
    };
  }),
}));

vi.mock('../../connection-manager/websocket-connection-manager', () => ({
  connectionManager: {
    registerClient: vi.fn(() => vi.fn()),
  },
  KEEP_ALIVE_MS: 10000,
}));

import { createGraphQLClient, execute } from '../graphql-client';

describe('createGraphQLClient', () => {
  beforeEach(() => {
    capturedOnHandlers = {};
    capturedShouldRetry = undefined;
    vi.clearAllMocks();
  });

  it('creates a client with the given URL', () => {
    const client = createGraphQLClient({ url: 'ws://test' });
    expect(client).toBeDefined();
    expect(client.subscribe).toBeDefined();
  });

  describe('onConnectionStateChange', () => {
    it('calls onConnectionStateChange(true, false) on first connect', () => {
      const onChange = vi.fn();
      createGraphQLClient({ url: 'ws://test', onConnectionStateChange: onChange });
      capturedOnHandlers.connected?.();
      expect(onChange).toHaveBeenCalledWith(true, false);
    });

    it('calls onConnectionStateChange(true, true) on reconnect', () => {
      const onChange = vi.fn();
      createGraphQLClient({ url: 'ws://test', onConnectionStateChange: onChange });
      capturedOnHandlers.connected?.();
      onChange.mockClear();
      capturedOnHandlers.connected?.();
      expect(onChange).toHaveBeenCalledWith(true, true);
    });

    it('calls onConnectionStateChange(false, true) on close after connect', () => {
      const onChange = vi.fn();
      createGraphQLClient({ url: 'ws://test', onConnectionStateChange: onChange });
      capturedOnHandlers.connected?.();
      onChange.mockClear();
      capturedOnHandlers.closed?.({});
      expect(onChange).toHaveBeenCalledWith(false, true);
    });

    it('does not call onConnectionStateChange on close before first connect', () => {
      const onChange = vi.fn();
      createGraphQLClient({ url: 'ws://test', onConnectionStateChange: onChange });
      capturedOnHandlers.closed?.({});
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('onReconnect', () => {
    it('does not call onReconnect on first connect', () => {
      const onReconnect = vi.fn();
      createGraphQLClient({ url: 'ws://test', onReconnect });
      capturedOnHandlers.connected?.();
      expect(onReconnect).not.toHaveBeenCalled();
    });

    it('calls onReconnect on subsequent connects', () => {
      const onReconnect = vi.fn();
      createGraphQLClient({ url: 'ws://test', onReconnect });
      capturedOnHandlers.connected?.();
      capturedOnHandlers.connected?.();
      expect(onReconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('shouldRetry', () => {
    it('does not retry definitive auth/protocol close codes', () => {
      createGraphQLClient({ url: 'ws://test' });
      expect(capturedShouldRetry?.({ code: 4401 })).toBe(false);
      expect(capturedShouldRetry?.({ code: 4403 })).toBe(false);
      expect(capturedShouldRetry?.({ code: 1008 })).toBe(false);
    });

    it('retries transient close codes', () => {
      createGraphQLClient({ url: 'ws://test' });
      expect(capturedShouldRetry?.({ code: 1006 })).toBe(true);
      expect(capturedShouldRetry?.({ code: 1012 })).toBe(true);
    });
  });
});

describe('execute timeout behavior', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('unsubscribes the in-flight operation when timeout elapses', async () => {
    vi.useFakeTimers();

    const unsubscribe = vi.fn();
    const client = {
      subscribe: vi.fn(() => unsubscribe),
    } as any;

    const promise = execute(client, { query: 'mutation Test { test }' }, 50);
    const assertion = expect(promise).rejects.toThrow("GraphQL mutation 'Test' timed out after 50ms");

    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('ignores late completion after timeout and does not double-unsubscribe', async () => {
    vi.useFakeTimers();

    const unsubscribe = vi.fn();
    let sink: { complete?: () => void } | null = null;
    const client = {
      subscribe: vi.fn((_op: unknown, currentSink: { complete?: () => void }) => {
        sink = currentSink;
        return unsubscribe;
      }),
    } as any;

    const promise = execute(client, { query: 'mutation Test { test }' }, 50);
    const assertion = expect(promise).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(50);
    await assertion;

    // Operation eventually completes after timeout; should be ignored.
    (sink as { complete?: () => void } | null)?.complete?.();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
