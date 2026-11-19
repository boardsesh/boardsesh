import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), signIn: vi.fn(), getSession: vi.fn(), assign: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));
// The page already knows who it shows: the guard's first session read is done.
vi.mock('@/app/lib/auth/session-guard', () => ({
  guardedFetch: mocks.fetch,
  browserSessionGuard: () => ({ whenViewerKnown: async () => 'viewer' }),
}));
vi.mock('@/app/lib/auth/web-session-events', () => ({
  signInWithSessionIntent: mocks.signIn,
  bridgeLegacyBrowserSession: mocks.getSession,
}));
vi.mock('@/app/components/brand/logo', () => ({ default: () => null }));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(
    function LocaleLinkStub(props, ref) {
      return <a ref={ref} {...props} />;
    },
  ),
}));

const { default: ReauthenticateContent } = await import('../reauthenticate-content');

const methodsReply = (reauthentication: { password: boolean; google: boolean }) =>
  Response.json({ status: 'methods', reauthentication: { ...reauthentication, apple: false } });

function respondTo(routes: Record<string, () => Response>) {
  mocks.fetch.mockImplementation(async (input: string) => {
    const handler = Object.entries(routes).find(([path]) => input.startsWith(path))?.[1];
    return handler ? handler() : new Response(null, { status: 404 });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({});
  Object.defineProperty(window, 'location', { value: { assign: mocks.assign }, configurable: true });
});

const renderPage = (outcome?: 'other_account' | 'expired') =>
  render(<ReauthenticateContent email="climber@example.test" callbackUrl="/developers/apps" outcome={outcome} />);

describe('ReauthenticateContent', () => {
  it('shows an error and no sign-in buttons when the methods read fails', async () => {
    respondTo({ '/api/auth/provider-security/methods': () => new Response(null, { status: 503 }) });
    renderPage();
    expect(await screen.findByText("We couldn't load your sign-in options.")).toBeTruthy();
    expect(screen.queryByText('Continue with Google')).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('re-reads the session once when the browser holds only the legacy cookie, then shows the methods', async () => {
    let calls = 0;
    respondTo({
      '/api/auth/provider-security/methods': () =>
        ++calls === 1
          ? Response.json({ status: 'refused', outcome: 'canonical_session_required' }, { status: 403 })
          : methodsReply({ password: false, google: true }),
    });
    renderPage();
    expect(await screen.findByText('Continue with Google')).toBeTruthy();
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('tells a wrong password from a rate limit and an outage, and returns through the check on success', async () => {
    respondTo({
      '/api/auth/provider-security/methods': () => methodsReply({ password: true, google: false }),
      '/api/auth/reauthenticate/start': () => Response.json({ status: 'started' }),
    });
    renderPage();
    const field = await screen.findByLabelText('Password');
    fireEvent.change(field, { target: { value: 'secret password' } });
    for (const [result, copy] of [
      [{ ok: false, status: 401, error: 'CredentialsSignin' }, "That password didn't work. Try again."],
      [{ ok: false, status: 429, error: 'AuthBackendUnavailable' }, 'Too many tries. Wait a minute, then try again.'],
      [
        { ok: false, status: 503, error: 'AuthBackendUnavailable' },
        "We can't check your password right now. Try again in a minute.",
      ],
    ] as const) {
      mocks.signIn.mockResolvedValueOnce(result);
      fireEvent.click(screen.getByText('Confirm'));
      expect(await screen.findByText(copy)).toBeTruthy();
    }
    mocks.signIn.mockResolvedValueOnce({ ok: true, status: 200, error: null });
    fireEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(mocks.assign).toHaveBeenCalledWith('/api/auth/reauthenticate/return'));
    const startCall = mocks.fetch.mock.calls.find(([input]) => input === '/api/auth/reauthenticate/start');
    expect(JSON.parse(String(startCall?.[1]?.body))).toEqual({ callbackUrl: '/developers/apps' });
  });

  it('starts Google with a forced fresh prompt, a login hint and the checking return', async () => {
    respondTo({
      '/api/auth/provider-security/methods': () => methodsReply({ password: false, google: true }),
      '/api/auth/reauthenticate/start': () => Response.json({ status: 'started' }),
    });
    mocks.signIn.mockResolvedValue(undefined);
    renderPage();
    fireEvent.click(await screen.findByText('Continue with Google'));
    await waitFor(() =>
      expect(mocks.signIn).toHaveBeenCalledWith(
        'google',
        { callbackUrl: '/api/auth/reauthenticate/return' },
        { max_age: '0', prompt: 'select_account consent', login_hint: 'climber@example.test' },
      ),
    );
  });

  it('after another account came back, offers sign-out and home and no sign-in form', () => {
    respondTo({ '/api/auth/provider-security/methods': () => methodsReply({ password: true, google: true }) });
    renderPage('other_account');
    expect(screen.getByText('You signed in as another account')).toBeTruthy();
    expect(screen.getByText('Sign out').closest('a')?.getAttribute('href')).toBe('/auth/signout');
    expect(screen.queryByLabelText('Password')).toBeNull();
  });
});
