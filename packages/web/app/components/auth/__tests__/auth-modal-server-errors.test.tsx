/**
 * Server-error paths for the modal login form: auth failures and thrown
 * signIn calls (network down) must surface in the form-level alert — a
 * swallowed catch previously left the form frozen with no feedback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const mockSignIn = vi.fn();
vi.mock('next-auth/react', () => ({
  getSession: vi.fn().mockResolvedValue(null),
  signIn: (...args: unknown[]) => mockSignIn(...args),
}));

vi.mock('../social-login-buttons', () => ({
  default: () => null,
}));

const mockShowMessage = vi.fn();
vi.mock('../../providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

const { default: AuthModal } = await import('../auth-modal');

function submitLogin() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'climber@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter22' } });
  fireEvent.click(screen.getByRole('button', { name: 'Login' }));
}

function submitRegister() {
  fireEvent.click(screen.getByRole('tab', { name: 'Create Account' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Crusher' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'climber@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2222' } });
  fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'hunter2222' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));
}

describe('AuthModal — login server errors', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // The network-failure path console.errors by design.
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    // Failed assertions must not leak a fetch stub into later tests.
    vi.unstubAllGlobals();
  });

  it('shows the invalid-credentials alert when signIn reports an auth error', async () => {
    mockSignIn.mockResolvedValueOnce({ error: 'CredentialsSignin', ok: false });
    const onClose = vi.fn();
    render(<AuthModal open onClose={onClose} />);

    submitLogin();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Invalid email or password/i);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows retryable authentication failure for backend unavailability, keeping the form open', async () => {
    mockSignIn.mockResolvedValueOnce({ error: 'AuthBackendUnavailable', status: 503, ok: false });
    render(<AuthModal open onClose={vi.fn()} />);
    submitLogin();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Authentication failed/i);
    expect(alert.textContent).not.toMatch(/Invalid email or password/i);
    expect((screen.getByRole('button', { name: 'Login' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('maps registration backend unavailability to translated auth-failed text without exposing its code', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: 'AuthBackendUnavailable' }) }),
    );
    render(<AuthModal open onClose={vi.fn()} />);
    submitRegister();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Authentication failed/i);
    expect(alert.textContent).not.toContain('AuthBackendUnavailable');
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it('keeps committed registration separate from a failed automatic login without repeating registration', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ requiresVerification: false }) });
    vi.stubGlobal('fetch', fetchMock);
    mockSignIn.mockResolvedValueOnce({ error: 'AuthBackendUnavailable', status: 503, ok: false });
    render(<AuthModal open onClose={vi.fn()} />);
    submitRegister();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Authentication failed/i);
    expect(screen.getByRole('button', { name: 'Login' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mockSignIn).toHaveBeenCalledOnce();
  });

  it('shows the generic auth-failed alert when signIn throws (network down)', async () => {
    mockSignIn.mockRejectedValueOnce(new Error('fetch failed'));
    const onClose = vi.fn();
    render(<AuthModal open onClose={onClose} />);

    submitLogin();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Authentication failed/i);
    // The form must stay open and interactive — no frozen state.
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Login' }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('surfaces a register API error in the register form alert', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: 'Email already registered' }) }),
    );
    render(<AuthModal open onClose={vi.fn()} />);

    submitRegister();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Email already registered/i);
  });

  it('surfaces a thrown register fetch (network down) in the register form alert', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network down')));
    render(<AuthModal open onClose={vi.fn()} />);

    submitRegister();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Registration failed\. Please try again/i);
  });

  it('does not resurface a stale register error after a tab round-trip', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network down')));
    render(<AuthModal open onClose={vi.fn()} />);

    submitRegister();
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('tab', { name: 'Login' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Create Account' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears the alert on a successful retry', async () => {
    mockSignIn.mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValueOnce({ ok: true, error: null });
    const onClose = vi.fn();
    render(<AuthModal open onClose={onClose} />);

    submitLogin();
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Login' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
