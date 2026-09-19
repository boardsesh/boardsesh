import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { DirectoryQuery } from '../directory-facets';

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
