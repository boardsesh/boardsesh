import { afterEach, describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  GRAPHQL_EMPTY_RESPONSE_ERROR_NAME,
  GRAPHQL_REQUEST_TIMEOUT_CODE,
  getErrorStatus,
  isNetworkError,
} from '@boardsesh/offline-sync/error-classification';

// The guard wraps authenticatedFetch — mock it directly so we can hand back
// whatever Response shape the test wants without touching auth/token plumbing
// (that's covered by auth-interceptor.test.ts).
vi.mock('../../auth-interceptor', () => ({
  authenticatedFetch: vi.fn(),
}));

// The connectivity store is a process-wide singleton. Mock it so each case can
// put the app in a chosen connectivity state and assert exactly what the client
// reported back (issue #4862).
const connectivity = vi.hoisted(() => ({
  snapshot: { effectiveOffline: false, reason: null as string | null },
  reportBackendOutcome: vi.fn(),
}));

vi.mock('../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => connectivity.snapshot,
  reportBackendOutcome: (outcome: unknown) => connectivity.reportBackendOutcome(outcome),
}));

import { authenticatedFetch } from '../../auth-interceptor';
import { BackendUnavailableError } from '../../connectivity/backend-unavailable-error';
import {
  graphqlFetchGated,
  isGraphqlRequestTimeoutError,
  GraphQLEmptyResponseError,
  INTERACTIVE_GRAPHQL_REQUEST_TIMEOUT_MS,
  OFFLINE_SYNC_GRAPHQL_REQUEST_TIMEOUT_MS,
} from '../client';

const mockAuthenticatedFetch = authenticatedFetch as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  connectivity.snapshot = { effectiveOffline: false, reason: null };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('graphqlFetchGated — the empty-body guard (#3190)', () => {
  it('throws GraphQLEmptyResponseError for a 200 with an empty body (#3190 — connection dropped mid-response)', async () => {
    mockAuthenticatedFetch.mockResolvedValue(new Response('', { status: 200 }));

    await expect(graphqlFetchGated('https://api.example.com/graphql')).rejects.toThrow(GraphQLEmptyResponseError);
  });

  it('throws GraphQLEmptyResponseError for a 200 with a whitespace-only body', async () => {
    mockAuthenticatedFetch.mockResolvedValue(new Response('   \n', { status: 200 }));

    await expect(graphqlFetchGated('https://api.example.com/graphql')).rejects.toThrow(GraphQLEmptyResponseError);
  });

  it('throws GraphQLEmptyResponseError for a 200 with a non-JSON body (e.g. an HTML captive-portal page)', async () => {
    mockAuthenticatedFetch.mockResolvedValue(new Response('<html>not json</html>', { status: 200 }));

    await expect(graphqlFetchGated('https://api.example.com/graphql')).rejects.toThrow(GraphQLEmptyResponseError);
  });

  it('throws GraphQLEmptyResponseError for a 200 whose body is valid JSON but not an object/array', async () => {
    mockAuthenticatedFetch.mockResolvedValue(new Response('"just a string"', { status: 200 }));

    await expect(graphqlFetchGated('https://api.example.com/graphql')).rejects.toThrow(GraphQLEmptyResponseError);
  });

  it('keeps the 2xx status while classifying the typed empty response as a network stop', async () => {
    mockAuthenticatedFetch.mockResolvedValue(new Response('', { status: 200 }));

    const request = graphqlFetchGated('https://api.example.com/graphql');

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

    const response = await graphqlFetchGated('https://api.example.com/graphql');

    expect(response.ok).toBe(true);
    await expect(response.text()).resolves.toBe(body);
  });

  it('passes a valid JSON array body straight through untouched (batched requests)', async () => {
    const body = JSON.stringify([{ data: { climbStatsHistory: [] } }]);
    mockAuthenticatedFetch.mockResolvedValue(new Response(body, { status: 200 }));

    const response = await graphqlFetchGated('https://api.example.com/graphql');

    expect(response.ok).toBe(true);
    await expect(response.text()).resolves.toBe(body);
  });

  it('does not intercept a non-2xx response even with an empty body — graphql-request already handles that as a ClientError', async () => {
    mockAuthenticatedFetch.mockResolvedValue(new Response('', { status: 500 }));

    const response = await graphqlFetchGated('https://api.example.com/graphql');

    expect(response.ok).toBe(false);
    expect(response.status).toBe(500);
  });

  it('does not intercept a non-2xx response with a non-JSON body', async () => {
    mockAuthenticatedFetch.mockResolvedValue(new Response('Bad Gateway', { status: 502 }));

    const response = await graphqlFetchGated('https://api.example.com/graphql');

    expect(response.ok).toBe(false);
    expect(response.status).toBe(502);
  });

  it('forwards url and options to authenticatedFetch unchanged', async () => {
    mockAuthenticatedFetch.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    const options = { method: 'POST', body: '{"query":"{ __typename }"}' };

    await graphqlFetchGated('https://api.example.com/graphql', options);

    // The deadline's own signal is the one addition; everything the caller
    // passed reaches the network untouched.
    expect(mockAuthenticatedFetch).toHaveBeenCalledWith(
      'https://api.example.com/graphql',
      expect.objectContaining({ ...options, signal: expect.any(AbortSignal) }),
    );
  });
});

describe('graphqlFetchGated — the request deadline', () => {
  // Interactive requests had NO deadline before #4862 — a request to a wedged
  // backend never settled, and the screen behind it never left its spinner.
  it('gives an interactive request 20s and a sync request 30s', () => {
    expect(INTERACTIVE_GRAPHQL_REQUEST_TIMEOUT_MS).toBe(20_000);
    expect(OFFLINE_SYNC_GRAPHQL_REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it('waits as long as it takes when the deadline is switched off (null)', async () => {
    vi.useFakeTimers();
    connectivity.snapshot = { effectiveOffline: false, reason: null };
    // A marginal link that answers after 60 s: with the kill switch on this is a
    // timeout; with it off the old wait-forever behaviour is back.
    mockAuthenticatedFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response(JSON.stringify({ data: {} }), { status: 200 })), 60_000);
        }),
    );

    const request = graphqlFetchGated('https://api.example.com/graphql', {}, null);
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(request).resolves.toBeInstanceOf(Response);
    vi.useRealTimers();
  });

  it('aborts and rejects a request that never settles once the deadline elapses', async () => {
    vi.useFakeTimers();
    mockAuthenticatedFetch.mockImplementation(() => new Promise<Response>(() => undefined));

    const request = graphqlFetchGated('https://api.example.com/graphql', {}, 1_000);
    // Attach the rejection handler before advancing time so Vitest never sees
    // the intentional timeout as an unhandled rejection.
    const rejection = expect(request).rejects.toMatchObject({
      // The NAME stays AbortError so every existing cancellation filter keeps
      // treating it as one; the CODE is what tells our deadline apart from a
      // climber walking away from the screen.
      name: 'AbortError',
      code: GRAPHQL_REQUEST_TIMEOUT_CODE,
      timeoutMs: 1_000,
      message: 'GraphQL request timed out after 1000ms',
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

    const request = graphqlFetchGated('https://api.example.com/graphql', { signal: callerController.signal }, 1_000);
    const rejection = expect(request).rejects.toBe(callerReason);
    callerController.abort(callerReason);

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its deadline after a successful response', async () => {
    vi.useFakeTimers();
    const responseBody = JSON.stringify({ data: { boardClimbs: [] } });
    mockAuthenticatedFetch.mockResolvedValue(new Response(responseBody, { status: 200 }));

    const response = await graphqlFetchGated('https://api.example.com/graphql', {}, 1_000);

    await expect(response.text()).resolves.toBe(responseBody);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('isGraphqlRequestTimeoutError', () => {
  it('matches only our own deadline, not a user cancellation carrying the same name', () => {
    const cancelled = new Error('cancelled');
    cancelled.name = 'AbortError';

    expect(isGraphqlRequestTimeoutError(cancelled)).toBe(false);
    expect(isGraphqlRequestTimeoutError({ code: GRAPHQL_REQUEST_TIMEOUT_CODE })).toBe(true);
    expect(isGraphqlRequestTimeoutError(null)).toBe(false);
  });
});

describe('graphqlFetchGated — failing fast (#4862)', () => {
  // The ordering is the point: authenticatedFetch's first act is
  // ensureFreshToken(), so an unchecked request to a dead backend would spend a
  // token refresh against that same dead backend before it even started.
  it('refuses before authenticatedFetch when the backend is known unreachable', async () => {
    connectivity.snapshot = { effectiveOffline: true, reason: 'backend_unreachable' };

    await expect(graphqlFetchGated('https://api.example.com/graphql')).rejects.toMatchObject({
      name: 'BackendUnavailableError',
      reason: 'backend_unreachable',
    });
    expect(mockAuthenticatedFetch).not.toHaveBeenCalled();
    expect(connectivity.reportBackendOutcome).not.toHaveBeenCalled();
  });

  it('carries the reason so the UI can say which side is down', async () => {
    connectivity.snapshot = { effectiveOffline: true, reason: 'device_offline' };

    const rejection = (await graphqlFetchGated('https://api.example.com/graphql').catch(
      (error: unknown) => error,
    )) as BackendUnavailableError;

    expect(rejection).toBeInstanceOf(BackendUnavailableError);
    expect(rejection.reason).toBe('device_offline');
  });

  it('sends the request normally while connectivity is fine', async () => {
    mockAuthenticatedFetch.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));

    const response = await graphqlFetchGated('https://api.example.com/graphql');

    expect(response.status).toBe(200);
    expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(1);
  });
});

describe('graphqlFetchGated — reachability outcomes (#4862)', () => {
  it('reports a 200 as a success', async () => {
    mockAuthenticatedFetch.mockResolvedValue(new Response(JSON.stringify({ data: { me: null } }), { status: 200 }));

    await graphqlFetchGated('https://api.example.com/graphql');

    expect(connectivity.reportBackendOutcome).toHaveBeenCalledExactlyOnceWith({ kind: 'success' });
  });

  // The server answered and refused. That is a healthy backend telling us
  // something true, and treating it as an outage would take the whole app
  // offline over one bad request.
  it.each([400, 401, 404, 429])('reports a %d as a success — the server answered', async (status) => {
    mockAuthenticatedFetch.mockResolvedValue(new Response('{"errors":[]}', { status }));

    await graphqlFetchGated('https://api.example.com/graphql');

    expect(connectivity.reportBackendOutcome).toHaveBeenCalledExactlyOnceWith({ kind: 'success' });
  });

  it.each([500, 502, 503, 504])('reports a %d as a backend failure', async (status) => {
    mockAuthenticatedFetch.mockResolvedValue(new Response('Bad Gateway', { status }));

    await graphqlFetchGated('https://api.example.com/graphql');

    expect(connectivity.reportBackendOutcome).toHaveBeenCalledExactlyOnceWith({ kind: 'failure', status });
  });

  // Yoga answers an unhandled resolver throw with a 200. Status alone would read
  // that outage as a perfectly healthy response.
  it('reports a 200 whose GraphQL errors say INTERNAL_SERVER_ERROR as a backend failure', async () => {
    const body = JSON.stringify({ errors: [{ message: 'boom', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] });
    mockAuthenticatedFetch.mockResolvedValue(new Response(body, { status: 200 }));

    await graphqlFetchGated('https://api.example.com/graphql');

    expect(connectivity.reportBackendOutcome).toHaveBeenCalledExactlyOnceWith({ kind: 'failure', status: 200 });
  });

  it('leaves an ordinary GraphQL error on a 200 as a success', async () => {
    const body = JSON.stringify({ errors: [{ message: 'nope', extensions: { code: 'NOT_FOUND' } }] });
    mockAuthenticatedFetch.mockResolvedValue(new Response(body, { status: 200 }));

    await graphqlFetchGated('https://api.example.com/graphql');

    expect(connectivity.reportBackendOutcome).toHaveBeenCalledExactlyOnceWith({ kind: 'success' });
  });

  it('reports a transport throw as a backend failure', async () => {
    const transportError = new TypeError('Network request failed');
    mockAuthenticatedFetch.mockRejectedValue(transportError);

    await expect(graphqlFetchGated('https://api.example.com/graphql')).rejects.toBe(transportError);

    expect(connectivity.reportBackendOutcome).toHaveBeenCalledExactlyOnceWith({
      kind: 'failure',
      error: transportError,
    });
  });

  it('reports our own deadline as a backend failure', async () => {
    vi.useFakeTimers();
    mockAuthenticatedFetch.mockImplementation(() => new Promise<Response>(() => undefined));

    const request = graphqlFetchGated('https://api.example.com/graphql', {}, 1_000);
    const rejection = expect(request).rejects.toMatchObject({ code: GRAPHQL_REQUEST_TIMEOUT_CODE });
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;

    expect(connectivity.reportBackendOutcome).toHaveBeenCalledExactlyOnceWith({
      kind: 'failure',
      error: expect.objectContaining({ code: GRAPHQL_REQUEST_TIMEOUT_CODE }),
    });
  });

  // A screen unmounting, or a superseded search. It proves nothing about the
  // server, and counting it would probe the backend every time someone scrolls
  // away from a list.
  it('reports nothing when the CALLER cancelled', async () => {
    mockAuthenticatedFetch.mockImplementation(() => new Promise<Response>(() => undefined));
    const callerController = new AbortController();
    const callerReason = new Error('screen unmounted');

    const request = graphqlFetchGated('https://api.example.com/graphql', { signal: callerController.signal });
    const rejection = expect(request).rejects.toBe(callerReason);
    callerController.abort(callerReason);
    await rejection;

    expect(connectivity.reportBackendOutcome).not.toHaveBeenCalled();
  });
});
