import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { resolveServerTree } from '@/app/lib/__tests__/helpers/resolve-server-tree';
import { getBoardImageDetailsForBoard } from '@/app/lib/board-image-details';
import { resolveStaticAssetUrl } from '@/app/lib/static-asset-url';
import { buildCanonicalClimbListUrl } from '@/app/lib/url-utils';
import { parseBoardRouteParamsWithSlugs } from '@/app/lib/url-utils.server';
import manifest from '../board-gallery-manifest.json';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/db/db', () => ({
  dbz: {
    select: () => {
      throw new Error('Gallery climb links must resolve through the static catalog');
    },
  },
}));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async (namespace: string | readonly string[]) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
    locale: 'en-US',
  }),
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children, 'aria-label': ariaLabel }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} aria-label={ariaLabel}>
      {children}
    </a>
  ),
}));
vi.mock('@/app/components/marketing/store-install-buttons', () => ({
  default: ({ placement }: { placement: string }) => (
    <a href="https://apps.apple.com" data-placement={placement}>
      App Store
    </a>
  ),
}));
vi.mock('@/app/lib/store-button-labels.server', () => ({
  getStoreButtonLabels: async () => ({ ios: 'App Store', android: 'Google Play', update: 'Update', locale: 'en-US' }),
}));
const { default: SupportedBoardsPage, generateMetadata } = await import('@/app/(site)/boards/page');

async function renderPage() {
  const html = renderToStaticMarkup(await resolveServerTree(<SupportedBoardsPage />));
  const renderedDocument = document.implementation.createHTMLDocument();
  renderedDocument.body.innerHTML = html;
  return renderedDocument;
}

describe('supported boards public entry', () => {
  it('server-renders all 17 real layouts and a spray photo with intrinsic dimensions', async () => {
    const document = await renderPage();
    expect(document.querySelector('h1')?.textContent).toBe('Your board, on Boardsesh');
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(document.querySelectorAll('li[data-board]')).toHaveLength(9);
    const images = document.querySelectorAll('li[data-board] img');
    expect(images).toHaveLength(18);
    for (const image of images) {
      expect(image.getAttribute('src')).toMatch(/\.webp$/);
      expect(Number(image.getAttribute('width'))).toBeGreaterThan(0);
      expect(Number(image.getAttribute('height'))).toBeGreaterThan(0);
      expect(image.getAttribute('alt')?.length).toBeGreaterThan(0);
    }
    expect(document.querySelectorAll('ul[role="list"]')).toHaveLength(9);
    expect(document.querySelectorAll('ul[tabindex="0"]')).toHaveLength(3);
  });

  it('server-renders a crawlable link to the canonical list for every pictured layout', async () => {
    const document = await renderPage();
    expect([...document.querySelectorAll('#kilter figcaption a')].map((link) => link.textContent)).toEqual([
      'Browse Original climbs',
      'Browse Homewall climbs',
    ]);
    expect(document.querySelector('#moonboard figcaption a')?.textContent).toBe('Browse Mini 2025 climbs');
    expect(document.querySelector('#spray figcaption a')).toBeNull();
    expect(document.querySelectorAll('figcaption a[href$="/list"]')).toHaveLength(manifest.layouts.length);

    for (const image of manifest.layouts) {
      const figure = document.querySelector(`img[src="${resolveStaticAssetUrl(image.src)}"]`)?.closest('figure');
      const href = figure?.querySelector('figcaption a')?.getAttribute('href');
      expect(href, image.layoutName).toBeTruthy();
      if (!href) throw new Error(`Missing climb list for ${image.layoutName}`);
      const [, boardName, layoutSlug, sizeSlug, setSlug, angle, surface] = href.split('/');
      expect(surface).toBe('list');
      const parsed = await parseBoardRouteParamsWithSlugs({
        board_name: boardName,
        layout_id: layoutSlug,
        size_id: sizeSlug,
        set_ids: setSlug,
        angle,
      });
      expect(parsed).toMatchObject({
        board_name: image.boardName,
        layout_id: image.layoutId,
        size_id: image.sizeId,
        angle: 40,
      });
      expect(parsed.set_ids).toHaveLength(image.setIds.length);
      expect(parsed.set_ids).toEqual(expect.arrayContaining(image.setIds));
      expect(buildCanonicalClimbListUrl(getBoardImageDetailsForBoard(parsed), parsed.angle)).toBe(href);
    }
  });

  it('names each board once in image descriptions while retaining layout generations', async () => {
    const document = await renderPage();
    expect(document.querySelector('#kilter img')?.getAttribute('alt')).toBe('Original on Kilter');
    expect(document.querySelector('#tension img')?.getAttribute('alt')).toBe('Board 2 Mirror on Tension');
    expect(document.querySelector('#moonboard img')?.getAttribute('alt')).toBe('Mini 2025 on MoonBoard');
  });

  it('gives the three Original layouts distinct accessible link names', async () => {
    const document = await renderPage();
    const links = [...document.querySelectorAll('figcaption a')].filter(
      (link) => link.textContent === 'Browse Original climbs',
    );
    expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([
      'Browse Original climbs on Kilter',
      'Browse Original climbs on Tension',
      'Browse Original climbs on Woods',
    ]);
  });

  it('keeps crawlable useful actions and one global logbook link', async () => {
    const document = await renderPage();
    for (const href of [
      '/gyms/kilter',
      '/gyms/tension',
      '/gyms/moonboard',
      '/gyms?boardType=woods',
      '/spraywalls',
      '/spraywalls/find',
    ]) {
      expect(document.querySelector(`a[href="${href}"]`)).not.toBeNull();
    }
    expect(document.querySelector('#spray figcaption')?.textContent).toBe('Bring your own spray wall');
    expect([...document.querySelectorAll('#spray a')].map((link) => link.textContent)).toEqual([
      'Compare spray wall apps',
      'Find a spray wall',
      'Set up your spray wall',
    ]);
    expect(document.querySelector('[data-placement="board-compat"]')).not.toBeNull();
    expect(document.querySelectorAll('a[href="/bring-your-logbook"]')).toHaveLength(1);
  });

  it('server-renders a crawlable guide link that names the comparison for every board and spray wall', async () => {
    const document = await renderPage();
    const guidePaths = {
      kilter: '/apps/kilter',
      tension: '/apps/aurora#tension',
      moonboard: '/apps/moonboard',
      decoy: '/apps/aurora#decoy',
      touchstone: '/apps/aurora#touchstone',
      grasshopper: '/apps/aurora#grasshopper',
      soill: '/apps/aurora#so-ill',
      woods: '/apps/woods',
      spray: '/compare/spray-wall-apps',
    };
    for (const [board, href] of Object.entries(guidePaths)) {
      // English pages say what the page compares; "(English)" is only for the localized pages.
      expect(document.querySelector(`#${board} a[href="${href}"]`)?.textContent).toMatch(/^Compare .+ apps$/);
    }
  });

  it('declares canonical, social and all six translated alternate metadata', async () => {
    const metadata = await generateMetadata();
    expect(metadata.title).toEqual({ absolute: 'Supported boards | Boardsesh' });
    expect(metadata.openGraph).toMatchObject({ title: 'Supported boards | Boardsesh' });
    expect(metadata.twitter).toMatchObject({ title: 'Supported boards | Boardsesh' });
    expect(metadata.alternates?.canonical).toContain('/boards');
    expect(metadata.openGraph).toBeTruthy();
    expect(metadata.twitter).toBeTruthy();
    for (const locale of ['en-US', 'es', 'fr', 'de', 'it', 'zh-CN']) {
      expect(metadata.alternates?.languages).toHaveProperty(locale);
    }
  });
});
