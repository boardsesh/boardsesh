import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('server-only', () => ({}));
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

async function renderPage() {
  const html = renderToStaticMarkup(await SupportedBoardsPage());
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
    expect(document.querySelector('#kilter figcaption')?.textContent).toBe('Original');
    expect([...document.querySelectorAll('#tension figcaption')].map((caption) => caption.textContent)).toEqual([
      'Board 2 Mirror',
      'Board 2 Spray',
      'Original',
    ]);
  });

  it('keeps crawlable useful actions and one global logbook link', async () => {
    const document = await renderPage();
    for (const href of ['/gyms/kilter', '/gyms/tension', '/gyms/moonboard', '/gyms?boardType=woods', '/spraywalls']) {
      expect(document.querySelector(`a[href="${href}"]`)).not.toBeNull();
    }
    expect(document.querySelector('[data-placement="board-compat"]')).not.toBeNull();
    expect(document.querySelectorAll('a[href="/bring-your-logbook"]')).toHaveLength(1);
  });

  it('declares canonical, social and all six translated alternate metadata', async () => {
    const metadata = await generateMetadata();
    expect(metadata.alternates?.canonical).toContain('/boards');
    expect(metadata.openGraph).toBeTruthy();
    expect(metadata.twitter).toBeTruthy();
    for (const locale of ['en-US', 'es', 'fr', 'de', 'it', 'zh-CN']) {
      expect(metadata.alternates?.languages).toHaveProperty(locale);
    }
  });
});
