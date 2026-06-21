export type NativeAuthFailureReason =
  | 'network'
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
