// @vitest-environment node
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

/**
 * The strip is a server component, so what matters is the FIRST server render:
 * four columns in the HTML a crawler with no JavaScript receives. Rendering
 * through `renderToStaticMarkup` is that pass.
 *
 * The strip used to carry its own store CTA and this suite asserted it. The page
 * asked for the install three times over, so the mid-page pair went; the hero and
 * the footer still carry it. The crawlable-store-link guarantee now lives where it
 * belongs, at page level: `app/__tests__/home-page-content.test.tsx` pins the hero
 * buttons to each store URL, and `e2e/marketing-refresh.spec.ts` asserts the
 * rendered page carries an apps.apple.com AND a play.google.com anchor in `main`.
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

let mockLocale = 'en-US';
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({
    t: (key: string) => resolveMarketingKey(key),
    locale: mockLocale,
  })),
}));

vi.mock('@/app/components/marketing/marketing-screenshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/components/marketing/marketing-screenshot')>()),
  MarketingPreviewSwitch: () => <div data-testid="preview-switch" />,
}));

// `next/image` is a client component with its own loader; a plain <img> keeps
// the assertion about the src the strip emits.
vi.mock('next/image', () => ({
  default: ({ src, alt, width, height }: { src: string; alt: string; width: number; height: number }) => (
    <img src={src} alt={alt} width={width} height={height} />
  ),
}));

const { default: HomeFeatureStrip } = await import('../home-feature-strip');

async function renderStrip(): Promise<string> {
  return renderToStaticMarkup(await HomeFeatureStrip());
}

describe('HomeFeatureStrip', () => {
  afterEach(() => {
    mockLocale = 'en-US';
  });

  it('hosts the iOS/Android preview switch on the English page', async () => {
    expect(await renderStrip()).toContain('data-testid="preview-switch"');
  });

  it('leaves the preview switch in the hero for other locales', async () => {
    mockLocale = 'de';
    expect(await renderStrip()).not.toContain('data-testid="preview-switch"');
  });

  it('renders four columns, each with a heading and a line of copy', async () => {
    const html = await renderStrip();

    expect(html.match(/data-testid="home-feature-column"/g)).toHaveLength(4);
    expect(html.match(/<h3/g)).toHaveLength(4);
    expect(html).toContain(resolveMarketingKey('home.features.queue.title'));
    expect(html).toContain(resolveMarketingKey('home.features.wall.title'));
    expect(html).toContain(resolveMarketingKey('home.features.profile.title'));
    expect(html).toContain(resolveMarketingKey('home.features.profile.body'));
    expect(html).toContain(resolveMarketingKey('home.features.spray.title'));
    expect(html).toContain(resolveMarketingKey('home.features.spray.body'));
  });

  it('renders the section heading as the only h2', async () => {
    const html = await renderStrip();

    expect(html.match(/<h2/g)).toHaveLength(1);
    expect(html).toContain(resolveMarketingKey('home.features.title'));
    expect(html).toContain(resolveMarketingKey('home.features.lead'));
  });

  it('shows a real app capture for all four features', async () => {
    const html = await renderStrip();

    expect(html.match(/<img/g)).toHaveLength(4);
    expect(html).toContain('/images/app/android/queue.webp');
    expect(html).toContain('/images/app/android/wall-status.webp');
    expect(html).toContain('/images/app/android/profile-overview.webp');
    expect(html).toContain('/images/app/android/spray-wall.webp');
    // Both captures carry alt text from the catalog. The comparison is on a
    // fragment: React escapes the apostrophes in the full string, so matching
    // the raw catalog value would be a test of HTML escaping, not of alt text.
    expect(html).toContain(resolveMarketingKey('home.features.wall.shotAlt'));
    expect(html).toContain(resolveMarketingKey('home.features.profile.shotAlt'));
    expect(html).toContain(resolveMarketingKey('home.features.queue.shotAlt'));
    expect(html).toContain(resolveMarketingKey('home.features.spray.shotAlt'));
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
      featureMarkup.indexOf('/images/app/android/profile-overview.webp'),
    );
    expect(featureMarkup.indexOf(resolveMarketingKey('home.features.spray.title'))).toBeLessThan(
      featureMarkup.indexOf('/images/app/android/spray-wall.webp'),
    );
    // Spray wall is the closing card.
    expect(featureMarkup.indexOf('/images/app/android/profile-overview.webp')).toBeLessThan(
      featureMarkup.indexOf(resolveMarketingKey('home.features.spray.title')),
    );
  });
});
