import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { GET_CONSENT_REGION, GET_MY_ANALYTICS_CONSENT } from '@boardsesh/graphql/operations/analytics-consent';
import { createRegionDefaultConsent, serializeConsentCookieValue, type ConsentRecord } from '@boardsesh/consent';

const transport = vi.hoisted(() => ({
  request: vi.fn(),
  // promptRequired the backend returns; an Error means the lookup fails.
  region: true as boolean | null | Error,
  pathname: '/',
}));
vi.mock('next-auth/react', () => ({ useSession: () => ({ status: 'unauthenticated', data: null }) }));
vi.mock('next/navigation', () => ({ usePathname: () => transport.pathname }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => ({ token: null }) }));
vi.mock('@/app/lib/graphql/client', () => ({ executeGraphQL: transport.request }));
vi.mock('@/app/lib/analytics', () => ({ setAnalyticsFlagAccountId: vi.fn() }));
vi.mock('@/app/lib/consent-pending-db', () => ({
  loadPendingConsent: async () => null,
  persistPendingConsent: async () => {},
}));

const explicitDenial: ConsentRecord = {
  analytics: 'denied',
  version: 1,
  source: 'web',
  decidedAt: '2026-10-08T12:00:01.000Z',
};
let cookies = '';

function consentCookie(): string | undefined {
  return cookies.startsWith('boardsesh-consent=') ? cookies.slice('boardsesh-consent='.length) : undefined;
}

async function renderBanner() {
  const { ConsentProvider, useConsent } = await import('../consent-provider');
  const { default: ConsentBanner } = await import('../consent-banner');
  function OpenChoices() {
    const { openChoices } = useConsent();
    return <button onClick={openChoices}>open-privacy-choices</button>;
  }
  return render(
    <ConsentProvider>
      <OpenChoices />
      <ConsentBanner />
    </ConsentProvider>,
  );
}

beforeEach(() => {
  vi.resetModules();
  transport.region = true;
  transport.pathname = '/';
  transport.request.mockReset().mockImplementation(async (query: string) => {
    if (query === GET_CONSENT_REGION) {
      if (transport.region instanceof Error) throw transport.region;
      return {
        consentRegion: {
          countryCode: transport.region === false ? 'US' : null,
          promptRequired: transport.region,
        },
      };
    }
    if (query === GET_MY_ANALYTICS_CONSENT) return { myAnalyticsConsent: null };
    throw new Error('unexpected operation');
  });
  cookies = '';
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => cookies,
    set: (cookie: string) => {
      const pair = cookie.split(';')[0];
      cookies = /Max-Age=0(;|$)/.test(cookie) ? '' : pair;
    },
  });
});
afterEach(() => {
  cleanup();
  delete (document as unknown as Record<string, unknown>).cookie;
  delete document.documentElement.dataset.consent;
});

function regionLookups(): number {
  return transport.request.mock.calls.filter(([query]) => query === GET_CONSENT_REGION).length;
}

describe('consent banner by region', () => {
  it('shows the banner to a visitor in a prompt region, and writes nothing', async () => {
    transport.region = true;
    const view = await renderBanner();
    expect(await view.findByTestId('consent-banner')).toBeTruthy();
    expect(consentCookie()).toBeUndefined();
    expect(regionLookups()).toBe(1);
  });

  it('never shows the banner outside the prompt regions and stores the region default', async () => {
    transport.region = false;
    const view = await renderBanner();
    await waitFor(() => expect(consentCookie()).toMatch(/^v1\.granted\.\d+\.web\.region$/));
    expect(view.queryByTestId('consent-banner')).toBeNull();
    expect(document.documentElement.dataset.consent).toBe('granted');
  });

  it('shows the banner when the region lookup fails', async () => {
    transport.region = new Error('backend unreachable');
    const view = await renderBanner();
    expect(await view.findByTestId('consent-banner')).toBeTruthy();
    expect(consentCookie()).toBeUndefined();
  });

  it('shows the banner when the backend cannot tell the country', async () => {
    transport.region = null;
    const view = await renderBanner();
    expect(await view.findByTestId('consent-banner')).toBeTruthy();
  });

  it('skips the lookup entirely for a visitor who already answered', async () => {
    cookies = `boardsesh-consent=${serializeConsentCookieValue(explicitDenial)}`;
    const view = await renderBanner();
    await act(async () => {
      await Promise.resolve();
    });
    expect(regionLookups()).toBe(0);
    expect(view.queryByTestId('consent-banner')).toBeNull();
    expect(consentCookie()).toBe(serializeConsentCookieValue(explicitDenial));
  });

  it('drops a region default and asks when the visitor is now in a prompt region', async () => {
    cookies = `boardsesh-consent=${serializeConsentCookieValue(createRegionDefaultConsent('web'))}`;
    transport.region = true;
    const view = await renderBanner();
    expect(await view.findByTestId('consent-banner')).toBeTruthy();
    expect(consentCookie()).toBeUndefined();
    expect(document.documentElement.dataset.consent).toBeUndefined();
  });

  it('keeps a region default when the region is unknown', async () => {
    const regionDefault = serializeConsentCookieValue(createRegionDefaultConsent('web'));
    cookies = `boardsesh-consent=${regionDefault}`;
    transport.region = null;
    await renderBanner();
    await waitFor(() => expect(regionLookups()).toBe(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(consentCookie()).toBe(regionDefault);
  });

  it('never looks up the region or writes a cookie on a chrome-less page', async () => {
    transport.pathname = '/embed/board/kilter';
    transport.region = false;
    await renderBanner();
    await act(async () => {
      await Promise.resolve();
    });
    expect(regionLookups()).toBe(0);
    expect(consentCookie()).toBeUndefined();
  });

  it('turns the region default into an explicit answer from Privacy choices', async () => {
    transport.region = false;
    const view = await renderBanner();
    await waitFor(() => expect(consentCookie()).toMatch(/\.region$/));
    fireEvent.click(view.getByRole('button', { name: 'open-privacy-choices' }));
    fireEvent.click(await view.findByRole('button', { name: 'deny' }));
    await waitFor(() => expect(consentCookie()).toMatch(/^v1\.denied\.\d+\.web$/));
    expect(document.documentElement.dataset.consent).toBe('denied');
  });
});
