import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import SetPasswordSection from '../set-password-section';
import { browserSessionGuard, WEB_SESSION_CHECK_EVENT } from '@/app/lib/auth/session-guard';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// Mock server-only
vi.mock('server-only', () => ({}));

// Mock snackbar
const mockShowMessage = vi.fn();
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

const reloadAfterAccountChange = vi.hoisted(() => vi.fn());
const refreshAccessTokenAfterCredentialChange = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/app/lib/auth/browser-access-token', async (original) => ({
  ...(await original<typeof import('@/app/lib/auth/browser-access-token')>()),
  refreshAccessTokenAfterCredentialChange,
}));
vi.mock('@/app/lib/auth/reload-after-account-change', () => ({ reloadAfterAccountChange }));

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // A fresh guard per case: it counts refused writes.
  delete (globalThis as typeof globalThis & { [key: symbol]: unknown })[Symbol.for('boardsesh.web-session-guard.v1')];
  mockFetch = vi.fn();
  global.fetch = mockFetch as unknown as typeof fetch;
});

describe('SetPasswordSection', () => {
  describe('when hasPassword is true', () => {
    it('shows password enabled status', () => {
      render(
        <SetPasswordSection
          hasPassword
          userEmail="user@example.com"
          linkedProviders={['google']}
          onPasswordSet={vi.fn()}
        />,
      );

      expect(screen.getByText('Password login is enabled for user@example.com')).toBeTruthy();
    });

    it('does not show the set password form', () => {
      render(
        <SetPasswordSection
          hasPassword
          userEmail="user@example.com"
          linkedProviders={['google']}
          onPasswordSet={vi.fn()}
        />,
      );

      expect(screen.queryByLabelText('Password')).toBeNull();
      expect(screen.queryByText('Set Password')).toBeNull();
    });
  });

  describe('when hasPassword is false', () => {
    it('shows the set password form', () => {
      render(
        <SetPasswordSection
          hasPassword={false}
          userEmail="user@example.com"
          linkedProviders={['google']}
          onPasswordSet={vi.fn()}
        />,
      );

      expect(screen.getByLabelText('Password')).toBeTruthy();
      expect(screen.getByLabelText('Confirm Password')).toBeTruthy();
      expect(screen.getByText('Set Password')).toBeTruthy();
    });

    it('shows linked provider info', () => {
      render(
        <SetPasswordSection
          hasPassword={false}
          userEmail="user@example.com"
          linkedProviders={['google']}
          onPasswordSet={vi.fn()}
        />,
      );

      expect(screen.getByText(/signed in with Google/)).toBeTruthy();
    });

    it('shows multiple providers', () => {
      render(
        <SetPasswordSection
          hasPassword={false}
          userEmail="user@example.com"
          linkedProviders={['google', 'apple']}
          onPasswordSet={vi.fn()}
        />,
      );

      expect(screen.getByText(/signed in with Google, Apple/)).toBeTruthy();
    });

    it('validates empty password', async () => {
      render(
        <SetPasswordSection
          hasPassword={false}
          userEmail="user@example.com"
          linkedProviders={[]}
          onPasswordSet={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByText('Set Password'));

      await waitFor(() => {
        expect(screen.getByText('Please enter a password')).toBeTruthy();
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('validates password minimum length', async () => {
      render(
        <SetPasswordSection
          hasPassword={false}
          userEmail="user@example.com"
          linkedProviders={[]}
          onPasswordSet={vi.fn()}
        />,
      );

      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } });
      fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'short' } });
      fireEvent.click(screen.getByText('Set Password'));

      await waitFor(() => {
        expect(screen.getByText('Password must be at least 8 characters')).toBeTruthy();
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('validates password confirmation mismatch', async () => {
      render(
        <SetPasswordSection
          hasPassword={false}
          userEmail="user@example.com"
          linkedProviders={[]}
          onPasswordSet={vi.fn()}
        />,
      );

      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'testpass123' } });
      fireEvent.change(screen.getByLabelText('Confirm Password'), {
        target: { value: 'different123' },
      });
      fireEvent.click(screen.getByText('Set Password'));

      await waitFor(() => {
        expect(screen.getByText('Passwords do not match')).toBeTruthy();
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('calls API and shows success on valid submission', async () => {
      const onPasswordSet = vi.fn();
      mockFetch.mockImplementation(async () => Response.json({ message: 'Password set successfully.' }));

      render(
        <SetPasswordSection
          hasPassword={false}
          userEmail="user@example.com"
          linkedProviders={['google']}
          onPasswordSet={onPasswordSet}
        />,
      );

      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'testpass123' } });
      fireEvent.change(screen.getByLabelText('Confirm Password'), {
        target: { value: 'testpass123' },
      });
      fireEvent.click(screen.getByText('Set Password'));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/internal/set-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: 'testpass123', confirmPassword: 'testpass123' }),
        });
      });

      await waitFor(() => {
        expect(mockShowMessage).toHaveBeenCalledWith(
          'Password set! You can now log in with your email and password.',
          'success',
        );
      });

      expect(onPasswordSet).toHaveBeenCalled();
    });

    it('shows error message on API failure', async () => {
      mockFetch.mockImplementation(async () => Response.json({ error: 'Password already set.' }, { status: 400 }));

      render(
        <SetPasswordSection
          hasPassword={false}
          userEmail="user@example.com"
          linkedProviders={[]}
          onPasswordSet={vi.fn()}
        />,
      );

      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'testpass123' } });
      fireEvent.change(screen.getByLabelText('Confirm Password'), {
        target: { value: 'testpass123' },
      });
      fireEvent.click(screen.getByText('Set Password'));

      await waitFor(() => {
        expect(mockShowMessage).toHaveBeenCalledWith('Password already set.', 'error');
      });
    });

    it('shows generic error on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      render(
        <SetPasswordSection
          hasPassword={false}
          userEmail="user@example.com"
          linkedProviders={[]}
          onPasswordSet={vi.fn()}
        />,
      );

      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'testpass123' } });
      fireEvent.change(screen.getByLabelText('Confirm Password'), {
        target: { value: 'testpass123' },
      });
      fireEvent.click(screen.getByText('Set Password'));

      await waitFor(() => {
        expect(mockShowMessage).toHaveBeenCalledWith('Failed to set password. Please try again.', 'error');
      });
    });

    it('keeps the typed password after a refusal: try again, then reload', async () => {
      mockFetch.mockImplementation(async () =>
        Response.json({ code: 'viewer_changed', error: 'Reload this page.' }, { status: 409 }),
      );
      // The session provider's probe finds the page's own account: nothing changes.
      const checks = vi.fn(() => browserSessionGuard().sessionChecked(browserSessionGuard().sessionReadStarted()));
      window.addEventListener(WEB_SESSION_CHECK_EVENT, checks);
      const onPasswordSet = vi.fn();

      render(
        <SetPasswordSection
          hasPassword={false}
          userEmail="user@example.com"
          linkedProviders={[]}
          onPasswordSet={onPasswordSet}
        />,
      );

      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'testpass123' } });
      fireEvent.change(screen.getByLabelText('Confirm Password'), {
        target: { value: 'testpass123' },
      });
      fireEvent.click(screen.getByText('Set Password'));

      expect(await screen.findByText(tFromCatalog('settings', 'writeRefused.tryAgain'))).toBeTruthy();
      expect(checks).toHaveBeenCalledOnce();
      await waitFor(() => expect(screen.getByText('Set Password').closest('button')?.disabled).toBe(false));
      expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('testpass123');
      expect(screen.queryByText(tFromCatalog('settings', 'reloadRequired.message'))).toBeNull();

      fireEvent.click(screen.getByText('Set Password'));

      expect(await screen.findByText(tFromCatalog('settings', 'reloadRequired.message'))).toBeTruthy();
      window.removeEventListener(WEB_SESSION_CHECK_EVENT, checks);
      // A write is never sent twice per press.
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockShowMessage).not.toHaveBeenCalled();
      expect(onPasswordSet).not.toHaveBeenCalled();
    });

    it('disables submit button while saving', async () => {
      let resolveFetch: (value: unknown) => void;
      mockFetch.mockReturnValue(
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
      );

      render(
        <SetPasswordSection
          hasPassword={false}
          userEmail="user@example.com"
          linkedProviders={[]}
          onPasswordSet={vi.fn()}
        />,
      );

      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'testpass123' } });
      fireEvent.change(screen.getByLabelText('Confirm Password'), {
        target: { value: 'testpass123' },
      });
      fireEvent.click(screen.getByText('Set Password'));

      // Button should be disabled while the request is in-flight
      await waitFor(() => {
        const button = screen.getByRole('button', { name: /Set Password/i });
        expect(button.hasAttribute('disabled')).toBe(true);
      });

      // Resolve the fetch to clean up
      resolveFetch!(Response.json({ message: 'Password set successfully.' }));

      await waitFor(() => {
        const button = screen.getByRole('button', { name: /Set Password/i });
        expect(button.hasAttribute('disabled')).toBe(false);
      });
    });

    it('does not show provider alert when no providers linked', () => {
      render(
        <SetPasswordSection
          hasPassword={false}
          userEmail="user@example.com"
          linkedProviders={[]}
          onPasswordSet={vi.fn()}
        />,
      );

      expect(screen.queryByText(/signed in with/)).toBeNull();
    });
  });
});

it('offers a translated reauthentication route and never claims the password was saved', async () => {
  const saved = vi.fn();
  mockFetch.mockImplementation(async () => Response.json({ error: 'reauthentication_required' }, { status: 403 }));
  render(
    <SetPasswordSection
      hasPassword={false}
      userEmail="synthetic@example.com"
      linkedProviders={['google']}
      onPasswordSet={saved}
    />,
  );
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'new-password' } });
  fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'new-password' } });
  fireEvent.click(screen.getByText('Set Password'));
  const action = await screen.findByRole('link', { name: 'Sign in again' });
  expect(screen.getByText('Sign in again to set a password.')).toBeTruthy();
  expect(action.getAttribute('href')).toContain('/auth/signout?callbackUrl=');
  expect(saved).not.toHaveBeenCalled();
  expect(mockShowMessage).not.toHaveBeenCalled();
});

it('clears both secrets and refreshes account identity when a different tab changed accounts', async () => {
  const saved = vi.fn();
  const changed = vi.fn().mockResolvedValue(undefined);
  mockFetch.mockImplementation(async () => Response.json({ error: 'identity_changed' }, { status: 409 }));
  render(
    <SetPasswordSection
      hasPassword={false}
      userEmail="synthetic@example.com"
      linkedProviders={[]}
      onPasswordSet={saved}
      onAccountChanged={changed}
      expectedSession={{ userId: 'synthetic-owner', authSessionId: 'synthetic-sid' }}
    />,
  );
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'new-password' } });
  fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'new-password' } });
  fireEvent.click(screen.getByText('Set Password'));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Confirm Password') as HTMLInputElement).value).toBe('');
  expect(saved).not.toHaveBeenCalled();
});

function submitNewPassword(props: { onPasswordSet: () => void; onAccountChanged?: () => Promise<void> }) {
  render(
    <SetPasswordSection
      hasPassword={false}
      userEmail="synthetic@example.com"
      linkedProviders={[]}
      expectedSession={{ userId: 'synthetic-owner', authSessionId: 'synthetic-sid' }}
      {...props}
    />,
  );
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'new-password' } });
  fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'new-password' } });
  fireEvent.click(screen.getByText('Set Password'));
}

it('shows an account that already has a password as such, never as this password saved, and refreshes its token (#7596 B4b)', async () => {
  const saved = vi.fn();
  mockFetch.mockImplementation(async () =>
    Response.json({ error: 'Password already set.', code: 'already_set' }, { status: 409 }),
  );
  submitNewPassword({ onPasswordSet: saved });
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  // The card flips to its "password login is enabled" state; no toast claims this password was saved.
  expect(mockShowMessage).not.toHaveBeenCalled();
  expect(refreshAccessTokenAfterCredentialChange).toHaveBeenCalledOnce();
});

it('reloads from the root when the server says the tab shows another login (#7596 B4b)', async () => {
  const saved = vi.fn();
  const changed = vi.fn().mockResolvedValue(undefined);
  mockFetch.mockImplementation(async () =>
    Response.json({ error: 'identity_changed', reload: 'root' }, { status: 409 }),
  );
  submitNewPassword({ onPasswordSet: saved, onAccountChanged: changed });
  await waitFor(() => expect(reloadAfterAccountChange).toHaveBeenCalledOnce());
  expect(changed).not.toHaveBeenCalled();
  expect(saved).not.toHaveBeenCalled();
});

it('keeps the ordinary set-password form for an Apple-only account with a known session', async () => {
  const saved = vi.fn();
  mockFetch.mockImplementation(async () => Response.json({ success: true }));
  render(
    <SetPasswordSection
      hasPassword={false}
      userEmail="synthetic@example.com"
      linkedProviders={['apple']}
      onPasswordSet={saved}
      onAccountChanged={vi.fn()}
      expectedSession={{ userId: 'synthetic-owner', authSessionId: 'synthetic-sid' }}
    />,
  );
  expect(screen.getByText(/signed in with Apple/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'new-password' } });
  fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'new-password' } });
  fireEvent.click(screen.getByText('Set Password'));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  const [path, init] = mockFetch.mock.calls[0] as [string, { body: string }];
  expect(path).toBe('/api/internal/set-password');
  expect(JSON.parse(init.body)).toEqual({
    password: 'new-password',
    confirmPassword: 'new-password',
    expectedUserId: 'synthetic-owner',
    expectedAuthSessionId: 'synthetic-sid',
  });
});
