import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { requestSprayDirectory } from '../directory-request';

vi.mock('@/app/lib/backend-url', () => ({ getGraphQLHttpUrl: () => 'https://backend.example/graphql' }));
afterEach(() => vi.unstubAllGlobals());

describe('anonymous spray directory transport', () => {
  it('omits credentials and caching, and fixes the board type on every request', async () => {
    const fetchRequest = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { searchBoards: { boards: [], totalCount: 0, hasMore: false } } }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchRequest);
    await expect(requestSprayDirectory({ boardType: 'kilter', angles: [40], limit: 24 })).resolves.toEqual({
      boards: [],
      totalCount: 0,
      hasMore: false,
    });
    const [url, options] = fetchRequest.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe('https://backend.example/graphql');
    expect(options).toMatchObject({ credentials: 'omit', cache: 'no-store' });
    expect(new Headers(options.headers).has('authorization')).toBe(false);
    if (typeof options.body !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(options.body).variables.input).toEqual({ boardType: 'spray', angles: [40], limit: 24 });
    expect(JSON.parse(options.body).query).toContain('searchBoards: publicSprayWalls');
    expect(options.signal).toBeDefined();
  });
});
