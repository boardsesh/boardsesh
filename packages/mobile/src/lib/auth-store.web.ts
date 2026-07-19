import { withAuthCookieLock } from './auth-cookie-lock.web';
import { webApiUrl } from './env';
import type { AuthTokenChangeListener, AuthTokenChangeSource } from './auth-token-change-types';

export type AuthSessionResult =
  | { status: 'authenticated'; token: string; userId: string; authSessionId: string }
  | { status: 'anonymous' }
  | { status: 'superseded' }
  | {
      status: 'unavailable';
      error: unknown;
      confirmedIdentity?: WebAuthIdentity;
      identityInvalidated?: boolean;
    };

export type WebAuthIdentity = {
  userId: string;
  authSessionId: string;
};

type NextAuthSession = {
  authSessionId?: unknown;
  user?: {
    id?: unknown;
  };
};

type WsAuthResponse = {
  authenticated?: unknown;
  token?: unknown;
  userId?: unknown;
  authSessionId?: unknown;
};

type AuthTokenClearedMessageBase = {
  type: 'auth-token-cleared';
  sourceId: string;
};

type AuthTokenClearedMessage = AuthTokenClearedMessageBase &
  (
    | { reason: 'credential-rotation' }
    | { reason: 'signout-started'; identity: WebAuthIdentity }
    | { reason: 'confirmed-signout'; identity: WebAuthIdentity }
  );

type AuthTokenClearPayload =
  | { reason: 'credential-rotation' }
  | { reason: 'signout-started'; identity: WebAuthIdentity }
  | { reason: 'confirmed-signout'; identity: WebAuthIdentity };

let backendToken: string | null = null;
let confirmedSessionIdentity: WebAuthIdentity | null | undefined;
let sessionGeneration = 0;
let synchronization: {
  generation: number;
  controller: AbortController;
  promise: Promise<AuthSessionResult>;
} | null = null;
const authTokenChangeListeners = new Set<AuthTokenChangeListener>();

const SESSION_SYNCHRONIZATION_TIMEOUT_MS = 15_000;
const MAX_IDENTITY_PAIR_ATTEMPTS = 3;
const AUTH_TOKEN_CHANNEL_NAME = 'boardsesh-expo-web-auth-v1';
const NEXT_AUTH_STORAGE_KEY = 'nextauth.message';

function createAuthSignalSourceId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch {
    // Fall through for restricted browser contexts with a partial crypto API.
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const authSignalSourceId = createAuthSignalSourceId();

function readWebAuthIdentity(identity: unknown): WebAuthIdentity | null {
  if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) return null;
  const candidate = identity as Record<string, unknown>;
  if (typeof candidate.userId !== 'string' || !candidate.userId) return null;
  if (typeof candidate.authSessionId !== 'string' || !candidate.authSessionId) return null;
  return { userId: candidate.userId, authSessionId: candidate.authSessionId };
}

function parseAuthTokenClearedMessage(message: unknown): AuthTokenClearedMessage | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null;
  const candidate = message as Record<string, unknown>;
  if (candidate.type !== 'auth-token-cleared' || typeof candidate.sourceId !== 'string') return null;

  if (candidate.reason === undefined || candidate.reason === 'credential-rotation') {
    return {
      type: 'auth-token-cleared',
      sourceId: candidate.sourceId,
      reason: 'credential-rotation',
    };
  }
  if (candidate.reason !== 'signout-started' && candidate.reason !== 'confirmed-signout') return null;

  const identity = readWebAuthIdentity(candidate.identity);
  if (identity === null) {
    // A brief mixed-version window can deliver the reason before every sender
    // includes its owner. It remains a revalidation-triggering rotation, never
    // an unscoped authoritative logout of whichever account now owns this tab.
    return {
      type: 'auth-token-cleared',
      sourceId: candidate.sourceId,
      reason: 'credential-rotation',
    };
  }
  return {
    type: 'auth-token-cleared',
    sourceId: candidate.sourceId,
    reason: candidate.reason,
    identity,
  };
}

function notifyAuthTokenChange(token: string | null, source: AuthTokenChangeSource): void {
  for (const listener of authTokenChangeListeners) {
    try {
      listener(token, source);
    } catch {
      // Credential invalidation must reach every listener even when one
      // consumer has already torn down or throws during its own cleanup.
    }
  }
}

function clearInMemoryTokens(source: AuthTokenChangeSource): void {
  sessionGeneration += 1;
  backendToken = null;
  synchronization?.controller.abort(new Error('Authentication session cleared'));
  synchronization = null;
  notifyAuthTokenChange(null, source);
}

function createAuthTokenChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;

  try {
    const channel = new BroadcastChannel(AUTH_TOKEN_CHANNEL_NAME);
    channel.addEventListener('message', (event: MessageEvent<unknown>) => {
      try {
        const message = parseAuthTokenClearedMessage(event.data);
        if (message === null || message.sourceId === authSignalSourceId) return;
        // Remote invalidation is intentionally not broadcast again. Every tab
        // receives the original channel message directly, so rebroadcasting here
        // would create a logout loop and duplicate generation/listener updates.
        if (message.reason === 'credential-rotation') {
          clearInMemoryTokens('remote');
          return;
        }

        if (confirmedSessionIdentity !== undefined && !sameIdentity(confirmedSessionIdentity, message.identity)) {
          // The durable sign-out belongs to an older login. Keep the newly
          // confirmed owner usable, but re-read the shared cookie as a guard
          // against unusual delivery ordering between browser primitives.
          notifyAuthTokenChange(backendToken, 'hint');
          return;
        }
        if (message.reason === 'signout-started') {
          // Only the tab that already owns the cookie lock emits this signal.
          // Fence peer requests and queued peer sign-outs; the lock owner does
          // not receive its own BroadcastChannel message and keeps ownership.
          clearInMemoryTokens('remote');
          return;
        }
        clearInMemoryTokens('remote-signout');
      } catch {
        // A malformed or late page-teardown event cannot break auth startup.
      }
    });
    return channel;
  } catch {
    // Some embedded/private browser contexts expose BroadcastChannel but reject
    // construction. The current tab still keeps generation-safe local auth.
    return null;
  }
}

const authTokenChannel = createAuthTokenChannel();

function createNextAuthStorageListener(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener('storage', (event) => {
    if (event.key !== NEXT_AUTH_STORAGE_KEY || typeof event.newValue !== 'string') return;
    try {
      const message: unknown = JSON.parse(event.newValue);
      if (typeof message !== 'object' || message === null || Array.isArray(message)) return;
      const candidate = message as Record<string, unknown>;
      if (candidate.event !== 'session') return;
      if (typeof candidate.data !== 'object' || candidate.data === null || Array.isArray(candidate.data)) return;
      // NextAuth's storage payload is only a hint. Never adopt identity or token
      // data from it or treat an identity-less sign-out as authoritative. Every
      // trigger first re-reads the HttpOnly cookie, and that response rotates or
      // clears credentials only when it proves the login scope changed.
      notifyAuthTokenChange(backendToken, 'hint');
    } catch {
      // Ignore malformed third-party/local storage events.
    }
  });
}

createNextAuthStorageListener();

function unavailable(
  error: unknown,
  confirmedIdentity?: WebAuthIdentity,
  identityInvalidated?: boolean,
): AuthSessionResult {
  return {
    status: 'unavailable',
    error,
    ...(confirmedIdentity ? { confirmedIdentity } : {}),
    ...(identityInvalidated ? { identityInvalidated: true } : {}),
  };
}

function sameIdentity(left: WebAuthIdentity | null, right: WebAuthIdentity | null): boolean {
  if (left === null || right === null) return left === right;
  return left.userId === right.userId && left.authSessionId === right.authSessionId;
}

function rotateForConfirmedIdentity(
  identity: WebAuthIdentity | null,
  generation: number,
): { generation: number; changed: boolean } {
  if (confirmedSessionIdentity === undefined) {
    confirmedSessionIdentity = identity;
    if (identity === null) backendToken = null;
    return { generation, changed: false };
  }
  if (sameIdentity(confirmedSessionIdentity, identity)) return { generation, changed: false };

  confirmedSessionIdentity = identity;
  backendToken = null;
  sessionGeneration += 1;
  if (synchronization?.generation === generation) synchronization.generation = sessionGeneration;
  notifyAuthTokenChange(null, 'session');
  return { generation: sessionGeneration, changed: true };
}

function invalidateUnscopedAuthenticatedIdentity(generation: number): number {
  if (confirmedSessionIdentity === undefined && backendToken === null) return generation;
  confirmedSessionIdentity = undefined;
  backendToken = null;
  sessionGeneration += 1;
  if (synchronization?.generation === generation) synchronization.generation = sessionGeneration;
  notifyAuthTokenChange(null, 'session');
  return sessionGeneration;
}

async function readJsonObject(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const responseBody: unknown = await Promise.race([response.json(), aborted(signal)]);
  if (typeof responseBody !== 'object' || responseBody === null || Array.isArray(responseBody)) {
    throw new Error('Authentication endpoint returned an invalid response');
  }
  return responseBody as Record<string, unknown>;
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const rejectFromSignal = () => reject(signal.reason ?? new Error('Authentication session synchronization aborted'));
    if (signal.aborted) {
      rejectFromSignal();
      return;
    }
    signal.addEventListener('abort', rejectFromSignal, { once: true });
  });
}

async function fetchWithAbort(input: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  // `fetch` should reject when its signal aborts, but racing it explicitly keeps
  // this boundary bounded under incomplete browser polyfills and test doubles.
  return Promise.race([fetch(input, { ...init, signal }), aborted(signal)]);
}

export function captureAuthCredentialGeneration(): number {
  return sessionGeneration;
}

export function captureConfirmedWebAuthIdentity(): WebAuthIdentity | null {
  if (confirmedSessionIdentity === undefined || confirmedSessionIdentity === null) return null;
  return { ...confirmedSessionIdentity };
}

export function isAuthCredentialGenerationCurrent(generation: number): boolean {
  return generation === sessionGeneration;
}

async function fetchWebSession(generation: number, signal: AbortSignal): Promise<AuthSessionResult> {
  let activeGeneration = generation;
  let lastConfirmedIdentity: WebAuthIdentity | undefined;
  let identityChangedDuringSynchronization = false;
  try {
    for (let attempt = 1; attempt <= MAX_IDENTITY_PAIR_ATTEMPTS; attempt += 1) {
      // Reading the NextAuth session first validates and rotates its HttpOnly
      // cookie, which remains inaccessible to Expo JavaScript. The ws-auth call
      // below returns both that request's decoded identity and its raw backend
      // JWE, so a cookie switch between the two requests can be detected.
      const sessionResponse = await fetchWithAbort(
        webApiUrl('/api/auth/session'),
        {
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        },
        signal,
      );
      if (!isAuthCredentialGenerationCurrent(activeGeneration)) return { status: 'superseded' };
      if (!sessionResponse.ok) {
        return unavailable(
          new Error(`Session endpoint failed: HTTP ${sessionResponse.status}`),
          lastConfirmedIdentity,
          identityChangedDuringSynchronization,
        );
      }

      const session = (await readJsonObject(sessionResponse, signal)) as NextAuthSession;
      if (!isAuthCredentialGenerationCurrent(activeGeneration)) return { status: 'superseded' };
      if (!session.user) {
        const confirmedAnonymous = rotateForConfirmedIdentity(null, activeGeneration);
        activeGeneration = confirmedAnonymous.generation;
        return { status: 'anonymous' };
      }
      if (typeof session.user.id !== 'string' || !session.user.id) {
        activeGeneration = invalidateUnscopedAuthenticatedIdentity(activeGeneration);
        return unavailable(new Error('Authenticated session returned no user identity'), undefined, true);
      }
      if (typeof session.authSessionId !== 'string' || !session.authSessionId) {
        activeGeneration = invalidateUnscopedAuthenticatedIdentity(activeGeneration);
        return unavailable(new Error('Authenticated session returned no login identity'), undefined, true);
      }
      const resolvedIdentity = { userId: session.user.id, authSessionId: session.authSessionId };
      lastConfirmedIdentity = resolvedIdentity;
      const confirmedIdentity = rotateForConfirmedIdentity(resolvedIdentity, activeGeneration);
      activeGeneration = confirmedIdentity.generation;
      identityChangedDuringSynchronization ||= confirmedIdentity.changed;

      const tokenResponse = await fetchWithAbort(
        webApiUrl('/api/internal/ws-auth'),
        {
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        },
        signal,
      );
      if (!isAuthCredentialGenerationCurrent(activeGeneration)) return { status: 'superseded' };
      if (!tokenResponse.ok) {
        return unavailable(
          new Error(`WebSocket auth endpoint failed: HTTP ${tokenResponse.status}`),
          resolvedIdentity,
          identityChangedDuringSynchronization,
        );
      }

      const tokenPayload = (await readJsonObject(tokenResponse, signal)) as WsAuthResponse;
      if (!isAuthCredentialGenerationCurrent(activeGeneration)) return { status: 'superseded' };
      if (tokenPayload.authenticated === false) {
        const confirmedAnonymous = rotateForConfirmedIdentity(null, activeGeneration);
        activeGeneration = confirmedAnonymous.generation;
        return { status: 'anonymous' };
      }
      if (tokenPayload.authenticated !== true || typeof tokenPayload.token !== 'string' || !tokenPayload.token) {
        // The session endpoint just confirmed an authenticated cookie. Treat a
        // missing bridge token as transient instead of signing the user out.
        return unavailable(
          new Error('Authenticated session returned no backend token'),
          resolvedIdentity,
          identityChangedDuringSynchronization,
        );
      }
      if (
        typeof tokenPayload.userId !== 'string' ||
        !tokenPayload.userId ||
        typeof tokenPayload.authSessionId !== 'string' ||
        !tokenPayload.authSessionId
      ) {
        return unavailable(
          new Error('Authenticated backend token returned no login identity'),
          resolvedIdentity,
          identityChangedDuringSynchronization,
        );
      }

      const tokenIdentity = { userId: tokenPayload.userId, authSessionId: tokenPayload.authSessionId };
      if (!sameIdentity(resolvedIdentity, tokenIdentity)) {
        // Never cache a token paired with another login. Its decoded identity is
        // still authoritative for the later cookie request, so rotate away from
        // the stale session result before retrying the pair from the beginning.
        lastConfirmedIdentity = tokenIdentity;
        const confirmedTokenIdentity = rotateForConfirmedIdentity(tokenIdentity, activeGeneration);
        activeGeneration = confirmedTokenIdentity.generation;
        identityChangedDuringSynchronization = true;
        if (attempt < MAX_IDENTITY_PAIR_ATTEMPTS) continue;
        return unavailable(
          new Error('Authentication identity kept changing during synchronization'),
          tokenIdentity,
          true,
        );
      }

      backendToken = tokenPayload.token;
      return { status: 'authenticated', token: tokenPayload.token, ...resolvedIdentity };
    }

    return unavailable(
      new Error('Authentication identity could not be synchronized'),
      lastConfirmedIdentity,
      identityChangedDuringSynchronization,
    );
  } catch (error) {
    // A newer logout/login generation owns the current state. Returning a
    // distinct result prevents this stale request from signing out that session.
    if (!isAuthCredentialGenerationCurrent(activeGeneration)) return { status: 'superseded' };
    return unavailable(error, lastConfirmedIdentity, identityChangedDuringSynchronization);
  }
}

/**
 * Revalidate the browser session. Concurrent HTTP 401s and WebSocket 4401s
 * share one request pair so they cannot create a refresh/reconnect storm.
 */
export function synchronizeWebSession(): Promise<AuthSessionResult> {
  if (synchronization?.generation === sessionGeneration) return synchronization.promise;

  const generation = sessionGeneration;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Authentication session synchronization timed out')),
    SESSION_SYNCHRONIZATION_TIMEOUT_MS,
  );
  const promise = withAuthCookieLock(async (): Promise<AuthSessionResult> => {
    if (!isAuthCredentialGenerationCurrent(generation)) return { status: 'superseded' };
    return fetchWebSession(generation, controller.signal);
  }, controller.signal)
    .catch((error: unknown): AuthSessionResult => {
      if (!isAuthCredentialGenerationCurrent(generation)) return { status: 'superseded' };
      return unavailable(error);
    })
    .finally(() => {
      clearTimeout(timeout);
      if (synchronization?.promise === promise) synchronization = null;
    });
  synchronization = { generation, controller, promise };
  return promise;
}

/** The backend JWE is intentionally process-memory only. */
export async function getAuthToken(): Promise<string | null> {
  return backendToken;
}

export async function getRefreshToken(): Promise<null> {
  return null;
}

export async function getTokenExpiresAt(): Promise<null> {
  return null;
}

export async function storeTokens(_jwt: string, _refreshToken: string, _expiresAt: string): Promise<never> {
  throw new Error('Expo web authentication is managed by an HttpOnly NextAuth session');
}

/**
 * Observe in-memory browser credential invalidation. The source lets the auth
 * provider distinguish another tab's logout from local generation rotation
 * during sign-in, whose cleanup is already owned by the local caller.
 */
export function subscribeAuthTokenChanges(listener: AuthTokenChangeListener): () => void {
  authTokenChangeListeners.add(listener);
  return () => authTokenChangeListeners.delete(listener);
}

function broadcastAuthTokenClear(payload: AuthTokenClearPayload): void {
  try {
    authTokenChannel?.postMessage({
      type: 'auth-token-cleared',
      sourceId: authSignalSourceId,
      ...payload,
    } satisfies AuthTokenClearedMessage);
  } catch {
    // BroadcastChannel is best-effort. Local logout and generation invalidation
    // must still complete if a browser closes the channel during page teardown.
  }
}

export async function clearTokens(): Promise<void> {
  clearInMemoryTokens('local');
  broadcastCredentialRotation();
}

/** Prompt peer tabs to re-read the cookie without changing this tab's generation. */
export function broadcastCredentialRotation(): void {
  broadcastAuthTokenClear({ reason: 'credential-rotation' });
}

/**
 * Stop this tab from using its JWE while a locked sign-out is in flight. Peer
 * tabs are notified only after this caller owns the cookie lock and verifies
 * the departing identity; an unscoped rotation here lets peer sign-outs cancel
 * one another before either caller owns durable revocation.
 */
export async function isolateTokensForSignOut(): Promise<void> {
  clearInMemoryTokens('local');
}

/** Prompt same-login peers to stop using their JWE while logout holds the cookie lock. */
export function broadcastSignOutStarted(identity: WebAuthIdentity): void {
  broadcastAuthTokenClear({
    reason: 'signout-started',
    identity: { ...identity },
  });
}

/** Tell peer tabs that the shared HttpOnly session was durably deleted. */
export function broadcastConfirmedSignOut(
  departingIdentity: WebAuthIdentity | null = captureConfirmedWebAuthIdentity(),
): void {
  if (departingIdentity === null) {
    broadcastAuthTokenClear({ reason: 'credential-rotation' });
    return;
  }
  broadcastAuthTokenClear({
    reason: 'confirmed-signout',
    identity: { ...departingIdentity },
  });
}

export async function isTokenExpiringSoon(): Promise<boolean> {
  return backendToken === null;
}
