// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Client, Sink } from 'graphql-ws';
import { execute } from '../execute';
import { GraphQLOperationError } from '../errors';

type FakeClient = Client & {
  emit: (payload: Parameters<NonNullable<Sink['next']>>[0]) => void;
  emitError: (err: unknown) => void;
  emitComplete: () => void;
  unsubscribe: ReturnType<typeof vi.fn>;
};

function makeFakeClient(): FakeClient {
  let currentSink: Sink | null = null;
  const unsubscribe = vi.fn();
  const client = {
    subscribe: (_op: unknown, sink: Sink) => {
      currentSink = sink;
      return unsubscribe;
    },
    on: () => () => {},
    iterate: () => {
      throw new Error('not used');
    },
    dispose: async () => {},
    terminate: () => {},
  } as unknown as Client;
  return Object.assign(client, {
    emit: (payload: Parameters<NonNullable<Sink['next']>>[0]) => currentSink?.next?.(payload),
    emitError: (err: unknown) => currentSink?.error?.(err),
    emitComplete: () => currentSink?.complete?.(),
    unsubscribe,
  }) as FakeClient;
}

describe('execute', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the last data payload received before complete', async () => {
    const client = makeFakeClient();
    const promise = execute<{ ok: boolean }>(client, { query: 'mutation Foo { ok }' });
    client.emit({ data: { ok: true } });
    client.emitComplete();
    await expect(promise).resolves.toEqual({ ok: true });
    expect(client.unsubscribe).toHaveBeenCalled();
  });

  it('rejects with GraphQLOperationError when next() carries errors', async () => {
    const client = makeFakeClient();
    const promise = execute(client, { query: 'mutation Foo { ok }' });
    client.emit({ data: null, errors: [{ message: 'bad', extensions: { code: 'X' } }] });
    await expect(promise).rejects.toBeInstanceOf(GraphQLOperationError);
    await expect(promise).rejects.toMatchObject({ extensions: { code: 'X' } });
    expect(client.unsubscribe).toHaveBeenCalled();
  });

  it('rejects with GraphQLOperationError when error() carries a graphql errors array', async () => {
    const client = makeFakeClient();
    const promise = execute(client, { query: 'mutation Foo { ok }' });
    client.emitError([{ message: 'boom', extensions: { code: 'NOPE' } }]);
    await expect(promise).rejects.toBeInstanceOf(GraphQLOperationError);
    await expect(promise).rejects.toMatchObject({ extensions: { code: 'NOPE' } });
  });

  it('rejects with a wrapped Error when error() is an unknown shape', async () => {
    const client = makeFakeClient();
    const promise = execute(client, { query: 'mutation Foo { ok }' });
    client.emitError({ weird: true });
    await expect(promise).rejects.toBeInstanceOf(Error);
  });

  it('rejects when complete fires before any data', async () => {
    const client = makeFakeClient();
    const promise = execute(client, { query: 'mutation Foo { ok }' });
    client.emitComplete();
    await expect(promise).rejects.toThrow(/completed without data/);
  });

  it('rejects after timeout if neither complete nor error fires, unsubscribing the stream', async () => {
    const client = makeFakeClient();
    const promise = execute(client, { query: 'mutation Foo { ok }' }, 100);
    vi.advanceTimersByTime(150);
    await expect(promise).rejects.toThrow(/timed out after 100ms/);
    expect(client.unsubscribe).toHaveBeenCalled();
  });

  it('clears the timeout once the operation settles so timers do not pile up', async () => {
    const client = makeFakeClient();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const promise = execute<{ ok: boolean }>(client, { query: 'mutation Foo { ok }' }, 30_000);
    client.emit({ data: { ok: true } });
    client.emitComplete();
    await expect(promise).resolves.toEqual({ ok: true });
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});

// Scripted client: delivers the next scripted response on each `subscribe` call
// (one per execute attempt), via a microtask so it lands after `execute` wires
// its sink. Runs with real timers — the retry `sleep` is injected as immediate.
type ScriptResponse =
  | { kind: 'data'; data: unknown }
  | { kind: 'errors'; errors: Array<{ message: string; extensions?: Record<string, unknown> }> };

function makeScriptedClient(script: ScriptResponse[]) {
  let call = 0;
  const subscribeSpy = vi.fn((_op: unknown, sink: Sink) => {
    const response = script[Math.min(call, script.length - 1)];
    call += 1;
    queueMicrotask(() => {
      if (response.kind === 'data') {
        sink.next?.({ data: response.data } as Parameters<NonNullable<Sink['next']>>[0]);
        sink.complete?.();
      } else {
        sink.next?.({ data: null, errors: response.errors } as Parameters<NonNullable<Sink['next']>>[0]);
      }
    });
    return vi.fn();
  });
  const client = {
    subscribe: subscribeSpy,
    on: () => () => {},
    iterate: () => {
      throw new Error('not used');
    },
    dispose: async () => {},
    terminate: () => {},
  } as unknown as Client;
  return { client, subscribeSpy };
}

const immediateSleep = () => Promise.resolve();

const rateLimited = (retryAfterSeconds: number): ScriptResponse => ({
  kind: 'errors',
  errors: [
    {
      message: `Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`,
      extensions: { code: 'RATE_LIMITED', retryAfterSeconds },
    },
  ],
});

describe('execute — rate-limit retry (#2655)', () => {
  it('retries a RATE_LIMITED rejection and resolves on the retry, honouring retryAfterSeconds', async () => {
    const { client, subscribeSpy } = makeScriptedClient([rateLimited(1), { kind: 'data', data: { ok: true } }]);
    const onRateLimited = vi.fn();

    const result = await execute<{ ok: boolean }>(
      client,
      { query: 'mutation Foo { ok }' },
      { sleep: immediateSleep, rateLimitJitterMs: 0, onRateLimited },
    );

    expect(result).toEqual({ ok: true });
    expect(subscribeSpy).toHaveBeenCalledTimes(2);
    expect(onRateLimited).toHaveBeenCalledTimes(1);
    expect(onRateLimited).toHaveBeenCalledWith({
      attempt: 1,
      maxAttempts: 2,
      retryAfterMs: 1000,
      operationName: 'Foo',
    });
  });

  it('caps the retry wait at maxRateLimitDelayMs', async () => {
    const { client } = makeScriptedClient([rateLimited(120), { kind: 'data', data: { ok: true } }]);
    const onRateLimited = vi.fn();

    await execute(
      client,
      { query: 'mutation Foo { ok }' },
      { sleep: immediateSleep, rateLimitJitterMs: 0, maxRateLimitDelayMs: 30_000, onRateLimited },
    );

    expect(onRateLimited).toHaveBeenCalledWith(expect.objectContaining({ retryAfterMs: 30_000 }));
  });

  it('gives up after the retry budget and rejects with the classifiable error', async () => {
    const { client, subscribeSpy } = makeScriptedClient([rateLimited(2)]);

    const promise = execute(
      client,
      { query: 'mutation Foo { ok }' },
      { rateLimitRetries: 2, sleep: immediateSleep, rateLimitJitterMs: 0 },
    );

    await expect(promise).rejects.toBeInstanceOf(GraphQLOperationError);
    await expect(promise).rejects.toMatchObject({ extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 2 } });
    // initial attempt + 2 retries
    expect(subscribeSpy).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-rate-limit GraphQL error', async () => {
    const { client, subscribeSpy } = makeScriptedClient([
      { kind: 'errors', errors: [{ message: 'boom', extensions: { code: 'NOPE' } }] },
    ]);

    await expect(execute(client, { query: 'mutation Foo { ok }' }, { sleep: immediateSleep })).rejects.toMatchObject({
      extensions: { code: 'NOPE' },
    });
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
  });

  it('rateLimitRetries: 0 surfaces the rate-limit error immediately', async () => {
    const { client, subscribeSpy } = makeScriptedClient([rateLimited(3)]);

    await expect(
      execute(client, { query: 'mutation Foo { ok }' }, { rateLimitRetries: 0, sleep: immediateSleep }),
    ).rejects.toBeInstanceOf(GraphQLOperationError);
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
  });

  it('recognises a legacy message-only rate limit (no extension) and retries', async () => {
    const { client } = makeScriptedClient([
      { kind: 'errors', errors: [{ message: 'Rate limit exceeded. Try again in 5 seconds.' }] },
      { kind: 'data', data: { ok: true } },
    ]);
    const onRateLimited = vi.fn();

    const result = await execute<{ ok: boolean }>(
      client,
      { query: 'mutation Foo { ok }' },
      { sleep: immediateSleep, rateLimitJitterMs: 0, onRateLimited },
    );

    expect(result).toEqual({ ok: true });
    expect(onRateLimited).toHaveBeenCalledWith(expect.objectContaining({ retryAfterMs: 5000 }));
  });

  it('gives each attempt a fresh timeout so the back-off wait cannot trip it', async () => {
    const { client } = makeScriptedClient([rateLimited(1), { kind: 'data', data: { ok: true } }]);
    // Short per-attempt timeout; the retry still succeeds because attempt 2 gets
    // its own timer and the wait happens outside any timer.
    const result = await execute<{ ok: boolean }>(
      client,
      { query: 'mutation Foo { ok }' },
      { timeoutMs: 50, sleep: immediateSleep, rateLimitJitterMs: 0 },
    );
    expect(result).toEqual({ ok: true });
  });
});
