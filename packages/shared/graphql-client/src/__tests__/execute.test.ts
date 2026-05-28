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

  it('rejects after timeout if neither complete nor error fires', async () => {
    const client = makeFakeClient();
    const promise = execute(client, { query: 'mutation Foo { ok }' }, 100);
    vi.advanceTimersByTime(150);
    await expect(promise).rejects.toThrow(/timed out after 100ms/);
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
