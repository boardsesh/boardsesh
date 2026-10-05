import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { __resetSessionInboundCampaignForTests } from '@/app/lib/inbound-campaign';
import { buildStoreUrl } from '@/app/lib/store-links';

const track = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/analytics', () => ({ track }));

vi.mock('@/app/lib/ble/capacitor-utils', () => ({
  isNativeApp: () => false,
  isCapacitorWebView: () => false,
  waitForCapacitor: () => Promise.resolve(false),
}));

const StoreInstallButtons = (await import('../store-install-buttons')).default;

const LABELS = { ios: 'App Store', android: 'Google Play', update: 'Update' };

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

describe('StoreInstallButtons', () => {
  beforeEach(() => {
    track.mockReset();
    __resetSessionInboundCampaignForTests();
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
    __resetSessionInboundCampaignForTests();
    setUserAgent(ORIGINAL_UA);
  });

  it('shows Google Play alone on an Android phone', async () => {
    setUserAgent(ANDROID_UA);
    render(<StoreInstallButtons placement="climb-view" labels={LABELS} />);

    const playLink = await screen.findByRole('link', { name: 'Google Play' });

    expect(playLink.getAttribute('href')).toBe(buildStoreUrl('android', { placement: 'climb-view' }));
    expect(screen.queryByRole('link', { name: 'App Store' })).toBeNull();
  });

  it('shows the App Store alone on an iPhone', async () => {
    setUserAgent(IPHONE_UA);
    render(<StoreInstallButtons placement="climb-view" labels={LABELS} />);

    const appStoreLink = await screen.findByRole('link', { name: 'App Store' });

    expect(appStoreLink.getAttribute('href')).toBe(buildStoreUrl('ios', { placement: 'climb-view' }));
    expect(new URL(appStoreLink.getAttribute('href') ?? '').searchParams.get('ct')).toBe('climb-view');
    expect(screen.queryByRole('link', { name: 'Google Play' })).toBeNull();
  });

  it('shows both stores on a desktop, which has no phone to infer', async () => {
    setUserAgent(DESKTOP_UA);
    render(<StoreInstallButtons placement="gyms-directory" labels={LABELS} />);

    const playLink = await screen.findByRole('link', { name: 'Google Play' });

    expect(playLink.getAttribute('href')).toBe(buildStoreUrl('android', { placement: 'gyms-directory' }));
    expect(screen.getByRole('link', { name: 'App Store' }).getAttribute('href')).toBe(
      buildStoreUrl('ios', { placement: 'gyms-directory' }),
    );
  });

  it('opens the store in a new tab, so the page and its click event survive', async () => {
    setUserAgent(ANDROID_UA);
    render(<StoreInstallButtons placement="climb-list" labels={LABELS} />);

    const playLink = await screen.findByRole('link', { name: 'Google Play' });

    expect(playLink.getAttribute('target')).toBe('_blank');
    expect(playLink.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('sends the click with the same placement the link carries', async () => {
    setUserAgent(ANDROID_UA);
    render(<StoreInstallButtons placement="spray-climb" labels={LABELS} />);

    const playLink = await screen.findByRole('link', { name: 'Google Play' });
    fireEvent.click(playLink);

    expect(track).toHaveBeenCalledWith('App Install Click', {
      platform: 'android',
      source: 'google-play',
      placement: 'spray-climb',
      mode: 'install',
    });
    expect(playLink.getAttribute('href')).toContain('utm_content=spray-climb');
  });

  it("carries a tagged visitor's source into the link, and keeps the link id ours", async () => {
    setUserAgent(ANDROID_UA);
    window.history.replaceState(null, '', '/kilter/x?utm_source=chatgpt.com&utm_content=theirs');
    render(<StoreInstallButtons placement="climb-view" labels={LABELS} />);

    const playLink = await screen.findByRole('link', { name: 'Google Play' });
    const referrer = new URLSearchParams(
      new URL(playLink.getAttribute('href') ?? '').searchParams.get('referrer') ?? '',
    );

    expect(referrer.get('utm_source')).toBe('chatgpt.com');
    expect(referrer.get('utm_content')).toBe('climb-view');
  });

  it('weighs both stores the same in the plain appearance', async () => {
    // Beside a filled primary action the store buttons are both outlined, so a
    // desktop reader is not steered to one store over the other.
    setUserAgent(DESKTOP_UA);
    render(<StoreInstallButtons placement="climb-view" labels={LABELS} appearance="plain" align="start" />);

    await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(2));

    for (const link of screen.getAllByRole('link')) {
      expect(link.className).toContain('MuiButton-outlined');
      expect(link.className).not.toContain('MuiButton-contained');
    }
  });

  it('fills the first store only in the brand appearance', async () => {
    setUserAgent(DESKTOP_UA);
    render(<StoreInstallButtons placement="help" labels={LABELS} />);

    await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(2));
    const [firstLink, secondLink] = screen.getAllByRole('link');

    expect(firstLink.className).toContain('MuiButton-contained');
    expect(secondLink.className).toContain('MuiButton-outlined');
  });
});
