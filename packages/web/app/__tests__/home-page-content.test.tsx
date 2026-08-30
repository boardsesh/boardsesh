import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import enMarketing from '@boardsesh/i18n/locales/en-US/marketing.json';
import { buildStoreUrl } from '@/app/lib/store-links';
import { __resetSessionInboundCampaignForTests } from '@/app/lib/inbound-campaign';
import deMarketing from '@boardsesh/i18n/locales/de/marketing.json';
import esMarketing from '@boardsesh/i18n/locales/es/marketing.json';
import frMarketing from '@boardsesh/i18n/locales/fr/marketing.json';
import itMarketing from '@boardsesh/i18n/locales/it/marketing.json';
import { DocumentLocaleProvider } from '@/app/lib/i18n/document-locale-context';

// Every hero store link names the hero as its placement (#6027).
const HERO_PLAY_STORE_URL = buildStoreUrl('android', { placement: 'hero' });
const HERO_APP_STORE_URL = buildStoreUrl('ios', { placement: 'hero' });

// --- Mocks ---

// Exercise the same fixed-locale catalogs as the static server page.
vi.mock('server-only', () => ({}));

const mockTrack = vi.fn();
vi.mock('@/app/lib/analytics-capture', () => ({
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

// jsdom has neither matchMedia nor a playable <video>; the hook has its own suite.
vi.mock('@/app/hooks/use-autoplay-video', () => ({
  useAutoplayVideo: () => ({
    videoRef: { current: null },
    showsControls: false,
    prefersReducedMotion: false,
    autoplayRefused: false,
    isShowingVideo: false,
    userPaused: false,
    toggleUserPaused: () => undefined,
  }),
}));

vi.mock('@/app/components/beta-videos/home-recent-beta-section', () => ({
  default: () => null,
}));

// The rail is deliberately NOT mocked — its anchors are the point of the page
// now, and mocking it would make the physical-board identity cases vacuous.
// Board artwork is an ordinary backend image and needs no browser renderer mock.

// --- Helpers ---

const marketingByLocale = { 'en-US': enMarketing, de: deMarketing, es: esMarketing, fr: frMarketing, it: itMarketing };

async function renderHome({ locale = 'en-US', ...slots }: Partial<Parameters<typeof HomePageContent>[0]> = {}) {
  const page = await HomePageContent({ locale, ...slots });
  return render(<DocumentLocaleProvider locale={locale}>{page}</DocumentLocaleProvider>);
}

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
  let loadSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsNativeApp.mockReturnValue(false);
    mockIsCapacitorWebView.mockReturnValue(false);
    mockWaitForCapacitor.mockResolvedValue(false);
    openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    // The showcase picks its video source from matchMedia; jsdom has neither that nor load().
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    loadSpy = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    loadSpy.mockRestore();
    openSpy.mockRestore();
    setUserAgent(ORIGINAL_UA);
  });

  it('keeps discovery after the app introduction', async () => {
    await renderHome({
      featureStrip: <section data-testid="features" />,
      gymSearch: <section data-testid="gyms" />,
    });
    const featureSection = screen.getByTestId('features');
    const gymSection = screen.getByTestId('gyms');
    expect(featureSection.compareDocumentPosition(gymSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the playable demo in the hero before the journey and feature sections', async () => {
    await renderHome({ featureStrip: <section data-testid="features" /> });
    const heroHeading = screen.getByRole('heading', { level: 1 });
    const hero = heroHeading.closest('section');
    const video = screen.getByLabelText(enMarketing.home.showcase.videoLabel);
    const featureSection = screen.getByTestId('features');
    expect(hero?.contains(video)).toBe(true);
    expect(video.compareDocumentPosition(featureSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelectorAll('video')).toHaveLength(1);
    expect(screen.queryByAltText(enMarketing.home.hero.playShotAlt)).toBeNull();
    expect(document.querySelectorAll('figcaption li')).toHaveLength(8);
    expect(screen.getByRole('button', { name: enMarketing.home.showcase.play })).toBeTruthy();
  });

  it.each(['es', 'fr', 'de', 'it'] as const)(
    'keeps the three real board captures without English video on the %s page',
    async (locale) => {
      await renderHome({ locale, featureStrip: <section data-testid="features" /> });
      const hero = screen.getByRole('heading', { level: 1 }).closest('section');
      const copy = marketingByLocale[locale].home.hero;
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(copy.title);
      expect(screen.getByRole('link', { name: copy.eyebrow }).getAttribute('href')).toBe(`/${locale}/boards`);
      for (const alt of [copy.tensionShotAlt, copy.moonboardShotAlt, copy.playShotAlt]) {
        expect(hero?.contains(screen.getByAltText(alt))).toBe(true);
      }
      expect(document.querySelector('video')).toBeNull();
    },
  );

  describe('hero install CTA', () => {
    it('renders both store buttons on desktop web', async () => {
      setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36');
      await renderHome();
      expect(await screen.findByRole('link', { name: /app store|get the free app/i })).toBeTruthy();
      fireEvent.click(await screen.findByRole('link', { name: /google play|get the free app/i }));
      expect(
        screen.getByRole('link', { name: /google play|get the free app|update the app/i }).getAttribute('href'),
      ).toBe(HERO_PLAY_STORE_URL);
    });

    it('keeps the shared App Store badge on iPhone beside the desktop install slot', async () => {
      setUserAgent(IOS_SAFARI_UA);
      await renderHome({ desktopInstall: <div data-testid="laptop-install" /> });

      const link = await screen.findByRole('link', { name: enMarketing.home.hero.ctaInstallIos });
      const badge = link.querySelector('img');

      // Shared HTML keeps the paired artwork and size after platform detection.
      expect(badge?.getAttribute('src')).toBe('/images/store-badges/app-store-black-en-US.svg');
      expect(badge?.getAttribute('height')).toBe('44');
      expect(badge?.getAttribute('alt')).toBe('Download on the App Store');
      expect(link.querySelector('.MuiButton-root')).toBeNull();
      // CSS shows one of the two per screen width; both are in the markup.
      expect(screen.getByTestId('laptop-install')).toBeTruthy();
    });

    it('shows the App Store install CTA on iOS web and opens the store on click', async () => {
      setUserAgent(IOS_SAFARI_UA);
      await renderHome();

      const button = await screen.findByRole('link', { name: /app store|get the free app/i });
      fireEvent.click(button);

      expect(button.getAttribute('href')).toBe(HERO_APP_STORE_URL);
      expect(button.getAttribute('rel')).toBe('noopener noreferrer');
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
      await renderHome();

      const button = await screen.findByRole('link', { name: /google play|get the free app/i });
      fireEvent.click(button);

      expect(
        screen.getByRole('link', { name: /google play|get the free app|update the app/i }).getAttribute('href'),
      ).toBe(HERO_PLAY_STORE_URL);
      expect(mockTrack).toHaveBeenCalledWith('App Install Click', {
        platform: 'android',
        source: 'google-play',
        placement: 'hero',
        mode: 'install',
      });
    });

    it("carries a tagged visitor's source into the store link", async () => {
      // The page renders the untagged link first (it has to match the server
      // HTML), then upgrades it once the landing campaign is known.
      __resetSessionInboundCampaignForTests();
      window.history.replaceState(null, '', '/?utm_source=instagram&utm_medium=social&utm_campaign=spray-launch');
      setUserAgent(ANDROID_UA);
      await renderHome();

      const button = await screen.findByRole('link', { name: /google play|get the free app/i });
      const referrer = new URLSearchParams(
        new URL(button.getAttribute('href') ?? '').searchParams.get('referrer') ?? '',
      );

      expect(referrer.get('utm_source')).toBe('instagram');
      expect(referrer.get('utm_medium')).toBe('social');
      expect(referrer.get('utm_campaign')).toBe('spray-launch');
      expect(referrer.get('utm_content')).toBe('hero');

      window.history.replaceState(null, '', '/');
      __resetSessionInboundCampaignForTests();
    });

    it('shows an update CTA for a retired iOS native app, pointed at the App Store', async () => {
      setUserAgent(IOS_SAFARI_UA);
      mockIsNativeApp.mockReturnValue(true);
      await renderHome();

      const button = await screen.findByRole('link', { name: /update the app/i });
      fireEvent.click(button);

      expect(button.getAttribute('href')).toBe(HERO_APP_STORE_URL);
      expect(button.getAttribute('rel')).toBe('noopener noreferrer');
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
      await renderHome();

      const button = await screen.findByRole('link', { name: /update the app/i });
      fireEvent.click(button);

      expect(
        screen.getByRole('link', { name: /google play|get the free app|update the app/i }).getAttribute('href'),
      ).toBe(HERO_PLAY_STORE_URL);
      expect(mockTrack).toHaveBeenCalledWith('App Install Click', {
        platform: 'android',
        source: 'google-play',
        placement: 'hero',
        mode: 'update',
      });
    });
  });

  describe('install handling', () => {
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

      await renderHome();
      expect(await screen.findByRole('link', { name: /update the app/i })).toBeTruthy();
      expect(screen.queryByRole('link', { name: /google play|get the free app/i })).toBeNull();
      expect(mockWaitForCapacitor).toHaveBeenCalledTimes(1);
    });
  });

  describe('public journeys', () => {
    it('offers all catalog boards and the photo wall before session detail', async () => {
      await renderHome({ featureStrip: <section data-testid="features" /> });
      const boardLinks = screen
        .getAllByRole('link')
        .filter((link) => link.getAttribute('href')?.startsWith('/boards#'));
      expect(boardLinks).toHaveLength(9);
      expect(boardLinks.map((link) => link.textContent)).toContain('Woods');
      expect(boardLinks.map((link) => link.getAttribute('href'))).toContain('/boards#quantum');
      expect(
        boardLinks[0].compareDocumentPosition(screen.getByTestId('features')) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
      expect(hrefs).toContain('/bring-your-logbook');
      expect(hrefs).toContain('/spraywalls');
      expect(hrefs).toContain('/gyms?claim=1');
      expect(hrefs).toContain('/for-gyms');
    });

    it('reports a named compatibility choice without a wall or account identifier', async () => {
      await renderHome();
      fireEvent.click(screen.getByRole('link', { name: 'Woods' }));
      expect(mockTrack).toHaveBeenCalledWith('Compatibility Board Selected', { board: 'woods', source: 'home-chip' });
    });

    it.each(['en-US', 'es', 'de'] as const)(
      'links the English-only board app guides from the %s hero',
      async (locale) => {
        await renderHome({ locale });
        const hero = screen.getByRole('heading', { level: 1 }).closest('section');
        const guides = screen.getByRole('link', { name: marketingByLocale[locale].home.hero.compareApps });
        // /apps is the canonical English guide across every homepage locale.
        expect(guides.getAttribute('href')).toBe('/apps');
        expect(guides.getAttribute('hreflang')).toBe('en');
        expect(hero?.contains(guides)).toBe(true);
      },
    );
  });

  describe('heading semantics', () => {
    it('gives the hero title a real <h1>, not just h5 styling', async () => {
      // MUI maps variant="h5" to a literal <h5>, so this shipped with no <h1>
      // anywhere on the site's highest-traffic indexable page. The fix is
      // `component="h1"` — visually identical, semantically correct — and this
      // pins it, because nothing visual changes if it regresses.
      await renderHome();

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
