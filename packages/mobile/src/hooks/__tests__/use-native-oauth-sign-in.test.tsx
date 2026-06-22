// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

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

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// The browser web fallback is the recovery path on every platform (it used to be
// iOS-only), so the hook no longer reads Platform.OS — no react-native mock needed.

const { useNativeOAuthSignIn } = await import('../use-native-oauth-sign-in');

type TrackedEvent = { event: unknown; flow: unknown; reason: unknown; recoverable: unknown };
function trackedEvents(): TrackedEvent[] {
  return trackMock.mock.calls.map(([event, props]) => ({
    event,
    flow: (props as { flow?: unknown })?.flow,
    reason: (props as { failure_reason?: unknown })?.failure_reason,
    recoverable: (props as { recoverable?: unknown })?.recoverable,
  }));
}

// The full props of every tracked event — for assertions that need a field
// trackedEvents() doesn't surface, like failure_detail.
function trackedProps(): Record<string, unknown>[] {
  return trackMock.mock.calls.map(([, props]) => props as Record<string, unknown>);
}

async function runSignIn(provider: 'google' | 'apple', setError = vi.fn()) {
  const { result } = renderHook(() => useNativeOAuthSignIn({ setError }));
  await act(async () => {
    await result.current.signIn(provider);
  });
  return setError;
}

describe('useNativeOAuthSignIn — Google web fallback', () => {
  beforeEach(() => {
    trackMock.mockReset();
    reportErrorMock.mockReset();
    signInWithAppleMock.mockReset();
    signInWithGoogleMock.mockReset();
    signInWithGoogleWebMock.mockReset();
    signInWithAppleWebMock.mockReset();
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
    });
    expect(events).toContainEqual({
      event: 'Login Succeeded',
      flow: 'web_fallback',
      reason: undefined,
      recoverable: undefined,
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
    });
  });
});

describe('useNativeOAuthSignIn — Apple web fallback', () => {
  beforeEach(() => {
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
    expect(events).toContainEqual({ event: 'Login Attempted', flow: 'web_fallback', reason: undefined });
    expect(events).toContainEqual({ event: 'Login Succeeded', flow: 'web_fallback', reason: undefined });
  });

  it('falls back and signs in when native Apple returns a non-cancel failure', async () => {
    signInWithAppleMock.mockResolvedValue({ success: false, status: 401, error: 'invalid' });
    signInWithAppleWebMock.mockResolvedValue({ success: true });

    const setError = await runSignIn('apple');

    expect(signInWithAppleWebMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).not.toHaveBeenCalled();
    expect(setError).toHaveBeenLastCalledWith(null);
    expect(trackedEvents()).toContainEqual({ event: 'Login Succeeded', flow: 'web_fallback', reason: undefined });
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
    });
  });
});

// The Android-specific failure mode #3100 fixes: a native Google
// DEVELOPER_ERROR (the running build's signing-cert SHA-1 isn't registered) used
// to dead-end login after #3083 gated the browser fallback to iOS. The fallback
// now runs on Android too, so the user recovers — while the native failure stays
// visible in analytics so the underlying SHA-1 misconfig is still measurable.
describe('useNativeOAuthSignIn — Android Google web fallback (DEVELOPER_ERROR recovery)', () => {
  beforeEach(() => {
    trackMock.mockReset();
    reportErrorMock.mockReset();
    signInWithAppleMock.mockReset();
    signInWithGoogleMock.mockReset();
    signInWithGoogleWebMock.mockReset();
    signInWithAppleWebMock.mockReset();
  });

  it('recovers via the web flow when native Google throws DEVELOPER_ERROR — and still records it', async () => {
    signInWithGoogleMock.mockRejectedValue(Object.assign(new Error('developer error'), { code: 'DEVELOPER_ERROR' }));
    signInWithGoogleWebMock.mockResolvedValue({ success: true });

    const setError = await runSignIn('google');

    expect(signInWithGoogleWebMock).toHaveBeenCalledTimes(1);
    // The browser recovered the user — no dead-end exception report.
    expect(reportErrorMock).not.toHaveBeenCalled();
    expect(setError).toHaveBeenLastCalledWith(null);
    const events = trackedEvents();
    expect(events).toContainEqual({ event: 'Login Succeeded', flow: 'web_fallback', reason: undefined });
    // The native failure is still tracked (flow: 'native') with the native code as
    // failure_detail, so DEVELOPER_ERROR / the SHA-1 misconfig stays visible in PostHog.
    const nativeFailure = trackedProps().find(
      (props) => props.flow === 'native' && props.failure_reason === 'exception',
    );
    expect(nativeFailure?.failure_detail).toBe('DEVELOPER_ERROR');
    // Android now recovers via the fallback too, so the native throw is tagged
    // recoverable (matches iOS) and the terminal-failure metric excludes it.
    expect(events).toContainEqual({
      event: 'Login Failed',
      flow: 'native',
      reason: 'exception',
      recoverable: true,
    });
  });

  it('recovers via the web flow when native Google returns a non-cancel failure', async () => {
    signInWithGoogleMock.mockResolvedValue({ success: false, status: 401, error: 'invalid' });
    signInWithGoogleWebMock.mockResolvedValue({ success: true });

    const setError = await runSignIn('google');

    expect(signInWithGoogleWebMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).not.toHaveBeenCalled();
    expect(setError).toHaveBeenLastCalledWith(null);
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

  it('surfaces an error and reports once when the web fallback also fails (SHA-1 still unfixed)', async () => {
    signInWithGoogleMock.mockRejectedValue(Object.assign(new Error('developer error'), { code: 'DEVELOPER_ERROR' }));
    signInWithGoogleWebMock.mockResolvedValue({
      success: false,
      status: 401,
      error: 'Invalid or expired transfer token',
    });

    const setError = await runSignIn('google');

    // A genuine failure still reaches error tracking — re-tagged under flow: 'web_fallback'.
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(setError).toHaveBeenLastCalledWith('nativeStart.oauthError');
    expect(trackedEvents()).toContainEqual({
      event: 'Login Failed',
      flow: 'web_fallback',
      reason: 'invalid_oauth_token',
    });
  });

  it('opens the Apple web fallback on Android too — the hook is platform-agnostic now', async () => {
    // Apple sign-in isn't offered in the Android UI, but the gate that used to keep
    // the fallback iOS-only is gone (#3083 → #3100). Locking the deliberate behavior:
    // if a caller ever passes 'apple', it recovers in the browser rather than
    // silently dead-ending — so a future regression that re-gates it is caught here.
    signInWithAppleMock.mockRejectedValue(Object.assign(new Error('unknown'), { code: 1000 }));
    signInWithAppleWebMock.mockResolvedValue({ success: true });

    const setError = await runSignIn('apple');

    expect(signInWithAppleWebMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).not.toHaveBeenCalled();
    expect(setError).toHaveBeenLastCalledWith(null);
  });
});
