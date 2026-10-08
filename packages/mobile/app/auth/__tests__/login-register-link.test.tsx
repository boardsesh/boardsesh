// @vitest-environment jsdom
vi.mock('../../../src/components/AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 0 }));
vi.mock('../../../src/hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../../src/components/PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
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
  View: ({
    children,
    accessibilityRole,
    style,
  }: {
    children?: ReactNode;
    accessibilityRole?: string;
    style?: unknown;
  }) =>
    createElement(
      'div',
      { role: accessibilityRole, 'data-flex-wrap': (style as { flexWrap?: string } | undefined)?.flexWrap },
      children,
    ),
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  Pressable: ({ onPress, children }: { onPress?: () => void; children?: ReactNode }) =>
    createElement('button', { onClick: onPress }, children),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: unknown) => styles,
  },
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
vi.mock('../../../src/lib/login-analytics', () => ({ useTrackLoginSucceeded: () => vi.fn() }));
vi.mock('../../../src/lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../src/lib/discord', () => ({ openDiscordInvite: vi.fn() }));
vi.mock('../../../src/lib/routing/anonymous-auth-gate', () => ({
  readPostLoginReturnHref: () => returnHrefState.current,
}));

const LoginScreen = (await import('../login')).default;
const RegisterScreen = (await import('../register')).default;

/** The row holding a footer link (the link's Pressable sits directly in it). */
function footerRowOf(link: HTMLElement): HTMLElement {
  const row = link.parentElement;
  if (!row) throw new Error('footer link has no row');
  return row;
}

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

// HIG Localization: "Noch kein Konto? Registrieren" is wider than a phone, so
// the prompt and its link sit in a row that wraps instead of running off-screen.
describe('auth footers wrap long translations', () => {
  it('wraps the login sign-up and Discord rows', () => {
    const { container } = render(<LoginScreen />);

    expect(footerRowOf(linkByKey(container, 'login.submit.signUp')).getAttribute('data-flex-wrap')).toBe('wrap');
    expect(footerRowOf(linkByKey(container, 'login.links.discord')).getAttribute('data-flex-wrap')).toBe('wrap');
  });

  it('wraps the register sign-in row', () => {
    const { container } = render(<RegisterScreen />);

    expect(footerRowOf(linkByKey(container, 'login.submit.signIn')).getAttribute('data-flex-wrap')).toBe('wrap');
  });
});
