import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { serializeConsentCookieValue, type ConsentRecord } from '@boardsesh/consent';

const transport = vi.hoisted(() => ({ request: vi.fn(), pathname: '/' }));
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
const explicitAnswer: ConsentRecord = {
  analytics: 'denied',
  version: 1,
  source: 'web',
  decidedAt: '2026-10-08T12:00:01.000Z',
};
let cookies = '';
async function renderBanner() {
  const { ConsentProvider, useConsent } = await import('../consent-provider');
  const { default: ConsentBanner } = await import('../consent-banner');
  function Choices() {
    const { openChoices, granted } = useConsent();
    return (
      <>
        <button onClick={openChoices}>open-privacy-choices</button>
        <span data-testid="authorized">{granted ? 'on' : 'off'}</span>
      </>
    );
  }
  function Content({ screen }: { screen: number }) {
    return (
      <>
        <Choices />
        <ConsentBanner key={screen} />
      </>
    );
  }
  const view = render(
    <ConsentProvider>
      <Content screen={0} />
    </ConsentProvider>,
  );
  return {
    ...view,
    navigate: () =>
      view.rerender(
        <ConsentProvider>
          <Content screen={1} />
        </ConsentProvider>,
      ),
  };
}
beforeEach(() => {
  vi.resetModules();
  transport.pathname = '/';
  transport.request.mockReset().mockRejectedValue(new Error('backend unreachable'));
  cookies = '';
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => cookies,
    set: (cookie: string) => {
      cookies = /Max-Age=0(;|$)/.test(cookie) ? '' : cookie.split(';')[0];
    },
  });
});
afterEach(() => {
  cleanup();
  delete (document as unknown as Record<string, unknown>).cookie;
  delete (navigator as unknown as Record<string, unknown>).globalPrivacyControl;
  delete document.documentElement.dataset.consent;
});
describe('universal explicit analytics consent', () => {
  it('asks immediately without location or backend access and sends nothing before yes', async () => {
    const view = await renderBanner();
    expect(await view.findByTestId('consent-banner')).toBeTruthy();
    expect(view.getByTestId('authorized').textContent).toBe('off');
    expect(cookies).toBe('');
    expect(transport.request).not.toHaveBeenCalled();
    const { hasAnalyticsConsent } = await import('@/app/lib/consent');
    expect(hasAnalyticsConsent()).toBe(false);
    fireEvent.click(view.getByRole('button', { name: 'allow' }));
    await waitFor(() => expect(hasAnalyticsConsent()).toBe(true));
    expect(cookies).toMatch(/^boardsesh-consent=v1\.granted\.\d+\.web$/);
    expect(view.queryByTestId('consent-banner')).toBeNull();
  });
  it('no thanks keeps analytics off and saves the explicit answer', async () => {
    const view = await renderBanner();
    fireEvent.click(await view.findByRole('button', { name: 'deny' }));
    await waitFor(() => expect(cookies).toMatch(/^boardsesh-consent=v1\.denied\.\d+\.web$/));
    expect(view.getByTestId('authorized').textContent).toBe('off');
    expect(view.queryByTestId('consent-banner')).toBeNull();
  });
  it('dismissal leaves consent unanswered across screens and choices can reopen it', async () => {
    const view = await renderBanner();
    fireEvent.click(await view.findByRole('button', { name: 'later' }));
    expect(view.queryByTestId('consent-banner')).toBeNull();
    expect(cookies).toBe('');
    view.navigate();
    await act(async () => {
      fireEvent.focus(window);
      fireEvent.online(window);
    });
    expect(view.queryByTestId('consent-banner')).toBeNull();
    expect(view.getByTestId('authorized').textContent).toBe('off');
    fireEvent.click(view.getByRole('button', { name: 'open-privacy-choices' }));
    expect(await view.findByRole('dialog')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'allow' }));
    await waitFor(() => expect(view.getByTestId('authorized').textContent).toBe('on'));
  });
  it.each(['granted', 'denied'] as const)('keeps an earlier explicit %s without prompting', async (analytics) => {
    cookies = `boardsesh-consent=${serializeConsentCookieValue({ ...explicitAnswer, analytics })}`;
    const view = await renderBanner();
    await waitFor(() =>
      expect(view.getByTestId('authorized').textContent).toBe(analytics === 'granted' ? 'on' : 'off'),
    );
    expect(view.queryByTestId('consent-banner')).toBeNull();
    expect(transport.request).not.toHaveBeenCalled();
  });
  it('migrates a legacy region-default cookie to unanswered and asks once', async () => {
    cookies = 'boardsesh-consent=v1.granted.1760000000.web.region';
    const view = await renderBanner();
    expect(await view.findByTestId('consent-banner')).toBeTruthy();
    expect(view.getByTestId('authorized').textContent).toBe('off');
    fireEvent.click(view.getByRole('button', { name: 'later' }));
    view.navigate();
    expect(view.queryByTestId('consent-banner')).toBeNull();
  });
  it('still asks with Global Privacy Control, without enabling anything automatically', async () => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
    const view = await renderBanner();
    expect(await view.findByTestId('consent-banner')).toBeTruthy();
    expect(view.getByTestId('authorized').textContent).toBe('off');
    expect(cookies).toBe('');
  });
  it('does not show the banner or write consent on embed pages', async () => {
    transport.pathname = '/embed/board/kilter';
    const view = await renderBanner();
    expect(view.queryByTestId('consent-banner')).toBeNull();
    expect(cookies).toBe('');
  });
});
