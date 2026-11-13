import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
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
    fireEvent.click(apple);
    expect(signIn.mock.calls).toEqual([
      ['google', { callbackUrl: '/settings' }],
      ['apple', { callbackUrl: '/settings' }],
    ]);
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
});
