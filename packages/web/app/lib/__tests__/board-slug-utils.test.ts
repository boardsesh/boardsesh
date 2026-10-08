// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { fetchMock, getServerAuthTokenMock } = vi.hoisted(() => ({
  fetchMock: vi.fn<typeof fetch>(),
  getServerAuthTokenMock: vi.fn<() => Promise<string | undefined>>(),
}));

vi.mock('server-only', () => ({}));

vi.mock('react', () => ({
  // React cache is request-scoped in Server Components. Keep the unit under
  // test directly callable so separate invocations can model separate requests.
  cache: <CachedFunction extends (...args: never[]) => unknown>(fn: CachedFunction): CachedFunction => fn,
}));

vi.mock('@/app/lib/auth/server-auth', () => ({
  getServerAuthToken: getServerAuthTokenMock,
}));

vi.mock('@/app/lib/graphql/client', () => ({
  getGraphQLHttpUrl: () => 'http://backend.test/graphql',
}));

vi.stubGlobal('fetch', fetchMock);

import { resolveBoardBySlug, type ResolvedBoard } from '../board-slug-utils';
import { SSR_BACKEND_FETCH_TIMEOUT_MS } from '../ssr-fetch-deadline';

const publicBoard: ResolvedBoard = {
  uuid: '11111111-1111-4111-8111-111111111111',
  slug: 'community-wall',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  name: 'Community Wall',
  description: null,
  locationName: null,
  isPublic: true,
  isUnlisted: false,
  isOwned: true,
  ownerId: 'owner-1',
  angle: 40,
  isAngleAdjustable: true,
};

const privateBoard: ResolvedBoard = {
  ...publicBoard,
  uuid: '22222222-2222-4222-8222-222222222222',
  slug: 'home-project-wall',
  name: 'Home Project Wall',
  isPublic: false,
};

function graphQlResponse(board: ResolvedBoard | null): Response {
  return new Response(JSON.stringify({ data: { boardBySlug: board } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('resolveBoardBySlug', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    getServerAuthTokenMock.mockReset();
    getServerAuthTokenMock.mockResolvedValue(undefined);
  });

  it('reauthorizes public anonymous lookups without sending an authorization header', async () => {
    fetchMock.mockResolvedValueOnce(graphQlResponse(publicBoard));

    await expect(resolveBoardBySlug(publicBoard.slug)).resolves.toEqual(publicBoard);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0];
    expect(new Headers(requestInit?.headers).get('Authorization')).toBeNull();
    // SSR of /b/<slug> names www as the calling client.
    expect(new Headers(requestInit?.headers).get('x-boardsesh-client')).toBe('boardsesh-web/0.1.0 (server)');
    expect(requestInit).toMatchObject({
      method: 'POST',
      cache: 'no-store',
    });
    expect(requestInit).not.toHaveProperty('next');
  });

  it('keeps an anonymously masked private lookup as not found', async () => {
    fetchMock.mockResolvedValueOnce(graphQlResponse(null));

    await expect(resolveBoardBySlug(privateBoard.slug)).resolves.toBeNull();

    const [, requestInit] = fetchMock.mock.calls[0];
    expect(new Headers(requestInit?.headers).get('Authorization')).toBeNull();
    expect(requestInit).toMatchObject({ cache: 'no-store' });
  });

  it('forwards the session token for private boards and disables shared caching', async () => {
    getServerAuthTokenMock.mockResolvedValueOnce('signed-session-token');
    fetchMock.mockResolvedValueOnce(graphQlResponse(privateBoard));

    await expect(resolveBoardBySlug(privateBoard.slug)).resolves.toEqual(privateBoard);

    const [, requestInit] = fetchMock.mock.calls[0];
    expect(new Headers(requestInit?.headers).get('Authorization')).toBe('Bearer signed-session-token');
    expect(new Headers(requestInit?.headers).get('x-boardsesh-client')).toBe('boardsesh-web/0.1.0 (server)');
    expect(requestInit).toMatchObject({ cache: 'no-store' });
    expect(requestInit).not.toHaveProperty('next');
  });

  it('does not let a private authenticated result cross into a later anonymous request', async () => {
    getServerAuthTokenMock.mockResolvedValueOnce('signed-session-token').mockResolvedValueOnce(undefined);
    fetchMock.mockResolvedValueOnce(graphQlResponse(privateBoard)).mockResolvedValueOnce(graphQlResponse(null));

    await expect(resolveBoardBySlug(privateBoard.slug)).resolves.toEqual(privateBoard);
    await expect(resolveBoardBySlug(privateBoard.slug)).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, authenticatedRequest] = fetchMock.mock.calls[0];
    const [, anonymousRequest] = fetchMock.mock.calls[1];
    expect(authenticatedRequest).toMatchObject({ cache: 'no-store' });
    expect(anonymousRequest).toMatchObject({ cache: 'no-store' });
    expect(new Headers(anonymousRequest?.headers).get('Authorization')).toBeNull();
  });

  // A spray wall's share link carries `?wall=<uuid>`. The backend opens an
  // unlisted wall only when that uuid reaches it as `wallUuid`.
  it('sends the wall capability only when the request carried one', async () => {
    fetchMock.mockResolvedValueOnce(graphQlResponse(publicBoard)).mockResolvedValueOnce(graphQlResponse(publicBoard));

    await resolveBoardBySlug(publicBoard.slug);
    await resolveBoardBySlug(publicBoard.slug, privateBoard.uuid);

    const plainBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as { query: string; variables: object };
    const wallBody = JSON.parse(fetchMock.mock.calls[1][1]?.body as string) as { query: string; variables: object };
    expect(plainBody.variables).toEqual({ slug: publicBoard.slug });
    expect(plainBody.query).not.toContain('wallUuid');
    expect(wallBody.variables).toEqual({ slug: publicBoard.slug, wallUuid: privateBoard.uuid });
    expect(wallBody.query).toContain('boardBySlug(slug: $slug, wallUuid: $wallUuid)');
  });

  it('asks again without the capability when the backend predates it, instead of a 500', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ errors: [{ message: 'Unknown argument "wallUuid" on field "Query.boardBySlug".' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(graphQlResponse(publicBoard));

    await expect(resolveBoardBySlug(publicBoard.slug, privateBoard.uuid)).resolves.toEqual(publicBoard);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1]?.body as string) as { variables: object };
    expect(retryBody.variables).toEqual({ slug: publicBoard.slug });
  });

  it('still throws any other GraphQL error on a lookup that carried the capability', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ message: 'read deadline exceeded' }], data: { boardBySlug: null } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(resolveBoardBySlug(publicBoard.slug, privateBoard.uuid)).rejects.toThrow(/GraphQL errors/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Every caller turns `null` into `notFound()`, and Vercel CDN-caches a 404 for
  // the length of the front door's `s-maxage`. A failed read must never look
  // like "no such board".
  it('throws instead of returning null when the backend fetch rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('fetch failed'));

    await expect(resolveBoardBySlug(publicBoard.slug)).rejects.toThrow('fetch failed');
  });

  it('throws instead of returning null on a non-2xx backend response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad gateway', { status: 502 }));

    await expect(resolveBoardBySlug(publicBoard.slug)).rejects.toThrow(/HTTP 502/);
  });

  it('throws instead of returning null on a 200 carrying GraphQL errors', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ message: 'read deadline exceeded' }], data: { boardBySlug: null } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(resolveBoardBySlug(publicBoard.slug)).rejects.toThrow(/GraphQL errors/);
  });

  // "Every failure throws" only holds if failures happen. A backend that
  // accepts the socket and never answers is otherwise not a failure at all —
  // it is a `/b/{slug}` render that never finishes.
  it('bounds both the anonymous and the authenticated read with the SSR deadline', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    getServerAuthTokenMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce('signed-session-token');
    fetchMock.mockResolvedValueOnce(graphQlResponse(publicBoard)).mockResolvedValueOnce(graphQlResponse(privateBoard));

    await resolveBoardBySlug(publicBoard.slug);
    await resolveBoardBySlug(privateBoard.slug);

    expect(timeoutSpy.mock.calls).toEqual([[SSR_BACKEND_FETCH_TIMEOUT_MS], [SSR_BACKEND_FETCH_TIMEOUT_MS]]);
    const [, anonymousRequest] = fetchMock.mock.calls[0];
    const [, authenticatedRequest] = fetchMock.mock.calls[1];
    expect(anonymousRequest?.signal).toBe(timeoutSpy.mock.results[0].value);
    expect(authenticatedRequest?.signal).toBe(timeoutSpy.mock.results[1].value);
    timeoutSpy.mockRestore();
  });

  it('throws instead of returning null when the deadline fires', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    await expect(resolveBoardBySlug(publicBoard.slug)).rejects.toThrow(/aborted/);
  });

  it('does not let an anonymous miss cross into a later authenticated request', async () => {
    getServerAuthTokenMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce('signed-session-token');
    fetchMock.mockResolvedValueOnce(graphQlResponse(null)).mockResolvedValueOnce(graphQlResponse(privateBoard));

    await expect(resolveBoardBySlug(privateBoard.slug)).resolves.toBeNull();
    await expect(resolveBoardBySlug(privateBoard.slug)).resolves.toEqual(privateBoard);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, anonymousRequest] = fetchMock.mock.calls[0];
    const [, authenticatedRequest] = fetchMock.mock.calls[1];
    expect(anonymousRequest).toMatchObject({ cache: 'no-store' });
    expect(new Headers(anonymousRequest?.headers).get('Authorization')).toBeNull();
    expect(authenticatedRequest).toMatchObject({ cache: 'no-store' });
    expect(authenticatedRequest).not.toHaveProperty('next');
    expect(new Headers(authenticatedRequest?.headers).get('Authorization')).toBe('Bearer signed-session-token');
  });
});
