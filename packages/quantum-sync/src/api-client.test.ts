import { describe, expect, it, vi } from 'vitest';
import { EwallsApiClient } from './api-client';

const scope = { board: 'QB_+ /', forcedType: 'big' };
const checkpoint = 'server+/ 空:%#';
function page(routes: string[], totalCount: number, hasMore = false) {
  return { initialSync: true, timestamp: checkpoint, routes: routes.map((id) => ({ id })), totalCount, hasMore };
}
function setup(...responses: unknown[]) {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(responses.shift()));
  return { fetcher, client: new EwallsApiClient({ fetch: fetcher, token: 'secret-bearer' }) };
}
describe('eWalls client', () => {
  it('publishes a complete multi-page bootstrap with the first-page account collections', async () => {
    const { client, fetcher } = setup(
      { ...page(['one'], 2, true), favorites: [{ routeId: 'one' }], diodes: [{ id: 'd' }] },
      page(['two'], 2),
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
    for (const [index, [target, options]] of fetcher.mock.calls.entries()) {
      const url = target as URL;
      expect(url.origin + url.pathname).toBe('https://e-walls.eu/api/v1/board/routes-delta');
      expect(Object.fromEntries(url.searchParams)).toEqual({ ...scope, page: String(index + 1), limit: '500' });
      expect(options?.redirect).toBe('error');
      expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer secret-bearer');
    }
  });
  it.each([
    [page(['one'], 2, true), page(['one'], 2)],
    [page(['one'], 2, true), page(['two'], 3)],
    [page(['one'], 2, true), { ...page(['two'], 2), timestamp: 'different' }],
    [page([], 1, true)],
    [page(['one'], 2)],
    [page(['one'], 1, true)],
    [{ ...page([], 0), initialSync: false }],
    [page([], 25001)],
  ])('rejects incomplete or inconsistent bootstrap', async (...pages) => {
    await expect(setup(...pages).client.bootstrap(scope)).rejects.toMatchObject({ code: 'invalid' });
  });
  it('bounds page count even when each page advances', async () => {
    const pages = Array.from({ length: 50 }, (_, index) => page([String(index)], 51, true));
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
    const pages = [page(['first'], 2, true), page(['second'], 2)];
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
});
