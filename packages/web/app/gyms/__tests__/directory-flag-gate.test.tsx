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
  fetchDirectoryPage.mockReset().mockResolvedValue({ ok: true, gyms: [], totalCount: 0 });
  fetchFacetCounts
    .mockReset()
    .mockResolvedValue({ ok: true, counts: { all: 10, kilter: 4, moonboard: 5, tension: 1 } });
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
    expect(getServerFeatureFlag).toHaveBeenCalledWith('gyms-directory', {
      distinctId: 'user-uuid-1',
      allowAnonymous: true,
    });
  });

  it('asks for a signed-out visitor too, instead of short-circuiting them to a 404', async () => {
    getPosthogDistinctId.mockResolvedValue(null);
    getServerFeatureFlag.mockResolvedValue(true);

    await renderGymDirectory('all', props);

    // `allowAnonymous` is what makes #4382's flag flip able to launch this
    // page. Without it the directory is signed-in-only however the PostHog
    // rollout is configured, and every crawler gets a 404.
    expect(getServerFeatureFlag).toHaveBeenCalledWith('gyms-directory', { distinctId: null, allowAnonymous: true });
  });

  it('still 404s a signed-out visitor when the flag says no', async () => {
    getPosthogDistinctId.mockResolvedValue(null);
    getServerFeatureFlag.mockResolvedValue(false);

    await expect(renderGymDirectory('all', props)).rejects.toThrow('NEXT_NOT_FOUND');
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
    fetchDirectoryPage.mockResolvedValue({ ok: true, gyms: [], totalCount: 500 });

    await renderGymDirectory('all', { searchParams: Promise.resolve({ page: '3' }) });

    expect(fetchDirectoryPage).toHaveBeenCalledTimes(1);
    expect(fetchDirectoryPage).toHaveBeenCalledWith(expect.objectContaining({ page: 3 }));
  });
});

describe('out-of-range pages', () => {
  beforeEach(() => {
    getServerFeatureFlag.mockResolvedValue(true);
  });

  it('404s a page past the real last page instead of serving an empty 200', async () => {
    // 30 gyms is two pages of 24. Page 3 is not a page.
    fetchDirectoryPage.mockResolvedValue({ ok: true, gyms: [], totalCount: 30 });

    await expect(renderGymDirectory('kilter', { searchParams: Promise.resolve({ page: '3' }) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
  });

  it('serves the real last page', async () => {
    fetchDirectoryPage.mockResolvedValue({ ok: true, gyms: [], totalCount: 30 });

    await expect(renderGymDirectory('kilter', { searchParams: Promise.resolve({ page: '2' }) })).resolves.toBeTruthy();
  });

  it('404s past the crawl-trap ceiling without spending a query', async () => {
    await expect(renderGymDirectory('all', { searchParams: Promise.resolve({ page: '9999' }) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    expect(fetchDirectoryPage).not.toHaveBeenCalled();
  });

  it('keeps page one of an empty result set as a 200 with the empty state', async () => {
    // "No gyms match that search" is an answer. "Page 40 of 2" is not a page.
    fetchDirectoryPage.mockResolvedValue({ ok: true, gyms: [], totalCount: 0 });

    await expect(renderGymDirectory('all', props)).resolves.toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });

  it('does not 404 every page just because the backend is down', async () => {
    // A failed fetch has no totalCount to compare against; treating it as zero
    // would 404 page 2 for the length of an incident.
    fetchDirectoryPage.mockResolvedValue({ ok: false });

    await expect(renderGymDirectory('all', { searchParams: Promise.resolve({ page: '2' }) })).resolves.toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });
});

describe('backend failure', () => {
  beforeEach(() => {
    getServerFeatureFlag.mockResolvedValue(true);
  });

  it('renders the error state rather than a confident "0 gyms" when the list fails', async () => {
    fetchDirectoryPage.mockResolvedValue({ ok: false });

    const element = await renderGymDirectory('all', props);
    const markup = JSON.stringify(element);

    expect(markup).toContain("We can't reach the gym list right now");
    // The count-bearing body copy is suppressed entirely — stating a false zero
    // with total confidence is worse than an error page.
    expect(markup).not.toContain('have a board listed on Boardsesh');
  });

  it('renders the error state when the facet counts fail', async () => {
    fetchFacetCounts.mockResolvedValue({ ok: false });

    const markup = JSON.stringify(await renderGymDirectory('all', props));
    expect(markup).toContain("We can't reach the gym list right now");
    expect(markup).not.toContain('have a board listed on Boardsesh');
  });

  it('keeps the h1 so the page still says what it is', async () => {
    fetchDirectoryPage.mockResolvedValue({ ok: false });

    const markup = JSON.stringify(await renderGymDirectory('kilter', props));
    expect(markup).toContain('Gyms with a Kilter board');
  });
});
