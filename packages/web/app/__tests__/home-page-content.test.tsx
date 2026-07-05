import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import enMarketing from '@boardsesh/i18n/locales/en-US/marketing.json';
import { IOS_APP_STORE_URL, ANDROID_PLAY_STORE_URL } from '@/app/lib/store-urls';

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

vi.mock('@/app/components/session-creation/start-sesh-drawer', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="start-sesh-drawer">Drawer</div> : null),
}));

vi.mock('@/app/components/search-drawer/unified-search-drawer', () => ({
  default: () => null,
}));

vi.mock('@/app/components/board-selector-drawer/board-selector-drawer', () => ({
  default: () => null,
}));

vi.mock('@/app/components/board-scroll/board-discovery-scroll', () => ({
  default: () => null,
}));

vi.mock('@/app/components/beta-videos/home-recent-beta-section', () => ({
  default: () => null,
}));

// --- Helpers ---

const defaultProps = {
  boardConfigs: {} as React.ComponentProps<typeof HomePageContent>['boardConfigs'],
};

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';
const IOS_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const originalUA = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');

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
    if (originalUA) {
      Object.defineProperty(window.navigator, 'userAgent', originalUA);
    }
  });

  describe('hero install CTA', () => {
    it('shows the App Store install CTA on iOS/desktop web and opens the store on click', async () => {
      setUserAgent(IOS_SAFARI_UA);
      render(<HomePageContent {...defaultProps} />);

      const button = await screen.findByRole('button', { name: /install from app store/i });
      fireEvent.click(button);

      expect(openSpy).toHaveBeenCalledWith(IOS_APP_STORE_URL, '_blank', 'noopener,noreferrer');
      expect(mockTrack).toHaveBeenCalledWith(
        'App Install Click',
        expect.objectContaining({ platform: 'ios', source: 'app-store', placement: 'hero', mode: 'install' }),
      );
      // The hero no longer starts a sesh — the drawer must stay closed and no
      // client navigation should fire.
      expect(screen.queryByTestId('start-sesh-drawer')).toBeNull();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('shows the Google Play install CTA on Android web and opens Play on click', async () => {
      setUserAgent(ANDROID_UA);
      render(<HomePageContent {...defaultProps} />);

      const button = await screen.findByRole('button', { name: /get it on google play/i });
      fireEvent.click(button);

      expect(openSpy).toHaveBeenCalledWith(ANDROID_PLAY_STORE_URL, '_blank', 'noopener,noreferrer');
      expect(mockTrack).toHaveBeenCalledWith(
        'App Install Click',
        expect.objectContaining({ platform: 'android', source: 'google-play', placement: 'hero', mode: 'install' }),
      );
    });

    it('shows an update CTA for the retired native app, pointed at the same store', async () => {
      setUserAgent(IOS_SAFARI_UA);
      mockIsNativeApp.mockReturnValue(true);
      render(<HomePageContent {...defaultProps} />);

      const button = await screen.findByRole('button', { name: /update the app/i });
      fireEvent.click(button);

      expect(openSpy).toHaveBeenCalledWith(IOS_APP_STORE_URL, '_blank', 'noopener,noreferrer');
      expect(mockTrack).toHaveBeenCalledWith(
        'App Install Click',
        expect.objectContaining({ placement: 'hero', mode: 'update' }),
      );
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
    it('renders the hero install CTA when initialPopularConfigs are provided', async () => {
      // BoardDiscoveryScroll is mocked, so we just verify the component renders
      // without error and still surfaces the hero CTA. Pin the UA so the CTA
      // label is deterministic (userAgent lives on the prototype, so the
      // per-test restore can't reset it between cases).
      setUserAgent(IOS_SAFARI_UA);
      const initialConfigs = [
        {
          boardType: 'kilter',
          layoutId: 8,
          layoutName: 'Original',
          sizeId: 25,
          sizeName: '12x12',
          sizeDescription: 'Full size',
          setIds: [26, 27],
          setNames: ['Set A', 'Set B'],
          climbCount: 500,
          totalAscents: 5000,
          boardCount: 10,
          displayName: 'OG 12x12',
        },
      ];

      render(<HomePageContent {...defaultProps} initialPopularConfigs={initialConfigs} />);
      expect(await screen.findByRole('button', { name: /install from app store/i })).toBeTruthy();
    });
  });
});
