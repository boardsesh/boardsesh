export type NativeAuthFailureReason =
  | 'network'
  | 'browser_unavailable'
  | 'browser_timeout'
  | 'invalid_credentials'
  | 'invalid_oauth_token'
  | 'invalid_request'
  | 'rate_limited'
  | 'service_unavailable'
  | 'server_error'
  | 'http_error'
  | 'exception';

// Which backend endpoint produced the failure. A 401 means "invalid
// credentials" on /auth/native/credentials but "invalid or expired identity
// token" on /auth/native/oauth — classify by the call site instead of
// string-matching server copy (which silently broke when the backend's 401
// body said 'Invalid email or password').
export type NativeAuthFailureSource = 'credentials' | 'oauth';

type NativeAuthFailure = { success: false; status: number | null; error: string };

export function classifyNativeAuthFailureReason(
  failure: NativeAuthFailure,
  source: NativeAuthFailureSource,
): NativeAuthFailureReason {
  if (failure.error === 'network') return 'network';
  // The web-OAuth fallback's in-app browser couldn't present (iOS 26). Carries no
  // HTTP status — classify off the sentinel error string before the status checks.
  if (failure.error === 'browser_unavailable') return 'browser_unavailable';
  if (failure.error === 'browser_timeout') return 'browser_timeout';
  if (failure.status === 400) return 'invalid_request';
  if (failure.status === 401) {
    return source === 'credentials' ? 'invalid_credentials' : 'invalid_oauth_token';
  }
  if (failure.status === 429) return 'rate_limited';
  if (failure.status === 503) return 'service_unavailable';
  if (failure.status != null && failure.status >= 500) return 'server_error';
  return 'http_error';
}

/**
 * Extract the status code from a thrown native sign-in error. The Google
 * (@react-native-google-signin) and Apple (expo-apple-authentication) modules
 * reject with a CodedError whose `.code` names the failure — most importantly
 * `DEVELOPER_ERROR`, which on Android means the running build's signing-cert
 * SHA-1 isn't registered as an Android OAuth client for this package in the
 * webClientId's Google Cloud project (the #1 native-sign-in misconfig, and one
 * that never reaches our backend). The message for these is usually opaque, so
 * surfacing the code turns a generic "sign in failed" into an actionable
 * telemetry property. Returns undefined for anything without a string/number
 * `code` (the caller falls back to the error message).
 */
export function nativeSignInErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : undefined;
}

// The two GMS Google-Sign-In failure codes that dead-end Android login and are
// recoverable via the browser fallback (a full NextAuth flow with no native SDK,
// so it's immune to the SHA-1 / OAuth-client misconfig behind them). DEVELOPER_ERROR
// is the classic unregistered-signing-cert SHA-1; INTERNAL_ERROR (8) is frequently
// the same mismatch (or transient Play Services). Deliberately narrow — NETWORK_ERROR
// (7), PLAY_SERVICES_NOT_AVAILABLE and friends are left to surface the real native
// error instead of bouncing into a browser. `com.google.android.gms.common.api.ApiException`
// surfaces these inconsistently across builds: a numeric `.code` (8 / 10), a string
// `.code` ('INTERNAL_ERROR'), or no usable `.code` at all with the name only in the
// message ("DEVELOPER_ERROR: Follow troubleshooting…"). Match all three forms.
const RECOVERABLE_ANDROID_GOOGLE_CODES = new Set(['8', '10', 'DEVELOPER_ERROR', 'INTERNAL_ERROR']);

/**
 * Whether a thrown Android Google-Sign-In error is a config-class failure
 * (DEVELOPER_ERROR / INTERNAL_ERROR) that the browser fallback can recover, vs a
 * failure that should surface its native error. Checks the `.code` (numeric or
 * string form) first, then falls back to the error message for the builds that
 * throw these with no usable code. The caller gates this on Platform.OS ===
 * 'android' && provider === 'google'.
 */
export function isRecoverableAndroidGoogleSignInError(error: unknown): boolean {
  const code = nativeSignInErrorCode(error);
  if (code !== undefined && RECOVERABLE_ANDROID_GOOGLE_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : '';
  return message.includes('DEVELOPER_ERROR') || message.includes('INTERNAL_ERROR');
}

// Apple's own English description for `ASAuthorizationError.canceled`. Some
// builds of expo-apple-authentication reject with this message and no usable
// `.code`, so the code check alone misses them.
const APPLE_CANCELLATION_MESSAGE = /user cance(?:l|ll)ed the authorization attempt/i;

/**
 * Whether a thrown Sign in with Apple error is the climber backing out of the
 * system sheet rather than a real failure.
 *
 * expo-apple-authentication usually rejects with a CodedError whose `.code` is
 * `ERR_REQUEST_CANCELED`, but not always: 49 events across 44 users in 30 days
 * reached the sign-in hook's outer catch with `failure_reason: 'exception'` and
 * the bare message "The user canceled the authorization attempt" (#3088). That
 * escape made a cancel look like a failure, which tipped iOS into the browser
 * OAuth fallback — so dismissing the Apple sheet dumped the climber into a web
 * sign-in. Hence the message fallback.
 *
 * Deliberately narrow. "The authorization attempt failed for an unknown reason"
 * and `ERR_REQUEST_UNKNOWN` are real failures and must keep classifying as such.
 */
export function isAppleSignInCancellation(error: unknown): boolean {
  if (nativeSignInErrorCode(error) === 'ERR_REQUEST_CANCELED') return true;
  if (typeof error !== 'object' || error === null) return false;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && APPLE_CANCELLATION_MESSAGE.test(message);
}
