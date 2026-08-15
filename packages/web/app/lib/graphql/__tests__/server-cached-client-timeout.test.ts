// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Both halves of the backend-call deadline: that the signal reaches the client
 * and aborts on time, and that the climb front door's two sections actually ask
 * for one. Without this the mechanism could be deleted outright — a wedged
 * backend would go back to hanging the climb page inside its `Promise.all` — and
 * nothing would go red.
 */
const { constructorOptions, backend } = vi.hoisted(() => ({
  constructorOptions: [] as ({ signal?: AbortSignal } | undefined)[],
  /** `wedged` never answers; flip it to model a healthy backend. */
  backend: { wedged: true },
}));

vi.mock('server-only', () => ({}));

vi.mock('graphql-request', () => ({
  GraphQLClient: class {
    constructor(
      public url: string,
      options?: { signal?: AbortSignal },
    ) {
      constructorOptions.push(options);
    }
    request<T>(): Promise<T> {
      // A wedged backend: the socket is open and nothing ever comes back.
      return backend.wedged ? new Promise<T>(() => {}) : (Promise.resolve({}) as Promise<T>);
    }
  },
}));

vi.mock('next/cache', () => ({
  unstable_cache:
    <T extends (...args: unknown[]) => unknown>(fn: T) =>
    (...args: Parameters<T>) =>
      fn(...args),
}));

vi.mock('@/app/lib/graphql/client', () => ({ getGraphQLHttpUrl: () => 'http://backend.test/graphql' }));
vi.mock('../server-graphql', () => ({
  executeAuthenticatedGraphQL: vi.fn(),
  serverMyBoards: vi.fn(),
  serverUserPlaylists: vi.fn(),
  serverGroupedNotifications: vi.fn(),
  serverPlaylist: vi.fn(),
  serverPlaylistClimbs: vi.fn(),
}));

import { createCachedGraphQLQuery } from '../server-cached-client';

describe('createCachedGraphQLQuery timeout', () => {
  beforeEach(() => {
    constructorOptions.length = 0;
    backend.wedged = true;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts the request once the timeout elapses', async () => {
    const query = createCachedGraphQLQuery('query Q { x }', 'similar-climbs', 3600, 3000);
    void query();
    await vi.advanceTimersByTimeAsync(0);

    const signal = constructorOptions[0]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(3000);
    expect(signal?.aborted).toBe(true);
  });

  it('passes no signal when no timeout is asked for', async () => {
    const query = createCachedGraphQLQuery('query Q { x }', 'session-grouped-feed-public', 86400);
    void query();
    await vi.advanceTimersByTimeAsync(0);

    expect(constructorOptions[0]?.signal).toBeUndefined();
    // And no stray timer keeps a serverless instance alive past its response.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timer when the backend answers in time', async () => {
    backend.wedged = false;

    const query = createCachedGraphQLQuery('query Q { x }', 'beta-links-x', 3600, 3000);
    await query();

    // A leaked timer per backend call keeps a serverless instance alive for
    // three seconds past its response.
    expect(vi.getTimerCount()).toBe(0);
    expect(constructorOptions[0]?.signal?.aborted).toBe(false);
  });
});
