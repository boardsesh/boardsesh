// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A backend 5xx, or any gateway error whose body is not JSON, reaches the screen
// as the literal string `HTTP <status>` (src/lib/auth.ts). Rendering that put
// "HTTP 504" in the login form during a backend deploy — untranslated in every
// locale. These pin the mapping from failure shape to on-screen copy.

const auth = vi.hoisted(() => ({ signInWithCredentials: vi.fn() }));
const analytics = vi.hoisted(() => ({ track: vi.fn(), setPersonProperties: vi.fn() }));
const reporting = vi.hoisted(() => ({ reportError: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const form = vi.hoisted(() => ({
  setters: {} as Record<string, (text: string) => void>,
  submit: null as (() => void) | null,
}));

vi.mock('../../../src/lib/analytics', () => ({
  track: analytics.track,
  setPersonProperties: analytics.setPersonProperties,
}));
vi.mock('../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ signInWithCredentials: auth.signInWithCredentials }),
}));
vi.mock('../../../src/lib/error-reporting', () => ({ reportError: reporting.reportError }));
vi.mock('../../../src/hooks/use-native-oauth-sign-in', () => ({
  useNativeOAuthSignIn: () => ({ signIn: vi.fn(), inProgress: false }),
}));
vi.mock('../../../src/components/auth/OAuthProviderButtons', () => ({
  OAuthProviderButtons: () => null,
  useOAuthProviders: () => ({ loading: false, error: null, apple: false, google: false }),
}));
vi.mock('../../../src/lib/routing/anonymous-auth-gate', () => ({ readPostLoginReturnHref: () => null }));
vi.mock('../../../src/lib/discord', () => ({ openDiscordInvite: vi.fn() }));
vi.mock('../../../src/lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ colorScheme: 'light', systemColors: {}, brandColors: {} }),
}));
// `t` echoes the key, so an assertion names the catalog entry the screen chose.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useRouter: () => router }));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('react-native', () => ({
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Platform: { OS: 'android' },
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../src/components/AuthFieldset', () => ({
  AuthFieldset: ({
    fields,
    onSubmit,
  }: {
    fields: Array<{ key: string; onChangeText: (text: string) => void }>;
    onSubmit?: () => void;
  }) => {
    fields.forEach((field) => {
      form.setters[field.key] = field.onChangeText;
    });
    form.submit = onSubmit ?? null;
    return createElement('div');
  },
}));
vi.mock('../../../src/components/Button', () => ({
  Button: ({ title, onPress, loading }: { title: string; onPress?: () => void; loading?: boolean }) =>
    createElement('button', { onClick: onPress, disabled: loading }, title),
}));

import LoginScreen from '../login';

beforeEach(() => {
  auth.signInWithCredentials.mockReset();
  analytics.track.mockClear();
  reporting.reportError.mockClear();
  form.setters = {};
  form.submit = null;
});

async function submitLogin() {
  render(createElement(LoginScreen));
  await act(async () => {
    form.setters.email?.('climber@example.com');
    form.setters.password?.('supersecure1');
  });
  await act(async () => {
    form.submit?.();
  });
}

describe('LoginScreen error copy', () => {
  it('shows translated copy, never the raw "HTTP 504", when the gateway times out', async () => {
    auth.signInWithCredentials.mockResolvedValue({ success: false, status: 504, error: 'HTTP 504' });

    await submitLogin();

    await waitFor(() => expect(screen.getByText('login.toasts.authFailed')).toBeTruthy());
    expect(screen.queryByText('HTTP 504')).toBeNull();
  });

  it('still reports the gateway failure to Sentry with the raw status', async () => {
    auth.signInWithCredentials.mockResolvedValue({ success: false, status: 504, error: 'HTTP 504' });

    await submitLogin();

    await waitFor(() => expect(reporting.reportError).toHaveBeenCalled());
    expect(reporting.reportError.mock.calls[0][1]).toMatchObject({
      extra: { status: 504, server_error: 'HTTP 504' },
    });
  });

  it('maps a rate limit to its own copy without reporting an error', async () => {
    auth.signInWithCredentials.mockResolvedValue({
      success: false,
      status: 429,
      error: 'Rate limit exceeded. Try again in 42 seconds.',
    });

    await submitLogin();

    await waitFor(() => expect(screen.getByText('login.toasts.tooManyAttempts')).toBeTruthy());
    // The backend's message is untranslated English, so it must not reach the form.
    expect(screen.queryByText(/Rate limit exceeded/)).toBeNull();
    expect(reporting.reportError).not.toHaveBeenCalled();
  });

  it('keeps wrong-password as a plain user error, not telemetry', async () => {
    auth.signInWithCredentials.mockResolvedValue({ success: false, status: 401, error: 'Invalid credentials' });

    await submitLogin();

    await waitFor(() => expect(screen.getByText('login.toasts.invalidCredentials')).toBeTruthy());
    expect(reporting.reportError).not.toHaveBeenCalled();
  });

  it('keeps the offline message for a transport failure', async () => {
    auth.signInWithCredentials.mockResolvedValue({ success: false, status: null, error: 'network' });

    await submitLogin();

    await waitFor(() => expect(screen.getByText('nativeStart.networkError')).toBeTruthy());
  });
});
