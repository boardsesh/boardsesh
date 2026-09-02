import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import enMarketing from '@boardsesh/i18n/locales/en-US/marketing.json';
import { IOS_APP_STORE_URL, ANDROID_PLAY_STORE_URL } from '@/app/lib/store-urls';
import { APP_URL } from '@/app/lib/app-origin';

// --- Mocks ---

// Resolve real en-US copy so assertions against the hero CTA still match after
// the page started reading from i18n catalogs. Falls back to the raw key, which
// surfaces missing keys clearly if a regex stops matching.
function resolveMarketingKey(key: string): string {
  const segments = key.split('.');
  let node: unknown = enMarketing;
  for (const segment of segments) {
    if (node && typeof node === 'object' && segment in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[segment];
    } else {
      return key;
    }
  }
  return typeof node === 'string' ? node : key;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => resolveMarketingKey(key),
    i18n: { language: 'en-US', changeLanguage: () => Promise.resolve() },
  }),
}));

const mockTrack = vi.fn();
vi.mock('@/app/lib/analytics', () => ({
  track: (...args: unknown[]) => mockTrack(...args),
}));

import HomePageContent from '../home-page-content';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

const mockIsNativeApp = vi.fn<() => boolean>(() => false);
const mockIsCapacitorWebView = vi.fn<() => boolean>(() => false);
const mockWaitForCapacitor = vi.fn<() => Promise<boolean>>(() => Promise.resolve(false));
vi.mock('@/app/lib/ble/capacitor-utils', () => ({
  isNativeApp: () => mockIsNativeApp(),
  isCapacitorWebView: () => mockIsCapacitorWebView(),
  waitForCapacitor: () => mockWaitForCapacitor(),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

vi.mock('@/app/components/beta-videos/home-recent-beta-section', () => ({
  default: () => null,
}));

// The rail is deliberately NOT mocked — its anchors are the point of the page
// now, and mocking it would make the "SSR popular configs" cases vacuous. Only
// the board artwork inside it is stubbed out.
vi.mock('@/app/components/board-renderer/board-renderer', () => ({
  default: () => <div data-testid="board-thumb" />,
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children, className }: { href: string; children?: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// --- Helpers ---

const defaultProps = {};

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';
const IOS_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// `userAgent` lives on Navigator.prototype, so getOwnPropertyDescriptor returns
// undefined and there's no own-property descriptor to hand back. Capture the
// string value instead and always redefine it in afterEach so the UA never
// bleeds between cases.
const ORIGINAL_UA = window.navigator.userAgent;

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
}

// --- Tests ---

describe('HomePageContent', () => {
  let openSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsNativeApp.mockReturnValue(false);
    mockIsCapacitorWebView.mockReturnValue(false);
    mockWaitForCapacitor.mockResolvedValue(false);
    openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
  });

  afterEach(() => {
    openSpy.mockRestore();
    setUserAgent(ORIGINAL_UA);
  });

  describe('hero install CTA', () => {
    it('shows the App Store install CTA on iOS/desktop web and opens the store on click', async () => {
      setUserAgent(IOS_SAFARI_UA);
      render(<HomePageContent {...defaultProps} />);

      const button = await screen.findByRole('button', { name: /install from app store/i });
      fireEvent.click(button);

      expect(openSpy).toHaveBeenCalledWith(IOS_APP_STORE_URL, '_blank', 'noopener,noreferrer');
      expect(mockTrack).toHaveBeenCalledWith('App Install Click', {
        platform: 'ios',
        source: 'app-store',
        placement: 'hero',
        mode: 'install',
      });
      // The hero no longer starts a sesh, and nothing on this page navigates
      // imperatively any more — every destination is an anchor.
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('shows the Google Play install CTA on Android web and opens Play on click', async () => {
      setUserAgent(ANDROID_UA);
      render(<HomePageContent {...defaultProps} />);

      const button = await screen.findByRole('button', { name: /get it on google play/i });
      fireEvent.click(button);

      expect(openSpy).toHaveBeenCalledWith(ANDROID_PLAY_STORE_URL, '_blank', 'noopener,noreferrer');
      expect(mockTrack).toHaveBeenCalledWith('App Install Click', {
        platform: 'android',
        source: 'google-play',
        placement: 'hero',
        mode: 'install',
      });
    });

    it('shows an update CTA for a retired iOS native app, pointed at the App Store', async () => {
      setUserAgent(IOS_SAFARI_UA);
      mockIsNativeApp.mockReturnValue(true);
      render(<HomePageContent {...defaultProps} />);

      const button = await screen.findByRole('button', { name: /update the app/i });
      fireEvent.click(button);

      expect(openSpy).toHaveBeenCalledWith(IOS_APP_STORE_URL, '_blank', 'noopener,noreferrer');
      expect(mockTrack).toHaveBeenCalledWith('App Install Click', {
        platform: 'ios',
        source: 'app-store',
        placement: 'hero',
        mode: 'update',
      });
    });

    it('shows an update CTA for a retired Android native app, pointed at Google Play', async () => {
      setUserAgent(ANDROID_UA);
      mockIsNativeApp.mockReturnValue(true);
      render(<HomePageContent {...defaultProps} />);

      const button = await screen.findByRole('button', { name: /update the app/i });
      fireEvent.click(button);

      expect(openSpy).toHaveBeenCalledWith(ANDROID_PLAY_STORE_URL, '_blank', 'noopener,noreferrer');
      expect(mockTrack).toHaveBeenCalledWith('App Install Click', {
        platform: 'android',
        source: 'google-play',
        placement: 'hero',
        mode: 'update',
      });
    });
  });

  describe('install app card', () => {
    it('shows the iOS App Store CTA on a regular browser', async () => {
      setUserAgent(IOS_SAFARI_UA);
      render(<HomePageContent {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText(/Get the Boardsesh app/i)).toBeTruthy();
      });
      expect(screen.getByText(/Lights up holds on your board straight from your phone/i)).toBeTruthy();
    });

    it('shows the Google Play CTA on Android UA', async () => {
      setUserAgent(ANDROID_UA);
      render(<HomePageContent {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText(/Now on Google Play/i)).toBeTruthy();
      });
      expect(screen.getByText(/Get the Boardsesh app/i)).toBeTruthy();
    });

    it('hides the install card once running in the native Capacitor app', async () => {
      mockIsNativeApp.mockReturnValue(true);
      render(<HomePageContent {...defaultProps} />);
      await waitFor(() => {
        expect(screen.queryByText(/Get the Boardsesh app/i)).toBeNull();
        expect(screen.queryByText(/Now on Google Play/i)).toBeNull();
      });
    });

    it('waits for the Capacitor bridge before classifying a WebView as web', async () => {
      setUserAgent(ANDROID_UA);
      mockIsCapacitorWebView.mockReturnValue(true);
      // Simulate the bridge appearing: waitForCapacitor resolves true and
      // a subsequent isNativeApp() check then returns true.
      let nativeAfterBridge = false;
      mockIsNativeApp.mockImplementation(() => nativeAfterBridge);
      mockWaitForCapacitor.mockImplementation(() => {
        nativeAfterBridge = true;
        return Promise.resolve(true);
      });

      render(<HomePageContent {...defaultProps} />);
      await waitFor(() => {
        // Card must not render since we now know we're native.
        expect(screen.queryByText(/Now on Google Play/i)).toBeNull();
      });
      expect(mockWaitForCapacitor).toHaveBeenCalledTimes(1);
    });
  });

  describe('SSR popular configs', () => {
    const KILTER_CONFIG = {
      boardType: 'kilter',
      layoutId: 1,
      layoutName: 'Original',
      sizeId: 10,
      sizeName: '12 x 12 Square',
      sizeDescription: 'With kickboard',
      setIds: [1, 20],
      setNames: ['Bolt Ons', 'Screw Ons'],
      climbCount: 500,
      totalAscents: 5000,
      boardCount: 10,
      displayName: 'Kilter Original 12x12',
    };

    it('renders one crawlable board link per SSR config', () => {
      setUserAgent(IOS_SAFARI_UA);
      render(
        <HomePageContent
          {...defaultProps}
          initialPopularConfigs={[KILTER_CONFIG, { ...KILTER_CONFIG, sizeId: 27, displayName: 'Kilter no kick' }]}
        />,
      );

      const boardLinks = screen
        .getAllByRole('link')
        .map((link) => link.getAttribute('href') ?? '')
        .filter((href) => /^\/(kilter|tension|moonboard)\/.+\/list$/.test(href));
      expect(boardLinks).toHaveLength(2);
    });

    it('renders no board links and does not crash when the backend returned nothing', () => {
      setUserAgent(IOS_SAFARI_UA);
      render(<HomePageContent {...defaultProps} initialPopularConfigs={[]} />);

      const boardLinks = screen
        .getAllByRole('link')
        .map((link) => link.getAttribute('href') ?? '')
        .filter((href) => /^\/(kilter|tension|moonboard)\/.+\/list$/.test(href));
      expect(boardLinks).toHaveLength(0);
    });
  });

  describe('onboarding cards are links', () => {
    it('points the Aurora and Playlist cards at real routes', () => {
      render(<HomePageContent {...defaultProps} />);

      expect(
        screen.getByRole('link', { name: new RegExp(resolveMarketingKey('home.cards.auroraTitle'), 'i') }),
      ).toHaveProperty('href');
      const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
      expect(hrefs).toContain('/aurora-migration');
      expect(hrefs).toContain('/playlists');
    });

    // The gym nudge came out with the search drawer and left a comment behind
    // promising its return "when #4372 builds the gyms directory". It did, so
    // the card is back — and unlike HomeGymCard, which self-gates to null, this
    // one renders for the signed-out visitor this suite mocks.
    it('points the "find a gym" card at the directory', () => {
      render(<HomePageContent {...defaultProps} />);

      const card = screen.getByRole('link', {
        name: new RegExp(resolveMarketingKey('home.cards.gymTitle'), 'i'),
      });
      expect(card.getAttribute('href')).toBe('/gyms');
    });

    it('hands the "Connect your board" card off to the app origin', () => {
      render(<HomePageContent {...defaultProps} />);

      const card = screen.getByRole('link', {
        name: new RegExp(resolveMarketingKey('home.cards.bluetoothTitle'), 'i'),
      });
      expect(card.getAttribute('href')).toBe(APP_URL);
    });
  });

  describe('heading semantics', () => {
    it('gives the hero title a real <h1>, not just h5 styling', () => {
      // MUI maps variant="h5" to a literal <h5>, so this shipped with no <h1>
      // anywhere on the site's highest-traffic indexable page. The fix is
      // `component="h1"` — visually identical, semantically correct — and this
      // pins it, because nothing visual changes if it regresses.
      render(<HomePageContent {...defaultProps} />);

      // jsdom, so this pins the element the component *renders*, not what the
      // deployed HTML contains. The SSR half is covered by the `/` check in
      // scripts/production-smoke.ts, which reads the real response body — this
      // one would still pass if the component became client-only.
      const levelOneHeadings = screen.getAllByRole('heading', { level: 1 });
      expect(levelOneHeadings.length, 'homepage must render exactly one <h1>').toBe(1);
      expect(levelOneHeadings[0].textContent?.trim().length ?? 0).toBeGreaterThan(0);
    });
  });
});
