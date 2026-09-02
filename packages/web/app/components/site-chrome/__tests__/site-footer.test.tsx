// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import SiteFooter from '../site-footer';

/**
 * The footer carries two obligations the deleted chrome used to cover:
 *
 *  1. Crawlable internal links. The SEO rules want 2–3 descriptive internal
 *     links on every indexable page; the search drawer and user drawer that
 *     used to supply discovery are gone, so the footer supplies them on every
 *     surface at once — including `/about` and `/legal`, which had none.
 *  2. The locale switcher. `CompactLanguageSwitcher`'s only mount was
 *     `user-drawer.tsx`. Without this the site ships four indexed locales and
 *     no way to change language.
 */

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

let mockPathname = '/';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

/** Every static entry in `app/sitemap.ts`. */
const SITEMAP_PATHS = ['/', '/about', '/help', '/docs', '/playlists', '/aurora-migration', '/legal', '/privacy'];

/**
 * Every path the footer links to — a superset of `SITEMAP_PATHS`.
 *
 * The four `/gyms*` routes are deliberately NOT sitemap entries: the directory
 * is `noindex, follow` until the duplicate-gym queue drains (#4372, #4381), so
 * the footer anchors are its only crawl path. Keeping the two constants apart
 * is the point — folding `/gyms` into `SITEMAP_PATHS` would make that
 * constant's name a lie and quietly assert a sitemap entry that must not exist.
 */
const FOOTER_PATHS = [...SITEMAP_PATHS, '/gyms', '/gyms/kilter', '/gyms/tension', '/gyms/moonboard'];

describe('SiteFooter', () => {
  beforeEach(() => {
    mockPathname = '/';
  });

  // Pinned here because `e2e/site-chrome.spec.ts` selects on it and e2e is
  // workflow_dispatch-only — a rename would otherwise go unnoticed.
  it('carries the site-footer testid the e2e spec selects', () => {
    const { container } = render(<SiteFooter />);
    expect(container.querySelector('[data-testid="site-footer"]')).toBeTruthy();
  });

  it('links to every static page in the sitemap', () => {
    const { container } = render(<SiteFooter />);

    const hrefs = Array.from(container.querySelectorAll('a')).map((anchor) => anchor.getAttribute('href'));
    for (const path of SITEMAP_PATHS) {
      expect(hrefs, `footer must link to ${path}`).toContain(path);
    }
  });

  // The gym directory has no sitemap entry, so the footer is the crawl path
  // into it. Descriptive anchor text is the SEO half of that — "Gyms with a
  // Kilter board" is the query shape, "Gyms" is not.
  it('links to each board-type gym directory with descriptive anchor text', () => {
    const { container } = render(<SiteFooter />);

    const anchorsByHref = new Map(
      Array.from(container.querySelectorAll('a')).map((anchor) => [anchor.getAttribute('href'), anchor.textContent]),
    );

    expect(anchorsByHref.get('/gyms/kilter')).toBe('Gyms with a Kilter board');
    expect(anchorsByHref.get('/gyms/tension')).toBe('Gyms with a Tension board');
    expect(anchorsByHref.get('/gyms/moonboard')).toBe('Gyms with a MoonBoard');
    expect(anchorsByHref.get('/gyms')).toBe('All gyms and walls');
  });

  // The wireframe drew `/gyms?board=kilter`; the routes shipped literal. A
  // query-param href would point at a URL that self-canonicalises to `/gyms`,
  // throwing away the per-board landing page the anchor exists to feed.
  it('points at the literal facet routes, never the query-param form', () => {
    const { container } = render(<SiteFooter />);

    const hrefs = Array.from(container.querySelectorAll('a')).map((anchor) => anchor.getAttribute('href'));
    expect(hrefs.filter((href) => href?.includes('?'))).toEqual([]);
  });

  it('renders those links as real anchors inside a labelled nav', () => {
    const { container } = render(<SiteFooter />);

    const nav = container.querySelector('nav');
    expect(nav).toBeTruthy();
    expect(nav?.getAttribute('aria-label')).toBe(tFromCatalog('common', 'footer.navLabel'));
    expect(nav?.querySelectorAll('a').length).toBe(FOOTER_PATHS.length);
  });

  it('groups the links under headings so twelve of them stay scannable', () => {
    const { container } = render(<SiteFooter />);

    const headings = Array.from(container.querySelectorAll('nav h2')).map((heading) => heading.textContent);
    expect(headings).toEqual([
      tFromCatalog('common', 'footer.groups.findAGym'),
      tFromCatalog('common', 'footer.groups.explore'),
      tFromCatalog('common', 'footer.groups.smallPrint'),
    ]);
  });

  it('hands off to the app', () => {
    render(<SiteFooter />);

    expect(screen.getByLabelText('Start climbing in the app')).toBeTruthy();
  });

  it('hosts the locale switcher — the user drawer that used to was deleted', () => {
    render(<SiteFooter />);

    expect(screen.getByRole('button', { name: /language/i })).toBeTruthy();
  });

  it('carries the compatible-not-affiliated trademark line', () => {
    render(<SiteFooter />);

    expect(screen.getByText(tFromCatalog('common', 'footer.trademarkNote'))).toBeTruthy();
  });

  it('renders nothing on a kiosk route', () => {
    mockPathname = '/kiosk/some-gym/lobby';
    const { container } = render(<SiteFooter />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing on an embed route', () => {
    mockPathname = '/embed/gym/some-uuid/leaderboard';
    const { container } = render(<SiteFooter />);
    expect(container.firstChild).toBeNull();
  });
});
