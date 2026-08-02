// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock the auth provider so the hook gets controllable sign-in functions without
// pulling in the provider's native dependency chain. The `type OAuthSignInResult`
// the hook imports from ../lib/auth is erased at compile time, so no native module
// is loaded here.
const signInWithAppleMock = vi.fn();
const signInWithGoogleMock = vi.fn();
const signInWithGoogleWebMock = vi.fn();
const signInWithAppleWebMock = vi.fn();
vi.mock('../../providers/auth-provider', () => ({
  useAuth: () => ({
    signInWithApple: signInWithAppleMock,
    signInWithGoogle: signInWithGoogleMock,
    signInWithGoogleWeb: signInWithGoogleWebMock,
    signInWithAppleWeb: signInWithAppleWebMock,
  }),
}));

const trackMock = vi.fn();
vi.mock('../../lib/analytics', () => ({ track: (...args: unknown[]) => trackMock(...args) }));

const reportErrorMock = vi.fn();
vi.mock('../../lib/error-reporting', () => ({ reportError: (...args: unknown[]) => reportErrorMock(...args) }));

const setOAuthPendingMock = vi.fn();
const consumeFreshOAuthPendingMock = vi.fn();
vi.mock('../../lib/oauth-pending-store', () => ({
  setOAuthPending: (...args: unknown[]) => setOAuthPendingMock(...args),
  consumeFreshOAuthPending: (...args: unknown[]) => consumeFreshOAuthPendingMock(...args),
}));
const consumeWebOAuthReturnMock = vi.fn();
vi.mock('../../lib/oauth-return', () => ({
  consumeWebOAuthErrorReturn: (...args: unknown[]) => consumeWebOAuthReturnMock(...args),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// The hook reads Platform.OS to gate the browser web fallback (Google + Apple)
// to iOS. A mutable hoisted ref lets each test flip the platform (default iOS,
// where the fallback lives); the real react-native module is too heavy to load
// under jsdom.
const { platform } = vi.hoisted(() => ({ platform: { OS: 'ios' } as { OS: string } }));
vi.mock('react-native', () => ({ Platform: platform }));

const { useNativeOAuthSignIn } = await import('../use-native-oauth-sign-in');

type TrackedEvent = {
  event: unknown;
  flow: unknown;
  reason: unknown;
  recoverable: unknown;
  mechanism: unknown;
};
function trackedEvents(): TrackedEvent[] {
  return trackMock.mock.calls.map(([event, props]) => ({
    event,
    flow: (props as { flow?: unknown })?.flow,
    reason: (props as { failure_reason?: unknown })?.failure_reason,
    recoverable: (props as { recoverable?: unknown })?.recoverable,
    mechanism: (props as { fallback_mechanism?: unknown })?.fallback_mechanism,
  }));
}

async function runSignIn(provider: 'google' | 'apple', setError = vi.fn(), isRegistration = false) {
  const { result } = renderHook(() => useNativeOAuthSignIn({ isRegistration, setError }));
  await act(async () => {
    await result.current.signIn(provider);
  });
  return setError;
}

describe('useNativeOAuthSignIn — Google web fallback (iOS)', () => {
  beforeEach(() => {
    platform.OS = 'ios';
    trackMock.mockReset();
    reportErrorMock.mockReset();
    signInWithAppleMock.mockReset();
    signInWithGoogleMock.mockReset();
    signInWithGoogleWebMock.mockReset();
    signInWithAppleWebMock.mockReset();
    setOAuthPendingMock.mockReset();
    setOAuthPendingMock.mockResolvedValue(undefined);
    consumeWebOAuthReturnMock.mockReset();
    consumeWebOAuthReturnMock.mockReturnValue(null);
    consumeFreshOAuthPendingMock.mockReset();
  });

  it('falls back to the web flow when native Google throws ("Unable to open Safari") and signs in', async () => {
    signInWithGoogleMock.mockRejectedValue(Object.assign(new Error('Unable to open Safari'), { code: -1 }));
    signInWithGoogleWebMock.mockResolvedValue({ success: true });

    const setError = await runSignIn('google');

    expect(signInWithGoogleWebMock).toHaveBeenCalledTimes(1);
    // The handled native failure no longer reaches error tracking — the fallback owns it.
    expect(reportErrorMock).not.toHaveBeenCalled();
    expect(setError).toHaveBeenLastCalledWith(null);
    const events = trackedEvents();
    expect(events).toContainEqual({
      event: 'Login Attempted',
      flow: 'web_fallback',
      reason: undefined,
      recoverable: undefined,
      mechanism: 'browser_deeplink',
    });
    expect(events).toContainEqual({
      event: 'Login Succeeded',
      flow: 'web_fallback',
      reason: undefined,
      recoverable: undefined,
      mechanism: 'browser_deeplink',
    });
    // The native throw is logged recoverable on iOS so the failure metric excludes it.
    expect(events).toContainEqual({ event: 'Login Failed', flow: 'native', reason: 'exception', recoverable: true });
  });

  it('falls back when native Google returns a non-cancel failure', async () => {
    signInWithGoogleMock.mockResolvedValue({ success: false, status: 401, error: 'invalid' });
    signInWithGoogleWebMock.mockResolvedValue({ success: true });

    await runSignIn('google');

    expect(signInWithGoogleWebMock).toHaveBeenCalledTimes(1);
    // The native backend failure is recoverable on iOS (the fallback runs next).
    expect(trackedEvents()).toContainEqual({
      event: 'Login Failed',
      flow: 'native',
      reason: 'invalid_oauth_token',
      recoverable: true,
    });
  });

  it('preserves registration attribution when the native flow falls back to the browser', async () => {
    signInWithGoogleMock.mockRejectedValue(Object.assign(new Error('Unable to open Safari'), { code: -1 }));
    signInWithGoogleWebMock.mockResolvedValue({ success: true });

    await runSignIn('google', vi.fn(), true);

    expect(signInWithGoogleWebMock).toHaveBeenCalledWith(true);
  });

  it('does NOT fall back when the user cancels native Google, and logs a cancel (not a failure)', async () => {
    signInWithGoogleMock.mockResolvedValue({ success: false, cancelled: true });

    await runSignIn('google');

    expect(signInWithGoogleWebMock).not.toHaveBeenCalled();
    expect(reportErrorMock).not.toHaveBeenCalled();
    const events = trackedEvents();
    expect(events).toContainEqual({
      event: 'Login Cancelled',
      flow: 'native',
      reason: undefined,
      recoverable: undefined,
    });
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'Login Failed' }));
  });

  it('surfaces an error and reports once when the web fallback also fails', async () => {
    signInWithGoogleMock.mockRejectedValue(new Error('Unable to open Safari'));
    signInWithGoogleWebMock.mockResolvedValue({
      success: false,
      status: 401,
      error: 'Invalid or expired transfer token',
    });

    const setError = await runSignIn('google');

    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(setError).toHaveBeenLastCalledWith('nativeStart.oauthError');
    expect(trackedEvents()).toContainEqual({
      event: 'Login Failed',
      flow: 'web_fallback',
      reason: 'invalid_oauth_token',
      mechanism: 'browser_deeplink',
    });
  });

  it('treats browser_unavailable as a Login Failed (not a cancel) and reports it', async () => {
    // The iOS 26 dead-end: the fallback's in-app browser fails to present, so
    // signInWithProviderWeb returns { error: 'browser_unavailable' }. Unlike a
    // user closing the browser (a silent cancel), this is a real failure — it must
    // surface an error, report to tracking, and stay out of the Cancelled bucket.
    signInWithGoogleMock.mockRejectedValue(new Error('Unable to open Safari'));
    signInWithGoogleWebMock.mockResolvedValue({ success: false, status: null, error: 'browser_unavailable' });

    const setError = await runSignIn('google');

    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(setError).toHaveBeenLastCalledWith('nativeStart.oauthError');
    const events = trackedEvents();
    expect(events).toContainEqual({
      event: 'Login Failed',
      flow: 'web_fallback',
      reason: 'browser_unavailable',
      recoverable: undefined,
      mechanism: 'browser_deeplink',
    });
    // A browser that never opened is a failure, not the user backing out.
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'Login Cancelled', flow: 'web_fallback' }));
  });
});

describe('useNativeOAuthSignIn — Expo web redirect', () => {
  beforeEach(() => {
    platform.OS = 'web';
    trackMock.mockReset();
    reportErrorMock.mockReset();
    signInWithAppleMock.mockReset();
    signInWithGoogleMock.mockReset();
    signInWithGoogleWebMock.mockReset();
    signInWithAppleWebMock.mockReset();
    setOAuthPendingMock.mockReset();
    setOAuthPendingMock.mockResolvedValue(undefined);
  });

  it('persists the attempt and treats a full-page Google redirect as neither success nor failure', async () => {
    signInWithGoogleMock.mockResolvedValue({ success: false, redirecting: true });

    await runSignIn('google');

    expect(setOAuthPendingMock).toHaveBeenCalledWith({
      attemptId: expect.any(String),
      provider: 'google',
      attemptedAt: expect.any(Number),
      isRegistration: false,
    });
    expect(signInWithGoogleMock).toHaveBeenCalledWith(expect.any(String), false);
    expect(signInWithGoogleWebMock).not.toHaveBeenCalled();
    expect(trackMock).toHaveBeenCalledWith('Login Attempted', {
      auth_method: 'google',
      flow: 'web',
    });
    expect(trackMock).not.toHaveBeenCalledWith('Login Succeeded', expect.anything());
    expect(trackMock).not.toHaveBeenCalledWith('Login Failed', expect.anything());
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('continues to OAuth when the analytics marker cannot be persisted', async () => {
    setOAuthPendingMock.mockRejectedValue(new Error('IndexedDB unavailable'));
    signInWithAppleMock.mockResolvedValue({ success: false, redirecting: true });

    await runSignIn('apple');

    expect(signInWithAppleMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('surfaces a provider error only for its matching browser attempt', async () => {
    consumeWebOAuthReturnMock.mockReturnValue({
      provider: 'apple',
      attemptId: 'attempt-apple-1',
      error: 'AccessDenied',
    });
    consumeFreshOAuthPendingMock.mockResolvedValue({
      attemptId: 'attempt-apple-1',
      provider: 'apple',
      attemptedAt: Date.now(),
      isRegistration: false,
    });
    const setError = vi.fn();

    renderHook(() => useNativeOAuthSignIn({ setError }));

    await waitFor(() => expect(setError).toHaveBeenCalledWith('nativeStart.oauthError'));
    expect(consumeFreshOAuthPendingMock).toHaveBeenCalledWith('attempt-apple-1');
    expect(trackMock).toHaveBeenCalledWith('Login Failed', {
      auth_method: 'apple',
      flow: 'web',
      failure_reason: 'oauth',
      failure_detail: 'AccessDenied',
    });
  });
});

describe('useNativeOAuthSignIn — Apple web fallback (iOS)', () => {
  beforeEach(() => {
    platform.OS = 'ios';
    trackMock.mockReset();
    reportErrorMock.mockReset();
    signInWithAppleMock.mockReset();
    signInWithGoogleMock.mockReset();
    signInWithGoogleWebMock.mockReset();
    signInWithAppleWebMock.mockReset();
  });

  it('falls back to the web flow when native Apple throws (ASAuthorizationError.unknown) and signs in', async () => {
    // code 1000 is ASAuthorizationError.unknown — the dead-end this fixes.
    signInWithAppleMock.mockRejectedValue(Object.assign(new Error('unknown'), { code: 1000 }));
    signInWithAppleWebMock.mockResolvedValue({ success: true });

    const setError = await runSignIn('apple');

    expect(signInWithAppleWebMock).toHaveBeenCalledTimes(1);
    // The Google web fallback must not run for an Apple attempt.
    expect(signInWithGoogleWebMock).not.toHaveBeenCalled();
    // The handled native failure no longer reaches error tracking — the fallback owns it.
    expect(reportErrorMock).not.toHaveBeenCalled();
    expect(setError).toHaveBeenLastCalledWith(null);
    const events = trackedEvents();
    expect(events).toContainEqual({
      event: 'Login Attempted',
      flow: 'web_fallback',
      reason: undefined,
      recoverable: undefined,
      mechanism: 'browser_deeplink',
    });
    expect(events).toContainEqual({
      event: 'Login Succeeded',
      flow: 'web_fallback',
      reason: undefined,
      recoverable: undefined,
      mechanism: 'browser_deeplink',
    });
  });

  it('falls back and signs in when native Apple returns a non-cancel failure', async () => {
    signInWithAppleMock.mockResolvedValue({ success: false, status: 401, error: 'invalid' });
    signInWithAppleWebMock.mockResolvedValue({ success: true });

    const setError = await runSignIn('apple');

    expect(signInWithAppleWebMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).not.toHaveBeenCalled();
    expect(setError).toHaveBeenLastCalledWith(null);
    expect(trackedEvents()).toContainEqual({
      event: 'Login Succeeded',
      flow: 'web_fallback',
      reason: undefined,
      recoverable: undefined,
      mechanism: 'browser_deeplink',
    });
  });

  it('preserves registration attribution when the native flow falls back to the browser', async () => {
    signInWithAppleMock.mockRejectedValue(Object.assign(new Error('unknown'), { code: 1000 }));
    signInWithAppleWebMock.mockResolvedValue({ success: true });

    await runSignIn('apple', vi.fn(), true);

    expect(signInWithAppleWebMock).toHaveBeenCalledWith(true);
  });

  it('does NOT fall back when the user cancels native Apple, and logs a cancel (not a failure)', async () => {
    signInWithAppleMock.mockResolvedValue({ success: false, cancelled: true });

    await runSignIn('apple');

    expect(signInWithAppleWebMock).not.toHaveBeenCalled();
    expect(reportErrorMock).not.toHaveBeenCalled();
    const events = trackedEvents();
    expect(events).toContainEqual({
      event: 'Login Cancelled',
      flow: 'native',
      reason: undefined,
      recoverable: undefined,
    });
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'Login Failed' }));
  });

  it('stays silent (no error, no report) when the browser Apple sheet is cancelled', async () => {
    // The native throw triggers the fallback; the user then backs out of the
    // browser. A browser cancel is not an error — no message, no error tracking.
    signInWithAppleMock.mockRejectedValue(Object.assign(new Error('unknown'), { code: 1000 }));
    signInWithAppleWebMock.mockResolvedValue({ success: false, cancelled: true });

    const setError = await runSignIn('apple');

    expect(signInWithAppleWebMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).not.toHaveBeenCalled();
    // setError(null) at the start; never set to an error message.
    expect(setError).not.toHaveBeenCalledWith('nativeStart.oauthError');
    // A browser cancel is logged as a distinct event, not a LoginFailed.
    const events = trackedEvents();
    expect(events).toContainEqual({
      event: 'Login Cancelled',
      flow: 'web_fallback',
      reason: undefined,
      recoverable: undefined,
      mechanism: 'browser_deeplink',
    });
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'Login Failed', flow: 'web_fallback' }));
  });

  it('surfaces an error and reports once when the Apple web fallback also fails', async () => {
    signInWithAppleMock.mockRejectedValue(Object.assign(new Error('unknown'), { code: 1000 }));
    signInWithAppleWebMock.mockResolvedValue({
      success: false,
      status: 401,
      error: 'Invalid or expired transfer token',
    });

    const setError = await runSignIn('apple');

    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(setError).toHaveBeenLastCalledWith('nativeStart.oauthError');
    expect(trackedEvents()).toContainEqual({
      event: 'Login Failed',
      flow: 'web_fallback',
      reason: 'invalid_oauth_token',
      mechanism: 'browser_deeplink',
    });
  });
});

describe('useNativeOAuthSignIn — Android Google config-class fallback (#3100)', () => {
  beforeEach(() => {
    platform.OS = 'android';
    trackMock.mockReset();
    reportErrorMock.mockReset();
    signInWithAppleMock.mockReset();
    signInWithGoogleMock.mockReset();
    signInWithGoogleWebMock.mockReset();
    signInWithAppleWebMock.mockReset();
  });

  it('falls back to the browser when native Google throws DEVELOPER_ERROR (string code) and signs in', async () => {
    // The SHA-1 / OAuth-client dead-end (#3100): the fallback runs a full NextAuth
    // flow with no native SDK, so it recovers login while the signing cert is fixed.
    signInWithGoogleMock.mockRejectedValue(Object.assign(new Error('developer error'), { code: 'DEVELOPER_ERROR' }));
    signInWithGoogleWebMock.mockResolvedValue({ success: true });

    const setError = await runSignIn('google');

    expect(signInWithGoogleWebMock).toHaveBeenCalledTimes(1);
    // The fallback owns the outcome, so the handled native throw no longer reports.
    expect(reportErrorMock).not.toHaveBeenCalled();
    expect(setError).toHaveBeenLastCalledWith(null);
    const events = trackedEvents();
    // The native throw is now recoverable on Android too, so the failure metric excludes it.
    expect(events).toContainEqual({ event: 'Login Failed', flow: 'native', reason: 'exception', recoverable: true });
    expect(events).toContainEqual({
      event: 'Login Succeeded',
      flow: 'web_fallback',
      reason: undefined,
      recoverable: undefined,
      mechanism: 'browser_deeplink',
    });
  });

  it('falls back when native Google throws INTERNAL_ERROR as a numeric code (8)', async () => {
    signInWithGoogleMock.mockRejectedValue(Object.assign(new Error('internal'), { code: 8 }));
    signInWithGoogleWebMock.mockResolvedValue({ success: true });

    await runSignIn('google');

    expect(signInWithGoogleWebMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('falls back when DEVELOPER_ERROR arrives only in the message (no usable code)', async () => {
    // Some builds throw with no `.code`, the name only in the message — must still recover.
    signInWithGoogleMock.mockRejectedValue(
      new Error('DEVELOPER_ERROR: Follow troubleshooting instructions at https://.../troubleshooting'),
    );
    signInWithGoogleWebMock.mockResolvedValue({ success: true });

    await runSignIn('google');

    expect(signInWithGoogleWebMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('reports browser timeout as a warning failure with the generic OAuth copy', async () => {
    signInWithGoogleMock.mockRejectedValue(Object.assign(new Error('developer error'), { code: 'DEVELOPER_ERROR' }));
    signInWithGoogleWebMock.mockResolvedValue({ success: false, status: null, error: 'browser_timeout' });

    const setError = await runSignIn('google');

    expect(trackedEvents()).toContainEqual({
      event: 'Login Failed',
      flow: 'web_fallback',
      reason: 'browser_timeout',
      recoverable: undefined,
      mechanism: 'browser_deeplink',
    });
    expect(trackedEvents()).not.toContainEqual(
      expect.objectContaining({ event: 'Login Cancelled', flow: 'web_fallback' }),
    );
    expect(trackedEvents()).not.toContainEqual(
      expect.objectContaining({ flow: 'web_fallback', reason: 'browser_unavailable' }),
    );
    expect(reportErrorMock).toHaveBeenCalledWith(expect.any(Error), {
      level: 'warning',
      tags: {
        source: 'native-auth',
        provider: 'google',
        flow: 'web_fallback',
        failure_reason: 'browser_timeout',
      },
      extra: { status: null, server_error: 'browser_timeout' },
    });
    expect(setError).toHaveBeenLastCalledWith('nativeStart.oauthError');
  });

  it('surfaces the native error (no fallback) for a non-config Google throw — NETWORK_ERROR (7)', async () => {
    // Strict scope: only DEVELOPER_ERROR / INTERNAL_ERROR recover. A transient
    // NETWORK_ERROR keeps surfacing its native error rather than bouncing to a browser.
    signInWithGoogleMock.mockRejectedValue(Object.assign(new Error('network error'), { code: 7 }));

    const setError = await runSignIn('google');

    expect(signInWithGoogleWebMock).not.toHaveBeenCalled();
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ provider: 'google', flow: 'native', native_error_code: '7' }),
      }),
    );
    expect(setError).toHaveBeenLastCalledWith('nativeStart.oauthError');
    // Not recoverable, so it counts toward the terminal failure metric.
    expect(trackedEvents()).toContainEqual({
      event: 'Login Failed',
      flow: 'native',
      reason: 'exception',
      recoverable: false,
    });
  });

  it('does not fall back when native Google RETURNS a non-cancel failure (result path stays iOS-only)', async () => {
    // Config errors are throws, not returns; a returned backend failure on Android
    // isn't a native-SDK dead-end, so the result path keeps surfacing it.
    signInWithGoogleMock.mockResolvedValue({ success: false, status: 401, error: 'invalid' });

    const setError = await runSignIn('google');

    expect(signInWithGoogleWebMock).not.toHaveBeenCalled();
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(setError).toHaveBeenLastCalledWith('nativeStart.oauthError');
  });

  it('does NOT fall back or error when the user cancels native Google, and logs a cancel', async () => {
    signInWithGoogleMock.mockResolvedValue({ success: false, cancelled: true });

    await runSignIn('google');

    expect(signInWithGoogleWebMock).not.toHaveBeenCalled();
    expect(reportErrorMock).not.toHaveBeenCalled();
    const events = trackedEvents();
    expect(events).toContainEqual({
      event: 'Login Cancelled',
      flow: 'native',
      reason: undefined,
      recoverable: undefined,
    });
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'Login Failed' }));
  });

  it('does not run the Apple web fallback on Android even for a config-class-looking throw', async () => {
    // The gate is provider === 'google': Apple isn't offered on Android, so a
    // native Apple throw must surface the real error, never open a browser fallback.
    signInWithAppleMock.mockRejectedValue(Object.assign(new Error('unknown'), { code: 'DEVELOPER_ERROR' }));

    const setError = await runSignIn('apple');

    expect(signInWithAppleWebMock).not.toHaveBeenCalled();
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(setError).toHaveBeenLastCalledWith('nativeStart.oauthError');
  });
});
