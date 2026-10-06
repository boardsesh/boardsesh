import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { __resetSessionInboundCampaignForTests } from '@/app/lib/inbound-campaign';
import { buildStoreUrl } from '@/app/lib/store-links';

const track = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/analytics', () => ({ track }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/app/lib/ble/capacitor-utils', () => ({
  isNativeApp: () => false,
  isCapacitorWebView: () => false,
  waitForCapacitor: () => Promise.resolve(false),
}));

const MarketingInstallLinks = (await import('../marketing-install-links')).default;

const ORIGINAL_UA = navigator.userAgent;
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

function setUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
}

describe('MarketingInstallLinks', () => {
  beforeEach(() => {
    track.mockReset();
    __resetSessionInboundCampaignForTests();
    setUserAgent(ANDROID_UA);
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
    __resetSessionInboundCampaignForTests();
    setUserAgent(ORIGINAL_UA);
  });

  it('points the store button at a link that names its placement', async () => {
    render(<MarketingInstallLinks placement="help" />);

    const playLink = await screen.findByRole('link', { name: 'home.hero.ctaInstallAndroid' });

    expect(playLink.getAttribute('href')).toBe(buildStoreUrl('android', { placement: 'help' }));
    expect(playLink.getAttribute('href')).toContain('utm_content=help');
  });

  it('sends the placement with the click', async () => {
    // /help sent no placement before #6027, so its clicks could not be told
    // from any other unplaced click.
    render(<MarketingInstallLinks placement="help" />);

    fireEvent.click(await screen.findByRole('link', { name: 'home.hero.ctaInstallAndroid' }));

    expect(track).toHaveBeenCalledWith('App Install Click', {
      platform: 'android',
      source: 'google-play',
      placement: 'help',
      mode: 'install',
    });
  });

  it('uses the placement it is given, so each surface gets its own link id', async () => {
    render(<MarketingInstallLinks placement="gyms-directory" />);

    const playLink = await screen.findByRole('link', { name: 'home.hero.ctaInstallAndroid' });

    expect(playLink.getAttribute('href')).toBe(buildStoreUrl('android', { placement: 'gyms-directory' }));
  });

  it("carries a tagged visitor's source into the store link", async () => {
    window.history.replaceState(null, '', '/help?utm_source=reddit&utm_medium=social');
    render(<MarketingInstallLinks placement="help" />);

    const playLink = await screen.findByRole('link', { name: 'home.hero.ctaInstallAndroid' });
    const referrer = new URLSearchParams(
      new URL(playLink.getAttribute('href') ?? '').searchParams.get('referrer') ?? '',
    );

    expect(referrer.get('utm_source')).toBe('reddit');
    expect(referrer.get('utm_medium')).toBe('social');
    expect(referrer.get('utm_content')).toBe('help');
  });
});
