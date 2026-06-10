import { Linking, Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { createTimeoutSignal } from './abort-timeout';
import { raceBrowserSignIn } from './auth-session-race';
import { storeTokens, clearTokens, getRefreshToken } from './auth-store';
import { BACKEND_URL, WEB_BASE_URL } from './env';

export type AuthProvider = 'google' | 'apple';

const AUTH_CALLBACK_URL = 'com.boardsesh.app://auth/callback';

// The transfer-token exchange doesn't echo the OAuth provider back, so the
// callback screen reads the in-flight attempt's provider from here to attribute
// its Login Succeeded/Failed events. Set by startSignIn; cleared when the
// attempt reaches a terminal outcome (login screen's failure paths, the
// callback screen's exchange outcomes, sign-out) so a callback mount outside a
// live flow — stale deep link, hot reload — can't inherit a previous attempt.
let pendingOAuthProvider: AuthProvider | null = null;

export function getPendingOAuthProvider(): AuthProvider | null {
  return pendingOAuthProvider;
}

export function clearPendingOAuthProvider(): void {
  pendingOAuthProvider = null;
}

// The two platforms deliver the OAuth callback differently:
// - Android: openAuthSessionAsync's custom tab. The callback arrives both as
//   the resolved result URL and as an expo-router deep link; the callback
//   screen dedupes the exchange.
// - iOS: a plain SFSafariViewController raced against the OS deep link the
//   server's callback page fires (see auth-session-race.ts for why
//   openAuthSessionAsync is deliberately avoided here). Expo Router also
//   routes the deep link to /auth/callback; the same dedupe applies.
export async function startSignIn(provider: AuthProvider): Promise<WebBrowser.WebBrowserAuthSessionResult> {
  pendingOAuthProvider = provider;
  const callbackUrl = encodeURIComponent('/api/auth/native/callback?next=/');
  const url = `${WEB_BASE_URL}/auth/native-start?provider=${provider}&callbackUrl=${callbackUrl}`;

  if (Platform.OS !== 'ios') {
    return WebBrowser.openAuthSessionAsync(url, AUTH_CALLBACK_URL);
  }

  const result = await raceBrowserSignIn(
    {
      addUrlListener: (listener) => Linking.addEventListener('url', listener),
      openBrowser: (browserUrl) => WebBrowser.openBrowserAsync(browserUrl),
      // async so the race always gets a real promise even if a future SDK's
      // dismissBrowser returns void or throws synchronously.
      dismissBrowser: async () => WebBrowser.dismissBrowser(),
    },
    url,
    AUTH_CALLBACK_URL,
  );
  if (result.type === 'error') {
    // Surfaces in the login screen's catch, which reports the message as
    // failure_detail — the old flow filed browser failures under 'cancel'.
    throw new Error(result.message);
  }
  return result.type === 'success'
    ? { type: 'success', url: result.url }
    : { type: WebBrowser.WebBrowserResultType.CANCEL };
}

type NativeAuthFailure = { success: false; status: number | null; error: string };

export async function exchangeTransferToken(
  transferToken: string,
): Promise<{ success: true; expiresAt: string } | NativeAuthFailure> {
  try {
    const response = await fetch(`${BACKEND_URL}/auth/native/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transferToken }),
      signal: createTimeoutSignal(15_000),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, status: response.status, error: errorBody || `HTTP ${response.status}` };
    }

    const data = (await response.json()) as { jwt: string; refreshToken: string; expiresAt: string };
    await storeTokens(data.jwt, data.refreshToken, data.expiresAt);
    return { success: true, expiresAt: data.expiresAt };
  } catch (error) {
    return { success: false, status: null, error: error instanceof Error ? error.message : 'Exchange failed' };
  }
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

export async function signOut(): Promise<void> {
  clearPendingOAuthProvider();
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
