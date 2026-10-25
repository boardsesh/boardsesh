import { describe, it, expect, vi } from 'vitest';
import type { Client, Sink } from 'graphql-ws';
import { subscribe } from '../subscribe';
import { GraphQLOperationError, GraphQLTransportClosedError, isRateLimitedError } from '../errors';

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

function makeSink(): Sink<unknown> {
  return { next: vi.fn(), error: vi.fn(), complete: vi.fn() };
}

describe('subscribe', () => {
  it('keeps the close code of a raw close event instead of "[object Object]"', () => {
    const client = makeFakeClient();
    const sink = makeSink();
    subscribe(client, { query: 'subscription Foo { ok }' }, sink);
    client.emitError({ type: 'close', code: 1006, reason: '', wasClean: false });
    const forwarded = (sink.error as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(forwarded).toBeInstanceOf(GraphQLTransportClosedError);
    expect(forwarded.code).toBe(1006);
    expect(forwarded.message).not.toContain('[object Object]');
  });

  it('types a TerminatedCloseEvent-like Error that carries a close code', () => {
    const client = makeFakeClient();
    const sink = makeSink();
    subscribe(client, { query: 'subscription Foo { ok }' }, sink);
    client.emitError(Object.assign(new Error('Socket closed with event 4499'), { code: 4499, reason: 'bye' }));
    const forwarded = (sink.error as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(forwarded).toBeInstanceOf(GraphQLTransportClosedError);
    expect(forwarded.code).toBe(4499);
  });

  it('forwards data to sink.next', () => {
    const client = makeFakeClient();
    const sink = makeSink();
    subscribe(client, { query: 'subscription Foo { ok }' }, sink);

    client.emit({ data: { ok: true } });

    expect(sink.next).toHaveBeenCalledWith({ ok: true });
  });

  it('forwards data.errors as a classifiable GraphQLOperationError (RATE_LIMITED preserved)', () => {
    const client = makeFakeClient();
    const sink = makeSink();
    subscribe(client, { query: 'subscription Foo { ok }' }, sink);

    client.emit({
      data: null,
      errors: [
        {
          message: 'Rate limit exceeded. Try again in 7 seconds.',
          extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 7 },
        },
      ],
    });

    expect(sink.error).toHaveBeenCalledWith(expect.any(GraphQLOperationError));
    const forwarded = (sink.error as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(isRateLimitedError(forwarded)).toBe(true);
    expect(forwarded).toMatchObject({ extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 7 } });
  });

  it('preserves non-rate-limit extensions in the forwarded error', () => {
    const client = makeFakeClient();
    const sink = makeSink();
    subscribe(client, { query: 'subscription Foo { ok }' }, sink);

    client.emit({ data: null, errors: [{ message: 'bad', extensions: { code: 'NOPE' } }] });

    expect(sink.error).toHaveBeenCalledWith(expect.any(GraphQLOperationError));
    expect((sink.error as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ extensions: { code: 'NOPE' } });
  });

  it('forwards an error-callback GraphQLError array as GraphQLOperationError', () => {
    const client = makeFakeClient();
    const sink = makeSink();
    subscribe(client, { query: 'subscription Foo { ok }' }, sink);

    client.emitError([
      {
        message: 'Rate limit exceeded. Try again in 3 seconds.',
        extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 3 },
      },
    ]);

    const forwarded = (sink.error as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(forwarded).toBeInstanceOf(GraphQLOperationError);
    expect(isRateLimitedError(forwarded)).toBe(true);
    expect(sink.error).toHaveBeenCalledTimes(1);
  });

  it('coerces a raw DOM error event into a proper Error', () => {
    const client = makeFakeClient();
    const sink = makeSink();
    subscribe(client, { query: 'subscription Foo { ok }' }, sink);

    client.emitError({ type: 'error' });

    const forwarded = (sink.error as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(forwarded).toBeInstanceOf(Error);
    expect(forwarded).not.toBeInstanceOf(GraphQLOperationError);
  });
});
