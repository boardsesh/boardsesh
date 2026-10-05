import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { act, renderHook } from '@testing-library/react';
import { __resetSessionInboundCampaignForTests } from '@/app/lib/inbound-campaign';
import { buildStoreUrl } from '@/app/lib/store-links';
import { useInboundCampaign } from '../use-inbound-campaign';

function StoreLink() {
  const inboundCampaign = useInboundCampaign();
  return <a href={buildStoreUrl('android', { placement: 'climb-view', inbound: inboundCampaign })}>Get the app</a>;
}

describe('useInboundCampaign', () => {
  beforeEach(() => {
    __resetSessionInboundCampaignForTests();
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
    __resetSessionInboundCampaignForTests();
    document.body.innerHTML = '';
  });

  it('returns the campaign the visit landed with', () => {
    window.history.replaceState(null, '', '/?utm_source=instagram&utm_medium=social');

    const { result } = renderHook(() => useInboundCampaign());

    expect(result.current).toEqual({ utm_source: 'instagram', utm_medium: 'social' });
  });

  it('returns null for an untagged visit', () => {
    window.history.replaceState(null, '', '/gyms');

    const { result } = renderHook(() => useInboundCampaign());

    expect(result.current).toBeNull();
  });

  it('renders the untagged link on the server even when the request URL is tagged', () => {
    // Climb pages are served from a shared CDN cache: the HTML has to be the
    // same for every visitor, so a campaign must never reach the server render.
    window.history.replaceState(null, '', '/?utm_source=instagram');

    const serverHtml = renderToString(<StoreLink />);

    expect(serverHtml).toContain('utm_source=boardsesh');
    expect(serverHtml).not.toContain('instagram');
  });

  it('upgrades the server-rendered link after hydration, without a mismatch', async () => {
    window.history.replaceState(null, '', '/?utm_source=instagram&utm_campaign=spray-launch');
    const container = document.createElement('div');
    container.innerHTML = renderToString(<StoreLink />);
    document.body.appendChild(container);
    const recoverableErrors: unknown[] = [];

    await act(async () => {
      hydrateRoot(container, <StoreLink />, {
        onRecoverableError: (error) => {
          recoverableErrors.push(error);
        },
      });
    });

    const href = container.querySelector('a')?.getAttribute('href') ?? '';
    const referrer = new URLSearchParams(new URL(href).searchParams.get('referrer') ?? '');
    expect(referrer.get('utm_source')).toBe('instagram');
    expect(referrer.get('utm_campaign')).toBe('spray-launch');
    expect(referrer.get('utm_content')).toBe('climb-view');
    expect(recoverableErrors).toEqual([]);
  });
});
