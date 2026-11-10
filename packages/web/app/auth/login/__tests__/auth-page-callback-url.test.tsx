/**
 * Where the login page sends the browser after sign-in. `callbackUrl` comes off
 * the address bar, so a crafted value must never navigate off-site, while every
 * real return path, including the absolute ones NextAuth produces, must survive.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

const { localeRouter, mockSignIn, navigationState, sessionState, socialLoginButtons } = vi.hoisted(() => ({
  localeRouter: { push: vi.fn(), replace: vi.fn() },
  mockSignIn: vi.fn(),
  navigationState: { searchParams: new URLSearchParams() },
  sessionState: { status: 'unauthenticated' },
  socialLoginButtons: vi.fn((_props: { callbackUrl?: string }) => null),
}));

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('next-auth/react', () => ({
  getSession: vi.fn().mockResolvedValue(null),
  signIn: (...args: unknown[]) => mockSignIn(...args),
  useSession: () => ({ status: sessionState.status, data: null }),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => navigationState.searchParams,
}));

vi.mock('@/app/lib/i18n/use-locale-router', () => ({
  useLocaleRouter: () => localeRouter,
  usePathnameWithoutLocale: () => '/auth/login',
}));

vi.mock('@/app/components/auth/social-login-buttons', () => ({
  default: (props: { callbackUrl?: string }) => socialLoginButtons(props),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

vi.mock('@/app/lib/analytics', () => ({
  track: vi.fn(),
  setPersonProperties: vi.fn(),
}));

const { default: AuthPageContent } = await import('../auth-page-content');

function openLoginPage(query: string) {
  navigationState.searchParams = new URLSearchParams(query);
  render(<AuthPageContent />);
}

function callbackQuery(callbackUrl: string): string {
  return new URLSearchParams({ callbackUrl }).toString();
}

function submitLogin() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'climber@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter22' } });
  fireEvent.click(screen.getByRole('button', { name: 'Login' }));
}

function submitRegister() {
  fireEvent.click(screen.getByRole('tab', { name: 'Create Account' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Crusher' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'climber@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2222' } });
  fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'hunter2222' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));
}

function stubSuccessfulRegistration() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ requiresVerification: false }) }),
  );
}

// Written as an attacker writes them, so they pass through the same query-string
// decoding the page's own `searchParams.get` does.
const OFF_SITE_QUERIES: [string, string][] = [
  ['https://evil.example', 'callbackUrl=https%3A%2F%2Fevil.example'],
  ['//evil', 'callbackUrl=%2F%2Fevil'],
  ['/\\evil', 'callbackUrl=%2F%5Cevil'],
  ['/%09/evil', 'callbackUrl=/%09/evil'],
  ['/%0a/evil', 'callbackUrl=/%0a/evil'],
  ['/%0d/evil', 'callbackUrl=/%0d/evil'],
  ['/%2509/evil', 'callbackUrl=/%2509/evil'],
  ['/%252F/evil', 'callbackUrl=/%252F/evil'],
  ['/%255Cevil', 'callbackUrl=/%255Cevil'],
  // Harmless until the locale router strips `/es` and leaves `//evil.example`.
  // auth-page-locale-router.test.tsx runs these through the real router.
  ['/es//evil.example', 'callbackUrl=/es//evil.example'],
  ['/es/\\evil.example', 'callbackUrl=/es/%5Cevil.example'],
  ['/.//evil.example', 'callbackUrl=/.//evil.example'],
];

const REAL_RETURN_PATHS = [
  '/settings',
  '/gym/bloclab/manage',
  '/gym/boulderwelt?claim=1',
  '/fr/gyms/new?gym=0b5c2c0e-6d0a-4a55-9a0f-0d9f3f0a7c11',
  '/b/the-garage?invite=abc123',
  '/setter/jimmy%20webb',
];

const nativeCallbackUrl = () =>
  `${window.location.origin}/api/auth/native/callback?next=%2F&provider=google&attemptId=0123456789abcdef0123456789abcdef`;

describe('AuthPageContent — callbackUrl redirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.status = 'unauthenticated';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('when the value would leave the site', () => {
    it.each(OFF_SITE_QUERIES)('sends a signed-in visitor to / for %s', async (_label, query) => {
      sessionState.status = 'authenticated';
      openLoginPage(query);
      await waitFor(() => expect(localeRouter.push).toHaveBeenCalledWith('/'));
      expect(localeRouter.push).toHaveBeenCalledTimes(1);
    });

    it.each(OFF_SITE_QUERIES)('sends a password login to / for %s', async (_label, query) => {
      mockSignIn.mockResolvedValueOnce({ ok: true });
      openLoginPage(query);
      submitLogin();
      await waitFor(() => expect(localeRouter.push).toHaveBeenCalledWith('/'));
      expect(localeRouter.push).toHaveBeenCalledTimes(1);
    });

    it('sends a new account to / too', async () => {
      stubSuccessfulRegistration();
      mockSignIn.mockResolvedValueOnce({ ok: true });
      openLoginPage('callbackUrl=/%09/evil');
      submitRegister();
      await waitFor(() => expect(localeRouter.push).toHaveBeenCalledWith('/'));
      expect(localeRouter.push).toHaveBeenCalledTimes(1);
    });
  });

  describe('when the value is a real return path', () => {
    it.each(REAL_RETURN_PATHS)('returns a signed-in visitor to %s', async (returnPath) => {
      sessionState.status = 'authenticated';
      openLoginPage(callbackQuery(returnPath));
      await waitFor(() => expect(localeRouter.push).toHaveBeenCalledWith(returnPath));
    });

    it('goes to / with no callbackUrl', async () => {
      sessionState.status = 'authenticated';
      openLoginPage('');
      await waitFor(() => expect(localeRouter.push).toHaveBeenCalledWith('/'));
    });

    it('keeps the absolute URL NextAuth sends after a failed social sign-in', async () => {
      const returnUrl = `${window.location.origin}/gym/bloclab/manage?claim=1`;
      mockSignIn.mockResolvedValueOnce({ ok: true });
      openLoginPage(`${callbackQuery(returnUrl)}&error=OAuthAccountNotLinked`);
      submitLogin();
      await waitFor(() => expect(localeRouter.push).toHaveBeenCalledWith(returnUrl));
    });

    it('keeps a new account on its absolute return URL', async () => {
      const returnUrl = `${window.location.origin}/gym/bloclab/manage`;
      stubSuccessfulRegistration();
      mockSignIn.mockResolvedValueOnce({ ok: true });
      openLoginPage(callbackQuery(returnUrl));
      submitRegister();
      await waitFor(() => expect(localeRouter.push).toHaveBeenCalledWith(returnUrl));
    });

    it('keeps the phone browser fallback on its callback after a failed attempt', async () => {
      const returnUrl = nativeCallbackUrl();
      mockSignIn.mockResolvedValueOnce({ ok: true });
      openLoginPage(`${callbackQuery(returnUrl)}&error=OAuthCallback`);
      submitLogin();
      await waitFor(() => expect(localeRouter.push).toHaveBeenCalledWith(returnUrl));
    });
  });

  describe('the social buttons', () => {
    it.each([
      ['the phone browser fallback callback', nativeCallbackUrl],
      [
        'the Expo web return URL',
        () =>
          'https://app.boardsesh.com/auth/login?boardseshOAuthProvider=google&boardseshOAuthAttempt=attempt-1&next=%2Fb%2Fthe-garage',
      ],
    ])('receive %s untouched, for NextAuth to validate', (_label, buildReturnUrl) => {
      const returnUrl = buildReturnUrl();
      openLoginPage(`${callbackQuery(returnUrl)}&error=OAuthCallback`);
      expect(socialLoginButtons.mock.lastCall?.[0].callbackUrl).toBe(returnUrl);
    });
  });
});
