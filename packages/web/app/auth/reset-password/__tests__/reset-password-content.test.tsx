import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

const mockRouterPush = vi.fn();
const mockSearchParams = new URLSearchParams();

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

vi.mock('@/app/components/brand/logo', () => ({
  default: () => <div data-testid="logo" />,
}));

vi.mock('@/app/components/back-button', () => ({
  default: () => <button data-testid="back-button" />,
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock('@/app/theme/theme-config', () => ({
  themeTokens: { shadows: { xs: '0 1px 2px rgba(0,0,0,0.05)' } },
}));

const mockShowMessage = vi.fn();

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof global.fetch;

import ResetPasswordContent from '../reset-password-content';

function renderWithParams(token?: string, email?: string) {
  mockSearchParams.delete('token');
  mockSearchParams.delete('email');
  if (token) mockSearchParams.set('token', token);
  if (email) mockSearchParams.set('email', email);
  return render(<ResetPasswordContent />);
}

describe('ResetPasswordContent', () => {
  beforeEach(() => {
    mockShowMessage.mockClear();
    mockFetch.mockClear();
    mockRouterPush.mockClear();
  });

  it('shows invalid link message when token or email is missing', () => {
    renderWithParams();
    expect(screen.getByText(/invalid/i)).toBeTruthy();
    expect(screen.queryByLabelText(/new password/i)).toBeNull();
  });

  it('shows invalid link when only token is provided', () => {
    renderWithParams('some-token', undefined);
    expect(screen.getByText(/invalid/i)).toBeTruthy();
  });

  it('shows password fields when both token and email are present', () => {
    renderWithParams('abc-token', 'user@example.com');
    expect(screen.getByLabelText(/^new password$/i)).toBeTruthy();
    expect(screen.getByLabelText(/confirm new password/i)).toBeTruthy();
  });

  it('shows error when password field is empty', async () => {
    renderWithParams('abc-token', 'user@example.com');
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));
    expect(await screen.findByText(/please enter a new password/i)).toBeTruthy();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('shows error when password is too short', async () => {
    renderWithParams('abc-token', 'user@example.com');
    fireEvent.change(screen.getByLabelText(/^new password$/i), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));
    expect(await screen.findByText(/at least 8 characters/i)).toBeTruthy();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('shows mismatch error when passwords do not match', async () => {
    renderWithParams('abc-token', 'user@example.com');
    fireEvent.change(screen.getByLabelText(/^new password$/i), { target: { value: 'SecurePass1!' } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: 'DifferentPass!' } });
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));
    expect(await screen.findByText(/passwords do not match/i)).toBeTruthy();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('submits and redirects on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: 'Password reset successful.' }),
    });
    renderWithParams('abc-token', 'user@example.com');
    fireEvent.change(screen.getByLabelText(/^new password$/i), { target: { value: 'SecurePass1!' } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: 'SecurePass1!' } });
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledOnce());
    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith('/auth/login'));
  });

  it('shows error toast when API returns failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Invalid or expired reset link' }),
    });
    renderWithParams('abc-token', 'user@example.com');
    fireEvent.change(screen.getByLabelText(/^new password$/i), { target: { value: 'SecurePass1!' } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: 'SecurePass1!' } });
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));
    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith('Invalid or expired reset link', 'error'));
    expect(mockRouterPush).not.toHaveBeenCalled();
  });
});
