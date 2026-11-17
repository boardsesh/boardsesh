import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import NativeStartClient from '../native-start-client';

const { selection, getCsrfToken } = vi.hoisted(() => ({
  selection: { provider: 'facebook', callbackUrl: '' },
  getCsrfToken: vi.fn<() => Promise<string | undefined>>(async () => undefined),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () =>
    new URLSearchParams({
      provider: selection.provider,
      ...(selection.callbackUrl ? { callbackUrl: selection.callbackUrl } : {}),
    }),
}));
vi.mock('next-auth/react', () => ({ getCsrfToken }));
vi.mock('react-i18next', () => ({
  useTranslation: (namespace: string) => ({ t: (key: string) => tFromCatalog(namespace, key) }),
}));

beforeEach(() => {
  selection.callbackUrl = '';
  getCsrfToken.mockReset().mockResolvedValue(undefined);
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

  it('records the native attempt, then fills the CSRF token and submits the Google form', async () => {
    selection.provider = 'google';
    const attemptId = 'a'.repeat(32);
    selection.callbackUrl = `${window.location.origin}/api/auth/native/callback?attemptId=${attemptId}`;
    const attributionFetch = vi.fn<typeof fetch>(async () => new Response(null));
    vi.stubGlobal('fetch', attributionFetch);
    getCsrfToken.mockResolvedValue('csrf');
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    const { container } = render(<NativeStartClient />);
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(attributionFetch).toHaveBeenCalledOnce();
    const [attemptUrl, attemptInit] = attributionFetch.mock.calls[0];
    expect(attemptUrl).toBe('/api/auth/native/attempt');
    expect(attemptInit?.method).toBe('POST');
    const attemptBody = attemptInit?.body;
    expect(typeof attemptBody).toBe('string');
    expect(JSON.parse(attemptBody as string)).toEqual({ attemptId, provider: 'google' });
    expect(getCsrfToken).toHaveBeenCalledOnce();
    expect(container.querySelector<HTMLInputElement>('input[name="csrfToken"]')?.value).toBe('csrf');
    expect(container.querySelector<HTMLInputElement>('input[name="callbackUrl"]')?.value).toBe(selection.callbackUrl);
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
});
