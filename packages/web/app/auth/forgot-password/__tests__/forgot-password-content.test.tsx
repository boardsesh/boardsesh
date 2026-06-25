import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
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

import ForgotPasswordContent from '../forgot-password-content';

/** Submit the form via its native submit event (fireEvent.click on type=submit doesn't trigger onSubmit in jsdom). */
function submitForm(container: HTMLElement) {
  const form = container.querySelector('form');
  if (!form) throw new Error('No form found');
  fireEvent.submit(form);
}

describe('ForgotPasswordContent', () => {
  beforeEach(() => {
    mockShowMessage.mockClear();
    mockFetch.mockClear();
  });

  it('shows email required error when submitting empty form', async () => {
    const { container } = render(<ForgotPasswordContent />);
    submitForm(container);
    expect(await screen.findByText(/please enter your email/i)).toBeTruthy();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('shows email invalid error for malformed address', async () => {
    const { container } = render(<ForgotPasswordContent />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'notanemail' } });
    submitForm(container);
    expect(await screen.findByText(/please enter a valid email/i)).toBeTruthy();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('submits valid email and shows inline confirmation (hides form)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: 'If an account exists...' }),
    });
    const { container } = render(<ForgotPasswordContent />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
    submitForm(container);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledOnce());
    expect(mockFetch).toHaveBeenCalledWith('/api/auth/forgot-password', expect.objectContaining({ method: 'POST' }));
    // Form hides and confirmation message appears
    expect(screen.queryByLabelText(/email/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /send reset link/i })).toBeNull();
    expect(screen.getByText(/if an account exists/i)).toBeTruthy();
  });

  it('shows error toast when API returns failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Too many requests' }),
    });
    const { container } = render(<ForgotPasswordContent />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'test@example.com' } });
    submitForm(container);
    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith('Too many requests', 'error'));
  });
});
