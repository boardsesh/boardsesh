// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARED_EVENTS } from '@boardsesh/analytics';

const analytics = vi.hoisted(() => ({ track: vi.fn(), setPersonProperties: vi.fn() }));
const auth = vi.hoisted(() => ({ register: vi.fn() }));
const router = vi.hoisted(() => ({ replace: vi.fn() }));
const oauth = vi.hoisted(() => ({ signIn: vi.fn(async () => ({ success: true }) as unknown) }));
const platform = vi.hoisted(() => ({ os: 'android' as 'android' | 'web' }));
const fetchMock = vi.hoisted(() => vi.fn());

vi.stubGlobal('fetch', fetchMock);

// Captures the fields + submit callback AuthFieldset receives, so the test can
// drive the form like a real user (fill email/password, then submit) without
// mounting the platform-split native field/button trees.
const form = vi.hoisted(() => ({
  fieldKeys: [] as string[],
  setters: {} as Record<string, (text: string) => void>,
  submit: null as (() => void) | null,
}));

vi.mock('../../../src/lib/analytics', () => ({
  track: analytics.track,
  setPersonProperties: analytics.setPersonProperties,
}));
// The real hook waits for the profile before tracking (login-analytics.test.tsx
// covers that). Tracking straight away keeps these assertions on one stream.
vi.mock('../../../src/lib/login-analytics', () => ({
  useTrackLoginSucceeded: () => (properties: Record<string, unknown>) => analytics.track('Login Succeeded', properties),
}));
vi.mock('../../../src/providers/auth-provider', () => ({ useAuth: () => ({ register: auth.register }) }));
vi.mock('../../../src/hooks/use-native-oauth-sign-in', () => ({
  useNativeOAuthSignIn: () => ({ signIn: oauth.signIn, inProgress: false }),
}));
// true (not the earlier false) so the Google button renders — needed to drive
// the OAuth-path negative test below via a real press, not just a stubbed hook.
vi.mock('../../../src/lib/auth', () => ({ isGoogleSignInConfigured: () => true }));
vi.mock('../../../src/lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../../src/lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ colorScheme: 'light', systemColors: {}, radii: { button: 10 } }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => router,
}));
vi.mock('expo-apple-authentication', () => ({
  AppleAuthenticationButton: () => null,
  AppleAuthenticationButtonType: { CONTINUE: 'continue' },
  AppleAuthenticationButtonStyle: { WHITE: 'white', BLACK: 'black' },
}));
vi.mock('react-native-svg', () => ({
  default: ({ children }: { children?: ReactNode }) => createElement('svg', null, children),
  Path: () => null,
}));
vi.mock('react-native', () => ({
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Platform: {
    get OS() {
      return platform.os;
    },
  },
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
    form.fieldKeys = fields.map((field) => field.key);
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
vi.mock('../../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

import RegisterScreen from '../register';

beforeEach(() => {
  analytics.track.mockClear();
  analytics.setPersonProperties.mockClear();
  auth.register.mockReset();
  router.replace.mockClear();
  oauth.signIn.mockClear();
  fetchMock.mockReset();
  platform.os = 'android';
  form.fieldKeys = [];
  form.setters = {};
  form.submit = null;
});

async function fillAndSubmit() {
  render(createElement(RegisterScreen));
  await act(async () => {
    form.setters.email?.('new@example.com');
    form.setters.password?.('supersecure1');
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
        screen: 'register',
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

  it('treats verification-required web registration as a completed but anonymous web signup', async () => {
    platform.os = 'web';
    auth.register.mockResolvedValue({
      success: true,
      authenticated: false,
      requiresVerification: true,
      emailSent: true,
    });

    await fillAndSubmit();

    await waitFor(() =>
      expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.SignupCompleted, {
        auth_method: 'credentials',
        flow: 'web',
        requires_verification: true,
      }),
    );
    expect(analytics.track).not.toHaveBeenCalledWith(SHARED_EVENTS.LoginSucceeded, expect.any(Object));
    expect(analytics.track).not.toHaveBeenCalledWith(SHARED_EVENTS.LoginFailed, expect.any(Object));
    expect(analytics.setPersonProperties).toHaveBeenCalledWith(undefined, {
      signup_at: expect.any(String),
      signup_auth_method: 'credentials',
    });
    expect(screen.getByText('login.toasts.checkEmail')).toBeTruthy();
  });

  it('offers a cross-origin resend (via www) before claiming a failed verification email was delivered', async () => {
    platform.os = 'web';
    auth.register.mockResolvedValue({
      success: true,
      authenticated: false,
      requiresVerification: true,
      emailSent: false,
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: 'accepted' }), { status: 200 }));

    await fillAndSubmit();

    await waitFor(() => expect(screen.getByText('login.signUp.verificationEmailNotSent')).toBeTruthy());
    expect(screen.queryByText('login.toasts.checkEmail')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'verifyRequest.resend' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Routed through webApiUrl() with included credentials so the standalone
    // app.boardsesh.com export reaches www (a relative URL would 404 on the
    // static origin); in this jsdom realm the origins differ, so the absolute
    // form is used.
    expect(url).toBe('https://www.boardsesh.com/api/auth/resend-verification');
    expect(options.credentials).toBe('include');
    expect(options.method).toBe('POST');
    if (typeof options.body !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(options.body)).toEqual({ email: 'new@example.com' });
    await waitFor(() => expect(screen.getByText('login.toasts.checkEmail')).toBeTruthy());
    expect(screen.queryByText('login.signUp.verificationEmailNotSent')).toBeNull();
  });

  it('keeps the resend action available when verification delivery fails again', async () => {
    platform.os = 'web';
    auth.register.mockResolvedValue({
      success: true,
      authenticated: false,
      requiresVerification: true,
      emailSent: false,
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }));

    await fillAndSubmit();
    fireEvent.click(await screen.findByRole('button', { name: 'verifyRequest.resend' }));

    await waitFor(() => expect(screen.getByText('verifyRequest.toasts.failed')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'verifyRequest.resend' })).toBeTruthy();
    expect(screen.queryByText('login.toasts.checkEmail')).toBeNull();
  });

  it('reports a native anonymous registration with the native analytics flow', async () => {
    platform.os = 'android';
    auth.register.mockResolvedValue({
      success: true,
      authenticated: false,
      requiresVerification: false,
      autoLoginUnavailable: true,
    });

    await fillAndSubmit();

    await waitFor(() =>
      expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.SignupCompleted, {
        auth_method: 'credentials',
        flow: 'native',
        requires_verification: false,
      }),
    );
    expect(analytics.track).not.toHaveBeenCalledWith(SHARED_EVENTS.LoginSucceeded, expect.any(Object));
    expect(analytics.track).not.toHaveBeenCalledWith(SHARED_EVENTS.LoginFailed, expect.any(Object));
    expect(screen.getByText('login.toasts.loginAfterCreate')).toBeTruthy();
  });

  it('does not fire SignupCompleted through the OAuth sign-in path', async () => {
    // register.tsx has exactly one SignupCompleted call site: the credentials
    // onSubmit() success branch. OAuth registration goes through
    // useNativeOAuthSignIn (already tagged is_registration: true on
    // LoginSucceeded there, tested separately in
    // use-native-oauth-sign-in.test.tsx) and must not also fire SignupCompleted
    // — matching web, which has no OAuth-signup-distinct event either.
    render(createElement(RegisterScreen));

    await act(async () => {
      fireEvent.click(screen.getByText('login.providers.google'));
    });

    expect(oauth.signIn).toHaveBeenCalledWith('google');
    expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.AuthOptionTapped, {
      option: 'google',
      screen: 'register',
    });
    expect(analytics.track).not.toHaveBeenCalledWith(SHARED_EVENTS.SignupCompleted, expect.any(Object));
    expect(analytics.setPersonProperties).not.toHaveBeenCalled();
  });
});

describe('RegisterScreen fields', () => {
  it('asks for email, one password and an optional name, with no Confirm Password', () => {
    render(createElement(RegisterScreen));

    expect(form.fieldKeys).toEqual(['email', 'password', 'name']);
  });

  it('creates the account from email and a single password', async () => {
    auth.register.mockResolvedValue({ success: true });

    await fillAndSubmit();

    await waitFor(() => expect(auth.register).toHaveBeenCalledWith('new@example.com', 'supersecure1', undefined));
  });
});
