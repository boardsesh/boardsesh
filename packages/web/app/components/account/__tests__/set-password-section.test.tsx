import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import SetPasswordSection from '../set-password-section';

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

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
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
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ message: 'Password set successfully.' }),
      });

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
      mockFetch.mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Password already set.' }),
      });

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
      resolveFetch!({
        ok: true,
        json: () => Promise.resolve({ message: 'Password set successfully.' }),
      });

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
