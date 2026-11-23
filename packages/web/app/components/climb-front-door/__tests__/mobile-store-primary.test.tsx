import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { __resetSessionInboundCampaignForTests } from '@/app/lib/inbound-campaign';
import { __resetQrLandingForTests } from '@/app/lib/qr-landing';
import { buildStoreUrl } from '@/app/lib/store-links';
import { classifyMarketingBrowser } from '@/app/lib/marketing-platform';
import { MarketingPreviewProvider } from '@/app/components/marketing/marketing-preview-provider';

const track = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/analytics', () => ({ track }));

const capacitor = vi.hoisted(() => ({ native: false }));
vi.mock('@/app/lib/ble/capacitor-utils', () => ({
  isNativeApp: () => capacitor.native,
  isCapacitorWebView: () => false,
  waitForCapacitor: () => Promise.resolve(false),
}));

const MobileStorePrimary = (await import('../mobile-store-primary')).default;

const LABELS = {
  ios: 'Download on the App Store',
  android: 'Get it on Google Play',
  update: 'Update the app',
  locale: 'en-US',
} as const;

const ORIGINAL_UA = navigator.userAgent;
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function setUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
}

function wrapper(): HTMLElement {
  const wrapperElement = document.querySelector('[data-store-link]')?.parentElement;
  if (!wrapperElement) throw new Error('no store link rendered');
  return wrapperElement;
}

/** The server HTML as a document, so the assertions can read the badges' attributes. */
function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
}

function badgeImage(root: ParentNode, store: 'ios' | 'android'): HTMLImageElement | null {
  return root.querySelector(`a[data-store-link="${store}"] > img`);
}

beforeEach(() => {
  track.mockReset();
  capacitor.native = false;
  __resetSessionInboundCampaignForTests();
  __resetQrLandingForTests();
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
  __resetSessionInboundCampaignForTests();
  setUserAgent(ORIGINAL_UA);
});

describe('MobileStorePrimary on the server', () => {
  // The climb page is stored at the edge for everyone; the request's user agent
  // must not pick the store in its HTML.
  it.each([
    ['an iPhone', IPHONE_UA],
    ['an Android phone', ANDROID_UA],
    ['a desktop', DESKTOP_UA],
    ['no user agent at all', ''],
  ])('ships both untagged store badges and no data-store when %s asked', (_requester, userAgent) => {
    const html = renderToString(
      <MarketingPreviewProvider initialBrowser={classifyMarketingBrowser(userAgent)}>
        <MobileStorePrimary placement="climb-view" labels={LABELS} qrLanding="climb" />
      </MarketingPreviewProvider>,
    );
    const page = parseHtml(html);

    expect(html).not.toContain('data-store=');
    expect(page.querySelector('a[data-store-link="ios"]')?.getAttribute('href')).toBe(
      buildStoreUrl('ios', { placement: 'climb-view' }),
    );
    expect(page.querySelector('a[data-store-link="android"]')?.getAttribute('href')).toBe(
      buildStoreUrl('android', { placement: 'climb-view' }),
    );
    // Both anchors are badges, named for anything that looks for the page's badges.
    expect(
      [...page.querySelectorAll('a[data-store-badge]')].map((link) => link.getAttribute('data-store-badge')),
    ).toEqual(['ios', 'android']);
    expect(badgeImage(page, 'ios')?.getAttribute('alt')).toBe('Download on the App Store');
    expect(badgeImage(page, 'android')?.getAttribute('alt')).toBe('Get it on Google Play');
    // No text button: the badge is the store link, and it carries no aria-label over its alt text.
    expect(page.querySelector('.MuiButton-root')).toBeNull();
    expect(page.querySelector('[aria-label]')).toBeNull();
  });

  it('ships both badges black at the lone 48px: CSS shows only one, but the page has other store badges', () => {
    const page = parseHtml(renderToString(<MobileStorePrimary placement="climb-view" labels={LABELS} />));

    // Black, not white: the climb page's app module and the list's QR card show
    // another store pair, and Apple allows white only for the page's one badge.
    expect(badgeImage(page, 'ios')?.getAttribute('src')).toBe('/images/store-badges/app-store-black-en-US.svg');
    expect(badgeImage(page, 'android')?.getAttribute('src')).toBe('/images/store-badges/google-play-en-US.svg');
    for (const store of ['ios', 'android'] as const) {
      expect(badgeImage(page, store)?.getAttribute('height')).toBe('48');
      // Lazy: an eager image would make React add a preload for each badge.
      expect(badgeImage(page, store)?.getAttribute('loading')).toBe('lazy');
    }
  });

  it("shows the badges in the page's language", () => {
    const page = parseHtml(
      renderToString(<MobileStorePrimary placement="climb-view" labels={{ ...LABELS, locale: 'de' }} />),
    );

    expect(badgeImage(page, 'ios')?.getAttribute('src')).toBe('/images/store-badges/app-store-black-de.svg');
    expect(badgeImage(page, 'android')?.getAttribute('src')).toBe('/images/store-badges/google-play-de.svg');
  });

  it('never carries the scanned medium in the server HTML', () => {
    window.history.replaceState(null, '', '/b/the-kilter/40/view/abc?src=qr&medium=desktop');

    const html = renderToString(<MobileStorePrimary placement="climb-view" labels={LABELS} qrLanding="climb" />);

    expect(html).not.toContain('climb-view.desktop');
  });
});

describe('MobileStorePrimary after mount', () => {
  it('names Google Play on an Android phone', async () => {
    setUserAgent(ANDROID_UA);
    render(<MobileStorePrimary placement="climb-view" labels={LABELS} />);

    await waitFor(() => expect(wrapper().getAttribute('data-store')).toBe('android'));
  });

  it('names the App Store on an iPhone', async () => {
    setUserAgent(IPHONE_UA);
    render(<MobileStorePrimary placement="climb-view" labels={LABELS} />);

    await waitFor(() => expect(wrapper().getAttribute('data-store')).toBe('ios'));
  });

  it('keeps both badges, unchanged, in the DOM either way, so the swap cannot shift anything', async () => {
    setUserAgent(ANDROID_UA);
    render(<MobileStorePrimary placement="climb-view" labels={LABELS} />);
    await waitFor(() => expect(wrapper().getAttribute('data-store')).toBe('android'));

    // Mount changes nothing but `data-store`: same artwork, same size.
    expect(badgeImage(wrapper(), 'ios')?.getAttribute('src')).toBe('/images/store-badges/app-store-black-en-US.svg');
    expect(badgeImage(wrapper(), 'ios')?.getAttribute('height')).toBe('48');
    expect(badgeImage(wrapper(), 'android')?.getAttribute('height')).toBe('48');
    // Only the chosen store is visible: the other one is `display: none` in the same cell.
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('data-store-badge'))).toEqual(['android']);
  });

  it('reports the click with its store, placement and mode', async () => {
    setUserAgent(ANDROID_UA);
    render(<MobileStorePrimary placement="climb-view" labels={LABELS} />);
    await waitFor(() => expect(wrapper().getAttribute('data-store')).toBe('android'));

    const playLink = screen.getByRole('link', { name: 'Get it on Google Play' });
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    playLink.dispatchEvent(clickEvent);

    // The handler adds the event and nothing else: the anchor still navigates.
    expect(clickEvent.defaultPrevented).toBe(false);
    expect(track).toHaveBeenCalledWith('App Install Click', {
      platform: 'android',
      source: 'google-play',
      placement: 'climb-view',
      mode: 'install',
    });
  });

  it('names the desktop code in the link id and on the click after a scan', async () => {
    setUserAgent(IPHONE_UA);
    window.history.replaceState(null, '', '/b/the-kilter/40/view/abc?src=qr&medium=desktop');
    render(<MobileStorePrimary placement="climb-view" labels={LABELS} qrLanding="climb" />);

    const appStoreLink = screen.getByRole('link', { name: 'Download on the App Store' });
    await waitFor(() =>
      expect(appStoreLink.getAttribute('href')).toBe(
        buildStoreUrl('ios', { placement: 'climb-view', qrMedium: 'desktop' }),
      ),
    );
    fireEvent.click(appStoreLink);

    expect(track).toHaveBeenCalledWith('App Install Click', {
      platform: 'ios',
      source: 'app-store',
      placement: 'climb-view',
      mode: 'install',
      qrMedium: 'desktop',
    });
  });

  it('leaves the CSS guess standing on a desktop window under md, so no badge swaps at hydration', async () => {
    // A desktop names both stores. Picking the first (the App Store) would swap
    // the Google Play badge the CSS showed for a different badge of a different width.
    setUserAgent(DESKTOP_UA);
    window.history.replaceState(null, '', '/b/the-kilter/40/view/abc?utm_source=instagram');
    render(<MobileStorePrimary placement="climb-view" labels={LABELS} />);

    // The tagged link arrives after mount, so this waits for the mounted render.
    const playLink = screen.getByRole('link', { name: 'Get it on Google Play' });
    await waitFor(() => expect(playLink.getAttribute('href')).toContain('instagram'));
    expect(wrapper().hasAttribute('data-store')).toBe(false);
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('data-store-badge'))).toEqual(['android']);
  });

  it('carries the campaign the visit landed with', async () => {
    setUserAgent(ANDROID_UA);
    window.history.replaceState(null, '', '/b/the-kilter/40/view/abc?utm_source=instagram&utm_medium=social');
    render(<MobileStorePrimary placement="climb-view" labels={LABELS} />);

    const playLink = screen.getByRole('link', { name: 'Get it on Google Play' });
    await waitFor(() => expect(playLink.getAttribute('href')).toContain('instagram'));
  });

  it('asks a retired native app for an update with a text button, not a download badge', async () => {
    capacitor.native = true;
    setUserAgent(IPHONE_UA);
    render(<MobileStorePrimary placement="climb-view" labels={LABELS} />);

    await waitFor(() => expect(screen.getAllByText('Update the app')).toHaveLength(2));
    expect(wrapper().getAttribute('data-store')).toBe('ios');
    expect(wrapper().querySelector('img')).toBeNull();
    expect(wrapper().querySelector('[data-store-badge]')).toBeNull();

    const updateLink = screen.getByRole('link', { name: 'Update the app' });
    expect(updateLink.className).toContain('MuiButton-contained');
    expect(updateLink.getAttribute('href')).toBe(buildStoreUrl('ios', { placement: 'climb-view' }));
    fireEvent.click(updateLink);
    expect(track).toHaveBeenCalledWith('App Install Click', {
      platform: 'ios',
      source: 'app-store',
      placement: 'climb-view',
      mode: 'update',
    });
  });
});
