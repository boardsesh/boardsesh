import { getAuthToken, getRefreshToken, storeTokens, isTokenExpiringSoon } from './auth-store';
import { signOut } from './auth';
import { BACKEND_URL } from './env';
import { reportError, reportHandledError } from './error-reporting';

let refreshPromise: Promise<boolean> | null = null;

// The interceptor lives in the lib layer and can't import the AuthProvider, but
// a failed-refresh 401 means the session is dead and the provider must run its
// full signed-out cleanup (flip isAuthenticated → redirect to login, dispose the
// WS client, reset analytics, clear caches). The provider registers that cleanup
// here in a useEffect; we invoke it from the 401 branch below.
let onForcedSignOut: (() => void) | null = null;

export function setOnForcedSignOut(callback: (() => void) | null): void {
  onForcedSignOut = callback;
}

async function refreshTokens(): Promise<boolean> {
  const currentRefreshToken = await getRefreshToken();
  if (!currentRefreshToken) return false;

  try {
    const response = await fetch(`${BACKEND_URL}/auth/native/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: currentRefreshToken }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      console.warn(`[Auth] Token refresh failed: HTTP ${response.status}`);
      // A 401/403 is an expired/revoked refresh token — routine, the user just
      // signs in again. A 5xx means our refresh endpoint is broken for everyone,
      // which we do want to see.
      if (response.status >= 500) {
        reportError(new Error(`Token refresh failed: HTTP ${response.status}`), {
          tags: { source: 'auth-refresh' },
          extra: { status: response.status },
        });
      }
      return false;
    }

    const data = (await response.json()) as { jwt: string; refreshToken: string; expiresAt: string };
    await storeTokens(data.jwt, data.refreshToken, data.expiresAt);
    return true;
  } catch (error) {
    console.warn('[Auth] Token refresh error:', error instanceof Error ? error.message : 'unknown');
    // Offline/aborted refreshes downgrade to a warning; a real throw reports.
    reportHandledError(error, { tags: { source: 'auth-refresh' } });
    return false;
  }
}

function deduplicatedRefresh(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = refreshTokens().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function ensureFreshToken(): Promise<boolean> {
  const expiring = await isTokenExpiringSoon();
  if (!expiring) return true;
  return deduplicatedRefresh();
}

let forcedSignOutPromise: Promise<void> | null = null;

// A burst of concurrent requests all 401 and all see deduplicatedRefresh() return
// false, so without collapsing them each would revoke + fire onForcedSignOut —
// duplicate `forced` Logout events and redundant provider cleanup. Run the sign-out
// once; reset on settle so a genuinely new 401 (after a later sign-in) still signs
// out. signOut() must complete (revoke + clearTokens) before onForcedSignOut runs.
function forceSignOut(): Promise<void> {
  if (!forcedSignOutPromise) {
    // Capture the hook now. signOut() awaits a network revoke; if the provider
    // unmounts during that window its effect nulls the module ref, but the
    // cleanup it registered must still run (dispose the WS, reset the http
    // client, clear caches) or the forced sign-out silently drops — the exact
    // failure this path exists to prevent.
    const notifyProvider = onForcedSignOut;
    forcedSignOutPromise = (async () => {
      await signOut();
      notifyProvider?.();
    })().finally(() => {
      forcedSignOutPromise = null;
    });
  }
  return forcedSignOutPromise;
}

export async function authenticatedFetch(url: string | URL | Request, options: RequestInit = {}): Promise<Response> {
  await ensureFreshToken();

  const token = await getAuthToken();
  const headers = new Headers(options.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(url, { ...options, headers });

  // On 401, force a refresh regardless of token expiry (server may have
  // revoked the token) and retry once with the new credentials.
  if (response.status === 401 && token) {
    const refreshed = await deduplicatedRefresh();
    if (refreshed) {
      const newToken = await getAuthToken();
      if (newToken) {
        headers.set('Authorization', `Bearer ${newToken}`);
        return fetch(url, { ...options, headers });
      }
    }
    // signOut() only revokes + clears tokens. forceSignOut also tells the provider
    // to run the rest of the cleanup so the UI leaves the authenticated screens
    // immediately, instead of waiting for the next background→foreground checkAuth.
    await forceSignOut();
  }

  return response;
}
