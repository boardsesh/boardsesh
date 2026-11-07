/**
 * The resend form's failure paths used to be swallowed (or toasted) — they now
 * surface in the FormShell alert. These tests pin that behaviour for both the
 * API-error response and a thrown fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

vi.mock('@/app/lib/i18n/use-locale-router', () => ({
  useLocaleRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

const { default: VerifyRequestContent } = await import('../verify-request-content');

async function submitResend() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'climber@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: /resend/i }));
}

describe('VerifyRequestContent — inline resend errors', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('surfaces an API error response in the form alert', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Too many attempts. Try later.' }),
    });
    render(<VerifyRequestContent />);

    await submitResend();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Too many attempts/i);
  });

  it('surfaces a thrown fetch (network down) instead of swallowing it', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    render(<VerifyRequestContent />);

    await submitResend();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Failed to send verification email/i);
    expect((screen.getByRole('button', { name: /resend/i }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('translates retryable backend failure without exposing its implementation code', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ error: 'AuthBackendUnavailable' }),
    });
    render(<VerifyRequestContent />);
    await submitResend();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Failed to send verification email/i);
    expect(alert.textContent).not.toContain('AuthBackendUnavailable');
    expect((screen.getByRole('button', { name: /resend/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
