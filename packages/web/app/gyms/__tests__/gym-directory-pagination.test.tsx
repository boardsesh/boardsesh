import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { DirectoryQuery } from '../directory-facets';
import { DirectoryPagination } from '@/app/components/directory/directory-pagination';

const getServerTranslation = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/i18n/server', () => ({ getServerTranslation, loadServerResources: vi.fn() }));

const GymDirectoryPagination = (await import('../gym-directory-pagination')).default;

const query: DirectoryQuery = {
  query: '',
  boardTypes: [],
  latitude: null,
  longitude: null,
  radiusKm: null,
  page: 2,
};

beforeEach(() => {
  getServerTranslation.mockResolvedValue({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog('gyms', key, options),
    i18n: {},
    locale: 'en-US',
  });
});

async function renderPager() {
  // Serialised rather than mounted: this is an async server component, and the
  // props are what carry the accessibility contract being asserted.
  return JSON.stringify(await GymDirectoryPagination({ facet: 'all', query, totalCount: 200 }));
}

describe('GymDirectoryPagination', () => {
  it('stops links at a directory crawl ceiling without changing the result count', () => {
    const markup = JSON.stringify(
      DirectoryPagination({
        currentPage: 40,
        totalCount: 2000,
        pageSize: 24,
        maxPages: 40,
        hrefForPage: (page) => `/spraywalls/find?page=${page}`,
        labels: {
          region: 'Spray-wall pages',
          previous: 'Previous',
          next: 'Next',
          page: (page) => `Page ${page}`,
          current: (page) => `Page ${page}, current page`,
        },
      }),
    );
    expect(markup).toContain('/spraywalls/find?page=39');
    expect(markup).not.toContain('/spraywalls/find?page=41');
    expect(markup).not.toContain('"rel":"next"');
  });

  it('supports another directory with its own URLs and accessible labels', () => {
    const markup = JSON.stringify(
      DirectoryPagination({
        currentPage: 2,
        totalCount: 70,
        pageSize: 24,
        hrefForPage: (page) => `/spraywalls/find?angle=40&page=${page}`,
        labels: {
          region: 'Spray-wall pages',
          previous: 'Previous',
          next: 'Next',
          page: (page) => `Page ${page}`,
          current: (page) => `Page ${page}, current page`,
        },
      }),
    );
    expect(markup).toContain('/spraywalls/find?angle=40&page=1');
    expect(markup).toContain('/spraywalls/find?angle=40&page=3');
    expect(markup).toContain('"aria-label":"Spray-wall pages"');
    expect(markup).toContain('"aria-current":"page"');
    expect(markup).not.toContain('/gyms');
  });

  it('shows the number and says the rest to a screen reader', async () => {
    const markup = await renderPager();

    // The current pill used to render "Page 2, current page" as visible text,
    // which wrapped the pager onto a second row. The sentence survives, hidden.
    expect(markup).toContain('"aria-current":"page"');
    expect(markup).toContain('Page 2, current page');
    expect(markup).toContain('"aria-hidden":"true"');
    // Every other pill keeps its full name too, as the link's accessible name.
    expect(markup).toContain('"aria-label":"Page 3"');
  });

  it('holds the 44px target the rest of the site holds', async () => {
    const markup = await renderPager();

    expect(markup).toContain('"minHeight":44');
    // A fixed `height` cannot grow for a longer label or a bigger text size.
    expect(markup).not.toContain('"height":40');
  });

  it('renders nothing at all when there is only one page', async () => {
    expect(await GymDirectoryPagination({ facet: 'all', query: { ...query, page: 1 }, totalCount: 4 })).toBeNull();
  });
});
