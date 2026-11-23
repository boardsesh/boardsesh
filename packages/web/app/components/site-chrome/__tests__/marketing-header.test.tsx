// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { act, render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { trackWebsiteJourneyEvent, trackWebsiteJourneyLinkClick } from '@/app/lib/website-journey-analytics';

import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import MarketingHeader from '../marketing-header';
import { APP_URL } from '@/app/lib/app-origin';
import { buildStoreUrl } from '@/app/lib/store-links';

const mockTrackAppInstallClick = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/track-app-install-click', () => ({ trackAppInstallClick: mockTrackAppInstallClick }));

/**
 * Successor to `global-header/__tests__/global-header.test.tsx`.
 *
 * The search-field and board-route cases are gone with the search drawer and
 * the persistent-session bridge, and W-19 (#4437) took the `/you` branches with
 * the route; everything the profile / `/settings` surfaces still depend on is
 * re-asserted here, plus two obligations this header picked up: the account
 * affordance that replaces the deleted UserDrawer (the only sign-in entry point
 * outside `/auth`, and now the only route to /settings) and the chrome-less
 * bail.
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
}));

vi.mock('@/app/components/back-button', () => ({
  default: (props: { fallbackUrl?: string }) => (
    <button data-testid="back-button" data-fallback={props.fallbackUrl}>
      Back
    </button>
  ),
}));

let mockSessionData: { user: { id: string; name: string } } | null = {
  user: { id: 'user-1', name: 'Test User' },
};
let mockSessionStatus = 'authenticated';
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockSessionData, status: mockSessionStatus }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const mockShareWithFallback = vi.fn();
vi.mock('@/app/lib/share-utils', () => ({
  shareWithFallback: (...args: unknown[]) => mockShareWithFallback(...args),
}));

let mockStatsFilterBridgeState = {
  isActive: false,
  pageTitle: null as string | null,
  backUrl: null as string | null,
  openFilterDrawer: null as (() => void) | null,
  hasActiveFilters: false,
};
vi.mock('@/app/components/stats-filter-bridge/stats-filter-bridge-context', () => ({
  useStatsFilterBridge: () => mockStatsFilterBridgeState,
}));

let mockProfileHeaderShareState = {
  isActive: false,
  displayName: null as string | null,
};
vi.mock('@/app/components/profile-header-bridge/profile-header-bridge-context', () => ({
  useProfileHeaderShare: () => mockProfileHeaderShareState,
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

vi.mock('@/app/lib/website-journey-analytics', () => ({
  trackWebsiteJourneyEvent: vi.fn(),
  trackWebsiteJourneyLinkClick: vi.fn(),
}));

describe('MarketingHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/some-page';
    mockSessionData = { user: { id: 'user-1', name: 'Test User' } };
    mockSessionStatus = 'authenticated';
    mockStatsFilterBridgeState = {
      isActive: false,
      pageTitle: null,
      backUrl: null,
      openFilterDrawer: null,
      hasActiveFilters: false,
    };
    mockProfileHeaderShareState = { isActive: false, displayName: null };
  });

  // `e2e/site-chrome.spec.ts` selects the chrome by this testid rather than by
  // tag, because kiosk/embed page content renders its own <header>/<footer>.
  // e2e is workflow_dispatch-only (standing rule 6), so pin the contract here
  // where every PR runs it.
  it('tags every header branch with the marketing-header testid the e2e spec selects', () => {
    for (const pathname of ['/some-page', '/', '/settings', '/profile/user-2', '/bring-your-logbook']) {
      mockPathname = pathname;
      const { container, unmount } = render(<MarketingHeader />);
      expect(
        container.querySelector('[data-testid="marketing-header"]'),
        `${pathname} must tag its header`,
      ).toBeTruthy();
      unmount();
    }
  });

  it('reports the navigation destination and app handoff placement', () => {
    const { container } = render(<MarketingHeader />);
    const helpLink = container.querySelector<HTMLAnchorElement>('nav a[href="/help"]');
    expect(helpLink).toBeTruthy();
    fireEvent.click(helpLink!);
    expect(trackWebsiteJourneyEvent).toHaveBeenCalledWith({
      name: 'Nav Link Clicked',
      properties: { area: 'header', target: '/help' },
    });
    fireEvent.click(screen.getByLabelText('Start climbing in the app'));
    expect(trackWebsiteJourneyLinkClick).toHaveBeenCalledWith(expect.anything(), {
      name: 'Web App Opened',
      properties: { placement: 'header' },
    });
  });

  it('renders the brand link and the app hand-off, and no search field', () => {
    render(<MarketingHeader />);

    expect(screen.getByLabelText('Boardsesh home').closest('a')?.getAttribute('href')).toBe('/');
    expect(screen.getByLabelText('Start climbing in the app')).toBeTruthy();
    expect(screen.queryByPlaceholderText('What do you want to climb?')).toBeNull();
  });

  it('keeps the genuine mark and wordmark together on home and inner pages', () => {
    for (const pathname of ['/', '/about', '/settings']) {
      mockPathname = pathname;
      const { unmount } = render(<MarketingHeader />);
      const brandLink = screen.getByLabelText('Boardsesh home');
      const mark = brandLink.querySelector('img');
      expect(brandLink.textContent).toBe('Boardsesh');
      expect(mark?.getAttribute('src')).toContain('boardsesh-mark');
      expect(mark?.getAttribute('alt')).toBe('');
      expect(mark?.getAttribute('loading')).toBe('eager');
      unmount();
    }
  });

  // -----------------------------------------------------------------------
  // Primary nav
  //
  // The header shipped with no nav at all, which is how the gym directory ended
  // up reachable only by typing the URL. These cases pin both halves of the
  // contract: which four destinations it carries, and that the anchors are in
  // the markup at every viewport (the responsive swap is CSS — the component
  // must not learn how wide the screen is).
  // -----------------------------------------------------------------------
  describe('primary nav', () => {
    const NAV_PATHS = ['/boards', '/gyms', '/spraywalls', '/playlists', '/help'];

    for (const [label, pathname] of [
      ['the default header', '/some-page'],
      ['the home header', '/'],
      ['the logbook guide', '/bring-your-logbook'],
    ] as const) {
      it(`carries the four nav links on ${label}`, () => {
        mockPathname = pathname;
        const { container } = render(<MarketingHeader />);

        const nav = container.querySelector('nav');
        expect(nav?.getAttribute('aria-label')).toBe(tFromCatalog('common', 'header.navLabel'));

        const hrefs = Array.from(nav?.querySelectorAll('a') ?? []).map((anchor) => anchor.getAttribute('href'));
        expect(hrefs).toEqual(NAV_PATHS);
      });
    }

    it('labels each nav link from the catalog', () => {
      const { container } = render(<MarketingHeader />);

      const labels = Array.from(container.querySelectorAll('nav a')).map((anchor) => anchor.textContent);
      expect(labels).toEqual(['Boards', 'Gyms', 'Spray walls', 'Playlists', 'Help']);
    });

    // The wireframe draws a "Boards" tab. `/boards` does not exist, so linking
    // it would put a 404 in the chrome of every page.
    it('links to the supported-boards page from the shared header', () => {
      const { container } = render(<MarketingHeader />);

      expect(container.querySelectorAll('a[href="/boards"]').length).toBe(1);
    });

    // The narrow-viewport treatment is a menu button, not a second set of
    // always-rendered anchors: the inline row is the crawlable copy and it is
    // hidden with CSS rather than unmounted, so it is present here too.
    it('offers the four destinations and the mobile app hand-off in its menu', () => {
      render(<MarketingHeader />);

      const menuButton = screen.getByLabelText('Open menu');
      expect(menuButton.getAttribute('aria-expanded')).toBe('false');

      fireEvent.click(menuButton);

      expect(menuButton.getAttribute('aria-expanded')).toBe('true');
      const menuItemHrefs = screen
        .getAllByRole('menuitem')
        .map((item) => item.closest('a')?.getAttribute('href') ?? item.getAttribute('href'));
      expect(menuItemHrefs).toEqual(['/profile/user-1', '/settings', ...NAV_PATHS, APP_URL]);
    });

    // The centred and brand-only variants own their whole bar — a profile
    // header is a back button, a title and one action, and /settings is the
    // brand link alone. Neither gets the nav.
    for (const pathname of ['/profile/user-2', '/profile/user-2/statistics', '/settings']) {
      it(`leaves ${pathname} without a nav`, () => {
        mockPathname = pathname;
        const { container } = render(<MarketingHeader />);

        expect(container.querySelector('nav')).toBeNull();
        expect(container.querySelectorAll('a[href="/gyms"]').length).toBe(0);
      });
    }
  });

  // -----------------------------------------------------------------------
  // The account affordance that replaces the deleted UserDrawer
  // -----------------------------------------------------------------------
  describe('account affordance', () => {
    it('offers a sign-in link when signed out — the only entry point outside /auth', () => {
      mockSessionData = null;
      mockSessionStatus = 'unauthenticated';
      render(<MarketingHeader />);

      expect(screen.getByText('Sign in').closest('a')?.getAttribute('href')).toBe('/auth/login');
    });

    it('links to your own profile when signed in', () => {
      render(<MarketingHeader />);

      expect(screen.getByLabelText('Your profile').closest('a')?.getAttribute('href')).toBe('/profile/user-1');
    });

    // W-19 (#4437) deleted /you, which carried the only link to /settings. The
    // account affordance is now the sole entry point, and stays that way until
    // W-21 decides what happens to /settings itself.
    it('keeps settings reachable from the account affordance', () => {
      const { container } = render(<MarketingHeader />);

      expect(container.querySelector('a[href="/settings"]')).toBeTruthy();
    });

    // W-19 parked the notifications bell here so /notifications stayed reachable
    // for one deploy. W-20b (#4439) deleted the page, so the link has to go too —
    // otherwise a signed-in visitor taps a bell that looks local and gets bounced
    // cross-origin by a 307.
    it('links nowhere into /notifications — the surface moved to the app', () => {
      for (const pathname of ['/some-page', '/', '/profile/user-2', '/settings']) {
        mockPathname = pathname;
        const { container, unmount } = render(<MarketingHeader />);
        expect(container.querySelectorAll('a[href^="/notifications"]').length, pathname).toBe(0);
        unmount();
      }
    });

    it('links nowhere into /you', () => {
      for (const pathname of ['/some-page', '/', '/profile/user-2', '/settings']) {
        mockPathname = pathname;
        const { container, unmount } = render(<MarketingHeader />);
        expect(container.querySelectorAll('a[href^="/you"]').length, pathname).toBe(0);
        unmount();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Chrome-less surfaces
  // -----------------------------------------------------------------------
  describe('on chrome-less surfaces', () => {
    it('renders nothing on a kiosk route', () => {
      mockPathname = '/kiosk/some-gym/lobby';
      const { container } = render(<MarketingHeader />);
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing on an embed route', () => {
      mockPathname = '/embed/gym/some-uuid/leaderboard';
      const { container } = render(<MarketingHeader />);
      expect(container.firstChild).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // /profile — profile statistics depends on every branch below
  // -----------------------------------------------------------------------
  describe('on /profile pages', () => {
    it('renders a back button instead of the brand link on the root profile page', () => {
      mockPathname = '/profile/user-2';
      render(<MarketingHeader />);

      expect(screen.getByTestId('back-button').getAttribute('data-fallback')).toBe('/');
      expect(screen.queryByLabelText('Boardsesh home')).toBeNull();
    });

    it('renders a share button for the viewed profile when profile share state is active', () => {
      mockPathname = '/profile/user-2';
      mockProfileHeaderShareState = { isActive: true, displayName: 'Viewed User' };

      render(<MarketingHeader />);

      expect(screen.getByLabelText('Share profile')).toBeTruthy();
    });

    it('shares the viewed profile URL from the root profile header', () => {
      mockPathname = '/profile/user-2';
      mockProfileHeaderShareState = { isActive: true, displayName: 'Viewed User' };

      render(<MarketingHeader />);
      fireEvent.click(screen.getByLabelText('Share profile'));

      expect(mockShareWithFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('/profile/user-2'),
          title: expect.stringContaining('Viewed User'),
          trackingEvent: 'Profile Shared',
        }),
      );
    });

    it('renders the child page title', () => {
      mockPathname = '/profile/user-2/sessions';
      render(<MarketingHeader />);

      expect(screen.getByText('Sessions')).toBeTruthy();
      expect(screen.getByTestId('back-button').getAttribute('data-fallback')).toBe('/profile/user-2');
    });

    it('renders the statistics filter action when the bridge is active', () => {
      mockPathname = '/profile/user-2/statistics';
      mockStatsFilterBridgeState = {
        isActive: true,
        pageTitle: 'Statistics',
        backUrl: '/profile/user-2',
        openFilterDrawer: vi.fn(),
        hasActiveFilters: true,
      };

      const { container } = render(<MarketingHeader />);

      expect(screen.getByText('Statistics')).toBeTruthy();
      expect(screen.getByLabelText('Open stats filters')).toBeTruthy();
      expect(container.querySelector('[class*="filterActiveIndicator"]')).toBeTruthy();
    });
  });

  describe('on /settings pages', () => {
    it('renders the brand link but no settings cog, share button or search bar', () => {
      mockPathname = '/settings';
      render(<MarketingHeader />);

      expect(screen.getByLabelText('Boardsesh home')).toBeTruthy();
      expect(screen.queryByLabelText('Settings')).toBeNull();
      expect(screen.queryByLabelText('Share profile')).toBeNull();
      expect(screen.queryByPlaceholderText('What do you want to climb?')).toBeNull();
    });
  });

  describe('on the home page', () => {
    it('renders a transparent bar with the brand link and the app hand-off', () => {
      mockPathname = '/';
      render(<MarketingHeader />);

      expect(screen.getByLabelText('Boardsesh home')).toBeTruthy();
      expect(screen.getByLabelText('Start climbing in the app')).toBeTruthy();
    });

    // Accepted with W-19's Q3 ruling: the account icons ride the transparent
    // hero bar too, because they are the only route to /settings now that /you
    // is gone.
    it('carries the account affordance for a signed-in visitor', () => {
      mockPathname = '/';
      const { container } = render(<MarketingHeader />);

      expect(container.querySelector('a[href="/settings"]')).toBeTruthy();
      expect(container.querySelector('a[href="/profile/user-1"]')).toBeTruthy();
    });

    it('shows a sign-in link and no account icons when signed out', () => {
      mockPathname = '/';
      mockSessionData = null;
      mockSessionStatus = 'unauthenticated';
      const { container } = render(<MarketingHeader />);

      expect(screen.getByText('Sign in').closest('a')?.getAttribute('href')).toBe('/auth/login');
      expect(container.querySelector('a[href="/settings"]')).toBeNull();
    });
  });

  // The phone's "Get the app" steps aside while the page's own store badge is on
  // screen. The hook's own cases live in `use-store-badge-on-screen.test.tsx`;
  // these pin what the header does with the answer.
  describe("the phone's Get the app link", () => {
    class FakeIntersectionObserver {
      static latest: FakeIntersectionObserver | null = null;
      constructor(readonly callback: IntersectionObserverCallback) {
        FakeIntersectionObserver.latest = this;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      report(target: Element, isIntersecting: boolean): void {
        const box = isIntersecting ? { top: 400, bottom: 448, height: 48 } : { top: -200, bottom: -152, height: 48 };
        const entry = { target, isIntersecting, boundingClientRect: box } as unknown as IntersectionObserverEntry;
        act(() => this.callback([entry], this as unknown as IntersectionObserver));
      }
    }

    beforeEach(() => {
      mockPathname = '/';
      vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function phoneInstallLink(): HTMLElement {
      return screen.getByText('Get the app').closest('a') as HTMLElement;
    }

    it('says whether a store badge in <main> is on screen, for the CSS to hide it', () => {
      render(
        <>
          <MarketingHeader />
          <main>
            <a data-store-badge="ios" href="https://apps.apple.com/">
              hero badge
            </a>
          </main>
        </>,
      );
      const badge = document.querySelector('main a[data-store-badge]') as Element;

      FakeIntersectionObserver.latest?.report(badge, true);
      expect(phoneInstallLink().getAttribute('data-store-badge-on-screen')).toBe('yes');

      FakeIntersectionObserver.latest?.report(badge, false);
      expect(phoneInstallLink().getAttribute('data-store-badge-on-screen')).toBe('no');
    });

    it('stays shown on a page with no store badge', () => {
      render(
        <>
          <MarketingHeader />
          <main>
            <p>About Boardsesh</p>
          </main>
        </>,
      );

      expect(phoneInstallLink().getAttribute('data-store-badge-on-screen')).toBe('no');
    });

    it('leaves the server HTML without an answer, so the CSS guess holds until the browser has one', () => {
      const markup = renderToString(<MarketingHeader />);

      expect(markup).toContain('Get the app');
      expect(markup).not.toContain('data-store-badge-on-screen');
    });

    it('keeps its store link and its click event', () => {
      render(<MarketingHeader />);
      const link = phoneInstallLink();

      expect(link.getAttribute('href')).toBe(buildStoreUrl('ios', { placement: 'header', inbound: null }));
      expect(link.getAttribute('target')).toBe('_blank');
      fireEvent.click(link);
      expect(mockTrackAppInstallClick).toHaveBeenCalledWith({
        platform: 'ios',
        source: 'app-store',
        placement: 'header',
        mode: 'install',
      });
    });
  });
});
