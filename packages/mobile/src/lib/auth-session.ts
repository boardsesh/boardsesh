import { deduplicatedRefresh } from './auth-interceptor';
import { BackendUnavailableError } from './connectivity/backend-unavailable-error';
import { getConnectivitySnapshot } from './connectivity/connectivity-store';
import { reportHandledError } from './error-reporting';
import {
  captureAuthCredentialGeneration,
  getAuthToken,
  isAuthCredentialGenerationCurrent,
  isTokenExpiringSoon,
} from './auth-store';
import type { UserStorageOwner } from './user-storage-owner';

export type AuthSessionDegradation = {
  stage: 'expiry-read' | 'refresh-unavailable' | 'refreshed-token-read';
  error: unknown;
};

export type AuthSessionResult =
  | {
      status: 'authenticated';
      token: string;
      generation: number;
      degraded?: AuthSessionDegradation;
      userId?: string;
      authSessionId?: string;
    }
  | { status: 'anonymous'; generation: number }
  | { status: 'superseded' }
  | {
      status: 'unavailable';
      stage: 'token-read';
      error: unknown;
      generation: number;
      confirmedIdentity?: UserStorageOwner;
      identityInvalidated?: boolean;
    };

function authenticatedSession(token: string, generation: number, degraded?: AuthSessionDegradation): AuthSessionResult {
  if (!isAuthCredentialGenerationCurrent(generation)) return { status: 'superseded' };
  return {
    status: 'authenticated',
    token,
    generation,
    ...(degraded ? { degraded } : {}),
  };
}

/** Resolve the native mobile JWT session, refreshing it when necessary. */
export async function resolveAuthSession(): Promise<AuthSessionResult> {
  const credentialGeneration = captureAuthCredentialGeneration();
  let currentToken: string | null;

  try {
    currentToken = await getAuthToken();
  } catch (error) {
    return isAuthCredentialGenerationCurrent(credentialGeneration)
      ? { status: 'unavailable', stage: 'token-read', error, generation: credentialGeneration }
      : { status: 'superseded' };
  }

  if (!isAuthCredentialGenerationCurrent(credentialGeneration)) return { status: 'superseded' };
  if (!currentToken) return { status: 'anonymous', generation: credentialGeneration };

  let tokenExpiringSoon: boolean;
  try {
    tokenExpiringSoon = await isTokenExpiringSoon();
  } catch (error) {
    return authenticatedSession(currentToken, credentialGeneration, { stage: 'expiry-read', error });
  }

  if (!isAuthCredentialGenerationCurrent(credentialGeneration)) return { status: 'superseded' };
  if (!tokenExpiringSoon) return authenticatedSession(currentToken, credentialGeneration);

  // The token is expiring AND we already know nothing can reach the server
  // (issue #4862). Refreshing would hang or fail, and `unavailable` is exactly
  // what that failure would resolve to — so take the same outcome without
  // spending the round trip, and keep the already-established local session.
  // The climber stays signed in through the outage; the next successful request
  // refreshes for real.
  const connectivity = getConnectivitySnapshot();
  if (connectivity.effectiveOffline) {
    return authenticatedSession(currentToken, credentialGeneration, {
      stage: 'refresh-unavailable',
      error: new BackendUnavailableError(connectivity.reason ?? 'backend_unreachable'),
    });
  }

  let refreshResult: Awaited<ReturnType<typeof deduplicatedRefresh>>;
  try {
    // Refresh via the status-returning path (not the boolean `ensureFreshToken`,
    // which collapses rejected and unavailable into the same `false`). A
    // server-rejected refresh token is a real logout; a transient network or
    // keychain failure preserves the already-established local session.
    refreshResult = await deduplicatedRefresh();
  } catch (error) {
    if (!isAuthCredentialGenerationCurrent(credentialGeneration)) return { status: 'superseded' };
    // The concrete interceptor catches and reports all expected refresh failures.
    // Keep this defensive boundary for an unexpected rejected implementation or
    // test double, and report its original cause exactly once.
    reportHandledError(error, {
      tags: { source: 'auth-session', auth_stage: 'refresh-unavailable' },
    });
    return authenticatedSession(currentToken, credentialGeneration, { stage: 'refresh-unavailable', error });
  }

  if (!isAuthCredentialGenerationCurrent(credentialGeneration) || refreshResult.status === 'superseded') {
    return { status: 'superseded' };
  }
  if (refreshResult.status === 'rejected') return { status: 'anonymous', generation: credentialGeneration };
  if (refreshResult.status === 'unavailable') {
    // `refreshTokens` owns telemetry for this original cause. Carry it to the
    // caller for provenance, but do not report a second generic exception there.
    return authenticatedSession(currentToken, credentialGeneration, {
      stage: 'refresh-unavailable',
      error: refreshResult.error,
    });
  }

  let refreshedToken: string | null;
  try {
    refreshedToken = await getAuthToken();
  } catch (error) {
    return authenticatedSession(currentToken, credentialGeneration, { stage: 'refreshed-token-read', error });
  }

  if (!isAuthCredentialGenerationCurrent(credentialGeneration)) return { status: 'superseded' };
  if (!refreshedToken) {
    return authenticatedSession(currentToken, credentialGeneration, {
      stage: 'refreshed-token-read',
      error: new Error('Refreshed auth token was unavailable from secure storage'),
    });
  }
  return authenticatedSession(refreshedToken, credentialGeneration);
}
