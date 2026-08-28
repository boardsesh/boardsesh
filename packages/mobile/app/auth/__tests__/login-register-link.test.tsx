// @vitest-environment jsdom
//
// The two hops the rest of the W-06 suites can't see: login forwarding `next` to
// the sign-up screen, and register handing it back. `AuthProvider` is what
// navigates after signing in (it reads the value straight off the location), so
// without this the ends of the register detour are only ever tested in
// isolation — and a visitor who taps Sign up, changes their mind and taps Sign
// in would drop the climb between two screens that each look correct alone.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }));
const returnHrefState = vi.hoisted(() => ({ current: null as string | null }));
const platformState = vi.hoisted(() => ({ os: 'web', version: undefined as number | undefined }));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platformState.os;
    },
    get Version() {
      return platformState.version;
    },
  },
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  View: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) =>
    createElement('div', { role: accessibilityRole }, children),
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  Pressable: ({ onPress, children }: { onPress?: () => void; children?: ReactNode }) =>
    createElement('button', { onClick: onPress }, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));

vi.mock('expo-image', () => ({ Image: () => createElement('img', null) }));
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useRouter: () => router }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ signInWithCredentials: vi.fn(), register: vi.fn() }),
}));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#000', secondaryLabel: '#666', separator: '#ccc', secondaryBackground: '#eee' },
    brandColors: { primary: '#7c3aed', warning: '#f59e0b' },
  }),
  // `Text` reads this one, and `undefined` is its documented no-provider path.
  useOptionalTheme: () => undefined,
}));
vi.mock('../../../src/hooks/use-native-oauth-sign-in', () => ({
  useNativeOAuthSignIn: () => ({ signIn: vi.fn(), inProgress: false }),
}));
vi.mock('../../../src/components/AuthFieldset', () => ({ AuthFieldset: () => null }));
vi.mock('../../../src/components/Button', () => ({ Button: () => null }));
vi.mock('../../../src/components/auth/OAuthProviderButtons', () => ({
  OAuthProviderButtons: () => null,
  useOAuthProviders: () => ({ loading: false, error: null, apple: false, google: false }),
}));
vi.mock('../../../src/lib/analytics', () => ({ track: vi.fn(), setPersonProperties: vi.fn() }));
vi.mock('../../../src/lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../../src/lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../src/lib/discord', () => ({ openDiscordInvite: vi.fn() }));
vi.mock('../../../src/lib/routing/anonymous-auth-gate', () => ({
  readPostLoginReturnHref: () => returnHrefState.current,
}));

const LoginScreen = (await import('../login')).default;
const RegisterScreen = (await import('../register')).default;

/** A footer link, found by its translation key (the `t` stub is identity). */
function linkByKey(container: HTMLElement, key: string): HTMLElement {
  const link = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(key));
  if (!link) throw new Error(`${key} link not rendered`);
  return link;
}

beforeEach(() => {
  vi.clearAllMocks();
  returnHrefState.current = null;
  platformState.os = 'web';
  platformState.version = undefined;
});

const RETURN_PATH = '/b/the-gym/40/view/crimpy-thing-0A1B2C3D4E5F60718293A4B5C6D7E8F9';

describe('LoginScreen', () => {
  it('does not show the retired split-screen warning on Android 15+', () => {
    platformState.os = 'android';
    platformState.version = 35;

    const { container } = render(<LoginScreen />);

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('login.splitScreenNotice');
  });

  it('forwards a read-only return path to the register screen', () => {
    returnHrefState.current = RETURN_PATH;

    const { container } = render(<LoginScreen />);
    fireEvent.click(linkByKey(container, 'login.submit.signUp'));

    expect(router.push).toHaveBeenCalledWith({ pathname: '/auth/register', params: { next: RETURN_PATH } });
  });

  // Native's `readPostLoginReturnHref()` is a constant `null`, so the ternary
  // keeps the call there literally what it has always been.
  it('pushes the bare register route when there is nothing to return to', () => {
    const { container } = render(<LoginScreen />);
    fireEvent.click(linkByKey(container, 'login.submit.signUp'));

    expect(router.push).toHaveBeenCalledWith('/auth/register');
  });
});

// The way back. Without it the detour is one-directional: Sign up → "actually,
// I have an account" → bare login, and the climb is gone in three taps.
describe('RegisterScreen sign-in link', () => {
  it('hands the return path back to login', () => {
    returnHrefState.current = RETURN_PATH;

    const { container } = render(<RegisterScreen />);
    fireEvent.click(linkByKey(container, 'login.submit.signIn'));

    expect(router.replace).toHaveBeenCalledWith({ pathname: '/auth/login', params: { next: RETURN_PATH } });
  });

  it('replaces with the bare login route when there is nothing to return to', () => {
    const { container } = render(<RegisterScreen />);
    fireEvent.click(linkByKey(container, 'login.submit.signIn'));

    expect(router.replace).toHaveBeenCalledWith('/auth/login');
  });
});
