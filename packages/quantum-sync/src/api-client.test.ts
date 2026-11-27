import { describe, expect, it, vi } from 'vitest';
import { EwallsApiClient } from './api-client';

const scope = { board: 'QB_+ /', forcedType: 'big' };
const checkpoint = 'server+/ 空:%#';
const stableDelta = { initialSync: false, timestamp: 'verified', routes: { changed: [], deleted: [] } };
function page(routes: string[], totalCount: number, hasMore = false, pageNumber = 1) {
  return {
    initialSync: pageNumber === 1,
    page: pageNumber,
    timestamp: pageNumber === 1 ? checkpoint : `page-${pageNumber}-checkpoint`,
    routes: routes.map((id) => ({ id })),
    totalCount,
    hasMore,
  };
}
function setup(...responses: unknown[]) {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(responses.shift()));
  return { fetcher, client: new EwallsApiClient({ fetch: fetcher, token: 'secret-bearer' }) };
}
describe('eWalls client', () => {
  it('keeps the first page checkpoint and account collections across bootstrap pages', async () => {
    const { client, fetcher } = setup(
      { ...page(['one'], 2, true), favorites: [{ routeId: 'one' }], diodes: [{ id: 'd' }] },
      { ...page(['two'], 2, false, 2), favorites: 'ignored continuation payload', diodes: 'ignored' },
      { ...stableDelta, favorites: 'ignored verification payload', diodes: [{ id: 'later' }] },
      { ...stableDelta, timestamp: 'next' },
    );
    const batch = await client.bootstrap(scope);
    expect(batch).toMatchObject({
      kind: 'bootstrap',
      baseCheckpoint: null,
      scope,
      checkpoint,
      routes: { upsert: [{ id: 'one' }, { id: 'two' }] },
      account: { favorites: { upsert: [{ routeId: 'one' }] } },
      diodes: [{ id: 'd' }],
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [index, [target, options]] of fetcher.mock.calls.slice(0, 2).entries()) {
      const url = target as URL;
      expect(url.origin + url.pathname).toBe('https://e-walls.eu/api/v1/board/routes-delta');
      expect(Object.fromEntries(url.searchParams)).toEqual({ ...scope, page: String(index + 1), limit: '500' });
      expect(options?.redirect).toBe('error');
      expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer secret-bearer');
    }
    expect(Object.fromEntries((fetcher.mock.calls[2][0] as URL).searchParams)).toEqual({
      ...scope,
      lastFetch: checkpoint,
    });
    expect(await client.delta(scope, batch.checkpoint)).toMatchObject({
      baseCheckpoint: checkpoint,
      checkpoint: 'next',
    });
    expect(Object.fromEntries((fetcher.mock.calls[3][0] as URL).searchParams)).toEqual({
      ...scope,
      lastFetch: checkpoint,
    });
  });
  it('accepts continuations marked initial when they share the first page checkpoint', async () => {
    const { client } = setup(
      page(['one'], 2, true),
      { initialSync: true, timestamp: checkpoint, routes: [{ id: 'two' }], totalCount: 2, hasMore: false },
      stableDelta,
    );
    expect(await client.bootstrap(scope)).toMatchObject({
      checkpoint,
      routes: { upsert: [{ id: 'one' }, { id: 'two' }] },
    });
  });
  it('refuses bootstrap when same-count churn can hide an unchanged route between pages', async () => {
    const { client, fetcher } = setup(page(['a', 'b'], 4, true), page(['d', 'e'], 4, false, 2), {
      ...stableDelta,
      routes: { changed: [{ id: 'e' }], deleted: [{ id: 'a' }] },
    });
    await expect(client.bootstrap(scope)).rejects.toMatchObject({ code: 'unstable' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it.each([
    { changed: [{ id: 'one' }], deleted: [] },
    { changed: [], deleted: [{ id: 'one' }] },
  ])('refuses bootstrap when verification reports either kind of route change', async (routes) => {
    const { client } = setup(page(['one'], 1), { ...stableDelta, routes });
    await expect(client.bootstrap(scope)).rejects.toMatchObject({ code: 'unstable' });
  });
  it.each([
    { timestamp: 'verified' },
    { ...stableDelta, routes: [] },
    { ...stableDelta, routes: { changed: [] } },
    { ...stableDelta, routes: { deleted: [] } },
    { ...stableDelta, timestamp: '' },
  ])('requires explicit route stability evidence before returning bootstrap', async (verification) => {
    await expect(setup(page([], 0), verification).client.bootstrap(scope)).rejects.toMatchObject({ code: 'invalid' });
  });
  it.each([
    [page(['one'], 2, true), page(['one'], 2, false, 2)],
    [page(['one'], 2, true), page(['two'], 3, false, 2)],
    [page(['one'], 2, true), page(['two'], 2, false, 3)],
    [page(['one'], 2, true), { ...page(['two'], 2, false, 2), initialSync: true }],
    [page(['one'], 2, true), { ...page(['two'], 2, false, 2), timestamp: '' }],
    [page(['one'], 2, true), { ...page(['two'], 2, false, 2), routes: { changed: [{ id: 'two' }], deleted: [] } }],
    [page([], 1, true)],
    [page(['one'], 2)],
    [page(['one'], 1, true)],
    [{ ...page([], 0), initialSync: false }],
    [page([], 25001)],
  ])('rejects incomplete or inconsistent bootstrap', async (...pages) => {
    await expect(setup(...pages).client.bootstrap(scope)).rejects.toMatchObject({ code: 'invalid' });
  });
  it('bounds page count even when each page advances', async () => {
    const pages = Array.from({ length: 50 }, (_, index) => page([String(index)], 51, true, index + 1));
    const { client, fetcher } = setup(...pages);
    await expect(client.bootstrap(scope)).rejects.toMatchObject({ code: 'limit' });
    expect(fetcher).toHaveBeenCalledTimes(50);
  });
  it('keeps opaque checkpoints, tombstones and account data separate', async () => {
    const { client, fetcher } = setup({
      timestamp: 'next',
      routes: { changed: [{ id: 'a', lights: { unmapped: true } }], deleted: [{ id: 'b' }] },
      ascents: [{ id: 's', userId: 'another' }],
      projects: { deleted: [{ routeId: 'a' }] },
      diodes: [],
    });
    expect(await client.delta(scope, checkpoint)).toEqual({
      kind: 'delta',
      scope,
      baseCheckpoint: checkpoint,
      checkpoint: 'next',
      routes: { upsert: [{ id: 'a', lights: { unmapped: true } }], deleted: ['b'] },
      account: {
        ascents: { upsert: [{ id: 's', userId: 'another' }], deleted: [] },
        favorites: { upsert: [], deleted: [] },
        projects: { upsert: [], deleted: ['a'] },
      },
      diodes: null,
    });
    expect(Object.fromEntries((fetcher.mock.calls[0][0] as URL).searchParams)).toEqual({
      ...scope,
      lastFetch: checkpoint,
    });
  });
  it('ignores account payloads on both catalogue acquisition paths when configured', async () => {
    const { fetcher } = setup({ ...page(['route'], 1), ascents: 'private unparsed collection' }, stableDelta, {
      timestamp: 'next',
      routes: { changed: [{ id: 'route' }] },
      favorites: { nonsense: true },
    });
    const client = new EwallsApiClient({ fetch: fetcher, token: 'secret-bearer', includeAccountCollections: false });
    const empty = { upsert: [], deleted: [] };
    const unchanged = {
      routes: { upsert: [{ id: 'route' }], deleted: [] },
      account: { ascents: empty, favorites: empty, projects: empty },
    };
    expect(await client.bootstrap(scope)).toMatchObject(unchanged);
    expect(await client.delta(scope, checkpoint)).toMatchObject(unchanged);
  });
  it.each([
    page([], 0),
    { timestamp: 'n', routes: { deleted: ['id'] } },
    { timestamp: 'n', routes: { changed: [{ id: 'same' }], deleted: [{ id: 'same' }] } },
    { timestamp: 'n', hasMore: true },
  ])('rejects malformed or ambiguous delta', async (body) => {
    await expect(setup(body).client.delta(scope, 'base')).rejects.toMatchObject({ code: 'invalid' });
  });
  it('keeps the bearer out of serialized client diagnostics', () => {
    const { client } = setup();
    expect(JSON.stringify(client)).not.toContain('secret-bearer');
    expect(Object.values(client)).not.toContain('secret-bearer');
  });

  it('uses credentials only for their intended request', async () => {
    const { client, fetcher } = setup({ token: 'new', user: { id: 'external' } }, { id: 'external' });
    expect(await client.login('e', 'p')).toEqual({ token: 'new', user: { id: 'external' } });
    expect(fetcher.mock.calls[0][1]?.body).toBe(JSON.stringify({ email: 'e', password: 'p' }));
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
    expect(await client.currentUser()).toEqual({ id: 'external' });
  });
  it('redacts transport errors and distinguishes invalid credentials from expired bearer', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('secret-bearer'))
      .mockResolvedValueOnce(new Response('private detail', { status: 401 }))
      .mockResolvedValueOnce(new Response('private detail', { status: 401 }));
    const client = new EwallsApiClient({ fetch: fetcher, token: 'secret-bearer' });
    await expect(client.currentUser()).rejects.toThrow(/^eWalls API request failed \(transport\)$/);
    await expect(client.currentUser()).rejects.toMatchObject({ code: 'expired', status: 401 });
    await expect(client.login('u', 'p')).rejects.toMatchObject({ code: 'authentication', status: 401 });
  });
  it('stops on cancellation before fetch or during fetch', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(
      async (_url, options) =>
        new Promise((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () => reject(new Error('secret'))),
        ),
    );
    const client = new EwallsApiClient({ fetch: fetcher, token: 'token' });
    const pending = client.currentUser(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await expect(client.currentUser(controller.signal)).rejects.toMatchObject({ code: 'aborted' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('applies timeout and byte bounds including the entire series', async () => {
    const fetcher: typeof fetch = async (_url, options) =>
      new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('secret'))));
    await expect(new EwallsApiClient({ fetch: fetcher, token: 't', timeoutMs: 5 }).currentUser()).rejects.toMatchObject(
      { code: 'timeout' },
    );
    const pages = [page(['first'], 2, true), page(['second'], 2, false, 2)];
    const { fetcher: jsonFetch } = setup(...pages);
    await expect(
      new EwallsApiClient({
        fetch: jsonFetch,
        token: 't',
        maxTotalBytes: Buffer.byteLength(JSON.stringify(pages[0])) + 1,
      }).bootstrap(scope),
    ).rejects.toMatchObject({ code: 'limit' });
    await expect(
      new EwallsApiClient({ fetch: setup({ id: 'too big' }).fetcher, token: 't', maxResponseBytes: 2 }).currentUser(),
    ).rejects.toMatchObject({ code: 'limit' });
  });
  it('counts the bootstrap verification against the shared byte budget', async () => {
    const pages = [page(['first'], 2, true), page(['second'], 2, false, 2)];
    const pageBytes = pages.reduce((total, response) => total + Buffer.byteLength(JSON.stringify(response)), 0);
    const { fetcher } = setup(...pages, stableDelta);
    const client = new EwallsApiClient({ fetch: fetcher, token: 't', maxTotalBytes: pageBytes + 1 });
    await expect(client.bootstrap(scope)).rejects.toMatchObject({ code: 'limit' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('cancels bootstrap when the caller aborts during verification', async () => {
    const controller = new AbortController();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(page(['one'], 1)))
      .mockImplementationOnce(async () => {
        controller.abort();
        return Response.json(stableDelta);
      });
    const client = new EwallsApiClient({ fetch: fetcher, token: 't' });
    await expect(client.bootstrap(scope, controller.signal)).rejects.toMatchObject({ code: 'aborted' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
