import { browserSessionGuard, sessionViewerKey, type SessionGuard, type SessionViewer } from './session-guard';

/**
 * The tab's 15-minute browser access token (#7596 B3b), in memory only.
 *
 * Under `AUTH_BROWSER_SESSION_MODE=better-auth`, `/api/internal/ws-auth`
 * answers a token that lives 15 minutes and says when it ends (`expiresAt`).
 * This module remembers the tokens ws-auth answered with an end time, so that:
 * - the hook refreshes about three minutes before the end (at about 12
 *   minutes), and on focus or `pageshow` once fewer than three remain;
 * - a request the backend refuses with 401, or a socket closed with 4401,
 *   gets ONE new token per refused token, shared by every caller, and then the
 *   session guard takes over (it re-reads the session);
 * - a socket reads the current token at each (re)connect through a handle
 *   that stays the same while the viewer does, so a refresh does not reopen it;
 * - an account change or sign-out seen by the guard drops every token first.
 *
 * A token without an end time (the raw NextAuth cookie that `legacy` mode
 * answers) is never remembered, so with the mode off nothing here changes what
 * a request or socket sends.
 */

/** Refresh this long before the token ends: about 12 minutes into 15. */
export const ACCESS_TOKEN_REFRESH_LEAD_MS = 3 * 60_000;
/** Never refresh sooner than this after the last refresh, even for a token capped by a short session. */
export const MIN_ACCESS_TOKEN_REFRESH_DELAY_MS = 30_000;
/** Longest wait between refresh attempts while ws-auth keeps answering 503. */
export const MAX_ACCESS_TOKEN_BACKOFF_MS = 5 * 60_000;

type IssuedToken = { readonly token: string; readonly viewerKey: string; readonly expiresAtMs: number };
type Refresher = () => Promise<void>;

type AccessTokenState = {
  current: IssuedToken | null;
  /** Every browser token this tab was given, mapped to the viewer it belongs to. */
  owners: Map<string, string>;
  /** The first token of each viewer: the handle a socket is keyed and opened by. */
  socketHandles: Map<string, string>;
  /** Tokens already refreshed once after a refusal; a second refusal goes to the guard. */
  refusedOnce: Set<string>;
  /** Tokens a socket was refused with (4401); the next connect asks for a new one. */
  socketRefused: Set<string>;
  refresher: Refresher | null;
  refreshing: Promise<void> | null;
  consecutiveFailures: number;
  watchedGuard: SessionGuard | null;
  listening: boolean;
};

const STATE_KEY = Symbol.for('boardsesh.browser-access-token.v1');
const REMEMBERED_TOKEN_LIMIT = 32;
const SOCKET_REFUSED_CLOSE_CODE = 4401;

type StateGlobal = typeof globalThis & { [key: symbol]: AccessTokenState | undefined };

function state(): AccessTokenState {
  const shared = globalThis as StateGlobal;
  return (shared[STATE_KEY] ??= {
    current: null,
    owners: new Map(),
    socketHandles: new Map(),
    refusedOnce: new Set(),
    socketRefused: new Set(),
    refresher: null,
    refreshing: null,
    consecutiveFailures: 0,
    watchedGuard: null,
    listening: false,
  });
}

/** The end of a ws-auth token in ms, or undefined for a token without one (legacy mode). */
export function wsAuthTokenExpiry(expiresAt: unknown): number | undefined {
  if (typeof expiresAt !== 'string') return undefined;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** How long until the token should be refreshed: about three minutes before its end, never under 30 s. */
export function accessTokenRefreshDelay(expiresAtMs: number, now = Date.now()): number {
  return Math.max(MIN_ACCESS_TOKEN_REFRESH_DELAY_MS, expiresAtMs - ACCESS_TOKEN_REFRESH_LEAD_MS - now);
}

/** Wait before the next attempt after `failures` refreshes in a row answered 503 or failed. */
export function accessTokenBackoff(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(MIN_ACCESS_TOKEN_REFRESH_DELAY_MS * 2 ** (failures - 1), MAX_ACCESS_TOKEN_BACKOFF_MS);
}

function dropEveryToken(store: AccessTokenState): void {
  store.current = null;
  store.owners.clear();
  store.socketHandles.clear();
  store.refusedOnce.clear();
  store.socketRefused.clear();
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
 * Remembers a token ws-auth answered with an end time, for the viewer it was
 * answered for. A token without one is not a browser access token and is ignored.
 */
export function rememberBrowserAccessToken(
  token: string,
  viewer: NonNullable<SessionViewer>,
  expiresAt: unknown,
): void {
  const expiresAtMs = wsAuthTokenExpiry(expiresAt);
  if (expiresAtMs === undefined) return;
  const store = state();
  watchGuard(store);
  listenForReturn(store);
  const viewerKey = sessionViewerKey(viewer);
  if (store.current && store.current.viewerKey !== viewerKey) dropEveryToken(store);
  store.current = { token, viewerKey, expiresAtMs };
  store.owners.set(token, viewerKey);
  if (store.owners.size > REMEMBERED_TOKEN_LIMIT) {
    const oldest = store.owners.keys().next().value;
    // A socket handle stays: it keys the open socket for as long as the viewer does.
    if (oldest !== undefined && ![...store.socketHandles.values()].includes(oldest)) store.owners.delete(oldest);
  }
  if (!store.socketHandles.has(viewerKey)) store.socketHandles.set(viewerKey, token);
  store.consecutiveFailures = 0;
}

/** Whether `token` is a browser access token this tab was given. False for every token in legacy mode. */
export function isBrowserAccessToken(token: string): boolean {
  return state().owners.has(token);
}

/** Within three minutes of its end (or past it). False with no browser token. */
export function accessTokenNeedsRefresh(now = Date.now()): boolean {
  const current = state().current;
  return current !== null && now >= current.expiresAtMs - ACCESS_TOKEN_REFRESH_LEAD_MS;
}

/** The hook's refetch, registered while a hook is mounted. One per tab. */
export function registerAccessTokenRefresher(refresher: Refresher): () => void {
  const store = state();
  store.refresher = refresher;
  return () => {
    if (store.refresher === refresher) store.refresher = null;
  };
}

/** Counts refreshes that failed in a row (503, timeout), for the hook's backoff. */
export function noteAccessTokenRefreshFailed(): number {
  return ++state().consecutiveFailures;
}

export function accessTokenRefreshFailures(): number {
  return state().consecutiveFailures;
}

/** One refresh at a time for the whole tab: every caller joins the one in flight. */
export function refreshAccessToken(): Promise<void> {
  const store = state();
  if (store.refreshing) return store.refreshing;
  const refresher = store.refresher;
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
  if (store.refusedOnce.has(refused)) return undefined;
  store.refusedOnce.add(refused);
  await refreshAccessToken();
  const next = store.current;
  if (!next || next.viewerKey !== owner || next.token === refused) return undefined;
  return next.token;
}

/** What a socket is keyed and opened by: the viewer's first token, or the token itself outside `better-auth`. */
export function socketCredentialHandle(token: string | null): string | null {
  if (token === null) return null;
  const store = state();
  const owner = store.owners.get(token);
  return owner === undefined ? token : (store.socketHandles.get(owner) ?? token);
}

/** A socket opened with `handle` was closed with `code`; 4401 means its token was refused. */
export function noteSocketClosed(handle: string, code: number | undefined): void {
  if (code !== SOCKET_REFUSED_CLOSE_CODE) return;
  const store = state();
  const owner = store.owners.get(handle);
  if (owner === undefined || store.current?.viewerKey !== owner) return;
  store.socketRefused.add(store.current.token);
}

/**
 * The token a socket sends in `connection_init`, read at each (re)connect.
 * Outside `better-auth` it is the handle itself. Inside, it is the viewer's
 * current token, refreshed first when it was refused (4401) or is close to
 * its end; a 1013 or a network drop reconnects with the same token.
 */
export async function socketConnectToken(handle: string): Promise<string> {
  const store = state();
  const owner = store.owners.get(handle);
  if (owner === undefined) return handle;
  const current = store.current;
  if (!current || current.viewerKey !== owner) return handle;
  if (store.socketRefused.has(current.token)) {
    store.socketRefused.delete(current.token);
    return (await refreshAfterRefusal(current.token)) ?? current.token;
  }
  if (accessTokenNeedsRefresh()) await refreshAccessToken();
  const latest = store.current;
  return latest && latest.viewerKey === owner ? latest.token : current.token;
}

/** Tests only: forget everything. */
export function resetBrowserAccessTokensForTests(): void {
  const store = state();
  dropEveryToken(store);
  store.refresher = null;
  store.refreshing = null;
  store.consecutiveFailures = 0;
  store.watchedGuard = null;
}
