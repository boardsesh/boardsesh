import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { GET_CONSENT_REGION, GET_MY_ANALYTICS_CONSENT } from '@boardsesh/graphql/operations/analytics-consent';
import { createRegionDefaultConsent, serializeConsentCookieValue, type ConsentRecord } from '@boardsesh/consent';

const transport = vi.hoisted(() => ({
  request: vi.fn(),
  regionRequest: vi.fn(),
  // promptRequired the backend returns; an Error means the lookup fails.
  region: true as boolean | null | Error,
  // Sec-GPC as the backend saw it.
  headerGpc: false,
  // Resolves the next region request by hand when set.
  pendingRegion: null as Promise<boolean | null> | null,
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
vi.mock('@/app/lib/graphql/client', () => ({
  executeGraphQL: transport.request,
  createGraphQLHttpClient: () => ({ request: transport.regionRequest }),
}));
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
    const { openChoices, granted } = useConsent();
    return (
      <>
        <button onClick={openChoices}>open-privacy-choices</button>
        <span data-testid="analytics-authorized">{granted ? 'on' : 'off'}</span>
      </>
    );
  }
  return render(
    <ConsentProvider>
      <OpenChoices />
      <ConsentBanner />
    </ConsentProvider>,
  );
}

async function sendsAnalytics(): Promise<boolean> {
  const { hasAnalyticsConsent } = await import('@/app/lib/consent');
  return hasAnalyticsConsent();
}

beforeEach(() => {
  vi.resetModules();
  transport.region = true;
  transport.headerGpc = false;
  transport.pendingRegion = null;
  transport.pathname = '/';
  transport.regionRequest.mockReset().mockImplementation(async ({ document }: { document: string }) => {
    if (document !== GET_CONSENT_REGION) throw new Error('unexpected operation');
    const promptRequired = transport.pendingRegion ? await transport.pendingRegion : transport.region;
    if (promptRequired instanceof Error) throw promptRequired;
    return {
      consentRegion: {
        countryCode: promptRequired === false ? 'US' : null,
        promptRequired,
        globalPrivacyControl: transport.headerGpc,
      },
    };
  });
  transport.request.mockReset().mockImplementation(async (query: string) => {
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
  delete (navigator as unknown as Record<string, unknown>).globalPrivacyControl;
  cleanup();
  delete (document as unknown as Record<string, unknown>).cookie;
  delete document.documentElement.dataset.consent;
});

function regionLookups(): number {
  return transport.regionRequest.mock.calls.length;
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
    // Writing the default leaves the hook's dependency unchanged: one lookup per page load.
    await act(async () => {
      await Promise.resolve();
    });
    expect(regionLookups()).toBe(1);
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
    fireEvent.focus(window);
    fireEvent.online(window);
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

  it('sends nothing on a stored region default until this page load confirms the region', async () => {
    cookies = `boardsesh-consent=${serializeConsentCookieValue(createRegionDefaultConsent('web'))}`;
    let answer!: (promptRequired: boolean | null) => void;
    transport.pendingRegion = new Promise((resolve) => {
      answer = resolve;
    });
    const view = await renderBanner();
    await waitFor(() => expect(regionLookups()).toBe(1));
    expect(view.getByTestId('analytics-authorized').textContent).toBe('off');
    expect(await sendsAnalytics()).toBe(false);

    await act(async () => {
      answer(false);
    });
    await waitFor(() => expect(view.getByTestId('analytics-authorized').textContent).toBe('on'));
    expect(await sendsAnalytics()).toBe(true);
    expect(view.queryByTestId('consent-banner')).toBeNull();
  });

  it('holds capture on focus, deduplicates resume events, and asks after travel into a prompt region', async () => {
    cookies = `boardsesh-consent=${serializeConsentCookieValue(createRegionDefaultConsent('web'))}`;
    transport.region = false;
    const view = await renderBanner();
    await waitFor(() => expect(view.getByTestId('analytics-authorized').textContent).toBe('on'));
    const { hasAnalyticsConsent } = await import('@/app/lib/consent');

    let answer!: (promptRequired: boolean | null) => void;
    transport.pendingRegion = new Promise((resolve) => {
      answer = resolve;
    });
    act(() => {
      fireEvent.focus(window);
      expect(hasAnalyticsConsent()).toBe(false);
      fireEvent(document, new Event('visibilitychange'));
      fireEvent.online(window);
    });
    await waitFor(() => expect(regionLookups()).toBe(2));
    expect(view.getByTestId('analytics-authorized').textContent).toBe('off');

    await act(async () => {
      answer(true);
    });
    expect(await view.findByTestId('consent-banner')).toBeTruthy();
    expect(consentCookie()).toBeUndefined();
    expect(hasAnalyticsConsent()).toBe(false);
    expect(regionLookups()).toBe(3);
  });

  it.each([
    ['stored default', true, false],
    ['no answer', false, false],
    ['settled default answer before its UI callback', true, true],
    ['settled first answer before its UI callback', false, true],
  ])(
    'never confirms %s after resume until a fresh location arrives',
    async (_scenario, storedDefault, settleBeforeResume) => {
      if (storedDefault)
        cookies = `boardsesh-consent=${serializeConsentCookieValue(createRegionDefaultConsent('web'))}`;
      let oldAnswer!: (promptRequired: boolean | null) => void;
      let freshAnswer!: (promptRequired: boolean | null) => void;
      transport.pendingRegion = new Promise((resolve) => {
        oldAnswer = resolve;
      });
      const { lookUpConsentRegion } = await import('@/app/lib/consent-region');
      const oldLookup = lookUpConsentRegion();
      if (settleBeforeResume) {
        // Register before the UI: expire the settled cache before its consumers run.
        void oldLookup.then(() => {
          fireEvent.focus(window);
        });
      }
      const view = await renderBanner();
      await waitFor(() => expect(regionLookups()).toBe(1));
      if (!settleBeforeResume)
        act(() => {
          fireEvent.focus(window);
          fireEvent.online(window);
        });
      transport.pendingRegion = new Promise((resolve) => {
        freshAnswer = resolve;
      });
      await act(async () => {
        oldAnswer(false);
      });
      await waitFor(() => expect(regionLookups()).toBe(2));
      expect(view.getByTestId('analytics-authorized').textContent).toBe('off');
      expect(await sendsAnalytics()).toBe(false);
      if (storedDefault) expect(consentCookie()).toMatch(/\.region$/);
      else expect(consentCookie()).toBeUndefined();

      await act(async () => {
        freshAnswer(true);
      });
      expect(await view.findByTestId('consent-banner')).toBeTruthy();
      expect(consentCookie()).toBeUndefined();
      expect(await sendsAnalytics()).toBe(false);
      expect(regionLookups()).toBe(2);
    },
  );

  it('keeps a stored default disabled when a focus refresh fails', async () => {
    cookies = `boardsesh-consent=${serializeConsentCookieValue(createRegionDefaultConsent('web'))}`;
    transport.region = false;
    const view = await renderBanner();
    await waitFor(() => expect(view.getByTestId('analytics-authorized').textContent).toBe('on'));
    const storedDefault = consentCookie();
    transport.region = new Error('offline after travel');

    fireEvent.focus(window);
    await waitFor(() => expect(regionLookups()).toBe(2));
    expect(consentCookie()).toBe(storedDefault);
    expect(await sendsAnalytics()).toBe(false);
    expect(view.queryByTestId('consent-banner')).toBeNull();
  });

  it('keeps a region default through a failed lookup but sends nothing on that page', async () => {
    const regionDefault = serializeConsentCookieValue(createRegionDefaultConsent('web'));
    cookies = `boardsesh-consent=${regionDefault}`;
    transport.region = new Error('backend unreachable');
    const view = await renderBanner();
    await waitFor(() => expect(regionLookups()).toBe(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(consentCookie()).toBe(regionDefault);
    expect(view.getByTestId('analytics-authorized').textContent).toBe('off');
    expect(await sendsAnalytics()).toBe(false);
  });

  it('tracks a fresh visitor outside the prompt regions once the default is written', async () => {
    transport.region = false;
    const view = await renderBanner();
    await waitFor(() => expect(view.getByTestId('analytics-authorized').textContent).toBe('on'));
    expect(await sendsAnalytics()).toBe(true);
  });

  it.each([
    ['navigator.globalPrivacyControl', true, false],
    ['the Sec-GPC header', false, true],
  ])(
    'treats Global Privacy Control (%s) as a no outside the prompt regions: no default, no banner',
    async (_source, navigatorGpc, headerGpc) => {
      if (navigatorGpc) Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
      transport.headerGpc = headerGpc;
      transport.region = false;
      const view = await renderBanner();
      await waitFor(() => expect(regionLookups()).toBe(1));
      await act(async () => {
        await Promise.resolve();
      });
      expect(consentCookie()).toBeUndefined();
      expect(view.queryByTestId('consent-banner')).toBeNull();
      expect(view.getByTestId('analytics-authorized').textContent).toBe('off');
    },
  );

  it('drops a stored region default under Global Privacy Control', async () => {
    cookies = `boardsesh-consent=${serializeConsentCookieValue(createRegionDefaultConsent('web'))}`;
    transport.headerGpc = true;
    transport.region = false;
    const view = await renderBanner();
    await waitFor(() => expect(consentCookie()).toBeUndefined());
    expect(view.queryByTestId('consent-banner')).toBeNull();
    expect(document.documentElement.dataset.consent).toBeUndefined();
  });

  it('still asks in a prompt region under Global Privacy Control', async () => {
    transport.headerGpc = true;
    transport.region = true;
    const view = await renderBanner();
    expect(await view.findByTestId('consent-banner')).toBeTruthy();
  });
});
