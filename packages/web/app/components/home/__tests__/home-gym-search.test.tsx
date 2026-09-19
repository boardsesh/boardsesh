import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

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

const fetchFacetCounts = vi.hoisted(() => vi.fn());
vi.mock('@/app/gyms/directory-data', () => ({ fetchFacetCounts }));
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

async function renderSection() {
  render(await HomeGymSearch());
}

beforeEach(() => {
  getServerTranslation.mockReset().mockImplementation(async (namespace: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
    i18n: {},
    locale: 'en-US',
  }));
  getBoardDiscovery.mockReset().mockResolvedValue([]);
  fetchFacetCounts.mockReset().mockResolvedValue({
    ok: true,
    counts: { all: 4740, kilter: 1786, moonboard: 2586, tension: 465 },
  });
});

describe('HomeGymSearch', () => {
  // The block sells the directory; it does not preview it. It used to render four
  // gym cards — a second copy of the directory's own row on a page that already
  // links there twice — and they came out with the marketing trim. `/gyms` is now
  // the only place gym rows render, so nothing here may fetch a page of them.
  it('renders no gym rows and asks no gym-discovery backend for any', async () => {
    await renderSection();

    expect(getBoardDiscovery).not.toHaveBeenCalled();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.queryByTestId('gym-board-previews')).toBeNull();
    expect(screen.queryAllByRole('link').map((link) => link.getAttribute('href'))).not.toContain(
      '/gym/boulderwelt-muenchen-ost',
    );
  });

  it('renders its heading and the directory link', async () => {
    await renderSection();

    expect(screen.getByRole('heading', { level: 2, name: 'Find a board near you' })).toBeTruthy();
    const browseAll = screen.getByRole('link', { name: /Browse the full gym directory/ });
    expect(browseAll.getAttribute('href')).toBe('/gyms');
  });

  it('states the live catalogue size in the intro', async () => {
    await renderSection();

    expect(screen.getByText(/4,740 gyms, club walls and garages already have a board listed/)).toBeTruthy();
  });

  it('still renders the heading and the directory link when the counts fail', async () => {
    // The homepage must never fail because the gym backend is down. With the cards
    // gone, a dead backend costs the counts and the chips and nothing else — there
    // is no longer an outage message here, because there is no longer a list to
    // apologise for.
    fetchFacetCounts.mockResolvedValue({ ok: false });

    await renderSection();

    expect(screen.getByRole('heading', { level: 2, name: 'Find a board near you' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Browse the full gym directory/ }).getAttribute('href')).toBe('/gyms');
  });

  it('drops the count from the intro rather than printing a confident zero', async () => {
    fetchFacetCounts.mockResolvedValue({ ok: false });

    await renderSection();

    expect(screen.getByText(/^Gyms, club walls and garages with a board on the wall are already listed/)).toBeTruthy();
    expect(screen.queryByText(/0 gyms, club walls/)).toBeNull();
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
});
