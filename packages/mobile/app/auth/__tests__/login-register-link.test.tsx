// @vitest-environment jsdom
//
// The one hop the rest of the W-06 suites can't see: login forwarding `next` to
// the sign-up screen. `AuthProvider` is what navigates after registering (it
// reads the value straight off the location), so without this the two ends of
// the register leg are only ever tested in isolation.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }));
const returnHrefState = vi.hoisted(() => ({ current: null as string | null }));

vi.mock('react-native', () => ({
  Platform: { OS: 'web', Version: undefined },
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  Pressable: ({ onPress, children }: { onPress?: () => void; children?: ReactNode }) =>
    createElement('button', { onClick: onPress }, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));

vi.mock('expo-image', () => ({ Image: () => createElement('img', null) }));
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../../src/providers/auth-provider', () => ({ useAuth: () => ({ signInWithCredentials: vi.fn() }) }));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#000', secondaryLabel: '#666', separator: '#ccc', secondaryBackground: '#eee' },
    brandColors: { primary: '#7c3aed', warning: '#f59e0b' },
  }),
}));
vi.mock('../../../src/hooks/use-native-oauth-sign-in', () => ({
  useNativeOAuthSignIn: () => ({ signIn: vi.fn(), inProgress: false }),
}));
vi.mock('../../../src/components/AuthFieldset', () => ({ AuthFieldset: () => null }));
vi.mock('../../../src/components/Button', () => ({ Button: () => null }));
vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../src/components/auth/OAuthProviderButtons', () => ({
  OAuthProviderButtons: () => null,
  useOAuthProviders: () => ({ loading: false, error: null, apple: false, google: false }),
}));
vi.mock('../../../src/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../src/lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../../src/lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../src/lib/discord', () => ({ openDiscordInvite: vi.fn() }));
vi.mock('../../../src/lib/routing/anonymous-auth-gate', () => ({
  readPostLoginReturnHref: () => returnHrefState.current,
}));

const LoginScreen = (await import('../login')).default;

/** The sign-up link, found by its translation key (the `t` stub is identity). */
function signUpLink(container: HTMLElement): HTMLElement {
  const link = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes('login.submit.signUp'),
  );
  if (!link) throw new Error('sign-up link not rendered');
  return link;
}

beforeEach(() => {
  vi.clearAllMocks();
  returnHrefState.current = null;
});

describe('LoginScreen sign-up link', () => {
  it('forwards a read-only return path to the register screen', () => {
    const next = '/b/the-gym/40/view/crimpy-thing-0A1B2C3D4E5F60718293A4B5C6D7E8F9';
    returnHrefState.current = next;

    const { container } = render(<LoginScreen />);
    fireEvent.click(signUpLink(container));

    expect(router.push).toHaveBeenCalledWith({ pathname: '/auth/register', params: { next } });
  });

  // Native's `readPostLoginReturnHref()` is a constant `null`, so the ternary
  // keeps the call there literally what it has always been.
  it('pushes the bare register route when there is nothing to return to', () => {
    const { container } = render(<LoginScreen />);
    fireEvent.click(signUpLink(container));

    expect(router.push).toHaveBeenCalledWith('/auth/register');
  });
});
