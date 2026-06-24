import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as WebBrowser from 'expo-web-browser';
import { getRandomBytes, digestStringAsync, CryptoDigestAlgorithm, CryptoEncoding } from 'expo-crypto';
import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';
import { createTimeoutSignal } from './abort-timeout';
import { storeTokens, clearTokens, getRefreshToken } from './auth-store';
import { nativeSignInErrorCode } from './native-auth-analytics';
import { parseDeepLinkQueryParams } from './deep-link-query';
import { BACKEND_URL, WEB_BASE_URL } from './env';

export type AuthProvider = 'google' | 'apple';

/**
 * Whether the build shipped the Google config the native flow needs, so the
 * login screen can hide the button instead of advertising a sign-in that would
 * fail on tap. Mirrors the app.config.ts plugin gating: the webClientId is
 * always required (it's the idToken audience), and on iOS the reversed-client
 * URL scheme that the google-signin config plugin registers must be present too
 * (an Apple-only build omits it). Android needs no URL scheme.
 */
export function isGoogleSignInConfigured(): boolean {
  if (!process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID) return false;
  // iOS additionally needs the iOS client ID: GoogleSignin.configure reads it
  // for the native flow, and app.config.ts derives the required URL scheme from
  // it. The scheme-only override isn't enough — configure would have no client
  // ID and signIn() would throw. (EXPO_PUBLIC_* are inlined at JS-bundle build
  // time, so an OTA update must be built with the same Google config as the
  // binary it lands on.)
  if (Platform.OS === 'ios') return Boolean(process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID);
  return true;
}

type ForwardedName = { firstName?: string; lastName?: string };

type NativeAuthFailure = { success: false; status: number | null; error: string };

// A native OAuth attempt resolves to one of: success, an explicit user
// cancellation (no error shown), or a real failure carrying the server's
// status/error (mapped to a translated message by the caller).
export type OAuthSignInResult = { success: true } | { success: false; cancelled: true } | NativeAuthFailure;

/**
 * POST a verified provider identity token to the backend, which verifies it
 * against the provider's JWKS and returns our mobile JWT pair. Mirrors
 * signInWithCredentials' failure shape so the analytics classifier is reused.
 */
export async function oauthNativeSignIn(
  provider: AuthProvider,
  identityToken: string,
  extra?: { nonce?: string; name?: ForwardedName },
): Promise<OAuthSignInResult> {
  let response: Response;
  try {
    response = await fetch(`${BACKEND_URL}/auth/native/oauth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, identityToken, nonce: extra?.nonce, name: extra?.name }),
      signal: createTimeoutSignal(15_000),
    });
  } catch {
    // Network failure / timeout. The caller maps this to a translated message.
    return { success: false, status: null, error: 'network' };
  }

  if (!response.ok) {
    let serverError = `HTTP ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.length > 0) {
        serverError = parsed.error;
      }
    } catch {
      // Body wasn't JSON; fall back to the HTTP status string above.
    }
    return { success: false, status: response.status, error: serverError };
  }

  const data = (await response.json()) as { jwt: string; refreshToken: string; expiresAt: string };
  await storeTokens(data.jwt, data.refreshToken, data.expiresAt);
  return { success: true };
}

// CSPRNG nonce, as lowercase hex. We hand Apple SHA-256(nonce) and send the raw
// value to the backend, which re-hashes to bind the token to this attempt — so
// the raw nonce never lives in the identity token (Apple echoes the request
// nonce verbatim).
function generateNonce(): string {
  const bytes = getRandomBytes(16);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// expo-apple-authentication rejects with a CodedError whose `.code` is
// `ERR_REQUEST_CANCELED` when the user dismisses the system sheet.
function isAppleCancellation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ERR_REQUEST_CANCELED';
}

export async function signInWithApple(): Promise<OAuthSignInResult> {
  const rawNonce = generateNonce();
  // Hand Apple the hash; the token's `nonce` claim will be this value (Apple
  // echoes it unmodified). The backend re-hashes the raw nonce we send below.
  const hashedNonce = await digestStringAsync(CryptoDigestAlgorithm.SHA256, rawNonce, {
    encoding: CryptoEncoding.HEX,
  });
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });
  } catch (error) {
    if (isAppleCancellation(error)) return { success: false, cancelled: true };
    throw error;
  }

  if (!credential.identityToken) {
    return { success: false, status: null, error: 'no_identity_token' };
  }

  // Apple delivers the name only on the first authorization; forward it when
  // present so a brand-new account gets a display name.
  const fullName = credential.fullName;
  const name: ForwardedName | undefined =
    fullName && (fullName.givenName || fullName.familyName)
      ? { firstName: fullName.givenName ?? undefined, lastName: fullName.familyName ?? undefined }
      : undefined;

  return oauthNativeSignIn('apple', credential.identityToken, { nonce: rawNonce, name });
}

let googleConfigured = false;
function configureGoogleSignin(): void {
  if (googleConfigured) return;
  // webClientId is required to receive an idToken; iosClientId scopes the
  // native flow on iOS. Both are inlined at build time (EXPO_PUBLIC_*).
  //
  // No androidClientId on purpose: @react-native-google-signin resolves the
  // Android OAuth client by package name + signing-certificate SHA-1 (registered
  // in the webClientId's Google Cloud project), not by an id string — passing one
  // is ignored. EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID exists only for backend-
  // audience parity. If Android sign-in fails before any network call, the
  // running build's SHA-1 likely isn't registered (see docs/android-sideload-build.md).
  GoogleSignin.configure({
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
    iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  });
  googleConfigured = true;
}

function isGoogleCancellation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === statusCodes.SIGN_IN_CANCELLED
  );
}

export async function signInWithGoogle(): Promise<OAuthSignInResult> {
  configureGoogleSignin();
  try {
    // No-op on iOS; on Android ensures Play Services is present/updatable.
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const response = await GoogleSignin.signIn();
    if (response.type === 'cancelled') {
      return { success: false, cancelled: true };
    }
    const idToken = response.data.idToken;
    if (!idToken) {
      return { success: false, status: null, error: 'no_id_token' };
    }
    return oauthNativeSignIn('google', idToken);
  } catch (error) {
    if (isGoogleCancellation(error)) return { success: false, cancelled: true };
    // An error that isn't one of the library's known status codes is, on Android,
    // almost always a config problem: the running build's signing-cert SHA-1 isn't
    // registered as an Android OAuth client for the package (the classic Play
    // Services flow called this DEVELOPER_ERROR; the newer Credential Manager flow
    // surfaces an unmapped error). It's a Google Cloud fix, not a code one — spell
    // it out for local dev. Release builds carry the code into PostHog via
    // login.tsx's failure_detail/tag.
    if (__DEV__) {
      const errorCode = nativeSignInErrorCode(error);
      const isKnownStatus = errorCode !== undefined && Object.values(statusCodes).includes(errorCode);
      if (!isKnownStatus)
        console.warn(
          `[auth] Google sign-in failed with an unmapped error (code: ${errorCode ?? 'none'}). On Android ` +
            "this is typically a config issue — the build's signing-certificate SHA-1 isn't registered as an " +
            "Android OAuth client for com.boardsesh.app in the webClientId's Google Cloud project. Get the " +
            'SHA-1 via `apksigner verify --print-certs <apk>` (see docs/android-sideload-build.md).',
        );
    }
    throw error;
  }
}

// The browser-OAuth fallback's deep-link return URL. Matches the web app's
// NATIVE_OAUTH_CALLBACK_SCHEME (packages/web/app/lib/auth/native-oauth-config.ts):
// /api/auth/native/callback redirects here with `?transferToken=…` on success.
const NATIVE_OAUTH_REDIRECT = 'com.boardsesh.app://auth/callback';

/**
 * Exchange a single-use transfer token (minted by the web app's
 * /api/auth/native/callback after a browser Google sign-in) for our mobile JWT
 * pair, and store it. Mirrors oauthNativeSignIn's failure shape so the analytics
 * classifier is reused.
 */
async function exchangeTransferToken(transferToken: string): Promise<OAuthSignInResult> {
  let response: Response;
  try {
    response = await fetch(`${BACKEND_URL}/auth/native/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transferToken }),
      signal: createTimeoutSignal(15_000),
    });
  } catch {
    // Network failure / timeout. The caller maps this to a translated message.
    return { success: false, status: null, error: 'network' };
  }

  if (!response.ok) {
    let serverError = `HTTP ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.length > 0) {
        serverError = parsed.error;
      }
    } catch {
      // Body wasn't JSON; fall back to the HTTP status string above.
    }
    return { success: false, status: response.status, error: serverError };
  }

  let data: { jwt: string; refreshToken: string; expiresAt: string };
  try {
    data = (await response.json()) as { jwt: string; refreshToken: string; expiresAt: string };
  } catch {
    // A 200 with an unreadable body — keep this function's "never throws" contract.
    return { success: false, status: response.status, error: 'invalid_response' };
  }
  await storeTokens(data.jwt, data.refreshToken, data.expiresAt);
  return { success: true };
}

/**
 * Browser-based OAuth sign-in — the fallback for when the native provider SDK
 * can't complete on the device. Opens the web app's /auth/native-start page in an
 * auth-session browser, which runs the proven NextAuth flow for `provider`, mints
 * a single-use transfer token on success, and redirects back to
 * NATIVE_OAUTH_REDIRECT; we then exchange that token for our JWT pair. Reuses the
 * same handoff the web app already serves (the Strava/Aurora pattern), with no
 * native OAuth SDK involvement, so it's immune to the native SDK's per-OS-version
 * breakage. The web /auth/native-start page already allows both 'google' and
 * 'apple' (its ALLOWED_PROVIDERS), and the callback + exchange are
 * provider-agnostic, so the only per-provider difference is this query param.
 *
 * Never throws: every outcome maps to an OAuthSignInResult (success / cancelled /
 * failure) so the caller treats it exactly like the native path.
 */
async function signInWithProviderWeb(provider: AuthProvider): Promise<OAuthSignInResult> {
  const nativeCallbackUrl = `${WEB_BASE_URL}/api/auth/native/callback?next=${encodeURIComponent('/')}`;
  const startUrl = `${WEB_BASE_URL}/auth/native-start?provider=${provider}&callbackUrl=${encodeURIComponent(nativeCallbackUrl)}`;

  let result: WebBrowser.WebBrowserAuthSessionResult;
  try {
    result = await WebBrowser.openAuthSessionAsync(startUrl, NATIVE_OAUTH_REDIRECT);
  } catch {
    // The auth-session browser couldn't open — treat as a network-class failure.
    return { success: false, status: null, error: 'network' };
  }

  // Dismissed before the redirect was captured — the user backed out.
  if (result.type !== 'success') return { success: false, cancelled: true };

  const params = parseDeepLinkQueryParams(result.url);
  const error = params.get('error');
  if (error) return { success: false, status: null, error };
  const transferToken = params.get('transferToken');
  if (!transferToken) return { success: false, status: null, error: 'no_transfer_token' };

  return exchangeTransferToken(transferToken);
}

// Browser Google fallback — for when native GoogleSignin can't present its OAuth
// browser (iOS 26.5.1 fails with GIDSignIn "Unable to open Safari" before any
// network call).
export function signInWithGoogleWeb(): Promise<OAuthSignInResult> {
  return signInWithProviderWeb('google');
}

// Browser Apple fallback — for when native Sign in with Apple throws a non-cancel
// error (ASAuthorizationError.unknown / code 1000: device not signed into iCloud,
// 2FA disabled, transient Apple ID issues), which otherwise dead-ends the user.
export function signInWithAppleWeb(): Promise<OAuthSignInResult> {
  return signInWithProviderWeb('apple');
}

export type CredentialsSignInResult = { success: true } | NativeAuthFailure;

export async function signInWithCredentials(email: string, password: string): Promise<CredentialsSignInResult> {
  let response: Response;
  try {
    response = await fetch(`${BACKEND_URL}/auth/native/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: createTimeoutSignal(15_000),
    });
  } catch {
    // Network failure / timeout. The caller maps this to a translated message.
    return { success: false, status: null, error: 'network' };
  }

  if (!response.ok) {
    let serverError = `HTTP ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.length > 0) {
        serverError = parsed.error;
      }
    } catch {
      // Body wasn't JSON; fall back to the HTTP status string above.
    }
    return { success: false, status: response.status, error: serverError };
  }

  const data = (await response.json()) as { jwt: string; refreshToken: string; expiresAt: string };
  await storeTokens(data.jwt, data.refreshToken, data.expiresAt);
  return { success: true };
}

/**
 * Create a Boardsesh account and sign the new user straight in. Mirrors
 * signInWithCredentials: the backend's /auth/native/register returns the same
 * JWT pair, so a 2xx response means the account exists AND the device is
 * authenticated. A 409 (preserved in `status`) is how the UI tells "this email
 * already has an account" apart from a real failure. `name` is optional.
 */
export async function registerWithCredentials(
  email: string,
  password: string,
  name?: string,
): Promise<CredentialsSignInResult> {
  let response: Response;
  try {
    response = await fetch(`${BACKEND_URL}/auth/native/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, ...(name ? { name } : {}) }),
      signal: createTimeoutSignal(15_000),
    });
  } catch {
    // Network failure / timeout. The caller maps this to a translated message.
    return { success: false, status: null, error: 'network' };
  }

  if (!response.ok) {
    let serverError = `HTTP ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.length > 0) {
        serverError = parsed.error;
      }
    } catch {
      // Body wasn't JSON; fall back to the HTTP status string above.
    }
    return { success: false, status: response.status, error: serverError };
  }

  const data = (await response.json()) as { jwt: string; refreshToken: string; expiresAt: string };
  await storeTokens(data.jwt, data.refreshToken, data.expiresAt);
  return { success: true };
}

export type PasswordResetResult = { success: true } | NativeAuthFailure;

/**
 * Request a password reset email. Calls the web API's forgot-password endpoint.
 * Always returns success=true on 2xx even though the backend is intentionally
 * non-committal about whether the email exists (user enumeration prevention).
 */
export async function requestPasswordReset(email: string): Promise<PasswordResetResult> {
  let response: Response;
  try {
    response = await fetch(`${WEB_BASE_URL}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
      signal: createTimeoutSignal(15_000),
    });
  } catch {
    return { success: false, status: null, error: 'network' };
  }

  if (!response.ok) {
    let serverError = `HTTP ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.length > 0) {
        serverError = parsed.error;
      }
    } catch {
      // Body wasn't JSON; fall back to the HTTP status string.
    }
    return { success: false, status: response.status, error: serverError };
  }

  return { success: true };
}

/**
 * Submit a new password using a reset token from the email link.
 * Calls the web API's reset-password endpoint.
 */
export async function resetPassword(email: string, token: string, newPassword: string): Promise<PasswordResetResult> {
  let response: Response;
  try {
    response = await fetch(`${WEB_BASE_URL}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, token, password: newPassword, confirmPassword: newPassword }),
      signal: createTimeoutSignal(15_000),
    });
  } catch {
    return { success: false, status: null, error: 'network' };
  }

  if (!response.ok) {
    let serverError = `HTTP ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.length > 0) {
        serverError = parsed.error;
      }
    } catch {
      // Body wasn't JSON; fall back to the HTTP status string.
    }
    return { success: false, status: response.status, error: serverError };
  }

  return { success: true };
}

export async function signOut(): Promise<void> {
  const refreshToken = await getRefreshToken();
  if (refreshToken) {
    // Best-effort server-side revocation — don't block on failure
    fetch(`${BACKEND_URL}/auth/native/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => {});
  }
  await clearTokens();
}
