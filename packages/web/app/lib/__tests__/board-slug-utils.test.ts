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

  it('shares public anonymous lookups without sending an authorization header', async () => {
    fetchMock.mockResolvedValueOnce(graphQlResponse(publicBoard));

    await expect(resolveBoardBySlug(publicBoard.slug)).resolves.toEqual(publicBoard);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0];
    expect(new Headers(requestInit?.headers).get('Authorization')).toBeNull();
    expect(requestInit).toMatchObject({
      method: 'POST',
      next: { revalidate: 300 },
    });
    expect(requestInit).not.toHaveProperty('cache');
  });

  it('keeps an anonymously masked private lookup as not found', async () => {
    fetchMock.mockResolvedValueOnce(graphQlResponse(null));

    await expect(resolveBoardBySlug(privateBoard.slug)).resolves.toBeNull();

    const [, requestInit] = fetchMock.mock.calls[0];
    expect(new Headers(requestInit?.headers).get('Authorization')).toBeNull();
    expect(requestInit).toMatchObject({ next: { revalidate: 300 } });
  });

  it('forwards the session token for private boards and disables shared caching', async () => {
    getServerAuthTokenMock.mockResolvedValueOnce('signed-session-token');
    fetchMock.mockResolvedValueOnce(graphQlResponse(privateBoard));

    await expect(resolveBoardBySlug(privateBoard.slug)).resolves.toEqual(privateBoard);

    const [, requestInit] = fetchMock.mock.calls[0];
    expect(new Headers(requestInit?.headers).get('Authorization')).toBe('Bearer signed-session-token');
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
    expect(anonymousRequest).toMatchObject({ next: { revalidate: 300 } });
    expect(new Headers(anonymousRequest?.headers).get('Authorization')).toBeNull();
  });

  it('does not let an anonymous miss cross into a later authenticated request', async () => {
    getServerAuthTokenMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce('signed-session-token');
    fetchMock.mockResolvedValueOnce(graphQlResponse(null)).mockResolvedValueOnce(graphQlResponse(privateBoard));

    await expect(resolveBoardBySlug(privateBoard.slug)).resolves.toBeNull();
    await expect(resolveBoardBySlug(privateBoard.slug)).resolves.toEqual(privateBoard);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, anonymousRequest] = fetchMock.mock.calls[0];
    const [, authenticatedRequest] = fetchMock.mock.calls[1];
    expect(anonymousRequest).toMatchObject({ next: { revalidate: 300 } });
    expect(new Headers(anonymousRequest?.headers).get('Authorization')).toBeNull();
    expect(authenticatedRequest).toMatchObject({ cache: 'no-store' });
    expect(authenticatedRequest).not.toHaveProperty('next');
    expect(new Headers(authenticatedRequest?.headers).get('Authorization')).toBe('Bearer signed-session-token');
  });
});
