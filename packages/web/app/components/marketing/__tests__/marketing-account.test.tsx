import React from 'react';
import { act, cleanup, render, renderHook, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { BrowserSessionContextValue } from '../../providers/session-provider';
import MarketingAccountControls from '../marketing-account-controls';
import {
  clearMarketingSession,
  publishMarketingConsentTransport,
  publishMarketingSession,
  useMarketingSession,
} from '../marketing-session-store';
import { ConsentStateProvider, useConsent } from '../../consent/consent-state-provider';
import { serializeConsentCookieValue, type ConsentRecord } from '@boardsesh/consent';

const journey = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('@/app/lib/website-journey-analytics', () => ({
  trackWebsiteJourneyLinkClick: (_click: unknown, event: unknown) => journey.track(event),
}));

vi.mock('../../i18n/locale-link', () => ({
  default: ({ children, href, onClick, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href={href}
      {...props}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock('@/app/lib/consent-pending-db', () => ({
  loadPendingConsent: async () => null,
  persistPendingConsent: async () => {},
}));

const update = async () => null;
function authenticated(login: string): BrowserSessionContextValue {
  return {
    data: { user: { id: 'climber-1' }, expires: '2030-01-01T00:00:00.000Z', authSessionId: login },
    status: 'authenticated',
    update,
  };
}
const grantedRecord: ConsentRecord = {
  analytics: 'granted',
  version: 1,
  source: 'web',
  decidedAt: '2026-11-25T00:00:00.000Z',
};

beforeEach(() => {
  clearMarketingSession();
  journey.track.mockClear();
});
afterEach(() => {
  cleanup();
  clearMarketingSession();
  document.cookie = 'boardsesh-consent=; Max-Age=0; Path=/';
});

describe('asynchronous marketing account boundary', () => {
  it('keeps a usable account link before resolving the guarded session', () => {
    render(<MarketingAccountControls labels={{ signIn: 'Sign in', profile: 'Your profile', settings: 'Settings' }} />);
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/auth/login');
    act(() => publishMarketingSession(authenticated('login-a')));
    expect(screen.getByRole('link', { name: 'Your profile' }).getAttribute('href')).toBe('/profile/climber-1');
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/settings');
  });

  it('preserves account navigation journey targets and menu placement', () => {
    const view = render(
      <MarketingAccountControls
        labels={{ signIn: 'Sign in', profile: 'Your profile', settings: 'Settings' }}
        placement="header-menu"
      />,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Sign in' }));
    expect(journey.track.mock.lastCall?.[0].properties).toEqual({ area: 'header-menu', target: '/auth/login' });
    act(() => publishMarketingSession(authenticated('login-a')));
    fireEvent.click(screen.getByRole('link', { name: 'Your profile' }));
    expect(journey.track.mock.lastCall?.[0].properties).toEqual({ area: 'header-menu', target: 'profile' });
    view.rerender(
      <MarketingAccountControls labels={{ signIn: 'Sign in', profile: 'Your profile', settings: 'Settings' }} />,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(journey.track.mock.lastCall?.[0].properties).toEqual({ area: 'header', target: '/settings' });
  });

  it('drops the bearer on a new login of the same account and on unresolved identity', () => {
    const transport = { read: vi.fn(), write: vi.fn() };
    const { result } = renderHook(useMarketingSession);
    act(() => {
      publishMarketingSession(authenticated('login-a'));
      publishMarketingConsentTransport('token-a', transport, authenticated('login-a'));
    });
    expect(result.current.token).toBe('token-a');
    act(() => publishMarketingSession(authenticated('login-b')));
    expect(result.current.token).toBeNull();
    act(() => publishMarketingConsentTransport('late-token-a', transport, authenticated('login-a')));
    expect(result.current.token).toBeNull();
    act(() => publishMarketingSession({ data: null, status: 'loading', update }));
    expect(result.current.session.status).toBe('loading');
    expect(result.current.token).toBeNull();
  });

  it('keeps a stored grant blocked until account identity is resolved', async () => {
    document.cookie = `boardsesh-consent=${serializeConsentCookieValue(grantedRecord)}; Path=/`;
    function Probe() {
      return <output>{String(useConsent().granted)}</output>;
    }
    const { rerender } = render(
      <ConsentStateProvider auth={{ accountId: null, status: 'loading', token: null }}>
        <Probe />
      </ConsentStateProvider>,
    );
    expect(screen.getByRole('status').textContent).toBe('false');
    rerender(
      <ConsentStateProvider auth={{ accountId: null, status: 'unauthenticated', token: null }}>
        <Probe />
      </ConsentStateProvider>,
    );
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('true'));
  });
});
