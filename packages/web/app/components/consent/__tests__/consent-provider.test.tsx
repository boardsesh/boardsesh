import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { GET_MY_ANALYTICS_CONSENT } from '@boardsesh/graphql/operations/analytics-consent';
import { serializeConsentCookieValue, type ConsentRecord } from '@boardsesh/consent';

const transport = vi.hoisted(() => ({
  request: vi.fn(),
  authStatus: 'authenticated' as 'authenticated' | 'unauthenticated',
}));
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    status: transport.authStatus,
    data: transport.authStatus === 'authenticated' ? { user: { id: 'account-1' } } : null,
  }),
}));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => ({ token: 'account-1-token' }) }));
vi.mock('@/app/lib/graphql/client', () => ({ executeGraphQL: transport.request }));
vi.mock('@/app/lib/analytics', () => ({ setAnalyticsFlagAccountId: vi.fn() }));
vi.mock('@/app/lib/consent-pending-db', () => ({
  loadPendingConsent: async () => null,
  persistPendingConsent: async () => {},
}));

const grantedRecord: ConsentRecord = {
  analytics: 'granted',
  version: 1,
  source: 'web',
  decidedAt: '2026-10-08T12:00:00.123Z',
};
const deniedRecord: ConsentRecord = {
  analytics: 'denied',
  version: 1,
  source: 'web',
  decidedAt: '2026-10-08T12:00:01.456Z',
};
let cookies = '';
let writtenCookies: string[] = [];

beforeEach(() => {
  vi.resetModules();
  transport.request.mockReset();
  transport.authStatus = 'authenticated';
  cookies = `boardsesh-consent=${serializeConsentCookieValue(grantedRecord)}`;
  writtenCookies = [];
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => cookies,
    set: (cookie: string) => {
      writtenCookies.push(cookie);
      cookies = cookie.split(';')[0];
    },
  });
});
afterEach(() => {
  cleanup();
  delete (document as unknown as Record<string, unknown>).cookie;
  delete document.documentElement.dataset.consent;
});

describe('ConsentProvider shared-cookie response races', () => {
  it('keeps an offline pending denial authoritative over an external grant', async () => {
    transport.request
      .mockResolvedValueOnce({ myAnalyticsConsent: grantedRecord })
      .mockRejectedValue(new Error('offline'));
    const { ConsentProvider, useConsent } = await import('../consent-provider');
    const consent = await import('@/app/lib/consent');
    function ConsentProbe() {
      const { granted, snapshot, decide } = useConsent();
      return (
        <>
          <div data-testid="choice">
            {snapshot.record?.analytics}:{String(granted)}:{String(snapshot.pending)}
          </div>
          <button
            onClick={() => {
              void decide('denied');
            }}
          >
            Decline
          </button>
        </>
      );
    }
    const view = render(
      <ConsentProvider>
        <ConsentProbe />
      </ConsentProvider>,
    );
    await waitFor(() => expect(view.getByTestId('choice').textContent).toBe('granted:true:false'));
    fireEvent.click(view.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(view.getByTestId('choice').textContent).toBe('denied:false:true'));
    await waitFor(() => expect(transport.request).toHaveBeenCalledTimes(2));
    const listenerGrants: boolean[] = [];
    consent.subscribeWebConsent(() => listenerGrants.push(consent.hasAnalyticsConsent()));
    await act(async () => {
      cookies = `boardsesh-consent=${serializeConsentCookieValue(grantedRecord)}`;
      consent.refreshWebConsent();
    });
    expect(view.getByTestId('choice').textContent).toBe('denied:false:true');
    expect(consent.hasAnalyticsConsent()).toBe(false);
    expect(listenerGrants.every((granted) => !granted)).toBe(true);
  });

  it('keeps another account cookie grant blocked until this account answers', async () => {
    cookies = `boardsesh-consent=${serializeConsentCookieValue(deniedRecord)}`;
    let resolveAccount!: (response: unknown) => void;
    const accountAnswer = new Promise<unknown>((resolve) => {
      resolveAccount = resolve;
    });
    transport.request.mockResolvedValueOnce({ myAnalyticsConsent: deniedRecord }).mockReturnValueOnce(accountAnswer);
    const { ConsentProvider, useConsent } = await import('../consent-provider');
    const consent = await import('@/app/lib/consent');
    const listenerGrants: boolean[] = [];
    consent.subscribeWebConsent(() => {
      if (consent.getWebConsentRecord()?.analytics === 'granted') listenerGrants.push(consent.hasAnalyticsConsent());
    });
    function ConsentProbe() {
      const { granted, snapshot } = useConsent();
      return (
        <div data-testid="choice">
          {snapshot.record?.analytics}:{String(granted)}
        </div>
      );
    }
    const view = render(
      <ConsentProvider>
        <ConsentProbe />
      </ConsentProvider>,
    );
    await waitFor(() => expect(view.getByTestId('choice').textContent).toBe('denied:false'));
    await waitFor(() => expect(transport.request).toHaveBeenCalledTimes(1));
    await act(async () => {
      cookies = `boardsesh-consent=${serializeConsentCookieValue(grantedRecord)}`;
      consent.refreshWebConsent();
    });
    await waitFor(() => expect(transport.request).toHaveBeenCalledTimes(2));
    expect(listenerGrants.length).toBeGreaterThan(0);
    expect(listenerGrants.every((granted) => !granted)).toBe(true);
    expect(consent.hasAnalyticsConsent()).toBe(false);
    expect(view.getByTestId('choice').textContent).toBe('granted:false');
    await act(async () => {
      resolveAccount({ myAnalyticsConsent: deniedRecord });
      await accountAnswer;
    });
    await waitFor(() => expect(view.getByTestId('choice').textContent).toBe('denied:false'));
    expect(cookies).toContain('.denied.');
  });

  it('restores a signed-out external grant without changed auth-effect dependencies', async () => {
    transport.authStatus = 'unauthenticated';
    cookies = `boardsesh-consent=${serializeConsentCookieValue(deniedRecord)}`;
    const { ConsentProvider, useConsent } = await import('../consent-provider');
    const consent = await import('@/app/lib/consent');
    function ConsentProbe() {
      const { granted } = useConsent();
      return <div data-testid="granted">{String(granted)}</div>;
    }
    const view = render(
      <ConsentProvider>
        <ConsentProbe />
      </ConsentProvider>,
    );
    expect(view.getByTestId('granted').textContent).toBe('false');
    await act(async () => {
      cookies = `boardsesh-consent=${serializeConsentCookieValue(grantedRecord)}`;
      consent.refreshWebConsent();
    });
    await waitFor(() => expect(view.getByTestId('granted').textContent).toBe('true'));
    expect(consent.hasAnalyticsConsent()).toBe(true);
    expect(transport.request).not.toHaveBeenCalled();
    view.unmount();
    expect(consent.hasAnalyticsConsent()).toBe(false);
  });

  it.each(['read', 'write'] as const)(
    'keeps an external withdrawal when a delayed account %s returns a grant',
    async (operation) => {
      let resolveServer!: (response: unknown) => void;
      const delayedServer = new Promise<unknown>((resolve) => {
        resolveServer = resolve;
      });
      let delayed = false;
      transport.request.mockImplementation((query: string, variables?: { input: { analytics: string } }) => {
        const reading = query === GET_MY_ANALYTICS_CONSENT;
        if (!delayed && reading === (operation === 'read')) {
          delayed = true;
          return delayedServer;
        }
        if (reading) return Promise.resolve({ myAnalyticsConsent: operation === 'write' ? null : grantedRecord });
        return Promise.resolve({
          setAnalyticsConsent: variables?.input.analytics === 'denied' ? deniedRecord : grantedRecord,
        });
      });
      const { ConsentProvider, useConsent } = await import('../consent-provider');
      function ConsentProbe() {
        const { snapshot } = useConsent();
        return <div data-testid="choice">{snapshot.record?.analytics}</div>;
      }
      const view = render(
        <ConsentProvider>
          <ConsentProbe />
        </ConsentProvider>,
      );
      await waitFor(() => expect(delayed).toBe(true));
      // Another origin writes the shared cookie while this tab remains in the background.
      cookies = `boardsesh-consent=${serializeConsentCookieValue(deniedRecord)}`;
      writtenCookies = [];
      await act(async () => {
        resolveServer(
          operation === 'read' ? { myAnalyticsConsent: grantedRecord } : { setAnalyticsConsent: grantedRecord },
        );
        await delayedServer;
      });
      await waitFor(() => expect(view.getByTestId('choice').textContent).toBe('denied'));
      await waitFor(() =>
        expect(transport.request).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ input: expect.objectContaining({ analytics: 'denied' }) }),
          'account-1-token',
        ),
      );
      expect(writtenCookies.every((cookie) => !cookie.includes('.granted.'))).toBe(true);
      expect(cookies).toContain('.denied.');
    },
  );
});
