import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { PartnerSignInView } from '@/app/lib/partner-oauth/page-views';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(
    function MockLocaleLink(props, ref) {
      return <a ref={ref} {...props} />;
    },
  ),
}));

const socialButtons = vi.fn();
vi.mock('@/app/components/auth/social-login-buttons', () => ({
  default: (props: { callbackUrl?: string }) => {
    socialButtons(props);
    return null;
  },
}));

const mockSignIn = vi.fn();
vi.mock('@/app/lib/auth/web-session-events', () => ({
  signInWithSessionIntent: (...args: unknown[]) => mockSignIn(...args),
}));

const { default: PartnerSignInContent } = await import('../partner-sign-in-content');

const RETURN_PATH = '/oauth/sign-in?client_id=bsk_sequence&sig=signed&boardsesh_signed_in=1';

function formView(overrides: Partial<Extract<PartnerSignInView, { kind: 'sign-in' }>> = {}): PartnerSignInView {
  return {
    kind: 'sign-in',
    reason: 'signed-out',
    account: null,
    returnPath: RETURN_PATH,
    signOutPath: '/auth/signout?callbackUrl=%2Foauth%2Fsign-in%3Fclient_id%3Dbsk_sequence',
    errorCode: null,
    ...overrides,
  };
}

const assign = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', {
    value: { href: originalLocation.href, origin: originalLocation.origin, assign },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { value: originalLocation, writable: true, configurable: true });
});

function submit() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'climber@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter22' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('PartnerSignInContent', () => {
  it('asks a signed-out climber to sign in, and says what happens next', () => {
    render(<PartnerSignInContent view={formView()} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Sign in to connect an app');
    expect(screen.getByText(/you'll see what it can access before anything is shared/)).toBeTruthy();
    expect(screen.queryByText(/Signed in as/)).toBeNull();
  });

  it('explains a second sign-in plainly on switch-on day, with no alarm', () => {
    render(<PartnerSignInContent view={formView({ reason: 'stale', account: 'climber@example.com' })} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Sign in again to continue');
    expect(screen.getByText(/Your account is fine/)).toBeTruthy();
    expect(screen.getByText('We ask every 30 days and after a password change.')).toBeTruthy();
    expect(screen.getByText(/Signed in as climber@example.com/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Not you? Sign out' }).getAttribute('href')).toContain('/auth/signout');
    // Signing in again is usually as the same climber.
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('climber@example.com');
  });

  it('tells a climber who just signed in to wait out the minute after a password change', () => {
    render(<PartnerSignInContent view={formView({ reason: 'just-signed-in', account: 'climber@example.com' })} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Almost there');
    expect(screen.getByText(/wait a minute, then sign in again/)).toBeTruthy();
  });

  it('returns social sign-ins to this page, marked, so they continue to the app', () => {
    render(<PartnerSignInContent view={formView()} />);
    expect(socialButtons).toHaveBeenCalledWith(expect.objectContaining({ callbackUrl: RETURN_PATH }));
  });

  it('continues with a full page load after a password sign-in', async () => {
    mockSignIn.mockResolvedValueOnce({ ok: true, error: null });
    render(<PartnerSignInContent view={formView()} />);
    submit();
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith(RETURN_PATH));
    expect(mockSignIn).toHaveBeenCalledWith('credentials', {
      email: 'climber@example.com',
      password: 'hunter22',
      redirect: false,
    });
  });

  it('keeps a failed password sign-in on the page with a plain message', async () => {
    mockSignIn.mockResolvedValueOnce({ ok: false, error: 'CredentialsSignin' });
    render(<PartnerSignInContent view={formView()} />);
    submit();
    expect((await screen.findByRole('alert')).textContent).toBe("That email and password don't match. Try again.");
    expect(assign).not.toHaveBeenCalled();
  });

  it.each([
    ['OAuthAccountNotLinked', 'That account belongs to a different Boardsesh sign-in.'],
    ['Callback', "That account isn't linked to your Boardsesh sign-in yet."],
    ['AuthBackendUnavailable', "Sign-in isn't working right now."],
    ['OAuthCallback', "Sign-in didn't finish. Try again."],
  ])('shows a failed social sign-in (%s) on this page', (errorCode, message) => {
    render(<PartnerSignInContent view={formView({ errorCode })} />);
    expect(screen.getByRole('alert').textContent).toContain(message);
  });

  it.each([
    [{ kind: 'invalid' } as const, "This link doesn't work"],
    [{ kind: 'unavailable' } as const, "Connecting apps isn't available right now"],
  ])('renders %j without a form', (view, title) => {
    render(<PartnerSignInContent view={view} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(title);
    expect(screen.queryByLabelText('Email')).toBeNull();
  });
});
