import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('server-only', () => ({}));

const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
);
vi.mock('next/navigation', () => ({ notFound }));

const getServerFeatureFlag = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/feature-flags/server-feature-flag', () => ({ getServerFeatureFlag }));

const getPosthogDistinctId = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/feature-flags/server-distinct-id', () => ({ getPosthogDistinctId }));

const fetchDirectoryPage = vi.hoisted(() => vi.fn());
const fetchFacetCounts = vi.hoisted(() => vi.fn());
vi.mock('../directory-data', () => ({ fetchDirectoryPage, fetchFacetCounts }));

const getServerTranslation = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/i18n/server', () => ({ getServerTranslation, loadServerResources: vi.fn() }));

vi.mock('@/app/lib/gym-funnel-analytics', () => ({
  trackGymFunnelEvent: vi.fn(),
  viewerStateFrom: (isAuthenticated: boolean) => (isAuthenticated ? 'signed-in' : 'signed-out'),
}));

const { renderGymDirectory } = await import('../directory-page');

const props = { searchParams: Promise.resolve({}) };

beforeEach(() => {
  notFound.mockClear();
  getServerFeatureFlag.mockReset();
  getPosthogDistinctId.mockReset().mockResolvedValue('user-uuid-1');
  fetchDirectoryPage.mockReset().mockResolvedValue({ gyms: [], totalCount: 0, hasMore: false });
  fetchFacetCounts.mockReset().mockResolvedValue({ all: 10, kilter: 4, moonboard: 5, tension: 1 });
  getServerTranslation.mockResolvedValue({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog('gyms', key, options),
    i18n: {},
    locale: 'en-US',
  });
});

describe('feature-flag gate', () => {
  it('404s the route when the flag is off, rather than only noindexing it', async () => {
    getServerFeatureFlag.mockResolvedValue(false);

    await expect(renderGymDirectory('all', props)).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledTimes(1);
    // The gate fires before any data is fetched.
    expect(fetchDirectoryPage).not.toHaveBeenCalled();
  });

  it('gates every facet route, not just /gyms', async () => {
    getServerFeatureFlag.mockResolvedValue(false);

    for (const facet of ['kilter', 'moonboard', 'tension'] as const) {
      await expect(renderGymDirectory(facet, { searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_NOT_FOUND');
    }
    expect(notFound).toHaveBeenCalledTimes(3);
  });

  it('asks PostHog about the authenticated person, not an anonymous id', async () => {
    getServerFeatureFlag.mockResolvedValue(true);

    await renderGymDirectory('kilter', props);

    // Person-property targeting only resolves when the evaluation names a
    // person PostHog holds those properties for. Anything else returns false
    // for a perfectly configured flag with nothing erroring anywhere.
    expect(getServerFeatureFlag).toHaveBeenCalledWith('gyms-directory', 'user-uuid-1');
  });

  it('passes a signed-out visitor through as having no person', async () => {
    getPosthogDistinctId.mockResolvedValue(null);
    getServerFeatureFlag.mockResolvedValue(false);

    await expect(renderGymDirectory('all', props)).rejects.toThrow('NEXT_NOT_FOUND');
    expect(getServerFeatureFlag).toHaveBeenCalledWith('gyms-directory', null);
  });

  it('renders once the flag is on', async () => {
    getServerFeatureFlag.mockResolvedValue(true);

    const element = await renderGymDirectory('all', props);

    expect(element).toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
    expect(fetchDirectoryPage).toHaveBeenCalledTimes(1);
    expect(fetchFacetCounts).toHaveBeenCalledTimes(1);
  });

  it('asks for one page of results per request, never a drain loop', async () => {
    getServerFeatureFlag.mockResolvedValue(true);

    await renderGymDirectory('all', { searchParams: Promise.resolve({ page: '3' }) });

    expect(fetchDirectoryPage).toHaveBeenCalledTimes(1);
    expect(fetchDirectoryPage).toHaveBeenCalledWith(expect.objectContaining({ page: 3 }));
  });
});
