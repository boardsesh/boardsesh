import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import type { GymDirectoryCard as GymDirectoryCardData } from '@boardsesh/graphql/operations';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { discoveryBoard } from '@/app/__test-helpers__/board-discovery-fixture';

vi.mock('server-only', () => ({}));

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const getServerTranslation = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/i18n/server', () => ({ getServerTranslation, loadServerResources: vi.fn() }));

const getPosthogDistinctId = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/feature-flags/server-distinct-id', () => ({ getPosthogDistinctId }));

const fetchDirectoryPage = vi.hoisted(() => vi.fn());
const fetchFacetCounts = vi.hoisted(() => vi.fn());
vi.mock('@/app/gyms/directory-data', () => ({ fetchDirectoryPage, fetchFacetCounts }));
const getBoardDiscovery = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/server-board-discovery', () => ({ getBoardDiscovery }));

vi.mock('@/app/lib/gym-funnel-analytics', () => ({
  trackGymFunnelEvent: vi.fn(),
  viewerStateFrom: (isAuthenticated: boolean) => (isAuthenticated ? 'signed-in' : 'signed-out'),
}));

/**
 * The three async/browser-only children, stubbed so the section itself can be
 * rendered to real DOM.
 *
 * React's client renderer cannot render an `async` component, so `I18nProvider`
 * and the directory's search form are replaced with the synchronous shape they
 * produce. The stubs keep the parts this suite asserts on — a real
 * `method="get"` form pointed at `/gyms` — and nothing else. Both are covered by
 * their own tests.
 */
vi.mock('@/app/components/providers/i18n-provider', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/app/gyms/gym-directory-search-form', () => ({
  default: ({ locale }: { locale: string }) => (
    <form method="get" action={locale === 'en-US' ? '/gyms' : `/${locale}/gyms`} role="search">
      <input type="search" name="q" aria-label="Search gyms" />
      <button type="submit">Search</button>
    </form>
  ),
}));

vi.mock('../home-gym-search-near-me', () => ({
  default: () => <button type="button">Use my location</button>,
}));

const HomeGymSearch = (await import('../home-gym-search')).default;

function gym(overrides: Partial<GymDirectoryCardData> = {}): GymDirectoryCardData {
  return {
    uuid: 'gym-1',
    slug: 'boulderwelt-muenchen-ost',
    name: 'Boulderwelt München Ost',
    address: 'Hansastraße 15, München',
    latitude: null,
    longitude: null,
    isClaimed: true,
    boardSummaries: [],
    ...overrides,
  };
}

async function renderSection() {
  render(await HomeGymSearch());
}

beforeEach(() => {
  getServerTranslation.mockReset().mockImplementation(async (namespace: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
    i18n: {},
    locale: 'en-US',
  }));
  getPosthogDistinctId.mockReset().mockResolvedValue(null);
  getBoardDiscovery.mockReset().mockResolvedValue([]);
  fetchDirectoryPage.mockReset().mockResolvedValue({
    ok: true,
    gyms: [
      gym(),
      gym({ uuid: 'gym-2', slug: 'granite-barn', name: 'Granite Barn Bouldering', address: null, isClaimed: false }),
    ],
    totalCount: 4740,
  });
  fetchFacetCounts.mockReset().mockResolvedValue({
    ok: true,
    counts: { all: 4740, kilter: 1786, moonboard: 2586, tension: 465 },
  });
});

describe('HomeGymSearch', () => {
  it('fetches bounded real-board previews for each gym without replacing its identity', async () => {
    getBoardDiscovery.mockImplementation(async ({ gymUuid }: { gymUuid: string }) =>
      gymUuid === 'gym-1' ? [discoveryBoard()] : [],
    );
    await renderSection();
    expect(getBoardDiscovery).toHaveBeenCalledWith({ gymUuid: 'gym-1', limit: 3 });
    expect(getBoardDiscovery).toHaveBeenCalledWith({ gymUuid: 'gym-2', limit: 3 });
    expect(screen.getByRole('link', { name: /Training room Kilter/ }).getAttribute('href')).toBe('/b/northside-kilter');
    expect(screen.getByRole('link', { name: 'Granite Barn Bouldering' })).toBeTruthy();
  });

  it('does not describe a successful empty catalogue as an outage', async () => {
    fetchDirectoryPage.mockResolvedValue({ ok: true, gyms: [], totalCount: 0 });
    await renderSection();
    expect(screen.queryByText(tFromCatalog('marketing', 'home.gymSearch.cardsUnavailable'))).toBeNull();
    expect(screen.getByRole('link', { name: /Browse the full gym directory/ })).toBeTruthy();
  });

  it('renders its heading and the directory link when gym data is available', async () => {
    await renderSection();

    expect(fetchDirectoryPage).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }), {
      prioritizeClaimed: true,
      limit: 4,
    });

    expect(screen.getByRole('heading', { level: 2, name: 'Find a board near you' })).toBeTruthy();
    const browseAll = screen.getByRole('link', { name: /Browse the full gym directory/ });
    expect(browseAll.getAttribute('href')).toBe('/gyms');
  });

  it('states the live catalogue size in the intro', async () => {
    await renderSection();

    expect(screen.getByText(/4,740 gyms, club walls and garages already have a board listed/)).toBeTruthy();
  });

  it('still renders the heading and the directory link when the gym fetch fails', async () => {
    // The homepage must never fail because the gym backend is down.
    fetchDirectoryPage.mockResolvedValue({ ok: false });
    fetchFacetCounts.mockResolvedValue({ ok: false });

    await renderSection();

    expect(screen.getByRole('heading', { level: 2, name: 'Find a board near you' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Browse the full gym directory/ }).getAttribute('href')).toBe('/gyms');
    expect(screen.getByText("The gym list isn't loading right now. The full directory is still there.")).toBeTruthy();
  });

  it('drops the count from the intro rather than printing a confident zero', async () => {
    fetchFacetCounts.mockResolvedValue({ ok: false });

    await renderSection();

    expect(screen.getByText(/^Gyms, club walls and garages with a board on the wall are already listed/)).toBeTruthy();
    expect(screen.queryByText(/0 gyms, club walls/)).toBeNull();
  });

  it('renders each gym card as a real anchor a crawler can follow', async () => {
    await renderSection();

    expect(screen.getByRole('link', { name: 'Boulderwelt München Ost' }).getAttribute('href')).toBe(
      '/gym/boulderwelt-muenchen-ost',
    );
    expect(screen.getByRole('link', { name: 'Granite Barn Bouldering' }).getAttribute('href')).toBe(
      '/gym/granite-barn',
    );
  });

  it('points the board-type chips at the literal facet routes, never a query string', async () => {
    await renderSection();

    expect(screen.getByRole('link', { name: /^Kilter ·/ }).getAttribute('href')).toBe('/gyms/kilter');
    expect(screen.getByRole('link', { name: /^MoonBoard ·/ }).getAttribute('href')).toBe('/gyms/moonboard');
    expect(screen.getByRole('link', { name: /^Tension ·/ }).getAttribute('href')).toBe('/gyms/tension');
  });

  it('hides the chips when the counts are unavailable instead of showing zeroes', async () => {
    fetchFacetCounts.mockResolvedValue({ ok: false });

    await renderSection();

    expect(screen.queryByRole('link', { name: /^Kilter ·/ })).toBeNull();
  });

  it('submits the search as a plain GET form to /gyms, so it works with no JavaScript', async () => {
    await renderSection();

    const form = screen.getByRole('search');
    expect(form.getAttribute('method')).toBe('get');
    expect(form.getAttribute('action')).toBe('/gyms');
  });

  it('asks the directory for one page and teases at most four gyms', async () => {
    fetchDirectoryPage.mockResolvedValue({
      ok: true,
      gyms: Array.from({ length: 24 }, (_unused, index) =>
        gym({ uuid: `gym-${index}`, slug: `gym-${index}`, name: `Gym ${index}` }),
      ),
      totalCount: 4740,
    });

    await renderSection();

    expect(fetchDirectoryPage).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });
});
