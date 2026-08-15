import { afterEach, describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  GRAPHQL_EMPTY_RESPONSE_ERROR_NAME,
  getErrorStatus,
  isNetworkError,
} from '@boardsesh/offline-sync/error-classification';

// The guard wraps authenticatedFetch — mock it directly so we can hand back
// whatever Response shape the test wants without touching auth/token plumbing
// (that's covered by auth-interceptor.test.ts).
vi.mock('../../auth-interceptor', () => ({
  authenticatedFetch: vi.fn(),
}));

import { authenticatedFetch } from '../../auth-interceptor';
import {
  graphqlFetchWithEmptyBodyGuard,
  graphqlFetchWithOfflineSyncTimeout,
  GraphQLEmptyResponseError,
} from '../client';

const mockAuthenticatedFetch = authenticatedFetch as Mock;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('graphqlFetchWithEmptyBodyGuard', () => {
  it('throws GraphQLEmptyResponseError for a 200 with an empty body (#3190 — connection dropped mid-response)', async () => {
    mockAuthenticatedFetch.mockResolvedValue(new Response('', { status: 200 }));

    await expect(graphqlFetchWithEmptyBodyGuard('https://api.example.com/graphql')).rejects.toThrow(
      GraphQLEmptyResponseError,
    );
  });

  it('throws GraphQLEmptyResponseError for a 200 with a whitespace-only body', async () => {
    mockAuthenticatedFetch.mockResolvedValue(new Response('   \n', { status: 200 }));

    await expect(graphqlFetchWithEmptyBodyGuard('https://api.example.com/graphql')).rejects.toThrow(
      GraphQLEmptyResponseError,
    );
  });

  it('throws GraphQLEmptyResponseError for a 200 with a non-JSON body (e.g. an HTML captive-portal page)', async () => {
    mockAuthenticatedFetch.mockResolvedValue(new Response('<html>not json</html>', { status: 200 }));

    await expect(graphqlFetchWithEmptyBodyGuard('https://api.example.com/graphql')).rejects.toThrow(
      GraphQLEmptyResponseError,
    );
  });

  it('throws GraphQLEmptyResponseError for a 200 whose body is valid JSON but not an object/array', async () => {
    mockAuthenticatedFetch.mockResolvedValue(new Response('"just a string"', { status: 200 }));

    await expect(graphqlFetchWithEmptyBodyGuard('https://api.example.com/graphql')).rejects.toThrow(
      GraphQLEmptyResponseError,
    );
  });

  it('keeps the 2xx status while classifying the typed empty response as a network stop', async () => {
    mockAuthenticatedFetch.mockResolvedValue(new Response('', { status: 200 }));

    const request = graphqlFetchWithEmptyBodyGuard('https://api.example.com/graphql');

    await expect(request).rejects.toMatchObject({
      name: GRAPHQL_EMPTY_RESPONSE_ERROR_NAME,
      message: expect.stringContaining('200'),
      status: 200,
    });

    const error = new GraphQLEmptyResponseError(200);
    expect(getErrorStatus(error)).toBe(200);
    expect(isNetworkError(error)).toBe(true);
  });

  it('passes a valid JSON object body straight through untouched', async () => {
    const body = JSON.stringify({ data: { climbStatsHistory: [] } });
    mockAuthenticatedFetch.mockResolvedValue(new Response(body, { status: 200 }));

    const response = await graphqlFetchWithEmptyBodyGuard('https://api.example.com/graphql');

    expect(response.ok).toBe(true);
    await expect(response.text()).resolves.toBe(body);
  });

  it('passes a valid JSON array body straight through untouched (batched requests)', async () => {
    const body = JSON.stringify([{ data: { climbStatsHistory: [] } }]);
    mockAuthenticatedFetch.mockResolvedValue(new Response(body, { status: 200 }));

    const response = await graphqlFetchWithEmptyBodyGuard('https://api.example.com/graphql');

    expect(response.ok).toBe(true);
    await expect(response.text()).resolves.toBe(body);
  });

  it('does not intercept a non-2xx response even with an empty body — graphql-request already handles that as a ClientError', async () => {
    mockAuthenticatedFetch.mockResolvedValue(new Response('', { status: 500 }));

    const response = await graphqlFetchWithEmptyBodyGuard('https://api.example.com/graphql');

    expect(response.ok).toBe(false);
    expect(response.status).toBe(500);
  });

  it('does not intercept a non-2xx response with a non-JSON body', async () => {
    mockAuthenticatedFetch.mockResolvedValue(new Response('Bad Gateway', { status: 502 }));

    const response = await graphqlFetchWithEmptyBodyGuard('https://api.example.com/graphql');

    expect(response.ok).toBe(false);
    expect(response.status).toBe(502);
  });

  it('forwards url and options to authenticatedFetch unchanged', async () => {
    mockAuthenticatedFetch.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    const options = { method: 'POST', body: '{"query":"{ __typename }"}' };

    await graphqlFetchWithEmptyBodyGuard('https://api.example.com/graphql', options);

    expect(mockAuthenticatedFetch).toHaveBeenCalledWith('https://api.example.com/graphql', options);
  });
});

describe('graphqlFetchWithOfflineSyncTimeout', () => {
  it('aborts and rejects a request that never settles once the offline-sync deadline elapses', async () => {
    vi.useFakeTimers();
    mockAuthenticatedFetch.mockImplementation(() => new Promise<Response>(() => undefined));

    const request = graphqlFetchWithOfflineSyncTimeout('https://api.example.com/graphql', {}, 1_000);
    // Attach the rejection handler before advancing time so Vitest never sees
    // the intentional timeout as an unhandled rejection.
    const rejection = expect(request).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Offline sync GraphQL request timed out after 1000ms',
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;

    const requestOptions = mockAuthenticatedFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(requestOptions?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards caller cancellation and clears its deadline', async () => {
    vi.useFakeTimers();
    mockAuthenticatedFetch.mockImplementation(() => new Promise<Response>(() => undefined));
    const callerController = new AbortController();
    const callerReason = new Error('caller cancelled');

    const request = graphqlFetchWithOfflineSyncTimeout(
      'https://api.example.com/graphql',
      { signal: callerController.signal },
      1_000,
    );
    const rejection = expect(request).rejects.toBe(callerReason);
    callerController.abort(callerReason);

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its deadline after a successful response', async () => {
    vi.useFakeTimers();
    const responseBody = JSON.stringify({ data: { boardClimbs: [] } });
    mockAuthenticatedFetch.mockResolvedValue(new Response(responseBody, { status: 200 }));

    const response = await graphqlFetchWithOfflineSyncTimeout('https://api.example.com/graphql', {}, 1_000);

    await expect(response.text()).resolves.toBe(responseBody);
    expect(vi.getTimerCount()).toBe(0);
  });
});
