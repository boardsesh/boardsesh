// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARED_EVENTS } from '@boardsesh/analytics';

const analytics = vi.hoisted(() => ({ track: vi.fn(), setPersonProperties: vi.fn() }));
const auth = vi.hoisted(() => ({ register: vi.fn() }));
const router = vi.hoisted(() => ({ replace: vi.fn() }));

// Captures the fields + submit callback AuthFieldset receives, so the test can
// drive the form like a real user (fill email/password/confirmPassword, then
// submit) without mounting the platform-split native field/button trees.
const form = vi.hoisted(() => ({
  setters: {} as Record<string, (text: string) => void>,
  submit: null as (() => void) | null,
}));

vi.mock('../../../src/lib/analytics', () => ({
  track: analytics.track,
  setPersonProperties: analytics.setPersonProperties,
}));
vi.mock('../../../src/providers/auth-provider', () => ({ useAuth: () => ({ register: auth.register }) }));
vi.mock('../../../src/hooks/use-native-oauth-sign-in', () => ({
  useNativeOAuthSignIn: () => ({ signIn: vi.fn(), inProgress: false }),
}));
vi.mock('../../../src/lib/auth', () => ({ isGoogleSignInConfigured: () => false }));
vi.mock('../../../src/lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../../src/lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ colorScheme: 'light', systemColors: {} }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => router,
}));
vi.mock('expo-apple-authentication', () => ({
  AppleAuthenticationButton: () => null,
  AppleAuthenticationButtonType: { SIGN_UP: 'sign_up' },
  AppleAuthenticationButtonStyle: { WHITE: 'white', BLACK: 'black' },
}));
vi.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSigninButton: Object.assign(() => null, {
    Size: { Wide: 'wide' },
    Color: { Dark: 'dark', Light: 'light' },
  }),
}));
vi.mock('react-native', () => ({
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Platform: { OS: 'android' },
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
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
  Button: ({ onPress }: { onPress?: () => void }) => createElement('button', { onClick: onPress }),
}));
vi.mock('../../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

import RegisterScreen from '../register';

beforeEach(() => {
  analytics.track.mockClear();
  analytics.setPersonProperties.mockClear();
  auth.register.mockReset();
  router.replace.mockClear();
  form.setters = {};
  form.submit = null;
});

async function fillAndSubmit() {
  render(createElement(RegisterScreen));
  await act(async () => {
    form.setters.email?.('new@example.com');
    form.setters.password?.('supersecure1');
    form.setters.confirmPassword?.('supersecure1');
  });
  await act(async () => {
    form.submit?.();
  });
}

describe('RegisterScreen analytics', () => {
  it('fires SignupCompleted + first-touch person properties alongside LoginSucceeded on success', async () => {
    auth.register.mockResolvedValue({ success: true });

    await fillAndSubmit();

    await waitFor(() =>
      expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.LoginSucceeded, {
        auth_method: 'credentials',
        flow: 'native',
        is_registration: true,
      }),
    );
    expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.SignupCompleted, {
      auth_method: 'credentials',
      flow: 'native',
    });
    expect(analytics.setPersonProperties).toHaveBeenCalledWith(undefined, {
      signup_at: expect.any(String),
      signup_auth_method: 'credentials',
    });
  });

  it('does not fire SignupCompleted when registration fails', async () => {
    auth.register.mockResolvedValue({ success: false, status: 400, error: 'Email already registered' });

    await fillAndSubmit();

    await waitFor(() => expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.LoginFailed, expect.any(Object)));
    expect(analytics.track).not.toHaveBeenCalledWith(SHARED_EVENTS.SignupCompleted, expect.any(Object));
    expect(analytics.setPersonProperties).not.toHaveBeenCalled();
  });
});
