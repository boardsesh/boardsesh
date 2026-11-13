import {
  captureAuthCredentialGeneration,
  getAuthToken,
  getRefreshToken,
  isAuthCredentialGenerationCurrent,
  isTokenExpiringSoon,
  storeTokensForGeneration,
} from './auth-store';
import { signOutForGeneration } from './auth';
import { getConnectivitySnapshot, reportBackendOutcome } from './connectivity/connectivity-store';
import { BACKEND_URL } from './env';
import { reportError, reportHandledError } from './error-reporting';
import type { AuthRejectionResult } from './auth-rejection-result';

type AuthRefreshResult =
  | { status: 'refreshed'; generation: number }
  | { status: 'rejected'; generation: number }
  | { status: 'unavailable'; generation: number; error: unknown }
  | { status: 'superseded' };

let refresh: { generation: number; promise: Promise<AuthRefreshResult> } | null = null;

// The interceptor lives in the lib layer and can't import the AuthProvider, but
// a failed-refresh 401 means the session is dead and the provider must run its
// full signed-out cleanup (flip isAuthenticated → redirect to login, dispose the
// WS client, reset analytics, clear caches). The provider registers that cleanup
// here in a useEffect; we invoke it from the 401 branch below.
let onForcedSignOut: (() => void) | null = null;

export function setOnForcedSignOut(callback: (() => void) | null): void {
  onForcedSignOut = callback;
}

function rejectedRefreshResult(generation: number): AuthRefreshResult {
  return isAuthCredentialGenerationCurrent(generation) ? { status: 'rejected', generation } : { status: 'superseded' };
}

async function refreshTokens(credentialGeneration: number): Promise<AuthRefreshResult> {
  try {
    // Keep the SecureStore read inside the guarded failure boundary. A locked or
    // temporarily unavailable keychain is no more authoritative than a failed
    // fetch and must resolve as unavailable rather than reject the shared refresh
    // promise (which could otherwise make callers treat the session as absent).
    const currentRefreshToken = await getRefreshToken();
    if (!isAuthCredentialGenerationCurrent(credentialGeneration)) return { status: 'superseded' };
    if (!currentRefreshToken) return rejectedRefreshResult(credentialGeneration);

    // Only the FETCH is wrapped. A keychain read that threw above is not a
    // backend signal, and reporting it as one would send the connectivity store
    // probing a server that is perfectly fine.
    let response: Response;
    try {
      response = await fetch(`${BACKEND_URL}/auth/native/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: currentRefreshToken }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (transportError) {
      reportBackendOutcome({ kind: 'failure', error: transportError });
      throw transportError;
    }

    // A refresh is a plain reachability sample like any other request: a 401 or
    // 403 means the SERVER answered and rejected the token, which is a healthy
    // backend telling us something true. Only a 5xx says the backend is broken.
    reportBackendOutcome(response.status >= 500 ? { kind: 'failure', status: response.status } : { kind: 'success' });

    if (!isAuthCredentialGenerationCurrent(credentialGeneration)) return { status: 'superseded' };

    if (!response.ok) {
      console.warn(`[Auth] Token refresh failed: HTTP ${response.status}`);
      const refreshError = new Error(`Token refresh failed: HTTP ${response.status}`);
      // A 401/403 is an expired/revoked refresh token — routine, the user just
      // signs in again. A 5xx means our refresh endpoint is broken for everyone,
      // which we do want to see.
      if (response.status >= 500) {
        reportError(refreshError, {
          tags: { source: 'auth-refresh' },
          extra: { status: response.status },
        });
      } else if (response.status !== 401 && response.status !== 403) {
        // Other unavailable responses (for example 429) are handled as degradation,
        // not logout. Report their original status once here; AuthProvider must
        // not emit a second generic "refresh unavailable" exception.
        reportHandledError(refreshError, {
          ...(response.status === 429 ? { level: 'warning' as const } : {}),
          tags: { source: 'auth-refresh' },
          extra: { status: response.status },
        });
      }
      return response.status === 401 || response.status === 403
        ? { status: 'rejected', generation: credentialGeneration }
        : { status: 'unavailable', generation: credentialGeneration, error: refreshError };
    }

    const data = (await response.json()) as { jwt: string; refreshToken: string; expiresAt: string };
    const stored = await storeTokensForGeneration(credentialGeneration, data.jwt, data.refreshToken, data.expiresAt);
    return stored ? { status: 'refreshed', generation: credentialGeneration } : { status: 'superseded' };
  } catch (error) {
    if (!isAuthCredentialGenerationCurrent(credentialGeneration)) return { status: 'superseded' };
    console.warn('[Auth] Token refresh error:', error instanceof Error ? error.message : 'unknown');
    // Offline/aborted refreshes downgrade to a warning; a real throw reports.
    reportHandledError(error, { tags: { source: 'auth-refresh' } });
    return { status: 'unavailable', generation: credentialGeneration, error };
  }
}

// Exported so the GraphQL-WS client can force a refresh on a 4401 close, the
// realtime mirror of the HTTP 401 branch below. Both go through the same
// in-flight promise, so a simultaneous HTTP 401 and WS 4401 hit the refresh
// endpoint exactly once.
export function deduplicatedRefresh(): Promise<AuthRefreshResult> {
  const generation = captureAuthCredentialGeneration();
  if (refresh?.generation === generation) return refresh.promise;

  const promise = refreshTokens(generation).finally(() => {
    if (refresh?.promise === promise) refresh = null;
  });
  refresh = { generation, promise };
  return promise;
}

export async function ensureFreshToken(): Promise<boolean> {
  // Degraded, but still signed in (issue #4862). With the backend unreachable —
  // or the climber in offline mode — a PROACTIVE refresh can only hang or fail,
  // and its `false` would make every caller treat a perfectly good local session
  // as gone: an outage would sign people out of their own app. Nothing is lost
  // by waiting, because the reactive 401 path below still refreshes the instant
  // the server answers again, and the refresh fetch itself is deliberately NOT
  // gated — it is one of the requests that discovers the recovery.
  if (getConnectivitySnapshot().effectiveOffline) return true;

  const expiring = await isTokenExpiringSoon();
  if (!expiring) return true;
  return (await deduplicatedRefresh()).status === 'refreshed';
}

let forcedSignOut: { generation: number; promise: Promise<void> } | null = null;

// Collapse forced sign-out only within one credential generation. A later login
// must never join an old cleanup promise or receive its provider callback.
function forceSignOut(generation: number): Promise<void> {
  if (!isAuthCredentialGenerationCurrent(generation)) return Promise.resolve();
  if (forcedSignOut?.generation === generation) return forcedSignOut.promise;

  // Capture the hook now. If the provider unmounts during credential cleanup its
  // effect nulls the module ref, but the
  // cleanup it registered must still run (dispose the WS, reset the http
  // client, clear caches) or the forced sign-out silently drops — the exact
  // failure this path exists to prevent.
  const notifyProvider = onForcedSignOut;
  const promise = (async () => {
    try {
      const performed = await signOutForGeneration(generation);
      if (performed && isAuthCredentialGenerationCurrent(generation + 1)) notifyProvider?.();
    } catch (error) {
      // Cleanup failures happen after this generation was synchronously
      // invalidated, so provider isolation is still required before rethrowing.
      if (isAuthCredentialGenerationCurrent(generation + 1)) notifyProvider?.();
      throw error;
    }
  })().finally(() => {
    if (forcedSignOut?.promise === promise) forcedSignOut = null;
  });
  forcedSignOut = { generation, promise };
  return promise;
}

/** Recover a server-rejected credential or finish the forced sign-out path. */
export async function recoverAuthRejection(): Promise<AuthRejectionResult> {
  const refreshResult = await deduplicatedRefresh();
  if (refreshResult.status === 'rejected') await forceSignOut(refreshResult.generation);
  return refreshResult.status;
}

export async function authenticatedFetch(url: string | URL | Request, options: RequestInit = {}): Promise<Response> {
  const requestGeneration = captureAuthCredentialGeneration();
  await ensureFreshToken();
  if (!isAuthCredentialGenerationCurrent(requestGeneration)) {
    throw new Error('Authentication session changed before the request could be sent');
  }

  const token = await getAuthToken();
  if (!isAuthCredentialGenerationCurrent(requestGeneration)) {
    throw new Error('Authentication session changed before the request could be sent');
  }
  const headers = new Headers(options.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(url, { ...options, headers });
  if (!isAuthCredentialGenerationCurrent(requestGeneration)) return response;

  // On 401, force a refresh regardless of token expiry (server may have
  // revoked the token) and retry once with the new credentials.
  if (response.status === 401 && token) {
    const refreshResult = await deduplicatedRefresh();
    if (refreshResult.status === 'superseded' || !isAuthCredentialGenerationCurrent(requestGeneration)) {
      return response;
    }
    if (
      refreshResult.status === 'refreshed' &&
      refreshResult.generation === requestGeneration &&
      isAuthCredentialGenerationCurrent(requestGeneration)
    ) {
      const newToken = await getAuthToken();
      if (!isAuthCredentialGenerationCurrent(requestGeneration)) return response;
      if (newToken) {
        headers.set('Authorization', `Bearer ${newToken}`);
        return fetch(url, { ...options, headers });
      }
    }
    // signOut() only revokes + clears tokens. forceSignOut also tells the provider
    // to run the rest of the cleanup so the UI leaves the authenticated screens
    // immediately, instead of waiting for the next background→foreground checkAuth.
    if (refreshResult.status === 'rejected') {
      await forceSignOut(refreshResult.generation);
      return response;
    }
  }

  return response;
}
