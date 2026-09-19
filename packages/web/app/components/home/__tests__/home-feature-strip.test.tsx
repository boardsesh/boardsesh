// @vitest-environment node
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

/**
 * The strip is a server component, so what matters is the FIRST server render:
 * three columns and a crawlable store link in the HTML a crawler with no
 * JavaScript receives. Rendering through `renderToStaticMarkup` is that pass.
 *
 * Copy resolves from the real en-US catalog rather than echoing keys back —
 * a missing key would otherwise render as its own dotted path and still pass.
 */

function resolveMarketingKey(dottedKey: string): string {
  return tFromCatalog('marketing', dottedKey);
}

vi.mock('server-only', () => ({}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => resolveMarketingKey(key), i18n: { language: 'en-US' } }),
}));
vi.mock('@/app/hooks/use-install-platform', () => ({
  useInstallPlatform: () => ({ platform: 'desktop-web', nativeStore: 'ios' }),
}));
vi.mock('@/app/lib/static-asset-url', () => ({ resolveStaticAssetUrl: (path: string) => path }));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({
    t: (key: string) => resolveMarketingKey(key),
    locale: 'en-US',
  })),
}));

// `next/image` is a client component with its own loader; a plain <img> keeps
// the assertion about the src the strip emits.
vi.mock('next/image', () => ({
  default: ({ src, alt, width, height }: { src: string; alt: string; width: number; height: number }) => (
    <img src={src} alt={alt} width={width} height={height} />
  ),
}));

const { default: HomeFeatureStrip } = await import('../home-feature-strip');
const { IOS_APP_STORE_URL, ANDROID_PLAY_STORE_URL } = await import('@/app/lib/store-urls');

async function renderStrip(): Promise<string> {
  return renderToStaticMarkup(await HomeFeatureStrip());
}

describe('HomeFeatureStrip', () => {
  it('renders three columns, each with a heading and a line of copy', async () => {
    const html = await renderStrip();

    expect(html.match(/data-testid="home-feature-column"/g)).toHaveLength(3);
    expect(html.match(/<h3/g)).toHaveLength(3);
    expect(html).toContain(resolveMarketingKey('home.features.queue.title'));
    expect(html).toContain(resolveMarketingKey('home.features.wall.title'));
    expect(html).toContain(resolveMarketingKey('home.features.profile.title'));
    expect(html).toContain(resolveMarketingKey('home.features.profile.body'));
  });

  it('renders the section heading as the only h2', async () => {
    const html = await renderStrip();

    expect(html.match(/<h2/g)).toHaveLength(1);
    expect(html).toContain(resolveMarketingKey('home.features.title'));
    expect(html).toContain(resolveMarketingKey('home.features.lead'));
  });

  it('carries the app CTA as a real anchor to each store', async () => {
    const html = await renderStrip();

    expect(html).toContain(`href="${IOS_APP_STORE_URL}"`);
    expect(html).toContain(`href="${ANDROID_PLAY_STORE_URL}"`);
    expect(html).toContain(resolveMarketingKey('home.hero.ctaInstallIos'));
    expect(html).toContain(resolveMarketingKey('home.hero.ctaInstallAndroid'));
  });

  it('shows a real app capture for all three features', async () => {
    const html = await renderStrip();

    expect(html.match(/<img/g)).toHaveLength(3);
    expect(html).toContain('/images/app/android/queue.webp');
    expect(html).toContain('/images/app/android/wall-status.webp');
    expect(html).toContain('/images/app/android/profile.webp');
    // Both captures carry alt text from the catalog. The comparison is on a
    // fragment: React escapes the apostrophes in the full string, so matching
    // the raw catalog value would be a test of HTML escaping, not of alt text.
    expect(html).toContain(resolveMarketingKey('home.features.wall.shotAlt'));
    expect(html).toContain(resolveMarketingKey('home.features.profile.shotAlt'));
    expect(html).toContain(resolveMarketingKey('home.features.queue.shotAlt'));
  });

  it('presents the benefit before each corresponding screenshot', async () => {
    const html = await renderStrip();
    // React can emit image preload hints before the section itself.
    const featureMarkup = html.slice(html.indexOf('data-testid="home-feature-column"'));

    expect(featureMarkup.indexOf(resolveMarketingKey('home.features.queue.title'))).toBeLessThan(
      featureMarkup.indexOf('/images/app/android/queue.webp'),
    );
    expect(featureMarkup.indexOf(resolveMarketingKey('home.features.wall.title'))).toBeLessThan(
      featureMarkup.indexOf('/images/app/android/wall-status.webp'),
    );
    expect(featureMarkup.indexOf(resolveMarketingKey('home.features.profile.title'))).toBeLessThan(
      featureMarkup.indexOf('/images/app/android/profile.webp'),
    );
  });
});
