/**
 * The OAuth return path, end to end through the modal.
 *
 * `SocialLoginButtons` defaults its callback to '/', and a social sign-in
 * leaves the page entirely — so any intent the caller had (claim this gym, pin
 * this playlist) is lost on the homepage unless `callbackUrl` reaches the
 * buttons. `onSuccess` cannot cover it: that only fires on the email/password
 * path, which never leaves the page.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import React from 'react';
import { render, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { AuthModalProvider, useAuthModal } from '@/app/components/providers/auth-modal-provider';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('next-auth/react', () => ({
  signIn: vi.fn(),
}));

const socialLoginButtons = vi.hoisted(() => vi.fn((_props: { callbackUrl?: string }) => null));
vi.mock('@/app/components/auth/social-login-buttons', () => ({
  default: socialLoginButtons,
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

const { default: AuthModal } = await import('../auth-modal');

const lastSocialProps = () => socialLoginButtons.mock.calls.at(-1)?.[0];

beforeEach(() => {
  socialLoginButtons.mockClear();
});

describe('AuthModal — callbackUrl', () => {
  it('forwards the caller callback URL to the OAuth buttons', () => {
    render(<AuthModal open onClose={vi.fn()} callbackUrl="/gym/boulderwelt?claim=1" />);

    expect(lastSocialProps()?.callbackUrl).toBe('/gym/boulderwelt?claim=1');
  });

  it('passes nothing when the caller has no return path, leaving the buttons on their default', () => {
    render(<AuthModal open onClose={vi.fn()} />);

    expect(lastSocialProps()?.callbackUrl).toBeUndefined();
  });
});

describe('AuthModalProvider — callbackUrl', () => {
  it('carries callbackUrl from openAuthModal all the way to the OAuth buttons', () => {
    const { result } = renderHook(() => useAuthModal(), {
      wrapper: ({ children }: { children: React.ReactNode }) => <AuthModalProvider>{children}</AuthModalProvider>,
    });

    act(() => {
      result.current.openAuthModal({ callbackUrl: '/gym/boulderwelt?claim=1' });
    });

    expect(lastSocialProps()?.callbackUrl).toBe('/gym/boulderwelt?claim=1');
  });
});
