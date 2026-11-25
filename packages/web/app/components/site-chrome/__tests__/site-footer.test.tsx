// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { trackWebsiteJourneyLinkClick } from '@/app/lib/website-journey-analytics';

import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import SiteFooter from '../site-footer';
import { MarketingCapabilitiesContext } from '../../marketing/marketing-capabilities-context';

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
const SITEMAP_PATHS = [
  '/',
  '/about',
  '/support',
  '/help',
  '/developers',
  '/boards',
  '/spraywalls',
  '/for-gyms#partners',
  '/playlists',
  '/bring-your-logbook',
  '/legal',
  '/privacy',
];

/**
 * Every path the footer links to — a superset of `SITEMAP_PATHS`.
 *
 * The four `/gyms*` routes are deliberately NOT sitemap entries: the directory
 * is `noindex, follow` until the duplicate-gym queue drains (#4372, #4381), so
 * the footer anchors are its only crawl path. Keeping the two constants apart
 * is the point — folding `/gyms` into `SITEMAP_PATHS` would make that
 * constant's name a lie and quietly assert a sitemap entry that must not exist.
 */
const FOOTER_PATHS = [...SITEMAP_PATHS.filter((path) => path !== '/'), '/gyms', '/gyms?claim=1'];

vi.mock('@/app/lib/website-journey-analytics', () => ({
  trackWebsiteJourneyEvent: vi.fn(),
  trackWebsiteJourneyLinkClick: vi.fn(),
}));

describe('SiteFooter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/';
  });

  it('reconciles the static marketing docs fallback with runtime public availability', () => {
    const view = render(<SiteFooter developerHref="/docs" />);
    expect(view.container.querySelector('a[href="/docs"]')).toBeTruthy();
    view.rerender(
      <MarketingCapabilitiesContext.Provider
        value={{ enableExpoAuthBridge: true, developerHref: '/developers', hasMonthlySupport: false }}
      >
        <SiteFooter developerHref="/docs" />
      </MarketingCapabilitiesContext.Provider>,
    );
    expect(view.container.querySelector('a[href="/developers"]')).toBeTruthy();
    expect(view.container.querySelector('a[href="/docs"]')).toBeNull();
  });

  // Pinned here because `e2e/site-chrome.spec.ts` selects on it and e2e is
  // workflow_dispatch-only — a rename would otherwise go unnoticed.
  it('carries the site-footer testid the e2e spec selects', () => {
    const { container } = render(<SiteFooter />);
    expect(container.querySelector('[data-testid="site-footer"]')).toBeTruthy();
  });

  it('closes the page with the same genuine mark and wordmark linked home', () => {
    render(<SiteFooter />);
    const brandLink = screen.getByLabelText('Boardsesh home');
    expect(brandLink.getAttribute('href')).toBe('/');
    expect(brandLink.textContent).toBe('Boardsesh');
    expect(brandLink.querySelector('img')?.getAttribute('src')).toContain('boardsesh-mark');
    expect(brandLink.querySelector('img')?.getAttribute('alt')).toBe('');
    fireEvent.click(brandLink);
    expect(trackWebsiteJourneyLinkClick).toHaveBeenCalledWith(expect.anything(), {
      name: 'Nav Link Clicked',
      properties: { area: 'footer', target: '/' },
    });
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
  it('gives wall owners direct spray, claim and partner paths', () => {
    const { container } = render(<SiteFooter />);
    for (const href of ['/boards', '/spraywalls', '/gyms?claim=1', '/for-gyms#partners', '/developers']) {
      expect(container.querySelector(`nav a[href="${href}"]`)).toBeTruthy();
    }
  });

  it('renders those links as real anchors inside a labelled nav', () => {
    const { container } = render(<SiteFooter />);

    const nav = container.querySelector('nav');
    expect(nav).toBeTruthy();
    expect(nav?.getAttribute('aria-label')).toBe(tFromCatalog('common', 'footer.navLabel'));
    for (const path of FOOTER_PATHS) expect(nav?.querySelector(`a[href="${path}"]`)).toBeTruthy();
  });

  it('groups the links under headings so twelve of them stay scannable', () => {
    const { container } = render(<SiteFooter />);

    const headings = Array.from(container.querySelectorAll('nav h2')).map((heading) => heading.textContent);
    expect(headings).toEqual([
      tFromCatalog('common', 'footer.journeys.climb'),
      tFromCatalog('common', 'footer.journeys.walls'),
      tFromCatalog('common', 'footer.journeys.project'),
      tFromCatalog('common', 'footer.journeys.help'),
    ]);
  });

  it('reports the navigation destination and app handoff placement', () => {
    const { container } = render(<SiteFooter />);
    const helpLink = container.querySelector<HTMLAnchorElement>('nav a[href="/help"]');
    expect(helpLink).toBeTruthy();
    fireEvent.click(helpLink!);
    expect(trackWebsiteJourneyLinkClick).toHaveBeenCalledWith(expect.anything(), {
      name: 'Nav Link Clicked',
      properties: { area: 'footer', target: '/help' },
    });
    fireEvent.click(screen.getByLabelText('Start climbing in the app'));
    expect(trackWebsiteJourneyLinkClick).toHaveBeenCalledWith(expect.anything(), {
      name: 'Web App Opened',
      properties: { placement: 'footer' },
    });
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

    expect(screen.getByText(/Boardsesh is independent and is not made or endorsed/)).toBeTruthy();
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

vi.mock('@/app/components/consent/consent-state-provider', () => ({
  useConsent: () => ({ granted: true, openChoices: vi.fn() }),
}));
