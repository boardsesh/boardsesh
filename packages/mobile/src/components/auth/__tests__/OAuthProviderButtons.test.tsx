// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

type ApplePressProps = { buttonType: string; buttonStyle: string; cornerRadius: number; onPress: () => void };

const appleButton = vi.hoisted(() => ({ props: null as ApplePressProps | null }));
const theme = vi.hoisted(() => ({ colorScheme: 'light' as 'light' | 'dark' }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: ({
    accessibilityLabel,
    children,
    disabled,
    onPress,
    testID,
  }: {
    accessibilityLabel?: string;
    children: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    testID?: string;
  }) =>
    createElement(
      'button',
      { 'aria-label': accessibilityLabel, 'data-testid': testID, disabled, onClick: onPress },
      children,
    ),
  StyleSheet: { create: <Styles,>(styles: Styles) => styles },
  Text: ({ children }: { children: ReactNode }) => createElement('span', null, children),
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));
vi.mock('expo-apple-authentication', () => ({
  AppleAuthenticationButton: (props: ApplePressProps) => {
    appleButton.props = props;
    return createElement('button', { 'data-testid': 'apple-button', onClick: props.onPress }, 'apple');
  },
  AppleAuthenticationButtonType: { SIGN_IN: 'sign_in', SIGN_UP: 'sign_up', CONTINUE: 'continue' },
  AppleAuthenticationButtonStyle: { WHITE: 'white', BLACK: 'black' },
}));
vi.mock('react-native-svg', () => ({
  default: ({ children }: { children: ReactNode }) => createElement('svg', null, children),
  Path: () => null,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => ({ 'login.providers.google': 'Continue with Google' })[key] ?? key }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ colorScheme: theme.colorScheme, radii: { button: 10 } }),
}));
vi.mock('../../../lib/auth', () => ({ isGoogleSignInConfigured: () => true }));

import { OAuthProviderButtons } from '../OAuthProviderButtons';

const BOTH = { apple: true, google: true, loading: false, error: false, retry: () => undefined };

afterEach(() => {
  cleanup();
  appleButton.props = null;
  theme.colorScheme = 'light';
});

describe('native OAuthProviderButtons', () => {
  it('shows the system "Continue with Apple" button above "Continue with Google"', () => {
    render(<OAuthProviderButtons disabled={false} providers={BOTH} onSignIn={vi.fn()} />);

    const apple = screen.getByTestId('apple-button');
    const google = screen.getByRole('button', { name: 'Continue with Google' });
    expect(appleButton.props?.buttonType).toBe('continue');
    expect(appleButton.props?.buttonStyle).toBe('black');
    expect(appleButton.props?.cornerRadius).toBe(10);
    expect(apple.compareDocumentPosition(google) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('uses the white Apple button in dark mode', () => {
    theme.colorScheme = 'dark';

    render(<OAuthProviderButtons disabled={false} providers={BOTH} onSignIn={vi.fn()} />);

    expect(appleButton.props?.buttonStyle).toBe('white');
  });

  it('starts the matching sign-in from each button', () => {
    const onSignIn = vi.fn();
    render(<OAuthProviderButtons disabled={false} providers={BOTH} onSignIn={onSignIn} />);

    fireEvent.click(screen.getByTestId('apple-button'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));

    expect(onSignIn.mock.calls).toEqual([['apple'], ['google']]);
  });

  it('ignores taps on both buttons while a sign-in is running', () => {
    const onSignIn = vi.fn();
    render(<OAuthProviderButtons disabled providers={BOTH} onSignIn={onSignIn} />);

    const google = screen.getByRole('button', { name: 'Continue with Google' });
    expect((google as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('apple-button'));
    fireEvent.click(google);

    expect(onSignIn).not.toHaveBeenCalled();
  });

  it('shows Google alone where Apple is not offered (Android)', () => {
    render(<OAuthProviderButtons disabled={false} providers={{ ...BOTH, apple: false }} onSignIn={vi.fn()} />);

    expect(screen.queryByTestId('apple-button')).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy();
  });
});
