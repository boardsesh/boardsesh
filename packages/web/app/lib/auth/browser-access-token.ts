import { browserSessionGuard, sessionViewerKey, type SessionGuard, type SessionViewer } from './session-guard';

/**
 * The tab's 15-minute browser access token (#7596 B3b), in memory only.
 *
 * Under `AUTH_BROWSER_SESSION_MODE=better-auth`, `/api/internal/ws-auth`
 * answers a token with its lifetime in seconds (`expiresIn`, by the server's
 * clock). This module remembers the tokens ws-auth answered with one and times
 * everything from when the tab RECEIVED the token, never from the client clock
 * against an absolute end, which may be minutes off. So that:
 * - the hook refreshes about three minutes before the end (at about 12
 *   minutes, minus up to 30 s of jitter), and on focus or `pageshow` once
 *   fewer than three remain;
 * - a refresh that fails (503, timeout) is tried again after 30 s, doubling
 *   to 5 minutes, per failure sequence, and never signs anyone out;
 * - a request the backend refuses with 401, or a socket closed with 4401,
 *   gets ONE new token per refused token, shared by every caller, and then the
 *   session guard takes over (it re-reads the session);
 * - a socket reads the current token at each (re)connect through a handle
 *   that stays the same while the viewer does, so a refresh does not reopen it;
 * - an account change or sign-out seen by the guard drops every token first.
 *
 * A token without a lifetime (the raw NextAuth cookie that `legacy` mode
 * answers) is never remembered, so with the mode off nothing here changes what
 * a request or socket sends.
 */

/** Refresh this long before the token ends: about 12 minutes into 15. */
export const ACCESS_TOKEN_REFRESH_LEAD_MS = 3 * 60_000;
/** Never refresh sooner than this after the last refresh, even for a token capped by a short session. */
export const MIN_ACCESS_TOKEN_REFRESH_DELAY_MS = 30_000;
/** Longest wait between refresh attempts while ws-auth keeps failing. */
export const MAX_ACCESS_TOKEN_BACKOFF_MS = 5 * 60_000;
/** Each token's timed refresh comes up to this much earlier, so tabs opened together do not refresh together. */
export const ACCESS_TOKEN_REFRESH_JITTER_MS = 30_000;
/** The close code a backend gives a socket whose browser token it refuses. */
export const SOCKET_REFUSED_CLOSE_CODE = 4401;

type IssuedToken = {
  readonly token: string;
  readonly viewerKey: string;
  /** When the token ends, on this tab's clock: receipt plus its lifetime. */
  readonly expiresAtMs: number;
};
type Refresher = () => Promise<void>;

type AccessTokenState = {
  current: IssuedToken | null;
  /** Every browser token this tab was given, mapped to the viewer it belongs to. */
  owners: Map<string, string>;
  /** Each token's jitter, chosen once when it arrived. */
  jitters: Map<string, number>;
  /** The first token of each viewer: the handle a socket is keyed and opened by. */
  socketHandles: Map<string, string>;
  /** Tokens already refreshed once after a refusal; a second refusal goes to the guard. */
  refusedOnce: Set<string>;
  /** Concurrent refusals for the same token share its pending replacement. */
  refusalRefreshes: Map<string, Promise<string | undefined>>;
  /** Tokens a socket was refused with (4401); the next connect asks for a new one. */
  socketRefused: Set<string>;
  /** The token each socket handle last connected with: the one a 4401 refused. */
  socketSent: Map<string, string>;
  /** Every mounted hook's refetch; any one refreshes the tab, so unmounting one never stops it. */
  refreshers: Set<Refresher>;
  refreshing: Promise<void> | null;
  consecutiveFailures: number;
  lastFailureAt: number;
  watchedGuard: SessionGuard | null;
  listening: boolean;
};

const STATE_KEY = Symbol.for('boardsesh.browser-access-token.v3');
const REMEMBERED_TOKEN_LIMIT = 32;

type StateGlobal = typeof globalThis & { [key: symbol]: AccessTokenState | undefined };

function state(): AccessTokenState {
  const shared = globalThis as StateGlobal;
  return (shared[STATE_KEY] ??= {
    current: null,
    owners: new Map(),
    jitters: new Map(),
    socketHandles: new Map(),
    refusedOnce: new Set(),
    refusalRefreshes: new Map(),
    socketRefused: new Set(),
    socketSent: new Map(),
    refreshers: new Set(),
    refreshing: null,
    consecutiveFailures: 0,
    lastFailureAt: 0,
    watchedGuard: null,
    listening: false,
  });
}

/** A ws-auth token's lifetime in ms, or undefined for a token without one (legacy mode). */
export function wsAuthTokenLifetime(expiresIn: unknown): number | undefined {
  return typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn >= 0 ? expiresIn * 1000 : undefined;
}

/** Wait before the next attempt after `failures` refreshes in a row failed: 30 s, doubling, at most 5 minutes. */
export function accessTokenBackoff(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(MIN_ACCESS_TOKEN_REFRESH_DELAY_MS * 2 ** (failures - 1), MAX_ACCESS_TOKEN_BACKOFF_MS);
}

/**
 * How long after it arrived a token goes stale: three minutes (plus its
 * jitter) before its end, never under 30 s. While refreshes fail, not before
 * the backoff since the last failure has passed. Measured from receipt, which
 * is what React Query's `dataUpdatedAt` is.
 */
export function accessTokenStaleTime(token: string | null | undefined, lifetimeMs: number, receivedAt: number): number {
  const store = state();
  const jitter = token ? (store.jitters.get(token) ?? 0) : 0;
  const fresh = Math.max(MIN_ACCESS_TOKEN_REFRESH_DELAY_MS, lifetimeMs - ACCESS_TOKEN_REFRESH_LEAD_MS - jitter);
  if (store.consecutiveFailures === 0) return fresh;
  return Math.max(fresh, store.lastFailureAt + accessTokenBackoff(store.consecutiveFailures) - receivedAt);
}

/** How long from now until the next timed refresh of a token that arrived at `receivedAt`. */
export function accessTokenRefreshInterval(
  token: string | null | undefined,
  lifetimeMs: number,
  receivedAt: number,
  now = Date.now(),
): number {
  return Math.max(
    MIN_ACCESS_TOKEN_REFRESH_DELAY_MS,
    receivedAt + accessTokenStaleTime(token, lifetimeMs, receivedAt) - now,
  );
}

function dropEveryToken(store: AccessTokenState): void {
  store.current = null;
  store.owners.clear();
  store.jitters.clear();
  store.socketHandles.clear();
  store.refusedOnce.clear();
  store.refusalRefreshes.clear();
  store.socketRefused.clear();
  store.socketSent.clear();
}

/** An account change or sign-out drops every token before anything else runs. */
function watchGuard(store: AccessTokenState): void {
  if (typeof window === 'undefined') return;
  const guard = browserSessionGuard();
  if (store.watchedGuard === guard) return;
  store.watchedGuard = guard;
  guard.setAccessTokenRefresher(refreshAfterRefusal, isBrowserAccessToken);
  guard.subscribe(() => {
    const viewer = guard.viewerKey();
    if (store.current && store.current.viewerKey !== viewer) dropEveryToken(store);
  });
}

function listenForReturn(store: AccessTokenState): void {
  if (store.listening || typeof window === 'undefined') return;
  store.listening = true;
  // The back/forward cache restores a page with its old token; focus is React
  // Query's own refetch, which this mirrors for `pageshow`.
  window.addEventListener('pageshow', (event: PageTransitionEvent) => {
    if (event.persisted && accessTokenNeedsRefresh()) void refreshAccessToken();
  });
}

/**
 * Remembers a token ws-auth answered with a lifetime, for the viewer it was
 * answered for, timed from `receivedAt` (now). A token without one is not a
 * browser access token and is ignored.
 */
export function rememberBrowserAccessToken(
  token: string,
  viewer: NonNullable<SessionViewer>,
  expiresIn: unknown,
  receivedAt = Date.now(),
): void {
  const lifetimeMs = wsAuthTokenLifetime(expiresIn);
  if (lifetimeMs === undefined) return;
  const store = state();
  watchGuard(store);
  listenForReturn(store);
  const viewerKey = sessionViewerKey(viewer);
  if (store.current && store.current.viewerKey !== viewerKey) dropEveryToken(store);
  store.current = { token, viewerKey, expiresAtMs: receivedAt + lifetimeMs };
  store.owners.set(token, viewerKey);
  if (!store.jitters.has(token)) store.jitters.set(token, Math.random() * ACCESS_TOKEN_REFRESH_JITTER_MS);
  if (store.owners.size > REMEMBERED_TOKEN_LIMIT) {
    // Keep the first token as the socket's stable handle and discard the oldest other token.
    const handle = store.socketHandles.get(viewerKey);
    const oldest = [...store.owners.keys()].find((remembered) => remembered !== handle && remembered !== token);
    if (oldest !== undefined) {
      store.owners.delete(oldest);
      store.jitters.delete(oldest);
      store.refusedOnce.delete(oldest);
      store.socketRefused.delete(oldest);
      store.socketSent.delete(oldest);
    }
  }
  if (!store.socketHandles.has(viewerKey)) store.socketHandles.set(viewerKey, token);
  store.consecutiveFailures = 0;
}

/** Whether `token` is a browser access token this tab was given. False for every token in legacy mode. */
export function isBrowserAccessToken(token: string): boolean {
  return state().owners.has(token);
}

/** Whether the tab holds a browser token now: then a failed refresh backs off instead of retrying at once. */
export function holdsBrowserAccessToken(): boolean {
  return state().current !== null;
}

/** Within three minutes of its end (or past it), by time since receipt. False with no browser token. */
export function accessTokenNeedsRefresh(now = Date.now()): boolean {
  const current = state().current;
  return current !== null && now >= current.expiresAtMs - ACCESS_TOKEN_REFRESH_LEAD_MS;
}

/** A hook's refetch, registered while the hook is mounted. Any registered one refreshes the tab. */
export function registerAccessTokenRefresher(refresher: Refresher): () => void {
  const store = state();
  store.refreshers.add(refresher);
  return () => {
    store.refreshers.delete(refresher);
  };
}

/** Counts refreshes that failed in a row (503, timeout, a repeated 401), for the backoff. */
export function noteAccessTokenRefreshFailed(now = Date.now()): number {
  const store = state();
  store.lastFailureAt = now;
  return ++store.consecutiveFailures;
}

export function accessTokenRefreshFailures(): number {
  return state().consecutiveFailures;
}

/** One refresh at a time for the whole tab: every caller joins the one in flight. */
export function refreshAccessToken(): Promise<void> {
  const store = state();
  if (store.refreshing) return store.refreshing;
  const refresher = store.refreshers.values().next().value;
  if (!refresher) return Promise.resolve();
  const refreshing = refresher()
    .catch(() => {})
    .finally(() => {
      if (store.refreshing === refreshing) store.refreshing = null;
    });
  store.refreshing = refreshing;
  return refreshing;
}

/**
 * After set-password, a provider link or unlink: the account's generation
 * moved and every earlier token is dead. Ask for a new one at once.
 */
export function refreshAccessTokenAfterCredentialChange(): Promise<void> {
  const store = state();
  if (!store.current) return Promise.resolve();
  for (const token of store.owners.keys()) store.refusedOnce.add(token);
  return refreshAccessToken();
}

/**
 * The backend refused `refused` (401 or 4401). The first refusal of a token
 * fetches one new token, shared by every caller; a second refusal of the same
 * token, or a refresh that brings nothing new, answers undefined, and the
 * session guard takes over.
 */
export async function refreshAfterRefusal(refused: string): Promise<string | undefined> {
  const store = state();
  const owner = store.owners.get(refused);
  if (owner === undefined) return undefined;
  const current = store.current;
  // Someone already refreshed past this token: use theirs.
  if (current && current.viewerKey === owner && current.token !== refused && !store.refusedOnce.has(current.token))
    return current.token;
  const pending = store.refusalRefreshes.get(refused);
  if (pending) return pending;
  if (store.refusedOnce.has(refused)) return undefined;
  store.refusedOnce.add(refused);
  const replacement = refreshAccessToken()
    .then(() => {
      const next = store.current;
      return next && next.viewerKey === owner && next.token !== refused ? next.token : undefined;
    })
    .finally(() => {
      if (store.refusalRefreshes.get(refused) === replacement) store.refusalRefreshes.delete(refused);
    });
  store.refusalRefreshes.set(refused, replacement);
  return replacement;
}

/** What a socket is keyed and opened by: the viewer's first token, or the token itself outside `better-auth`. */
export function socketCredentialHandle(token: string | null): string | null {
  if (token === null) return null;
  const store = state();
  const owner = store.owners.get(token);
  return owner === undefined ? token : (store.socketHandles.get(owner) ?? token);
}

/** A socket opened with `handle` was closed with `code`; 4401 means the token it connected with was refused. */
export function noteSocketClosed(handle: string, code: number | undefined): void {
  if (code !== SOCKET_REFUSED_CLOSE_CODE) return;
  const store = state();
  const sent = store.socketSent.get(handle);
  if (sent !== undefined && store.owners.has(sent)) store.socketRefused.add(sent);
}

/**
 * The token a socket sends in `connection_init`, read at each (re)connect.
 * Outside `better-auth` it is the handle itself. Inside, it is the viewer's
 * current token: refreshed once first when that very token was refused
 * (4401), or when it is close to its end. A 1013 or a network drop reconnects
 * with the same token.
 */
export async function socketConnectToken(handle: string): Promise<string> {
  const store = state();
  const owner = store.owners.get(handle);
  if (owner === undefined) return handle;
  const current = store.current;
  if (!current || current.viewerKey !== owner) return handle;
  let token = current.token;
  if (store.socketRefused.has(token)) {
    store.socketRefused.delete(token);
    token = (await refreshAfterRefusal(token)) ?? token;
  } else if (accessTokenNeedsRefresh()) {
    await refreshAccessToken();
    const latest = store.current;
    if (latest && latest.viewerKey === owner) token = latest.token;
  }
  store.socketSent.set(handle, token);
  return token;
}

/** Tests only: forget everything. */
export function resetBrowserAccessTokensForTests(): void {
  const store = state();
  dropEveryToken(store);
  store.refreshers.clear();
  store.refreshing = null;
  store.consecutiveFailures = 0;
  store.lastFailureAt = 0;
  store.watchedGuard = null;
}
