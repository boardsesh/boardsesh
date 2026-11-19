// @vitest-environment node
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('server-only', () => ({}));
const directory = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/app/gyms/directory-data', () => ({ fetchFacetTotal: directory.fetch }));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async (namespace: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
    locale: 'en-US',
  }),
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/app/components/marketing/store-install-buttons', () => ({
  default: ({ placement }: { placement: string }) => (
    <a href="https://apps.apple.com" data-placement={placement}>
      App Store
    </a>
  ),
}));
vi.mock('@/app/lib/store-button-labels.server', () => ({
  getStoreButtonLabels: async () => ({ ios: 'App Store', android: 'Google Play', update: 'Update' }),
}));
const { default: SupportedBoardsPage, generateMetadata } = await import('../page');

beforeEach(() => directory.fetch.mockReset().mockResolvedValue(12));

describe('supported boards public entry', () => {
  it('server-renders each catalog board with actual import choices and directory links', async () => {
    const html = renderToStaticMarkup(await SupportedBoardsPage());
    for (const brand of ['Kilter', 'Tension', 'MoonBoard', 'Decoy', 'Touchstone', 'Grasshopper', 'So iLL', 'Woods'])
      expect(html).toContain(brand);
    expect(html).toContain('MoonBoard CSV');
    expect(html).toContain('Aurora export file');
    expect(html).toContain('href="/gyms/kilter"');
    expect(html).toContain('href="/gyms/moonboard"');
    expect(html).toContain('href="/gyms?boardType=woods"');
    expect(html).toContain('href="/spraywalls"');
    expect(html).toContain('data-placement="board-compat"');
    expect(directory.fetch).toHaveBeenCalledTimes(8);
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it('keeps compatibility readable without publishing false zeroes during a directory outage', async () => {
    directory.fetch.mockResolvedValue(null);
    const html = renderToStaticMarkup(await SupportedBoardsPage());
    expect(html).toContain('href="/gyms/kilter"');
    expect(html).not.toContain(' · 0');
    expect(html).toContain('Light climbs from the iOS or Android app.');
  });

  it('declares canonical, social and translated alternate metadata for the new search surface', async () => {
    const metadata = await generateMetadata();
    expect(metadata.alternates?.canonical).toContain('/boards');
    expect(metadata.openGraph).toBeTruthy();
    expect(metadata.twitter).toBeTruthy();
    expect(metadata.alternates?.languages).toHaveProperty('es');
  });
});
