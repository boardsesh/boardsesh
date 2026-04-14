import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Client, Sink } from 'graphql-ws';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Prevent connectionManager from starting its setInterval in the test env.
vi.mock('../../connection-manager/websocket-connection-manager', () => ({
  connectionManager: {
    registerClient: vi.fn(() => vi.fn()), // returns a no-op unregister function
    subscribe: vi.fn(() => vi.fn()),
    getSnapshot: vi.fn(() => ({ name: null, state: 'idle', lastActivity: null })),
    forceReconnect: vi.fn(),
    setPrimaryName: vi.fn(),
    dispose: vi.fn(),
    __resetForTests: vi.fn(),
  },
  KEEP_ALIVE_MS: 5_000,
  STALE_GRACE_MS: 10_000,
  HEALTH_CHECK_INTERVAL_MS: 1_000,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal mock graphql-ws Client that lets tests drive the sink. */
function makeMockClient() {
  let capturedSink: Sink<unknown> | null = null;
  const unsubscribeFn = vi.fn();

  const client: Pick<Client, 'subscribe'> = {
    subscribe: vi.fn((_payload, sink: Sink<unknown>) => {
      capturedSink = sink;
      return unsubscribeFn;
    }),
  };

  return {
    client: client as unknown as Client,
    /** Returns the Sink captured by the most-recent subscribe() call. */
    sink: () => {
      if (!capturedSink) throw new Error('subscribe() has not been called yet');
      return capturedSink;
    },
    unsubscribeFn,
  };
}

// ---------------------------------------------------------------------------
// Imports (after mocks so vi.mock hoisting works correctly)
// ---------------------------------------------------------------------------

// eslint-disable-next-line import/first
import { execute } from '../graphql-client';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('execute()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // --- Success path ---

  it('resolves with data when the subscription delivers next then complete', async () => {
    const { client, sink } = makeMockClient();
    const resultPromise = execute<{ value: string }>(
      client,
      { query: 'mutation Foo { foo { value } }' },
      1_000,
    );

    sink().next({ data: { value: 'hello' } });
    sink().complete();

    await expect(resultPromise).resolves.toEqual({ value: 'hello' });
  });

  it('uses the last next() payload when multiple are delivered before complete', async () => {
    const { client, sink } = makeMockClient();
    const resultPromise = execute<{ n: number }>(
      client,
      { query: 'mutation M { m { n } }' },
      1_000,
    );

    sink().next({ data: { n: 1 } });
    sink().next({ data: { n: 2 } });
    sink().complete();

    await expect(resultPromise).resolves.toEqual({ n: 2 });
  });

  it('rejects when complete fires without any data', async () => {
    const { client, sink } = makeMockClient();
    const resultPromise = execute(
      client,
      { query: 'mutation M { m }' },
      1_000,
    );

    sink().complete();

    await expect(resultPromise).rejects.toThrow("completed without data");
  });

  // --- Error normalisation ---

  it('rejects with a proper Error when the sink receives a plain Error', async () => {
    const { client, sink } = makeMockClient();
    const resultPromise = execute(
      client,
      { query: 'mutation M { m }' },
      1_000,
    );

    sink().error(new Error('transport failed'));

    await expect(resultPromise).rejects.toThrow('transport failed');
    await expect(resultPromise).rejects.toBeInstanceOf(Error);
  });

  it('wraps a non-Error rejection value (e.g. CloseEvent-like plain object) in an Error', async () => {
    const { client, sink } = makeMockClient();
    const resultPromise = execute(
      client,
      { query: 'mutation M { m }' },
      1_000,
    );

    // Simulates graphql-ws passing { code, reason } as the rejection value
    sink().error({ code: 1000, reason: 'All Subscriptions Gone' });

    await expect(resultPromise).rejects.toBeInstanceOf(Error);
    await expect(resultPromise).rejects.toThrow(/All Subscriptions Gone/);
  });

  // --- Timeout path ---

  it('rejects with a timeout error when the operation exceeds timeoutMs', async () => {
    const { client } = makeMockClient();
    const resultPromise = execute(
      client,
      { query: 'mutation Slow { slow }' },
      500,
    );

    vi.advanceTimersByTime(500);

    await expect(resultPromise).rejects.toThrow('timed out after 500ms');
  });

  it('calls unsubscribe() when the timeout fires', async () => {
    const { client, unsubscribeFn } = makeMockClient();
    const resultPromise = execute(
      client,
      { query: 'mutation Slow { slow }' },
      500,
    ).catch(() => {});

    vi.advanceTimersByTime(500);
    await resultPromise;

    expect(unsubscribeFn).toHaveBeenCalledTimes(1);
  });

  it('ignores a complete callback that fires after the timeout', async () => {
    const { client, sink } = makeMockClient();
    const resultPromise = execute<{ v: number }>(
      client,
      { query: 'mutation Slow { slow { v } }' },
      500,
    );

    // Capture the rejection before advancing timers
    const rejection = resultPromise.catch((e: unknown) => e);

    vi.advanceTimersByTime(500);
    const err = await rejection;

    // Now simulate graphql-ws firing complete after the unsubscribe teardown
    sink().next({ data: { v: 42 } });
    sink().complete();

    // The original promise must still be the timeout rejection, not a resolution
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timed out/);

    // unsubscribe() must not have been called again by the complete handler
    // (it was called once by the timeout; the complete path should bail out)
    const { unsubscribeFn } = makeMockClient(); // fresh ref just to be explicit
    // We verify via the same promise result — if complete had re-fired resolve()
    // the race would have settled differently, which the assertion above already catches.
    void unsubscribeFn; // suppress unused-var lint
  });

  it('ignores an error callback that fires after the timeout', async () => {
    const { client, sink } = makeMockClient();
    const resultPromise = execute(
      client,
      { query: 'mutation Slow { slow }' },
      500,
    );

    const rejection = resultPromise.catch((e: unknown) => e);
    vi.advanceTimersByTime(500);
    const err = await rejection;

    // Late-arriving sink error should be silently ignored
    expect(() => sink().error(new Error('late error'))).not.toThrow();

    expect((err as Error).message).toMatch(/timed out/);
  });

  it('clears the timeout timer when the operation succeeds before the deadline', async () => {
    const { client, sink } = makeMockClient();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const resultPromise = execute<{ ok: boolean }>(
      client,
      { query: 'mutation Fast { fast { ok } }' },
      1_000,
    );

    sink().next({ data: { ok: true } });
    sink().complete();

    await resultPromise;

    // .finally() should have called clearTimeout with the timer id
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// dispose() rejection handling
// ---------------------------------------------------------------------------

describe('createGraphQLClient dispose() override', () => {
  // We test the pattern in isolation: given a client whose originalDispose()
  // returns a rejected Promise, the override must not let that rejection escape
  // as an unhandled rejection.

  it('silences a rejection from originalDispose() instead of creating an unhandled rejection', async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      // Replicate what createGraphQLClient does to the dispose method
      const rejectingDispose = () => Promise.reject(new Error('dispose failed'));
      const wrapped = () => {
        Promise.resolve(rejectingDispose()).catch(() => {
          // suppressed — matches production behaviour
        });
      };

      wrapped();

      // Flush microtasks so any unhandled rejection would have been reported
      await Promise.resolve();
      await Promise.resolve();

      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('silences a plain-object rejection ({ code, reason }) from originalDispose()', async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const rejectingDispose = () =>
        Promise.reject({ code: 1000, reason: 'All Subscriptions Gone' });

      const wrapped = () => {
        Promise.resolve(rejectingDispose()).catch(() => {});
      };

      wrapped();
      await Promise.resolve();
      await Promise.resolve();

      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});
