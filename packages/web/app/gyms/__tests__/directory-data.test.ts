import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { DirectoryQuery } from '../directory-facets';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/graphql/server-cached-client', () => ({ createCachedGraphQLQuery: () => request }));
import { fetchDirectoryPage } from '../directory-data';

const query: DirectoryQuery = { query: '', boardTypes: [], latitude: null, longitude: null, radiusKm: null, page: 1 };

beforeEach(() => {
  request.mockReset().mockResolvedValue({ searchGyms: { gyms: [], totalCount: 0 } });
});

describe('directory query isolation', () => {
  it('searches the selected city by coordinates without using its label as gym text', async () => {
    await fetchDirectoryPage({
      ...query,
      place: 'Sydney, New South Wales, Australia',
      latitude: -33.86785,
      longitude: 151.20732,
      radiusKm: 50,
    });
    expect(request).toHaveBeenCalledWith({
      input: { requireSlug: true, latitude: -33.86785, longitude: 151.20732, radiusKm: 50, limit: 24, offset: 0 },
    });
  });
  it('keeps the normal directory at 24 results without claimed priority', async () => {
    await fetchDirectoryPage({ ...query, page: 2 });
    expect(request).toHaveBeenCalledWith({ input: { requireSlug: true, limit: 24, offset: 24 } });
  });

  it('sends homepage ordering and size to the backend as distinct cache arguments', async () => {
    await fetchDirectoryPage(query, { prioritizeClaimed: true, limit: 4 });
    expect(request).toHaveBeenCalledWith({
      input: { requireSlug: true, prioritizeClaimed: true, limit: 4, offset: 0 },
    });
  });

  it('does not add the flag to ordinary proximity searches', async () => {
    await fetchDirectoryPage({ ...query, latitude: -33.86, longitude: 151.2, radiusKm: 25 });
    expect(request).toHaveBeenCalledWith({
      input: { requireSlug: true, latitude: -33.86, longitude: 151.2, radiusKm: 25, limit: 24, offset: 0 },
    });
  });
});
