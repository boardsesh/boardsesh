// @vitest-environment jsdom
//
// #5654: Apple and Google first, email kept open below an "or use email"
// divider, a tagline that says what the climber gets, and one `Auth Option
// Tapped` event per way in.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARED_EVENTS } from '@boardsesh/analytics';

const auth = vi.hoisted(() => ({ signInWithCredentials: vi.fn() }));
const analytics = vi.hoisted(() => ({ track: vi.fn(), trackLoginSucceeded: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const oauth = vi.hoisted(() => ({
  signIn: vi.fn(),
  setError: null as ((message: string | null) => void) | null,
}));
const providers = vi.hoisted(() => ({ apple: true, google: true }));
const form = vi.hoisted(() => ({
  setters: {} as Record<string, (text: string) => void>,
  submit: null as (() => void) | null,
}));

vi.mock('../../../src/lib/analytics', () => ({ track: analytics.track, setPersonProperties: vi.fn() }));
vi.mock('../../../src/lib/login-analytics', () => ({
  useTrackLoginSucceeded: () => analytics.trackLoginSucceeded,
}));
vi.mock('../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ signInWithCredentials: auth.signInWithCredentials }),
}));
vi.mock('../../../src/lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../../src/hooks/use-native-oauth-sign-in', () => ({
  useNativeOAuthSignIn: ({ setError }: { setError: (message: string | null) => void }) => {
    oauth.setError = setError;
    return { signIn: oauth.signIn, inProgress: false };
  },
}));
vi.mock('../../../src/components/auth/OAuthProviderButtons', () => ({
  OAuthProviderButtons: ({ onSignIn }: { onSignIn: (provider: 'apple' | 'google') => void }) =>
    createElement(
      'div',
      { 'data-testid': 'oauth-buttons' },
      providers.apple ? createElement('button', { onClick: () => onSignIn('apple') }, 'apple-button') : null,
      providers.google ? createElement('button', { onClick: () => onSignIn('google') }, 'google-button') : null,
    ),
  useOAuthProviders: () => ({ loading: false, error: false, apple: providers.apple, google: providers.google }),
}));
vi.mock('../../../src/lib/routing/anonymous-auth-gate', () => ({ readPostLoginReturnHref: () => null }));
vi.mock('../../../src/lib/discord', () => ({ openDiscordInvite: vi.fn() }));
vi.mock('../../../src/lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ colorScheme: 'light', systemColors: {}, brandColors: {} }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useRouter: () => router }));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('react-native', () => ({
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Platform: { OS: 'ios' },
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
    return createElement('div', { 'data-testid': 'email-form' });
  },
}));
vi.mock('../../../src/components/Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));

import LoginScreen from '../login';

function isBefore(first: Element, second: Element): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

function authOptionTaps(): unknown[] {
  return analytics.track.mock.calls
    .filter(([eventName]) => eventName === SHARED_EVENTS.AuthOptionTapped)
    .map(([, properties]) => properties);
}

beforeEach(() => {
  vi.clearAllMocks();
  providers.apple = true;
  providers.google = true;
  oauth.setError = null;
  form.setters = {};
  form.submit = null;
});

describe('LoginScreen layout', () => {
  it('says what the climber gets, then Apple and Google, then email below "or use email"', () => {
    render(createElement(LoginScreen));

    const headline = screen.getByText('nativeStart.tagline');
    const detail = screen.getByText('nativeStart.taglineDetail');
    const oauthButtons = screen.getByTestId('oauth-buttons');
    const divider = screen.getByText('nativeStart.orUseEmail');
    const emailForm = screen.getByTestId('email-form');

    expect(isBefore(headline, detail)).toBe(true);
    expect(isBefore(detail, oauthButtons)).toBe(true);
    expect(isBefore(oauthButtons, divider)).toBe(true);
    expect(isBefore(divider, emailForm)).toBe(true);
    expect(screen.queryByText('nativeStart.orContinueWith')).toBeNull();
  });

  it('goes straight to the email form, with no dangling divider, when no provider is available', () => {
    providers.apple = false;
    providers.google = false;

    render(createElement(LoginScreen));

    expect(screen.queryByTestId('oauth-buttons')).toBeNull();
    expect(screen.queryByText('nativeStart.orUseEmail')).toBeNull();
    expect(screen.getByTestId('email-form')).toBeTruthy();
  });

  it('shows an Apple or Google failure under those buttons, above the email form', async () => {
    render(createElement(LoginScreen));

    await act(async () => {
      oauth.setError?.('nativeStart.oauthError');
    });

    const oauthError = screen.getByText('nativeStart.oauthError');
    expect(isBefore(screen.getByTestId('oauth-buttons'), oauthError)).toBe(true);
    expect(isBefore(oauthError, screen.getByTestId('email-form'))).toBe(true);
  });
});

describe('LoginScreen Auth Option Tapped', () => {
  it('reports Apple and Google taps before starting their sign-in', () => {
    render(createElement(LoginScreen));

    fireEvent.click(screen.getByText('apple-button'));
    fireEvent.click(screen.getByText('google-button'));

    expect(authOptionTaps()).toEqual([
      { option: 'apple', screen: 'login' },
      { option: 'google', screen: 'login' },
    ]);
    expect(oauth.signIn).toHaveBeenNthCalledWith(1, 'apple');
    expect(oauth.signIn).toHaveBeenNthCalledWith(2, 'google');
  });

  it('reports Create Account and Forgot password taps', () => {
    render(createElement(LoginScreen));

    fireEvent.click(screen.getByText('login.submit.signUp'));
    fireEvent.click(screen.getByText('login.links.forgotPassword'));

    expect(authOptionTaps()).toEqual([
      { option: 'create_account', screen: 'login' },
      { option: 'forgot_password', screen: 'login' },
    ]);
    expect(router.push).toHaveBeenCalledWith('/auth/register');
    expect(router.push).toHaveBeenCalledWith('/auth/forgot-password');
  });

  it('reports an email sign-in and hands Login Succeeded to the account-age tracker', async () => {
    auth.signInWithCredentials.mockResolvedValue({ success: true });
    render(createElement(LoginScreen));

    await act(async () => {
      form.setters.email?.('climber@example.com');
      form.setters.password?.('supersecure1');
    });
    await act(async () => {
      form.submit?.();
    });

    expect(authOptionTaps()).toEqual([{ option: 'email_sign_in', screen: 'login' }]);
    expect(analytics.trackLoginSucceeded).toHaveBeenCalledWith({ auth_method: 'credentials', flow: 'native' });
    expect(analytics.track).not.toHaveBeenCalledWith(SHARED_EVENTS.LoginSucceeded, expect.anything());
  });

  it('does not report an email sign-in while the form is still empty', async () => {
    render(createElement(LoginScreen));

    await act(async () => {
      form.submit?.();
    });

    expect(authOptionTaps()).toEqual([]);
    expect(auth.signInWithCredentials).not.toHaveBeenCalled();
  });
});
