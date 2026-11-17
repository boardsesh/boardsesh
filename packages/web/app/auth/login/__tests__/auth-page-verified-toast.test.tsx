/**
 * The "email verified" toast after the verify-email redirect. The snackbar's
 * showMessage changes when the account does (a sign-in on this page), and the
 * toast must not show a second time when it does.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import React from 'react';
import { render } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

const snackbar = vi.hoisted(() => ({ showMessage: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('next-auth/react', () => ({
  getSession: vi.fn().mockResolvedValue(null),
  signIn: vi.fn(),
  useSession: () => ({ status: 'unauthenticated', data: null }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/auth/login',
  useSearchParams: () => new URLSearchParams('verified=true'),
}));

vi.mock('@/app/components/auth/social-login-buttons', () => ({
  default: () => null,
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: snackbar.showMessage }),
}));

vi.mock('@/app/lib/analytics', () => ({
  track: vi.fn(),
  setPersonProperties: vi.fn(),
}));

const { default: AuthPageContent } = await import('../auth-page-content');

describe('AuthPageContent — verified toast', () => {
  it('greets a verified email once, even when showMessage changes with the account', () => {
    const beforeSignIn = vi.fn();
    snackbar.showMessage = beforeSignIn;
    const page = render(<AuthPageContent />);

    const afterSignIn = vi.fn();
    snackbar.showMessage = afterSignIn;
    page.rerender(<AuthPageContent />);

    expect(beforeSignIn).toHaveBeenCalledExactlyOnceWith('Email verified! You can now log in.', 'success');
    expect(afterSignIn).not.toHaveBeenCalled();
  });
});
