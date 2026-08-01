import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
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
import { graphqlFetchWithEmptyBodyGuard, GraphQLEmptyResponseError } from '../client';

const mockAuthenticatedFetch = authenticatedFetch as Mock;

beforeEach(() => {
  vi.clearAllMocks();
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
