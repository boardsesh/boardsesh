import type { Session } from 'next-auth';
import { computeViewerMarker, readViewerMarker } from '@boardsesh/auth-protocol/viewer-marker';
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
 * at once. `actionFetch` waits for that re-check and retries a climber's read
 * or delete once. Design: issue #7596.
 *
 * The viewer marker (`@boardsesh/auth-protocol/viewer-marker`) tells the page,
 * synchronously when a reply lands, whether the browser still holds the login
 * it shows, so a switch made on another host is caught before focus. A reply
 * that lands under another marker is held while the session check runs: the
 * check naming another account retires the page; confirming the same login
 * delivers the reply; proving nothing supersedes it. The marker alone never
 * signs out or reloads, and a page checks at most four false values (a fifth
 * turns the marker check off for the document). The check arms only once this
 * document has seen its own login's marker, which only a server under
 * `better-auth` writes; until then a marker of any value is ignored, so with
 * the mode off a planted marker costs nothing. A toast or navigation asked for
 * while a check runs waits for it (`runIfCurrent`) instead of being dropped.
 * See "One guard" in docs/auth/better-auth-browser-session.md.
 */
export const WEB_SESSION_CHECK_EVENT = 'boardsesh-web-session-check';
const GUARD_KEY = Symbol.for('boardsesh.web-session-guard.v1');
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
const REMEMBERED_TOKEN_LIMIT = 32;
// A login whose session has no authSessionId yet. Same placeholder as the Expo auth bridge.
const PENDING_LOGIN_IDENTITY = 'pending-login-identity';
const QUERY_RETRY_LIMIT = 3;
// The provider's probe and the session read that may follow each stop at 15 s.
const RECHECK_TIMEOUT_MS = 30_000;
// Sent again after the re-check. A write is never sent twice: its answer may be lost after a commit.
const RETRIED_METHODS = new Set(['GET', 'HEAD', 'DELETE']);
// False marker values one document checks; the next one turns the marker check off for it.
const MARKER_FALSE_VALUE_LIMIT = 4;
// The marker value a tab that saw its own marker reads once the cookie is gone.
const ABSENT_MARKER = '';
// What an armed tab reads when the browser holds two differing copies (another Path or scope).
const CONFLICTED_MARKER = '\u0000conflicted';
// A check that proved nothing is tried again on a later reply, after 30 s, then 60 s, up to 5 minutes.
const UNPROVEN_RETRY_MS = 30_000;
const UNPROVEN_RETRY_MAX_MS = 5 * 60_000;

export type SessionViewer = { readonly userId: string; readonly authSessionId: string } | null;

export class SessionSupersededError extends Error {
  /** The server answered `viewer_changed`, so it read and wrote nothing. */
  readonly refusedByServer: boolean;
  constructor(options: { readonly refusedByServer?: boolean } = {}) {
    super('The signed-in account changed while this request was in flight');
    this.name = 'SessionSupersededError';
    this.refusedByServer = options.refusedByServer ?? false;
  }
}

export function isSessionSuperseded(error: unknown): error is SessionSupersededError {
  return error instanceof Error && error.name === 'SessionSupersededError';
}

/**
 * The page kept its account through the re-check, yet the action still did not
 * go through: a retried read or delete was refused again, a write was refused
 * twice in a row, or a write's answer was lost. The caller shows "Reload this
 * page" instead of nothing.
 */
export class ReloadRequiredError extends Error {
  constructor() {
    super('The action could not be confirmed for the account this page shows');
    this.name = 'ReloadRequiredError';
  }
}

export function isReloadRequired(error: unknown): error is ReloadRequiredError {
  return error instanceof Error && error.name === 'ReloadRequiredError';
}

/**
 * The server refused a write before writing anything, and the re-check kept
 * the page's account. Nothing was saved; the caller asks for another press.
 */
export class WriteRefusedError extends Error {
  constructor() {
    super('The server refused this write before writing anything');
    this.name = 'WriteRefusedError';
  }
}

export function isWriteRefused(error: unknown): error is WriteRefusedError {
  return error instanceof Error && error.name === 'WriteRefusedError';
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

/** The account ws-auth says the cookie names now; undefined when the probe proves nothing. */
export function readProbedViewer(candidate: unknown): SessionViewer | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const probe = candidate as Record<string, unknown>;
  if (probe.authenticated === false) return null;
  if (probe.authenticated !== true || typeof probe.userId !== 'string') return undefined;
  return signedInViewer(probe.userId, typeof probe.authSessionId === 'string' ? probe.authSessionId : null);
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

function requestTarget(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
}

function isSameOrigin(input: RequestInfo | URL, pageOrigin: string | undefined): boolean {
  if (!pageOrigin) return false;
  try {
    return new URL(requestTarget(input), pageOrigin).origin === pageOrigin;
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
  /** How long `actionFetch` waits for a re-check the provider never reports. */
  readonly recheckTimeoutMs?: number;
  /** `document.cookie`, or undefined where there is no document. */
  readonly readDocumentCookie?: () => string | undefined;
  /** Whether the page reads the `__Secure-` marker name (https) or the plain one (local http). */
  readonly secureContext?: () => boolean;
  /** The marker a login is expected to carry; undefined turns the check off for that login. */
  readonly computeMarker?: (authSessionId: string) => Promise<string | undefined>;
};

/** What a false marker value turned out to be: the same login, or a check that proved nothing. */
type FalseMarkerOutcome = 'same-login' | 'unproven';
/** A checked false value: what its last check found and, for 'unproven', when it may be checked again. */
type CheckedFalseMarker = { readonly outcome: FalseMarkerOutcome; readonly retryAt: number; readonly attempts: number };

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
  const generationCurrent = (captured: number) => !retiring && captured === generation;
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

  // The re-check a viewer_changed answer asked for. Only a probe or session
  // read that started after it was asked can answer it (a read already out may
  // have seen the cookie before it changed), or a read that moved the viewer.
  // `checkEpoch` counts the re-checks asked for; a read records it when it starts.
  // A check settles `true` when a probe or session read confirmed the page's own
  // login, and `false` when it proved nothing, timed out, or moved the viewer.
  let checkEpoch = 0;
  let pendingCheck: {
    readonly epoch: number;
    readonly done: Promise<boolean>;
    readonly settle: (confirmed: boolean) => void;
  } | null = null;
  function askForCheck(): Promise<boolean> {
    if (!pendingCheck) {
      let resolve: (confirmed: boolean) => void = () => {};
      const done = new Promise<boolean>((settle) => {
        resolve = settle;
      });
      const timer = setTimeout(() => settleCheck(false), dependencies.recheckTimeoutMs ?? RECHECK_TIMEOUT_MS);
      pendingCheck = {
        epoch: ++checkEpoch,
        done,
        settle: (confirmed) => {
          clearTimeout(timer);
          resolve(confirmed);
        },
      };
    }
    const { done } = pendingCheck;
    dependencies.requestSessionCheck();
    return done;
  }
  function settleCheck(confirmed: boolean): void {
    const pending = pendingCheck;
    pendingCheck = null;
    pending?.settle(confirmed);
  }
  /** Settles the open re-check only for a read that started after it was asked. */
  function settleCheckStartedAt(readStarted: number | undefined, confirmed: boolean): void {
    if (pendingCheck && readStarted !== undefined && readStarted >= pendingCheck.epoch) settleCheck(confirmed);
  }
  const afterSessionCheck = (): Promise<void> => pendingCheck?.done.then(() => undefined) ?? Promise.resolve();

  // The viewer marker. `expectedMarker` is the accepted login's marker once its
  // digest is in; until then, and for an anonymous or pending login, nothing is
  // checked. `markerSeen`: this document saw its own marker since the login was
  // accepted; nothing is checked before it (the check is armed only by a
  // marker the server wrote). `falseMarkers`: values met under this login and
  // what their last check found (absent while a check runs). `falseMarkerChecks`
  // counts the checks this document ran; past the limit the check is off for good.
  const readDocumentCookie =
    dependencies.readDocumentCookie ?? (() => (typeof document === 'undefined' ? undefined : document.cookie));
  const secureContext =
    dependencies.secureContext ?? (() => typeof location !== 'undefined' && location.protocol === 'https:');
  const computeMarker = dependencies.computeMarker ?? ((authSessionId: string) => computeViewerMarker(authSessionId));
  let expectedMarker: string | undefined;
  let markerSeen = false;
  const falseMarkers = new Map<string, CheckedFalseMarker>();
  const runningMarkerChecks = new Map<string, Promise<FalseMarkerOutcome | 'other'>>();
  let falseMarkerChecks = 0;
  let markerCheckOff = false;

  function expectMarkerOf(next: SessionViewer): void {
    expectedMarker = undefined;
    markerSeen = false;
    falseMarkers.clear();
    runningMarkerChecks.clear();
    if (next === null || next.authSessionId === PENDING_LOGIN_IDENTITY) return;
    const forViewer = sessionViewerKey(next);
    void computeMarker(next.authSessionId)
      .catch(() => undefined)
      .then((marker) => {
        if (viewerKey() !== forViewer) return;
        expectedMarker = marker;
        // Armed at once when the browser already holds this login's marker (the login or bridge just wrote it).
        armIfOwnMarker();
      });
  }

  /** The marker the browser holds now, as the page's scheme names it; undefined where there is no document. */
  function readMarkerNow() {
    const cookieText = readDocumentCookie();
    return cookieText === undefined ? undefined : readViewerMarker(cookieText, secureContext());
  }

  function armIfOwnMarker(): void {
    const reading = readMarkerNow();
    if (expectedMarker !== undefined && reading?.kind === 'present' && reading.value === expectedMarker)
      markerSeen = true;
  }

  /** The false value the browser holds now, or undefined when a reply may be delivered as far as the marker goes. */
  function falseMarkerNow(): string | undefined {
    if (markerCheckOff || expectedMarker === undefined || retiring) return undefined;
    const reading = readMarkerNow();
    if (reading === undefined) return undefined;
    if (reading.kind === 'present' && reading.value === expectedMarker) {
      markerSeen = true;
      return undefined;
    }
    // Not armed: this document never saw its own marker, so nothing a server wrote is known. Ignore any value.
    if (!markerSeen) return undefined;
    // Armed: two differing copies (another Path or scope) are one false value; a missing marker is a sign-out.
    if (reading.kind === 'conflicted') return CONFLICTED_MARKER;
    if (reading.kind === 'missing') return ABSENT_MARKER;
    return reading.value;
  }

  /**
   * One session check for a false value: 'other' when the page moved off its
   * login (another account retires the page), 'same-login' when the check
   * confirmed the page's own login, 'unproven' when it proved nothing.
   */
  function checkFalseMarker(value: string): Promise<FalseMarkerOutcome | 'other'> {
    const running = runningMarkerChecks.get(value);
    if (running) return running;
    falseMarkerChecks += 1;
    const forViewer = viewerKey();
    const forGeneration = generation;
    const check = askForCheck().then((confirmed): FalseMarkerOutcome | 'other' => {
      if (runningMarkerChecks.get(value) === check) runningMarkerChecks.delete(value);
      if (retiring || generation !== forGeneration || viewerKey() !== forViewer) return 'other';
      const outcome: FalseMarkerOutcome = confirmed ? 'same-login' : 'unproven';
      const attempts = (falseMarkers.get(value)?.attempts ?? 0) + 1;
      const backoff = Math.min(UNPROVEN_RETRY_MS * 2 ** (attempts - 1), UNPROVEN_RETRY_MAX_MS);
      falseMarkers.set(value, { outcome, attempts, retryAt: now() + backoff });
      // What waited for this check (a toast, a navigation, a subscriber) runs or re-reads now.
      if (outcome === 'same-login') notify();
      return outcome;
    });
    runningMarkerChecks.set(value, check);
    return check;
  }

  /**
   * What the marker says about a reply now: 'deliver', 'hold' (a check is
   * running or was just started for this value). Starts at most one check per
   * false value; a value past the limit turns the marker check off.
   */
  function markerGate(): { readonly kind: 'deliver' } | { readonly kind: 'hold'; readonly value: string } {
    const value = falseMarkerNow();
    if (value === undefined) return { kind: 'deliver' };
    // Checked before: a confirmed same login, or a check that proved nothing and is not due again yet.
    const checked = falseMarkers.get(value);
    if (checked && (checked.outcome === 'same-login' || now() < checked.retryAt)) return { kind: 'deliver' };
    if (!runningMarkerChecks.has(value)) {
      if (falseMarkerChecks >= MARKER_FALSE_VALUE_LIMIT) {
        markerCheckOff = true;
        return { kind: 'deliver' };
      }
      void checkFalseMarker(value);
    }
    return { kind: 'hold', value };
  }

  /** True when a reply sent under `sentGeneration` may reach its caller as far as the marker goes; waits for a check. */
  async function markerAdmits(sentGeneration: number): Promise<boolean> {
    const gate = markerGate();
    if (gate.kind === 'deliver') return true;
    const outcome = await checkFalseMarker(gate.value);
    return outcome === 'same-login' && generationCurrent(sentGeneration);
  }

  /** The generation check toasts and navigation use: the generation, then the marker, which never waits here. */
  const isCurrent = (captured: number) => generationCurrent(captured) && markerGate().kind === 'deliver';

  /**
   * Runs `action` (a toast, a navigation) if the render of `captured` still
   * shows the browser's login: at once when the marker agrees, after the check
   * when a false value is being checked and it confirms the same login, never
   * when the check names another account or proves nothing.
   */
  function runIfCurrent(captured: number, action: () => void): void {
    if (!generationCurrent(captured)) return;
    const gate = markerGate();
    if (gate.kind === 'deliver') {
      action();
      return;
    }
    void checkFalseMarker(gate.value).then((outcome) => {
      if (outcome === 'same-login' && generationCurrent(captured)) action();
    });
  }

  // Consecutive viewer_changed refusals of one write (method and URL). Any
  // answer, or a move of the viewer, starts the count again.
  const refusedWrites = new Map<string, number>();

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

  // Set by the browser access token store (#7596 B3b): one new token for a refused one.
  let refreshRefusedToken: ((refused: string) => Promise<string | undefined>) | null = null;
  let canRefreshToken: (token: string) => boolean = () => false;

  const guardedFetch: typeof fetch = async (input, init) => {
    if (retiring) throw new SessionSupersededError();
    const token = bearerToken(input, init);
    const tokenOwner = token === undefined ? undefined : tokenOwners.get(token);
    // A closure that kept an earlier account's token fails before anything is sent.
    if (tokenOwner !== undefined && viewer !== undefined && tokenOwner !== sessionViewerKey(viewer))
      throw new SessionSupersededError();
    const sentGeneration = generation;
    // A 15-minute browser token the backend refuses is replaced once and the
    // request sent once more; a Request body can be read only once, so keep a copy.
    const refreshable = token !== undefined && refreshRefusedToken !== null && canRefreshToken(token);
    const retryInput = refreshable && input instanceof Request ? input.clone() : input;
    const sentInit = withExpectedViewer(input, init);
    let response: Response;
    let body: ArrayBuffer;
    try {
      response = await send(input, sentInit);
      // Callers read the body after this resolves, so decide only once it is all here.
      body = await response.arrayBuffer();
      if (response.status === 401 && refreshable && token !== undefined && refreshRefusedToken) {
        const replacement = await refreshRefusedToken(token);
        if (replacement !== undefined && generationCurrent(sentGeneration)) {
          const headers = outgoingHeaders(retryInput, init);
          headers.set('authorization', `Bearer ${replacement}`);
          response = await send(retryInput, withExpectedViewer(retryInput, { ...init, headers }));
          body = await response.arrayBuffer();
        }
      }
    } catch (error) {
      if (!generationCurrent(sentGeneration)) throw new SessionSupersededError();
      throw error;
    }
    if (!generationCurrent(sentGeneration)) throw new SessionSupersededError();
    // The cookie names another account than this page shows, and the route read
    // and wrote nothing. Ask now rather than at the next focus.
    if (response.status === 409 && isViewerChangedBody(body)) {
      void askForCheck();
      throw new SessionSupersededError({ refusedByServer: true });
    }
    // Still refused (or never retried): the session check decides who this page is.
    if (response.status === 401) noteUnauthorized();
    // The browser holds another login's marker: held until the session check decides.
    if (!(await markerAdmits(sentGeneration))) throw new SessionSupersededError();
    return new Response(NULL_BODY_STATUSES.has(response.status) ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  function acceptViewer(next: SessionViewer): 'publish' | 'retire' {
    if (retiring) return 'retire';
    const previous = viewer;
    viewer = next;
    if (previous === undefined) {
      expectMarkerOf(next);
      notify();
      return 'publish';
    }
    if (sessionViewerKey(previous) === sessionViewerKey(next)) return 'publish';
    expectMarkerOf(next);
    generation += 1;
    refusedWrites.clear();
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
  }

  /**
   * A climber's action. A superseded request waits for the session re-check; a
   * page moving to another account rethrows it (show nothing, the page
   * reloads). Otherwise a read or delete is sent once more under the account
   * the re-check kept. A write is never sent again: refused once, it throws
   * WriteRefusedError (ask for another press). ReloadRequiredError replaces
   * silence when a retry is refused again, when a write is refused twice in a
   * row, or when a write's answer was lost. One retry at most.
   */
  const actionFetch: typeof fetch = async (input, init) => {
    const method = requestMethod(input, init);
    const action = `${method} ${requestTarget(input)}`;
    let response: Response;
    try {
      response = await guardedFetch(input instanceof Request ? input.clone() : input, init);
    } catch (error) {
      if (!isSessionSuperseded(error) || retiring) throw error;
      await afterSessionCheck();
      if (retiring) throw error;
      if (!RETRIED_METHODS.has(method)) {
        if (!error.refusedByServer) throw new ReloadRequiredError();
        const refusals = (refusedWrites.get(action) ?? 0) + 1;
        if (refusals < 2) {
          refusedWrites.set(action, refusals);
          throw new WriteRefusedError();
        }
        refusedWrites.delete(action);
        throw new ReloadRequiredError();
      }
      try {
        response = await guardedFetch(input, init);
      } catch (retryError) {
        if (!isSessionSuperseded(retryError) || retiring) throw retryError;
        throw new ReloadRequiredError();
      }
    }
    // An answered action shows the page and the server agree again.
    refusedWrites.clear();
    return response;
  };

  return {
    fetch: guardedFetch,
    actionFetch,
    /** Recorded by the provider when a probe or session read starts; pass it back when it ends. */
    sessionReadStarted: (): number => checkEpoch,
    /**
     * The provider's probe or read ended without an accepted read. `confirmed`:
     * it read the page's own login again; otherwise it proved nothing.
     */
    sessionChecked: (readStarted: number | undefined, confirmed = false) =>
      settleCheckStartedAt(readStarted, confirmed),
    subscribe,
    isCurrent,
    runIfCurrent,
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
    /**
     * The browser access token store (#7596 B3b): `canRefresh` names its
     * tokens, `refresh` answers one new token for a refused one, or undefined
     * to give up. Unset (legacy mode has no such token), a 401 is only noted.
     */
    setAccessTokenRefresher(
      refresh: (refused: string) => Promise<string | undefined>,
      canRefresh: (token: string) => boolean,
    ): void {
      refreshRefusedToken = refresh;
      canRefreshToken = canRefresh;
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
    accept(next: SessionViewer, readStarted?: number): 'publish' | 'retire' {
      const before = viewerKey();
      const outcome = acceptViewer(next);
      // A read that moved the viewer answers an open re-check whenever it
      // started; one that found the same viewer (a confirmation) only if it started after.
      if (outcome === 'retire' || viewerKey() !== before) settleCheck(false);
      else settleCheckStartedAt(readStarted, true);
      return outcome;
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

/**
 * fetch for a climber's action (a tap, or the list it refreshes): like
 * guardedFetch, then after a re-check one retry of a read or delete, and
 * ReloadRequiredError where silence would hide a press that did nothing.
 */
export const guardedActionFetch: typeof fetch = (input, init) => browserSessionGuard().actionFetch(input, init);
