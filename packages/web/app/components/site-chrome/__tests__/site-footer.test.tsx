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

describe('SiteFooter', () => {
  beforeEach(() => {
    mockPathname = '/';
  });

  it('links to every static page in the sitemap', () => {
    const { container } = render(<SiteFooter />);

    const hrefs = Array.from(container.querySelectorAll('a')).map((anchor) => anchor.getAttribute('href'));
    for (const path of SITEMAP_PATHS) {
      expect(hrefs, `footer must link to ${path}`).toContain(path);
    }
  });

  it('renders those links as real anchors inside a labelled nav', () => {
    const { container } = render(<SiteFooter />);

    const nav = container.querySelector('nav');
    expect(nav).toBeTruthy();
    expect(nav?.getAttribute('aria-label')).toBe(tFromCatalog('common', 'footer.navLabel'));
    expect(nav?.querySelectorAll('a').length).toBe(SITEMAP_PATHS.length);
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
