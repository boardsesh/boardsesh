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
  install: 'Get the free app',
  update: 'Update the app',
  installAria: { ios: 'Get the free app on the App Store', android: 'Get the free app on Google Play' },
};

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
  if (!wrapperElement) throw new Error('no store button rendered');
  return wrapperElement;
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
  ])('ships both untagged store links and no data-store when %s asked', (_requester, userAgent) => {
    const html = renderToString(
      <MarketingPreviewProvider initialBrowser={classifyMarketingBrowser(userAgent)}>
        <MobileStorePrimary placement="climb-view" labels={LABELS} qrLanding="climb" />
      </MarketingPreviewProvider>,
    );

    expect(html).not.toContain('data-store=');
    expect(html).toContain(`href="${buildStoreUrl('ios', { placement: 'climb-view' }).replaceAll('&', '&amp;')}"`);
    expect(html).toContain(`href="${buildStoreUrl('android', { placement: 'climb-view' }).replaceAll('&', '&amp;')}"`);
    expect(html).toContain('data-store-link="ios"');
    expect(html).toContain('data-store-link="android"');
    expect(html.match(/>Get the free app</g)).toHaveLength(2);
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

  it('keeps both anchors in the DOM either way, so the swap cannot shift anything', async () => {
    setUserAgent(ANDROID_UA);
    render(<MobileStorePrimary placement="climb-view" labels={LABELS} />);
    await waitFor(() => expect(wrapper().getAttribute('data-store')).toBe('android'));

    expect(wrapper().querySelector('[data-store-link="ios"]')?.getAttribute('aria-label')).toBe(
      'Get the free app on the App Store',
    );
    // Only the chosen store is visible: the other one is `display: none` in the same cell.
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('aria-label'))).toEqual([
      'Get the free app on Google Play',
    ]);
  });

  it('reports the click with its store, placement and mode', async () => {
    setUserAgent(ANDROID_UA);
    render(<MobileStorePrimary placement="climb-view" labels={LABELS} />);
    await waitFor(() => expect(wrapper().getAttribute('data-store')).toBe('android'));

    fireEvent.click(screen.getByRole('link', { name: 'Get the free app on Google Play' }));

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

    const appStoreLink = screen.getByRole('link', { name: 'Get the free app on the App Store' });
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

  it('carries the campaign the visit landed with', async () => {
    setUserAgent(ANDROID_UA);
    window.history.replaceState(null, '', '/b/the-kilter/40/view/abc?utm_source=instagram&utm_medium=social');
    render(<MobileStorePrimary placement="climb-view" labels={LABELS} />);

    const playLink = screen.getByRole('link', { name: 'Get the free app on Google Play' });
    await waitFor(() => expect(playLink.getAttribute('href')).toContain('instagram'));
  });

  it('asks a retired native app for an update instead', async () => {
    capacitor.native = true;
    setUserAgent(IPHONE_UA);
    render(<MobileStorePrimary placement="climb-view" labels={LABELS} />);

    await waitFor(() => expect(screen.getAllByText('Update the app')).toHaveLength(2));
    expect(wrapper().getAttribute('data-store')).toBe('ios');
  });
});
