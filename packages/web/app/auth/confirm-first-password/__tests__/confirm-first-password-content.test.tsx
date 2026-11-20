import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), getSession: vi.fn(), refresh: vi.fn(), replaceState: vi.fn() }));
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
vi.mock('@/app/lib/auth/web-session-events', () => ({ bridgeLegacyBrowserSession: mocks.getSession }));
vi.mock('@/app/lib/auth/browser-access-token', () => ({ refreshAccessTokenAfterCredentialChange: mocks.refresh }));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(
    function LocaleLinkStub(props, ref) {
      return <a ref={ref} {...props} />;
    },
  ),
}));

const { default: ConfirmFirstPasswordContent } = await import('../confirm-first-password-content');

const TOKEN = 'T'.repeat(43);
const OPERATION = 'f'.repeat(64);

function arriveWith(hash: string) {
  Object.defineProperty(window, 'location', {
    value: { hash, pathname: '/auth/confirm-first-password', search: '' },
    configurable: true,
  });
  Object.defineProperty(window, 'history', {
    value: { state: null, replaceState: mocks.replaceState },
    configurable: true,
  });
}

function answers(byStep: Record<string, Array<[number, Record<string, unknown>]>>) {
  mocks.fetch.mockImplementation(async (input: string) => {
    const step = String(input).replace('/api/auth/first-password/', '');
    const queue = byStep[step];
    if (!queue?.length) return new Response(null, { status: 404 });
    const [status, body] = queue.length > 1 ? queue.shift()! : queue[0];
    return Response.json(body, { status });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  arriveWith(`#token=${TOKEN}&operation=${OPERATION}`);
});

describe('ConfirmFirstPasswordContent', () => {
  it('takes the token out of the address and explains a link opened in another browser', async () => {
    answers({ status: [[409, { status: 'other_browser' }]] });
    render(<ConfirmFirstPasswordContent />);
    expect(
      await screen.findByText('Open this link in the browser where you asked for it. Nothing has changed.'),
    ).toBeTruthy();
    expect(mocks.replaceState).toHaveBeenCalledWith(null, '', '/auth/confirm-first-password');
    expect(screen.queryByLabelText('New password')).toBeNull();
  });

  it('explains a link opened by another account and changes nothing', async () => {
    answers({ status: [[409, { status: 'other_account' }]] });
    render(<ConfirmFirstPasswordContent />);
    expect(await screen.findByText(/This link belongs to another sign-in/)).toBeTruthy();
  });

  it('says the link is incomplete without a token', async () => {
    arriveWith('');
    render(<ConfirmFirstPasswordContent />);
    expect(await screen.findByText('This link is incomplete. Ask for a new one from Settings.')).toBeTruthy();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('sets the password, asking recover once after a lost reply, then fetches a new access token', async () => {
    answers({
      status: [[200, { status: 'pending' }]],
      confirm: [[503, { status: 'unavailable' }]],
      recover: [[200, { status: 'committed', generation: 1, refreshAccessToken: true }]],
    });
    render(<ConfirmFirstPasswordContent />);
    fireEvent.change(await screen.findByLabelText('New password'), { target: { value: 'a long password' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'a long password' } });
    fireEvent.click(screen.getByText('Save password'));
    expect(await screen.findByText(/Your password is set/)).toBeTruthy();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    const confirmBody = JSON.parse(
      String(mocks.fetch.mock.calls.find(([input]) => String(input).endsWith('/confirm'))?.[1]?.body),
    );
    expect(confirmBody).toEqual({
      token: TOKEN,
      operation: OPERATION,
      password: 'a long password',
      confirmPassword: 'a long password',
    });
  });

  it('checks the two passwords match before sending anything', async () => {
    answers({ status: [[200, { status: 'pending' }]] });
    render(<ConfirmFirstPasswordContent />);
    fireEvent.change(await screen.findByLabelText('New password'), { target: { value: 'a long password' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'another password' } });
    fireEvent.click(screen.getByText('Save password'));
    expect(await screen.findByText("The two passwords don't match.")).toBeTruthy();
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  });

  it('keeps the form after a lost prepare reply, which leaves nothing to recover', async () => {
    answers({
      status: [[200, { status: 'pending' }]],
      confirm: [[503, { status: 'unavailable' }]],
      recover: [[400, { status: 'refused', outcome: 'denied', code: 'invalid_proof' }]],
    });
    render(<ConfirmFirstPasswordContent />);
    fireEvent.change(await screen.findByLabelText('New password'), { target: { value: 'a long password' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'a long password' } });
    fireEvent.click(screen.getByText('Save password'));
    expect(await screen.findByText("That didn't go through. Try again in a minute.")).toBeTruthy();
    expect(screen.getByLabelText('New password')).toBeTruthy();
  });
});
