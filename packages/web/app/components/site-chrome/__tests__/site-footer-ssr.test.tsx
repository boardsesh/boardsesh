import React from 'react';
import { describe, it, expect, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import SiteFooter from '../site-footer';

/**
 * The SEO verify for W-16.
 *
 * SiteFooter is the only thing left on www that puts internal links on *every*
 * indexable surface — the search drawer and user drawer that used to supply
 * discovery came out with the climbing UI, and `/about` and `/legal` never had
 * chrome links at all. The rule the reposition is trying to satisfy ("≥2–3
 * crawlable internal links with descriptive anchor text on every indexable
 * page") is only met if those anchors are in the *first server-rendered HTML*,
 * not painted in after hydration.
 *
 * So this renders the real component through `renderToString` and asserts the
 * markup. `next/link` is deliberately NOT mocked away into something that
 * always emits an `<a>`: `LocaleLink` is mocked to the same shape Next renders
 * it as, and the assertion is on the serialized HTML string rather than on a
 * jsdom tree, so a future change to a click-handler `<div>` fails here.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/about',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

/** Every static entry in `app/sitemap.ts`. */
const SITEMAP_PATHS = ['/', '/about', '/help', '/docs', '/playlists', '/aurora-migration', '/legal', '/privacy'];

/**
 * Every path the footer links to — a superset of `SITEMAP_PATHS`.
 *
 * The `/gyms*` routes are `noindex, follow` and out of the sitemap on purpose
 * until the duplicate-gym queue drains (#4372, #4381). A crawler still follows
 * them, but only if the anchors are in the first HTML — which is exactly what
 * this file exists to prove, so they belong here and not in `SITEMAP_PATHS`.
 */
const GYM_DIRECTORY_PATHS = ['/gyms', '/gyms/kilter', '/gyms/tension', '/gyms/moonboard'];
const FOOTER_PATHS = [...SITEMAP_PATHS, ...GYM_DIRECTORY_PATHS];

describe('SiteFooter server-rendered HTML', () => {
  it('ships every footer link as a real anchor in the first render', () => {
    const html = renderToString(<SiteFooter />);

    for (const path of FOOTER_PATHS) {
      expect(html, `first HTML must carry an anchor to ${path}`).toContain(`href="${path}"`);
    }
  });

  it('gives each anchor descriptive text, not a bare URL', () => {
    const html = renderToString(<SiteFooter />);

    // The mocked `t` echoes the key, so each link's text is its catalog key —
    // which is exactly what proves the label came from the catalog rather than
    // being an empty or icon-only anchor.
    for (const key of [
      'footer.links.home',
      'footer.links.about',
      'footer.links.help',
      'footer.links.docs',
      'footer.links.playlists',
      'footer.links.auroraMigration',
      'footer.links.legal',
      'footer.links.privacy',
      'footer.links.gyms',
      'footer.links.gymsKilter',
      'footer.links.gymsTension',
      'footer.links.gymsMoonboard',
    ]) {
      expect(html).toContain(key);
    }
  });

  it('renders inside a <footer> landmark', () => {
    expect(renderToString(<SiteFooter />)).toContain('<footer');
  });
});
