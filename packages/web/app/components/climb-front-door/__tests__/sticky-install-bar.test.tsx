import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { __resetSessionInboundCampaignForTests } from '@/app/lib/inbound-campaign';
import { __resetQrLandingForTests } from '@/app/lib/qr-landing';
import { buildStoreUrl } from '@/app/lib/store-links';
import { classifyMarketingBrowser } from '@/app/lib/marketing-platform';
import { MarketingPreviewProvider } from '@/app/components/marketing/marketing-preview-provider';

const track = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/analytics', () => ({ track }));

vi.mock('@/app/lib/ble/capacitor-utils', () => ({
  isNativeApp: () => false,
  isCapacitorWebView: () => false,
  waitForCapacitor: () => Promise.resolve(false),
}));

const consentState = vi.hoisted(() => ({
  promptShowing: false,
  dialogOpen: false,
}));
vi.mock('@/app/components/consent/consent-state-provider', () => ({
  useConsent: () => ({ promptShowing: consentState.promptShowing, dialogOpen: consentState.dialogOpen }),
}));

const barModule = await import('../sticky-install-bar');
const StickyInstallBar = barModule.default;
const { __resetStickyInstallBarForTests } = barModule;

const LABELS = {
  free: 'Free',
  cta: 'Get the app',
  dismiss: 'Hide this bar',
  ctaAria: { ios: 'Get the app on the App Store', android: 'Get the app on Google Play' },
};

const ORIGINAL_UA = navigator.userAgent;
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1';
const DESKTOP_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function setUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
}

/** IntersectionObserver as the bar sees it: each test moves the page by hand. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets: Element[] = [];

  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit = {},
  ) {
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.push(target);
  }

  disconnect(): void {
    this.targets.length = 0;
  }

  unobserve(): void {}

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  report(target: Element, position: { isIntersecting: boolean; top: number; bottom: number }): void {
    const entry = {
      target,
      isIntersecting: position.isIntersecting,
      boundingClientRect: { top: position.top, bottom: position.bottom, height: position.bottom - position.top },
    } as unknown as IntersectionObserverEntry;
    act(() => this.callback([entry], this as unknown as IntersectionObserver));
  }
}

function observerOf(selector: string): { observer: FakeIntersectionObserver; target: Element } {
  for (const observer of FakeIntersectionObserver.instances) {
    const target = observer.targets.find((candidate) => candidate.matches(selector));
    if (target) return { observer, target };
  }
  throw new Error(`nothing observes ${selector}`);
}

/** The hero's store block scrolled up out of view. */
function scrollPastHero(): void {
  const { observer, target } = observerOf('[data-sticky-install-hide]');
  observer.report(target, { isIntersecting: false, top: -300, bottom: -120 });
}

function bringHeroBack(): void {
  const { observer, target } = observerOf('[data-sticky-install-hide]');
  observer.report(target, { isIntersecting: true, top: 200, bottom: 380 });
}

function reachEnd(): void {
  const { observer, target } = observerOf('[data-sticky-install-end]');
  observer.report(target, { isIntersecting: true, top: 500, bottom: 500 });
}

function renderPage() {
  return render(
    <main>
      <div data-cta="mobile-install" data-sticky-install-hide="">
        store button
      </div>
      <StickyInstallBar labels={LABELS} markUrl="/brand/boardsesh-mark.webp" qrLanding="climb" />
    </main>,
  );
}

function bar(): HTMLElement | null {
  return document.querySelector('[data-testid="sticky-install-bar"]');
}

async function waitForBar(): Promise<HTMLElement> {
  await waitFor(() => expect(bar()).not.toBeNull());
  return bar() as HTMLElement;
}

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  track.mockReset();
  consentState.promptShowing = false;
  consentState.dialogOpen = false;
  __resetStickyInstallBarForTests();
  __resetSessionInboundCampaignForTests();
  __resetQrLandingForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setUserAgent(ORIGINAL_UA);
  window.history.replaceState(null, '', '/');
});

describe('StickyInstallBar on the server', () => {
  it('ships only its end marker: no store link for a crawler or a cached page', () => {
    const html = renderToString(<StickyInstallBar labels={LABELS} markUrl="/m.webp" />);

    expect(html).toContain('data-sticky-install-end');
    expect(html).not.toContain('sticky-install-bar');
    expect(html).not.toContain('href=');
  });
});

describe('StickyInstallBar by browser', () => {
  it.each([
    ['Chrome on Android', ANDROID_CHROME, 'android'],
    ['Chrome on an iPhone, which shows no Smart App Banner', IPHONE_CHROME, 'ios'],
  ] as const)('comes up for %s once the hero button has scrolled away', async (_browser, userAgent, store) => {
    setUserAgent(userAgent);
    renderPage();
    const stickyBar = await waitForBar();
    expect(stickyBar.getAttribute('data-open')).toBe('false');

    scrollPastHero();

    expect(stickyBar.getAttribute('data-open')).toBe('true');
    expect(screen.getByRole('link', { name: LABELS.ctaAria[store] }).getAttribute('href')).toBe(
      buildStoreUrl(store, { placement: 'sticky-bar' }),
    );
  });

  it.each([
    ['Safari on an iPhone, which has its own Smart App Banner', IPHONE_SAFARI],
    ['a desktop', DESKTOP_CHROME],
  ])('never renders for %s', async (_browser, userAgent) => {
    setUserAgent(userAgent);
    renderPage();

    // Give the platform effect its turn, then check nothing came of it.
    await act(async () => {});
    expect(bar()).toBeNull();
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
  });
});

describe('StickyInstallBar on a page cached for another browser', () => {
  // The root layout seeds `useInstallPlatform` from the user agent of the request
  // that rendered the page; the edge hands that page to everyone after it.
  it('never offers a store when the cache was filled by Android and Safari on an iPhone reads it', async () => {
    setUserAgent(IPHONE_SAFARI);
    render(
      <MarketingPreviewProvider initialBrowser={classifyMarketingBrowser(ANDROID_CHROME)}>
        <StickyInstallBar labels={LABELS} markUrl="/m.webp" />
      </MarketingPreviewProvider>,
    );

    await act(async () => {});
    expect(bar()).toBeNull();
    // Not even for one commit: no observer was ever set up for an Android bar.
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
  });

  it('offers Google Play on Android when the cache was filled by an iPhone', async () => {
    setUserAgent(ANDROID_CHROME);
    render(
      <MarketingPreviewProvider initialBrowser={classifyMarketingBrowser(IPHONE_SAFARI)}>
        <main>
          <div data-sticky-install-hide="">store button</div>
          <StickyInstallBar labels={LABELS} markUrl="/m.webp" />
        </main>
      </MarketingPreviewProvider>,
    );
    await waitForBar();
    scrollPastHero();

    expect(screen.getByRole('link', { name: LABELS.ctaAria.android })).toBeTruthy();
  });
});

describe('StickyInstallBar and the consent card', () => {
  it('stays down while the consent card is up (or may still come up), and comes up once it is gone', async () => {
    setUserAgent(ANDROID_CHROME);
    consentState.promptShowing = true;
    const { rerender } = renderPage();
    const stickyBar = await waitForBar();
    scrollPastHero();
    expect(stickyBar.getAttribute('data-open')).toBe('false');

    consentState.promptShowing = false;
    rerender(
      <main>
        <div data-cta="mobile-install" data-sticky-install-hide="">
          store button
        </div>
        <StickyInstallBar labels={LABELS} markUrl="/brand/boardsesh-mark.webp" qrLanding="climb" />
      </main>,
    );

    expect(stickyBar.getAttribute('data-open')).toBe('true');
  });

  it('stays down while the privacy dialog is open', async () => {
    setUserAgent(ANDROID_CHROME);
    consentState.dialogOpen = true;
    renderPage();
    const stickyBar = await waitForBar();

    scrollPastHero();

    expect(stickyBar.getAttribute('data-open')).toBe('false');
  });
});

describe('StickyInstallBar and the page around it', () => {
  it('goes back down while the hero button is on screen again', async () => {
    setUserAgent(ANDROID_CHROME);
    renderPage();
    const stickyBar = await waitForBar();
    scrollPastHero();
    expect(stickyBar.getAttribute('data-open')).toBe('true');

    bringHeroBack();

    expect(stickyBar.getAttribute('data-open')).toBe('false');
  });

  it('leaves once the end of the page reaches it, so it never covers the last line or the footer', async () => {
    setUserAgent(ANDROID_CHROME);
    renderPage();
    const stickyBar = await waitForBar();
    scrollPastHero();

    reachEnd();

    expect(stickyBar.getAttribute('data-open')).toBe('false');
    // The end counts from the bar's top edge, not the screen's bottom.
    const { observer } = observerOf('[data-sticky-install-end]');
    expect(observer.options.rootMargin).toMatch(/^0px 0px -\d+px 0px$/);
  });

  it('stays down over a store block that streams in after mount, like the app module', async () => {
    setUserAgent(ANDROID_CHROME);
    renderPage();
    const stickyBar = await waitForBar();
    scrollPastHero();
    expect(stickyBar.getAttribute('data-open')).toBe('true');

    // The app module's store pair arrives from a <Suspense> boundary.
    const appModule = document.createElement('section');
    appModule.innerHTML = '<div data-cta="app-install" data-sticky-install-hide="">store pair</div>';
    act(() => {
      document.querySelector('main')?.insertBefore(appModule, document.querySelector('[data-sticky-install-end]'));
    });
    await waitFor(() => expect(() => observerOf('[data-cta="app-install"]')).not.toThrow());
    const { observer, target } = observerOf('[data-cta="app-install"]');
    observer.report(target, { isIntersecting: true, top: 300, bottom: 360 });

    expect(stickyBar.getAttribute('data-open')).toBe('false');

    // Scrolled past it as well, the bar comes back.
    observer.report(target, { isIntersecting: false, top: -200, bottom: -140 });
    expect(stickyBar.getAttribute('data-open')).toBe('true');
  });

  it('ignores a store block that is display:none (the desktop layout)', async () => {
    setUserAgent(ANDROID_CHROME);
    renderPage();
    const stickyBar = await waitForBar();
    const { observer, target } = observerOf('[data-sticky-install-hide]');

    observer.report(target, { isIntersecting: false, top: 0, bottom: 0 });

    expect(stickyBar.getAttribute('data-open')).toBe('false');
  });
});

describe('StickyInstallBar actions', () => {
  it('reports its click under the sticky-bar placement', async () => {
    setUserAgent(ANDROID_CHROME);
    renderPage();
    await waitForBar();
    scrollPastHero();

    fireEvent.click(screen.getByRole('link', { name: LABELS.ctaAria.android }));

    expect(track).toHaveBeenCalledWith('App Install Click', {
      platform: 'android',
      source: 'google-play',
      placement: 'sticky-bar',
      mode: 'install',
    });
  });

  it('names the desktop code in its link after a scan', async () => {
    setUserAgent(ANDROID_CHROME);
    window.history.replaceState(null, '', '/b/the-kilter/40/view/abc?src=qr&medium=desktop');
    renderPage();
    await waitForBar();
    scrollPastHero();

    await waitFor(() =>
      expect(screen.getByRole('link', { name: LABELS.ctaAria.android }).getAttribute('href')).toBe(
        buildStoreUrl('android', { placement: 'sticky-bar', qrMedium: 'desktop' }),
      ),
    );
  });

  it('stays dismissed for the rest of the visit, in memory only', async () => {
    setUserAgent(ANDROID_CHROME);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { unmount } = renderPage();
    await waitForBar();
    scrollPastHero();

    fireEvent.click(screen.getByRole('button', { name: LABELS.dismiss }));
    expect(bar()).toBeNull();

    // Another climb, same visit.
    unmount();
    renderPage();
    await act(async () => {});
    expect(bar()).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
});
