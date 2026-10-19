import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { buildStoreUrl } from '@/app/lib/store-links';
import { __resetSessionInboundCampaignForTests } from '@/app/lib/inbound-campaign';

const trackBeforeNavigation = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/app/lib/analytics', () => ({ track: vi.fn(), trackBeforeNavigation }));

const { default: SessionInviteInstallCta, SESSION_INVITE_CAMPAIGN } = await import('../session-invite-install-cta');

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
const PLAY = 'Get it on Google Play';
const APP_STORE = 'Download on the App Store';

function renderCta(options: { sessionId?: string } = { sessionId: SESSION_ID }) {
  render(<SessionInviteInstallCta sessionId={options.sessionId} googlePlayLabel={PLAY} appStoreLabel={APP_STORE} />);
}

function anchorFor(label: string): HTMLAnchorElement | null {
  return screen.getByText(label).closest('a');
}

/** What the app reads back from Play: the `referrer` param, split as a query string. */
function installReferrer(): URLSearchParams {
  const href = anchorFor(PLAY)?.getAttribute('href') ?? '';
  return new URLSearchParams(new URL(href).searchParams.get('referrer') ?? '');
}

beforeEach(() => {
  trackBeforeNavigation.mockClear();
  window.history.replaceState(null, '', `/join/${SESSION_ID}`);
  __resetSessionInboundCampaignForTests();
});

describe('SessionInviteInstallCta', () => {
  it('renders both stores as real anchors built by the shared store link builder', () => {
    renderCta();

    const storeLink = { placement: 'join-page', campaign: SESSION_INVITE_CAMPAIGN, linkDetail: SESSION_ID } as const;
    expect(anchorFor(PLAY)?.getAttribute('href')).toBe(buildStoreUrl('android', storeLink));
    expect(anchorFor(APP_STORE)?.getAttribute('href')).toBe(buildStoreUrl('ios', storeLink));
  });

  it('puts the session id in the Play referrer utm_content, under the join-page placement', () => {
    renderCta();

    const referrer = installReferrer();
    expect(referrer.get('utm_content')).toBe(`join-page.${SESSION_ID}`);
    expect(referrer.get('utm_campaign')).toBe('session-invite');
    expect(referrer.get('utm_source')).toBe('boardsesh');
    expect(referrer.get('utm_medium')).toBe('web');
  });

  it('keeps the session id out of the App Store link', () => {
    renderCta();

    const href = anchorFor(APP_STORE)?.getAttribute('href') ?? '';
    expect(new URL(href).searchParams.get('ct')).toBe('join-page');
    expect(href).not.toContain(SESSION_ID);
  });

  it('names only the placement when the page has no real session to name', () => {
    renderCta({});

    expect(installReferrer().get('utm_content')).toBe('join-page');
  });

  it('opens both stores in a new tab without leaking the opener', () => {
    renderCta();

    for (const label of [PLAY, APP_STORE]) {
      expect(anchorFor(label)?.getAttribute('target')).toBe('_blank');
      expect(anchorFor(label)?.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('fires App Install Click through the flushing tracker, with the placement and the session', () => {
    renderCta();

    fireEvent.click(screen.getByText(PLAY));
    expect(trackBeforeNavigation).toHaveBeenLastCalledWith('App Install Click', {
      platform: 'android',
      source: 'google-play',
      placement: 'join-page',
      sessionId: SESSION_ID,
    });

    fireEvent.click(screen.getByText(APP_STORE));
    expect(trackBeforeNavigation).toHaveBeenLastCalledWith('App Install Click', {
      platform: 'ios',
      source: 'app-store',
      placement: 'join-page',
      sessionId: SESSION_ID,
    });
  });

  it('omits the session from the click when there is none', () => {
    renderCta({});

    fireEvent.click(screen.getByText(PLAY));
    expect(trackBeforeNavigation).toHaveBeenLastCalledWith('App Install Click', {
      platform: 'android',
      source: 'google-play',
      placement: 'join-page',
    });
  });

  it('never blocks the navigation the anchor performs', () => {
    renderCta();

    const anchor = anchorFor(PLAY);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor?.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });

  it("carries a tagged visitor's source into the link after hydration, keeping the session", () => {
    window.history.replaceState(null, '', `/join/${SESSION_ID}?utm_source=whatsapp`);
    __resetSessionInboundCampaignForTests();
    renderCta();

    const referrer = installReferrer();
    expect(referrer.get('utm_source')).toBe('whatsapp');
    expect(referrer.get('utm_content')).toBe(`join-page.${SESSION_ID}`);
  });
});
