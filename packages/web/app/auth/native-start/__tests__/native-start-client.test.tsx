import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import NativeStartClient from '../native-start-client';

const { selection, getCsrfToken, readiness, canonicalStart, preflight } = vi.hoisted(() => ({
  selection: { provider: 'facebook', callbackUrl: '' },
  getCsrfToken: vi.fn<() => Promise<string | undefined>>(async () => undefined),
  readiness: { coordinator: false, provider: false },
  canonicalStart: vi.fn<typeof import('@/app/lib/auth/canonical-provider-start').startCanonicalProviderSignin>(
    async () => {},
  ),
  preflight: vi.fn(async () => {}),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () =>
    new URLSearchParams({
      provider: selection.provider,
      ...(selection.callbackUrl ? { callbackUrl: selection.callbackUrl } : {}),
    }),
}));
vi.mock('next-auth/react', () => ({ getCsrfToken }));
vi.mock('@/app/lib/auth/canonical-provider-start', () => ({ startCanonicalProviderSignin: canonicalStart }));
vi.mock('@/app/lib/auth/browser-coordinator-readiness', () => ({
  publicBrowserCoordinatorReady: () => readiness.coordinator,
}));
vi.mock('@/app/lib/auth/provider-security-readiness', () => ({
  publicProviderSecurityReady: () => readiness.provider,
}));
vi.mock('@/app/lib/auth/browser-coordinator-client', () => ({ readCanonicalBrowserCoordinator: preflight }));
vi.mock('react-i18next', () => ({
  useTranslation: (namespace: string) => ({ t: (key: string) => tFromCatalog(namespace, key) }),
}));

beforeEach(() => {
  selection.callbackUrl = '';
  getCsrfToken.mockReset().mockResolvedValue(undefined);
  readiness.coordinator = false;
  readiness.provider = false;
  canonicalStart.mockReset().mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('native browser provider start', () => {
  it('refuses Facebook before requesting CSRF or creating a sign-in form', () => {
    selection.provider = 'facebook';
    const { container } = render(<NativeStartClient />);
    expect(screen.getByText(tFromCatalog('auth', 'nativeStart.invalidProvider'))).toBeTruthy();
    expect(getCsrfToken).not.toHaveBeenCalled();
    expect(container.querySelector('form')).toBeNull();
  });

  it.each(['google', 'apple'])('still prepares the supported %s sign-in form', async (provider) => {
    selection.provider = provider;
    const { container } = render(<NativeStartClient />);
    await waitFor(() => expect(getCsrfToken).toHaveBeenCalledOnce());
    expect(container.querySelector('form')?.getAttribute('action')).toBe(`/api/auth/signin/${provider}`);
  });
  it.each(['google', 'apple'])(
    'joins %s to the actual canonical transport and configured server origin when both gates qualify',
    async (provider) => {
      readiness.coordinator = true;
      readiness.provider = true;
      selection.provider = provider;
      render(<NativeStartClient canonicalAuthOrigin="https://www.boardsesh.com" />);
      await waitFor(() => expect(canonicalStart).toHaveBeenCalledOnce());
      const [input, dependencies] = canonicalStart.mock.calls[0];
      expect(input).toMatchObject({ canonicalOrigin: 'https://www.boardsesh.com', provider, callbackUrl: '/' });
      expect(dependencies.preflight).toBe(preflight);
      expect(dependencies.currentOrigin).toBe(window.location.origin);
      expect(dependencies.beforeSignin).toEqual(expect.any(Function));
      expect(getCsrfToken).not.toHaveBeenCalled();
    },
  );
  it.each(['coordinator', 'provider'] as const)(
    'refuses a partially qualified %s gate without legacy fallback',
    async (gate) => {
      readiness[gate] = true;
      selection.provider = 'google';
      render(<NativeStartClient canonicalAuthOrigin="https://www.boardsesh.com" />);
      await screen.findByText(tFromCatalog('auth', 'nativeStart.oauthError'));
      expect(canonicalStart).not.toHaveBeenCalled();
      expect(getCsrfToken).not.toHaveBeenCalled();
    },
  );
  it('does not infer the canonical authority from the current URL when its server prop is missing', async () => {
    readiness.coordinator = true;
    readiness.provider = true;
    selection.provider = 'google';
    render(<NativeStartClient />);
    await screen.findByText(tFromCatalog('auth', 'nativeStart.oauthError'));
    expect(canonicalStart).not.toHaveBeenCalled();
    expect(getCsrfToken).not.toHaveBeenCalled();
  });
  it('keeps canonical transport failures on the retry surface without submitting a legacy form', async () => {
    readiness.coordinator = true;
    readiness.provider = true;
    selection.provider = 'google';
    canonicalStart.mockRejectedValue(new Error('UNAVAILABLE'));
    render(<NativeStartClient canonicalAuthOrigin="https://www.boardsesh.com" />);
    await screen.findByText(tFromCatalog('auth', 'nativeStart.oauthError'));
    expect(screen.getByRole('button', { name: tFromCatalog('auth', 'nativeStart.retryProviders') })).toBeTruthy();
    expect(getCsrfToken).not.toHaveBeenCalled();
    expect(canonicalStart).toHaveBeenCalledOnce();
  });
  it.each(['csrf', 'attribution'] as const)(
    'shows retry after a timed-out legacy %s physically settles without submitting',
    async (pending) => {
      vi.useFakeTimers();
      selection.provider = 'google';
      const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
      let settle!: () => void;
      if (pending === 'csrf')
        getCsrfToken.mockImplementation(
          () =>
            new Promise<string>((resolve) => {
              settle = () => resolve('held-csrf');
            }),
        );
      else {
        selection.callbackUrl = `${window.location.origin}/api/auth/native/callback?attemptId=${'a'.repeat(32)}`;
        vi.stubGlobal(
          'fetch',
          vi.fn(
            () =>
              new Promise<Response>((resolve) => {
                settle = () => resolve(new Response(null));
              }),
          ),
        );
      }
      render(<NativeStartClient />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(settle).toEqual(expect.any(Function));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(submit).not.toHaveBeenCalled();
      await act(async () => {
        settle();
        await Promise.resolve();
      });
      expect(screen.queryByRole('button', { name: tFromCatalog('auth', 'nativeStart.retryProviders') })).toBeTruthy();
      expect(submit).not.toHaveBeenCalled();
      if (pending === 'attribution') expect(getCsrfToken).not.toHaveBeenCalled();
    },
  );
  it('aborts the exact pending canonical operation on unmount', async () => {
    readiness.coordinator = true;
    readiness.provider = true;
    selection.provider = 'google';
    let settle!: () => void;
    canonicalStart.mockImplementation(
      async () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const rendered = render(<NativeStartClient canonicalAuthOrigin="https://www.boardsesh.com" />);
    await waitFor(() => expect(canonicalStart).toHaveBeenCalledOnce());
    const signal = canonicalStart.mock.calls[0][0].signal;
    expect(signal.aborted).toBe(false);
    rendered.unmount();
    expect(signal.aborted).toBe(true);
    settle();
    await Promise.resolve();
  });
});
