import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Locale } from '@/app/lib/i18n/config';
import { DocumentLocaleProvider } from '@/app/lib/i18n/document-locale-context';

vi.mock('server-only', () => ({}));

const fetchFacetCounts = vi.hoisted(() => vi.fn());
vi.mock('@/app/gyms/directory-data', () => ({ fetchFacetCounts }));
const getBoardDiscovery = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/server-board-discovery', () => ({ getBoardDiscovery }));

const HomeGymSearch = (await import('../home-gym-search')).default;

async function renderSection(locale: Locale = 'en-US') {
  render(<DocumentLocaleProvider locale={locale}>{await HomeGymSearch({ locale })}</DocumentLocaleProvider>);
}

beforeEach(() => {
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

    expect(screen.getByText(/4,740 gyms, club walls and home walls are listed in the board directory/)).toBeTruthy();
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

  it.each([
    ['en-US', 'Gym or town', 'Search for a gym or town', '/gyms'],
    ['de', 'Halle oder Ort', 'Halle oder Ort suchen', '/de/gyms'],
  ] as const)(
    'labels the field and submits the gym query by GET on the %s homepage',
    async (locale, label, submit, path) => {
      await renderSection(locale);

      const form = screen.getByRole<HTMLFormElement>('search');
      const input = screen.getByRole<HTMLInputElement>('textbox', { name: label });
      expect(input.labels?.[0]?.textContent).toBe(label);
      expect(input.labels?.[0]?.htmlFor).toBe(input.id);
      expect(input.form).toBe(form);
      expect(screen.getByRole<HTMLButtonElement>('button', { name: submit }).type).toBe('submit');
      fireEvent.change(input, { target: { value: 'Berlin' } });
      expect(new FormData(form).get('q')).toBe('Berlin');
      expect(form.method).toBe('get');
      expect(form.getAttribute('action')).toBe(path);
    },
  );
});
