import { invalidateCredentialSnapshots } from './privacy/privacy-cache';
import { withAuthCookieLock } from './auth-cookie-lock.web';
import { webApiUrl } from './env';
import type { AuthTokenChangeListener, AuthTokenChangeSource } from './auth-token-change-types';
import {
  hasBrowserPageIdentity,
  isBrowserPageRetired,
  observeConfirmedBrowserIdentity,
  reloadRetiredBrowserPage,
  retireBrowserPageForSignOut,
} from './browser-page-retirement.web';

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
  /** When the token ends: only the 15-minute browser token has one (`better-auth`, #7596 B3b). */
  expiresAt?: unknown;
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
/** When `backendToken` ends, in ms; null for the legacy JWE, which has no end the page knows. */
let backendTokenExpiresAt: number | null = null;
let accessTokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let accessTokenRefreshFailures = 0;
let confirmedSessionIdentity: WebAuthIdentity | null | undefined;
let sessionGeneration = 0;
let synchronization: {
  generation: number;
  controller: AbortController;
  promise: Promise<AuthSessionResult>;
} | null = null;
const authTokenChangeListeners = new Set<AuthTokenChangeListener>();
let lastSessionReadAt = Number.NEGATIVE_INFINITY;

const SESSION_SYNCHRONIZATION_TIMEOUT_MS = 15_000;
/** Focus re-reads at most this often; every NextAuth session GET rewrites its cookie today. */
const FOCUS_SESSION_RECHECK_INTERVAL_MS = 30_000;
const MAX_IDENTITY_PAIR_ATTEMPTS = 3;
const AUTH_TOKEN_CHANNEL_NAME = 'boardsesh-expo-web-auth-v1';
const NEXT_AUTH_STORAGE_KEY = 'nextauth.message';

/** Refresh this long before a browser token ends: about 12 minutes into 15 (#7596 B3b). */
const ACCESS_TOKEN_REFRESH_LEAD_MS = 3 * 60_000;
/** Never sooner than this, even for a token capped by a short session. */
const MIN_ACCESS_TOKEN_REFRESH_DELAY_MS = 30_000;
/** Longest wait between refresh attempts while the token endpoint keeps failing. */
const MAX_ACCESS_TOKEN_BACKOFF_MS = 5 * 60_000;

function readTokenExpiry(expiresAt: unknown): number | null {
  if (typeof expiresAt !== 'string') return null;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function clearAccessTokenRefreshTimer(): void {
  if (accessTokenRefreshTimer === null) return;
  clearTimeout(accessTokenRefreshTimer);
  accessTokenRefreshTimer = null;
}

/**
 * The page's backend token, in memory only. A browser access token
 * (`better-auth`) carries its end: the page refreshes it about three minutes
 * before, through the one shared session read, and backs off while that read
 * fails. The legacy JWE has no end and is never refreshed on a timer.
 */
function setBackendToken(token: string | null, expiresAt: number | null = null): void {
  const replaced = token !== backendToken;
  backendToken = token;
  backendTokenExpiresAt = token === null ? null : expiresAt;
  if (replaced || token === null) {
    clearAccessTokenRefreshTimer();
    if (token !== null) accessTokenRefreshFailures = 0;
  }
  if (token !== null && backendTokenExpiresAt !== null && accessTokenRefreshTimer === null)
    scheduleAccessTokenRefresh(
      Math.max(MIN_ACCESS_TOKEN_REFRESH_DELAY_MS, backendTokenExpiresAt - ACCESS_TOKEN_REFRESH_LEAD_MS - Date.now()),
    );
}

function scheduleAccessTokenRefresh(delayMs: number): void {
  clearAccessTokenRefreshTimer();
  const token = backendToken;
  const generation = sessionGeneration;
  accessTokenRefreshTimer = setTimeout(() => {
    accessTokenRefreshTimer = null;
    if (backendToken !== token || generation !== sessionGeneration) return;
    void synchronizeWebSession().then((result) => {
      if (result.status !== 'unavailable' || backendToken !== token || generation !== sessionGeneration) return;
      // The endpoint failed (503, timeout): keep the token while it lasts and try again later.
      accessTokenRefreshFailures += 1;
      scheduleAccessTokenRefresh(
        Math.min(
          MIN_ACCESS_TOKEN_REFRESH_DELAY_MS * 2 ** (accessTokenRefreshFailures - 1),
          MAX_ACCESS_TOKEN_BACKOFF_MS,
        ),
      );
    });
  }, delayMs);
}

/** A browser access token within three minutes of its end. Never true for the legacy JWE. */
function accessTokenNearExpiry(now = Date.now()): boolean {
  return backendTokenExpiresAt !== null && now >= backendTokenExpiresAt - ACCESS_TOKEN_REFRESH_LEAD_MS;
}

/** A browser access token past its end: the backend refuses it, so it is not sent. */
function accessTokenExpired(now = Date.now()): boolean {
  return backendTokenExpiresAt !== null && now >= backendTokenExpiresAt;
}

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
  setBackendToken(null);
  invalidateCredentialSnapshots();
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
        // Another tab durably signed this page's account out.
        retireBrowserPageForSignOut();
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

/**
 * Who the shared cookie belongs to now, read from ws-auth, which never sets a
 * cookie (the NextAuth session GET rewrites it). `undefined` means unknown: an
 * outage is never evidence of a change.
 */
async function readCookieIdentityWithoutCookieWrite(): Promise<
  { identity: WebAuthIdentity | null; accessToken?: { token: string; expiresAt: number } } | undefined
> {
  try {
    const response = await fetch(webApiUrl('/api/internal/ws-auth'), {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    // A 401 (only under `better-auth`, #7596 B3b): the cookie's session ended.
    // That is a change for the full session read to confirm, never a sign-out by itself.
    if (response.status === 401) return { identity: null };
    if (!response.ok) return undefined;
    const payload: unknown = await response.json();
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
    const candidate = payload as WsAuthResponse;
    if (candidate.authenticated === false) return { identity: null };
    if (candidate.authenticated !== true) return undefined;
    const identity = readWebAuthIdentity(candidate);
    if (identity === null) return undefined;
    const expiresAt = readTokenExpiry(candidate.expiresAt);
    return typeof candidate.token === 'string' && candidate.token && expiresAt !== null
      ? { identity, accessToken: { token: candidate.token, expiresAt } }
      : { identity };
  } catch {
    return undefined;
  }
}

/**
 * Ask the provider for a full re-read only when the cookie moved to another
 * login. A browser access token the probe brought for the same login replaces
 * the page's own, so a focus check also refreshes it; the legacy JWE is not
 * taken from a probe.
 */
async function recheckSessionIdentity(): Promise<void> {
  lastSessionReadAt = Date.now();
  const generation = sessionGeneration;
  const observed = await readCookieIdentityWithoutCookieWrite();
  if (observed === undefined || generation !== sessionGeneration) return;
  if (confirmedSessionIdentity !== undefined && sameIdentity(confirmedSessionIdentity, observed.identity)) {
    if (observed.accessToken && backendToken !== null)
      setBackendToken(observed.accessToken.token, observed.accessToken.expiresAt);
    return;
  }
  notifyAuthTokenChange(backendToken, 'hint');
}

function createSessionRecheckListeners(): void {
  if (typeof window === 'undefined') return;
  // app.boardsesh.com and www are different origins, so a login or sign-out on
  // www reaches this page only through these re-reads (visibilitychange is
  // already an AppState re-read in the provider).
  window.addEventListener('focus', () => {
    // A browser access token with under three minutes left is refreshed now, throttle or not.
    if (Date.now() - lastSessionReadAt < FOCUS_SESSION_RECHECK_INTERVAL_MS && !accessTokenNearExpiry()) return;
    void recheckSessionIdentity();
  });
  window.addEventListener('pageshow', (event: PageTransitionEvent) => {
    // Back/forward cache restored this document with its old account tree and
    // memory token. A retired page reloads; a live one re-reads at once.
    if (!event.persisted || !hasBrowserPageIdentity()) return;
    if (isBrowserPageRetired()) {
      reloadRetiredBrowserPage();
      return;
    }
    void recheckSessionIdentity();
  });
}

createSessionRecheckListeners();

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
  // Before any listener runs, so every transport already sees a retired page.
  observeConfirmedBrowserIdentity(identity);
  if (confirmedSessionIdentity === undefined) {
    confirmedSessionIdentity = identity;
    if (identity === null) setBackendToken(null);
    return { generation, changed: false };
  }
  if (sameIdentity(confirmedSessionIdentity, identity)) return { generation, changed: false };

  confirmedSessionIdentity = identity;
  setBackendToken(null);
  sessionGeneration += 1;
  invalidateCredentialSnapshots();
  if (synchronization?.generation === generation) synchronization.generation = sessionGeneration;
  notifyAuthTokenChange(null, 'session');
  return { generation: sessionGeneration, changed: true };
}

function invalidateUnscopedAuthenticatedIdentity(generation: number): number {
  if (confirmedSessionIdentity === undefined && backendToken === null) return generation;
  confirmedSessionIdentity = undefined;
  setBackendToken(null);
  sessionGeneration += 1;
  invalidateCredentialSnapshots();
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

/** Match the native generation subscription using the browser's existing invalidation stream. */
export function subscribeAuthCredentialGenerationChanges(listener: (generation: number) => void): () => void {
  return subscribeAuthTokenChanges(() => listener(sessionGeneration));
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
      // A 401 (only under `better-auth`, #7596 B3b): the session ended between
      // the two reads. Read the session again; it answers who the cookie is now.
      if (tokenResponse.status === 401 && attempt < MAX_IDENTITY_PAIR_ATTEMPTS) continue;
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

      setBackendToken(tokenPayload.token, readTokenExpiry(tokenPayload.expiresAt));
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
  lastSessionReadAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Authentication session synchronization timed out')),
    SESSION_SYNCHRONIZATION_TIMEOUT_MS,
  );
  const read = async (): Promise<AuthSessionResult> => {
    if (!isAuthCredentialGenerationCurrent(generation)) return { status: 'superseded' };
    return fetchWebSession(generation, controller.signal);
  };
  const promise = withAuthCookieLock(read, controller.signal)
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

/** Unknown/retired credentials are never evidence of an anonymous session. */
export function hasConfirmedAnonymousWebSession(): boolean {
  return confirmedSessionIdentity === null;
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
 * The browser counterpart of the native deferred-reconcile retry (#5345). It has
 * nothing to do, and that is a fact about the platform rather than a shortcut.
 *
 * KeychainNamespaceMigration is mounted from the one root layout, so its AppState
 * `active` listener runs in the browser too and calls this. There is no v1 -> v2
 * keychain namespace to reconcile there: `USES_V2_NAMESPACE` is
 * `process.env.EXPO_OS === 'ios'`, so `migrateSecureKeysToV2` returns before it
 * touches SecureStore and `deferredReconcileKeys('auth')` is always empty on web.
 * Web credentials are the HttpOnly NextAuth cookie (see `getAuthToken`), never a
 * SecureStore item, so there is no stale copy for a repair to find either.
 *
 * Resolving rather than throwing like `storeTokens` is deliberate: a throw says
 * "you called something impossible", and a foreground transition asking whether
 * anything is deferred is a perfectly ordinary thing to do. Nothing on web reports
 * a deferral, so nothing here should pretend one is being retried.
 * `keychain-namespace-migration.web.test.ts` holds that pair together.
 */
export function retryDeferredCredentialReconcile(): Promise<void> {
  return Promise.resolve();
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
    identity: { userId: identity.userId, authSessionId: identity.authSessionId },
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
    identity: { userId: departingIdentity.userId, authSessionId: departingIdentity.authSessionId },
  });
}

/**
 * No token, or a browser access token (`better-auth`) within three minutes of
 * its end. The legacy JWE has no end the page knows, so for it this is only
 * "no token", as before.
 */
export async function isTokenExpiringSoon(): Promise<boolean> {
  return backendToken === null || accessTokenNearExpiry();
}

/** Whether the page's token is a browser access token past its end (never the legacy JWE). */
export function isAuthTokenExpired(): boolean {
  return backendToken !== null && accessTokenExpired();
}
