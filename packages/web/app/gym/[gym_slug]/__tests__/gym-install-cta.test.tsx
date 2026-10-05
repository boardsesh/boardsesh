import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { GymQrMedium } from '@boardsesh/analytics';
import { buildStoreUrl } from '@/app/lib/store-links';
import { __resetSessionInboundCampaignForTests } from '@/app/lib/inbound-campaign';

const track = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/analytics', () => ({ track }));

const GymInstallCta = (await import('../gym-install-cta')).default;

function renderCta(gymSlug = 'boulderwelt-munich', qrMedium: GymQrMedium | null = null) {
  render(
    <GymInstallCta
      gymSlug={gymSlug}
      qrMedium={qrMedium}
      googlePlayLabel="Get it on Google Play"
      appStoreLabel="Get it on the App Store"
    />,
  );
}

/** What the app reads back from Play: the `referrer` param, split as a query string. */
function installReferrer(label: string): URLSearchParams {
  const href = anchorFor(label)?.getAttribute('href') ?? '';
  return new URLSearchParams(new URL(href).searchParams.get('referrer') ?? '');
}

function anchorFor(label: string): HTMLAnchorElement | null {
  return screen.getByText(label).closest('a');
}

beforeEach(() => {
  track.mockReset();
  window.history.replaceState(null, '', '/gym/boulderwelt-munich');
  __resetSessionInboundCampaignForTests();
});

describe('GymInstallCta', () => {
  it('renders both stores as real anchors so the server HTML is complete', () => {
    // No platform sniffing: an effect that picks one store leaves a crawler
    // (and anyone reading before hydration) with zero install links.
    renderCta();

    const storeLink = { placement: 'gym-page', gymSlug: 'boulderwelt-munich' } as const;
    expect(anchorFor('Get it on Google Play')?.getAttribute('href')).toBe(buildStoreUrl('android', storeLink));
    expect(anchorFor('Get it on the App Store')?.getAttribute('href')).toBe(buildStoreUrl('ios', storeLink));
  });

  it('opens both stores in a new tab without leaking the opener', () => {
    renderCta();

    for (const label of ['Get it on Google Play', 'Get it on the App Store']) {
      const anchor = anchorFor(label);
      expect(anchor?.getAttribute('target')).toBe('_blank');
      expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('gives both stores the same button weight', () => {
    // `App Install Click` exists to be broken down by platform (PH-13). A filled
    // Play button beside an outlined App Store one would tilt the very split
    // this CTA was built to measure, so the variants have to match.
    renderCta();

    const playClasses = anchorFor('Get it on Google Play')?.className ?? '';
    const appStoreClasses = anchorFor('Get it on the App Store')?.className ?? '';
    expect(playClasses).toContain('MuiButton-contained');
    expect(appStoreClasses).toContain('MuiButton-contained');
    expect(playClasses).not.toContain('MuiButton-outlined');
    expect(appStoreClasses).not.toContain('MuiButton-outlined');
  });

  it('fires App Install Click with the gym-page placement and slug for Play', () => {
    renderCta();

    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchorFor('Get it on Google Play')?.dispatchEvent(clickEvent);

    // The handler adds the event and nothing else — the anchor still navigates,
    // so middle-click and "copy link address" behave as they always did.
    expect(clickEvent.defaultPrevented).toBe(false);
    expect(track).toHaveBeenCalledWith('App Install Click', {
      platform: 'android',
      source: 'google-play',
      placement: 'gym-page',
      gymSlug: 'boulderwelt-munich',
    });
  });

  it('fires App Install Click with the gym-page placement and slug for the App Store', () => {
    renderCta();

    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchorFor('Get it on the App Store')?.dispatchEvent(clickEvent);

    expect(clickEvent.defaultPrevented).toBe(false);
    // `source` keeps its historic value — PH-13 breaks the install funnel down
    // by it, and that number has to stay comparable across this change.
    expect(track).toHaveBeenCalledWith('App Install Click', {
      platform: 'ios',
      source: 'app-store',
      placement: 'gym-page',
      gymSlug: 'boulderwelt-munich',
    });
  });

  it('calls a click on the page web, not qr', () => {
    // Every gym-page link used to say `utm_medium=qr`, scan or no scan, so a
    // poster could not be measured against the page it points at (#6027).
    renderCta();

    const referrer = installReferrer('Get it on Google Play');
    expect(referrer.get('utm_medium')).toBe('web');
    expect(referrer.get('utm_content')).toBe('gym-page');
    expect(referrer.get('utm_campaign')).toBe('gym-boulderwelt-munich');
  });

  it('calls a click after a poster scan qr, on both stores', () => {
    renderCta('boulderwelt-munich', 'poster');

    const referrer = installReferrer('Get it on Google Play');
    expect(referrer.get('utm_medium')).toBe('qr');
    expect(referrer.get('utm_content')).toBe('gym-page.poster');
    expect(referrer.get('utm_campaign')).toBe('gym-boulderwelt-munich');

    const appStoreUrl = new URL(anchorFor('Get it on the App Store')?.getAttribute('href') ?? '');
    expect(appStoreUrl.searchParams.get('ct')).toBe('gym-page.poster');
  });

  it('adds the printed medium to the click after a scan, on both stores', () => {
    renderCta('boulderwelt-munich', 'poster');

    anchorFor('Get it on Google Play')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    anchorFor('Get it on the App Store')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(track).toHaveBeenNthCalledWith(1, 'App Install Click', {
      platform: 'android',
      source: 'google-play',
      placement: 'gym-page',
      gymSlug: 'boulderwelt-munich',
      qrMedium: 'poster',
    });
    expect(track).toHaveBeenNthCalledWith(2, 'App Install Click', {
      platform: 'ios',
      source: 'app-store',
      placement: 'gym-page',
      gymSlug: 'boulderwelt-munich',
      qrMedium: 'poster',
    });
  });

  it('gives the App Store link a campaign token shared by every gym', () => {
    // One token per kind of link, never per gym: App Analytics hides a campaign
    // under 5 first-time downloads.
    renderCta();

    const appStoreUrl = new URL(anchorFor('Get it on the App Store')?.getAttribute('href') ?? '');
    expect(appStoreUrl.searchParams.get('ct')).toBe('gym-page');
    expect(appStoreUrl.searchParams.get('mt')).toBe('8');
  });

  it("keeps a tagged visitor's source, and the gym as the campaign", () => {
    // A gym linking its page from its Instagram bio.
    window.history.replaceState(null, '', '/gym/boulderwelt-munich?utm_source=instagram&utm_medium=social');
    renderCta();

    const referrer = installReferrer('Get it on Google Play');
    expect(referrer.get('utm_source')).toBe('instagram');
    expect(referrer.get('utm_medium')).toBe('social');
    expect(referrer.get('utm_campaign')).toBe('gym-boulderwelt-munich');
    expect(referrer.get('utm_content')).toBe('gym-page');
  });

  it('names the campaign after the slug it was given', () => {
    renderCta('vertical-life-wien');

    expect(anchorFor('Get it on Google Play')?.getAttribute('href')).toContain('utm_campaign=gym-vertical-life-wien');
  });
});
