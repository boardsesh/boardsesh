// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Pressable: ({
    accessibilityLabel,
    children,
    disabled,
    onPress,
  }: {
    accessibilityLabel?: string;
    children: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
  }) => createElement('button', { 'aria-label': accessibilityLabel, disabled, onClick: onPress }, children),
  StyleSheet: { create: <Styles,>(styles: Styles) => styles },
  Text: ({ children }: { children: ReactNode }) => createElement('span', null, children),
  View: ({ accessibilityLabel, children }: { accessibilityLabel?: string; children: ReactNode }) =>
    createElement('div', { 'aria-label': accessibilityLabel }, children),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'login.providers.google': 'Continue with Google',
        'login.providers.apple': 'Continue with Apple',
        'nativeStart.orContinueWith': 'or continue with',
        'nativeStart.providerDiscoveryError': "We couldn't load the social sign-in options.",
        'nativeStart.retryProviders': 'Try again',
      })[key] ?? key,
  }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    colorScheme: 'light',
    systemColors: { accent: '#0066cc', fill: '#cccccc', secondaryLabel: '#666666' },
  }),
}));

vi.mock('react-native-svg', () => ({
  default: ({ children }: { children: ReactNode }) => createElement('svg', null, children),
  Path: (props: Record<string, unknown>) => createElement('path', props),
}));

import { OAuthProviderButtons, useOAuthProviders } from '../OAuthProviderButtons.web';

function ProviderHarness({ onSignIn = vi.fn() }: { onSignIn?: (provider: 'apple' | 'google') => void }) {
  const providers = useOAuthProviders();
  return <OAuthProviderButtons disabled={false} isRegistration={false} providers={providers} onSignIn={onSignIn} />;
}

describe('OAuthProviderButtons on web', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reserves button space while provider discovery is loading', () => {
    vi.mocked(fetch).mockReturnValue(new Promise(() => {}));

    const { container } = render(<ProviderHarness />);

    expect(container.querySelectorAll('[aria-label="or continue with"]')).toHaveLength(1);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('fetches configured providers with credentials and renders only Apple and Google', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ google: true, apple: false, facebook: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    render(<ProviderHarness />);
    await act(async () => {});

    expect(fetch).toHaveBeenCalledWith(
      'https://www.boardsesh.com/api/auth/providers-config',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    );
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue with Apple' })).toBeNull();
    expect(screen.queryByText('Continue with Facebook')).toBeNull();
  });

  it('renders Apple when it is the only configured provider', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ google: false, apple: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    render(<ProviderHarness />);
    await act(async () => {});

    expect(screen.getByRole('button', { name: 'Continue with Apple' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull();
  });

  it('starts the selected provider', async () => {
    const onSignIn = vi.fn();
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ google: true, apple: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { unmount } = render(<ProviderHarness onSignIn={onSignIn} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Apple' }));
    expect(onSignIn).toHaveBeenCalledWith('apple');
    unmount();
  });

  it('offers a retry when discovery fails', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    render(<ProviderHarness />);
    await act(async () => {});
    const retryButton = screen.getByRole('button', { name: 'Try again' });
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ google: true, apple: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    fireEvent.click(retryButton);
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy();
  });

  it('offers a retry when provider discovery times out', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    render(<ProviderHarness />);
    await act(() => vi.advanceTimersByTimeAsync(8_000));

    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('disables provider controls while a sign-in is in progress', () => {
    const onSignIn = vi.fn();
    render(
      <OAuthProviderButtons
        disabled
        isRegistration
        providers={{ apple: true, google: true, loading: false, error: false, retry: vi.fn() }}
        onSignIn={onSignIn}
      />,
    );

    const googleButton = screen.getByRole('button', { name: 'Continue with Google' });
    const appleButton = screen.getByRole('button', { name: 'Continue with Apple' });
    expect((googleButton as HTMLButtonElement).disabled).toBe(true);
    expect((appleButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(googleButton);
    expect(onSignIn).not.toHaveBeenCalled();
  });
});
