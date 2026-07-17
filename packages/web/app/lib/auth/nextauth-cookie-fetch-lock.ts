'use client';

import { getSession } from 'next-auth/react';

export const NEXTAUTH_COOKIE_LOCK_NAME = 'boardsesh-nextauth-cookie-v1';

const LOCK_INSTALLATION_KEY = Symbol.for('boardsesh.nextauth-cookie-fetch-lock.state-v1');
const NEXTAUTH_SESSION_PATH = '/api/auth/session';
const NEXTAUTH_CSRF_PATH = '/api/auth/csrf';
const NEXTAUTH_SIGNOUT_PATH = '/api/auth/signout';
const NEXTAUTH_CALLBACK_PATH_PREFIX = '/api/auth/callback/';
const NEXTAUTH_SIGNIN_PATH_PREFIX = '/api/auth/signin/';
const EXPO_AUTH_CHANNEL_NAME = 'boardsesh-expo-web-auth-v1';
const AUTH_COOKIE_OPERATION_TIMEOUT_MS = 15_000;

export type NextAuthSessionIdentity = {
  userId: string;
  authSessionId: string;
};

export type GuardedNextAuthSignOutResult = {
  status: 'signed-out' | 'identity-changed';
  url: string;
};

type GuardedNextAuthSignOutOptions = {
  callbackUrl?: string;
  redirect?: boolean;
};

type FetchLockState = {
  originalFetch: typeof fetch;
  lockedFetch: typeof fetch;
  fallbackQueue: Promise<void>;
};

type FetchLockGlobal = typeof globalThis & {
  [key: symbol]: FetchLockState | undefined;
};

function getLockManager(): LockManager | null {
  try {
    return typeof navigator === 'undefined' ? null : navigator.locks;
  } catch {
    return null;
  }
}

function getRequestUrl(input: RequestInfo | URL): URL | null {
  try {
    const requestTarget = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(requestTarget, window.location.href);
  } catch {
    return null;
  }
}

function getRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input !== 'string' && 'method' in input && typeof input.method === 'string') {
    return input.method.toUpperCase();
  }
  return 'GET';
}

function getRequestSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | undefined {
  if (init?.signal !== undefined) return init.signal ?? undefined;
  return typeof input !== 'string' && 'signal' in input ? input.signal : undefined;
}

function isNextAuthCookieRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const requestUrl = getRequestUrl(input);
  if (!requestUrl || requestUrl.origin !== window.location.origin) return false;

  const pathname = requestUrl.pathname.endsWith('/') ? requestUrl.pathname.slice(0, -1) : requestUrl.pathname;
  if (pathname === NEXTAUTH_SESSION_PATH || pathname === NEXTAUTH_CSRF_PATH) return true;

  const method = getRequestMethod(input, init);
  const isMutation = method !== 'GET' && method !== 'HEAD';
  return (
    isMutation &&
    (pathname === NEXTAUTH_SIGNOUT_PATH ||
      pathname.startsWith(NEXTAUTH_CALLBACK_PATH_PREFIX) ||
      pathname.startsWith(NEXTAUTH_SIGNIN_PATH_PREFIX))
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('NextAuth cookie lock wait aborted');
}

function createBoundedAuthSignal(sourceSignal?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abortFromSource = () => controller.abort(sourceSignal?.reason);
  if (sourceSignal?.aborted) abortFromSource();
  else sourceSignal?.addEventListener('abort', abortFromSource, { once: true });

  const timeout = setTimeout(
    () => controller.abort(new Error('NextAuth cookie operation timed out')),
    AUTH_COOKIE_OPERATION_TIMEOUT_MS,
  );
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      sourceSignal?.removeEventListener('abort', abortFromSource);
    },
  };
}

function enqueueFallback<Result>(
  operation: () => Promise<Result>,
  state: FetchLockState,
  signal?: AbortSignal,
): Promise<Result> {
  const guardedOperation = () => {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return operation();
  };
  const queuedResult = state.fallbackQueue.then(guardedOperation, guardedOperation);
  state.fallbackQueue = queuedResult.then(
    () => undefined,
    () => undefined,
  );
  if (!signal) return queuedResult;

  return new Promise<Result>((resolve, reject) => {
    const rejectFromAbort = () => reject(abortReason(signal));
    if (signal.aborted) {
      rejectFromAbort();
      return;
    }
    signal.addEventListener('abort', rejectFromAbort, { once: true });
    void queuedResult.then(
      (result) => {
        signal.removeEventListener('abort', rejectFromAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', rejectFromAbort);
        reject(error);
      },
    );
  });
}

function runWithCookieLock<Result>(
  operation: (originalFetch: typeof fetch) => Promise<Result>,
  state: FetchLockState,
  signal?: AbortSignal,
): Promise<Result> {
  const guardedOperation = () => operation(state.originalFetch);
  const lockManager = getLockManager();
  if (lockManager) {
    return lockManager.request(
      NEXTAUTH_COOKIE_LOCK_NAME,
      { mode: 'exclusive', ...(signal ? { signal } : {}) },
      guardedOperation,
    );
  }
  return enqueueFallback(guardedOperation, state, signal);
}

function isSessionIdentity(candidate: unknown): candidate is { user: { id: string }; authSessionId: string } {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false;
  const session = candidate as Record<string, unknown>;
  if (typeof session.authSessionId !== 'string' || !session.authSessionId.trim()) return false;
  if (typeof session.user !== 'object' || session.user === null || Array.isArray(session.user)) return false;
  const user = session.user as Record<string, unknown>;
  return typeof user.id === 'string' && Boolean(user.id.trim());
}

function isAnonymousSession(candidate: unknown): boolean {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    !Array.isArray(candidate) &&
    Object.keys(candidate as Record<string, unknown>).length === 0
  );
}

function readCsrfToken(candidate: unknown): string | null {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return null;
  const csrfToken = (candidate as Record<string, unknown>).csrfToken;
  return typeof csrfToken === 'string' && csrfToken ? csrfToken : null;
}

function readValidatedSignOutUrl(candidate: unknown, callbackUrl: string): string | null {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return null;
  const responseUrl = (candidate as Record<string, unknown>).url;
  if (typeof responseUrl !== 'string' || !responseUrl) return null;

  try {
    const parsingBaseUrl = window.location.origin;
    const returnedUrl = new URL(responseUrl, parsingBaseUrl);
    const expectedUrl = new URL(callbackUrl, parsingBaseUrl);
    return returnedUrl.origin === expectedUrl.origin && returnedUrl.pathname === expectedUrl.pathname
      ? responseUrl
      : null;
  } catch {
    return null;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function broadcastExpoAuthChange(
  reason:
    | { type: 'credential-rotation' }
    | { type: 'signout-started'; identity: NextAuthSessionIdentity }
    | { type: 'confirmed-signout'; identity: NextAuthSessionIdentity },
): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(EXPO_AUTH_CHANNEL_NAME);
    channel.postMessage({
      type: 'auth-token-cleared',
      sourceId: 'nextauth-web',
      ...(reason.type === 'confirmed-signout' || reason.type === 'signout-started'
        ? { reason: reason.type, identity: reason.identity }
        : { reason: reason.type }),
    });
    channel.close();
  } catch {
    // Cross-tab refresh is best effort; the initiating tab still redirects.
  }
}

function redirectTo(url: string): void {
  window.location.href = url;
  if (url.includes('#')) window.location.reload();
}

/**
 * Install one browser-realm fetch boundary around NextAuth cookie reads and
 * writes. Expo web uses the same Web Lock name, closing cross-app response-order
 * races; the local queue preserves request order in browsers without Web Locks.
 *
 * NextAuth reads CSRF and performs callback/sign-out as separate requests. Each
 * fetch is serialized here, but the pair is not one atomic lock transaction;
 * project-owned sign-out callers use `guardedNextAuthSignOut` below to bind the
 * full sequence to the identity displayed in the initiating tab.
 * A provider OAuth callback returns through top-level navigation, not fetch, and
 * remains outside this Phase 0 boundary. Expo web OAuth is currently disabled.
 */
export function installNextAuthCookieFetchLock(): void {
  if (typeof window === 'undefined' || typeof globalThis.fetch !== 'function') return;

  const lockGlobal = globalThis as FetchLockGlobal;
  // Keep the record outside the wrapped function. HMR can reevaluate this module,
  // and observability tools can wrap fetch after installation; wrapping that new
  // outer function again would recurse into the existing non-reentrant lock.
  if (lockGlobal[LOCK_INSTALLATION_KEY]) return;

  const state: FetchLockState = {
    originalFetch: globalThis.fetch,
    lockedFetch: globalThis.fetch,
    fallbackQueue: Promise.resolve(),
  };
  const lockedFetch: typeof fetch = (input, init) => {
    const performUnboundedFetch = () => state.originalFetch.call(globalThis, input, init);
    if (!isNextAuthCookieRequest(input, init)) return performUnboundedFetch();

    const sourceSignal = getRequestSignal(input, init);
    const boundedSignal = createBoundedAuthSignal(sourceSignal);
    const performFetch = () =>
      state.originalFetch.call(globalThis, input, {
        ...init,
        signal: boundedSignal.signal,
      });
    return runWithCookieLock(() => performFetch(), state, boundedSignal.signal).finally(boundedSignal.dispose);
  };

  state.lockedFetch = lockedFetch;
  lockGlobal[LOCK_INSTALLATION_KEY] = state;
  globalThis.fetch = lockedFetch;
}

/**
 * Sign out the exact NextAuth login rendered by the initiating tab. The entire
 * read/CSRF/delete sequence owns the shared cookie lock, and its internal
 * requests bypass the installed fetch wrapper to avoid a non-reentrant lock.
 */
export async function guardedNextAuthSignOut(
  identity: NextAuthSessionIdentity,
  options: GuardedNextAuthSignOutOptions = {},
): Promise<GuardedNextAuthSignOutResult> {
  if (!identity.userId.trim() || !identity.authSessionId.trim()) {
    throw new Error('Cannot sign out without a complete session identity');
  }

  installNextAuthCookieFetchLock();
  const lockGlobal = globalThis as FetchLockGlobal;
  const state = lockGlobal[LOCK_INSTALLATION_KEY];
  if (!state) throw new Error('NextAuth cookie lock is unavailable');

  const callbackUrl = options.callbackUrl ?? window.location.href;
  const boundedSignal = createBoundedAuthSignal();
  let signOutStarted = false;
  let result: GuardedNextAuthSignOutResult;
  try {
    result = await runWithCookieLock(
      async (originalFetch) => {
        const sessionResponse = await originalFetch.call(globalThis, NEXTAUTH_SESSION_PATH, {
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          signal: boundedSignal.signal,
        });
        if (!sessionResponse.ok) throw new Error('Unable to verify the session before signing out');
        const currentSession = await readJson(sessionResponse);
        if (isAnonymousSession(currentSession)) {
          return { status: 'signed-out' as const, url: callbackUrl };
        }
        if (!isSessionIdentity(currentSession)) {
          throw new Error('Unable to verify the session before signing out');
        }
        if (currentSession.user.id !== identity.userId || currentSession.authSessionId !== identity.authSessionId) {
          return { status: 'identity-changed' as const, url: callbackUrl };
        }

        signOutStarted = true;
        broadcastExpoAuthChange({ type: 'signout-started', identity });
        const csrfResponse = await originalFetch.call(globalThis, NEXTAUTH_CSRF_PATH, {
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          signal: boundedSignal.signal,
        });
        const csrfToken = readCsrfToken(await readJson(csrfResponse));
        if (!csrfResponse.ok || !csrfToken) throw new Error('Unable to prepare sign out');

        const signOutResponse = await originalFetch.call(globalThis, NEXTAUTH_SIGNOUT_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            csrfToken,
            callbackUrl,
            json: 'true',
            expectedUserId: identity.userId,
            expectedAuthSessionId: identity.authSessionId,
          }),
          signal: boundedSignal.signal,
        });
        const signOutBody = await readJson(signOutResponse);
        if (signOutResponse.status === 409) {
          return { status: 'identity-changed' as const, url: callbackUrl };
        }
        if (!signOutResponse.ok) throw new Error('Unable to sign out');
        const validatedSignOutUrl = readValidatedSignOutUrl(signOutBody, callbackUrl);
        if (!validatedSignOutUrl) throw new Error('Unable to confirm sign out');
        return { status: 'signed-out' as const, url: validatedSignOutUrl };
      },
      state,
      boundedSignal.signal,
    );
  } catch (error) {
    if (signOutStarted) {
      broadcastExpoAuthChange({ type: 'credential-rotation' });
      await getSession();
    }
    throw error;
  } finally {
    boundedSignal.dispose();
  }

  if (result.status === 'signed-out') {
    broadcastExpoAuthChange({ type: 'confirmed-signout', identity });
  } else {
    broadcastExpoAuthChange({ type: 'credential-rotation' });
  }
  // BroadcastChannel reaches Expo and the current NextAuth bridge. Always dual
  // publish NextAuth's storage refresh for already-open pre-deploy tabs and
  // browser message loss, after releasing the non-reentrant outer lock.
  await getSession();
  if (options.redirect ?? true) redirectTo(result.url);
  return result;
}
