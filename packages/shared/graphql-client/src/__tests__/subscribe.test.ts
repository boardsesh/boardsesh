import { describe, it, expect, vi } from 'vitest';
import type { Client, Sink } from 'graphql-ws';
import { subscribe } from '../subscribe';
import { GraphQLOperationError, RateLimitError } from '../errors';

type FakeClient = Client & {
  emit: (payload: Parameters<NonNullable<Sink['next']>>[0]) => void;
  emitError: (err: unknown) => void;
};

function makeFakeClient(): FakeClient {
  let currentSink: Sink | null = null;
  const client = {
    subscribe: (_op: unknown, sink: Sink) => {
      currentSink = sink;
      return vi.fn();
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
  }) as FakeClient;
}

function makeErrorSink(onError: Sink['error']): Sink<unknown> {
  return {
    next: vi.fn(),
    error: onError,
    complete: vi.fn(),
  };
}

describe('subscribe', () => {
  it('surfaces structured rate-limit errors as RateLimitError without retrying', () => {
    const client = makeFakeClient();
    const onError = vi.fn();

    subscribe(client, { query: 'subscription Foo { ok }' }, makeErrorSink(onError));

    client.emit({
      data: null,
      errors: [
        {
          message: 'Rate limit exceeded. Try again in 7 seconds.',
          extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 7 },
        },
      ],
    });

    expect(onError).toHaveBeenCalledWith(expect.any(RateLimitError));
    expect(onError.mock.calls[0][0]).toMatchObject({ retryAfterSeconds: 7 });
  });

  it('preserves non-rate-limit GraphQL extensions in GraphQLOperationError', () => {
    const client = makeFakeClient();
    const onError = vi.fn();

    subscribe(client, { query: 'subscription Foo { ok }' }, makeErrorSink(onError));

    client.emit({
      data: null,
      errors: [{ message: 'bad', extensions: { code: 'NOPE' } }],
    });

    expect(onError).toHaveBeenCalledWith(expect.any(GraphQLOperationError));
    expect(onError.mock.calls[0][0]).toMatchObject({ extensions: { code: 'NOPE' } });
  });

  it('parses legacy rate-limit messages from the error callback', () => {
    const client = makeFakeClient();
    const onError = vi.fn();

    subscribe(client, { query: 'subscription Foo { ok }' }, makeErrorSink(onError));

    client.emitError([{ message: 'Rate limit exceeded. Try again in 3 seconds.' }]);

    expect(onError).toHaveBeenCalledWith(expect.any(RateLimitError));
    expect(onError.mock.calls[0][0]).toMatchObject({ retryAfterSeconds: 3 });
  });
});
