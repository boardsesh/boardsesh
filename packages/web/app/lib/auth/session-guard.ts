import type { Session } from 'next-auth';
import { EXPECTED_VIEWER_HEADER, isViewerChangedBody } from './expected-viewer';
import { reloadAfterAccountChange } from './reload-after-account-change';

/**
 * The one client guard for www (#7596). The session provider tells it every
 * accepted session read; every user-scoped request goes through `fetch` here.
 * A response that lands after the account changed is never handed to its
 * caller: the caller gets a SessionSupersededError instead. A change made in
 * another tab or app retires the page: caches are cleared and it reloads.
 * Same-origin requests name the account this page shows in
 * `X-Boardsesh-Expected-Viewer`; a 409 `viewer_changed` answer means the cookie
 * names another account, so it is superseded too and the session is re-checked
 * at once. Design: issue #7596.
 */
export const WEB_SESSION_CHECK_EVENT = 'boardsesh-web-session-check';
const GUARD_KEY = Symbol.for('boardsesh.web-session-guard.v1');
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
const REMEMBERED_TOKEN_LIMIT = 32;
// A login whose session has no authSessionId yet. Same placeholder as the Expo auth bridge.
const PENDING_LOGIN_IDENTITY = 'pending-login-identity';
const QUERY_RETRY_LIMIT = 3;

export type SessionViewer = { readonly userId: string; readonly authSessionId: string } | null;

export class SessionSupersededError extends Error {
  constructor() {
    super('The signed-in account changed while this request was in flight');
    this.name = 'SessionSupersededError';
  }
}

export function isSessionSuperseded(error: unknown): error is SessionSupersededError {
  return error instanceof Error && error.name === 'SessionSupersededError';
}

/** React Query retry: a superseded request is tried once more, under the account that replaced it. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return failureCount < (isSessionSuperseded(error) ? 1 : QUERY_RETRY_LIMIT);
}

export function signedInViewer(userId: string, authSessionId?: string | null): NonNullable<SessionViewer> {
  return { userId, authSessionId: authSessionId || PENDING_LOGIN_IDENTITY };
}

export function sessionViewerOf(session: Session | null): SessionViewer {
  return session ? signedInViewer(session.user.id, session.authSessionId) : null;
}

export function sessionViewerKey(viewer: SessionViewer): string {
  return viewer ? `${viewer.userId}:${viewer.authSessionId}` : 'anonymous';
}

/** The headers fetch will send: `init.headers` replaces a Request's own. */
function outgoingHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
}

function bearerToken(input: RequestInfo | URL, init?: RequestInit): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(outgoingHeaders(input, init).get('authorization') ?? '')?.[1];
}

function isSameOrigin(input: RequestInfo | URL, pageOrigin: string | undefined): boolean {
  if (!pageOrigin) return false;
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(target, pageOrigin).origin === pageOrigin;
  } catch {
    return false;
  }
}

function browserPageOrigin(): string | undefined {
  return typeof location === 'undefined' ? undefined : location.origin;
}

/** This tab's own sign-in or sign-out. Cancel it when the flow changed nothing. */
export type LocalChange = {
  /** Keeps the claim open for the refresh read that follows the flow. */
  readonly extend: () => void;
  readonly cancel: () => void;
};

export type SessionGuardDependencies = {
  readonly reloadPage: () => void;
  readonly requestSessionCheck: () => void;
  readonly send?: typeof fetch;
  /** The page's origin; only requests to it carry the expected-viewer header. */
  readonly pageOrigin?: () => string | undefined;
  readonly now?: () => number;
  readonly cleanupTimeoutMs?: number;
  readonly localChangeWindowMs?: number;
  readonly unauthorizedDelayMs?: number;
};

export function createSessionGuard(dependencies: SessionGuardDependencies) {
  const send: typeof fetch = dependencies.send ?? ((input, init) => globalThis.fetch(input, init));
  const now = dependencies.now ?? Date.now;
  const listeners = new Set<() => void>();
  const cleanups = new Set<() => unknown>();
  const tokenOwners = new Map<string, string>();
  // undefined until the first accepted read: nothing is known about the owner.
  let viewer: SessionViewer | undefined;
  let generation = 0;
  let retiring = false;
  // The open claim of this tab's own sign-in or sign-out, if any.
  let localChange: { until: number } | null = null;
  const localChangeWindowMs = dependencies.localChangeWindowMs ?? 20_000;
  let unauthorizedTimer: ReturnType<typeof setTimeout> | undefined;

  const notify = () => {
    for (const listener of listeners) listener();
  };
  const isCurrent = (captured: number) => !retiring && captured === generation;
  const viewerKey = () => (viewer === undefined ? undefined : sessionViewerKey(viewer));
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  async function retire(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, dependencies.cleanupTimeoutMs ?? 2000);
    });
    const cleanupsDone = Promise.all(
      [...cleanups].map((cleanup) =>
        Promise.resolve()
          .then(cleanup)
          .catch(() => {}),
      ),
    );
    await Promise.race([cleanupsDone, timeout]);
    clearTimeout(timer);
    dependencies.reloadPage();
  }

  function noteUnauthorized(): void {
    if (unauthorizedTimer !== undefined) return;
    unauthorizedTimer = setTimeout(() => {
      unauthorizedTimer = undefined;
      dependencies.requestSessionCheck();
    }, dependencies.unauthorizedDelayMs ?? 1000);
  }

  // Only this page's own origin hears who it shows; other origins never get the
  // header (it would also force a CORS preflight). Before the first accepted
  // read the page shows nobody, so it names nobody.
  const pageOrigin = dependencies.pageOrigin ?? browserPageOrigin;
  const withExpectedViewer = (input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined => {
    if (viewer === undefined || !isSameOrigin(input, pageOrigin())) return init;
    const headers = outgoingHeaders(input, init);
    headers.set(EXPECTED_VIEWER_HEADER, sessionViewerKey(viewer));
    return { ...init, headers };
  };

  const guardedFetch: typeof fetch = async (input, init) => {
    if (retiring) throw new SessionSupersededError();
    const token = bearerToken(input, init);
    const tokenOwner = token === undefined ? undefined : tokenOwners.get(token);
    // A closure that kept an earlier account's token fails before anything is sent.
    if (tokenOwner !== undefined && viewer !== undefined && tokenOwner !== sessionViewerKey(viewer))
      throw new SessionSupersededError();
    const sentGeneration = generation;
    const sentInit = withExpectedViewer(input, init);
    let response: Response;
    let body: ArrayBuffer;
    try {
      response = await send(input, sentInit);
      // Callers read the body after this resolves, so decide only once it is all here.
      body = await response.arrayBuffer();
    } catch (error) {
      if (!isCurrent(sentGeneration)) throw new SessionSupersededError();
      throw error;
    }
    if (!isCurrent(sentGeneration)) throw new SessionSupersededError();
    // The cookie names another account than this page shows, and the route read
    // and wrote nothing. Ask now rather than at the next focus.
    if (response.status === 409 && isViewerChangedBody(body)) {
      dependencies.requestSessionCheck();
      throw new SessionSupersededError();
    }
    if (response.status === 401) noteUnauthorized();
    return new Response(NULL_BODY_STATUSES.has(response.status) ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  return {
    fetch: guardedFetch,
    subscribe,
    isCurrent,
    viewerKey,
    capture: () => generation,
    isRetiring: () => retiring,
    /** Marks the next account change as started by this tab (sign-in, guarded sign-out). */
    expectLocalChange(): LocalChange {
      const claim = { until: now() + localChangeWindowMs };
      localChange = claim;
      return {
        extend: () => {
          if (localChange === claim) claim.until = now() + localChangeWindowMs;
        },
        cancel: () => {
          if (localChange === claim) localChange = null;
        },
      };
    },
    registerCleanup(cleanup: () => unknown): () => void {
      cleanups.add(cleanup);
      return () => {
        cleanups.delete(cleanup);
      };
    },
    rememberToken(token: string, owner: NonNullable<SessionViewer>): void {
      tokenOwners.delete(token);
      tokenOwners.set(token, sessionViewerKey(owner));
      if (tokenOwners.size > REMEMBERED_TOKEN_LIMIT) tokenOwners.delete(tokenOwners.keys().next().value ?? token);
    },
    whenViewerKnown(timeoutMs: number): Promise<string | undefined> {
      if (viewer !== undefined) return Promise.resolve(viewerKey());
      return new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          unsubscribe();
          resolve(viewerKey());
        };
        const timer = setTimeout(finish, timeoutMs);
        const unsubscribe = subscribe(() => {
          if (viewer !== undefined) finish();
        });
      });
    },
    /** Called by the session provider before it publishes a read. 'retire' means: publish nothing. */
    accept(next: SessionViewer): 'publish' | 'retire' {
      if (retiring) return 'retire';
      const previous = viewer;
      viewer = next;
      if (previous === undefined) {
        notify();
        return 'publish';
      }
      if (sessionViewerKey(previous) === sessionViewerKey(next)) return 'publish';
      generation += 1;
      // A claim covers one change.
      const local = localChange !== null && localChange.until > now();
      localChange = null;
      // Anonymous to signed-in, a new login of the same account, and this tab's
      // own sign-in or sign-out keep the page. Its own flow navigates.
      if (previous === null || previous.userId === next?.userId || local) {
        notify();
        return 'publish';
      }
      retiring = true;
      notify();
      void retire();
      return 'retire';
    },
  };
}

export type SessionGuard = ReturnType<typeof createSessionGuard>;

type GuardGlobal = typeof globalThis & { [key: symbol]: SessionGuard | undefined };

/** One guard per browser realm, kept across hot reloads like the cookie fetch lock. */
export function browserSessionGuard(): SessionGuard {
  const shared = globalThis as GuardGlobal;
  return (shared[GUARD_KEY] ??= createSessionGuard({
    reloadPage: () => reloadAfterAccountChange(),
    requestSessionCheck: () => window.dispatchEvent(new Event(WEB_SESSION_CHECK_EVENT)),
  }));
}

/** fetch for user-scoped requests: a response from an earlier account rejects with SessionSupersededError. */
export const guardedFetch: typeof fetch = (input, init) => browserSessionGuard().fetch(input, init);
