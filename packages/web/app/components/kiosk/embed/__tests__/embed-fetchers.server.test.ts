// @vitest-environment node

// Pins the transient-vs-null discrimination contract of the embed fetchers:
// transport failures, HTTP errors, GraphQL errors, and malformed payloads are
// { status: 'error' } (→ the page's self-healing retry screen), while ONLY a
// successful response resolving the entity (possibly to null) is
// { status: 'ok' } (→ the page's own isPublic gates decide notFound()).
// A regression that flips an error into an ok/null would silently 404
// working embeds; one that flips ok/null into error would mask the security
// gates behind the retry screen — both directions matter.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/graphql/client', () => ({
  getGraphQLHttpUrl: () => 'http://backend.test/graphql',
}));

import { SSR_BACKEND_FETCH_TIMEOUT_MS } from '@/app/lib/ssr-fetch-deadline';
import { fetchBoardForEmbed, fetchGymBoardsForEmbed, fetchGymForEmbed } from '../embed-fetchers';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// React's `cache()` memoizes per argument, so every test uses a fresh uuid to
// keep calls independent.
let uuidCounter = 0;
function nextUuid(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// An unbounded SSR fetch is what turns a stalled backend into a blank iframe:
// Node's fetch has no default timeout, so nothing else in this file's contract
// gets a chance to run. These pin that the deadline is actually attached to the
// request — not merely declared as a constant somewhere.
describe('every embed fetch carries the SSR deadline', () => {
  it('passes the AbortSignal built from SSR_BACKEND_FETCH_TIMEOUT_MS to fetch', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { board: null } }));

    await fetchBoardForEmbed(nextUuid());

    expect(timeoutSpy).toHaveBeenCalledWith(SSR_BACKEND_FETCH_TIMEOUT_MS);
    const [, requestInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(requestInit.signal).toBe(timeoutSpy.mock.results[0].value);
    expect(requestInit.signal?.aborted).toBe(false);
  });

  it('holds the deadline for the gym and gym-boards queries too', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { gym: null } }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { gymBoards: [] } }));

    await fetchGymForEmbed(nextUuid());
    await fetchGymBoardsForEmbed(nextUuid());

    expect(timeoutSpy.mock.calls).toEqual([[SSR_BACKEND_FETCH_TIMEOUT_MS], [SSR_BACKEND_FETCH_TIMEOUT_MS]]);
    for (const [, requestInit] of mockFetch.mock.calls as [string, RequestInit][]) {
      expect(requestInit.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('maps a fired deadline to error, so the widget paints the retry screen', async () => {
    mockFetch.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    expect(await fetchBoardForEmbed(nextUuid())).toEqual({ status: 'error' });
  });
});

describe('fetchBoardForEmbed — transient failures are errors, never ok/null', () => {
  it('maps a non-2xx HTTP response to error', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: null }, 500));
    expect(await fetchBoardForEmbed(nextUuid())).toEqual({ status: 'error' });
  });

  it('maps a thrown fetch (network down) to error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await fetchBoardForEmbed(nextUuid())).toEqual({ status: 'error' });
  });

  it('maps data: null to error', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: null }));
    expect(await fetchBoardForEmbed(nextUuid())).toEqual({ status: 'error' });
  });

  it('maps a missing data key to error', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    expect(await fetchBoardForEmbed(nextUuid())).toEqual({ status: 'error' });
  });

  it('maps a GraphQL errors array to error even when data is present', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { board: { uuid: 'x' } }, errors: [{ message: 'resolver blew up' }] }),
    );
    expect(await fetchBoardForEmbed(nextUuid())).toEqual({ status: 'error' });
  });

  it('maps a payload missing the queried field (picker → undefined) to error', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { somethingElse: 1 } }));
    expect(await fetchBoardForEmbed(nextUuid())).toEqual({ status: 'error' });
  });

  it('maps unparseable JSON to error', async () => {
    mockFetch.mockResolvedValueOnce(new Response('<html>gateway timeout</html>', { status: 200 }));
    expect(await fetchBoardForEmbed(nextUuid())).toEqual({ status: 'error' });
  });
});

describe('fetchBoardForEmbed — successful resolutions are ok', () => {
  it('a successful null board is ok/null (→ the page notFound()s, not the retry screen)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { board: null } }));
    expect(await fetchBoardForEmbed(nextUuid())).toEqual({ status: 'ok', entity: null });
  });

  it('a successful board is ok with the entity', async () => {
    const board = { uuid: 'board-1', name: 'Main Kilter', isPublic: true, boardId: 42 };
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { board } }));
    expect(await fetchBoardForEmbed(nextUuid())).toEqual({ status: 'ok', entity: board });
  });

  it('sends an ANONYMOUS request (no auth header) with the 5-minute shared cache', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { board: null } }));
    await fetchBoardForEmbed(nextUuid());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = mockFetch.mock.calls[0] as [string, RequestInit & { next?: unknown }];
    expect(requestUrl).toBe('http://backend.test/graphql');
    expect(requestInit.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(requestInit.next).toEqual({ revalidate: 300 });
  });
});

describe('fetchGymForEmbed / fetchGymBoardsForEmbed share the same contract', () => {
  it('gym: successful null is ok/null; failure is error', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { gym: null } }));
    expect(await fetchGymForEmbed(nextUuid())).toEqual({ status: 'ok', entity: null });

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: null, errors: [{ message: 'NOT_FOUND' }] }));
    expect(await fetchGymForEmbed(nextUuid())).toEqual({ status: 'error' });
  });

  it('gymBoards: a successful list is ok; a masked private gym (GraphQL error) is error', async () => {
    const boards = [{ uuid: 'board-1', name: 'Main Kilter' }];
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { gymBoards: boards } }));
    expect(await fetchGymBoardsForEmbed(nextUuid())).toEqual({ status: 'ok', entity: boards });

    // gymBoards masks private/missing gyms as a NOT_FOUND GraphQL error —
    // callers gate on the public gym first, so this maps to the retry screen.
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: null, errors: [{ message: 'Gym not found' }] }));
    expect(await fetchGymBoardsForEmbed(nextUuid())).toEqual({ status: 'error' });
  });
});
