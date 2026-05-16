import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

type SubscribeSink = {
  next: (data: { data?: unknown; errors?: Array<{ message: string; extensions?: Record<string, unknown> }> }) => void;
  error: (err: unknown) => void;
  complete: () => void;
};

const { mockGraphQLWsClient } = vi.hoisted(() => ({
  mockGraphQLWsClient: {
    subscribe: vi.fn(),
    dispose: vi.fn(),
    iterate: vi.fn(),
    terminate: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('graphql-ws', () => ({
  createClient: vi.fn(() => mockGraphQLWsClient),
}));

vi.mock('../../connection-manager/websocket-connection-manager', () => ({
  connectionManager: { registerClient: vi.fn(() => vi.fn()) },
  KEEP_ALIVE_MS: 30_000,
}));

import { execute } from '../graphql-client';
import { RateLimitError, onRateLimited } from '../rate-limit-error';

const QUERY = 'mutation Test { test }';

beforeEach(() => {
  mockGraphQLWsClient.subscribe.mockReset();
});

function setupSubscribeSequence(responders: Array<(sink: SubscribeSink) => void>) {
  let call = 0;
  mockGraphQLWsClient.subscribe.mockImplementation((_payload: unknown, sink: SubscribeSink) => {
    const respond = responders[call++];
    if (!respond) throw new Error('Unexpected extra subscribe call');
    // Defer so the caller can return the unsubscribe function before sink fires.
    queueMicrotask(() => respond(sink));
    return () => {};
  });
}

describe('execute() rate-limit retry', () => {
  it('retries after a RATE_LIMITED error with extensions and resolves', async () => {
    setupSubscribeSequence([
      (sink) => {
        sink.next({
          errors: [
            {
              message: 'Rate limit exceeded. Try again in 0 seconds.',
              extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 0 },
            },
          ],
        });
      },
      (sink) => {
        sink.next({ data: { test: 'ok' } });
        sink.complete();
      },
    ]);

    const result = await execute(mockGraphQLWsClient as never, { query: QUERY });
    expect(result).toEqual({ test: 'ok' });
    expect(mockGraphQLWsClient.subscribe).toHaveBeenCalledTimes(2);
  });

  it('falls back to message regex when extensions are missing', async () => {
    setupSubscribeSequence([
      (sink) => {
        sink.next({ errors: [{ message: 'Rate limit exceeded. Try again in 0 seconds.' }] });
      },
      (sink) => {
        sink.next({ data: { test: 'legacy' } });
        sink.complete();
      },
    ]);

    const result = await execute(mockGraphQLWsClient as never, { query: QUERY });
    expect(result).toEqual({ test: 'legacy' });
    expect(mockGraphQLWsClient.subscribe).toHaveBeenCalledTimes(2);
  });

  it('rejects with RateLimitError after exhausting retries', async () => {
    setupSubscribeSequence([
      (sink) =>
        sink.next({
          errors: [
            {
              message: 'Rate limit exceeded. Try again in 0 seconds.',
              extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 0 },
            },
          ],
        }),
      (sink) =>
        sink.next({
          errors: [
            {
              message: 'Rate limit exceeded. Try again in 0 seconds.',
              extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 0 },
            },
          ],
        }),
      (sink) =>
        sink.next({
          errors: [
            {
              message: 'Rate limit exceeded. Try again in 0 seconds.',
              extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 0 },
            },
          ],
        }),
    ]);

    await expect(execute(mockGraphQLWsClient as never, { query: QUERY })).rejects.toBeInstanceOf(RateLimitError);
    expect(mockGraphQLWsClient.subscribe).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-rate-limit GraphQL errors', async () => {
    setupSubscribeSequence([(sink) => sink.next({ errors: [{ message: 'Validation failed' }] })]);

    await expect(execute(mockGraphQLWsClient as never, { query: QUERY })).rejects.toThrow('Validation failed');
    expect(mockGraphQLWsClient.subscribe).toHaveBeenCalledTimes(1);
  });

  it('emits onRateLimited for each retry attempt', async () => {
    setupSubscribeSequence([
      (sink) =>
        sink.next({
          errors: [
            {
              message: 'Rate limit exceeded. Try again in 0 seconds.',
              extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 0 },
            },
          ],
        }),
      (sink) => {
        sink.next({ data: { test: 'ok' } });
        sink.complete();
      },
    ]);

    const events: Array<{ attempt: number; retryAfter: number }> = [];
    const unsubscribe = onRateLimited((err, attempt) => {
      events.push({ attempt, retryAfter: err.retryAfterSeconds });
    });

    try {
      await execute(mockGraphQLWsClient as never, { query: QUERY });
    } finally {
      unsubscribe();
    }

    expect(events).toEqual([{ attempt: 1, retryAfter: 0 }]);
  });
});
