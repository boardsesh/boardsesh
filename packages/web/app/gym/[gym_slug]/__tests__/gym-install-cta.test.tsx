import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { IOS_APP_STORE_URL } from '@/app/lib/store-urls';
import { playStoreUrlForGym } from '@/app/lib/gym-attribution';

const track = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/analytics', () => ({ track }));

const GymInstallCta = (await import('../gym-install-cta')).default;

function renderCta(gymSlug = 'boulderwelt-munich') {
  render(
    <GymInstallCta gymSlug={gymSlug} googlePlayLabel="Get it on Google Play" appStoreLabel="Get it on the App Store" />,
  );
}

function anchorFor(label: string): HTMLAnchorElement | null {
  return screen.getByText(label).closest('a');
}

beforeEach(() => {
  track.mockReset();
});

describe('GymInstallCta', () => {
  it('renders both stores as real anchors so the server HTML is complete', () => {
    // No platform sniffing: an effect that picks one store leaves a crawler
    // (and anyone reading before hydration) with zero install links.
    renderCta();

    expect(anchorFor('Get it on Google Play')?.getAttribute('href')).toBe(playStoreUrlForGym('boulderwelt-munich'));
    expect(anchorFor('Get it on the App Store')?.getAttribute('href')).toBe(IOS_APP_STORE_URL);
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

  it('leaves the App Store URL free of attribution params', () => {
    // iOS attribution is explicitly out of scope (#3402), and Apple has no
    // Install Referrer equivalent to read them back.
    renderCta();

    expect(anchorFor('Get it on the App Store')?.getAttribute('href')).toBe(IOS_APP_STORE_URL);
  });

  it('names the campaign after the slug it was given', () => {
    renderCta('vertical-life-wien');

    expect(anchorFor('Get it on Google Play')?.getAttribute('href')).toContain('utm_campaign=gym-vertical-life-wien');
  });
});
