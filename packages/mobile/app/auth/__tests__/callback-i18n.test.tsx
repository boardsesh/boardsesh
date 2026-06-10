// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Repro for A11-auth-onboarding-004: the OAuth callback screen rendered
// hardcoded English ('Signing in...', 'Sign in failed: ...', 'No transfer
// token received'). With `t` returning the key, a localized render must show
// the catalog key rather than any English literal — so an es/fr user never
// sees raw English at the most failure-prone step of the OAuth round-trip.

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const router = vi.hoisted(() => ({ replace: vi.fn() }));
const params = vi.hoisted(() => ({ transferToken: undefined as string | undefined }));

vi.mock('../../../src/lib/analytics', () => ({ track: analytics.track }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  ActivityIndicator: () => null,
  StyleSheet: { create: (styles: unknown) => styles },
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ transferToken: params.transferToken }),
  useRouter: () => router,
}));

// `t` echoes the key, so any English literal left in the component would show
// up verbatim and fail the assertions below. Stable identity (like the real
// hook's) so the effect depending on it doesn't re-fire on every render.
const stableT = vi.hoisted(() => (key: string) => key);
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: stableT }) }));

const auth = vi.hoisted(() => ({
  exchangeTransferToken: vi.fn(async () => ({ success: false, error: 'Invalid or expired transfer token' })),
}));
vi.mock('../../../src/lib/auth', () => ({
  exchangeTransferToken: auth.exchangeTransferToken,
  getPendingOAuthProvider: () => 'apple',
  clearPendingOAuthProvider: vi.fn(),
}));
vi.mock('../../../src/lib/native-auth-analytics', () => ({ classifyNativeAuthFailureReason: () => 'invalid_token' }));
// Stable across renders like the real provider's useCallback — a fresh fn per
// render would re-fire the effect after setError's re-render and double-track.
const refreshAuthStateMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ refreshAuthState: refreshAuthStateMock }),
}));
vi.mock('../../../src/providers/theme-provider', () => ({ useTheme: () => ({ brandColors: { error: '#FF3B30' } }) }));

import AuthCallback from '../callback';

beforeEach(() => {
  analytics.track.mockClear();
  router.replace.mockClear();
  auth.exchangeTransferToken.mockClear();
  params.transferToken = undefined;
});

describe('AuthCallback localization', () => {
  it('renders the translated spinner label while exchanging the token', () => {
    params.transferToken = 'tok-123';
    const { container } = render(createElement(AuthCallback));
    // Translated key, not the old hardcoded 'Signing in...'.
    expect(container.textContent).toContain('nativeStart.signingIn');
    expect(container.textContent).not.toContain('Signing in');
  });

  it('renders a translated failure message without tracking when no transfer token arrives', async () => {
    params.transferToken = undefined;
    const { container } = render(createElement(AuthCallback));
    await waitFor(() => expect(container.textContent).toContain('callback.noTransferToken'));
    // The old screen prefixed every error with hardcoded 'Sign in failed:'.
    expect(container.textContent).not.toContain('Sign in failed');
    expect(container.textContent).not.toContain('No transfer token received');
    // login.tsx owns no-token tracking — it parses the same callback URL from
    // the browser result. This mount can be expo-router's second delivery of
    // that URL (or a stale deep link), so tracking here would double-count.
    expect(analytics.track).not.toHaveBeenCalled();
  });

  it('renders a translated generic message instead of raw server error text', async () => {
    params.transferToken = 'tok-expired';
    const { container } = render(createElement(AuthCallback));
    await waitFor(() => expect(container.textContent).toContain('callback.failed'));
    // The raw English/server string must never reach the user.
    expect(container.textContent).not.toContain('Invalid or expired transfer token');
    // The exchange failure is attributed to the provider startSignIn recorded.
    expect(analytics.track).toHaveBeenCalledWith(
      'Login Failed',
      expect.objectContaining({ auth_method: 'apple', flow: 'native' }),
    );
  });

  // This screen mounts twice for one login: expo-router routes the callback
  // deep link AND login.tsx routes here with the URL startSignIn resolved. The
  // module-level exchangedTokens set must keep the duplicate mount from
  // replaying the one-time token — the duplicate shows the spinner, never a
  // "token already used" failure.
  it('exchanges a token only once across a double mount', async () => {
    params.transferToken = 'tok-double-mount';
    const firstMount = render(createElement(AuthCallback));
    const secondMount = render(createElement(AuthCallback));
    await waitFor(() => expect(firstMount.container.textContent).toContain('callback.failed'));
    expect(auth.exchangeTransferToken).toHaveBeenCalledTimes(1);
    expect(secondMount.container.textContent).toContain('nativeStart.signingIn');
    expect(secondMount.container.textContent).not.toContain('callback.failed');
  });
});
