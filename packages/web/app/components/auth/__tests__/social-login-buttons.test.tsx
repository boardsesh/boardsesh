import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import SocialLoginButtons from '../social-login-buttons';

const { signIn } = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock('@/app/lib/auth/web-session-events', () => ({ signInWithSessionIntent: signIn }));
vi.mock('@/app/lib/ble/capacitor-utils', () => ({ isNativeApp: () => false }));
vi.mock('@/app/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('@/app/lib/oauth-pending-db', () => ({ setOAuthPending: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: (namespace: string) => ({ t: (key: string) => tFromCatalog(namespace, key) }),
}));
beforeEach(() => {
  signIn.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('supported social sign-in buttons', () => {
  it('offers Google and Apple while ignoring an older Facebook-enabled config', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ google: true, apple: true, facebook: true })),
    );
    render(<SocialLoginButtons callbackUrl="/settings" />);
    const google = await screen.findByRole('button', { name: 'Continue with Google' });
    const apple = screen.getByRole('button', { name: 'Continue with Apple' });
    expect(screen.queryByRole('button', { name: /facebook/i })).toBeNull();
    fireEvent.click(google);
    await waitFor(() => expect(google.hasAttribute('disabled')).toBe(false));
    fireEvent.click(apple);
    expect(signIn).toHaveBeenNthCalledWith(
      1,
      'google',
      { callbackUrl: '/settings' },
      { signal: expect.any(AbortSignal) },
    );
    expect(signIn).toHaveBeenNthCalledWith(
      2,
      'apple',
      { callbackUrl: '/settings' },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('renders no sign-in option when only the removed provider is configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ google: false, apple: false, facebook: true })),
    );
    const { container } = render(<SocialLoginButtons />);
    await waitFor(() => expect(container.textContent).toBe(''));
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
  it('keeps duplicate provider starts disabled through the pending operation and aborts on unmount', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ google: true, apple: true })),
    );
    let settle!: () => void;
    signIn.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const rendered = render(<SocialLoginButtons />);
    const google = await screen.findByRole('button', { name: 'Continue with Google' });
    const apple = screen.getByRole('button', { name: 'Continue with Apple' });
    fireEvent.click(google);
    fireEvent.click(apple);
    expect(signIn).toHaveBeenCalledOnce();
    const context: unknown = signIn.mock.calls[0]?.[2];
    if (!context || typeof context !== 'object' || !('signal' in context) || !(context.signal instanceof AbortSignal))
      throw new Error('Missing captured provider lifetime');
    expect(context.signal.aborted).toBe(false);
    rendered.unmount();
    expect(context.signal.aborted).toBe(true);
    settle();
    await Promise.resolve();
  });
  it('shows the existing retry copy for a refused canonical start without retrying', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ google: true, apple: true })),
    );
    signIn.mockResolvedValue({ error: 'AuthBackendUnavailable', ok: false, status: 503, url: null });
    render(<SocialLoginButtons />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    await screen.findByText(tFromCatalog('auth', 'nativeStart.oauthError'));
    expect(signIn).toHaveBeenCalledOnce();
  });
});
