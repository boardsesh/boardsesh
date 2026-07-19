import {
  captureAuthCredentialGeneration,
  getAuthToken,
  isAuthCredentialGenerationCurrent,
  synchronizeWebSession,
} from './auth-store.web';
import { signOutForGeneration } from './auth.web';
import { reportHandledError } from './error-reporting';
import type { AuthRejectionResult } from './auth-rejection-result';

let onForcedSignOut: (() => void) | null = null;
type WebRefreshResult =
  | { status: 'authenticated'; generation: number; userId: string; authSessionId: string }
  | { status: 'anonymous'; generation: number }
  | { status: 'unavailable'; generation: number }
  | { status: 'superseded' };

let refresh: { generation: number; promise: Promise<WebRefreshResult> } | null = null;
let forcedSignOut: { generation: number; promise: Promise<void> } | null = null;

export function setOnForcedSignOut(callback: (() => void) | null): void {
  onForcedSignOut = callback;
}

function forceSignOut(generation: number): Promise<void> {
  if (!isAuthCredentialGenerationCurrent(generation)) return Promise.resolve();
  if (forcedSignOut?.generation === generation) return forcedSignOut.promise;

  const notifyProvider = onForcedSignOut;
  const promise = (async () => {
    try {
      const performed = await signOutForGeneration(generation);
      if (performed && isAuthCredentialGenerationCurrent(generation + 1)) notifyProvider?.();
    } catch (error) {
      // Durable cookie revocation may fail after the memory credential has
      // already been invalidated. Isolate provider state for that same owner,
      // but never let its callback clean up a later login.
      reportHandledError(error);
      if (isAuthCredentialGenerationCurrent(generation + 1)) notifyProvider?.();
    }
  })().finally(() => {
    if (forcedSignOut?.promise === promise) forcedSignOut = null;
  });
  forcedSignOut = { generation, promise };
  return promise;
}

function deduplicatedSessionRefresh(): Promise<WebRefreshResult> {
  const generation = captureAuthCredentialGeneration();
  if (refresh?.generation === generation) return refresh.promise;

  const promise = (async (): Promise<WebRefreshResult> => {
    const session = await synchronizeWebSession();
    if (session.status === 'superseded') {
      return { status: 'superseded' };
    }
    // Confirming A -> anonymous deliberately rotates the store generation before
    // returning. Preserve that authoritative result so forced provider cleanup
    // still runs; authenticated identity changes remain superseded below.
    if (session.status === 'anonymous') {
      return { status: 'anonymous', generation: captureAuthCredentialGeneration() };
    }
    if (!isAuthCredentialGenerationCurrent(generation)) return { status: 'superseded' };
    if (session.status === 'authenticated') {
      return {
        status: 'authenticated',
        generation,
        userId: session.userId,
        authSessionId: session.authSessionId,
      };
    }
    return { status: 'unavailable', generation };
  })().finally(() => {
    if (refresh?.promise === promise) refresh = null;
  });
  refresh = { generation, promise };
  return promise;
}

/**
 * Revalidate an auth rejection against the HttpOnly session. A confirmed
 * anonymous response signs out the provider; an unavailable endpoint leaves
 * the current in-memory session alone so a network outage cannot log users out.
 */
export async function deduplicatedRefresh(): Promise<boolean> {
  const refreshResult = await deduplicatedSessionRefresh();
  if (refreshResult.status === 'anonymous') await forceSignOut(refreshResult.generation);
  return refreshResult.status === 'authenticated';
}

/**
 * Browser refresh already signs out only a confirmed anonymous cookie. A
 * superseded request or unavailable endpoint must leave a newer/current session
 * alone while the rejected WebSocket closes without retrying its stale token.
 */
export async function recoverAuthRejection(): Promise<AuthRejectionResult> {
  const refreshResult = await deduplicatedSessionRefresh();
  if (refreshResult.status === 'anonymous') await forceSignOut(refreshResult.generation);
  return refreshResult.status;
}

export async function ensureFreshToken(): Promise<boolean> {
  const generation = captureAuthCredentialGeneration();
  if (await getAuthToken()) return isAuthCredentialGenerationCurrent(generation);
  if (!isAuthCredentialGenerationCurrent(generation)) return false;
  const session = await synchronizeWebSession();
  return session.status === 'authenticated' && isAuthCredentialGenerationCurrent(generation);
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
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(url, { ...options, headers });
  if (!isAuthCredentialGenerationCurrent(requestGeneration)) return response;
  if (response.status !== 401 || !token) return response;

  const refreshResult = await deduplicatedSessionRefresh();
  if (refreshResult.status === 'anonymous') {
    await forceSignOut(refreshResult.generation);
    return response;
  }
  if (refreshResult.status === 'superseded' || refreshResult.generation !== requestGeneration) {
    return response;
  }

  if (refreshResult.status === 'authenticated') {
    const refreshedToken = await getAuthToken();
    if (!isAuthCredentialGenerationCurrent(requestGeneration)) return response;
    if (refreshedToken) {
      const retryHeaders = new Headers(headers);
      retryHeaders.set('Authorization', `Bearer ${refreshedToken}`);
      const retryResponse = await fetch(url, { ...options, headers: retryHeaders });
      if (retryResponse.status === 401 && isAuthCredentialGenerationCurrent(requestGeneration)) {
        // The cookie and bridge endpoint both said authenticated, but the
        // backend rejected that freshly resolved token too. A 401 can mean the
        // session is dead OR that this request simply lacked permission for the
        // resource — re-confirm the session before signing out, so a
        // permission-401 never logs the user out. Only a confirmed-anonymous
        // cookie triggers sign-out.
        const confirmation = await deduplicatedSessionRefresh();
        if (confirmation.status === 'anonymous') await forceSignOut(confirmation.generation);
      }
      return retryResponse;
    }
  }

  return response;
}
